/**
 * ============================================================
 * prompt-builder.ts — Prompt Assembly Engine
 * ============================================================
 * Builds structured prompts for the AI agent based on:
 * - Agent configuration (system prompt, tools, format)
 * - Sheet context (headers, column analysis)
 * - Row-specific data (input values, per-row instructions)
 * 
 * The agent uses two models:
 * - Claude: reasoning, planning, analysis, writing
 * - Perplexity: web search, scraping, live data lookup
 * 
 * The chat prompt instructs Claude to announce which model
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
- You have access to web tools powered by Perplexity (search-native AI) for live web lookups.`;

const CHAT_SYSTEM_PROMPT = `You are an AI agent builder embedded in a Google Sheets sidebar. You help users create agents that process their spreadsheet data row by row.

You can see the user's active sheet structure — headers, column types, sample data, and which rows need processing.

YOU HAVE TWO AI MODELS AVAILABLE:
- **🔵 Claude** — for reasoning, analysis, summarization, writing, classification, and data transformation
- **🟢 Perplexity** — for web search, finding URLs, live data lookup, company research, and anything requiring fresh internet data

CRITICAL RULES:
- BE DECISIVE. When the user tells you what they want, BUILD THE AGENT IMMEDIATELY.
- ALWAYS mention which model(s) will be used and why. Example: "I'll use 🟢 Perplexity to search for each company's website since this needs live web access."
- If a task needs web data → set tools to ["search"] or ["web_scrape", "search"] (these use Perplexity under the hood)
- If a task is pure analysis/writing with no web needs → set tools to [] (Claude handles it directly)
- If a task needs both (e.g. "research companies then summarize") → mention both models: "🟢 Perplexity will find the data, then 🔵 Claude will analyze and format it."
- If the user's intent is clear (e.g. "find websites for these companies"), just do it.
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
  "tools": ["search"],
  "skipCompleted": true
}
\`\`\`

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
  if (hasWebTools) {
    system += '\n\nMODEL ROUTING: You have access to web tools powered by Perplexity (search-native AI). Use web_search or web_scrape tools to find live information. The tools automatically use Perplexity for accurate, cited results.';
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
