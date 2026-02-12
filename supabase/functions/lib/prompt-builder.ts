/**
 * ============================================================
 * prompt-builder.ts — Prompt Assembly Engine
 * ============================================================
 * Builds structured prompts for the AI agent based on:
 * - Agent configuration (system prompt, tools, format)
 * - Sheet context (headers, column analysis)
 * - Row-specific data (input values, per-row instructions)
 * 
 * The agent uses FOUR tool categories:
 * - 🔵 Claude: reasoning, planning, analysis, writing
 * - 🟢 Perplexity: web search, scraping, live data lookup
 * - 🟣 Apollo.io: contact/company enrichment, email finding, people search
 * - 🟡 ZeroBounce: email validation, deliverability check, email format guessing
 * 
 * The chat prompt instructs Claude to announce which tool/model
 * will handle each step, so the user sees the routing.
 */

import type { AgentConfig, SheetContext, RowData } from './types.ts';

// =============================================================
// SYSTEM PROMPTS
// =============================================================

const BASE_SYSTEM_PROMPT = `You are an AI agent operating inside a Google Sheets sidebar. Your job is to process spreadsheet data row by row, performing research, analysis, or enrichment tasks as instructed by the user.

CORE PRINCIPLES:
- Be concise. Users want dense, actionable output — not essays.
- Be accurate. If you can't find information, say so clearly. Never fabricate.
- Follow the output format exactly. If the user wants "1-2 sentences", give 1-2 sentences.
- Each row is independent. Don't reference other rows unless explicitly asked.

AVAILABLE CONTEXT:
- You receive the sheet's column headers and structure.
- You receive the current row's data across all input columns.
- You may receive a per-row instruction that overrides the default task.

AVAILABLE TOOL CATEGORIES:
- 🟢 Perplexity web tools: web_search, web_scrape, web_research — for live web lookups, finding websites, news, general research
- 🟣 Apollo.io tools: apollo_enrich_person, apollo_enrich_company, apollo_search_people, apollo_find_email — for B2B contact/company data, email finding, professional enrichment
- 🟣 Apollo.io list tools: apollo_get_lists, apollo_create_list, apollo_add_contact_to_list, apollo_add_account_to_list — for pushing leads/companies into Apollo saved lists
- 🟡 ZeroBounce tools: zerobounce_validate, zerobounce_batch_validate, zerobounce_guess_format — for email verification, deliverability checks, email format detection
- 🔵 Claude (you): reasoning, analysis, summarization, writing, data transformation — no tool call needed`;

const CHAT_SYSTEM_PROMPT = `You are an AI agent builder embedded in a Google Sheets sidebar. You help users create agents that process their spreadsheet data row by row.

You can see the user's active sheet structure — headers, column types, sample data, and which rows need processing.

YOU HAVE FOUR TOOL CATEGORIES:
- **🔵 Claude** (you) — reasoning, analysis, summarization, writing, classification, data transformation
- **🟢 Perplexity** — web search, finding URLs, live data lookup, general web research, news, anything requiring fresh internet data
- **🟣 Apollo.io** — B2B sales intelligence: contact enrichment (name → email, phone, title, LinkedIn), company enrichment (domain → industry, size, revenue, funding, tech stack), people search (find decision-makers by title/company/location), email finding, AND list management (get lists, create lists, add contacts/companies to lists)
- **🟡 ZeroBounce** — email verification and validation: checks if emails are deliverable (valid/invalid/catch-all/disposable), detects email format patterns for domains, and can construct probable emails from name + domain

TOOL ROUTING RULES:
- Need contact/company enrichment data (emails, phones, titles, company details)? → Use 🟣 Apollo tools
- Need to verify/validate email addresses? → Use 🟡 ZeroBounce tools
- Need to guess someone's email from name + domain? → Use 🟡 ZeroBounce guess_format, then validate the result
- Need general web data (websites, news, reviews, pricing)? → Use 🟢 Perplexity tools
- Need analysis, writing, classification, formatting? → 🔵 Claude handles it directly
- Need BOTH enrichment + validation? → Chain them: "🟣 Apollo will find the email, then 🟡 ZeroBounce will verify it's deliverable"
- If data could come from either Apollo or web search, prefer Apollo for B2B data (more structured, faster) and Perplexity for general info

CRITICAL RULES:
- BE DECISIVE. When the user tells you what they want, BUILD THE AGENT IMMEDIATELY.
- ALWAYS mention which tool(s)/model(s) will be used and why. Example: "I'll use 🟣 Apollo.io to enrich each contact since we need professional email addresses and titles."
- If a task needs Apollo.io enrichment → set tools to include "apollo_enrich_person", "apollo_enrich_company", "apollo_search_people", or "apollo_find_email"
- If a task needs to push leads/companies to Apollo lists → set tools to include "apollo_get_lists", "apollo_create_list", "apollo_add_contact_to_list", or "apollo_add_account_to_list"
- If a task needs email validation → set tools to include "zerobounce_validate" or "zerobounce_batch_validate"
- If a task needs to guess/construct emails from names → set tools to include "zerobounce_guess_format"
- If a task needs web data → set tools to include "search" and/or "web_scrape" (these use Perplexity under the hood)
- If a task is pure analysis/writing → set tools to []
- If the user's intent is clear (e.g. "find emails for these contacts"), just do it.
- If a column doesn't exist yet for output, pick the next empty column letter.
- NEVER ask unnecessary follow-up questions. Just act.
- Keep responses SHORT. 2-3 sentences + model routing note, then the agent_config block.
- Reference the actual data you can see (column names, sample values, row counts).

DEFAULTS (use these unless the user specifies otherwise):
- Output format: concise, 1-2 sentences or a single value
- Skip completed rows: true
- Status column: next column after output

When you're ready (which should usually be your FIRST response), include this JSON block:
\`\`\`agent_config
{
  "action": "start_run",
  "name": "Agent Name",
  "systemPrompt": "...",
  "defaultInstruction": "...",
  "inputColumns": ["A"],
  "outputColumn": "B",
  "statusColumn": "C",
  "outputFormat": "concise",
  "tools": ["apollo_enrich_person", "search"],
  "skipCompleted": true
}
\`\`\`

TOOL NAME REFERENCE:
- Perplexity web tools: "search", "web_scrape", "web_research"
- Apollo.io enrichment tools: "apollo_enrich_person", "apollo_enrich_company", "apollo_search_people", "apollo_find_email"
- Apollo.io list tools: "apollo_get_lists", "apollo_create_list", "apollo_add_contact_to_list", "apollo_add_account_to_list"
- ZeroBounce tools: "zerobounce_validate", "zerobounce_batch_validate", "zerobounce_guess_format", "zerobounce_credits"

IMPORTANT: Include the agent_config block as soon as the user's intent is clear. Do not wait for multiple rounds of confirmation.`;

// =============================================================
// PROMPT BUILDERS
// =============================================================

/**
 * Builds the system prompt for the chat/planning phase.
 * This is used when the user is talking to the sidebar to configure an agent.
 */
export function buildChatPrompt(sheetContext: SheetContext): string {
  let prompt = CHAT_SYSTEM_PROMPT;

  prompt += '\n\n--- CURRENT SHEET CONTEXT ---\n';
  prompt += `Sheet: "${sheetContext.sheetName}" (${sheetContext.rowCount} rows, ${sheetContext.columnCount} columns)\n\n`;

  // Column descriptions
  prompt += 'COLUMNS:\n';
  for (const col of sheetContext.columns || []) {
    let role = '';
    if (col.looksLikeOutput) role = ' [LIKELY OUTPUT]';
    else if (col.looksLikeStatus) role = ' [LIKELY STATUS]';
    else if (col.looksLikeInstruction) role = ' [LIKELY INSTRUCTION]';
    else if (col.fillRate > 50) role = ' [INPUT]';

    prompt += `  ${col.letter} — "${col.name}" (${col.type}, ${col.fillRate}% filled)${role}\n`;
    if (col.sampleValues && col.sampleValues.length > 0) {
      prompt += `    Samples: ${col.sampleValues.slice(0, 3).join(', ')}\n`;
    }
  }

  // Processing summary
  if (sheetContext.emptyOutputRows && sheetContext.emptyOutputRows.count > 0) {
    prompt += `\nROWS TO PROCESS: ${sheetContext.emptyOutputRows.count} rows have input data but no output yet.\n`;
  }

  return prompt;
}

/**
 * Builds the prompt for processing a single row.
 * This is the per-row prompt sent to Claude during an agent run.
 */
export function buildRowPrompt(
  config: AgentConfig,
  row: RowData,
  sheetContext: SheetContext
): { system: string; user: string } {
  // System prompt
  let system = config.systemPrompt || BASE_SYSTEM_PROMPT;
  
  // Add model routing context
  const hasWebTools = (config.tools || []).some(t => ['search', 'web_scrape', 'web_research'].includes(t));
  const hasApolloTools = (config.tools || []).some(t => t.startsWith('apollo_'));
  const hasZerobounceTools = (config.tools || []).some(t => t.startsWith('zerobounce_'));
  
  if (hasWebTools || hasApolloTools || hasZerobounceTools) {
    system += '\n\nMODEL ROUTING:';
    if (hasWebTools) {
      system += '\n- 🟢 Perplexity web tools available: Use web_search or web_scrape for live web information. Returns accurate, cited results.';
    }
    if (hasApolloTools) {
      system += '\n- 🟣 Apollo.io tools available. Returns structured B2B data (emails, titles, phone numbers, company details).';
      system += '\n\nAPOLLO.io BEST PRACTICES:';
      system += '\n- **Find CEO/CTO/specific role email**: Use apollo_find_email with title + domain. Example: apollo_find_email({ title: "CEO", domain: "tesla.com" }) → searches filtered to CEO, reveals full profile with email.';
      system += '\n- **Alternative for role search**: apollo_search_people with person_titles + organization_domains + per_page:1. This searches then auto-reveals top match with email.';
      system += '\n- **Enrich known person**: apollo_enrich_person({ first_name: "Elon", last_name: "Musk", domain: "tesla.com" })';
      system += '\n- **Enrich company**: apollo_enrich_company({ domain: "tesla.com" })';
      system += '\n- Always use company DOMAIN when available (more precise than company name).';
      system += '\n- NEVER enumerate all employees. Always use title/seniority filters to find specific roles.';
      system += '\n- **Push to Apollo list**: apollo_add_contact_to_list({ list_name: "My List", first_name, last_name, email, title, organization_name }) — creates contact in CRM + adds to list';
      system += '\n- **Push company to list**: apollo_add_account_to_list({ list_name: "My List", name: "Tesla", domain: "tesla.com" })';
      system += '\n- **Get existing lists**: apollo_get_lists() — shows all contact and account lists with IDs';
      system += '\n- **Create new list**: apollo_create_list({ name: "My New List", type: "contacts" })';
    }
    if (hasZerobounceTools) {
      system += '\n- 🟡 ZeroBounce tools available. Validates email deliverability and guesses email format patterns.';
      system += '\n\nZEROBOUNCE BEST PRACTICES:';
      system += '\n- **Validate an email**: zerobounce_validate({ email: "john@company.com" }) → returns status: valid/invalid/catch-all/unknown';
      system += '\n- **Guess email format for a domain**: zerobounce_guess_format({ domain: "tesla.com" }) → returns pattern like "first.last"';
      system += '\n- **Construct + validate**: zerobounce_guess_format({ domain: "tesla.com", first_name: "elon", last_name: "musk" }) → returns probable email, then validate it';
      system += '\n- Use ZeroBounce AFTER finding emails (from Apollo or elsewhere) to verify deliverability before outputting.';
      system += '\n- Status meanings: "valid" = safe to send, "invalid" = bounce, "catch-all" = domain accepts all (unverifiable), "do_not_mail" = disposable/role-based';
    }
    if (hasWebTools && hasApolloTools) {
      system += '\n- Use Apollo.io for structured B2B data (contact info, company firmographics). Use Perplexity for general web info (news, articles, reviews, pricing).';
    }
    if (hasApolloTools && hasZerobounceTools) {
      system += '\n- POWERFUL COMBO: Use 🟣 Apollo to find contacts/emails, then 🟡 ZeroBounce to verify deliverability. Report both the email and its validation status.';
    }
  }

  system += '\n\nOUTPUT CONSTRAINTS:';
  if (config.outputFormat) {
    system += `\n- Format: ${config.outputFormat}`;
  }
  system += '\n- Return ONLY the output value. No preamble, no explanation, no markdown.';
  system += '\n- If you cannot find the information, respond with "Not found" and a brief reason.';

  // User prompt (row-specific)
  let user = '';

  // Add input data
  const inputCols = config.inputColumns || [];
  const headers = sheetContext.headers || [];
  
  for (const colLetter of inputCols) {
    const header = headers.find(h => h.letter === colLetter);
    const value = row[colLetter] || row[header?.name || ''];
    if (value) {
      user += `${header?.name || colLetter}: ${value}\n`;
    }
  }

  // Add instruction
  const instruction = row._instruction || config.defaultInstruction || 'Research this entity';
  user += `\nTask: ${instruction}`;

  return { system, user };
}

/**
 * Builds tool definitions based on agent config.
 * These are passed to the Claude API as tool schemas.
 * Web tools (search, scrape, research) are powered by Perplexity under the hood.
 */
export function buildToolDefinitions(config: AgentConfig): any[] {
  const tools: any[] = [];
  const enabledTools = config.tools || ['search'];

  if (enabledTools.includes('web_scrape')) {
    tools.push({
      name: 'web_scrape',
      description: 'Fetch and extract content from a specific URL. Powered by Perplexity — returns intelligent, structured extraction rather than raw HTML. Use for visiting company websites, reading articles, or extracting data from known URLs.',
      input_schema: {
        type: 'object',
        properties: {
          url: {
            type: 'string',
            description: 'The URL to scrape',
          },
          extract: {
            type: 'string',
            description: 'What specific information to extract from the page',
          },
        },
        required: ['url'],
      },
    });
  }

  if (enabledTools.includes('search')) {
    tools.push({
      name: 'web_search',
      description: 'Search the web for information. Powered by Perplexity — returns search-grounded answers with citations in a single call. Use for finding websites, company info, news, funding data, contact details, or any live web data.',
      input_schema: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'The search query. Be specific — include company name, what you\'re looking for, etc.',
          },
        },
        required: ['query'],
      },
    });
  }

  if (enabledTools.includes('web_research')) {
    tools.push({
      name: 'web_research',
      description: 'Deep web research on a topic. Powered by Perplexity — synthesizes multiple sources into a comprehensive answer. Use for complex research questions that need multiple data points.',
      input_schema: {
        type: 'object',
        properties: {
          question: {
            type: 'string',
            description: 'The research question to investigate',
          },
          context: {
            type: 'string',
            description: 'Optional context about what you already know or what angle to research',
          },
        },
        required: ['question'],
      },
    });
  }

  if (enabledTools.includes('extract')) {
    tools.push({
      name: 'extract_data',
      description: 'Extract structured data from text. Use this to pull specific fields like company size, funding amount, technology stack, etc.',
      input_schema: {
        type: 'object',
        properties: {
          text: {
            type: 'string',
            description: 'The text to extract from',
          },
          fields: {
            type: 'array',
            items: { type: 'string' },
            description: 'The specific fields to extract',
          },
        },
        required: ['text', 'fields'],
      },
    });
  }

  // ---- 🟣 APOLLO.IO TOOLS ----

  if (enabledTools.includes('apollo_enrich_person')) {
    tools.push({
      name: 'apollo_enrich_person',
      description: 'Enrich a person using Apollo.io. Given a name + company/domain/email, returns their full professional profile: title, email, phone, LinkedIn URL, location, seniority, and company details. Best for B2B contact enrichment.',
      input_schema: {
        type: 'object',
        properties: {
          first_name: {
            type: 'string',
            description: 'Person\'s first name',
          },
          last_name: {
            type: 'string',
            description: 'Person\'s last name',
          },
          name: {
            type: 'string',
            description: 'Full name (alternative to first_name + last_name)',
          },
          email: {
            type: 'string',
            description: 'Known email address (helps with matching)',
          },
          organization_name: {
            type: 'string',
            description: 'Company name the person works at',
          },
          domain: {
            type: 'string',
            description: 'Company website domain (e.g. "apollo.io")',
          },
          linkedin_url: {
            type: 'string',
            description: 'LinkedIn profile URL',
          },
        },
        required: [],
      },
    });
  }

  if (enabledTools.includes('apollo_enrich_company')) {
    tools.push({
      name: 'apollo_enrich_company',
      description: 'Enrich a company using Apollo.io. Given a domain or company name, returns detailed company data: industry, employee count, annual revenue, total funding, funding stage, tech stack, headquarters location, social links, and description.',
      input_schema: {
        type: 'object',
        properties: {
          domain: {
            type: 'string',
            description: 'Company website domain (e.g. "apollo.io"). Preferred over name.',
          },
          name: {
            type: 'string',
            description: 'Company name (used if domain is not available)',
          },
        },
        required: [],
      },
    });
  }

  if (enabledTools.includes('apollo_search_people')) {
    tools.push({
      name: 'apollo_search_people',
      description: 'Search for people in Apollo.io\'s database using FILTERS, then automatically reveals top matches to get full details (email, phone, name). This is the best way to find a specific role at a company (e.g. "find the CEO of Tesla"). ALWAYS use person_titles + organization_domains filters to narrow results. Set per_page to 1 when looking for one specific role. Returns full professional profiles with verified emails.',
      input_schema: {
        type: 'object',
        properties: {
          person_titles: {
            type: 'array',
            items: { type: 'string' },
            description: 'REQUIRED for role searches. Job titles to filter by (e.g. ["CEO"], ["CTO", "Chief Technology Officer"], ["VP Sales", "Vice President of Sales"])',
          },
          organization_domains: {
            type: 'array',
            items: { type: 'string' },
            description: 'Company domains to search within (e.g. ["tesla.com"]). Preferred over organization_names.',
          },
          organization_names: {
            type: 'array',
            items: { type: 'string' },
            description: 'Company names to search within (use if domain is not available)',
          },
          person_locations: {
            type: 'array',
            items: { type: 'string' },
            description: 'Locations to filter by (e.g. ["San Francisco", "United States"])',
          },
          person_seniorities: {
            type: 'array',
            items: { type: 'string' },
            description: 'Seniority filter. Values: "c_suite", "vp", "director", "manager", "senior", "entry". Use "c_suite" for CEO/CTO/CFO/COO searches.',
          },
          q_keywords: {
            type: 'string',
            description: 'Keywords to search for in the person\'s profile',
          },
          per_page: {
            type: 'number',
            description: 'Number of results to return. Use 1-3 for specific role lookups, up to 25 for broad searches. Default: 3.',
          },
        },
        required: [],
      },
    });
  }

  if (enabledTools.includes('apollo_find_email')) {
    tools.push({
      name: 'apollo_find_email',
      description: 'Find a person\'s professional email address using Apollo.io. Two modes: (1) Provide name + company/domain for direct lookup. (2) Provide title + company domain to search-and-reveal (e.g. "find the CEO\'s email at tesla.com"). Returns verified work email.',
      input_schema: {
        type: 'object',
        properties: {
          first_name: {
            type: 'string',
            description: 'Person\'s first name (for direct lookup)',
          },
          last_name: {
            type: 'string',
            description: 'Person\'s last name (for direct lookup)',
          },
          name: {
            type: 'string',
            description: 'Full name (alternative to first_name + last_name)',
          },
          title: {
            type: 'string',
            description: 'Job title to search for (e.g. "CEO", "CTO"). Use when you don\'t know the person\'s name but know their role.',
          },
          organization_name: {
            type: 'string',
            description: 'Company name',
          },
          domain: {
            type: 'string',
            description: 'Company domain (e.g. "tesla.com"). Preferred over organization_name.',
          },
          linkedin_url: {
            type: 'string',
            description: 'LinkedIn profile URL (helps with matching)',
          },
        },
        required: [],
      },
    });
  }

  // ---- 🟣 APOLLO.IO LIST MANAGEMENT TOOLS ----

  if (enabledTools.includes('apollo_get_lists')) {
    tools.push({
      name: 'apollo_get_lists',
      description: 'Get all saved lists from your Apollo.io account. Returns both contact lists and account lists with their names, IDs, and counts. Use this to find existing lists before adding contacts/companies.',
      input_schema: {
        type: 'object',
        properties: {},
        required: [],
      },
    });
  }

  if (enabledTools.includes('apollo_create_list')) {
    tools.push({
      name: 'apollo_create_list',
      description: 'Create a new list in Apollo.io. Use type "contacts" for people lists or "accounts" for company lists. The list can then be used to add contacts or companies to.',
      input_schema: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: 'Name for the new list (e.g. "Q1 2026 Outreach Targets")',
          },
          type: {
            type: 'string',
            enum: ['contacts', 'accounts'],
            description: 'Type of list: "contacts" for people, "accounts" for companies. Default: contacts.',
          },
        },
        required: ['name'],
      },
    });
  }

  if (enabledTools.includes('apollo_add_contact_to_list')) {
    tools.push({
      name: 'apollo_add_contact_to_list',
      description: 'Add a person/contact to an Apollo.io list. Creates the contact in your CRM and adds them to the specified list. Provide the list name (not ID). If the list doesn\'t exist, use apollo_create_list first.',
      input_schema: {
        type: 'object',
        properties: {
          list_name: {
            type: 'string',
            description: 'The exact name of the Apollo list to add the contact to',
          },
          first_name: {
            type: 'string',
            description: 'Contact\'s first name',
          },
          last_name: {
            type: 'string',
            description: 'Contact\'s last name',
          },
          email: {
            type: 'string',
            description: 'Contact\'s email address',
          },
          title: {
            type: 'string',
            description: 'Contact\'s job title',
          },
          organization_name: {
            type: 'string',
            description: 'Contact\'s company name',
          },
          domain: {
            type: 'string',
            description: 'Company domain (e.g. "tesla.com")',
          },
          linkedin_url: {
            type: 'string',
            description: 'Contact\'s LinkedIn profile URL',
          },
          phone: {
            type: 'string',
            description: 'Contact\'s phone number',
          },
        },
        required: ['list_name', 'first_name', 'last_name'],
      },
    });
  }

  if (enabledTools.includes('apollo_add_account_to_list')) {
    tools.push({
      name: 'apollo_add_account_to_list',
      description: 'Add a company/account to an Apollo.io list. Creates the account in your CRM and adds it to the specified list. Provide the list name (not ID). If the list doesn\'t exist, use apollo_create_list first.',
      input_schema: {
        type: 'object',
        properties: {
          list_name: {
            type: 'string',
            description: 'The exact name of the Apollo list to add the company to',
          },
          name: {
            type: 'string',
            description: 'Company name',
          },
          domain: {
            type: 'string',
            description: 'Company domain (e.g. "tesla.com")',
          },
          phone: {
            type: 'string',
            description: 'Company phone number',
          },
        },
        required: ['list_name', 'name'],
      },
    });
  }

  // ---- 🟡 ZEROBOUNCE TOOLS ----

  if (enabledTools.includes('zerobounce_validate')) {
    tools.push({
      name: 'zerobounce_validate',
      description: 'Validate a single email address using ZeroBounce. Returns deliverability status (valid/invalid/catch-all/abuse/do_not_mail/spamtrap/unknown), SMTP provider, MX records, domain age, and whether it\'s a free email service. Use this to verify an email is real and deliverable before sending.',
      input_schema: {
        type: 'object',
        properties: {
          email: {
            type: 'string',
            description: 'The email address to validate (e.g. "john@company.com")',
          },
        },
        required: ['email'],
      },
    });
  }

  if (enabledTools.includes('zerobounce_batch_validate')) {
    tools.push({
      name: 'zerobounce_batch_validate',
      description: 'Validate multiple email addresses at once using ZeroBounce. Accepts up to 100 emails and returns deliverability status for each. More efficient than validating one at a time for large lists.',
      input_schema: {
        type: 'object',
        properties: {
          emails: {
            type: 'array',
            items: { type: 'string' },
            description: 'Array of email addresses to validate (max 100)',
          },
        },
        required: ['emails'],
      },
    });
  }

  if (enabledTools.includes('zerobounce_guess_format')) {
    tools.push({
      name: 'zerobounce_guess_format',
      description: 'Guess the email format pattern for a domain using ZeroBounce (e.g. "first.last@domain.com"). Optionally provide first_name and last_name to get the probable email address for a specific person. Great for constructing email addresses when you know someone\'s name and company domain.',
      input_schema: {
        type: 'object',
        properties: {
          domain: {
            type: 'string',
            description: 'The company domain to check format for (e.g. "tesla.com")',
          },
          first_name: {
            type: 'string',
            description: 'First name to construct the probable email (optional)',
          },
          last_name: {
            type: 'string',
            description: 'Last name to construct the probable email (optional)',
          },
        },
        required: ['domain'],
      },
    });
  }

  if (enabledTools.includes('zerobounce_credits')) {
    tools.push({
      name: 'zerobounce_credits',
      description: 'Check remaining ZeroBounce API credits. Use this before large batch operations to ensure sufficient credits.',
      input_schema: {
        type: 'object',
        properties: {},
        required: [],
      },
    });
  }

  return tools;
}

/**
 * Parses the chat response to extract agent configuration.
 * Looks for ```agent_config JSON blocks in the response.
 */
export function parseAgentConfig(response: string): AgentConfig | null {
  const match = response.match(/```agent_config\s*\n?([\s\S]*?)```/);
  if (!match) return null;

  try {
    return JSON.parse(match[1]);
  } catch (e) {
    console.error('Failed to parse agent config:', e);
    return null;
  }
}

/**
 * Estimates the token cost for a row based on typical prompt sizes.
 * Used for pre-run cost estimates.
 */
export function estimateRowCost(config: AgentConfig): {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
} {
  const baseSystemTokens = 300;
  const configTokens = 100;
  const rowDataTokens = 50 * (config.inputColumns?.length || 2);
  const toolUseTokens = (config.tools || []).includes('search') ? 1500 : 500;
  
  const inputTokens = baseSystemTokens + configTokens + rowDataTokens + toolUseTokens;
  const outputTokens = 150;
  
  // Sonnet 4.5 pricing: $3/M input, $15/M output
  const costUsd = (inputTokens * 3 + outputTokens * 15) / 1_000_000;
  
  return { inputTokens, outputTokens, costUsd };
}
