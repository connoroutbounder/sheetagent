/**
 * ============================================================
 * tools.ts — AI Agent Tool Implementations
 * ============================================================
 * Handles tool calls from Claude during agent execution.
 * 
 * Web tools (search, scrape) are powered by Perplexity —
 * a search-native AI model that returns grounded, cited results
 * in a single API call. This replaces the old Serper + scraping
 * pipeline with something faster, cheaper, and more accurate.
 * 
 * Analysis tools stay in Claude (the orchestrator).
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

const PERPLEXITY_API_KEY = Deno.env.get('PERPLEXITY_API_KEY') || '';
const FIRECRAWL_API_KEY = Deno.env.get('FIRECRAWL_API_KEY') || '';
const PERPLEXITY_MODEL = 'sonar';  // Fast, search-optimized model

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
      case 'web_search':
        return await perplexitySearch(input.query);
      case 'web_scrape':
        return await perplexityScrape(input.url, input.extract);
      case 'web_research':
        return await perplexityResearch(input.question, input.context);
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
          content: truncateResult(content, 4000),
          is_error: content.startsWith('Tool error:'),
        };
      })
    );
    results.push(...batchResults);
  }

  return results;
}

// =============================================================
// PERPLEXITY-POWERED WEB TOOLS
// =============================================================

/**
 * Web search via Perplexity. Returns search-grounded answers
 * with citations in a single API call.
 */
async function perplexitySearch(query: string): Promise<string> {
  if (!PERPLEXITY_API_KEY) {
    return `Search unavailable: PERPLEXITY_API_KEY not configured. Query was: "${query}"`;
  }

  try {
    const response = await fetch('https://api.perplexity.ai/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${PERPLEXITY_API_KEY}`,
      },
      body: JSON.stringify({
        model: PERPLEXITY_MODEL,
        messages: [
          {
            role: 'system',
            content: 'You are a precise research assistant. Return factual, concise answers with source URLs. If looking for a website, return the exact URL.',
          },
          {
            role: 'user',
            content: query,
          },
        ],
        max_tokens: 500,
        return_citations: true,
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      return `Perplexity search error (${response.status}): ${errText}`;
    }

    const data = await response.json();
    let answer = data.choices?.[0]?.message?.content || 'No results found.';

    // Append citations if available
    if (data.citations && data.citations.length > 0) {
      answer += '\n\nSources:\n' + data.citations.map((c: string, i: number) => `[${i + 1}] ${c}`).join('\n');
    }

    return answer;
  } catch (e) {
    return `Search error: ${e.message}`;
  }
}

/**
 * Web scraping via Perplexity. Instead of fetching raw HTML,
 * we ask Perplexity to read and extract from a specific URL.
 */
async function perplexityScrape(url: string, extractHint?: string): Promise<string> {
  if (!url.startsWith('http')) {
    url = 'https://' + url;
  }

  // If Perplexity is available, use it for intelligent extraction
  if (PERPLEXITY_API_KEY) {
    const prompt = extractHint
      ? `Go to ${url} and extract the following: ${extractHint}. Be specific and factual.`
      : `Go to ${url} and summarize the main content. Include key facts, data, and any contact information.`;

    try {
      const response = await fetch('https://api.perplexity.ai/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${PERPLEXITY_API_KEY}`,
        },
        body: JSON.stringify({
          model: PERPLEXITY_MODEL,
          messages: [
            {
              role: 'system',
              content: 'You are a web scraping assistant. Extract and return the requested information from the given URL. Be precise and factual.',
            },
            { role: 'user', content: prompt },
          ],
          max_tokens: 1000,
          return_citations: true,
        }),
      });

      if (response.ok) {
        const data = await response.json();
        let answer = data.choices?.[0]?.message?.content || '';
        if (data.citations && data.citations.length > 0) {
          answer += '\n\nSources:\n' + data.citations.map((c: string, i: number) => `[${i + 1}] ${c}`).join('\n');
        }
        if (answer) return answer;
      }
    } catch (e) {
      console.warn('Perplexity scrape error, falling back:', e.message);
    }
  }

  // Fallback: basic fetch
  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; AgentBuilder/1.0)' },
      signal: AbortSignal.timeout(10000),
    });

    const html = await response.text();
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

/**
 * Deep web research via Perplexity. For complex questions that
 * need multiple search results synthesized into one answer.
 */
async function perplexityResearch(question: string, context?: string): Promise<string> {
  if (!PERPLEXITY_API_KEY) {
    return `Research unavailable: PERPLEXITY_API_KEY not configured. Question was: "${question}"`;
  }

  const messages: Array<{ role: string; content: string }> = [
    {
      role: 'system',
      content: 'You are a thorough research assistant. Provide comprehensive, well-sourced answers. Include specific data points, URLs, and citations.',
    },
  ];

  if (context) {
    messages.push({
      role: 'user',
      content: `Context: ${context}\n\nResearch question: ${question}`,
    });
  } else {
    messages.push({ role: 'user', content: question });
  }

  try {
    const response = await fetch('https://api.perplexity.ai/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${PERPLEXITY_API_KEY}`,
      },
      body: JSON.stringify({
        model: PERPLEXITY_MODEL,
        messages,
        max_tokens: 1500,
        return_citations: true,
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      return `Research error (${response.status}): ${errText}`;
    }

    const data = await response.json();
    let answer = data.choices?.[0]?.message?.content || 'No results found.';

    if (data.citations && data.citations.length > 0) {
      answer += '\n\nSources:\n' + data.citations.map((c: string, i: number) => `[${i + 1}] ${c}`).join('\n');
    }

    return answer;
  } catch (e) {
    return `Research error: ${e.message}`;
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
  const fieldList = fields.join(', ');
  return `Extract the following from the text below: ${fieldList}\n\n---\n${truncateResult(text, 3000)}`;
}

// =============================================================
// HELPERS
// =============================================================

/**
 * Truncates text to a maximum character count, preserving word boundaries.
 */
function truncateResult(text: string, maxChars: number): string {
  if (!text || text.length <= maxChars) return text;

  const truncated = text.substring(0, maxChars);
  const lastSpace = truncated.lastIndexOf(' ');

  return truncated.substring(0, lastSpace > maxChars * 0.8 ? lastSpace : maxChars) + '\n[...truncated]';
}
