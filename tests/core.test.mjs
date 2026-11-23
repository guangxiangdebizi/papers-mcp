import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { blankPaper, arxiv, doi, mergePapers, namedAuthor, sourced } from '../build/core/paper.js';
import { LruCache, deadline, fetchPublic, readLimited, validatePublicUrl } from '../build/net/fetchPublic.js';
import { SearchInput, searchPapers } from '../build/tools/search.js';
import { parseDocument } from '../build/reading/reader.js';
import { toCsl, gbt7714 } from '../build/tools/export.js';
import { saveArtifact } from '../build/core/artifacts.js';
import * as s2 from '../build/providers/semanticScholar.js';

test('exact identity merge, transitive aliases, versions and field provenance; titles never merge', () => {
  assert.equal(doi('https://doi.org/10.1038/NATURE14539'), '10.1038/nature14539');
  assert.equal(doi('https://doi.org/10.1038%2FNATURE14539?ref=example'), '10.1038/nature14539');
  assert.deepEqual(arxiv('https://arxiv.org/pdf/1706.03762v7.pdf?download=1'), { base: '1706.03762', version: 'v7' });
  assert.deepEqual(arxiv('https://arxiv.org/pdf/hep-th/9901001v2.pdf'), { base: 'hep-th/9901001', version: 'v2' });
  const first = blankPaper('doi:10.1234/a', 'https://doi.org/10.1234/a'); first.identifiers.doi = '10.1234/a'; first.title = 'Same';
  const second = blankPaper('openalex:W1', 'https://openalex.org/W1'); second.identifiers.openalex = 'W1'; second.title = 'Same';
  const bridge = blankPaper('other', 'https://example.org'); bridge.identifiers = { ...bridge.identifiers, doi: '10.1234/a', openalex: 'W1' }; bridge.abstract = 'Original abstract';
  const distinct = blankPaper('doi:10.1234/b', 'https://doi.org/10.1234/b'); distinct.identifiers.doi = '10.1234/b'; distinct.title = 'Same';
  const result = mergePapers([sourced(first, 'crossref', first.canonical_url), sourced(second, 'openalex', second.canonical_url), sourced(bridge, 'arxiv', bridge.canonical_url), distinct]);
  assert.equal(result.length, 2);
  const merged = result.find(p => p.identifiers.doi === '10.1234/a');
  assert.equal(merged.abstract, 'Original abstract'); assert.equal(merged.provenance.length, 3);
  assert.deepEqual(merged.field_sources.abstract, ['arxiv']);
});

test('bounded cache, HTTPS/private URL controls, streaming size and body timeout', async () => {
  const cache = new LruCache(2); cache.set('a', 1, 9999); cache.set('b', 2, 9999); cache.get('a'); cache.set('c', 3, 9999);
  assert.equal(cache.get('b'), undefined); cache.set('d', 4, -1); assert.equal(cache.get('d'), undefined);
  for (const url of ['http://api.crossref.org', 'https://user:pass@arxiv.org', 'https://127.0.0.1', 'https://169.254.169.254', 'https://[::1]', 'https://[::ffff:127.0.0.1]', 'https://10.0.0.2', 'https://api.crossref.org:8080'])
    await assert.rejects(validatePublicUrl(url), e => ['UNSAFE_URL', 'INVALID_URL'].includes(e.code));
  const tooLarge = new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array(12)); c.close(); } }));
  await assert.rejects(readLimited(tooLarge, 10, deadline(1000)), { code: 'RESPONSE_TOO_LARGE' });
  const hanging = new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array(1)); } }));
  const keepAlive = setTimeout(() => {}, 1000);
  await assert.rejects(readLimited(hanging, 10, deadline(30)));
  clearTimeout(keepAlive);
});

test('provider failure preserves other results, strict filters/cache, retry-after and redirect controls', async () => {
  const original = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async url => {
    requests++;
    if (String(url).includes('api.openalex.org')) return new Response('', { status: 429, headers: { 'retry-after': '0.01' } });
    if (String(url).includes('redirect')) return new Response('', { status: 302, headers: { location: 'https://127.0.0.1/private' } });
    return Response.json({ message: { 'total-results': 1, items: [{ DOI: '10.1234/test', title: ['Real fixture'], 'container-title': ['Nature'], ISSN: ['0028-0836'], type: 'journal-article', published: { 'date-parts': [[2015, 5, 27]] } }] } });
  };
  try {
    const args = SearchInput.parse({ query: 'network-fixture', sources: ['openalex', 'crossref'], filters: { from: '2015-01-01', to: '2015-12-31' } });
    const result = await searchPapers(args);
    assert.equal(result.items.length, 1); assert.equal(result.sources.find(s => s.name === 'openalex').status, 'error');
    const only = SearchInput.parse({ query: 'cache-fixture', sources: ['crossref'], filters: { venue: '0028-0836', from: '2015-01-01', to: '2015-12-31' } });
    const first = await searchPapers(only), count = requests, second = await searchPapers(only);
    assert.equal(first.items[0].venue, 'Nature'); assert.equal(second.cache_hit, true); assert.equal(requests, count);
    const mismatch = await searchPapers(SearchInput.parse({ query: 'mismatch-fixture', sources: ['crossref'], filters: { venue: 'Science' } }));
    assert.equal(mismatch.items.length, 0);
    await assert.rejects(searchPapers(SearchInput.parse({ query: 'x', sources: ['arxiv'], filters: { venue: 'Nature' } })), { code: 'UNSUPPORTED_FILTER' });
    await assert.rejects(searchPapers(SearchInput.parse({ query: 'x', sources: ['openalex'], sort: 'citations_desc' })), { code: 'ALL_SOURCES_FAILED' });
    await assert.rejects(fetchPublic('https://api.crossref.org/redirect', { source: 'test', signal: deadline(1000) }), { code: 'UNSAFE_URL' });
    assert.throws(() => SearchInput.parse({ query: ' ' }));
    await assert.rejects(searchPapers(SearchInput.parse({ query: 'x', filters: { from: '2025-01-01', to: '2024-01-01' } })), { code: 'INVALID_FILTER' });
  } finally { globalThis.fetch = original; }
});

function samplePdf() {
  const stream = 'BT /F1 12 Tf 50 750 Td (3 Model Architecture) Tj 0 -24 Td (The model uses attention to compute representations.) Tj 0 -24 Td (4 Results) Tj 0 -24 Td (The evaluation reports a measured score on the test data.) Tj ET';
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>', `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  let content = '%PDF-1.4\n'; const offsets = [0];
  objects.forEach((object, i) => { offsets.push(content.length); content += `${i + 1} 0 obj\n${object}\nendobj\n`; });
  const start = content.length;
  content += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(n => `${String(n).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${start}\n%%EOF`;
  return new TextEncoder().encode(content);
}
test('real pdfjs worker extracts pages and headings; HTML never falls back to site body', async () => {
  const doc = await parseDocument('pdf', samplePdf(), deadline(10000));
  assert.equal(doc.page_count, 1); assert.ok(doc.pages[0].text.includes('attention'));
  assert.equal(doc.segments[0].page, 1); assert.match(doc.segments[0].section, /Model Architecture/);
  const html = await parseDocument('html', '<html><nav>noise</nav><main>unrelated body text</main></html>', deadline(10000));
  assert.equal(html.segments.length, 0);
  const article = await parseDocument('html', '<meta name="citation_title" content="Study"><article><h2>Methods</h2><p>This original method paragraph contains exact reproducible source evidence.</p></article>', deadline(10000));
  assert.equal(article.segments[0].section, 'Methods');
});

test('CSL precision/corporate authors, GB/T rendering and actual artifact bytes/hash', async () => {
  const p = blankPaper('arxiv:1706.03762', 'https://arxiv.org/abs/1706.03762');
  p.title = 'A & B'; p.identifiers.arxiv = '1706.03762'; p.published = '2017'; p.authors = [namedAuthor('Research Consortium')];
  const csl = toCsl(p); assert.deepEqual(csl.issued, { 'date-parts': [[2017]] });
  assert.deepEqual(csl.author, [{ literal: 'Research Consortium' }]); assert.equal(csl.DOI, undefined);
  const text = gbt7714(p, 1); assert.match(text, /\[EB\/OL\]/); assert.match(text, /arXiv:1706.03762/);
  const conference = { ...p, work_type: 'proceedings-article', venue: 'Conference Proceedings' };
  assert.match(gbt7714(conference, 1), /\[C\]\/\/Conference Proceedings/);
  assert.equal(toCsl(conference).type, 'paper-conference');
  const result = await saveArtifact('citations.txt', text), bytes = await readFile(result.path);
  assert.equal(result.bytes, bytes.length); assert.equal(result.sha256, createHash('sha256').update(bytes).digest('hex'));
  assert.equal(result.downloadUrl, undefined);
});

test('Semantic Scholar public/key enrichment and citation/reference direction mapping', async () => {
  const original = globalThis.fetch, oldKey = process.env.S2_API_KEY;
  const record = { paperId: 'fixture-s2', externalIds: { DOI: '10.1234/s2-fixture', ArXiv: '1706.03762' }, title: 'S2 fixture',
    authors: [{ name: 'A Researcher', authorId: '1' }], citationCount: 7, tldr: { text: 'Upstream TLDR' }, year: 2020 };
  const seen = [];
  globalThis.fetch = async (url, options) => {
    seen.push({ url: String(url), key: options.headers['x-api-key'] });
    if (String(url).includes('/citations?')) return Response.json({ data: [{ citingPaper: record }], next: 1 });
    if (String(url).includes('/references?')) return Response.json({ data: [{ citedPaper: record }] });
    return Response.json(record);
  };
  try {
    delete process.env.S2_API_KEY;
    const p = await s2.get('DOI:10.1234/s2-fixture', deadline(3000));
    assert.equal(p.cited_by_count, 7); assert.equal(p.tldr, 'Upstream TLDR'); assert.equal(p.identifiers.arxiv, '1706.03762');
    assert.equal(seen[0].key, undefined);
    process.env.S2_API_KEY = 'fixture-key';
    const citations = await s2.links('fixture-s2', 'citations', 0, 1, deadline(3000));
    const references = await s2.links('fixture-s2', 'references', 0, 1, deadline(3000));
    assert.equal(citations.has_more, true); assert.equal(references.has_more, false);
    assert.equal(citations.items[0].id, 's2:fixture-s2'); assert.equal(seen[1].key, 'fixture-key');
  } finally { globalThis.fetch = original; if (oldKey === undefined) delete process.env.S2_API_KEY; else process.env.S2_API_KEY = oldKey; }
});
