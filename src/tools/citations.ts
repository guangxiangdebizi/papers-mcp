import * as z from 'zod/v4';
import { Paper, SourceStatus, ToolError, errorMessage, mergePapers } from '../core/paper.js';
import { deadline } from '../net/fetchPublic.js';
import { loadMetadata } from '../reading/reader.js';
import * as oa from '../providers/openalex.js';
import * as s2 from '../providers/semanticScholar.js';
import { mapLimit } from './compare.js';

export const CitationsInput = z.object({ ref: z.string().trim().min(1).max(2000),
  direction: z.enum(['citations', 'references']).default('references'),
  source: z.enum(['auto', 'openalex', 'semantic_scholar']).default('auto'),
  offset: z.number().int().min(0).max(9000).default(0), limit: z.number().int().min(1).max(50).default(10),
}).strict();
export const CitationsData = z.object({ paper: Paper, direction: z.enum(['citations', 'references']), items: z.array(Paper),
  source: z.enum(['openalex', 'semantic_scholar']), offset: z.number(), next_offset: z.number().nullable(), has_more: z.boolean(),
  sources: z.array(SourceStatus), warnings: z.array(z.string()), retrieved_at: z.string() });
export async function getCitations(args: z.infer<typeof CitationsInput>, parent?: AbortSignal) {
  const signal = deadline(30_000, parent);
  const { paper, warnings } = await loadMetadata(args.ref, signal, false);
  const statuses: z.infer<typeof SourceStatus>[] = [];
  for (const source of args.source === 'auto' ? ['openalex', 'semantic_scholar'] as const : [args.source]) {
    if (process.env.DISABLED_SOURCES?.split(',').includes(source)) { statuses.push({ name: source, status: 'skipped', reason: 'Disabled by platform.' }); continue; }
    try {
      let items, has_more, next_offset;
      if (source === 'openalex') {
        const id = paper.identifiers.openalex ?? (paper.identifiers.doi ? (await oa.get(paper.identifiers.doi, signal)).identifiers.openalex : null);
        if (!id) throw new ToolError('MISSING_IDENTIFIER', 'No OpenAlex work ID is available.');
        if (args.direction === 'citations') {
          // OpenAlex page numbers use per_page-sized boundaries; fetch one extra page for arbitrary offsets.
          const size = args.limit;
          const page = Math.floor(args.offset / size) + 1;
          const data = await oa.request('works', { filter: `cites:${id}`, per_page: String(size), page: String(page), sort: 'cited_by_count:desc' }, signal);
          let works = data.results ?? [];
          if (args.offset % size) works = [...works, ...(await oa.request('works', { filter: `cites:${id}`, per_page: String(size), page: String(page + 1), sort: 'cited_by_count:desc' }, signal)).results ?? []];
          items = works.slice(args.offset % size, args.offset % size + size).map(oa.normalize);
          has_more = args.offset + items.length < (data.meta?.count ?? 0);
        } else {
          const work = await oa.request(`works/${id}`, {}, signal);
          const refs: string[] = work.referenced_works ?? [];
          const ids = refs.slice(args.offset, args.offset + args.limit).map(r => r.split('/').pop()!);
          const records = await mapLimit(ids, 2, async id => {
            try { return await oa.get(id, signal); }
            catch (e) { warnings.push(`${id}: ${errorMessage(e)}`); return null; }
          });
          items = records.filter((p): p is NonNullable<typeof p> => p !== null);
          has_more = args.offset + args.limit < refs.length;
        }
        next_offset = has_more ? args.offset + args.limit : null;
      } else {
        const id = s2.s2Id(paper);
        if (!id) throw new ToolError('MISSING_IDENTIFIER', 'No identifier supported by Semantic Scholar is available.');
        ({ items, has_more, next_offset } = await s2.links(id, args.direction, args.offset, args.limit, signal));
      }
      statuses.push({ name: source, status: 'ok', retrieved: items.length });
      return { paper, direction: args.direction, items: mergePapers(items), source, offset: args.offset, has_more, next_offset,
        sources: statuses, warnings, retrieved_at: new Date().toISOString() };
    } catch (e) { statuses.push({ name: source, status: 'error', reason: errorMessage(e) }); }
  }
  throw new ToolError('CITATIONS_UNAVAILABLE', statuses.map(s => `${s.name}: ${s.reason}`).join('; '), true);
}
