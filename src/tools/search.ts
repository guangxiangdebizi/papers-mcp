import * as z from 'zod/v4';
import { Filters, Paper, SourceStatus, ToolError, aliases, errorMessage, mergePapers, type PaperRecord, type FilterArgs } from '../core/paper.js';
import { deadline, metadataCache } from '../net/fetchPublic.js';
import * as openalex from '../providers/openalex.js';
import * as crossref from '../providers/crossref.js';
import * as arxiv from '../providers/arxiv.js';
import type { ProviderResult } from '../providers/types.js';

export const SearchInput = z.object({ query: z.string().trim().min(1).max(300), filters: Filters.default({}),
  sources: z.array(z.enum(['openalex', 'crossref', 'arxiv'])).min(1).max(3).optional(),
  sort: z.enum(['relevance', 'date_desc', 'citations_desc']).default('relevance'), limit: z.number().int().min(1).max(20).default(8),
}).strict();
export const SearchData = z.object({ items: z.array(Paper), query_recipe: SearchInput, applied_filters: Filters,
  searched_sources: z.array(z.string()), sources: z.array(SourceStatus), truncated: z.boolean(),
  cache_hit: z.boolean(), retrieved_at: z.string(), similar_titles: z.array(z.array(z.string())), warnings: z.array(z.string()) });
export type SearchArgs = z.infer<typeof SearchInput>;
const shortId = (s: string) => s.replace(/^https:\/\/openalex.org\//i, '');
function matches(p: PaperRecord, f: FilterArgs): boolean {
  const start = p.published?.length === 4 ? `${p.published}-01-01` : p.published?.length === 7 ? `${p.published}-01` : p.published;
  const end = p.published?.length === 4 ? `${p.published}-12-31` : p.published?.length === 7
    ? new Date(Date.UTC(Number(p.published.slice(0, 4)), Number(p.published.slice(5, 7)), 0)).toISOString().slice(0, 10) : p.published;
  if (f.from && (!start || start < f.from)) return false;
  if (f.to && (!end || end > f.to)) return false;
  if (f.oa_only && (!p.oa_url || !p.oa_status || ['closed', 'unknown'].includes(p.oa_status))) return false;
  if (f.arxiv_category && !p.categories.includes(f.arxiv_category)) return false;
  if (f.venue) {
    if (/^S\d+$/i.test(shortId(f.venue))) { if (shortId(p.venue_id ?? '') !== shortId(f.venue)) return false; }
    else if (/^\d{4}-\d{3}[\dX]$/i.test(f.venue)) { if (!p.issns.includes(f.venue)) return false; }
    else if (p.venue?.toLowerCase() !== f.venue.toLowerCase()) return false;
  }
  if (f.author) {
    if (/^A\d+$/i.test(shortId(f.author))) { if (!p.authors.some(a => shortId(a.id ?? '') === shortId(f.author!))) return false; }
    else if (!p.authors.some(a => a.name.toLowerCase() === f.author!.toLowerCase())) return false;
  }
  if (f.institution && !p.institutions.some(i => shortId(i.id ?? '') === shortId(f.institution!))) return false;
  return true;
}
export async function searchPapers(args: SearchArgs, parent?: AbortSignal) {
  if (args.filters.from && args.filters.to && args.filters.from > args.filters.to)
    throw new ToolError('INVALID_FILTER', 'filters.from must not be after filters.to.');
  const key = `search:${JSON.stringify(args)}`;
  const cached = metadataCache.get<z.infer<typeof SearchData>>(key);
  if (cached) return { ...cached, cache_hit: true };
  const signal = deadline(20_000, parent);
  const selected = [...new Set(args.sources ?? ['openalex', 'crossref', 'arxiv'] as const)];
  const statuses: z.infer<typeof SourceStatus>[] = [];
  const active = selected.filter(name => {
    let reason = '';
    if (args.sort === 'citations_desc' && name !== 'openalex') reason = 'Citation sorting is supported by OpenAlex only.';
    if (args.filters.arxiv_category && name !== 'arxiv') reason = 'arxiv_category requires arXiv.';
    if (args.filters.institution && name !== 'openalex') reason = 'Institution identity requires OpenAlex.';
    if (args.filters.venue && name === 'arxiv') reason = 'arXiv cannot verify publication venue.';
    if (args.filters.oa_only && name === 'crossref') reason = 'Crossref cannot verify OA status.';
    if (args.filters.author && /^A\d+$/i.test(shortId(args.filters.author)) && name !== 'openalex') reason = 'OpenAlex author ID requires OpenAlex.';
    if (args.filters.venue && /^S\d+$/i.test(shortId(args.filters.venue)) && name !== 'openalex') reason = 'OpenAlex source ID requires OpenAlex.';
    if (process.env.DISABLED_SOURCES?.split(',').map(s => s.trim()).includes(name)) reason = 'Disabled by platform configuration.';
    if (reason) statuses.push({ name, status: 'skipped', reason });
    return !reason;
  });
  if (!active.length) throw new ToolError('UNSUPPORTED_FILTER', 'No selected source supports all filters and sorting.', false, 'Remove the incompatible filter or select a compatible source.', statuses);
  const resolved = { ...args.filters };
  let resolutionError: unknown;
  if (active.includes('openalex')) {
    try {
      for (const [key, kind] of [['author', 'authors'], ['institution', 'institutions'], ['venue', 'sources']] as const)
        if (resolved[key]) resolved[key] = (await openalex.entity(kind, resolved[key]!, signal)).id;
    } catch (e) {
      if (e instanceof ToolError && ['AMBIGUOUS_ENTITY', 'ENTITY_NOT_FOUND'].includes(e.code)) throw e;
      resolutionError = e;
    }
  }
  const providers = { openalex, crossref, arxiv };
  const batches = await Promise.all(active.map(async name => {
    try {
      if (name === 'openalex' && resolutionError) throw resolutionError;
      const filters = name === 'openalex' ? resolved : args.filters;
      const result = await providers[name].search({ ...args, filters, limit: 20 }, signal);
      const items = result.items.filter(p => matches(p, filters));
      statuses.push({ name, status: 'ok', retrieved: items.length });
      return { ...result, items };
    } catch (e) {
      statuses.push({ name, status: 'error', reason: errorMessage(e) });
      return { items: [], truncated: false } as ProviderResult;
    }
  }));
  if (!statuses.some(s => s.status === 'ok')) throw new ToolError('ALL_SOURCES_FAILED', statuses.map(s => `${s.name}: ${s.reason}`).join('; '), true);
  const merged = mergePapers(batches.flatMap(b => b.items));
  const score = (p: PaperRecord) => batches.reduce((total, b) => {
    const rank = b.items.findIndex(x => aliases(x).some(a => aliases(p).includes(a)));
    return total + (rank < 0 ? 0 : 1 / (61 + rank));
  }, 0);
  merged.sort((a, b) => {
    const order = args.sort === 'date_desc' ? (b.published ?? '').localeCompare(a.published ?? '') : args.sort === 'citations_desc'
      ? (b.cited_by_count ?? -1) - (a.cited_by_count ?? -1) : score(b) - score(a);
    return order || a.id.localeCompare(b.id);
  });
  const titles = new Map<string, string[]>();
  for (const p of merged) if (p.title) { const title = p.title.toLowerCase().replace(/[^\p{L}\p{N}]/gu, ''); titles.set(title, [...(titles.get(title) ?? []), p.id]); }
  const result = { items: merged.slice(0, args.limit), query_recipe: args, applied_filters: resolved,
    searched_sources: active, sources: statuses.sort((a, b) => selected.indexOf(a.name as typeof active[number]) - selected.indexOf(b.name as typeof active[number])),
    truncated: merged.length > args.limit || batches.some(b => b.truncated), cache_hit: false,
    retrieved_at: new Date().toISOString(), similar_titles: [...titles.values()].filter(ids => ids.length > 1),
    warnings: statuses.filter(s => s.status === 'error').map(s => `${s.name}: ${s.reason}`) };
  if (statuses.every(s => s.status !== 'error')) metadataCache.set(key, result, 900_000);
  return result;
}
