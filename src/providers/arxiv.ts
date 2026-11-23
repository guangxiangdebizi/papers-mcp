import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { arxiv, blankPaper, doi, namedAuthor, sourced, ToolError, type PaperRecord } from '../core/paper.js';
import { fetchPublic, metadataCache } from '../net/fetchPublic.js';
import { clean, list, type Json, type SearchInput, type ProviderResult } from './types.js';

export function parseAtom(xml: string): { items: PaperRecord[]; total: number } {
  if (XMLValidator.validate(xml) !== true) throw new ToolError('INVALID_RESPONSE', 'arXiv returned invalid XML.');
  const feed = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '', removeNSPrefix: true }).parse(xml).feed;
  if (!feed) throw new ToolError('INVALID_RESPONSE', 'arXiv returned no Atom feed.');
  const items = list<Json>(feed.entry).map((e: Json) => {
    const ax = arxiv(e.id ?? '');
    if (!ax) throw new ToolError('UPSTREAM_ERROR', clean(e.summary) || 'Invalid arXiv entry.');
    const versioned = `${ax.base}${ax.version ?? ''}`;
    const p = blankPaper(`arxiv:${ax.base}`, `https://arxiv.org/abs/${versioned}`);
    p.identifiers.arxiv = ax.base; p.identifiers.doi = doi(e.doi ?? '');
    p.title = clean(e.title) || null;
    p.authors = list<Json>(e.author).map(a => namedAuthor(clean(a.name)));
    p.published = String(e.published ?? '').slice(0, 10) || null;
    p.updated = String(e.updated ?? '').slice(0, 10) || null;
    p.date_kind = 'submitted'; p.work_type = 'preprint';
    p.abstract = clean(e.summary) || null;
    p.categories = list<Json>(e.category).map(c => c.term).filter(Boolean);
    p.oa_status = 'green'; p.oa_url = p.canonical_url;
    p.pdf_url = `https://arxiv.org/pdf/${versioned}`;
    p.versions = [{ id: `arxiv:${versioned}`, url: p.canonical_url, published: p.published, updated: p.updated, kind: 'preprint' }];
    return sourced(p, 'arxiv', p.canonical_url);
  });
  return { items, total: Number(feed.totalResults ?? items.length) };
}
async function request(params: Record<string, string>, signal: AbortSignal): Promise<{ items: PaperRecord[]; total: number }> {
  const key = `arxiv:${JSON.stringify(params)}`;
  const cached = metadataCache.get<{ items: PaperRecord[]; total: number }>(key);
  if (cached) return cached;
  const url = new URL('https://export.arxiv.org/api/query');
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const data = parseAtom(new TextDecoder().decode((await fetchPublic(url.href, { source: 'arxiv', signal })).bytes));
  metadataCache.set(key, data, params.id_list ? 86_400_000 : 900_000);
  return data;
}
const literal = (s: string) => `"${s.replace(/["\\:()\[\]{}]/g, ' ').replace(/\s+/g, ' ').trim()}"`;
export async function search(input: SearchInput, signal: AbortSignal): Promise<ProviderResult> {
  const f = input.filters;
  const terms = [`all:${literal(input.query)}`];
  if (f.author) terms.push(`au:${literal(f.author)}`);
  if (f.arxiv_category) terms.push(`cat:${f.arxiv_category}`);
  if (f.from || f.to) terms.push(`submittedDate:[${(f.from ?? '1991-01-01').replaceAll('-', '')}0000 TO ${(f.to ?? '2999-12-31').replaceAll('-', '')}2359]`);
  const data = await request({ search_query: terms.join(' AND '), start: '0', max_results: String(input.limit),
    sortBy: input.sort === 'date_desc' ? 'submittedDate' : 'relevance', sortOrder: 'descending' }, signal);
  return { items: data.items, truncated: data.total > input.limit };
}
export async function get(ref: string, signal: AbortSignal): Promise<PaperRecord> {
  const ax = arxiv(ref)!;
  const data = await request({ id_list: `${ax.base}${ax.version ?? ''}` }, signal);
  if (!data.items.length) throw new ToolError('NOT_FOUND', `arXiv ${ref} was not found.`);
  if (ax.version && !data.items[0].versions.some(v => v.id === `arxiv:${ax.base}${ax.version}`))
    throw new ToolError('VERSION_MISMATCH', `arXiv did not return requested version ${ax.version}.`);
  return data.items[0];
}
