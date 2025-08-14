import fetch from "node-fetch";
import * as cheerio from "cheerio";
function ensureNumber(n, def) {
    const v = Number(n);
    return Number.isFinite(v) ? v : def;
}
function normalizeArray(input) {
    if (!input)
        return undefined;
    if (Array.isArray(input))
        return input.filter(Boolean);
    return String(input).split(",").map(s => s.trim()).filter(Boolean);
}
export const searchPapersTool = {
    name: "papers.search",
    description: "仅使用 arXiv 按关键字/作者/年份检索论文（arXiv-only）",
    parameters: {
        type: "object",
        properties: {
            query: { type: "string", description: "Main search query (keywords, title, abstract)." },
            authors: { type: "array", items: { type: "string" }, description: "Author names to filter." },
            affiliations: { type: "array", items: { type: "string" }, description: "Affiliation/Institution filters." },
            venue: { type: "array", items: { type: "string" }, description: "Journal or conference names." },
            year_from: { type: "number", description: "Start year." },
            year_to: { type: "number", description: "End year." },
            fields_of_study: { type: "array", items: { type: "string" }, description: "Field/category filters." },
            open_access_only: { type: "boolean", description: "Only return open-access results." },
            sort_by: { type: "string", enum: ["relevance", "date_desc", "citations_desc"], description: "Sorting preference." },
            page: { type: "number", description: "Page number (>=1)." },
            page_size: { type: "number", description: "Page size (<=100)." }
        },
        required: ["query"]
    },
    async run(args) {
        try {
            const query = (args.query || "").trim();
            if (!query)
                throw new Error("query is required");
            const page = Math.max(1, ensureNumber(args.page, 1));
            const page_size = Math.min(100, Math.max(1, ensureNumber(args.page_size, 20)));
            const authors = normalizeArray(args.authors);
            const affiliations = normalizeArray(args.affiliations);
            const venue = normalizeArray(args.venue);
            const fields = normalizeArray(args.fields_of_study);
            const openAccessOnly = !!args.open_access_only;
            const sortBy = args.sort_by || "relevance";
            // arXiv-only search
            const arxiv = await searchArxiv({
                query, authors, affiliations, venue, year_from: args.year_from, year_to: args.year_to, fields, openAccessOnly, sortBy, page, page_size
            });
            // Dedupe (no-op for single source, kept for consistency)
            const merged = dedupeResults([...arxiv.items]);
            const total = arxiv.total || merged.length;
            const has_more = page * page_size < total;
            const payload = {
                page,
                page_size,
                total,
                has_more,
                items: merged
            };
            return {
                content: [
                    { type: "text", text: `找到 ${merged.length} 条结果（第 ${page} 页）。` },
                    { type: "text", text: "```json\n" + JSON.stringify(payload, null, 2) + "\n```" }
                ]
            };
        }
        catch (err) {
            return { content: [{ type: "text", text: `❌ 检索失败：${err.message}` }], isError: true };
        }
    }
};
function dedupeResults(items) {
    const seen = new Map();
    const keyOf = (it) => (it.doi?.toLowerCase()) || (it.arxiv_id?.toLowerCase()) || `${(it.title || "").toLowerCase()}_${it.year || 0}`;
    for (const it of items) {
        const k = keyOf(it);
        if (!k)
            continue;
        if (!seen.has(k)) {
            seen.set(k, it);
        }
        else {
            const prev = seen.get(k);
            // prefer item with doi, with more fields filled, or higher citation_count
            const score = (x) => (x.doi ? 2 : 0) + (x.abstract_snippet ? 1 : 0) + (x.citation_count || 0);
            if (score(it) > score(prev))
                seen.set(k, it);
        }
    }
    return [...seen.values()];
}
async function searchOpenAlex(params) {
    const { query, authors, affiliations, venue, year_from, year_to, fields, openAccessOnly, sortBy, page, page_size } = params;
    const filters = [];
    if (authors && authors.length)
        filters.push(...authors.map((a) => `authorships.author.display_name.search:\"${escapeQ(a)}\"`));
    if (affiliations && affiliations.length)
        filters.push(...affiliations.map((o) => `institutions.display_name.search:\"${escapeQ(o)}\"`));
    if (venue && venue.length)
        filters.push(...venue.map((v) => `host_venue.display_name.search:\"${escapeQ(v)}\"`));
    if (year_from)
        filters.push(`from_publication_date:${year_from}-01-01`);
    if (year_to)
        filters.push(`to_publication_date:${year_to}-12-31`);
    if (openAccessOnly)
        filters.push(`is_oa:true`);
    if (fields && fields.length)
        filters.push(...fields.map((f) => `primary_topic.field.display_name.search:\"${escapeQ(f)}\"`));
    const searchParam = query ? `search=${encodeURIComponent(query)}` : "";
    const filterParam = filters.length ? `filter=${encodeURIComponent(filters.join(","))}` : "";
    const perPage = `per_page=${page_size}`;
    const pageParam = `page=${page}`;
    const sortParam = sortBy === "date_desc" ? "sort=publication_date:desc" : sortBy === "citations_desc" ? "sort=cited_by_count:desc" : "";
    const url = `https://api.openalex.org/works?${[searchParam, filterParam, perPage, pageParam, sortParam].filter(Boolean).join("&")}`;
    const res = await fetch(url, { headers: { "User-Agent": "paper-mcp/1.0 (mailto:guangxiangdebizi@gmail.com)" } });
    if (!res.ok)
        throw new Error(`OpenAlex error ${res.status}`);
    const data = await res.json();
    const items = (data.results || []).map((w) => ({
        title: w.title,
        authors: (w.authorships || []).map((a) => a.author?.display_name).filter(Boolean),
        venue: w.host_venue?.display_name,
        year: w.publication_year,
        doi: (w.doi || "").replace(/^https?:\/\/doi.org\//, ""),
        arxiv_id: (w.primary_location?.source?.hosted && w.primary_location?.source?.display_name === "arXiv") ? extractArxivId(w.primary_location?.source?.id) : undefined,
        primary_url: w.primary_location?.landing_page_url || w.host_venue?.url || w.id,
        oa_pdf_url: w.open_access?.oa_url || w.open_access?.oa_url_for_pdf || undefined,
        abstract_snippet: w.abstract_inverted_index ? invertAbstract(w.abstract_inverted_index).slice(0, 500) : undefined,
        citation_count: w.cited_by_count,
        source: "openalex"
    }));
    return { items, total: data.meta?.count || 0 };
}
function extractArxivId(id) {
    if (!id)
        return undefined;
    const m = id.match(/arxiv.org\/(abs|pdf)\/(\S+)/i);
    return m ? m[2].replace(/\.pdf$/i, "") : undefined;
}
function invertAbstract(inv) {
    // OpenAlex stores inverted-index abstract; reconstruct to string
    const positions = [];
    for (const [word, idxs] of Object.entries(inv)) {
        for (const i of idxs)
            positions.push([i, word]);
    }
    positions.sort((a, b) => a[0] - b[0]);
    return positions.map(([, w]) => w).join(" ");
}
async function searchArxiv(params) {
    const { query, authors, year_from, year_to, fields, page, page_size } = params;
    // arXiv API uses Atom; perform minimal query by combining terms
    const terms = [];
    if (query)
        terms.push(`all:${escapeQ(query)}`);
    if (authors && authors.length)
        terms.push(...authors.map((a) => `au:${escapeQ(a)}`));
    if (fields && fields.length)
        terms.push(...fields.map((f) => `cat:${escapeQ(f)}`));
    // arXiv lacks direct year range filter; could post-filter
    const searchQuery = terms.join("+AND+");
    const start = (page - 1) * page_size;
    const max_results = page_size;
    const url = `http://export.arxiv.org/api/query?search_query=${searchQuery}&start=${start}&max_results=${max_results}`;
    const res = await fetchWithRetry(url, { headers: { "User-Agent": "paper-mcp/1.0 (mailto:guangxiangdebizi@gmail.com)" } }, 2, 10000);
    if (!res.ok)
        throw new Error(`arXiv error ${res.status}`);
    const text = await res.text();
    const parsed = parseArxivAtom(text);
    let items = parsed.items;
    if (year_from || year_to) {
        items = items.filter(it => {
            const y = it.year || 0;
            return (year_from ? y >= year_from : true) && (year_to ? y <= year_to : true);
        });
    }
    return { items, total: parsed.total };
}
function parseArxivAtom(xml) {
    const $ = cheerio.load(xml, { xmlMode: true });
    const items = [];
    $('entry').each((_, el) => {
        const entry = $(el);
        const title = (entry.find('> title').first().text() || '').replace(/\s+/g, ' ').trim();
        const authors = entry.find('author > name').map((__, a) => $(a).text().trim()).get().filter(Boolean);
        const summary = (entry.find('> summary').first().text() || '').replace(/\s+/g, ' ').trim();
        const id = entry.find('> id').first().text().trim();
        const arxiv_id = (id.match(/arxiv.org\/abs\/(\S+)/) || [])[1];
        const updated = entry.find('> updated').first().text().trim();
        const year = updated ? Number(updated.slice(0, 4)) : undefined;
        const links = entry.find('> link').map((__, l) => $(l).attr('href')).get().filter(Boolean);
        const pdf = links.find(l => /\/pdf\//.test(l)) || (arxiv_id ? `https://arxiv.org/pdf/${arxiv_id}.pdf` : undefined);
        items.push({ title, authors, venue: 'arXiv', year, arxiv_id, primary_url: id, oa_pdf_url: pdf, abstract_snippet: summary, source: 'arxiv' });
    });
    const totalText = $('opensearch\\:totalResults').first().text().trim();
    const total = totalText ? Number(totalText) : items.length;
    return { items, total };
}
function textBetween(s, a, b) {
    const i = s.indexOf(a);
    if (i === -1)
        return "";
    const j = s.indexOf(b, i + a.length);
    if (j === -1)
        return "";
    return s.slice(i + a.length, j);
}
async function searchCrossref(params) {
    const { query, authors, affiliations, venue, year_from, year_to, sortBy, page, page_size } = params;
    const qs = {
        query: query,
        rows: String(page_size),
        offset: String((page - 1) * page_size)
    };
    if (authors && authors.length)
        qs["query.author"] = authors.join(" ");
    if (venue && venue.length)
        qs["query.container-title"] = venue.join(" ");
    if (year_from || year_to) {
        const from = year_from || 1900;
        const to = year_to || new Date().getFullYear();
        qs.filter = `from-pub-date:${from}-01-01,until-pub-date:${to}-12-31`;
    }
    if (sortBy === "date_desc")
        qs.sort = "issued";
    const url = `https://api.crossref.org/works?${new URLSearchParams(qs).toString()}`;
    const res = await fetch(url, { headers: { "User-Agent": "paper-mcp/1.0 (mailto:guangxiangdebizi@gmail.com)" } });
    if (!res.ok)
        throw new Error(`Crossref error ${res.status}`);
    const data = await res.json();
    const items = (data.message?.items || []).map((it) => ({
        title: Array.isArray(it.title) ? it.title[0] : it.title,
        authors: (it.author || []).map((a) => [a.given, a.family].filter(Boolean).join(" ")).filter(Boolean),
        venue: Array.isArray(it["container-title"]) ? it["container-title"][0] : it["container-title"],
        year: it.issued?.["date-parts"]?.[0]?.[0],
        doi: it.DOI,
        primary_url: it.URL,
        abstract_snippet: typeof it.abstract === "string" ? it.abstract.replace(/<[^>]+>/g, "").slice(0, 500) : undefined,
        source: "crossref"
    }));
    const total = data.message["total-results"] || items.length;
    return { items, total };
}
function escapeQ(s) { return s.replace(/["<>]/g, " "); }
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
