/**
 * ============================================================
 * tools.ts — AI Agent Tool Implementations
 * ============================================================
 * Handles tool calls from Claude during agent execution.
 * 
 * FOUR TOOL CATEGORIES:
 * 
 * 🟢 Web tools (search, scrape) — powered by Perplexity
 *    A search-native AI model that returns grounded, cited results
 *    in a single API call.
 * 
 * 🟣 Apollo.io tools (enrich, search) — powered by Apollo.io API
 *    Sales intelligence platform for contact/company enrichment,
 *    email finding, and people search.
 * 
 * 🟡 ZeroBounce tools (validate, guess format) — powered by ZeroBounce API
 *    Email verification and validation service. Checks deliverability,
 *    detects disposable/catch-all emails, and guesses email formats.
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
const PERPLEXITY_MODEL = 'sonar';  // Fast, search-optimized model
const APOLLO_BASE_URL = 'https://api.apollo.io';
const ZEROBOUNCE_BASE_URL = 'https://api.zerobounce.net/v2';

// External API keys: user-provided (per-request) takes priority over env var
let _apolloApiKey = Deno.env.get('APOLLO_API_KEY') || '';
let _zerobounceApiKey = Deno.env.get('ZEROBOUNCE_API_KEY') || '';

// =============================================================
// CACHED LIST ENTRIES
// =============================================================
// When apolloGetListEntries fetches data, it stores the full dataset
// here so handleChat can construct bulk_write without Claude having
// to enumerate every entry (which fails at scale).

interface CachedListEntries {
  listName: string;
  type: 'contacts' | 'accounts';
  entries: Array<Record<string, string>>;
  totalCount: number;
}

let _cachedListEntries: CachedListEntries | null = null;

/**
 * Returns and clears the cached list entries from the last
 * apolloGetListEntries call. Used by handleChat to construct
 * bulk_write responses for large datasets.
 */
export function getCachedListEntries(): CachedListEntries | null {
  const result = _cachedListEntries;
  _cachedListEntries = null;
  return result;
}

/**
 * Sets the Apollo API key for the current request.
 */
export function setApolloApiKey(key: string) {
  if (key) _apolloApiKey = key;
}

function getApolloApiKey(): string {
  return _apolloApiKey;
}

/**
 * Sets the ZeroBounce API key for the current request.
 */
export function setZerobounceApiKey(key: string) {
  if (key) _zerobounceApiKey = key;
}

function getZerobounceApiKey(): string {
  return _zerobounceApiKey;
}

/**
 * Helper: makes an authenticated Apollo.io API request (POST).
 * Uses both header and body auth for maximum compatibility.
 */
async function apolloRequest(endpoint: string, body: Record<string, any>): Promise<any> {
  const apiKey = getApolloApiKey();
  if (!apiKey) {
    throw new Error('Apollo.io API key not configured. Add it in Settings or set APOLLO_API_KEY secret.');
  }
  
  body.api_key = apiKey;
  
  const response = await fetch(`${APOLLO_BASE_URL}${endpoint}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-cache',
      'X-Api-Key': apiKey,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Apollo API error (${response.status}): ${errText}`);
  }

  return response.json();
}

/**
 * Helper: makes an authenticated Apollo.io PUT request.
 * Used for updating existing records (e.g. adding labels).
 */
async function apolloRequestPut(endpoint: string, body: Record<string, any>): Promise<any> {
  const apiKey = getApolloApiKey();
  if (!apiKey) {
    throw new Error('Apollo.io API key not configured.');
  }
  
  body.api_key = apiKey;
  
  const response = await fetch(`${APOLLO_BASE_URL}${endpoint}`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-cache',
      'X-Api-Key': apiKey,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Apollo API error (${response.status}): ${errText}`);
  }

  return response.json();
}

/**
 * Helper: strips a URL to a bare domain.
 * "https://www.circuithub.com/about" → "circuithub.com"
 */
function stripToDomain(input: string): string {
  if (!input) return input;
  let domain = input.trim();
  // Remove protocol
  domain = domain.replace(/^https?:\/\//, '');
  // Remove www.
  domain = domain.replace(/^www\./, '');
  // Remove path/query
  domain = domain.split('/')[0].split('?')[0].split('#')[0];
  return domain.toLowerCase();
}

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
      case 'apollo_get_lists':
        return await apolloGetLists(input);
      case 'apollo_get_list_entries':
        return await apolloGetListEntries(input);
      case 'apollo_create_list':
        return await apolloCreateList(input);
      case 'apollo_add_contact_to_list':
        return await apolloAddContactToList(input);
      case 'apollo_add_account_to_list':
        return await apolloAddAccountToList(input);

      // 🟡 ZeroBounce tools
      case 'zerobounce_validate':
        return await zerobounceValidate(input.email);
      case 'zerobounce_batch_validate':
        return await zerobounceBatchValidate(input.emails);
      case 'zerobounce_guess_format':
        return await zerobounceGuessFormat(input.domain, input.first_name, input.last_name);
      case 'zerobounce_credits':
        return await zerobounceGetCredits();

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
 * Helper: Reveals a person by ID via Apollo.io /v1/people/match.
 * The search endpoint returns obfuscated data. This "reveals" the
 * full profile including email, phone, last name, etc.
 */
async function apolloRevealPerson(personId: string): Promise<any | null> {
  try {
    const data = await apolloRequest('/v1/people/match', {
      id: personId,
      reveal_personal_emails: true,
    });
    return data.person || null;
  } catch (e) {
    console.error('Apollo reveal error:', e.message);
    return null;
  }
}

/**
 * Helper: Formats a fully-revealed Apollo person into readable text.
 */
function formatApolloPerson(person: any): string {
  const fields: string[] = [];
  if (person.name) fields.push(`Name: ${person.name}`);
  if (person.title) fields.push(`Title: ${person.title}`);
  if (person.headline) fields.push(`Headline: ${person.headline}`);
  if (person.email) {
    let emailLine = `Email: ${person.email}`;
    if (person.email_status) emailLine += ` (${person.email_status})`;
    fields.push(emailLine);
  }
  if (person.phone_numbers?.length > 0) {
    fields.push(`Phone: ${person.phone_numbers.map((p: any) => p.sanitized_number || p.raw_number).join(', ')}`);
  }
  if (person.linkedin_url) fields.push(`LinkedIn: ${person.linkedin_url}`);
  if (person.city) fields.push(`Location: ${[person.city, person.state, person.country].filter(Boolean).join(', ')}`);

  const org = person.organization;
  if (org) {
    fields.push('');
    fields.push(`Company: ${org.name || 'Unknown'}`);
    if (org.website_url) fields.push(`Website: ${org.website_url}`);
    if (org.industry) fields.push(`Industry: ${org.industry}`);
    if (org.estimated_num_employees) fields.push(`Employees: ${org.estimated_num_employees}`);
  }

  if (person.seniority) fields.push(`Seniority: ${person.seniority}`);
  if (person.departments?.length > 0) fields.push(`Department: ${person.departments.join(', ')}`);

  return fields.join('\n') || 'Person found but no details available.';
}

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
  if (!getApolloApiKey()) {
    return 'Apollo.io unavailable: No API key configured. Add your Apollo API key in the sidebar Settings.';
  }

  let firstName = input.first_name || '';
  let lastName = input.last_name || '';
  if (!firstName && !lastName && input.name) {
    const parts = input.name.trim().split(/\s+/);
    firstName = parts[0] || '';
    lastName = parts.slice(1).join(' ') || '';
  }

  const body: Record<string, any> = {};
  if (firstName) body.first_name = firstName;
  if (lastName) body.last_name = lastName;
  if (input.email) body.email = input.email;
  if (input.organization_name) body.organization_name = input.organization_name;
  if (input.domain) body.domain = stripToDomain(input.domain);
  if (input.linkedin_url) body.linkedin_url = input.linkedin_url;

  try {
    const data = await apolloRequest('/v1/people/match', body);
    const person = data.person;
    if (!person) return 'No matching person found in Apollo.io.';
    return formatApolloPerson(person);
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
  if (!getApolloApiKey()) {
    return 'Apollo.io unavailable: No API key configured. Add your Apollo API key in the sidebar Settings.';
  }

  const body: Record<string, any> = {};
  if (input.domain) body.domain = stripToDomain(input.domain);
  if (input.name && !input.domain) body.domain = stripToDomain(input.name);

  try {
    const data = await apolloRequest('/v1/organizations/enrich', body);
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
 * Searches for people via Apollo.io using the NEW api_search endpoint.
 * Two-step process:
 * 1. Search with filters → get obfuscated results with person IDs
 * 2. Reveal top matches → get full details (email, phone, name)
 * 
 * This is the correct way to find "CEO of Tesla" — search with title
 * filters, then reveal the match to get their email.
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
  pull_all?: boolean;  // If true, auto-paginate and cache ALL results (no enrichment credits)
}): Promise<string> {
  if (!getApolloApiKey()) {
    return 'Apollo.io unavailable: No API key configured. Add your Apollo API key in the sidebar Settings.';
  }

  const perPage = Math.min(input.per_page || 3, 100);
  // Detect bulk pull mode: either explicit pull_all flag, or high per_page (>=25)
  const isBulkPull = input.pull_all === true || perPage >= 25;

  const baseBody: Record<string, any> = {
    per_page: perPage,
  };

  if (input.person_titles) baseBody.person_titles = input.person_titles;
  if (input.organization_domains) baseBody.q_organization_domains = input.organization_domains.map(stripToDomain).join('\n');
  if (input.organization_names) baseBody.organization_names = input.organization_names;
  if (input.person_locations) baseBody.person_locations = input.person_locations;
  if (input.person_seniorities) baseBody.person_seniorities = input.person_seniorities;
  if (input.contact_email_status) baseBody.contact_email_status = input.contact_email_status;
  if (input.q_keywords) baseBody.q_keywords = input.q_keywords;

  try {
    if (isBulkPull) {
      // ===== BULK PULL MODE =====
      // Auto-paginate through ALL results, extract basic info (no reveal/enrichment credits used),
      // cache the full dataset for bulk_write.
      const MAX_ENTRIES = 10000;
      const TIME_LIMIT_MS = 120_000;
      const startTime = Date.now();
      const allEntries: Array<Record<string, string>> = [];
      let totalCount = 0;
      let page = 1;
      let timedOut = false;

      while (allEntries.length < MAX_ENTRIES) {
        if (Date.now() - startTime > TIME_LIMIT_MS) { timedOut = true; break; }

        const data = await apolloRequest('/api/v1/mixed_people/api_search', {
          ...baseBody,
          per_page: 100,  // Always max per page for bulk
          page,
        });

        const people = data.people || [];
        if (page === 1) {
          totalCount = data.total_entries || data.pagination?.total_entries || 0;
        }

        if (people.length === 0) break;

        for (const p of people) {
          allEntries.push({
            name: [p.first_name, p.last_name].filter(Boolean).join(' ') || 'Unknown',
            first_name: p.first_name || '',
            last_name: p.last_name || '',
            title: p.title || '',
            company: p.organization?.name || '',
            domain: p.organization?.primary_domain || '',
            linkedin: p.linkedin_url || '',
            // Note: email is obfuscated in search results — no credits used
            email: p.email || '',
          });
        }

        if (people.length < 100) break;
        page++;
      }

      if (allEntries.length === 0) {
        return 'No people found matching the search criteria.';
      }

      // Cache for bulk_write (same mechanism as apolloGetListEntries)
      const companyLabel = input.organization_domains?.[0] || input.organization_names?.[0] || 'search';
      _cachedListEntries = {
        listName: `search_${companyLabel}`,
        type: 'contacts',
        entries: allEntries,
        totalCount: totalCount || allEntries.length,
      };

      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      let summary = `✅ Fetched ALL ${allEntries.length} contacts`;
      if (timedOut) {
        summary += ` (${allEntries.length} of ${totalCount} before time limit)`;
      } else if (totalCount > allEntries.length) {
        summary += ` (${totalCount} total, capped at ${MAX_ENTRIES})`;
      }
      summary += ` in ${elapsed}s.\n\n`;

      // Show first 5 samples
      const sampleCount = Math.min(5, allEntries.length);
      summary += `Sample contacts (${sampleCount} of ${allEntries.length}):\n`;
      for (let i = 0; i < sampleCount; i++) {
        const e = allEntries[i];
        summary += `• ${e.name}`;
        if (e.title) summary += ` — ${e.title}`;
        if (e.linkedin) summary += ` | LinkedIn: ${e.linkedin}`;
        summary += '\n';
      }

      summary += `\nAvailable fields: name, first_name, last_name, title, company, domain, linkedin, email`;
      summary += `\n\n[Dataset cached — respond with bulk_write using source: "apollo_search" and a fields mapping to write all ${allEntries.length} entries to the sheet]`;

      return summary;
    }

    // ===== TARGETED SEARCH MODE =====
    // Small per_page (1-24): search + reveal for full details including verified email
    const data = await apolloRequest('/api/v1/mixed_people/api_search', { ...baseBody, page: input.page || 1 });
    const people = data.people || [];
    const totalCount = data.total_entries || data.pagination?.total_entries || people.length;

    if (people.length === 0) {
      return 'No people found matching the search criteria.';
    }

    // Reveal matches to get full details (email, phone, full name)
    const revealLimit = Math.min(people.length, perPage);
    let result = `Found ${totalCount} matching people. Showing ${revealLimit} with full details:\n\n`;

    for (let i = 0; i < revealLimit; i++) {
      const searchResult = people[i];
      const personId = searchResult.id;

      if (personId) {
        const revealed = await apolloRevealPerson(personId);
        if (revealed) {
          result += formatApolloPerson(revealed) + '\n---\n';
          continue;
        }
      }

      // Fallback: show obfuscated search result
      const parts: string[] = [];
      parts.push(`• ${searchResult.first_name || ''} ${searchResult.last_name_obfuscated || searchResult.last_name || ''}`);
      if (searchResult.title) parts.push(`  Title: ${searchResult.title}`);
      if (searchResult.organization?.name) parts.push(`  Company: ${searchResult.organization.name}`);
      parts.push(`  (Full details unavailable — could not reveal contact)`);
      result += parts.join('\n') + '\n\n';
    }

    return truncateResult(result, 4000);
  } catch (e) {
    return `Apollo search error: ${e.message}`;
  }
}

/**
 * Finds a person's email via Apollo.io. Specialized wrapper:
 * If name is known → direct match via /v1/people/match
 * If only title + company → search + reveal
 */
async function apolloFindEmail(input: {
  first_name?: string;
  last_name?: string;
  name?: string;
  title?: string;
  organization_name?: string;
  domain?: string;
  linkedin_url?: string;
}): Promise<string> {
  if (!getApolloApiKey()) {
    return 'Apollo.io unavailable: No API key configured. Add your Apollo API key in the sidebar Settings.';
  }

  let firstName = input.first_name || '';
  let lastName = input.last_name || '';
  if (!firstName && !lastName && input.name) {
    const parts = input.name.trim().split(/\s+/);
    firstName = parts[0] || '';
    lastName = parts.slice(1).join(' ') || '';
  }

  // If we have a name, use direct match (faster, more precise)
  if (firstName && lastName) {
    const body: Record<string, any> = {
      first_name: firstName,
      last_name: lastName,
      reveal_personal_emails: true,
    };
    if (input.organization_name) body.organization_name = input.organization_name;
    if (input.domain) body.domain = stripToDomain(input.domain);
    if (input.linkedin_url) body.linkedin_url = input.linkedin_url;

    try {
      const data = await apolloRequest('/v1/people/match', body);
      const person = data.person;

      if (!person) {
        return `No email found for ${firstName} ${lastName} at ${input.organization_name || input.domain || 'unknown company'}.`;
      }

      if (person.email) {
        let result = person.email;
        if (person.email_status) result += ` (${person.email_status})`;
        if (person.title) result += `\nTitle: ${person.title}`;
        if (person.name) result += `\nName: ${person.name}`;
        if (person.organization?.name) result += `\nCompany: ${person.organization.name}`;
        return result;
      }

      return `Person found (${person.name || 'Unknown'}) but no email available.`;
    } catch (e) {
      return `Apollo find email error: ${e.message}`;
    }
  }

  // If we only have title + company (e.g. "find CEO email at tesla.com"),
  // use search + reveal
  if (input.title && (input.domain || input.organization_name)) {
    const searchBody: Record<string, any> = {
      person_titles: [input.title],
      per_page: 1,
    };
    if (input.domain) searchBody.q_organization_domains = stripToDomain(input.domain);
    if (input.organization_name) searchBody.organization_names = [input.organization_name];

    try {
      const searchData = await apolloRequest('/api/v1/mixed_people/api_search', searchBody);
      const people = searchData.people || [];

      if (people.length === 0) {
        return `No ${input.title} found at ${input.domain || input.organization_name}.`;
      }

      const revealed = await apolloRevealPerson(people[0].id);
      if (revealed && revealed.email) {
        let result = revealed.email;
        if (revealed.email_status) result += ` (${revealed.email_status})`;
        if (revealed.name) result += `\nName: ${revealed.name}`;
        if (revealed.title) result += `\nTitle: ${revealed.title}`;
        if (revealed.organization?.name) result += `\nCompany: ${revealed.organization.name}`;
        return result;
      }

      return revealed
        ? `Found ${revealed.name || 'someone'} (${revealed.title || input.title}) but no email available.`
        : `Found a match but could not retrieve full details.`;
    } catch (e) {
      return `Apollo find email error: ${e.message}`;
    }
  }

  return 'Not enough information to find email. Provide either (name + company) or (title + company domain).';
}

// =============================================================
// APOLLO.IO LIST MANAGEMENT TOOLS
// =============================================================

/**
 * Fetches saved lists (labels) from Apollo.io.
 * Supports optional search filter to find lists by name.
 * Without a search term, returns all lists (may be truncated if >100).
 */
async function apolloGetLists(input?: { search?: string }): Promise<string> {
  if (!getApolloApiKey()) {
    return 'Apollo.io unavailable: No API key configured. Add your Apollo API key in the sidebar Settings.';
  }

  try {
    const response = await fetch(`${APOLLO_BASE_URL}/api/v1/labels`, {
      headers: {
        'X-Api-Key': getApolloApiKey(),
        'Cache-Control': 'no-cache',
      },
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Apollo API error (${response.status}): ${errText}`);
    }

    let labels: any[] = await response.json();

    if (!labels || labels.length === 0) {
      return 'No lists found in your Apollo account.';
    }

    // Filter by search term if provided (case-insensitive partial match)
    const searchTerm = input?.search?.toLowerCase();
    if (searchTerm) {
      labels = labels.filter((l: any) => 
        l.name?.toLowerCase().includes(searchTerm)
      );

      if (labels.length === 0) {
        return `No lists found matching "${input!.search}". Try a shorter/different search term.`;
      }
    }

    const contactLists = labels.filter((l: any) => l.modality === 'contacts');
    const accountLists = labels.filter((l: any) => l.modality === 'accounts');

    let result = searchTerm
      ? `Found ${labels.length} list(s) matching "${input!.search}":\n\n`
      : `Total lists: ${labels.length}\n\n`;

    if (accountLists.length > 0) {
      result += `🏢 Account Lists (${accountLists.length}):\n`;
      for (const l of accountLists) {
        result += `  • "${l.name}" — ${l.cached_count || 0} accounts (ID: ${l.id})\n`;
      }
    }

    if (contactLists.length > 0) {
      result += `\n📋 Contact Lists (${contactLists.length}):\n`;
      for (const l of contactLists) {
        result += `  • "${l.name}" — ${l.cached_count || 0} contacts (ID: ${l.id})\n`;
      }
    }

    return result || 'No lists found.';
  } catch (e) {
    return `Apollo get lists error: ${e.message}`;
  }
}

/**
 * Helper: finds an Apollo list (label) by name.
 * Returns { id, name, modality, cached_count } or null.
 */
async function apolloFindListByName(listName: string): Promise<any | null> {
  const response = await fetch(`${APOLLO_BASE_URL}/api/v1/labels`, {
    headers: {
      'X-Api-Key': getApolloApiKey(),
      'Cache-Control': 'no-cache',
    },
  });

  if (!response.ok) return null;

  const labels: any[] = await response.json();
  const searchLower = listName.toLowerCase();

  // Try exact match first
  let match = labels.find((l: any) => l.name?.toLowerCase() === searchLower);
  // Fall back to partial match
  if (!match) {
    match = labels.find((l: any) => l.name?.toLowerCase().includes(searchLower));
  }
  return match || null;
}

/**
 * Fetches ALL entries (accounts or contacts) FROM an Apollo list.
 * Auto-paginates through all pages (100 per page, up to 10,000 entries).
 * Uses a time-based safety cutoff (120s) to stay within Edge Function limits.
 * 
 * The full dataset is cached in _cachedListEntries so that handleChat
 * can construct bulk_write responses without Claude having to enumerate
 * every entry (which fails at scale with 255+ entries).
 * 
 * Returns a compact SUMMARY to Claude (count + 5 samples), not the
 * full dataset. Claude then produces a lightweight bulk_write block
 * specifying column→field mapping, and the server fills in the rows.
 */
async function apolloGetListEntries(input: {
  list_name: string;
  page?: number;
  per_page?: number;
}): Promise<string> {
  if (!getApolloApiKey()) {
    return 'Apollo.io unavailable: No API key configured.';
  }

  try {
    // Step 1: Find the list by name
    const list = await apolloFindListByName(input.list_name);
    if (!list) {
      return `List "${input.list_name}" not found. Use apollo_get_lists with a search term to find it.`;
    }

    const PER_PAGE = 100;    // Apollo max per page
    const MAX_ENTRIES = 10000; // Support up to 10K entries
    const TIME_LIMIT_MS = 120_000; // 120s safety cutoff (Edge Function limit ~150s)
    const startTime = Date.now();
    const allEntries: Array<Record<string, string>> = [];
    let totalEntries = 0;
    let page = 1;
    let timedOut = false;

    // Step 2: Auto-paginate through ALL pages with time-based safety
    if (list.modality === 'accounts') {
      while (allEntries.length < MAX_ENTRIES) {
        if (Date.now() - startTime > TIME_LIMIT_MS) { timedOut = true; break; }

        const data = await apolloRequest('/v1/accounts/search', {
          label_ids: [list.id],
          per_page: PER_PAGE,
          page,
        });

        const accounts = data.accounts || [];
        if (page === 1) {
          totalEntries = data.pagination?.total_entries || 0;
        }

        if (accounts.length === 0) break;

        for (const a of accounts) {
          allEntries.push({
            name: a.name || 'Unknown',
            domain: a.primary_domain || a.domain || (a.website_url ? stripToDomain(a.website_url) : ''),
            website: a.website_url || '',
            industry: a.industry || '',
            employees: String(a.estimated_num_employees || ''),
          });
        }

        if (accounts.length < PER_PAGE) break;
        page++;
      }
    } else {
      // Contacts list
      while (allEntries.length < MAX_ENTRIES) {
        if (Date.now() - startTime > TIME_LIMIT_MS) { timedOut = true; break; }

        const data = await apolloRequest('/api/v1/mixed_people/api_search', {
          label_ids: [list.id],
          per_page: PER_PAGE,
          page,
        });

        const people = data.people || [];
        if (page === 1) {
          totalEntries = data.pagination?.total_entries || 0;
        }

        if (people.length === 0) break;

        for (const p of people) {
          allEntries.push({
            name: [p.first_name, p.last_name].filter(Boolean).join(' ') || 'Unknown',
            email: p.email || '',
            title: p.title || '',
            company: p.organization?.name || '',
            domain: p.organization?.primary_domain || '',
            linkedin: p.linkedin_url || '',
          });
        }

        if (people.length < PER_PAGE) break;
        page++;
      }
    }

    const fetchedCount = allEntries.length;
    const total = totalEntries || fetchedCount;
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

    if (fetchedCount === 0) {
      return `List "${list.name}" exists but has no entries.`;
    }

    // Step 3: Cache the FULL dataset for handleChat to use in bulk_write
    _cachedListEntries = {
      listName: list.name,
      type: list.modality as 'contacts' | 'accounts',
      entries: allEntries,
      totalCount: total,
    };

    // Step 4: Return a compact SUMMARY to Claude (not all entries)
    const typeLabel = list.modality === 'accounts' ? 'companies' : 'contacts';
    let summary = `✅ Fetched ${fetchedCount} ${typeLabel} from list "${list.name}"`;
    if (timedOut) {
      summary += ` (fetched ${fetchedCount} of ${total} before time limit — the rest can be fetched in a follow-up)`;
    } else if (total > fetchedCount) {
      summary += ` (${total} total in list, capped at ${MAX_ENTRIES})`;
    }
    summary += ` in ${elapsed}s.\n\n`;

    // Show first 5 as samples
    const sampleCount = Math.min(5, fetchedCount);
    summary += `Sample entries (${sampleCount} of ${fetchedCount}):\n`;
    for (let i = 0; i < sampleCount; i++) {
      const e = allEntries[i];
      if (list.modality === 'accounts') {
        summary += `• ${e.name} — ${e.domain || 'no domain'}`;
        if (e.industry) summary += ` | ${e.industry}`;
        summary += '\n';
      } else {
        summary += `• ${e.name}`;
        if (e.email) summary += ` — ${e.email}`;
        if (e.title) summary += ` (${e.title})`;
        if (e.company) summary += ` at ${e.company}`;
        summary += '\n';
      }
    }

    // Available fields for Claude's reference
    if (list.modality === 'accounts') {
      summary += `\nAvailable fields: name, domain, website, industry, employees`;
    } else {
      summary += `\nAvailable fields: name, email, title, company, domain, linkedin`;
    }
    summary += `\n\n[Dataset cached — respond with bulk_write using source: "apollo_list" and a fields mapping to write all ${fetchedCount} entries to the sheet]`;

    return summary;
  } catch (e) {
    return `Apollo get list entries error: ${e.message}`;
  }
}

/**
 * Creates a new list (label) in Apollo.io.
 * Can be a contacts list or an accounts list.
 */
async function apolloCreateList(input: {
  name: string;
  type?: string; // "contacts" or "accounts"
}): Promise<string> {
  if (!getApolloApiKey()) {
    return 'Apollo.io unavailable: No API key configured.';
  }

  const modality = input.type === 'accounts' ? 'accounts' : 'contacts';

  try {
    const data = await apolloRequest('/api/v1/labels', {
      name: input.name,
      modality: modality,
    });

    const label = data.label;
    if (!label) {
      return `Failed to create list "${input.name}".`;
    }

    return `✅ Created ${modality} list: "${label.name}" (ID: ${label.id})`;
  } catch (e) {
    return `Apollo create list error: ${e.message}`;
  }
}

/**
 * Adds a contact (person) to an Apollo list.
 * Creates the contact in the user's CRM if it doesn't exist.
 * Requires at minimum: first_name, last_name, email.
 */
async function apolloAddContactToList(input: {
  list_name: string;
  first_name: string;
  last_name: string;
  email?: string;
  title?: string;
  organization_name?: string;
  domain?: string;
  linkedin_url?: string;
  phone?: string;
}): Promise<string> {
  if (!getApolloApiKey()) {
    return 'Apollo.io unavailable: No API key configured.';
  }

  const body: Record<string, any> = {
    first_name: input.first_name,
    last_name: input.last_name,
    label_names: [input.list_name],
  };

  if (input.email) body.email = input.email;
  if (input.title) body.title = input.title;
  if (input.organization_name) body.organization_name = input.organization_name;
  if (input.domain) {
    const d = stripToDomain(input.domain);
    body.website_url = `https://${d}`;
  }
  if (input.linkedin_url) body.linkedin_url = input.linkedin_url;
  if (input.phone) body.phone_numbers = [{ raw_number: input.phone }];

  try {
    const data = await apolloRequest('/v1/contacts', body);
    const contact = data.contact;

    if (!contact) {
      return `Failed to add ${input.first_name} ${input.last_name} to list "${input.list_name}".`;
    }

    const fields: string[] = [];
    fields.push(`✅ Added to list "${input.list_name}"`);
    fields.push(`Name: ${contact.name || `${input.first_name} ${input.last_name}`}`);
    if (contact.email) fields.push(`Email: ${contact.email}`);
    if (contact.title) fields.push(`Title: ${contact.title}`);
    if (contact.organization_name) fields.push(`Company: ${contact.organization_name}`);
    fields.push(`Apollo Contact ID: ${contact.id}`);

    return fields.join('\n');
  } catch (e) {
    // Handle duplicate - the contact might already exist
    if (e.message?.includes('422') || e.message?.includes('already exists')) {
      return `Contact ${input.first_name} ${input.last_name} may already exist in your CRM. Try updating the existing contact instead.`;
    }
    return `Apollo add contact error: ${e.message}`;
  }
}

/**
 * Adds a company (account) to an Apollo list.
 * 
 * TWO-STEP PROCESS (Apollo doesn't apply labels during creation):
 * 1. Create/upsert the account using the domain → Apollo auto-enriches
 *    it against their database, matching to the real company record.
 * 2. Update the account to assign it to the list (label).
 * 
 * The domain/website URL is the source of truth — it tells Apollo
 * which company record to match against (e.g. "circuithub.com" → CircuitHub).
 */
async function apolloAddAccountToList(input: {
  list_name: string;
  name: string;
  domain?: string;
  phone?: string;
}): Promise<string> {
  if (!getApolloApiKey()) {
    return 'Apollo.io unavailable: No API key configured.';
  }

  // Strip URL to bare domain for Apollo matching
  const domain = input.domain ? stripToDomain(input.domain) : undefined;

  // Step 1: Create/find the account — Apollo auto-enriches from domain
  const createBody: Record<string, any> = {
    name: input.name,
  };
  if (domain) createBody.domain = domain;
  if (input.phone) createBody.phone = input.phone;

  try {
    const data = await apolloRequest('/v1/accounts', createBody);
    const account = data.account;

    if (!account) {
      return `Failed to create account for ${input.name}. Apollo returned no account record.`;
    }

    // Step 2: Update the account to assign the list label
    // (Apollo ignores label_names in the create call for accounts)
    try {
      await apolloRequestPut(`/v1/accounts/${account.id}`, {
        label_names: [input.list_name],
      });
    } catch (updateErr) {
      // Account was created but label assignment failed
      return `Account "${account.name}" created (ID: ${account.id}) but failed to add to list "${input.list_name}": ${updateErr.message}`;
    }

    const fields: string[] = [];
    fields.push(`✅ Added "${account.name}" to list "${input.list_name}"`);
    if (account.primary_domain || account.domain) fields.push(`Domain: ${account.primary_domain || account.domain}`);
    if (account.website_url) fields.push(`Website: ${account.website_url}`);
    if (account.industry) fields.push(`Industry: ${account.industry}`);
    if (account.estimated_num_employees) fields.push(`Employees: ${account.estimated_num_employees}`);
    if (account.founded_year) fields.push(`Founded: ${account.founded_year}`);
    if (account.linkedin_url) fields.push(`LinkedIn: ${account.linkedin_url}`);
    fields.push(`Apollo Account ID: ${account.id}`);

    return fields.join('\n');
  } catch (e) {
    return `Apollo add account error: ${e.message}`;
  }
}

// =============================================================
// ZEROBOUNCE TOOLS
// =============================================================

/**
 * Validates a single email address via ZeroBounce.
 * Returns deliverability status, SMTP provider, domain age, etc.
 */
async function zerobounceValidate(email: string): Promise<string> {
  const apiKey = getZerobounceApiKey();
  if (!apiKey) {
    return 'ZeroBounce unavailable: No API key configured. Add your ZeroBounce API key in the sidebar Settings.';
  }

  try {
    const url = `${ZEROBOUNCE_BASE_URL}/validate?api_key=${encodeURIComponent(apiKey)}&email=${encodeURIComponent(email)}`;
    const response = await fetch(url);

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`ZeroBounce API error (${response.status}): ${errText}`);
    }

    const data = await response.json();

    const fields: string[] = [];
    fields.push(`Email: ${data.address}`);
    fields.push(`Status: ${data.status}`);
    if (data.sub_status) fields.push(`Sub-status: ${data.sub_status}`);
    fields.push(`Free email: ${data.free_email ? 'Yes' : 'No'}`);
    if (data.smtp_provider) fields.push(`SMTP Provider: ${data.smtp_provider}`);
    if (data.mx_found === 'true') fields.push(`MX Record: ${data.mx_record}`);
    if (data.domain_age_days) fields.push(`Domain Age: ${data.domain_age_days} days`);
    if (data.did_you_mean) fields.push(`Did you mean: ${data.did_you_mean}`);
    if (data.firstname) fields.push(`First Name: ${data.firstname}`);
    if (data.lastname) fields.push(`Last Name: ${data.lastname}`);
    if (data.city) fields.push(`Location: ${[data.city, data.region, data.country].filter(Boolean).join(', ')}`);

    return fields.join('\n');
  } catch (e) {
    return `ZeroBounce validate error: ${e.message}`;
  }
}

/**
 * Validates multiple email addresses in a single call.
 * ZeroBounce batch endpoint supports up to 100 emails.
 */
async function zerobounceBatchValidate(emails: string[]): Promise<string> {
  const apiKey = getZerobounceApiKey();
  if (!apiKey) {
    return 'ZeroBounce unavailable: No API key configured. Add your ZeroBounce API key in the sidebar Settings.';
  }

  if (!emails || emails.length === 0) {
    return 'No emails provided for validation.';
  }

  // For small batches, validate one by one (simpler, no file upload needed)
  if (emails.length <= 10) {
    const results: string[] = [];
    for (const email of emails) {
      const result = await zerobounceValidate(email);
      results.push(result);
      results.push('---');
    }
    return results.join('\n');
  }

  // For larger batches, use the batch endpoint
  try {
    const emailBatch = emails.slice(0, 100).map(e => ({ email_address: e }));
    const url = `${ZEROBOUNCE_BASE_URL}/validatebatch`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: apiKey,
        email_batch: emailBatch,
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`ZeroBounce batch API error (${response.status}): ${errText}`);
    }

    const data = await response.json();
    const emailResults = data.email_batch || [];
    let result = `Validated ${emailResults.length} emails:\n\n`;

    for (const item of emailResults) {
      result += `• ${item.address}: ${item.status}`;
      if (item.sub_status) result += ` (${item.sub_status})`;
      if (item.free_email) result += ' [free]';
      result += '\n';
    }

    if (data.errors?.length > 0) {
      result += `\nErrors: ${data.errors.map((e: any) => `${e.email_address}: ${e.error}`).join(', ')}`;
    }

    return truncateResult(result, 4000);
  } catch (e) {
    return `ZeroBounce batch validate error: ${e.message}`;
  }
}

/**
 * Guesses the email format for a domain (e.g. first.last@domain.com).
 * Optionally, if first_name and last_name are provided, returns the
 * probable email address for that person.
 */
async function zerobounceGuessFormat(domain: string, firstName?: string, lastName?: string): Promise<string> {
  const apiKey = getZerobounceApiKey();
  if (!apiKey) {
    return 'ZeroBounce unavailable: No API key configured. Add your ZeroBounce API key in the sidebar Settings.';
  }

  try {
    let url = `${ZEROBOUNCE_BASE_URL}/guessformat?api_key=${encodeURIComponent(apiKey)}&domain=${encodeURIComponent(domain)}`;
    if (firstName) url += `&first_name=${encodeURIComponent(firstName)}`;
    if (lastName) url += `&last_name=${encodeURIComponent(lastName)}`;

    const response = await fetch(url);

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`ZeroBounce API error (${response.status}): ${errText}`);
    }

    const data = await response.json();

    if (data.failure_reason) {
      return `Could not determine email format for ${domain}: ${data.failure_reason}`;
    }

    const fields: string[] = [];
    fields.push(`Domain: ${data.domain}`);
    if (data.company_name) fields.push(`Company: ${data.company_name}`);
    fields.push(`Primary Format: ${data.format} (${data.confidence} confidence)`);

    if (data.other_domain_formats?.length > 0) {
      const altFormats = data.other_domain_formats
        .slice(0, 5)
        .map((f: any) => `${f.format} (${f.confidence})`)
        .join(', ');
      fields.push(`Other Formats: ${altFormats}`);
    }

    // If name was provided, construct the probable email
    if (firstName && lastName && data.format) {
      const email = buildEmailFromFormat(data.format, firstName.toLowerCase(), lastName.toLowerCase(), domain);
      if (email) {
        fields.push(`\nProbable Email: ${email}`);
      }
    }

    return fields.join('\n');
  } catch (e) {
    return `ZeroBounce guess format error: ${e.message}`;
  }
}

/**
 * Helper: builds an email from a format pattern and name parts.
 */
function buildEmailFromFormat(format: string, first: string, last: string, domain: string): string | null {
  const f = first.charAt(0); // first initial
  const l = last.charAt(0);  // last initial
  const patterns: Record<string, string> = {
    'first.last': `${first}.${last}`,
    'first': first,
    'last': last,
    'firstlast': `${first}${last}`,
    'lastfirst': `${last}${first}`,
    'first.l': `${first}.${l}`,
    'f.last': `${f}.${last}`,
    'firstl': `${first}${l}`,
    'lfirst': `${l}${first}`,
    'last.first': `${last}.${first}`,
    'first_last': `${first}_${last}`,
    'last.f': `${last}.${f}`,
    'flast': `${f}${last}`,
    'lastf': `${last}${f}`,
  };

  const local = patterns[format];
  return local ? `${local}@${domain}` : null;
}

/**
 * Gets remaining ZeroBounce API credits.
 */
async function zerobounceGetCredits(): Promise<string> {
  const apiKey = getZerobounceApiKey();
  if (!apiKey) {
    return 'ZeroBounce unavailable: No API key configured.';
  }

  try {
    const url = `${ZEROBOUNCE_BASE_URL}/getcredits?api_key=${encodeURIComponent(apiKey)}`;
    const response = await fetch(url);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const data = await response.json();
    return `ZeroBounce credits remaining: ${data.Credits}`;
  } catch (e) {
    return `ZeroBounce credits check error: ${e.message}`;
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
