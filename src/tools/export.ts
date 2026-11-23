import * as z from 'zod/v4';
import { Cite } from '@citation-js/core';
import '@citation-js/plugin-bibtex';
import '@citation-js/plugin-ris';
import { Artifact, saveArtifact } from '../core/artifacts.js';
import { aliases, errorMessage, hash, mergePapers, type PaperRecord } from '../core/paper.js';
import { deadline } from '../net/fetchPublic.js';
import { loadMetadata } from '../reading/reader.js';
import { mapLimit } from './compare.js';

export const ExportInput = z.object({ refs: z.array(z.string().trim().min(1).max(2000)).min(1).max(30),
  format: z.enum(['bibtex', 'ris', 'csl_json', 'gbt7714']) }).strict();
export const ExportData = z.object({ format: ExportInput.shape.format, filename: z.string(), mime: z.string(), text: z.string(),
  artifact: Artifact, exported_ids: z.array(z.string()), skipped: z.array(z.object({ ref: z.string(), reason: z.string() })), warnings: z.array(z.string()) });
export function toCsl(p: PaperRecord): Record<string, unknown> {
  const kind = p.work_type ?? '';
  const type = /proceeding|conference/i.test(kind) ? 'paper-conference' : /journal|article/i.test(kind) && p.venue ? 'article-journal'
    : /preprint|posted-content/i.test(kind) || p.identifiers.arxiv ? 'manuscript'
    : kind === 'book' ? 'book' : /chapter/i.test(kind) ? 'chapter' : /report/i.test(kind) ? 'report' : /dissertation|thesis/i.test(kind) ? 'thesis' : 'article';
  const year = p.published?.split('-').map(Number);
  const stem = (p.authors[0]?.family ?? p.authors[0]?.name ?? 'paper').split(/\s+/)[0].replace(/[^A-Za-z0-9]/g, '') || 'paper';
  return { id: `paper_${hash(p.id)}`, 'citation-key': `${stem}${p.published?.slice(0, 4) ?? ''}_${hash(p.id)}`, type, ...(p.title ? { title: p.title } : {}),
    author: p.authors.map(a => a.family ? { family: a.family, ...(a.given ? { given: a.given } : {}) } : { literal: a.literal ?? a.name }),
    ...(year?.every(Number.isFinite) ? { issued: { 'date-parts': [year] } } : {}),
    ...(p.venue ? { 'container-title': p.venue } : {}), ...(p.identifiers.doi ? { DOI: p.identifiers.doi } : {}),
    URL: p.canonical_url, ...(p.volume ? { volume: p.volume } : {}), ...(p.issue ? { issue: p.issue } : {}),
    ...(p.pages ? { page: p.pages } : {}), ...(p.publisher ? { publisher: p.publisher } : {}),
    ...(p.identifiers.arxiv ? { archive: 'arXiv', archive_location: p.identifiers.arxiv, note: `arXiv:${p.identifiers.arxiv}` } : {}),
  };
}
export function gbt7714(p: PaperRecord, index: number, accessDate = new Date().toISOString().slice(0, 10)): string {
  const authors = p.authors.slice(0, 3).map(a => a.family ? `${a.family.toUpperCase()}${a.given ? ' ' + a.given.split(/[\s-]+/).filter(Boolean).map(s => s[0]?.toUpperCase()).join(' ') : ''}` : a.literal ?? a.name).join(', ')
    + (p.authors.length > 3 ? ', et al' : '');
  const year = p.published?.slice(0, 4);
  let citation = `[${index}] ${authors ? authors + '. ' : ''}${p.title ?? '[title unavailable]'}`;
  if (/journal|^article$/i.test(p.work_type ?? '') && p.venue) {
    citation += `[J]. ${p.venue}${year ? ', ' + year : ''}${p.volume ? ', ' + p.volume : ''}${p.issue ? '(' + p.issue + ')' : ''}${p.pages ? ': ' + p.pages : ''}.`;
  } else if (/proceeding|conference/i.test(p.work_type ?? '') && p.venue) {
    citation += `[C]//${p.venue}. ${p.publisher ? p.publisher + ', ' : ''}${year ?? ''}${p.pages ? ': ' + p.pages : ''}.`;
  } else {
    citation += `[EB/OL]. ${p.identifiers.arxiv ? `arXiv:${p.identifiers.arxiv}. ` : ''}${p.published ? `(${p.published})` : ''}[${accessDate}]. ${p.canonical_url}.`;
  }
  if (p.identifiers.doi) citation += ` DOI:${p.identifiers.doi}.`;
  return citation;
}
export async function exportCitations(args: z.infer<typeof ExportInput>, parent?: AbortSignal) {
  const signal = deadline(60_000, parent), warnings: string[] = [];
  const loaded = await mapLimit(args.refs, 2, async ref => {
    try { const result = await loadMetadata(ref, signal, false); warnings.push(...result.warnings.map(w => `${ref}: ${w}`)); return { ref, paper: result.paper, reason: null }; }
    catch (e) { return { ref, paper: null, reason: errorMessage(e) }; }
  });
  const papers: PaperRecord[] = [], skipped: { ref: string; reason: string }[] = [];
  for (const entry of loaded) {
    if (!entry.paper) { skipped.push({ ref: entry.ref, reason: entry.reason! }); continue; }
    if (papers.some(p => aliases(p).some(a => aliases(entry.paper!).includes(a)))) skipped.push({ ref: entry.ref, reason: 'DUPLICATE: already included in this export.' });
    papers.push(entry.paper);
  }
  const unique = mergePapers(papers), csl = unique.map(toCsl);
  const text = args.format === 'csl_json' ? JSON.stringify(csl, null, 2) + '\n' : args.format === 'gbt7714'
    ? unique.map((p, i) => gbt7714(p, i + 1)).join('\n\n') + (unique.length ? '\n' : '')
    : unique.length ? new Cite(csl).format(args.format === 'bibtex' ? 'bibtex' : 'ris') : '';
  const extension = { bibtex: 'bib', ris: 'ris', csl_json: 'json', gbt7714: 'txt' }[args.format];
  const filename = `citations.${extension}`, artifact = await saveArtifact(filename, text);
  return { format: args.format, filename, mime: { bibtex: 'application/x-bibtex', ris: 'application/x-research-info-systems', csl_json: 'application/vnd.citationstyles.csl+json', gbt7714: 'text/plain; charset=utf-8' }[args.format],
    text, artifact, exported_ids: unique.map(p => p.id), skipped, warnings };
}
