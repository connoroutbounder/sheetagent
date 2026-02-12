/**
 * ============================================================
 * tools.ts — AI Agent Tool Implementations
 * ============================================================
 * Handles tool calls from Claude during agent execution.
 * Each tool maps to a real API: Firecrawl for scraping,
 * Serper for search, and built-in extraction logic.
 */

// =============================================================
// TYPES
// =============================================================

interface ToolCall {
  name: string;
  input: Record<string, any>;
}

interface ToolResult {
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}

// =============================================================
// ENVIRONMENT
// =============================================================

const FIRECRAWL_API_KEY = Deno.env.get('FIRECRAWL_API_KEY') || '';
const SERPER_API_KEY = Deno.env.get('SERPER_API_KEY') || '';
const FIRECRAWL_BASE_URL = 'https://api.firecrawl.dev/v1';
const SERPER_BASE_URL = 'https://google.serper.dev';

// =============================================================
// TOOL EXECUTOR
// =============================================================

/**
 * Routes a tool call to the appropriate handler.
 */
export async function executeTool(toolCall: ToolCall): Promise<string> {
  const { name, input } = toolCall;

  try {
    switch (name) {
      case 'web_scrape':
        return await webScrape(input.url, input.extract);
      case 'web_search':
        return await webSearch(input.query);
      case 'extract_data':
        return extractData(input.text, input.fields);
      default:
        return `Unknown tool: ${name}`;
    }
  } catch (error) {
    console.error(`Tool ${name} error:`, error);
    return `Tool error: ${error.message || 'Unknown error'}`;
  }
}

/**
 * Executes multiple tool calls from a Claude response.
 * Returns formatted tool results for the next API call.
 */
export async function executeToolCalls(
  toolCalls: Array<{ id: string; name: string; input: Record<string, any> }>
): Promise<ToolResult[]> {
  const results: ToolResult[] = [];

  // Execute tools in parallel (with concurrency limit)
  const CONCURRENCY = 3;
  for (let i = 0; i < toolCalls.length; i += CONCURRENCY) {
    const batch = toolCalls.slice(i, i + CONCURRENCY);
    const batchResults = await Promise.all(
      batch.map(async (call) => {
        const content = await executeTool({ name: call.name, input: call.input });
        return {
          tool_use_id: call.id,
          content: truncateResult(content, 4000), // Cap to prevent context overflow
          is_error: content.startsWith('Tool error:'),
        };
      })
    );
    results.push(...batchResults);
  }

  return results;
}

// =============================================================
// WEB SCRAPER (Firecrawl)
// =============================================================

/**
 * Scrapes a webpage and returns extracted content.
 * Uses Firecrawl for reliable rendering and extraction.
 * Falls back to basic fetch if Firecrawl is unavailable.
 */
async function webScrape(url: string, extractHint?: string): Promise<string> {
  // Normalize URL
  if (!url.startsWith('http')) {
    url = 'https://' + url;
  }

  // Try Firecrawl first
  if (FIRECRAWL_API_KEY) {
    try {
      const response = await fetch(`${FIRECRAWL_BASE_URL}/scrape`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${FIRECRAWL_API_KEY}`,
        },
        body: JSON.stringify({
          url,
          formats: ['markdown'],
          onlyMainContent: true,
          waitFor: 2000,
          timeout: 15000,
        }),
      });

      if (response.ok) {
        const data = await response.json();
        const markdown = data.data?.markdown || '';
        
        if (markdown) {
          // If there's an extraction hint, return relevant section
          if (extractHint) {
            return extractRelevantContent(markdown, extractHint);
          }
          return truncateResult(markdown, 6000);
        }
      }
    } catch (e) {
      console.warn('Firecrawl error, falling back:', e.message);
    }
  }

  // Fallback: basic fetch
  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; AgentBuilder/1.0)',
      },
      signal: AbortSignal.timeout(10000),
    });

    const html = await response.text();
    
    // Basic HTML to text extraction
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    return truncateResult(text, 4000);
  } catch (e) {
    return `Failed to scrape ${url}: ${e.message}`;
  }
}

// =============================================================
// WEB SEARCH (Serper)
// =============================================================

/**
 * Performs a web search and returns formatted results.
 */
async function webSearch(query: string): Promise<string> {
  if (!SERPER_API_KEY) {
    return `Search unavailable: SERPER_API_KEY not configured. Query was: "${query}"`;
  }

  try {
    const response = await fetch(`${SERPER_BASE_URL}/search`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-KEY': SERPER_API_KEY,
      },
      body: JSON.stringify({
        q: query,
        num: 5,
      }),
    });

    if (!response.ok) {
      return `Search API error: ${response.status}`;
    }

    const data = await response.json();
    const results: string[] = [];

    // Knowledge graph (if available)
    if (data.knowledgeGraph) {
      const kg = data.knowledgeGraph;
      results.push(`[Knowledge Graph] ${kg.title}: ${kg.description || ''}`);
      if (kg.attributes) {
        for (const [key, value] of Object.entries(kg.attributes)) {
          results.push(`  ${key}: ${value}`);
        }
      }
    }

    // Organic results
    if (data.organic) {
      for (const result of data.organic.slice(0, 5)) {
        results.push(`[${result.title}] (${result.link})\n${result.snippet || ''}`);
      }
    }

    // Answer box
    if (data.answerBox) {
      results.unshift(`[Direct Answer] ${data.answerBox.answer || data.answerBox.snippet || ''}`);
    }

    return results.join('\n\n') || 'No results found.';
  } catch (e) {
    return `Search error: ${e.message}`;
  }
}

// =============================================================
// DATA EXTRACTION
// =============================================================

/**
 * Extracts structured fields from text.
 * This is a prompt-based extraction — the AI agent calls this
 * to parse specific data points from scraped content.
 */
function extractData(text: string, fields: string[]): string {
  // For the extraction tool, we return the text with field hints
  // The actual extraction happens in the AI layer
  const fieldList = fields.join(', ');
  return `Extract the following from the text below: ${fieldList}\n\n---\n${truncateResult(text, 3000)}`;
}

// =============================================================
// HELPERS
// =============================================================

/**
 * Extracts the most relevant section of content based on a hint.
 */
function extractRelevantContent(text: string, hint: string): string {
  const keywords = hint.toLowerCase().split(/\s+/);
  const paragraphs = text.split(/\n\n+/);
  
  // Score each paragraph by keyword matches
  const scored = paragraphs.map((p, idx) => {
    const lower = p.toLowerCase();
    const score = keywords.reduce((sum, kw) => sum + (lower.includes(kw) ? 1 : 0), 0);
    return { text: p, score, idx };
  });

  // Sort by relevance, keep top sections
  scored.sort((a, b) => b.score - a.score);
  const relevant = scored.slice(0, 5).sort((a, b) => a.idx - b.idx);
  
  return relevant.map(r => r.text).join('\n\n');
}

/**
 * Truncates text to a maximum character count, preserving word boundaries.
 */
function truncateResult(text: string, maxChars: number): string {
  if (!text || text.length <= maxChars) return text;
  
  const truncated = text.substring(0, maxChars);
  const lastSpace = truncated.lastIndexOf(' ');
  
  return truncated.substring(0, lastSpace > maxChars * 0.8 ? lastSpace : maxChars) + '\n[...truncated]';
}
