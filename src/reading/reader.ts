import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { arxiv, blankPaper, doi, errorMessage, hash, mergePapers, namedAuthor, sourced, ToolError, type PaperRecord, type Passage } from '../core/paper.js';
import { deadline, fetchPublic, metadataCache } from '../net/fetchPublic.js';
import * as oa from '../providers/openalex.js';
import * as cr from '../providers/crossref.js';
import * as ax from '../providers/arxiv.js';
import * as s2 from '../providers/semanticScholar.js';

export interface Segment { text: string; page?: number; section: string; paragraph: number; }
export interface ParsedDocument { segments: Segment[]; pages: { page: number; text: string }[]; page_count: number | null;
  metadata: { title: string | null; authors: string[]; doi: string | null; published: string | null; abstract: string | null; pdf: string | null; venue: string | null } | null; }
export async function parseDocument(kind: 'pdf' | 'html', input: Uint8Array | string, signal: AbortSignal, pageRange?: { start: number; count: number }): Promise<ParsedDocument> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    // Process isolation also contains crashes in optional native PDF font/canvas dependencies.
    const worker = fork(fileURLToPath(new URL('./parseWorker.js', import.meta.url)), [], {
      serialization: 'advanced', stdio: ['ignore', 'ignore', 'pipe', 'ipc'], execArgv: ['--max-old-space-size=256'] });
    worker.stderr?.on('data', () => {});
    let settled = false;
    const finish = () => { settled = true; signal.removeEventListener('abort', abort); clearTimeout(timer); worker.kill(); };
    const abort = () => { finish(); reject(new ToolError('TIMEOUT', 'Document parsing was interrupted.', true)); };
    const timer = setTimeout(abort, 10_000);
    signal.addEventListener('abort', abort, { once: true });
    worker.once('message', (message: { error?: string; result: ParsedDocument }) => { finish(); message.error ? reject(new ToolError('PARSE_ERROR', message.error)) : resolve(message.result); });
    worker.once('error', e => { finish(); reject(e); });
    worker.once('exit', code => { if (!settled) { finish(); reject(new ToolError('PARSE_ERROR', `Parser worker exited with code ${code}.`)); } });
    worker.send(kind === 'pdf' ? { kind, bytes: input, pageRange } : { kind, html: input });
  });
}
const enabled = (name: string) => !process.env.DISABLED_SOURCES?.split(',').map(s => s.trim()).includes(name);
async function htmlMetadata(url: string, signal: AbortSignal): Promise<{ paper: PaperRecord; document: ParsedDocument; url: string }> {
  const response = await fetchPublic(url, { source: 'web', signal });
  if (/pdf/i.test(response.contentType) || new TextDecoder().decode(response.bytes.slice(0, 5)) === '%PDF-')
    throw new ToolError('PDF_METADATA_UNAVAILABLE', 'A bare PDF has no verified bibliography. Supply a DOI/arXiv ID or article URL.', false, 'Use full_text mode to read the PDF, or supply its DOI.');
  const doc = await parseDocument('html', new TextDecoder().decode(response.bytes), signal);
  const meta = doc.metadata!;
  if (!meta.title) throw new ToolError('UNSUPPORTED_PAGE', 'No scholarly citation metadata or article title was found.');
  const a = arxiv(url);
  const d = doi(meta.doi ?? '');
  const p = blankPaper(a ? `arxiv:${a.base}` : d ? `doi:${d}` : `url:${hash(url)}`, response.url);
  p.title = meta.title; p.authors = meta.authors.map(namedAuthor); p.published = meta.published;
  p.abstract = meta.abstract; p.venue = meta.venue; p.identifiers.doi = d; p.identifiers.arxiv = a?.base ?? null;
  if (meta.pdf) { p.pdf_url = new URL(meta.pdf, response.url).href; }
  if (a) {
    p.work_type = 'preprint'; p.date_kind = 'submitted'; p.oa_url = response.url; p.oa_status = 'green';
    p.pdf_url = `https://arxiv.org/pdf/${a.base}${a.version ?? ''}`;
  }
  p.versions = [{ id: a ? `arxiv:${a.base}${a.version ?? ''}` : p.id, url: response.url, published: p.published, updated: null, kind: a ? 'preprint' : 'article' }];
  return { paper: sourced(p, a ? 'arxiv' : 'web', response.url), document: doc, url: response.url };
}
export async function loadMetadata(ref: string, parent?: AbortSignal, enrich = true): Promise<{ paper: PaperRecord; warnings: string[] }> {
  const signal = deadline(15_000, parent);
  const trimmed = ref.trim().replace(/^doi:/i, '');
  const a = arxiv(trimmed), d = doi(trimmed);
  const oid = /^(?:https:\/\/openalex.org\/|openalex:)?(W\d+)$/i.exec(trimmed)?.[1];
  const sid = /^(?:s2:|https:\/\/www.semanticscholar.org\/paper\/)([a-f0-9]{40})$/i.exec(trimmed)?.[1];
  const key = `paper:${a ? `${a.base}${a.version ?? ''}` : d ?? oid ?? sid ?? ''}:${enrich}`;
  if (a || d || oid || sid) { const cached = metadataCache.get<{ paper: PaperRecord; warnings: string[] }>(key); if (cached) return cached; }
  const warnings: string[] = [], records: PaperRecord[] = [];
  const tryLoad = async (name: string, fn: () => Promise<PaperRecord>) => {
    if (!enabled(name)) return;
    try { records.push(await fn()); } catch (e) { warnings.push(`${name}: ${errorMessage(e)}`); }
  };
  if (a) {
    await tryLoad('arxiv', () => ax.get(trimmed, deadline(8000, signal)));
    if (!records.length) await tryLoad('arxiv', async () => (await htmlMetadata(`https://arxiv.org/html/${a.base}${a.version ?? ''}`, deadline(4000, signal))).paper);
    if (!records.length) await tryLoad('arxiv', async () => (await htmlMetadata(`https://arxiv.org/abs/${a.base}${a.version ?? ''}`, signal)).paper);
  } else if (d) {
    const values = await Promise.allSettled([
      enabled('crossref') ? cr.get(d, deadline(10_000, signal)) : Promise.reject(new Error('disabled')),
      enabled('openalex') ? oa.get(d, deadline(10_000, signal)) : Promise.reject(new Error('disabled')),
    ]);
    for (let i = 0; i < values.length; i++) { const result = values[i]; if (result.status === 'fulfilled') records.push(result.value); else warnings.push(`${i ? 'openalex' : 'crossref'}: ${errorMessage(result.reason)}`); }
  } else if (oid) await tryLoad('openalex', () => oa.get(oid, signal));
  else if (sid) await tryLoad('semantic_scholar', () => s2.get(sid, signal));
  else if (/^https:\/\//i.test(trimmed)) records.push((await htmlMetadata(trimmed, signal)).paper);
  else throw new ToolError('INVALID_REFERENCE', 'Use a DOI, arXiv ID, OpenAlex W ID, s2: ID or public HTTPS article/PDF URL.');
  if (!records.length && (d || a) && enabled('semantic_scholar')) await tryLoad('semantic_scholar', () => s2.get(d ? `DOI:${d}` : `ARXIV:${a!.base}`, deadline(4000, signal)));
  if (!records.length) throw new ToolError('METADATA_UNAVAILABLE', warnings.join('; ') || 'No source is available.', true, 'Check the identifier or try the public article URL.');
  let paper = mergePapers(records)[0];
  const id = s2.s2Id(paper);
  if (enrich && id && enabled('semantic_scholar') && !paper.identifiers.semantic_scholar) {
    try { paper = mergePapers([paper, await s2.get(id, deadline(4000, parent))])[0]; }
    catch (e) { warnings.push(`semantic_scholar enrichment: ${errorMessage(e)}`); }
  }
  const result = { paper, warnings };
  if ((a || d || oid || sid) && !warnings.length) metadataCache.set(key, result, 86_400_000);
  return result;
}

export async function readFullText(paper: PaperRecord, signal: AbortSignal, preferPdf = false, pageRange?: { start: number; count: number }): Promise<{ document: ParsedDocument | null; version_url: string | null; warnings: string[] }> {
  const warnings: string[] = [];
  const a = paper.identifiers.arxiv;
  const version = a ? arxiv(paper.versions.find(v => v.id.startsWith('arxiv:'))?.id.replace('arxiv:', '') ?? a) : null;
  const urls = [...new Set([
    preferPdf ? paper.pdf_url : null,
    version ? `https://arxiv.org/html/${version.base}${version.version ?? ''}` : null,
    !a && paper.oa_url && !/\.pdf(?:$|\?)/i.test(paper.oa_url) && !paper.oa_url.includes('/pdf/') ? paper.oa_url : null,
    paper.pdf_url, !a ? paper.oa_url : null,
  ].filter((u): u is string => Boolean(u)))];
  for (const url of urls) {
    if (signal.aborted) break;
    try {
      const pdfCandidate = /\/pdf\/|\.pdf(?:$|\?)/i.test(url);
      const response = await fetchPublic(url, { source: url.includes('arxiv.org') ? 'arxiv' : 'web', signal: deadline(pdfCandidate ? 15_000 : 7000, signal), maxBytes: pdfCandidate ? 25 * 1024 * 1024 : 5 * 1024 * 1024 });
      const isPdf = /pdf/i.test(response.contentType) || new TextDecoder().decode(response.bytes.slice(0, 5)) === '%PDF-';
      const doc = await parseDocument(isPdf ? 'pdf' : 'html', isPdf ? response.bytes : new TextDecoder().decode(response.bytes), signal, pageRange);
      if (doc.segments.length || (isPdf && pageRange && doc.page_count !== null && pageRange.start > doc.page_count))
        return { document: doc, version_url: response.url, warnings };
      if (!isPdf && doc.metadata?.pdf) {
        const pdfUrl = new URL(doc.metadata.pdf, response.url).href;
        if (!urls.includes(pdfUrl)) urls.push(pdfUrl);
      }
      warnings.push(`${url}: no readable article body.`);
    } catch (e) { warnings.push(`${url}: ${errorMessage(e)}`); }
  }
  return { document: null, version_url: null, warnings };
}
export function evidence(p: PaperRecord, segment: Segment, url: string, basis: 'abstract' | 'full_text' = 'full_text'): Passage {
  return { id: `E-${hash(`${p.id}:${url}:${segment.page}:${segment.paragraph}:${segment.text}`)}`, paper_id: p.id,
    quote: segment.text.slice(0, 2400), version_url: url,
    locator: basis === 'abstract' ? { section: 'Abstract' } : { ...(segment.page ? { page: segment.page } : {}), section: segment.section, paragraph: segment.paragraph }, basis };
}
export function pickPassages(p: PaperRecord, doc: ParsedDocument | null, url: string | null, focus: string | undefined, max: number): Passage[] {
  if (!doc || !url) return p.abstract ? [evidence(p, { text: p.abstract, section: 'Abstract', paragraph: 1 }, p.canonical_url, 'abstract')] : [];
  const terms = focus?.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(t => t.length > 2) ?? [];
  const ranked = doc.segments.map((segment, index) => ({ segment, index, score: terms.reduce((n, t) => n + (segment.text.toLowerCase().includes(t) ? 1 : 0) + (segment.section.toLowerCase().includes(t) ? 4 : 0), 0) }));
  if (terms.length) ranked.sort((a, b) => b.score - a.score || a.index - b.index);
  return ranked.filter(s => !terms.length || s.score > 0).slice(0, max).map(s => evidence(p, s.segment, url));
}
