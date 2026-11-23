import { lookup } from 'node:dns/promises';
import ipaddr from 'ipaddr.js';
import { ToolError } from '../core/paper.js';

export class LruCache {
  private entries = new Map<string, { expires: number; value: unknown }>();
  constructor(private capacity = 500) {}
  get<T>(key: string): T | undefined {
    const item = this.entries.get(key);
    if (!item) return;
    this.entries.delete(key);
    if (item.expires <= Date.now()) return;
    this.entries.set(key, item);
    return structuredClone(item.value) as T;
  }
  set(key: string, value: unknown, ttl: number) {
    this.entries.delete(key);
    this.entries.set(key, { expires: Date.now() + ttl, value: structuredClone(value) });
    while (this.entries.size > this.capacity) this.entries.delete(this.entries.keys().next().value!);
  }
}
export const metadataCache = new LruCache();
const expiries = new WeakMap<AbortSignal, number>();
export function deadline(ms: number, parent?: AbortSignal) {
  const signal = parent ? AbortSignal.any([parent, AbortSignal.timeout(ms)]) : AbortSignal.timeout(ms);
  expiries.set(signal, Math.min(Date.now() + ms, parent ? expiries.get(parent) ?? Infinity : Infinity));
  return signal;
}
export async function sleep(ms: number, signal: AbortSignal) {
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
    signal.addEventListener('abort', abort, { once: true });
  });
}
async function untilAborted<T>(task: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return task;
  signal.throwIfAborted();
  let abort!: () => void;
  const interrupted = new Promise<never>((_, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
  });
  try { return await Promise.race([task, interrupted]); }
  finally { signal.removeEventListener('abort', abort); }
}
export async function validatePublicUrl(raw: string, signal?: AbortSignal): Promise<URL> {
  let url: URL;
  try { url = new URL(raw); } catch { throw new ToolError('INVALID_URL', 'Expected an HTTPS URL.'); }
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443'))
    throw new ToolError('UNSAFE_URL', 'Only credential-free public HTTPS URLs on port 443 are supported.');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  // Fixed scholarly origins also work behind enterprise DNS/proxy gateways.
  const trustedHosts = ['api.openalex.org', 'api.crossref.org', 'export.arxiv.org', 'arxiv.org', 'api.semanticscholar.org', 'doi.org',
    'papers.neurips.cc', 'papers.nips.cc', 'proceedings.neurips.cc', 'aclanthology.org', 'proceedings.mlr.press', 'openreview.net', 'hal.science',
    ...(process.env.ALLOWED_PAPER_HOSTS?.split(',').map(s => s.trim()).filter(Boolean) ?? [])];
  if (trustedHosts.includes(host)) return url;
  const addresses = ipaddr.isValid(host) ? [{ address: host }] : await untilAborted(lookup(host, { all: true }), signal);
  if (!addresses.length || addresses.some(({ address }) => {
    const parsed = ipaddr.process(address);
    return parsed.range() !== 'unicast';
  })) throw new ToolError('UNSAFE_URL', 'Private, loopback, reserved and link-local addresses are blocked.');
  return url;
}
export async function readLimited(response: Response, maxBytes: number, signal: AbortSignal): Promise<Uint8Array> {
  if (Number(response.headers.get('content-length')) > maxBytes) {
    await response.body?.cancel();
    throw new ToolError('RESPONSE_TOO_LARGE', `Response exceeds ${maxBytes} bytes.`);
  }
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  const abort = () => { void reader.cancel(signal.reason).catch(() => {}); };
  signal.addEventListener('abort', abort, { once: true });
  try {
    signal.throwIfAborted();
    while (true) {
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new ToolError('RESPONSE_TOO_LARGE', `Response exceeds ${maxBytes} bytes.`);
      chunks.push(value);
    }
  } finally {
    signal.removeEventListener('abort', abort);
    await reader.cancel().catch(() => {});
  }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
  return result;
}

const queues = new Map<string, Promise<void>>();
const lastRequests = new Map<string, number>();
const cooldowns = new Map<string, number>();
async function limited<T>(source: string, signal: AbortSignal, fn: () => Promise<T>): Promise<T> {
  const previous = queues.get(source) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>(resolve => { release = resolve; });
  queues.set(source, current);
  try {
    await untilAborted(previous, signal);
    const gap = source === 'arxiv' ? 3100 : source === 'semantic_scholar' ? 1100 : 150;
    await sleep(Math.max(0, gap - (Date.now() - (lastRequests.get(source) ?? 0))), signal);
    lastRequests.set(source, Date.now());
    return await fn();
  } finally {
    // Do not let an aborted queued request release later requests ahead of its predecessor.
    void previous.finally(release);
    if (queues.get(source) === current) void current.then(() => { if (queues.get(source) === current) queues.delete(source); });
  }
}
export interface FetchOptions { source: string; signal: AbortSignal; maxBytes?: number; headers?: Record<string, string>; }
export async function fetchPublic(raw: string, options: FetchOptions): Promise<{ bytes: Uint8Array; url: string; contentType: string }> {
  const { source, signal, maxBytes = 5 * 1024 * 1024 } = options;
  const cooldownKey = source === 'openalex' ? `${source}:${/^\/(works|authors|institutions|sources)\/.+/.test(new URL(raw).pathname) ? 'singleton' : 'query'}` : source;
  return limited(source, signal, async () => {
    if ((cooldowns.get(cooldownKey) ?? 0) > Date.now()) throw new ToolError('RATE_LIMITED', `${source} is in Retry-After cooldown until ${new Date(cooldowns.get(cooldownKey)!).toISOString()}.`, true);
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        let url = await validatePublicUrl(raw, signal);
        for (let redirect = 0; redirect <= 5; redirect++) {
          const response = await fetch(url, { signal, redirect: 'manual', headers: {
            'user-agent': `papers-mcp/2.0.0${process.env.CONTACT_EMAIL ? ` (mailto:${process.env.CONTACT_EMAIL})` : ''}`,
            accept: '*/*', ...options.headers,
          } });
          if ([301, 302, 303, 307, 308].includes(response.status)) {
            await response.body?.cancel();
            if (redirect === 5 || !response.headers.get('location')) throw new ToolError('REDIRECT_ERROR', 'Too many redirects or missing Location.');
            const next = await validatePublicUrl(new URL(response.headers.get('location')!, url).href, signal);
            if (next.origin !== url.origin && options.headers && Object.keys(options.headers).some(k => /key|authorization/i.test(k)))
              throw new ToolError('UNSAFE_REDIRECT', 'Refusing to forward API credentials to another origin.');
            url = next;
            continue;
          }
          if (response.status === 429 || response.status >= 500) {
            await response.body?.cancel();
            if (attempt === 2) throw new ToolError('UPSTREAM_UNAVAILABLE', `${source} returned HTTP ${response.status}.`, true);
            const retryAfter = response.headers.get('retry-after');
            const wait = retryAfter ? (/^\d+(\.\d+)?$/.test(retryAfter) ? Number(retryAfter) * 1000 : Math.max(0, Date.parse(retryAfter) - Date.now())) : 700 * 2 ** attempt;
            if (response.status === 429 && retryAfter && wait > (expiries.get(signal) ?? Date.now() + 20_000) - Date.now()) {
              cooldowns.set(cooldownKey, Date.now() + Math.min(wait, 86_400_000));
              throw new ToolError('RATE_LIMITED', `${source} returned HTTP 429; Retry-After exceeds this request budget.`, true, 'Retry after the upstream cooldown; other public sources remain usable.');
            }
            await sleep(Math.max(Number.isFinite(wait) ? wait : 700, source === 'arxiv' ? 3100 : 0), signal);
            break;
          }
          if (!response.ok) {
            await response.body?.cancel();
            throw new ToolError(response.status === 404 ? 'NOT_FOUND' : 'UPSTREAM_HTTP_ERROR', `${source} returned HTTP ${response.status}.`, false);
          }
          return { bytes: await readLimited(response, maxBytes, signal), url: url.href, contentType: response.headers.get('content-type') ?? '' };
        }
      } catch (e) {
        if (signal.aborted) throw new ToolError('TIMEOUT', `${source} exceeded the request deadline.`, true);
        if (e instanceof ToolError || attempt === 2) throw e;
        await sleep(source === 'arxiv' ? 3100 : 700 * 2 ** attempt, signal);
      }
    }
    throw new ToolError('UPSTREAM_UNAVAILABLE', `${source} failed after retries.`, true);
  });
}
export async function fetchJson(url: string, source: string, signal: AbortSignal, headers?: Record<string, string>): Promise<unknown> {
  const result = await fetchPublic(url, { source, signal, headers });
  return JSON.parse(new TextDecoder().decode(result.bytes));
}
