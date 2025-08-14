# 📚 Paper MCP Usage Examples

This document provides practical examples of how to use the Paper MCP tools for academic research.

## 🔍 Search Papers Examples

### Basic Keyword Search
```json
{
  "query": "machine learning"
}
```

### Search by Author
```json
{
  "query": "neural networks",
  "authors": ["Geoffrey Hinton", "Yann LeCun"]
}
```

### Search by Institution
```json
{
  "query": "computer vision",
  "affiliations": ["Stanford University", "MIT"]
}
```

### Advanced Search with Multiple Filters
```json
{
  "query": "transformer architecture",
  "authors": ["Ashish Vaswani"],
  "venue": ["NeurIPS", "ICML", "ICLR"],
  "year_from": 2017,
  "year_to": 2024,
  "open_access_only": true,
  "sort_by": "citations_desc",
  "page": 1,
  "page_size": 10
}
```

### Search in Specific Fields
```json
{
  "query": "quantum computing",
  "fields_of_study": ["Computer Science", "Physics"],
  "year_from": 2020
}
```

## 📖 Analyze Papers Examples

### Analyze arXiv Paper
```json
{
  "url": "https://arxiv.org/abs/1706.03762"
}
```

### Analyze PDF with Full Text
```json
{
  "url": "https://arxiv.org/pdf/1706.03762.pdf",
  "include_full_text": true,
  "max_content_length": 10000
}
```

### Analyze DOI Link
```json
{
  "url": "https://doi.org/10.1038/nature14539"
}
```

### Analyze Journal Page
```json
{
  "url": "https://www.nature.com/articles/nature14539",
  "include_full_text": true
}
```

## 🎯 Common Research Workflows

### 1. Literature Review Workflow

**Step 1: Broad Search**
```json
{
  "query": "deep learning medical imaging",
  "year_from": 2020,
  "sort_by": "citations_desc",
  "page_size": 50
}
```

**Step 2: Analyze Top Papers**
```json
{
  "url": "https://arxiv.org/abs/2001.00001",
  "include_full_text": true
}
```

**Step 3: Find Related Work by Authors**
```json
{
  "query": "medical imaging",
  "authors": ["Author Name from Step 2"]
}
```

### 2. Conference Paper Discovery

**Find Recent Papers from Top Venues**
```json
{
  "query": "natural language processing",
  "venue": ["ACL", "EMNLP", "NAACL"],
  "year_from": 2023,
  "sort_by": "date_desc"
}
```

### 3. Open Access Research

**Find Freely Available Papers**
```json
{
  "query": "artificial intelligence ethics",
  "open_access_only": true,
  "sort_by": "relevance"
}
```

### 4. Institution-Specific Research

**Find Papers from Specific Universities**
```json
{
  "query": "robotics",
  "affiliations": ["Carnegie Mellon University", "MIT"],
  "year_from": 2022
}
```

## 🔧 Tips and Best Practices

### Search Tips
- Use specific keywords for better results
- Combine multiple filters to narrow down results
- Use `open_access_only: true` to find freely available papers
- Sort by `citations_desc` to find influential papers
- Sort by `date_desc` to find recent work

### Analysis Tips
- Use `include_full_text: true` for comprehensive analysis
- Set appropriate `max_content_length` based on your needs
- arXiv URLs work best for full-text extraction
- DOI links provide reliable metadata

### Performance Tips
- Start with smaller page sizes (10-20) for faster results
- Use specific author/venue filters to reduce search scope
- Cache frequently accessed papers locally

## 🚨 Common Issues and Solutions

### Search Issues
- **No results**: Try broader keywords or remove restrictive filters
- **Too many results**: Add more specific filters (author, venue, year)
- **Duplicate results**: The system automatically deduplicates, but some may remain

### Analysis Issues
- **PDF access denied**: Try the arXiv version if available
- **Incomplete extraction**: Some publishers block automated access
- **Large content**: Reduce `max_content_length` for faster processing

## 📊 Expected Response Formats

### Search Response
```json
{
  "page": 1,
  "page_size": 20,
  "has_more": true,
  "items": [
    {
      "title": "Paper Title",
      "authors": ["Author 1", "Author 2"],
      "venue": "Conference/Journal Name",
      "year": 2023,
      "doi": "10.1000/example",
      "arxiv_id": "2301.00001",
      "primary_url": "https://example.com",
      "oa_pdf_url": "https://example.com/paper.pdf",
      "citation_count": 42,
      "source": "openalex"
    }
  ]
}
```

### Analysis Response
```json
{
  "title": "Paper Title",
  "authors": ["Author 1", "Author 2"],
  "abstract": "Paper abstract...",
  "content": "Full or partial content...",
  "url": "https://example.com",
  "type": "arxiv",
  "metadata": {
    "arxiv_id": "2301.00001",
    "published": "2023-01-01",
    "categories": ["cs.AI", "cs.LG"]
  }
}
```

These examples should help you get started with using Paper MCP for your research needs!