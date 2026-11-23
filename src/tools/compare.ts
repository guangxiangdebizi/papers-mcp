import * as z from 'zod/v4';
import { Evidence, Paper, errorMessage, type PaperRecord, type Passage } from '../core/paper.js';
import { deadline } from '../net/fetchPublic.js';
import { evidence, loadMetadata, readFullText } from '../reading/reader.js';

export const Dimension = z.enum(['method', 'data', 'result', 'limitation']);
export const CompareInput = z.object({ refs: z.array(z.string().trim().min(1).max(2000)).min(2).max(5),
  dimensions: z.array(Dimension).min(1).max(4).default(['method', 'data', 'result', 'limitation']),
  focus: z.string().trim().max(200).optional(),
}).strict();
const Cell = z.object({ dimension: Dimension, excerpt: z.string().nullable(), evidence_ids: z.array(z.string()), reason: z.string().nullable() });
export const CompareRow = z.object({ ref: z.string(), paper: Paper.nullable(), read_level: z.enum(['metadata', 'abstract', 'full_text', 'unavailable']), cells: z.array(Cell), error: z.string().nullable() });
export const CompareData = z.object({ columns: z.array(Dimension), rows: z.array(CompareRow), evidence: z.array(Evidence), markdown: z.string(), warnings: z.array(z.string()) });
export async function mapLimit<T, R>(values: T[], limit: number, fn: (value: T, index: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(values.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, async () => {
    while (next < values.length) { const index = next++; results[index] = await fn(values[index], index); }
  }));
  return results;
}
const sections: Record<z.infer<typeof Dimension>, RegExp> = {
  method: /method|approach|architecture|attention|model|方法/i,
  data: /data|corpus|corpora|experimental setup|training|数据/i,
  result: /result|evaluation|experiment|performance|结果|实验/i,
  limitation: /limitation|局限|不足/i,
};
const escapeCell = (s: string) => s.replaceAll('|', '\\|').replace(/[\r\n]+/g, ' ');
export async function comparePapers(args: z.infer<typeof CompareInput>, parent?: AbortSignal) {
  const signal = deadline(45_000, parent), allEvidence: Passage[] = [], warnings: string[] = [];
  const dimensions = [...new Set(args.dimensions)];
  const rows = await mapLimit(args.refs, 2, async ref => {
    let paper: PaperRecord | null = null;
    const empty = (reason: string) => dimensions.map(dimension => ({ dimension, excerpt: null, evidence_ids: [] as string[], reason }));
    try {
      const metadata = await loadMetadata(ref, deadline(12_000, signal), false);
      paper = metadata.paper; warnings.push(...metadata.warnings.map(w => `${ref}: ${w}`));
      const reading = await readFullText(paper, deadline(18_000, signal));
      warnings.push(...reading.warnings.map(w => `${ref}: ${w}`));
      if (!reading.document || !reading.version_url) return { ref, paper, read_level: paper.abstract ? 'abstract' as const : 'metadata' as const,
        cells: empty('Full-text section unavailable; no fact inferred from metadata or abstract.'), error: null };
      const cells = dimensions.map(dimension => {
        const candidates = reading.document!.segments.filter(s => sections[dimension].test(s.section));
        const terms = args.focus?.toLowerCase().split(/\W+/).filter(t => t.length > 2) ?? [];
        candidates.sort((a, b) => terms.filter(t => b.text.toLowerCase().includes(t)).length - terms.filter(t => a.text.toLowerCase().includes(t)).length);
        const segment = candidates[0];
        if (!segment) return { dimension, excerpt: null, evidence_ids: [], reason: 'No matching section heading was found.' };
        const passage = evidence(paper!, { ...segment, text: segment.text.slice(0, 1000) }, reading.version_url!);
        allEvidence.push(passage);
        return { dimension, excerpt: passage.quote, evidence_ids: [passage.id], reason: null };
      });
      return { ref, paper, read_level: 'full_text' as const, cells, error: null };
    } catch (e) { return { ref, paper, read_level: paper ? 'metadata' as const : 'unavailable' as const, cells: empty(errorMessage(e)), error: errorMessage(e) }; }
  });
  const markdown = [`| Paper | ${dimensions.join(' | ')} |`, `| --- | ${dimensions.map(() => '---').join(' | ')} |`,
    ...rows.map(row => `| ${escapeCell(row.paper?.title ?? row.ref)} | ${row.cells.map(c => c.excerpt ? `${escapeCell(c.excerpt)} [${c.evidence_ids.join(', ')}]` : `未找到 / Not found: ${escapeCell(c.reason ?? '')}`).join(' | ')} |`)].join('\n');
  return { columns: dimensions, rows, evidence: [...new Map(allEvidence.map(e => [e.id, e])).values()], markdown, warnings };
}
