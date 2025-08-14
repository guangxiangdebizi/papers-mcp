# 📚 Paper MCP

A Model Context Protocol (MCP) server for academic paper search and analysis. This tool helps researchers quickly find, analyze, and extract information from academic papers using open data sources.

## ✨ Features

### 🔍 Paper Search (`papers.search`)
- **Multi-source search**: OpenAlex, Crossref, arXiv
- **Advanced filtering**: Author, affiliation, venue, year range, field of study
- **Smart deduplication**: Automatically merges results from different sources
- **Open access focus**: Option to filter for freely available papers
- **Flexible sorting**: By relevance, date, or citation count

### 📖 Paper Analysis (`papers.analyze`)
- **Universal URL support**: PDF links, arXiv pages, DOI links, journal pages
- **Intelligent extraction**: Title, authors, abstract, metadata
- **Full-text analysis**: Optional complete content extraction
- **Multiple formats**: Handles PDF, HTML, and XML sources
- **Rich metadata**: Publication details, citation info, access links

## 🚀 Quick Start

### Installation

```bash
# Clone the repository
git clone https://github.com/guangxiangdebizi/paper-mcp.git
cd paper-mcp

# Install dependencies
npm install

# Build the project
npm run build
```

### Usage

#### Local Development (Stdio)
```bash
# Start the MCP server
npm start
```

#### Web Interface (SSE)
```bash
# Install supergateway globally
npm install -g supergateway

# Start SSE server on port 3100
npm run sse
```

### Claude Desktop Configuration

#### Stdio Mode
Add to your Claude Desktop config:
```json
{
  "mcpServers": {
    "paper-mcp": {
      "command": "node",
      "args": ["path/to/paper-mcp/build/index.js"]
    }
  }
}
```

#### SSE Mode
```json
{
  "mcpServers": {
    "paper-mcp": {
      "type": "sse",
      "url": "http://localhost:3100/sse",
      "timeout": 600
    }
  }
}
```

## 🛠️ API Reference

### Search Papers

```typescript
// Basic search
{
  "query": "machine learning transformers"
}

// Advanced search with filters
{
  "query": "neural networks",
  "authors": ["Geoffrey Hinton", "Yann LeCun"],
  "affiliations": ["Google", "Meta"],
  "venue": ["Nature", "Science"],
  "year_from": 2020,
  "year_to": 2024,
  "open_access_only": true,
  "sort_by": "citations_desc",
  "page": 1,
  "page_size": 20
}
```

### Analyze Paper

```typescript
// Analyze from URL
{
  "url": "https://arxiv.org/abs/2301.00001"
}

// Full-text extraction
{
  "url": "https://example.com/paper.pdf",
  "include_full_text": true,
  "max_content_length": 10000
}
```

## 🌐 Data Sources

- **[OpenAlex](https://openalex.org/)**: Comprehensive academic database
- **[Crossref](https://www.crossref.org/)**: DOI and metadata registry
- **[arXiv](https://arxiv.org/)**: Preprint repository
- **[Unpaywall](https://unpaywall.org/)**: Open access link detection

## 📊 Example Outputs

### Search Results
```json
{
  "page": 1,
  "page_size": 20,
  "has_more": true,
  "items": [
    {
      "title": "Attention Is All You Need",
      "authors": ["Ashish Vaswani", "Noam Shazeer"],
      "venue": "NeurIPS",
      "year": 2017,
      "doi": "10.5555/3295222.3295349",
      "primary_url": "https://arxiv.org/abs/1706.03762",
      "oa_pdf_url": "https://arxiv.org/pdf/1706.03762.pdf",
      "citation_count": 50000,
      "source": "openalex"
    }
  ]
}
```

### Analysis Results
```json
{
  "title": "Attention Is All You Need",
  "authors": ["Ashish Vaswani", "Noam Shazeer"],
  "abstract": "The dominant sequence transduction models...",
  "content": "Full paper content...",
  "type": "arxiv",
  "metadata": {
    "arxiv_id": "1706.03762",
    "published": "2017-06-12",
    "categories": ["cs.CL", "cs.AI"]
  }
}
```

## 🔧 Development

```bash
# Watch mode for development
npm run dev

# Build for production
npm run build

# Run tests (if available)
npm test
```

## 📝 License

Apache 2.0 - see [LICENSE](LICENSE) file for details.

## 👨‍💻 Author

**Xingyu Chen**
- 📧 Email: [guangxiangdebizi@gmail.com](mailto:guangxiangdebizi@gmail.com)
- 🔗 LinkedIn: [xingyu-chen-b5b3b0313](https://www.linkedin.com/in/xingyu-chen-b5b3b0313/)
- 🐙 GitHub: [@guangxiangdebizi](https://github.com/guangxiangdebizi/)
- 📦 NPM: [@xingyuchen](https://www.npmjs.com/~xingyuchen)

## 🤝 Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## 🙏 Acknowledgments

- OpenAlex for providing comprehensive academic data
- Crossref for DOI resolution services
- arXiv for open access to preprints
- The MCP community for the excellent protocol

---

*Built with ❤️ for the research community*