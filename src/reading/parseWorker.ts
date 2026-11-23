import * as cheerio from 'cheerio';
import type { ParsedDocument, Segment } from './reader.js';

export function sectionHeading(line: string): boolean {
  const text = line.replace(/\s+/g, ' ').trim();
  if (text.length > 110) return false;
  if (/^\d+(?:\.\d+)*\.?\s+[A-Z][^.!?;]{1,95}$/.test(text)) return true;
  return /^(?:abstract|introduction|background|related work|model architecture|the transformer|attention|multi.head attention|scaled dot.product attention|methods?|methodology|approach|materials(?: and methods)?|datasets?|data(?: collection)?|experimental? (?:setup|results)|experiments?|results(?: and discussion)?|training|evaluation|discussion|limitations?(?: and future work)?|conclusions?(?: and future work)?|references|acknowledg\w*|方法|数据|实验|结果|局限|结论):?$/i.test(text);
}
export function parseHtml(html: string): ParsedDocument {
  const $ = cheerio.load(html);
  $('script,style,nav,footer,header,aside,form,.ltx_bibliography,annotation,annotation-xml').remove();
  const article = $('article').first().length ? $('article').first() : $('.ltx_document, #article-body, .article-body, [itemprop="articleBody"]').first();
  const segments: Segment[] = [];
  let section = 'Article';
  if (article.length) article.find('h1,h2,h3,h4,h5,p').each((_, element) => {
    const text = $(element).text().replace(/\s+/g, ' ').trim();
    if (/^h[1-5]$/.test(element.tagName)) section = text;
    else if (text.length > 40 && segments.length < 3000) segments.push({ text: text.slice(0, 20_000), section, paragraph: segments.length + 1 });
  });
  const meta = (name: string) => $(`meta[name="${name}"],meta[property="${name}"]`).first().attr('content') ?? null;
  const authors = $('meta[name="citation_author"]').map((_, el) => $(el).attr('content') ?? '').get();
  if (!authors.length) $('.ltx_authors .ltx_personname').each((_, el) => { const name = $(el).text().replace(/\s+/g, ' ').trim(); if (name) authors.push(name); });
  const pdf = meta('citation_pdf_url');
  return { segments, page_count: null, pages: [], metadata: {
    title: meta('citation_title') ?? meta('dc.title') ?? (article.length ? article.find('h1').first().text().trim() || null : null),
    authors, doi: meta('citation_doi'), published: meta('citation_publication_date')?.replaceAll('/', '-') ?? meta('dc.date'),
    abstract: meta('description') && $('meta[name="citation_title"]').length ? meta('description') :
      $('.abstract, .ltx_abstract, blockquote.abstract').first().text().replace(/^Abstract:\s*/i, '').replace(/\s+/g, ' ').trim() || null,
    pdf, venue: meta('citation_journal_title'),
  } };
}
export async function parsePdf(bytes: Uint8Array, pageRange?: { start: number; count: number }): Promise<ParsedDocument> {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const pdf = await getDocument({ data: new Uint8Array(bytes), useSystemFonts: true, isEvalSupported: false, verbosity: 0 }).promise;
  const segments: Segment[] = [], pages: { page: number; text: string }[] = [];
  let section = 'Document';
  try {
    for (let number = pageRange?.start ?? 1; number <= Math.min(pdf.numPages, 300, pageRange ? pageRange.start + pageRange.count - 1 : 300); number++) {
      const page = await pdf.getPage(number);
      const content = await page.getTextContent();
      const lines: string[] = [];
      let line = '', y: number | undefined;
      for (const item of content.items) if ('str' in item) {
        const nextY = item.transform[5] as number;
        if (y !== undefined && Math.abs(nextY - y) > 3 && line) { lines.push(line.trim()); line = ''; }
        line += `${line && !line.endsWith(' ') ? ' ' : ''}${item.str}`;
        y = nextY;
        if (item.hasEOL) { if (line.trim()) lines.push(line.trim()); line = ''; y = undefined; }
      }
      if (line.trim()) lines.push(line.trim());
      const normalized = lines.map(line => line.replace(/\s+/g, ' ').trim()).filter(line => !/^\d+$/.test(line));
      pages.push({ page: number, text: normalized.join('\n').slice(0, 30_000) });
      let paragraph = '';
      const flush = () => {
        if (paragraph.trim().length > 30) segments.push({ text: paragraph.trim(), page: number, section, paragraph: segments.length + 1 });
        paragraph = '';
      };
      for (const value of normalized) {
        if (sectionHeading(value)) { flush(); section = value; }
        else {
          paragraph += `${paragraph ? ' ' : ''}${value}`;
          if (paragraph.length > 700 && /[.!?]$/.test(value)) flush();
          else if (paragraph.length > 2400) flush();
        }
      }
      flush();
      page.cleanup();
    }
    return { segments, pages, page_count: pdf.numPages, metadata: null };
  } finally { await pdf.destroy(); }
}
if (process.send) process.once('message', async (workerData: { kind: string; bytes: Uint8Array; html: string; pageRange?: { start: number; count: number } }) => {
  try {
    const result = workerData.kind === 'pdf' ? await parsePdf(workerData.bytes, workerData.pageRange) : parseHtml(workerData.html);
    process.send!({ result });
  } catch (error) { process.send!({ error: error instanceof Error ? error.message : String(error) }); }
});
