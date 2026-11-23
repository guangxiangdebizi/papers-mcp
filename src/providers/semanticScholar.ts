import { arxiv, blankPaper, doi, namedAuthor, sourced, type PaperRecord } from '../core/paper.js';
import { fetchJson, metadataCache } from '../net/fetchPublic.js';
import type { Json } from './types.js';

const fields = 'paperId,externalIds,title,authors,year,publicationDate,venue,publicationVenue,abstract,citationCount,tldr,openAccessPdf,url,publicationTypes';
export async function request(path: string, params: Record<string, string>, signal: AbortSignal): Promise<Json> {
  const key = `s2:${path}:${JSON.stringify(params)}`;
  const cached = metadataCache.get<Json>(key);
  if (cached) return cached;
  const url = new URL(`https://api.semanticscholar.org/graph/v1/${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const data = await fetchJson(url.href, 'semantic_scholar', signal,
    process.env.S2_API_KEY ? { 'x-api-key': process.env.S2_API_KEY } : undefined) as Json;
  metadataCache.set(key, data, 86_400_000);
  return data;
}
export function normalize(w: Json): PaperRecord {
  const d = doi(w.externalIds?.DOI ?? '');
  const ax = arxiv(w.externalIds?.ArXiv ?? '');
  const p = blankPaper(`s2:${w.paperId}`, w.url ?? `https://www.semanticscholar.org/paper/${w.paperId}`);
  p.identifiers = { doi: d, arxiv: ax?.base ?? null, openalex: null, semantic_scholar: w.paperId ?? null };
  p.title = w.title ?? null; p.authors = (w.authors ?? []).map((a: Json) => ({ ...namedAuthor(a.name ?? ''), id: a.authorId ?? null }));
  p.venue = w.venue || null; p.issns = w.publicationVenue?.issn ? [w.publicationVenue.issn] : [];
  p.published = w.publicationDate ?? (w.year ? String(w.year) : null); p.date_kind = 'publication';
  p.abstract = w.abstract ?? null; p.work_type = w.publicationTypes?.[0] ?? null;
  p.pdf_url = w.openAccessPdf?.url || null; p.oa_url = p.pdf_url; p.oa_status = p.pdf_url ? 'open' : null;
  p.cited_by_count = typeof w.citationCount === 'number' ? w.citationCount : null;
  p.citation_as_of = p.cited_by_count === null ? null : new Date().toISOString();
  p.tldr = w.tldr?.text ?? null;
  return sourced(p, 'semantic_scholar', `https://api.semanticscholar.org/graph/v1/paper/${w.paperId}`);
}
export function s2Id(p: PaperRecord): string | null {
  return p.identifiers.semantic_scholar ?? (p.identifiers.doi ? `DOI:${p.identifiers.doi}` : p.identifiers.arxiv ? `ARXIV:${p.identifiers.arxiv}` : null);
}
export async function get(id: string, signal: AbortSignal): Promise<PaperRecord> {
  return normalize(await request(`paper/${encodeURIComponent(id)}`, { fields }, signal));
}
export async function links(id: string, direction: 'citations' | 'references', offset: number, limit: number, signal: AbortSignal) {
  const data = await request(`paper/${encodeURIComponent(id)}/${direction}`, { fields: fields.replace(',tldr', ''), offset: String(offset), limit: String(limit) }, signal);
  return { items: (data.data ?? []).map((x: Json) => x.citingPaper ?? x.citedPaper).filter((x: Json) => x?.paperId).map(normalize),
    has_more: typeof data.next === 'number', next_offset: data.next ?? null };
}
