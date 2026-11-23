import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { initSync, parse } from '@retorquere/bibtex-parser';
import { stdioClient, httpClient, call } from './helpers.mjs';

const nature = '10.1038/nature14539', transformer = '1706.03762v7';
const pdfUrl = 'https://papers.neurips.cc/paper_files/paper/2017/file/3f5ee243547dee91fbd053c1c4a845aa-Paper.pdf';
function readRis(text) {
  return text.split(/^ER\s+-\s*$/m).filter(s => /^TY\s+-/m.test(s)).map(record => {
    const fields = {};
    for (const line of record.split(/\r?\n/)) {
      const match = /^([A-Z0-9]{2})\s+-\s?(.*)$/.exec(line);
      if (match) (fields[match[1]] ??= []).push(match[2]);
    }
    return fields;
  });
}
export async function runLive(record = false) {
  const examples = { retrieved_at: new Date().toISOString() };
  const client = await stdioClient();
  try {
    const listed = (await client.listTools()).tools;
    assert.deepEqual(listed.map(t => t.name).sort(), ['search_papers', 'get_paper', 'get_citations', 'compare_papers', 'export_citations'].sort());
    assert.ok(listed.every(t => t.outputSchema));
    const metadata = await call(client, 'get_paper', { ref: nature, mode: 'metadata' });
    assert.equal(metadata.data.paper.title, 'Deep learning');
    assert.deepEqual(metadata.data.paper.authors.map(a => a.family), ['LeCun', 'Bengio', 'Hinton']);
    assert.equal(metadata.data.read_level, 'metadata'); assert.equal(metadata.data.full_text, null);
    examples.nature = metadata;

    const searched = await call(client, 'search_papers', { query: 'diffusion language models', limit: 5 });
    assert.ok(searched.data.items.length); assert.equal(searched.data.sources.length, 3);
    examples.diffusion_search = searched;
    console.log(`LIVE search: ${searched.data.items.length} papers; ${searched.data.sources.map(s => s.name + '=' + s.status).join(', ')}`);
    const exact = await call(client, 'search_papers', { query: 'deep learning', sources: ['crossref'], filters: { venue: '0028-0836', from: '2015-01-01', to: '2015-12-31' }, limit: 5 });
    assert.ok(exact.data.items.length); assert.ok(exact.data.items.every(p => p.issns.includes('0028-0836') && p.published.startsWith('2015')));
    const repeat = await call(client, 'search_papers', exact.data.query_recipe);
    assert.equal(repeat.data.cache_hit, true);
    const bad = await call(client, 'search_papers', { query: 'transformer', sources: ['arxiv'], filters: { venue: 'Nature' }, sort: 'citations_desc' }, true);
    assert.equal(bad.error.code, 'UNSUPPORTED_FILTER');
    examples.nature_filter = exact;

    const reading = await call(client, 'get_paper', { ref: transformer, mode: 'evidence', focus: 'model architecture', max_passages: 2 });
    assert.equal(reading.data.read_level, 'full_text'); assert.ok(reading.data.passages.length);
    assert.ok(reading.data.passages.every(e => e.basis === 'full_text' && (e.locator.page || e.locator.section)));
    assert.match(reading.data.passages.map(e => e.quote).join(' '), /encoder|decoder|attention/i);
    examples.transformer_method = reading;
    const arxivPdf = await call(client, 'get_paper', { ref: 'https://arxiv.org/pdf/1706.03762.pdf', mode: 'full_text', page: 4, page_size: 1 });
    assert.ok(arxivPdf.data.full_text?.pages.length, JSON.stringify(arxivPdf.data.warnings));
    assert.equal(arxivPdf.data.full_text.pages[0].page, 4);
    assert.ok(arxivPdf.data.passages.some(e => e.locator.page === 4 && /attention/i.test(e.quote)));
    examples.arxiv_pdf_page = arxivPdf;
    const pdf = await call(client, 'get_paper', { ref: pdfUrl, mode: 'full_text', page: 3, page_size: 1, focus: 'attention' });
    assert.ok(pdf.data.full_text, JSON.stringify(pdf.data.warnings));
    assert.equal(pdf.data.full_text.pages[0].page, 3); assert.ok(pdf.data.full_text.total_pages >= 10);
    assert.match(pdf.data.full_text.pages[0].text, /decoder|attention/i);
    assert.ok(pdf.data.passages.every(e => e.locator.page === 3));
    // Fetch the same official PDF independently; pdfjs extraction must match the located page.
    const pdfBytes = new Uint8Array(await (await fetch(pdfUrl, { signal: AbortSignal.timeout(20000) })).arrayBuffer());
    const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const document = await getDocument({ data: pdfBytes, isEvalSupported: false, verbosity: 0 }).promise;
    const pageText = (await (await document.getPage(3)).getTextContent()).items.filter(i => 'str' in i).map(i => i.str).join(' ').replace(/\s+/g, ' ');
    for (const e of pdf.data.passages) assert.ok(pageText.includes(e.quote.replace(/\s+/g, ' ')));
    await document.destroy();
    examples.pdf_page = pdf;

    const refs = await call(client, 'get_citations', { ref: nature, direction: 'references', source: 'openalex', limit: 3 });
    assert.equal(refs.data.items.length, 3); assert.equal(refs.data.source, 'openalex');
    examples.references = refs;
    const comparison = await call(client, 'compare_papers', { refs: [transformer, '1810.04805', nature], dimensions: ['method', 'data', 'result', 'limitation'] });
    assert.equal(comparison.data.rows.length, 3);
    assert.ok(comparison.data.rows[0].cells.some(c => c.excerpt));
    assert.equal(comparison.data.rows[1].read_level, 'full_text', JSON.stringify(comparison.data.rows[1]));
    assert.ok(comparison.data.rows[2].paper);
    for (const row of comparison.data.rows) for (const cell of row.cells) if (cell.excerpt) assert.ok(cell.evidence_ids.every(id => comparison.data.evidence.some(e => e.id === id)));
    examples.comparison = comparison;

    const outputs = {};
    for (const format of ['bibtex', 'ris', 'csl_json', 'gbt7714']) {
      const result = await call(client, 'export_citations', { refs: [nature, transformer, nature, 'not-an-id'], format });
      assert.equal(result.data.exported_ids.length, 2); assert.equal(result.data.skipped.length, 2);
      const bytes = await readFile(result.data.artifact.path);
      assert.equal(bytes.toString('utf8'), result.data.text); assert.equal(bytes.length, result.data.artifact.bytes);
      assert.equal(createHash('sha256').update(bytes).digest('hex'), result.data.artifact.sha256);
      outputs[format] = result;
    }
    initSync({ module: await readFile(new URL('./bibtex_parser_bg.wasm', import.meta.resolve('@retorquere/bibtex-parser'))) });
    const bib = parse(outputs.bibtex.data.text);
    assert.equal(bib.errors.length, 0, JSON.stringify(bib.errors)); assert.equal(bib.entries.length, 2);
    assert.ok(bib.entries.every(e => /_[a-f0-9]{10}$/.test(e.key)));
    const journal = bib.entries.find(e => e.fields.doi === nature);
    assert.ok(journal); assert.equal(journal.fields.author.length, 3);
    assert.match(JSON.stringify(journal.fields.author), /LeCun.*Bengio.*Hinton/);
    assert.match(JSON.stringify(bib.entries), /arxiv.org\/abs\/1706.03762/);
    const ris = readRis(outputs.ris.data.text); assert.equal(ris.length, 2);
    assert.equal(ris[0].DO[0], nature); assert.equal(ris[0].AU.length, 3); assert.match(ris[0].AU.join(' '), /LeCun.*Bengio.*Hinton/);
    assert.match(ris[1].UR[0], /arxiv.org\/abs\/1706.03762/);
    assert.notEqual(ris[1].TY[0], 'JOUR', 'Preprints must not be labeled as journal articles.');
    assert.equal(JSON.parse(outputs.csl_json.data.text).length, 2);
    assert.match(outputs.gbt7714.data.text, /\[J\].*Nature/); assert.match(outputs.gbt7714.data.text, /\[EB\/OL\]/);
    examples.exports = outputs;
    console.log('LIVE stdio: bibliography, filters/cache, full text, PDF page, references, comparison and 4 export formats passed.');
  } finally { await client.close(); }
  const http = await httpClient({ PUBLIC_BASE_URL: 'https://papers.example.test' });
  try {
    assert.equal((await http.client.listTools()).tools.length, 5);
    const meta = await call(http.client, 'get_paper', { ref: nature, mode: 'metadata' });
    assert.equal(meta.data.paper.title, examples.nature.data.paper.title);
    const exported = await call(http.client, 'export_citations', { refs: [nature], format: 'gbt7714' });
    const artifact = exported.data.artifact;
    assert.ok(artifact.downloadUrl.startsWith('https://papers.example.test/files/'));
    const id = artifact.path.replaceAll('\\', '/').split('/').slice(-2).join('/');
    const response = await fetch(new URL(`/files/${id}`, http.url)); assert.equal(response.status, 200);
    const bytes = Buffer.from(await response.arrayBuffer()); assert.equal(bytes.toString('utf8'), exported.data.text);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), artifact.sha256);
    assert.equal((await fetch(http.url)).status, 405);
    assert.equal((await fetch(http.url, { headers: { origin: 'https://untrusted.example.test' } })).status, 403);
    assert.equal((await fetch(new URL('/files/00000000-0000-0000-0000-000000000000/citations.txt', http.url))).status, 404);
    console.log('LIVE HTTP: initialize, listTools, get_paper, export_citations and file download/hash passed.');
  } finally { await http.close(); }
  if (record) {
    await mkdir('docs', { recursive: true });
    const clean = JSON.parse(JSON.stringify(examples));
    for (const data of Object.values(clean.exports)) data.data.artifact.path = `output/<random-id>/${data.data.filename}`;
    await writeFile('docs/live-examples.json', JSON.stringify(clean, null, 2) + '\n', 'utf8');
    for (const data of Object.values(examples.exports)) await writeFile(`docs/${data.data.filename}`, data.data.text, 'utf8');
  }
  return examples;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await runLive(process.env.RECORD_EXAMPLES === '1');
