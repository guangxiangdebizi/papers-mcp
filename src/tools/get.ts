import * as z from 'zod/v4';
import { Evidence, Paper, blankPaper, hash } from '../core/paper.js';
import { deadline } from '../net/fetchPublic.js';
import { loadMetadata, pickPassages, readFullText } from '../reading/reader.js';

export const GetInput = z.object({ ref: z.string().trim().min(1).max(2000),
  mode: z.enum(['metadata', 'abstract', 'evidence', 'full_text']).default('abstract'),
  focus: z.string().trim().max(200).optional(), max_passages: z.number().int().min(1).max(6).default(3),
  page: z.number().int().min(1).default(1), page_size: z.number().int().min(1).max(5).default(3),
}).strict();
export const GetData = z.object({ paper: Paper, read_level: z.enum(['metadata', 'abstract', 'full_text']),
  abstract: z.string().nullable(), passages: z.array(Evidence), missing: z.array(z.string()), warnings: z.array(z.string()),
  full_text: z.object({ version_url: z.string(), page: z.number(), page_size: z.number(), total_pages: z.number().nullable(),
    pages: z.array(z.object({ page: z.number(), text: z.string() })), has_more: z.boolean() }).nullable(),
});
export async function getPaper(args: z.infer<typeof GetInput>, parent?: AbortSignal) {
  const signal = deadline(30_000, parent);
  let metadata;
  if (/^https:\/\/.*(?:\.pdf(?:\?.*)?)$/i.test(args.ref) && !args.ref.includes('arxiv.org/') && ['full_text', 'evidence'].includes(args.mode))
    metadata = { paper: { ...blankPaper(`url:${hash(args.ref)}`, args.ref), pdf_url: args.ref, oa_url: args.ref }, warnings: ['No verified bibliography is available for a bare PDF URL.'] };
  else metadata = await loadMetadata(args.ref, signal, args.mode !== 'metadata');
  const { paper, warnings } = metadata;
  const missing: string[] = [];
  if (!paper.title) missing.push('title');
  if (!paper.authors.length) missing.push('authors');
  if (!paper.abstract) missing.push('abstract');
  let doc = null, url = null;
  if (['evidence', 'full_text'].includes(args.mode)) {
    const reading = await readFullText(paper, signal, args.mode === 'full_text', args.mode === 'full_text' ? { start: args.page, count: args.page_size } : undefined);
    doc = reading.document; url = reading.version_url; warnings.push(...reading.warnings);
    if (!doc) missing.push('full_text');
  }
  const passageDoc = doc?.pages.length && args.mode === 'full_text' ? { ...doc,
    segments: doc.segments.filter(s => s.page && s.page >= args.page && s.page < args.page + args.page_size) } : doc;
  const passages = args.mode === 'metadata' ? [] : pickPassages(paper, passageDoc, url, args.focus, args.max_passages);
  if (args.focus && !passages.length) missing.push('matching_passages');
  const full_text = doc && url ? { version_url: url, page: args.page, page_size: args.page_size, total_pages: doc.page_count,
    pages: doc.pages.filter(p => p.page >= args.page && p.page < args.page + args.page_size),
    has_more: doc.page_count !== null && doc.page_count >= args.page + args.page_size } : null;
  if (doc && args.mode === 'full_text' && !doc.pages.length) missing.push('pdf_page_numbers');
  if (doc?.page_count !== null && doc?.page_count !== undefined && args.page > doc.page_count) missing.push('page_out_of_range');
  if (doc && doc.page_count !== null && doc.page_count > 300) missing.push('pages_beyond_parser_limit_300');
  return { paper, read_level: doc ? 'full_text' as const : paper.abstract && args.mode !== 'metadata' ? 'abstract' as const : 'metadata' as const,
    abstract: args.mode === 'metadata' ? null : paper.abstract, passages, missing, warnings, full_text };
}
