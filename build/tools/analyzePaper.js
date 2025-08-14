import fetch from "node-fetch";
import * as cheerio from "cheerio";
export const analyzePaperTool = {
    name: "papers.analyze",
    description: "从 URL 分析论文（支持 PDF、arXiv、期刊/网页、DOI），提取标题/作者/摘要，必要时提取正文摘要。",
    parameters: {
        type: "object",
        properties: {
            url: {
                type: "string",
                description: "URL of the paper (PDF link, arXiv page, journal article page, DOI link)."
            },
            include_full_text: {
                type: "boolean",
                description: "Whether to extract full text content (default: false, only extract abstract and metadata)."
            },
            max_content_length: {
                type: "number",
                description: "Maximum length of extracted content in characters (default: 5000)."
            }
        },
        required: ["url"]
    },
    async run(args) {
        try {
            const url = (args.url || "").trim();
            if (!url)
                throw new Error("请提供 URL");
            const includeFullText = !!args.include_full_text;
            const maxLength = Math.min(20000, Math.max(1000, args.max_content_length || 5000));
            // Normalize URL and determine type
            const normalizedUrl = normalizeUrl(url);
            const urlType = await detectUrlType(normalizedUrl);
            let result;
            switch (urlType) {
                case "pdf":
                    result = await analyzePdf(normalizedUrl, includeFullText, maxLength);
                    break;
                case "arxiv":
                    result = await analyzeArxiv(normalizedUrl, includeFullText, maxLength);
                    break;
                case "doi":
                    result = await analyzeDoi(normalizedUrl, includeFullText, maxLength);
                    break;
                case "webpage":
                default:
                    result = await analyzeWebpage(normalizedUrl, includeFullText, maxLength);
                    break;
            }
            const summary = generateSummary(result);
            return {
                content: [
                    { type: "text", text: summary },
                    { type: "text", text: "```json\n" + JSON.stringify(result, null, 2) + "\n```" }
                ]
            };
        }
        catch (err) {
            return {
                content: [{ type: "text", text: `❌ 分析失败：${err.message}` }],
                isError: true
            };
        }
    }
};
// Helper functions
function normalizeUrl(url) {
    if (!url.startsWith("http")) {
        if (url.startsWith("doi:")) {
            return `https://doi.org/${url.slice(4)}`;
        }
        if (url.match(/^10\./)) {
            return `https://doi.org/${url}`;
        }
        if (url.match(/^\d{4}\.\d{4}/)) {
            return `https://arxiv.org/abs/${url}`;
        }
        return `https://${url}`;
    }
    return url;
}
async function detectUrlType(url) {
    try {
        const u = new URL(url);
        const pathname = u.pathname.toLowerCase();
        if (pathname.endsWith(".pdf"))
            return "pdf";
        if (u.hostname.includes("arxiv.org"))
            return "arxiv";
        if (u.hostname.includes("doi.org") || pathname.includes("/doi/"))
            return "doi";
        // Heuristic: check content-type via HEAD for potential PDFs
        const ct = await headContentType(url).catch(() => "");
        if (ct && ct.includes("application/pdf"))
            return "pdf";
        return "webpage";
    }
    catch {
        return "webpage";
    }
}
async function analyzePdf(url, includeFullText, maxLength) {
    const MAX_PDF_BYTES = 25 * 1024 * 1024; // 25MB 上限，避免内存压力
    const len = await headContentLength(url).catch(() => undefined);
    if (typeof len === "number" && len > MAX_PDF_BYTES) {
        throw new Error(`PDF 文件过大（${Math.round(len / 1048576)}MB），请改用摘要模式或提供更小文件`);
    }
    const response = await fetchWithRetry(url, {
        headers: { "User-Agent": "paper-mcp/1.0 (mailto:guangxiangdebizi@gmail.com)", "Accept": "application/pdf" }
    }, 2, 15000);
    if (!response.ok) {
        throw new Error(`Failed to fetch PDF: ${response.status}`);
    }
    const buffer = await response.buffer();
    // Dynamic import to avoid startup issues
    const pdfParse = (await import("pdf-parse")).default;
    const pdfData = await pdfParse(buffer);
    const text = pdfData.text || "";
    const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
    // Extract title (usually first few non-empty lines)
    const title = extractTitle(lines);
    // Extract authors (heuristic: look for patterns after title)
    const authors = extractAuthors(lines, title);
    // Extract abstract
    const abstract = extractAbstract(text);
    // Extract content
    const content = includeFullText ? text.slice(0, maxLength) : abstract;
    return {
        title,
        authors,
        abstract,
        content: content?.slice(0, maxLength),
        url,
        type: "pdf",
        metadata: {
            pages: pdfData.numpages,
            text_length: text.length
        }
    };
}
async function analyzeArxiv(url, includeFullText, maxLength) {
    // Extract arXiv ID from URL
    const arxivId = url.match(/arxiv\.org\/(?:abs|pdf)\/(\S+?)(?:\.pdf)?$/)?.[1];
    if (!arxivId)
        throw new Error("Invalid arXiv URL");
    // Fetch arXiv API
    const apiUrl = `http://export.arxiv.org/api/query?id_list=${arxivId}`;
    const response = await fetchWithRetry(apiUrl, {
        headers: { "User-Agent": "paper-mcp/1.0 (mailto:guangxiangdebizi@gmail.com)" }
    }, 2, 10000);
    if (!response.ok)
        throw new Error(`arXiv API error: ${response.status}`);
    const xml = await response.text();
    // Parse XML robustly via cheerio (XML mode)
    const $ = cheerio.load(xml, { xmlMode: true });
    const entry = $('entry').first();
    const title = (entry.find('> title').first().text() || '').replace(/\s+/g, ' ').trim();
    const summary = (entry.find('> summary').first().text() || '').replace(/\s+/g, ' ').trim();
    const authors = entry.find('author > name').map((_, a) => $(a).text().trim()).get().filter(Boolean);
    const published = entry.find('> published').first().text().trim();
    const categories = entry.find('> category').map((_, c) => $(c).attr('term')).get().filter(Boolean);
    let fullContent = summary;
    // If full text requested, try to get PDF
    if (includeFullText) {
        try {
            const pdfUrl = `https://arxiv.org/pdf/${arxivId}.pdf`;
            const pdfResult = await analyzePdf(pdfUrl, true, maxLength);
            fullContent = pdfResult.content || summary;
        }
        catch {
            // Fallback to summary if PDF fails
            fullContent = summary;
        }
    }
    return {
        title,
        authors,
        abstract: summary,
        content: fullContent?.slice(0, maxLength),
        url,
        type: "arxiv",
        metadata: {
            arxiv_id: arxivId,
            published,
            categories,
            pdf_url: `https://arxiv.org/pdf/${arxivId}.pdf`
        }
    };
}
async function analyzeDoi(url, includeFullText, maxLength) {
    // Extract DOI
    const doi = url.match(/doi\.org\/(10\..+)$/)?.[1] || url.match(/\/doi\/(10\..+)$/)?.[1];
    if (!doi)
        throw new Error("Invalid DOI URL");
    // Try Crossref API first
    try {
        const crossrefUrl = `https://api.crossref.org/works/${doi}`;
        const response = await fetchWithRetry(crossrefUrl, {
            headers: { "User-Agent": "paper-mcp/1.0 (mailto:guangxiangdebizi@gmail.com)" }
        }, 2, 10000);
        if (response.ok) {
            const data = await response.json();
            const work = data.message;
            const title = Array.isArray(work.title) ? work.title[0] : work.title;
            const authors = (work.author || []).map((a) => [a.given, a.family].filter(Boolean).join(" "));
            const abstract = work.abstract ?
                work.abstract.replace(/<[^>]+>/g, "").slice(0, maxLength) : "";
            // Try to get full text from publisher page
            let content = abstract;
            if (includeFullText && work.URL) {
                try {
                    const pageResult = await analyzeWebpage(work.URL, true, maxLength);
                    content = pageResult.content || abstract;
                }
                catch {
                    content = abstract;
                }
            }
            return {
                title,
                authors,
                abstract,
                content: content?.slice(0, maxLength),
                url,
                type: "doi",
                metadata: {
                    doi,
                    publisher: work.publisher,
                    journal: Array.isArray(work["container-title"]) ?
                        work["container-title"][0] : work["container-title"],
                    published: work.published?.["date-parts"]?.[0]?.join("-"),
                    publisher_url: work.URL
                }
            };
        }
    }
    catch {
        // Fallback to webpage analysis
    }
    // Fallback: analyze the DOI redirect page
    return await analyzeWebpage(url, includeFullText, maxLength);
}
async function analyzeWebpage(url, includeFullText, maxLength) {
    const response = await fetchWithRetry(url, {
        headers: {
            "User-Agent": "paper-mcp/1.0 (mailto:guangxiangdebizi@gmail.com)",
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8"
        }
    }, 1, 12000);
    if (!response.ok)
        throw new Error(`Failed to fetch webpage: ${response.status}`);
    const html = await response.text();
    const $ = cheerio.load(html);
    // Extract title
    const title = $('title').text().trim() ||
        $('h1').first().text().trim() ||
        $('meta[property="og:title"]').attr('content') ||
        $('meta[name="citation_title"]').attr('content') || "";
    // Extract authors
    const authors = [];
    $('meta[name="citation_author"]').each((_, el) => {
        const author = $(el).attr('content');
        if (author)
            authors.push(author.trim());
    });
    // If no citation authors, try other selectors
    if (authors.length === 0) {
        $('.author, .authors, [class*="author"]').each((_, el) => {
            const text = $(el).text().trim();
            if (text && text.length < 100)
                authors.push(text);
        });
    }
    // Extract abstract
    let abstract = $('meta[name="citation_abstract"]').attr('content') ||
        $('meta[property="og:description"]').attr('content') ||
        $('meta[name="description"]').attr('content') || "";
    if (!abstract) {
        const abstractSelectors = ['.abstract', '#abstract', '[class*="abstract"]', '.summary'];
        for (const sel of abstractSelectors) {
            const elem = $(sel).first();
            if (elem.length) {
                abstract = elem.text().trim();
                break;
            }
        }
    }
    // Extract content
    let content = abstract;
    if (includeFullText) {
        // Remove script, style, nav, header, footer
        $('script, style, nav, header, footer, .navigation, .sidebar').remove();
        // Try to find main content
        const contentSelectors = ['main', '.content', '.article-body', '.paper-content', 'article', '.main'];
        let mainContent = "";
        for (const sel of contentSelectors) {
            const elem = $(sel).first();
            if (elem.length) {
                mainContent = elem.text().trim();
                break;
            }
        }
        if (!mainContent) {
            mainContent = $('body').text().trim();
        }
        content = mainContent.replace(/\s+/g, " ").slice(0, maxLength);
    }
    return {
        title: title.slice(0, 500),
        authors: authors.slice(0, 20), // Limit authors
        abstract: abstract.slice(0, 2000),
        content: content?.slice(0, maxLength),
        url,
        type: "webpage",
        metadata: {
            domain: new URL(url).hostname,
            content_length: content?.length || 0
        }
    };
}
// Text extraction helpers
function extractTitle(lines) {
    // Look for the first substantial line that looks like a title
    for (let i = 0; i < Math.min(10, lines.length); i++) {
        const line = lines[i];
        if (line.length > 10 && line.length < 200 &&
            !line.toLowerCase().includes('abstract') &&
            !line.toLowerCase().includes('introduction')) {
            return line;
        }
    }
    return lines[0] || "";
}
function extractAuthors(lines, title) {
    const authors = [];
    const titleIndex = lines.findIndex(l => l.includes(title.slice(0, 20)));
    // Look in the few lines after title
    for (let i = titleIndex + 1; i < Math.min(titleIndex + 5, lines.length); i++) {
        const line = lines[i];
        if (line.length > 5 && line.length < 100) {
            // Simple heuristic: if it contains common name patterns
            if (/[A-Z][a-z]+\s+[A-Z][a-z]+/.test(line) || line.includes(',')) {
                authors.push(...line.split(/[,;]/).map(s => s.trim()).filter(Boolean));
                break;
            }
        }
    }
    return authors.slice(0, 10); // Limit to 10 authors
}
function extractAbstract(text) {
    const abstractMatch = text.match(/(?:abstract|summary)[\s\n]*:?[\s\n]*([\s\S]{50,2000}?)(?:\n\s*\n|introduction|keywords|1\.|references)/i);
    return abstractMatch ? abstractMatch[1].trim().replace(/\s+/g, " ") : "";
}
function extractXmlContent(xml, tag) {
    const match = xml.match(new RegExp(`<${tag}>([\s\S]*?)<\/${tag}>`, 'i'));
    return match ? match[1].trim() : "";
}
function generateSummary(result) {
    const { title, authors, abstract, type, metadata } = result;
    let summary = `# ${title || '未命名论文'}\n\n`;
    if (authors && authors.length) {
        summary += `**作者**：${authors.slice(0, 5).join('，')}${authors.length > 5 ? ' 等' : ''}\n\n`;
    }
    if (abstract) {
        summary += `**摘要：**\n${abstract}\n\n`;
    }
    summary += `**来源类型**：${type}\n`;
    if (metadata) {
        if (metadata.arxiv_id)
            summary += `**arXiv ID**：${metadata.arxiv_id}\n`;
        if (metadata.doi)
            summary += `**DOI**：${metadata.doi}\n`;
        if (metadata.journal)
            summary += `**期刊**：${metadata.journal}\n`;
        if (metadata.published)
            summary += `**发表时间**：${metadata.published}\n`;
        if (metadata.pages)
            summary += `**页数**：${metadata.pages}\n`;
    }
    return summary;
}
// Networking helpers
async function fetchWithRetry(url, init = {}, retries = 2, timeoutMs = 10000) {
    let attempt = 0;
    let lastErr;
    while (attempt <= retries) {
        const ac = new AbortController();
        const id = setTimeout(() => ac.abort(), timeoutMs);
        try {
            const res = await fetch(url, { ...init, signal: ac.signal });
            clearTimeout(id);
            if (res.status === 429 || res.status >= 500) {
                throw new Error(`HTTP ${res.status}`);
            }
            return res;
        }
        catch (e) {
            clearTimeout(id);
            lastErr = e;
            if (attempt === retries)
                break;
            const backoff = 300 * Math.pow(2, attempt);
            await new Promise(r => setTimeout(r, backoff));
            attempt++;
        }
    }
    throw lastErr;
}
async function headContentType(url) {
    const res = await fetchWithRetry(url, { method: "HEAD", headers: { "User-Agent": "paper-mcp/1.0 (mailto:guangxiangdebizi@gmail.com)" } }, 1, 6000);
    return res.headers.get("content-type") || undefined;
}
async function headContentLength(url) {
    const res = await fetchWithRetry(url, { method: "HEAD", headers: { "User-Agent": "paper-mcp/1.0 (mailto:guangxiangdebizi@gmail.com)" } }, 1, 6000);
    const len = res.headers.get("content-length");
    return len ? Number(len) : undefined;
}
