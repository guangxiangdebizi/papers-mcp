import { blankPaper, doi, namedAuthor, sourced, type PaperRecord } from '../core/paper.js';
import { fetchJson, metadataCache } from '../net/fetchPublic.js';
import { clean, type Json, type SearchInput, type ProviderResult } from './types.js';

const base = 'https://api.crossref.org';
export function normalize(w: Json): PaperRecord {
  const d = doi(w.DOI ?? '')!;
  const p = blankPaper(`doi:${d}`, `https://doi.org/${d}`);
  p.identifiers.doi = d;
  p.title = clean(w.title?.[0]) || null;
  p.authors = (w.author ?? []).map((a: Json) => ({ ...namedAuthor(a.name ?? [a.given, a.family].filter(Boolean).join(' ')),
    given: a.given ?? null, family: a.family ?? null, literal: a.name ?? null, orcid: a.ORCID ?? null }));
  p.institutions = (w.author ?? []).flatMap((a: Json) => (a.affiliation ?? []).map((i: Json) => ({ id: null, name: i.name ?? '' })));
  p.venue = clean(w['container-title']?.[0]) || null;
  p.issns = w.ISSN ?? [];
  p.work_type = w.type ?? null;
  const date = w.published?.['date-parts']?.[0] ?? w['published-print']?.['date-parts']?.[0] ?? w['published-online']?.['date-parts']?.[0] ?? w.issued?.['date-parts']?.[0];
  p.published = Array.isArray(date) && Number.isInteger(date[0]) && date[0] > 0
    ? date.map((x: number, i: number) => i === 0 ? String(x) : String(x).padStart(2, '0')).join('-') : null;
  p.date_kind = 'publication';
  p.abstract = clean(w.abstract) || null;
  // Crossref license/link fields alone do not establish open access.
  p.volume = w.volume ?? null; p.issue = w.issue ?? null; p.pages = w.page ?? null; p.publisher = w.publisher ?? null;
  p.versions = [{ id: p.id, url: p.canonical_url, published: p.published, updated: null, kind: p.work_type ?? 'publication' }];
  for (const [relation, records] of Object.entries(w.relation ?? {})) {
    if (!['is-preprint-of', 'has-preprint', 'is-version-of', 'has-version'].includes(relation)) continue;
    for (const r of records as Json[]) if (r['id-type'] === 'doi' && doi(r.id))
      p.versions.push({ id: `doi:${doi(r.id)}`, url: `https://doi.org/${doi(r.id)}`, published: null, updated: null, kind: relation });
  }
  return sourced(p, 'crossref', `${base}/works/${encodeURIComponent(d)}`);
}
async function request(path: string, params: Record<string, string>, signal: AbortSignal): Promise<Json> {
  const key = `crossref:${path}:${JSON.stringify(params)}`;
  const cached = metadataCache.get<Json>(key);
  if (cached) return cached;
  const url = new URL(`${base}/${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  if (process.env.CONTACT_EMAIL) url.searchParams.set('mailto', process.env.CONTACT_EMAIL);
  const data = await fetchJson(url.href, 'crossref', signal) as Json;
  metadataCache.set(key, data, path === 'works' ? 900_000 : 86_400_000);
  return data;
}
export async function search(input: SearchInput, signal: AbortSignal): Promise<ProviderResult> {
  const params: Record<string, string> = { 'query.bibliographic': input.query, 'query.title': input.query, rows: String(input.limit) };
  const f = input.filters, filters: string[] = [];
  if (f.from) filters.push(`from-pub-date:${f.from}`);
  if (f.to) filters.push(`until-pub-date:${f.to}`);
  if (f.venue && /^\d{4}-\d{3}[\dX]$/i.test(f.venue)) filters.push(`issn:${f.venue}`);
  else if (f.venue) params['query.container-title'] = f.venue;
  if (f.author) params['query.author'] = f.author;
  if (filters.length) params.filter = filters.join(',');
  if (input.sort === 'date_desc') { params.sort = 'published'; params.order = 'desc'; }
  const data = (await request('works', params, signal)).message;
  return { items: (data.items ?? []).map(normalize), truncated: (data['total-results'] ?? 0) > input.limit };
}
export async function get(ref: string, signal: AbortSignal): Promise<PaperRecord> {
  return normalize((await request(`works/${encodeURIComponent(doi(ref)!)}`, {}, signal)).message);
}
