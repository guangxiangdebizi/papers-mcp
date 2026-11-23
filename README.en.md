# Papers MCP: discover, read and cite research
Search OpenAlex, Crossref and arXiv; enrich records with Semantic Scholar citation counts and TLDR.
Read open PDFs by page, locate original evidence, compare up to five papers and export BibTeX, RIS, CSL-JSON or GB/T 7714.

[中文](README.md) · [Agent workflow and Chinese examples](SKILL.md) · [Real MCP outputs](docs/live-examples.json)

## Real examples

Search the topic “diffusion language models”:
```json
{"query":"diffusion language models","limit":5}
```

The [recorded result](docs/live-examples.json) includes titles, identifiers, source coverage, provenance, a reusable query recipe and truncation status. Reciprocal-rank fusion deduplicates exact identifiers; no cross-index total is invented.

Real hits include *Improving Variable-Length Generation in Diffusion Language Models via Length Regularization* (arXiv:2602.07546, 2026-02-07), *Hierarchical Continuous Diffusion Language Models* (arXiv:2610.02193, 2026-10-01), and *Diffusion-based Large Language Models Survey* (DOI:10.36227/techrxiv.175502932.20939890/v1, 2025-08-12). This snapshot used arXiv and Crossref because the public OpenAlex daily budget was exhausted; source statuses preserve that coverage change.

Read the method of *Attention Is All You Need*:
```json
{"ref":"1706.03762v7","mode":"evidence","focus":"model architecture","max_passages":2}
```
The original excerpt “The Transformer follows this overall architecture using stacked self-attention and point-wise, fully connected layers for both the encoder and decoder” is located in [v7, Section 3](https://arxiv.org/html/1706.03762v7#S3). HTML evidence has section/paragraph locators; PDF evidence has actual page numbers. The recording also contains page 3 of the official NeurIPS PDF.

Export GB/T 7714-2015 references:
```json
{"refs":["10.1038/nature14539"],"format":"gbt7714"}
```
```text
[1] LECUN Y, BENGIO Y, HINTON G. Deep learning[J]. Nature, 2015, 521(7553): 436-444. DOI:10.1038/nature14539.
```
Real mixed bibliography files: [BibTeX](docs/citations.bib), [RIS](docs/citations.ris), [CSL-JSON](docs/citations.json), [GB/T text](docs/citations.txt).

## Install

Requires **Node >=20.19** (Node 22 LTS recommended).
```sh
git clone https://github.com/guangxiangdebizi/papers-mcp.git
cd papers-mcp
npm ci
npm run build
npm start
```

The official stable v2 SDK uses split packages: `@modelcontextprotocol/server@2.4.0`, `@modelcontextprotocol/node@2.1.2` and the test client `@modelcontextprotocol/client@2.4.0`, verified against npm and the [official installation guide](https://github.com/modelcontextprotocol/typescript-sdk#installation). PDF extraction uses pinned `pdfjs-dist@4.10.38`, replacing pdf-parse.

### stdio

Replace cwd with the absolute clone path. Use `/` or escaped backslashes on Windows.
```json
{"mcpServers":{"papers":{"command":"node","args":["build/index.js"],"cwd":"/path/to/papers-mcp","env":{"MCP_TRANSPORT":"stdio","OUTPUT_DIR":"./output"}}}}
```
For clients without cwd support, use an absolute script path and OUTPUT_DIR. stdout carries only MCP messages; diagnostics go to stderr.

### Stateless Streamable HTTP

PowerShell:
```powershell
$env:MCP_TRANSPORT = "http"
$env:PORT = "3100"
$env:OUTPUT_DIR = "./output"
$env:PUBLIC_BASE_URL = "http://127.0.0.1:3100"
npm start
```
Linux/macOS:
```sh
MCP_TRANSPORT=http PORT=3100 OUTPUT_DIR=./output PUBLIC_BASE_URL=http://127.0.0.1:3100 npm start
```
Client configuration:
```json
{"mcpServers":{"papers":{"url":"http://127.0.0.1:3100/mcp"}}}
```
POST `/mcp` is stateless, without user sessions or an SSE gateway. GET `/health` checks service health; GET `/files/<random-UUID>/<filename>` downloads exports. GET/DELETE `/mcp` return 405.

## Tools

| Tool | Main inputs | Output |
| --- | --- | --- |
| `search_papers` | query, filters, sources, sort, limit 1-20 | Bounded candidates, verified filters, coverage, query_recipe |
| `get_paper` | ref, mode metadata/abstract/evidence/full_text, focus, max_passages 1-6, page, page_size 1-5 | Bibliography, actual read level, original evidence and locators |
| `get_citations` | ref, direction references/citations, source auto/openalex/semantic_scholar, offset, limit 1-50 | References or citing papers and next_offset |
| `compare_papers` | 2-5 refs, dimensions method/data/result/limitation, optional focus | Original section extracts, evidence IDs and Markdown; no generated summaries |
| `export_citations` | 1-30 refs, format bibtex/ris/csl_json/gbt7714 | UTF-8 text, MIME, artifact, exported IDs and per-reference skipped reasons |

References accept DOI/doi.org URLs, modern/legacy/versioned arXiv IDs and arxiv.org URLs, OpenAlex W IDs, `s2:<paperId>`, public HTTPS scholarly article URLs and open PDF URLs. Bare PDFs retain unknown bibliography fields as null rather than guessing from their first lines.

`get_paper` defaults to abstract mode; metadata and abstract modes never download PDFs. For full_text, page is the **first 1-based PDF page**, and page_size is the number of pages (maximum five). Continue with page + page_size. HTML evidence uses section/paragraph locators; supply the open PDF URL when PDF pagination is needed. Focus uses deterministic keyword matching, not a model.

### Filtering and identity

Filters: from/to (inclusive ISO dates), author, institution, venue, arxiv_category and oa_only. Default search covers the three primary indexes, at most 20 candidates each. Citation sorting uses OpenAlex only. Category filtering uses arXiv only. Unsupported combinations return UNSUPPORTED_FILTER.

OpenAlex entities are resolved to IDs; ambiguity returns candidate IDs instead of a guess. Venue accepts an exact name, ISSN or OpenAlex S ID. Results are rechecked against all hard filters; unknown values fail the condition. Crossref is skipped for OA-only requests and arXiv for publication-venue requests. Date kinds distinguish submission from publication. RRF uses `1/(60+rank)` with stable ID tie-breaking. Exact DOI, arXiv base ID and OpenAlex aliases merge complementary fields; identical titles alone do not merge records.

Every tool declares an outputSchema and returns structuredContent `{status,data,warnings,error}` plus one short text. An empty successful search is different from all-sources-failed. Partial results retain usable data and expose missing coverage. Errors include code, message, retryable and next_action; invalid argument types are rejected before network calls.

## Kuku platform deployment

No language-model API/key is used server-side. The platform agent translates topic terms, explains excerpts and writes the user's answer using SKILL.md. Optional index keys belong to the platform, not end users.

| Variable | Default | Purpose |
| --- | --- | --- |
| MCP_TRANSPORT | stdio | stdio or http |
| HOST / PORT | 127.0.0.1 / 3100 | HTTP listener; use HOST=0.0.0.0 in containers |
| OUTPUT_DIR | ./output | Export directory, relative to the process cwd |
| PUBLIC_BASE_URL | unset | Public root URL, optionally with a reverse-proxy prefix; enables artifact.downloadUrl |
| OPENALEX_API_KEY | unset | Optional platform OpenAlex budget |
| S2_API_KEY | unset | Optional Semantic Scholar quota; public access otherwise |
| CONTACT_EMAIL | unset | Polite API pool and User-Agent contact |
| DISABLED_SOURCES | unset | Comma-separated openalex,crossref,arxiv,semantic_scholar |
| ALLOWED_PAPER_HOSTS | unset | Additional exact trusted paper hostnames for proxy-DNS environments, set by administrators |

The gateway owns public TLS, authentication, rate limiting and artifact expiration. Host/Origin checks and loopback binding are enabled by default. Exports have random UUID paths, without user-specific storage; anyone holding a download link can retrieve that artifact. Path, byte count and SHA-256 are always returned; downloadUrl is present only when configured.

Outbound HTTPS uses exact scholarly-host allowlists or public DNS validation, rejecting private addresses, credentials, non-443 ports and unsafe redirects. Actual streamed response limits are 25 MiB for PDFs and 5 MiB for other responses. In-memory LRU capacity is 500; queries expire after 15 minutes and metadata after 24 hours. PDFs, arbitrary user URLs and keys are not persistently cached. Search/read/compare/export deadlines are 20/30/45/60 seconds. 429/5xx retry at most twice within budget, honoring Retry-After. arXiv requests are serialized with at least three seconds between them. Parsing runs in a terminable Node subprocess with a heap limit.

## Tests

```sh
npm test
npm run test:live
```
Tests include deterministic upstream faults and real online MCP workflows over both transports, PDF extraction, reference lookup, comparison, all export formats, independent Zotero Better BibTeX parsing, an independent RIS tag reader, and downloaded artifact hashes. Network failures are not silently skipped. Outputs go to OUTPUT_DIR and are ignored by Git.

To refresh the public examples, use `RECORD_EXAMPLES=1 npm run test:live` on Linux/macOS or `$env:RECORD_EXAMPLES="1"; npm run test:live` in PowerShell.

## Migration from 1.x

Replace papers.search with search_papers, papers.analyze with get_paper, url with ref, and include_full_text=true with mode=full_text. Search page/page_size are replaced by bounded limit, not silently translated. Native /mcp replaces the old SSE gateway. Rebuild after npm ci rather than running stale generated files.

## Limitations

- Shared-IP public budgets can be exhausted on OpenAlex or Semantic Scholar; coverage failures are explicit and optional platform keys have separate quotas.
- Index coverage, abstracts, TLDR and citation counts depend on the provider and retrieval date; bounded candidates are not a systematic review.
- Scanned PDFs need OCR outside this server; columns, formulas and tables may lose layout, and extraction is capped at 300 pages.
- Missing sections stay empty; no results or limitations are inferred, and international indexes do not cover Chinese commercial databases.
- GB/T text covers common journal, conference and online records; unknown name structures remain literal and missing publication details are not invented.

## License

[Apache-2.0](LICENSE), Xingyu Chen (guangxiangdebizi).
