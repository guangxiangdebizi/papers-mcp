import { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { ToolError, errorMessage } from './core/paper.js';
import { SearchInput, SearchData, searchPapers } from './tools/search.js';
import { GetInput, GetData, getPaper } from './tools/get.js';
import { CitationsInput, CitationsData, getCitations } from './tools/citations.js';
import { CompareInput, CompareData, comparePapers } from './tools/compare.js';
import { ExportInput, ExportData, exportCitations } from './tools/export.js';

const ErrorSchema = z.object({ code: z.string(), message: z.string(), retryable: z.boolean(), next_action: z.string(), details: z.unknown().optional() });
const envelope = <T extends z.ZodType>(data: T) => z.object({ status: z.enum(['ok', 'partial', 'error']), data: data.nullable(), warnings: z.array(z.string()), error: ErrorSchema.nullable() });
export function createServer() {
  const server = new McpServer({ name: 'papers-mcp', version: '2.0.0' });
  function register<I extends z.ZodType, O extends z.ZodType>(name: string, description: string, input: I, output: O,
    run: (args: z.output<I>, signal: AbortSignal) => Promise<z.output<O>>, summarize: (data: z.output<O>) => string,
    incomplete: (data: z.output<O>) => boolean = () => false) {
    server.registerTool(name, { description, inputSchema: input as z.ZodType, outputSchema: envelope(output),
      annotations: { readOnlyHint: name !== 'export_citations', destructiveHint: false, openWorldHint: true } }, async (args, extra) => {
      try {
        const data = await run(input.parse(args), extra.mcpReq.signal);
        const warnings = (data as { warnings?: string[] }).warnings ?? [];
        const partial = incomplete(data);
        const structuredContent = { status: partial ? 'partial' : 'ok', data, warnings, error: null };
        return { content: [{ type: 'text' as const, text: summarize(data) }], structuredContent };
      } catch (e) {
        const error = e instanceof ToolError ? { code: e.code, message: e.message, retryable: e.retryable, next_action: e.next_action, ...(e.details ? { details: e.details } : {}) }
          : { code: 'TOOL_FAILED', message: errorMessage(e), retryable: true, next_action: 'Retry later or use another public source.' };
        return { isError: true, content: [{ type: 'text' as const, text: `${error.code}: ${error.message}` }],
          structuredContent: { status: 'error', data: null, warnings: [], error } };
      }
    });
  }
  register('search_papers', '找论文时使用。Search OpenAlex, Crossref and arXiv with verified hard filters; pass English topic keywords, not a natural-language question. Returns bounded candidates, provenance, coverage and a reusable query_recipe, never a merged total.', SearchInput, SearchData, searchPapers,
    d => `找到 ${d.items.length} 篇：${d.items.slice(0, 3).map(p => p.title ?? p.id).join('；')}。可用源：${d.sources.filter(s => s.status === 'ok').map(s => s.name).join(', ')}${d.sources.some(s => s.status === 'error') ? '；部分源失败，见 sources' : ''}。`, d => d.sources.some(s => s.status === 'error'));
  register('get_paper', '核对论文或读取原文时使用。Accepts DOI, arXiv ID (including version/legacy IDs), OpenAlex ID or public HTTPS article/PDF URL. mode=full_text returns PDF pages (page is the 1-based first PDF page, page_size <=5); evidence uses focus keywords and real page/section locators. Metadata/abstract mode does not download PDFs. S2 adds citation counts and TLDR when available.', GetInput, GetData, getPaper,
    d => `${d.paper.title ?? d.paper.id}：已读取 ${d.read_level}，返回 ${d.passages.length} 条原文；缺失：${d.missing.join(', ') || '无'}。`, d => d.warnings.length > 0 || d.missing.includes('full_text') || d.missing.includes('matching_passages') || d.missing.includes('page_out_of_range'));
  register('get_citations', '追踪引用或参考文献时使用。direction=citations means papers citing this work; references means works cited by it. Uses OpenAlex with Semantic Scholar fallback. Offset and limit paginate upstream records; counts are source-specific.', CitationsInput, CitationsData, getCitations,
    d => `从 ${d.source} 取得 ${d.items.length} 篇${d.direction === 'citations' ? '引用论文' : '参考文献'}。`, d => d.sources.some(s => s.status === 'error') || d.warnings.length > 0);
  register('compare_papers', '已选 2-5 篇论文，需要对照方法、数据、结果、局限时使用。Deterministically extracts original passages by section headings; every cell links to evidence with page/section. Missing full-text sections remain empty. Does not summarize, translate, rank or call a language model.', CompareInput, CompareData, comparePapers,
    d => `已对照 ${d.rows.length} 篇论文、${d.columns.length} 个维度，取得 ${d.evidence.length} 条可定位原文。`, d => d.rows.some(r => r.error || r.cells.some(c => c.excerpt === null)));
  register('export_citations', '把已选论文导入 Zotero、LaTeX 或中文报告时使用。Exports UTF-8 BibTeX, RIS, CSL-JSON or GB/T 7714-2015 text. Deduplicates exact IDs, preserves author order and reports invalid references; creates a downloadable artifact, no model required.', ExportInput, ExportData, exportCitations,
    d => `已导出 ${d.exported_ids.length} 条 ${d.format} 引用，跳过 ${d.skipped.length} 项；文件 ${d.filename}（${d.artifact.bytes} bytes）。`, d => d.skipped.some(s => !s.reason.startsWith('DUPLICATE')) || !d.exported_ids.length);
  return server;
}
