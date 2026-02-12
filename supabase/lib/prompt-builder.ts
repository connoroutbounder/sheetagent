/**
 * ============================================================
 * prompt-builder.ts — Prompt Assembly Engine
 * ============================================================
 * Builds structured prompts for the AI agent based on:
 * - Agent configuration (system prompt, tools, format)
 * - Sheet context (headers, column analysis)
 * - Row-specific data (input values, per-row instructions)
 * 
 * Designed for Claude Sonnet 4.5 with tool use.
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
- You have access to tools for web scraping, search, and data extraction.`;

const CHAT_SYSTEM_PROMPT = `You are an AI assistant embedded in a Google Sheets sidebar called "Agent Builder". You help users create and configure agents that process their spreadsheet data.

You can see the user's active sheet structure — headers, column types, sample data, and which rows need processing.

YOUR CAPABILITIES:
- Analyze sheet structure and suggest agent configurations
- Help users define what each agent should do per row
- Map input columns, output columns, and instructions
- Configure tools (web scraping, search, data extraction)
- Start agent runs and monitor progress

CONVERSATION STYLE:
- Reference specific columns by name and letter (e.g., "Column A — Company")
- Show the user you understand their data by referencing sample values
- Propose concrete plans before executing ("Here's what I'll do...")
- Keep explanations short — this is a sidebar, not a document

When the user describes what they want, respond with a structured plan and ask for confirmation before starting.

When you're ready to start a run, include a JSON block in your response:
\`\`\`agent_config
{
  "action": "start_run",
  "name": "Agent Name",
  "systemPrompt": "...",
  "defaultInstruction": "...",
  "inputColumns": ["A", "B"],
  "outputColumn": "D",
  "statusColumn": "E",
  "outputFormat": "1-2 sentences",
  "tools": ["web_scrape", "search"],
  "skipCompleted": true
}
\`\`\``;

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
 */
export function buildToolDefinitions(config: AgentConfig): any[] {
  const tools: any[] = [];
  const enabledTools = config.tools || ['search'];

  if (enabledTools.includes('web_scrape')) {
    tools.push({
      name: 'web_scrape',
      description: 'Fetch and extract content from a web page. Use this to visit company websites, blog posts, or any URL.',
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
      description: 'Search the web for information. Use this to find recent news, funding info, competitor data, or any public information.',
      input_schema: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'The search query',
          },
        },
        required: ['query'],
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
  // Rough estimates based on typical prompts
  const baseSystemTokens = 300;
  const configTokens = 100;
  const rowDataTokens = 50 * (config.inputColumns?.length || 2);
  const toolUseTokens = (config.tools || []).includes('web_scrape') ? 1500 : 500;
  
  const inputTokens = baseSystemTokens + configTokens + rowDataTokens + toolUseTokens;
  const outputTokens = 150; // ~1-2 sentences
  
  // Sonnet 4.5 pricing: $3/M input, $15/M output
  const costUsd = (inputTokens * 3 + outputTokens * 15) / 1_000_000;
  
  return { inputTokens, outputTokens, costUsd };
}
