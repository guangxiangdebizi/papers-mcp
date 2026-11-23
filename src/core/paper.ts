import * as z from 'zod/v4';
import { createHash } from 'node:crypto';

export const Source = z.enum(['openalex', 'crossref', 'arxiv', 'semantic_scholar', 'web']);
export type SourceName = z.infer<typeof Source>;
export const Author = z.object({
  name: z.string(), given: z.string().nullable(), family: z.string().nullable(),
  literal: z.string().nullable(), id: z.string().nullable(), orcid: z.string().nullable(),
});
export const Paper = z.object({
  id: z.string(), identifiers: z.object({ doi: z.string().nullable(), arxiv: z.string().nullable(),
    openalex: z.string().nullable(), semantic_scholar: z.string().nullable() }),
  title: z.string().nullable(), authors: z.array(Author), venue: z.string().nullable(),
  venue_id: z.string().nullable(), issns: z.array(z.string()), work_type: z.string().nullable(),
  published: z.string().nullable(), updated: z.string().nullable(), date_kind: z.string(),
  canonical_url: z.string(), oa_url: z.string().nullable(), pdf_url: z.string().nullable(),
  oa_status: z.string().nullable(), abstract: z.string().nullable(),
  cited_by_count: z.number().nullable(), citation_as_of: z.string().nullable(), tldr: z.string().nullable(),
  categories: z.array(z.string()), institutions: z.array(z.object({ id: z.string().nullable(), name: z.string() })),
  volume: z.string().nullable(), issue: z.string().nullable(), pages: z.string().nullable(), publisher: z.string().nullable(),
  provenance: z.array(z.object({ source: Source, url: z.string(), retrieved_at: z.string(), fields: z.array(z.string()) })),
  field_sources: z.record(z.string(), z.array(Source)),
  versions: z.array(z.object({ id: z.string(), url: z.string(), published: z.string().nullable(),
    updated: z.string().nullable(), kind: z.string() })),
});
export type PaperRecord = z.infer<typeof Paper>;
export const Evidence = z.object({ id: z.string(), paper_id: z.string(), quote: z.string(), version_url: z.string(),
  locator: z.object({ page: z.number().int().positive().optional(), section: z.string().optional(),
    paragraph: z.number().int().positive().optional() }), basis: z.enum(['abstract', 'full_text']) });
export type Passage = z.infer<typeof Evidence>;
export const SourceStatus = z.object({ name: Source, status: z.enum(['ok', 'error', 'skipped']),
  reason: z.string().optional(), cache_hit: z.boolean().optional(), retrieved: z.number().optional() });
export const Filters = z.object({
  from: z.iso.date().optional(), to: z.iso.date().optional(),
  author: z.string().trim().min(1).max(200).optional(),
  institution: z.string().trim().min(1).max(200).optional(),
  venue: z.string().trim().min(1).max(200).optional(),
  arxiv_category: z.string().regex(/^[A-Za-z-]+(?:\.[A-Za-z-]+)?$/).optional(), oa_only: z.boolean().optional(),
}).strict();
export type FilterArgs = z.infer<typeof Filters>;

export class ToolError extends Error {
  constructor(public code: string, message: string, public retryable = false,
    public next_action = 'Check the input or retry later.', public details?: unknown) { super(message); }
}
export const errorMessage = (e: unknown) => e instanceof Error ? e.message : String(e);
export const hash = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 10);
export function doi(s: string): string | null {
  let value = s.trim();
  if (/^https?:\/\/(?:dx\.)?doi\.org\//i.test(value)) {
    try { value = decodeURIComponent(new URL(value).pathname.slice(1)); } catch { return null; }
  } else value = value.replace(/^doi:\s*/i, '');
  return /^10\.\d{4,9}\/\S+$/i.test(value) ? value.toLowerCase() : null;
}
export function arxiv(s: string): { base: string; version: string | null } | null {
  const value = s.trim().replace(/^(?:arxiv:\s*|https?:\/\/(?:(?:export|www)\.)?arxiv\.org\/(?:abs|pdf|html)\/)/i, '')
    .replace(/[?#].*$/, '').replace(/\.pdf$/i, '');
  const m = /^(\d{4}\.\d{4,5}|[a-z-]+(?:\.[A-Z]{2})?\/\d{7})(v\d+)?$/i.exec(value);
  return m ? { base: m[1], version: m[2] ?? null } : null;
}
export function blankPaper(id: string, url: string): PaperRecord {
  return { id, identifiers: { doi: null, arxiv: null, openalex: null, semantic_scholar: null },
    title: null, authors: [], venue: null, venue_id: null, issns: [], work_type: null,
    published: null, updated: null, date_kind: 'unknown', canonical_url: url,
    oa_url: null, pdf_url: null, oa_status: null, abstract: null, cited_by_count: null,
    citation_as_of: null, tldr: null, categories: [], institutions: [], volume: null, issue: null,
    pages: null, publisher: null, provenance: [], field_sources: {}, versions: [] };
}
export function sourced(p: PaperRecord, source: SourceName, url: string): PaperRecord {
  const fields = Object.keys(p).filter(k => !['provenance', 'field_sources'].includes(k) &&
    p[k as keyof PaperRecord] !== null && (!Array.isArray(p[k as keyof PaperRecord]) || (p[k as keyof PaperRecord] as unknown[]).length));
  p.provenance.push({ source, url, retrieved_at: new Date().toISOString(), fields });
  for (const field of fields) p.field_sources[field] = [source];
  return p;
}
export function aliases(p: PaperRecord): string[] {
  return [p.id, p.identifiers.doi && `doi:${p.identifiers.doi}`, p.identifiers.arxiv && `arxiv:${p.identifiers.arxiv}`,
    p.identifiers.openalex && `openalex:${p.identifiers.openalex}`, p.identifiers.semantic_scholar && `s2:${p.identifiers.semantic_scholar}`]
    .filter((x): x is string => Boolean(x));
}
export function mergePapers(items: PaperRecord[]): PaperRecord[] {
  const groups: PaperRecord[] = [];
  for (const input of items) {
    let p = structuredClone(input);
    const matching = groups.filter(g => aliases(g).some(a => aliases(p).includes(a)));
    const insertion = matching.length ? groups.indexOf(matching[0]) : groups.length;
    for (const other of [...matching].reverse()) {
      // Keep established metadata; add complementary fields and their own provenance.
      const merged = structuredClone(other);
      for (const key of Object.keys(p) as (keyof PaperRecord)[]) {
        if (['identifiers', 'versions', 'provenance', 'field_sources', 'id'].includes(key)) continue;
        if (merged[key] === null || (Array.isArray(merged[key]) && !(merged[key] as unknown[]).length)) {
          Object.assign(merged, { [key]: p[key] });
          merged.field_sources[key] = p.field_sources[key] ?? [];
        } else if (JSON.stringify(merged[key]) === JSON.stringify(p[key])) {
          merged.field_sources[key] = [...new Set([...(merged.field_sources[key] ?? []), ...(p.field_sources[key] ?? [])])];
        }
      }
      for (const k of Object.keys(p.identifiers) as (keyof PaperRecord['identifiers'])[]) merged.identifiers[k] ??= p.identifiers[k];
      merged.provenance = [...merged.provenance, ...p.provenance].filter((v, i, all) => all.findIndex(x => x.source === v.source && x.url === v.url) === i);
      merged.versions = [...merged.versions, ...p.versions].filter((v, i, all) => all.findIndex(x => x.id === v.id && x.url === v.url) === i);
      groups.splice(groups.indexOf(other), 1);
      p = merged;
    }
    if (p.identifiers.doi) p.id = `doi:${p.identifiers.doi}`;
    else if (p.identifiers.arxiv) p.id = `arxiv:${p.identifiers.arxiv}`;
    groups.splice(insertion, 0, p);
  }
  return groups;
}
export function namedAuthor(name: string): z.infer<typeof Author> {
  return { name, given: null, family: null, literal: name, id: null, orcid: null };
}
