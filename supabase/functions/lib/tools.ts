/**
 * ============================================================
 * tools.ts — AI Agent Tool Implementations
 * ============================================================
 * Handles tool calls from Claude during agent execution.
 * 
 * THREE TOOL CATEGORIES:
 * 
 * 🟢 Web tools (search, scrape) — powered by Perplexity
 *    A search-native AI model that returns grounded, cited results
 *    in a single API call.
 * 
 * 🟣 Apollo.io tools (enrich, search) — powered by Apollo.io API
 *    Sales intelligence platform for contact/company enrichment,
 *    email finding, and people search. First external API connector.
 * 
 * 🔵 Analysis tools (extract) — handled by Claude (the orchestrator)
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
const APOLLO_API_KEY = Deno.env.get('APOLLO_API_KEY') || '';
const PERPLEXITY_MODEL = 'sonar';  // Fast, search-optimized model
const APOLLO_BASE_URL = 'https://api.apollo.io';

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
      // 🟢 Perplexity web tools
      case 'web_search':
        return await perplexitySearch(input.query);
      case 'web_scrape':
        return await perplexityScrape(input.url, input.extract);
      case 'web_research':
        return await perplexityResearch(input.question, input.context);

      // 🟣 Apollo.io tools
      case 'apollo_enrich_person':
        return await apolloEnrichPerson(input);
      case 'apollo_enrich_company':
        return await apolloEnrichCompany(input);
      case 'apollo_search_people':
        return await apolloSearchPeople(input);
      case 'apollo_find_email':
        return await apolloFindEmail(input);

      // 🔵 Analysis tools
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
// APOLLO.IO TOOLS
// =============================================================

/**
 * Enriches a person via Apollo.io. Given name + company/domain/email,
 * returns full professional profile: title, email, phone, LinkedIn, etc.
 */
async function apolloEnrichPerson(input: {
  first_name?: string;
  last_name?: string;
  name?: string;
  email?: string;
  organization_name?: string;
  domain?: string;
  linkedin_url?: string;
}): Promise<string> {
  if (!APOLLO_API_KEY) {
    return 'Apollo.io unavailable: APOLLO_API_KEY not configured. Ask the user to add their Apollo API key in Settings.';
  }

  // Parse a full name into first/last if only "name" was provided
  let firstName = input.first_name || '';
  let lastName = input.last_name || '';
  if (!firstName && !lastName && input.name) {
    const parts = input.name.trim().split(/\s+/);
    firstName = parts[0] || '';
    lastName = parts.slice(1).join(' ') || '';
  }

  const body: Record<string, any> = { api_key: APOLLO_API_KEY };
  if (firstName) body.first_name = firstName;
  if (lastName) body.last_name = lastName;
  if (input.email) body.email = input.email;
  if (input.organization_name) body.organization_name = input.organization_name;
  if (input.domain) body.domain = input.domain;
  if (input.linkedin_url) body.linkedin_url = input.linkedin_url;

  try {
    const response = await fetch(`${APOLLO_BASE_URL}/v1/people/match`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errText = await response.text();
      return `Apollo API error (${response.status}): ${errText}`;
    }

    const data = await response.json();
    const person = data.person;

    if (!person) {
      return 'No matching person found in Apollo.io.';
    }

    // Format a clean, structured result
    const fields: string[] = [];
    if (person.name) fields.push(`Name: ${person.name}`);
    if (person.title) fields.push(`Title: ${person.title}`);
    if (person.headline) fields.push(`Headline: ${person.headline}`);
    if (person.email) fields.push(`Email: ${person.email}`);
    if (person.phone_numbers?.length > 0) {
      fields.push(`Phone: ${person.phone_numbers.map((p: any) => p.sanitized_number || p.raw_number).join(', ')}`);
    }
    if (person.linkedin_url) fields.push(`LinkedIn: ${person.linkedin_url}`);
    if (person.city) fields.push(`Location: ${[person.city, person.state, person.country].filter(Boolean).join(', ')}`);

    // Company info
    const org = person.organization;
    if (org) {
      fields.push('');
      fields.push(`Company: ${org.name || 'Unknown'}`);
      if (org.website_url) fields.push(`Website: ${org.website_url}`);
      if (org.industry) fields.push(`Industry: ${org.industry}`);
      if (org.estimated_num_employees) fields.push(`Employees: ${org.estimated_num_employees}`);
    }

    // Seniority & departments
    if (person.seniority) fields.push(`Seniority: ${person.seniority}`);
    if (person.departments?.length > 0) fields.push(`Department: ${person.departments.join(', ')}`);

    return fields.join('\n') || 'Person found but no details available.';
  } catch (e) {
    return `Apollo enrich person error: ${e.message}`;
  }
}

/**
 * Enriches a company via Apollo.io. Given domain or company name,
 * returns company details: industry, size, revenue, funding, tech stack, etc.
 */
async function apolloEnrichCompany(input: {
  domain?: string;
  name?: string;
}): Promise<string> {
  if (!APOLLO_API_KEY) {
    return 'Apollo.io unavailable: APOLLO_API_KEY not configured. Ask the user to add their Apollo API key in Settings.';
  }

  const body: Record<string, any> = { api_key: APOLLO_API_KEY };
  if (input.domain) body.domain = input.domain;
  if (input.name && !input.domain) body.domain = input.name; // Apollo prefers domain; try name as domain

  try {
    const response = await fetch(`${APOLLO_BASE_URL}/v1/organizations/enrich`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errText = await response.text();
      return `Apollo API error (${response.status}): ${errText}`;
    }

    const data = await response.json();
    const org = data.organization;

    if (!org) {
      return `No company found for "${input.domain || input.name}" in Apollo.io.`;
    }

    const fields: string[] = [];
    if (org.name) fields.push(`Company: ${org.name}`);
    if (org.website_url) fields.push(`Website: ${org.website_url}`);
    if (org.blog_url) fields.push(`Blog: ${org.blog_url}`);
    if (org.industry) fields.push(`Industry: ${org.industry}`);
    if (org.keywords?.length > 0) fields.push(`Keywords: ${org.keywords.slice(0, 8).join(', ')}`);
    if (org.estimated_num_employees) fields.push(`Employees: ${org.estimated_num_employees}`);
    if (org.annual_revenue_printed) fields.push(`Revenue: ${org.annual_revenue_printed}`);
    if (org.total_funding_printed) fields.push(`Total Funding: ${org.total_funding_printed}`);
    if (org.latest_funding_round_date) fields.push(`Latest Funding: ${org.latest_funding_round_date}`);
    if (org.latest_funding_stage) fields.push(`Funding Stage: ${org.latest_funding_stage}`);
    if (org.founded_year) fields.push(`Founded: ${org.founded_year}`);
    if (org.linkedin_url) fields.push(`LinkedIn: ${org.linkedin_url}`);
    if (org.twitter_url) fields.push(`Twitter: ${org.twitter_url}`);
    if (org.facebook_url) fields.push(`Facebook: ${org.facebook_url}`);
    if (org.phone) fields.push(`Phone: ${org.phone}`);
    if (org.city) fields.push(`HQ: ${[org.city, org.state, org.country].filter(Boolean).join(', ')}`);
    if (org.short_description) fields.push(`\nDescription: ${org.short_description}`);
    if (org.technologies?.length > 0) fields.push(`\nTech Stack: ${org.technologies.slice(0, 15).join(', ')}`);

    return fields.join('\n') || 'Company found but no details available.';
  } catch (e) {
    return `Apollo enrich company error: ${e.message}`;
  }
}

/**
 * Searches for people via Apollo.io. Find contacts matching specific criteria
 * like title, company, location, industry, etc.
 */
async function apolloSearchPeople(input: {
  person_titles?: string[];
  organization_domains?: string[];
  organization_names?: string[];
  person_locations?: string[];
  person_seniorities?: string[];
  contact_email_status?: string[];
  per_page?: number;
  page?: number;
  q_keywords?: string;
}): Promise<string> {
  if (!APOLLO_API_KEY) {
    return 'Apollo.io unavailable: APOLLO_API_KEY not configured. Ask the user to add their Apollo API key in Settings.';
  }

  const body: Record<string, any> = {
    api_key: APOLLO_API_KEY,
    page: input.page || 1,
    per_page: Math.min(input.per_page || 10, 25), // Cap at 25
  };

  if (input.person_titles) body.person_titles = input.person_titles;
  if (input.organization_domains) body.q_organization_domains = input.organization_domains.join('\n');
  if (input.organization_names) body.organization_names = input.organization_names;
  if (input.person_locations) body.person_locations = input.person_locations;
  if (input.person_seniorities) body.person_seniorities = input.person_seniorities;
  if (input.contact_email_status) body.contact_email_status = input.contact_email_status;
  if (input.q_keywords) body.q_keywords = input.q_keywords;

  try {
    const response = await fetch(`${APOLLO_BASE_URL}/api/v1/mixed_people/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errText = await response.text();
      return `Apollo API error (${response.status}): ${errText}`;
    }

    const data = await response.json();
    const people = data.people || [];
    const totalCount = data.pagination?.total_entries || people.length;

    if (people.length === 0) {
      return 'No people found matching the search criteria.';
    }

    let result = `Found ${totalCount} people (showing ${people.length}):\n\n`;

    for (const person of people) {
      const parts: string[] = [];
      parts.push(`• ${person.name || 'Unknown'}`);
      if (person.title) parts.push(`  Title: ${person.title}`);
      if (person.organization?.name) parts.push(`  Company: ${person.organization.name}`);
      if (person.email) parts.push(`  Email: ${person.email}`);
      if (person.city) parts.push(`  Location: ${[person.city, person.state, person.country].filter(Boolean).join(', ')}`);
      if (person.linkedin_url) parts.push(`  LinkedIn: ${person.linkedin_url}`);
      result += parts.join('\n') + '\n\n';
    }

    return truncateResult(result, 4000);
  } catch (e) {
    return `Apollo search error: ${e.message}`;
  }
}

/**
 * Finds a person's email via Apollo.io. Specialized wrapper around
 * people enrichment that focuses on email discovery.
 */
async function apolloFindEmail(input: {
  first_name?: string;
  last_name?: string;
  name?: string;
  organization_name?: string;
  domain?: string;
  linkedin_url?: string;
}): Promise<string> {
  if (!APOLLO_API_KEY) {
    return 'Apollo.io unavailable: APOLLO_API_KEY not configured. Ask the user to add their Apollo API key in Settings.';
  }

  // Parse name
  let firstName = input.first_name || '';
  let lastName = input.last_name || '';
  if (!firstName && !lastName && input.name) {
    const parts = input.name.trim().split(/\s+/);
    firstName = parts[0] || '';
    lastName = parts.slice(1).join(' ') || '';
  }

  const body: Record<string, any> = {
    api_key: APOLLO_API_KEY,
    reveal_personal_emails: false,
    reveal_phone_number: false,
  };
  if (firstName) body.first_name = firstName;
  if (lastName) body.last_name = lastName;
  if (input.organization_name) body.organization_name = input.organization_name;
  if (input.domain) body.domain = input.domain;
  if (input.linkedin_url) body.linkedin_url = input.linkedin_url;

  try {
    const response = await fetch(`${APOLLO_BASE_URL}/v1/people/match`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errText = await response.text();
      return `Apollo API error (${response.status}): ${errText}`;
    }

    const data = await response.json();
    const person = data.person;

    if (!person) {
      return `No email found for ${firstName} ${lastName} at ${input.organization_name || input.domain || 'unknown company'}.`;
    }

    if (person.email) {
      let result = person.email;
      if (person.email_status) result += ` (${person.email_status})`;
      if (person.title) result += `\nTitle: ${person.title}`;
      if (person.organization?.name) result += `\nCompany: ${person.organization.name}`;
      return result;
    }

    return `Person found (${person.name || 'Unknown'}) but no email available.`;
  } catch (e) {
    return `Apollo find email error: ${e.message}`;
  }
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
