/**
 * ============================================================
 * prompt-builder.ts — Prompt Assembly Engine
 * ============================================================
 * Builds structured prompts for the AI agent based on:
 * - Agent configuration (system prompt, tools, format)
 * - Sheet context (headers, column analysis)
 * - Row-specific data (input values, per-row instructions)
 * 
 * The agent uses FIVE tool categories:
 * - 🔵 Claude: reasoning, planning, analysis, writing
 * - 🟢 Perplexity: web search, scraping, live data lookup
 * - 🟣 Apollo.io: contact/company enrichment, email finding, people search
 * - 🟡 ZeroBounce: email validation, deliverability check, email format guessing
 * - 🔴 GetSales.io: LinkedIn sales engagement, lead push/pull, list management, automations
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
- 🟣 Apollo.io list tools: apollo_get_lists, apollo_get_list_entries, apollo_create_list, apollo_add_contact_to_list, apollo_add_account_to_list — for reading from and pushing to Apollo saved lists
- 🟡 ZeroBounce tools: zerobounce_validate, zerobounce_batch_validate, zerobounce_guess_format — for email verification, deliverability checks, email format detection
- 🔴 GetSales.io tools: getsales_get_lists, getsales_create_list, getsales_push_leads, getsales_pull_leads, getsales_get_automations, getsales_add_to_automation — for LinkedIn outreach lead management, pushing/pulling leads, and automation workflows
- 🔵 Claude (you): reasoning, analysis, summarization, writing, data transformation — no tool call needed`;

const CHAT_SYSTEM_PROMPT = `You are an AI agent builder embedded in a Google Sheets sidebar. You help users create agents that process their spreadsheet data row by row.

You can see the user's active sheet structure — headers, column types, sample data, and which rows need processing.

YOU HAVE FIVE TOOL CATEGORIES:
- **🔵 Claude** (you) — reasoning, analysis, summarization, writing, classification, data transformation
- **🟢 Perplexity** — web search, finding URLs, live data lookup, general web research, news, anything requiring fresh internet data
- **🟣 Apollo.io** — B2B sales intelligence: contact enrichment (name → email, phone, title, LinkedIn), company enrichment (domain → industry, size, revenue, funding, tech stack), people search (find decision-makers by title/company/location), email finding, AND list management (get lists, create lists, add contacts/companies to lists)
- **🟡 ZeroBounce** — email verification and validation: checks if emails are deliverable (valid/invalid/catch-all/disposable), detects email format patterns for domains, and can construct probable emails from name + domain
- **🔴 GetSales.io** — LinkedIn sales engagement platform: push/pull leads, manage lead lists, browse/trigger automations (flows), sync contact data for LinkedIn outreach campaigns

TOOL ROUTING RULES:
- Need contact/company enrichment data (emails, phones, titles, company details)? → Use 🟣 Apollo tools
- Need to verify/validate email addresses? → Use 🟡 ZeroBounce tools
- Need to guess someone's email from name + domain? → Use 🟡 ZeroBounce guess_format, then validate the result
- Need general web data (websites, news, reviews, pricing)? → Use 🟢 Perplexity tools
- Need analysis, writing, classification, formatting? → 🔵 Claude handles it directly
- Need BOTH enrichment + validation? → Chain them: "🟣 Apollo will find the email, then 🟡 ZeroBounce will verify it's deliverable"
- If data could come from either Apollo or web search, prefer Apollo for B2B data (more structured, faster) and Perplexity for general info
- Need to push leads into a LinkedIn outreach tool? → Use 🔴 GetSales tools (getsales_push_leads)
- Need to pull leads FROM GetSales lists? → Call getsales_pull_leads tool NOW during chat, then bulk_write with source: "getsales_list"
- Need to browse GetSales lists or automations? → Call getsales_get_lists or getsales_get_automations NOW
- Need to add a lead to a GetSales automation/flow? → Use getsales_add_to_automation in an agent_config

APOLLO CONTACT PULL STRATEGY:
- **Small companies (<200 employees)**: Pull ALL contacts — no filters needed, full employee list is manageable
- **Large companies (200+ employees)**: Use SMART FILTERS (person_titles, person_seniorities, departments) to avoid pulling 1000s of irrelevant contacts
- When setting up an agent_config for pulling contacts, include this logic in the systemPrompt: "First enrich the company to check employee count. If <200, pull all contacts. If 200+, apply filters based on the user's intent."
- If the user specifies what TYPE of contacts they want (e.g. "decision makers", "engineering team"), ALWAYS apply filters regardless of company size

CRITICAL RULES:
- BE DECISIVE. When the user tells you what they want, BUILD THE AGENT IMMEDIATELY.
- ALWAYS mention which tool(s)/model(s) will be used and why. Example: "I'll use 🟣 Apollo.io to enrich each contact since we need professional email addresses and titles."
- If a task needs Apollo.io enrichment → set tools to include "apollo_enrich_person", "apollo_enrich_company", "apollo_search_people", or "apollo_find_email"
- Need to PULL data from an Apollo list into the sheet? → Call apollo_get_list_entries tool NOW during this chat, then return a bulk_write block (see below)
- Need to PUSH leads/companies to Apollo lists? → Use "apollo_add_contact_to_list" or "apollo_add_account_to_list" in an agent_config
- Need to find or browse Apollo lists? → Call apollo_get_lists tool with a search term NOW
- If a task needs email validation → set tools to include "zerobounce_validate" or "zerobounce_batch_validate"
- If a task needs to guess/construct emails from names → set tools to include "zerobounce_guess_format"
- If a task needs web data → set tools to include "search" and/or "web_scrape" (these use Perplexity under the hood)
- If a task needs to push leads to GetSales → set tools to include "getsales_push_leads" in an agent_config
- Need to PULL leads from a GetSales list? → Call getsales_pull_leads tool NOW during this chat, then return a bulk_write block with source: "getsales_list"
- Need to find or browse GetSales lists? → Call getsales_get_lists tool with optional search term NOW
- If a task is pure analysis/writing → set tools to []
- If the user's intent is clear (e.g. "find emails for these contacts"), just do it.
- If a column doesn't exist yet for output, pick the next empty column letter.
- NEVER ask unnecessary follow-up questions. Just act.
- Keep responses SHORT. 2-3 sentences + model routing note, then the appropriate block.
- Reference the actual data you can see (column names, sample values, row counts).

DEFAULTS (use these unless the user specifies otherwise):
- Output format: concise, 1-2 sentences or a single value
- Skip completed rows: true
- Status column: next column after output

YOU HAVE TWO RESPONSE FORMATS:

**FORMAT 1: agent_config** — For ROW-BY-ROW processing of EXISTING sheet data.
Use this when the user wants to process/enrich/transform rows already in the sheet.
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

**FORMAT 2: bulk_write** — For IMPORTING external data INTO the sheet.
Use this when the user wants to pull data from an external source (like an Apollo list) and populate the sheet.
The data will be written starting at the FIRST EMPTY ROW after existing data on the TARGET sheet.

**IMPORTANT: sheetName parameter**
- If the user says "post to Sheet2" or "add to [sheet name]", include "sheetName": "Sheet2" (or the exact sheet name).
- If no sheet is specified, omit sheetName and data writes to the active sheet.
- If the target sheet doesn't exist, it will be created automatically.

**For Apollo list imports (recommended for large lists):**
After calling apollo_get_list_entries, the full dataset is cached server-side. You just need to specify which fields go in which columns:
\`\`\`bulk_write
{
  "source": "apollo_list",
  "sheetName": "Sheet2",
  "columns": ["A", "B"],
  "fields": ["name", "domain"]
}
\`\`\`
Available fields for account lists: name, domain, website, industry, employees
Available fields for contact lists: name, email, title, company, domain, linkedin

**For GetSales list imports:**
After calling getsales_pull_leads, the full dataset is cached. Specify fields→columns:
\`\`\`bulk_write
{
  "source": "getsales_list",
  "sheetName": "Sheet2",
  "columns": ["A", "B", "C", "D"],
  "fields": ["name", "email", "title", "company"]
}
\`\`\`
Available fields for GetSales leads: name, first_name, last_name, email, title, company, linkedin, linkedin_id, phone, location, status

**For small/manual datasets (non-Apollo):**
\`\`\`bulk_write
{
  "sheetName": "Sheet2",
  "columns": ["A", "B"],
  "rows": [
    ["Company Name 1", "website1.com"],
    ["Company Name 2", "website2.com"]
  ]
}
\`\`\`

WHEN TO USE WHICH FORMAT:
- "Find CEO emails for each company" → agent_config (processes existing rows)
- "Pull companies from my Apollo list" → Call apollo_get_list_entries tool, then bulk_write with source: "apollo_list"
- "Pull all employees from CircuitHub" → Call apollo_search_people with pull_all: true + organization_domains, then bulk_write with source: "apollo_search"
- "Add these companies to an Apollo list" → agent_config with apollo_add_account_to_list tool
- "Enrich the website for each company" → agent_config (processes existing rows)
- "Import contacts from Apollo list X into column A and B" → Call apollo_get_list_entries, then bulk_write with source: "apollo_list"
- "Push these leads to GetSales" → agent_config with getsales_push_leads tool (row-by-row from sheet)
- "Pull leads from GetSales list X" → Call getsales_pull_leads tool, then bulk_write with source: "getsales_list"
- "Add leads to a GetSales automation" → agent_config with getsales_add_to_automation tool

IMPORTANT FOR bulk_write:
- You have access to Apollo AND GetSales tools during this chat. CALL THEM to fetch data before writing.
- When the user says "pull from Apollo list X", call apollo_get_list_entries({ list_name: "X" }) to get the data.
- When the user says "pull all employees from X", call apollo_search_people with pull_all: true + organization_domains: ["x.com"]. This auto-paginates to get ALL contacts.
- When the user says "pull leads from GetSales list X", call getsales_pull_leads({ list_name: "X" }) to get the data.
- After the tool returns, respond with a bulk_write block. Use the correct source: "apollo_list", "apollo_search", or "getsales_list" — with a fields mapping. Do NOT try to enumerate all rows yourself. The server will populate rows from the cached data.
- The user's sheet may already have data — bulk_write automatically appends after the last row ON THE TARGET SHEET.
- If the user mentions a specific sheet (e.g. "post to Sheet2", "add to the Employees tab"), ALWAYS include "sheetName" in the bulk_write block.
- Match the columns the user specifies (e.g. "column A and B" → columns: ["A", "B"]).
- Map the right fields to the right columns (e.g. "names and websites" → fields: ["name", "domain"]).
- For Apollo contact search pulls, available fields: name, first_name, last_name, title, company, domain, linkedin, email.
- For GetSales pulls, available fields: name, first_name, last_name, email, title, company, linkedin, linkedin_id, phone, location, status.

TOOL NAME REFERENCE:
- Perplexity web tools: "search", "web_scrape", "web_research"
- Apollo.io enrichment tools: "apollo_enrich_person", "apollo_enrich_company", "apollo_search_people", "apollo_find_email"
- Apollo.io list tools: "apollo_get_lists", "apollo_get_list_entries", "apollo_create_list", "apollo_add_contact_to_list", "apollo_add_account_to_list"
- ZeroBounce tools: "zerobounce_validate", "zerobounce_batch_validate", "zerobounce_guess_format", "zerobounce_credits"
- GetSales.io tools: "getsales_get_lists", "getsales_create_list", "getsales_push_leads", "getsales_pull_leads", "getsales_get_automations", "getsales_add_to_automation"

IMPORTANT: Include the agent_config or bulk_write block as soon as the user's intent is clear. Do not wait for multiple rounds of confirmation.`;

// =============================================================
// PROMPT BUILDERS
// =============================================================

/**
 * Builds the system prompt for the chat/planning phase.
 * This is used when the user is talking to the sidebar to configure an agent.
 */
export function buildChatPrompt(sheetContext: SheetContext, memory?: string): string {
  let prompt = CHAT_SYSTEM_PROMPT;

  // Inject persistent agent memory (company context, brand voice, custom rules)
  if (memory && memory.trim()) {
    prompt += '\n\n--- AGENT MEMORY (PERSISTENT CONTEXT) ---\n';
    prompt += 'The user has provided the following background information. Use it to inform ALL your responses, agent configurations, and processing. This context applies to every interaction.\n\n';
    prompt += memory.trim();
    prompt += '\n--- END AGENT MEMORY ---\n';
  }

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
  sheetContext: SheetContext,
  memory?: string
): { system: string; user: string } {
  // System prompt
  let system = config.systemPrompt || BASE_SYSTEM_PROMPT;

  // Inject persistent agent memory (company context, brand voice, custom rules)
  if (memory && memory.trim()) {
    system += '\n\n--- AGENT MEMORY (PERSISTENT CONTEXT) ---\n';
    system += memory.trim();
    system += '\n--- END AGENT MEMORY ---\n';
    system += '\nUse the above context to inform your output. Match the specified tone, use company-specific details, and follow any custom rules provided.';
  }
  
  // Add model routing context
  const hasWebTools = (config.tools || []).some(t => ['search', 'web_scrape', 'web_research'].includes(t));
  const hasApolloTools = (config.tools || []).some(t => t.startsWith('apollo_'));
  const hasZerobounceTools = (config.tools || []).some(t => t.startsWith('zerobounce_'));
  const hasGetsalesTools = (config.tools || []).some(t => t.startsWith('getsales_'));
  
  if (hasWebTools || hasApolloTools || hasZerobounceTools || hasGetsalesTools) {
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
      system += '\n\nAPOLLO CONTACT PULL STRATEGY (IMPORTANT):';
      system += '\n- **Small companies (<200 employees)**: Use apollo_search_people with pull_all: true + organization_domains. This auto-paginates and fetches ALL contacts without using enrichment credits.';
      system += '\n- **Large companies (200+ employees)**: Use SMART FILTERS. Apply person_titles, person_seniorities, and/or departments to narrow results. Example: If user wants "contacts", infer the likely targets:';
      system += '\n  • General "pull contacts" → filter to seniorities: ["c_suite", "vp", "director", "manager"] to get decision-makers';
      system += '\n  • "Sales team" → filter person_titles: ["Sales", "Account Executive", "SDR", "BDR", "Revenue"]';
      system += '\n  • "Engineering team" → filter person_titles: ["Engineer", "Developer", "CTO", "VP Engineering"]';
      system += '\n  • "Marketing team" → filter person_titles: ["Marketing", "CMO", "Growth", "Content"]';
      system += '\n  • Specific role → filter person_titles to that exact role + per_page: 1-3';
      system += '\n- To determine company size: first call apollo_enrich_company({ domain }) to get estimated_num_employees, then decide strategy.';
      system += '\n- If the user specifies what type of contacts they want, ALWAYS use filters regardless of company size.';
      system += '\n\nAPOLLO LIST MANAGEMENT:';
      system += '\n- **Pull companies FROM a list**: apollo_get_list_entries({ list_name: "My List" }) — fetches all accounts/contacts from a named list with their details (name, domain, industry, etc.)';
      system += '\n- **Find a list**: apollo_get_lists({ search: "keyword" }) — ALWAYS use search param to filter (there may be hundreds of lists)';
      system += '\n- **Push company to list**: apollo_add_account_to_list({ list_name: "My List", name: "Tesla", domain: "tesla.com" }) — DOMAIN IS REQUIRED. Apollo uses the domain to match the real company in their database and auto-enriches it.';
      system += '\n- **CRITICAL**: Always pass the domain/website URL when adding accounts to lists. Full URLs like "https://www.tesla.com" are auto-stripped to "tesla.com".';
      system += '\n- **Push contact to list**: apollo_add_contact_to_list({ list_name: "My List", first_name, last_name, email, title, organization_name })';
      system += '\n- **Create new list**: apollo_create_list({ name: "My New List", type: "accounts" }) — type is "contacts" or "accounts"';
      system += '\n- **Workflow — pull list to sheet**: Use apollo_get_list_entries to get all entries, then output each entry\'s data as the row result.';
      system += '\n- **Workflow — push sheet to list**: For each row, read the company name and website/domain from the sheet columns, then call apollo_add_account_to_list with both name and domain.';
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
    if (hasGetsalesTools) {
      system += '\n- 🔴 GetSales.io tools available. LinkedIn sales engagement platform for lead management and outreach automation.';
      system += '\n\nGETSALES BEST PRACTICES:';
      system += '\n- **Push a lead**: getsales_push_leads({ list_name: "My List", leads: [{ first_name: "John", last_name: "Doe", email: "john@co.com", company_name: "Company", position: "CEO", linkedin_id: "john-doe-123" }] })';
      system += '\n- **LinkedIn ID**: Extract from LinkedIn URL: "https://www.linkedin.com/in/john-doe-123" → "john-doe-123". Auto-cleaned if full URL is passed.';
      system += '\n- **Pull leads from list**: getsales_pull_leads({ list_name: "My List" }) — auto-paginates, returns all leads.';
      system += '\n- **Browse lists**: getsales_get_lists({ search: "keyword" })';
      system += '\n- **Browse automations**: getsales_get_automations({ search: "keyword" })';
      system += '\n- **Add to automation**: After pushing a lead, use getsales_add_to_automation with the returned lead UUID.';
      system += '\n- **WORKFLOW — Apollo to GetSales**: Use 🟣 Apollo to enrich, then 🔴 GetSales to push the enriched lead for LinkedIn outreach.';
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
      description: 'Search for people in Apollo.io\'s database. TWO MODES: (1) Targeted search (per_page 1-24): finds specific roles, reveals full details with email. (2) Bulk pull (pull_all: true): auto-paginates through ALL matching people, caches results for bulk_write — use this when pulling ALL employees from a company. COMPANY SIZE STRATEGY: <200 employees → use pull_all: true. 200+ employees → use filters + low per_page.',
      input_schema: {
        type: 'object',
        properties: {
          person_titles: {
            type: 'array',
            items: { type: 'string' },
            description: 'Job titles to filter by (e.g. ["CEO"], ["CTO", "Chief Technology Officer"])',
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
            description: 'Seniority filter. Values: "c_suite", "vp", "director", "manager", "senior", "entry".',
          },
          q_keywords: {
            type: 'string',
            description: 'Keywords to search for in the person\'s profile',
          },
          per_page: {
            type: 'number',
            description: 'Results per page. Use 1-3 for specific role lookups. Ignored when pull_all is true. Default: 3.',
          },
          pull_all: {
            type: 'boolean',
            description: 'Set to true to auto-paginate and fetch ALL matching people (up to 10K). Results are cached for bulk_write. Use for "pull all employees from X" requests. Does NOT consume enrichment credits.',
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
      description: 'Search and list saved lists from Apollo.io. ALWAYS use the "search" parameter to filter by name — there may be hundreds of lists. Returns matching lists with names, types, counts, and IDs.',
      input_schema: {
        type: 'object',
        properties: {
          search: {
            type: 'string',
            description: 'Search term to filter lists by name (case-insensitive partial match). ALWAYS provide this to avoid truncation. Example: "UK Brands" or "Good-Loop".',
          },
        },
        required: [],
      },
    });
  }

  if (enabledTools.includes('apollo_get_list_entries')) {
    tools.push({
      name: 'apollo_get_list_entries',
      description: 'Fetch ALL companies or contacts FROM an Apollo.io list. Auto-paginates to retrieve the entire list (up to 10,000 entries). Returns a summary with sample entries — the full dataset is cached server-side for bulk_write. After calling this, respond with a bulk_write block using source: "apollo_list" and a fields mapping. For contact lists, available fields: name, email, title, company, domain, linkedin.',
      input_schema: {
        type: 'object',
        properties: {
          list_name: {
            type: 'string',
            description: 'The name of the Apollo list to fetch entries from (case-insensitive, supports partial match)',
          },
        },
        required: ['list_name'],
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
      description: 'Add a company/account to an Apollo.io list. Uses the DOMAIN to match the company in Apollo\'s database, enriches it with firmographic data (industry, size, funding, etc.), and adds it to the named list. ALWAYS provide the domain — it\'s the source of truth for finding the right company record. Full URLs (e.g. "https://www.tesla.com") are automatically stripped to bare domains.',
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
            description: 'Company website or domain (e.g. "tesla.com" or "https://www.tesla.com"). This is the SOURCE OF TRUTH — Apollo uses this to match the correct company record.',
          },
          phone: {
            type: 'string',
            description: 'Company phone number',
          },
        },
        required: ['list_name', 'name', 'domain'],
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

  // =============================================================
  // 🔴 GETSALES.io TOOL DEFINITIONS
  // =============================================================

  if (enabledTools.includes('getsales_get_lists')) {
    tools.push({
      name: 'getsales_get_lists',
      description: 'Get all contact lists from GetSales.io. Optionally filter by name with a search term. Returns list names and UUIDs.',
      input_schema: {
        type: 'object',
        properties: {
          search: {
            type: 'string',
            description: 'Optional: filter lists by name (case-insensitive partial match)',
          },
        },
        required: [],
      },
    });
  }

  if (enabledTools.includes('getsales_create_list')) {
    tools.push({
      name: 'getsales_create_list',
      description: 'Create a new contact list in GetSales.io. Returns the new list UUID.',
      input_schema: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: 'Name for the new list',
          },
        },
        required: ['name'],
      },
    });
  }

  if (enabledTools.includes('getsales_push_leads')) {
    tools.push({
      name: 'getsales_push_leads',
      description: 'Push (upsert) one or more leads into a GetSales.io list. Each lead can include LinkedIn ID, name, email, company, title, headline, etc. Finds or creates the list by name if list_uuid is not provided. Use this for syncing sheet data into GetSales for LinkedIn outreach.',
      input_schema: {
        type: 'object',
        properties: {
          list_uuid: {
            type: 'string',
            description: 'UUID of the target list. If omitted, list_name is used to find/create the list.',
          },
          list_name: {
            type: 'string',
            description: 'Name of the target list. Used to find or create the list if list_uuid is not provided.',
          },
          move_to_list: {
            type: 'boolean',
            description: 'If true, moves existing leads to this list (default: false)',
          },
          leads: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                linkedin_id: { type: 'string', description: 'LinkedIn profile ID or full URL (auto-cleaned)' },
                first_name: { type: 'string' },
                last_name: { type: 'string' },
                company_name: { type: 'string' },
                email: { type: 'string' },
                headline: { type: 'string' },
                position: { type: 'string', description: 'Job title/position' },
                raw_address: { type: 'string', description: 'Location (city, state, country)' },
                linkedin: { type: 'string', description: 'Full LinkedIn profile URL' },
                custom_fields: { type: 'object', description: 'Custom field key-value pairs' },
              },
            },
            description: 'Array of lead objects to push',
          },
        },
        required: ['leads'],
      },
    });
  }

  if (enabledTools.includes('getsales_pull_leads')) {
    tools.push({
      name: 'getsales_pull_leads',
      description: 'Pull ALL leads from a GetSales.io list. Auto-paginates to get every lead. Data is cached server-side for bulk_write. Provide either list_uuid or list_name. Returns a summary with sample leads and available fields.',
      input_schema: {
        type: 'object',
        properties: {
          list_uuid: {
            type: 'string',
            description: 'UUID of the list to pull from',
          },
          list_name: {
            type: 'string',
            description: 'Name of the list to pull from (searched if UUID not provided)',
          },
        },
        required: [],
      },
    });
  }

  if (enabledTools.includes('getsales_get_automations')) {
    tools.push({
      name: 'getsales_get_automations',
      description: 'Get all automations (flows) from GetSales.io. Optionally filter by name. Returns automation names, UUIDs, and statuses.',
      input_schema: {
        type: 'object',
        properties: {
          search: {
            type: 'string',
            description: 'Optional: filter automations by name (case-insensitive partial match)',
          },
        },
        required: [],
      },
    });
  }

  if (enabledTools.includes('getsales_add_to_automation')) {
    tools.push({
      name: 'getsales_add_to_automation',
      description: 'Add a lead to a GetSales.io automation (flow). Requires the lead UUID and automation UUID.',
      input_schema: {
        type: 'object',
        properties: {
          lead_uuid: {
            type: 'string',
            description: 'UUID of the lead to add',
          },
          automation_uuid: {
            type: 'string',
            description: 'UUID of the automation/flow to add the lead to',
          },
        },
        required: ['lead_uuid', 'automation_uuid'],
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
 * Parses the chat response to extract a bulk_write block.
 * Looks for ```bulk_write JSON blocks in the response.
 */
export function parseBulkWrite(response: string): any | null {
  const match = response.match(/```bulk_write\s*\n?([\s\S]*?)```/);
  if (!match) return null;

  try {
    return JSON.parse(match[1]);
  } catch (e) {
    console.error('Failed to parse bulk_write:', e);
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
