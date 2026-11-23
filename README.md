# Papers MCP：查论文、读原文、导引用
跨 OpenAlex、Crossref、arXiv 查找论文，用 Semantic Scholar 补充引用数和 TLDR。
按页读取开放 PDF、定位方法与结果、对照最多五篇论文，导出 BibTeX、RIS、CSL-JSON 和 GB/T 7714。

[English](README.en.md) · [中文问法与 agent 工作流](SKILL.md) · [真实运行输出](docs/live-examples.json)

## 真实输出

案例由真实 MCP Client 运行，完整题录、来源状态和原文定位见 [live-examples.json](docs/live-examples.json)。

### 找“扩散语言模型”

平台把中文概念转换为通用英文检索词：
```json
{"query":"diffusion language models","limit":5}
```

结果返回 `query_recipe`、`applied_filters`、每源状态、字段来源和版本关系。按源内排名倒数融合去重，不报告无法核对的跨库总量。真实命中题录保存在上面的输出文件中。

本次命中的条目包括：

| 论文 | 日期 | 标识 |
| --- | --- | --- |
| Improving Variable-Length Generation in Diffusion Language Models via Length Regularization | 2026-02-07 | arXiv:2602.07546 |
| Hierarchical Continuous Diffusion Language Models | 2026-10-01 | arXiv:2610.02193 |
| Diffusion-based Large Language Models Survey | 2025-08-12 | DOI:10.36227/techrxiv.175502932.20939890/v1 |

本次 OpenAlex 公共日额度耗尽，候选由 arXiv 与 Crossref 交付；该覆盖状态也保存在结果中。

### 读 1706.03762 的方法

```json
{"ref":"1706.03762v7","mode":"evidence","focus":"model architecture","max_passages":2}
```

*Attention Is All You Need*，`3 Model Architecture`：
> The Transformer follows this overall architecture using stacked self-attention and point-wise, fully connected layers for both the encoder and decoder, shown in the left and right halves of Figure 1, respectively.

定位为 [arXiv v7 第 3 节](https://arxiv.org/html/1706.03762v7#S3)，返回 `basis=full_text` 和段号。HTML 不编造页码。[NeurIPS 正式版 PDF](https://papers.neurips.cc/paper_files/paper/2017/file/3f5ee243547dee91fbd053c1c4a845aa-Paper.pdf) 的分页案例保存在同一输出文件中。

### 导出中文引用

```json
{"refs":["10.1038/nature14539"],"format":"gbt7714"}
```
```text
[1] LECUN Y, BENGIO Y, HINTON G. Deep learning[J]. Nature, 2015, 521(7553): 436-444. DOI:10.1038/nature14539.
```

下载并导入：[BibTeX](docs/citations.bib) · [RIS](docs/citations.ris) · [CSL-JSON](docs/citations.json) · [GB/T 7714-2015 文本](docs/citations.txt)。样例混合 Nature DOI 和 arXiv 预印本，保留作者顺序和预印本链接。

## 五分钟部署

Node.js **20.19+**，推荐 Node 22 LTS。使用 lockfile 固定依赖。
```sh
git clone https://github.com/guangxiangdebizi/papers-mcp.git
cd papers-mcp
npm ci
npm run build
npm start
```

`npm start` 默认 stdio，等待 MCP 客户端消息；日志只写 stderr。使用官方稳定 v2 拆包：`@modelcontextprotocol/server@2.4.0`、`@modelcontextprotocol/node@2.1.2`；测试客户端为 `@modelcontextprotocol/client@2.4.0`。安装方式按 [官方 SDK 说明](https://github.com/modelcontextprotocol/typescript-sdk#installation) 和实施日 npm 核实。PDF 使用锁定的 `pdfjs-dist@4.10.38`，不再依赖 `pdf-parse`。

### stdio 配置

把 `cwd` 改为克隆目录绝对路径。Windows JSON 路径使用 `/` 或 `\\`。
```json
{
  "mcpServers": {
    "papers": {
      "command": "node",
      "args": ["build/index.js"],
      "cwd": "/path/to/papers-mcp",
      "env": {"MCP_TRANSPORT":"stdio","OUTPUT_DIR":"./output"}
    }
  }
}
```

不支持 `cwd` 的客户端把 args 改为 `/path/to/papers-mcp/build/index.js`，并给 OUTPUT_DIR 指定绝对路径。

### Streamable HTTP 配置

PowerShell：
```powershell
$env:MCP_TRANSPORT = "http"
$env:PORT = "3100"
$env:OUTPUT_DIR = "./output"
$env:PUBLIC_BASE_URL = "http://127.0.0.1:3100"
npm start
```

Linux/macOS：
```sh
MCP_TRANSPORT=http PORT=3100 OUTPUT_DIR=./output PUBLIC_BASE_URL=http://127.0.0.1:3100 npm start
```

客户端：
```json
{"mcpServers":{"papers":{"url":"http://127.0.0.1:3100/mcp"}}}
```

HTTP `/mcp` 是无状态 Streamable HTTP，不使用旧 SSE 网关，不创建用户会话。`GET /health` 检查服务；`GET /files/<随机 UUID>/<文件名>` 下载引用文件。MCP 使用 POST；GET/DELETE `/mcp` 返回 405。

## 工具与参数

所有工具有 Zod 输入、`outputSchema`、`structuredContent` 和一句可读结果。

| 工具 | 核心参数 | 返回 |
| --- | --- | --- |
| `search_papers` | `query`，`filters`，`sources`，`sort`，`limit=1..20` | 有界候选、覆盖状态、复查配方、是否截断 |
| `get_paper` | `ref`，`mode=metadata/abstract/evidence/full_text`，`focus`，`max_passages=1..6`，`page`，`page_size=1..5` | 题录、实际读取层级、原文和页码/章节/段号 |
| `get_citations` | `ref`，`direction=references/citations`，`source=auto/openalex/semantic_scholar`，`offset`，`limit=1..50` | 参考文献或施引文献、来源和下一偏移量 |
| `compare_papers` | `refs=2..5`，`dimensions=method/data/result/limitation`，`focus` | 按章节标题抽取的原文矩阵、证据和 Markdown；不生成总结 |
| `export_citations` | `refs=1..30`，`format=bibtex/ris/csl_json/gbt7714` | UTF-8 正文、MIME、文件、导出 ID 与逐项 skipped |

`get_paper` 默认读摘要。`metadata` 和 `abstract` 模式不下载 PDF。`full_text` 的 `page` 是 PDF 起始页码，每次最多五页，下一次 `page += page_size`。HTML 使用 passages 的章节/段号；查看 PDF 页码可传开放 PDF URL。裸 PDF 不猜题名和作者，缺失书目保持 null。

支持 DOI、doi.org URL、新旧式 arXiv ID 和版本、arxiv.org/abs/pdf/html URL、OpenAlex W ID、`s2:<paperId>` 及公共 HTTPS 学术文章 URL。`focus` 是确定性关键词匹配，中文解读由平台 agent 完成。

### 筛选约定

`filters` 支持 `from/to`（ISO 日期，含端点）、`author`、`institution`、`venue`、`arxiv_category`、`oa_only`。默认搜索三个主源，每源最多 20 个候选，不提供搜索结果翻页游标。

- OpenAlex 作者/机构/载体使用实体 ID。名称先解析；同名歧义返回 `AMBIGUOUS_ENTITY` 和候选，不自动选第一条。
- `venue` 可传精确刊名、ISSN 或 OpenAlex S ID；已知 ISSN 应优先使用。
- 返回后再次核对硬条件，未知不算满足。Crossref 无法验证 OA，arXiv 无法验证正式发表期刊，因而自动跳过。
- 引用数排序仅用 OpenAlex，返回取数日期；`arxiv_category` 仅用 arXiv。没有兼容源时返回 `UNSUPPORTED_FILTER`。
- 相关性按 `1/(60+rank)` 融合，日期按首次发表/提交日期排序；`date_kind` 明示语义。
- 规范 DOI、arXiv 基础 ID 和 OpenAlex ID 建别名索引。同名但没有标识关系时不合并。

### 结构与错误

结果信封为 `structuredContent:{status,data,warnings,error}`。`ok` 的空 items 表示零命中；`partial` 表示已有结果但覆盖、原文或某些条目缺失；全部来源失败返回 `error` 并设置 `isError=true`。错误包含 `code/message/retryable/next_action`。参数类型错误由 SDK 在请求前拒绝。完整结构见工具 outputSchema 与真实样例。

## 库库平台封装

不需要模型 key，最终用户无需申请 Token。平台可统一配置可选来源 key。用 `SKILL.md` 的中文问法让 agent 找候选、定位、解读与导出。

| 环境变量 | 默认 | 用途 |
| --- | --- | --- |
| `MCP_TRANSPORT` | `stdio` | `stdio` 或 `http` |
| `PORT` / `HOST` | `3100` / `127.0.0.1` | HTTP 监听；容器可设置 HOST=0.0.0.0 |
| `OUTPUT_DIR` | `./output` | 引用文件目录，按运行目录解析 |
| `PUBLIC_BASE_URL` | 不设置 | 对外根 URL；设置后返回 downloadUrl，反代时可含基础路径 |
| `OPENALEX_API_KEY` | 不设置 | 平台 OpenAlex 额度；无 key 使用公共额度 |
| `S2_API_KEY` | 不设置 | 平台 Semantic Scholar 额度；无 key 走公共接口 |
| `CONTACT_EMAIL` | 不设置 | 上游礼貌池和 User-Agent 联系方式 |
| `DISABLED_SOURCES` | 不设置 | 逗号分隔禁用 openalex/crossref/arxiv/semantic_scholar |
| `ALLOWED_PAPER_HOSTS` | 不设置 | 代理 DNS 环境中额外信任的精确论文主机名，由平台管理员配置 |

网关负责公网 HTTPS、认证、限流和产物过期清理。服务默认回环监听，检查 HTTP Host/Origin。产物无用户身份分区，随机 UUID 隔离文件；下载链接持有者可下载对应文件。

出站仅 HTTPS：可信学术主机用精确白名单，其他主机检查公网 DNS 地址；拒绝私网、凭据 URL、非 443 端口和不安全跳转。进程内 500 项 LRU 缓存查询 15 分钟、题录 24 小时，不持久缓存 PDF、任意用户 URL 或 key。按实际字节限制 PDF 25 MiB，其他响应 5 MiB。搜索/单篇/比较/导出的总时限为 20/30/45/60 秒；429/5xx 最多重试两次并遵守 Retry-After。arXiv 单并发，间隔至少 3 秒。解析在可终止、限制堆内存的独立 Node 子进程执行。

## 测试

```sh
npm test
npm run test:live
```

`npm test` 包含故障测试和真实在线流程：启动 stdio/HTTP、调用五个工具、读 PDF 页、导出再用 Zotero Better BibTeX 独立解析器和独立 RIS tag reader 核对文件、验证下载 SHA-256。需要联网，服务不可达会使验收失败，不静默跳过。产物写 OUTPUT_DIR，不进 Git。

更新真实样例：PowerShell 执行 `$env:RECORD_EXAMPLES="1"; npm run test:live`；Linux/macOS 执行 `RECORD_EXAMPLES=1 npm run test:live`。docs/ 只保存用户可用输出，内部记录单独保存。

## 从 1.x 迁移

`papers.search` → `search_papers`；`papers.analyze` → `get_paper`。旧 `url` → `ref`，`include_full_text=true` → `mode=full_text`；检索 `page/page_size` 改为有界 `limit`，不静默映射旧分页语义。`sse` 脚本由原生 `/mcp` 替代。先 `npm ci && npm run build`，不要运行旧生成文件。

## 局限

- OpenAlex 和 Semantic Scholar 的公共额度可能被共享 IP 耗尽；失败源显式返回状态，平台 key 可提供独立额度。
- 收录、摘要、TLDR 和引用数取决于来源与取数日期，候选集不等于系统检索全集。
- 扫描 PDF 无 OCR，复杂双栏、公式和表格可能丢失版面，单篇最多解析 300 页。
- 章节抽取不推断未写出的数据、结果或局限，国际检索不覆盖中文商业数据库。
- GB/T 文本覆盖常见期刊、会议和在线文献条目，未知姓名结构保留原名，不补造出版信息。

## 许可证

[Apache-2.0](LICENSE)，作者陈星宇（guangxiangdebizi）。
