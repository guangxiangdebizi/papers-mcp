import { blankPaper, doi, arxiv, namedAuthor, sourced, ToolError, type PaperRecord } from '../core/paper.js';
import { fetchJson, metadataCache } from '../net/fetchPublic.js';
import { clean, type Json, type SearchInput, type ProviderResult } from './types.js';

const base = 'https://api.openalex.org';
export function apiUrl(path: string, params: Record<string, string> = {}): string {
  const url = new URL(`${base}/${path}`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  if (process.env.OPENALEX_API_KEY) url.searchParams.set('api_key', process.env.OPENALEX_API_KEY);
  if (process.env.CONTACT_EMAIL) url.searchParams.set('mailto', process.env.CONTACT_EMAIL);
  return url.href;
}
export async function request(path: string, params: Record<string, string>, signal: AbortSignal): Promise<Json> {
  const key = `openalex:${path}:${JSON.stringify(params)}`;
  const cached = metadataCache.get<Json>(key);
  if (cached) return cached;
  const data = await fetchJson(apiUrl(path, params), 'openalex', signal) as Json;
  metadataCache.set(key, data, path === 'works' ? 900_000 : 86_400_000);
  return data;
}
function abstract(index: Json | null): string | null {
  if (!index) return null;
  const words: string[] = [];
  for (const [word, positions] of Object.entries(index)) for (const pos of positions as number[]) words[pos] = word;
  return words.join(' ') || null;
}
export function normalize(w: Json): PaperRecord {
  const d = doi(w.doi ?? '') || null;
  const locations = w.locations ?? [];
  const ax = locations.map((l: Json) => arxiv(l.landing_page_url ?? '') ?? arxiv(l.pdf_url ?? '')).find(Boolean);
  const p = blankPaper(d ? `doi:${d}` : w.id.replace('https://openalex.org/', 'openalex:'), w.doi ?? w.primary_location?.landing_page_url ?? w.id);
  p.identifiers = { doi: d, arxiv: ax?.base ?? null, openalex: w.id?.split('/').pop() ?? null, semantic_scholar: null };
  p.title = w.title ?? w.display_name ?? null;
  p.authors = (w.authorships ?? []).map((a: Json) => ({ ...namedAuthor(a.author?.display_name ?? ''), id: a.author?.id ?? null, orcid: a.author?.orcid ?? null }));
  p.institutions = (w.authorships ?? []).flatMap((a: Json) => (a.institutions ?? []).map((i: Json) => ({ id: i.id ?? null, name: i.display_name ?? '' })));
  const source = w.primary_location?.source;
  p.venue = source?.display_name ?? null;
  p.venue_id = source?.id ?? null;
  p.issns = source?.issn ?? [];
  p.work_type = w.type ?? null;
  p.published = w.publication_date ?? (w.publication_year ? String(w.publication_year) : null);
  p.updated = w.updated_date ?? null;
  p.date_kind = 'publication';
  p.abstract = abstract(w.abstract_inverted_index);
  p.oa_status = w.open_access?.oa_status ?? null;
  p.oa_url = w.best_oa_location?.landing_page_url ?? w.best_oa_location?.pdf_url ?? w.open_access?.oa_url ?? null;
  p.pdf_url = w.best_oa_location?.pdf_url ?? w.primary_location?.pdf_url ?? null;
  p.cited_by_count = typeof w.cited_by_count === 'number' ? w.cited_by_count : null;
  p.citation_as_of = p.cited_by_count === null ? null : new Date().toISOString();
  p.volume = w.biblio?.volume ?? null;
  p.issue = w.biblio?.issue ?? null;
  p.pages = w.biblio?.first_page ? [w.biblio.first_page, w.biblio.last_page].filter(Boolean).join('-') : null;
  p.versions = [{ id: p.id, url: p.canonical_url, published: p.published, updated: p.updated, kind: p.work_type ?? 'publication' }];
  return sourced(p, 'openalex', `${base}/works/${p.identifiers.openalex}`);
}
export async function entity(kind: 'authors' | 'institutions' | 'sources', value: string, signal: AbortSignal): Promise<Json> {
  const prefix = { authors: 'A', institutions: 'I', sources: 'S' }[kind];
  const id = value.replace(/^https:\/\/openalex\.org\//i, '');
  if (new RegExp(`^${prefix}\\d+$`, 'i').test(id)) return request(`${kind}/${id}`, {}, signal);
  const params: Record<string, string> = /^\d{4}-\d{3}[\dX]$/i.test(value) && kind === 'sources'
    ? { filter: `issn:${value}` } : { search: value };
  const data = await request(kind, { ...params, per_page: '5' }, signal);
  const candidates = (data.results ?? []).map((x: Json) => ({ id: x.id, name: x.display_name, issns: x.issn ?? [] }));
  const exact = candidates.filter((x: Json) => x.name.toLowerCase() === value.toLowerCase() || x.issns.includes(value));
  if (exact.length === 1) return { id: exact[0].id, display_name: exact[0].name, issn: exact[0].issns };
  throw new ToolError(candidates.length ? 'AMBIGUOUS_ENTITY' : 'ENTITY_NOT_FOUND',
    `${kind}: supply an exact OpenAlex ID or ISSN. Candidates: ${JSON.stringify(candidates)}`,
    false, 'Select a candidate ID and use it in the same filter.', candidates);
}
export async function search(input: SearchInput, signal: AbortSignal): Promise<ProviderResult> {
  const f = input.filters;
  const filters: string[] = [];
  if (f.from) filters.push(`from_publication_date:${f.from}`);
  if (f.to) filters.push(`to_publication_date:${f.to}`);
  if (f.oa_only) filters.push('is_oa:true');
  if (f.author) filters.push(`authorships.author.id:${f.author}`);
  if (f.institution) filters.push(`authorships.institutions.id:${f.institution}`);
  if (f.venue) filters.push(`primary_location.source.id:${f.venue}`);
  const params: Record<string, string> = { search: input.query, per_page: String(input.limit) };
  if (filters.length) params.filter = filters.join(',');
  if (input.sort === 'date_desc') params.sort = 'publication_date:desc';
  if (input.sort === 'citations_desc') params.sort = 'cited_by_count:desc';
  const w = await request('works', params, signal);
  return { items: (w.results ?? []).map(normalize), truncated: (w.meta?.count ?? 0) > input.limit };
}
export async function get(ref: string, signal: AbortSignal): Promise<PaperRecord> {
  const id = doi(ref) ? `https://doi.org/${doi(ref)}` : ref.replace(/^https:\/\/openalex.org\//, '').replace(/^openalex:/i, '');
  return normalize(await request(`works/${encodeURIComponent(id)}`, {}, signal));
}
