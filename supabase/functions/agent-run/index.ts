/**
 * ============================================================
 * agent-run/index.ts — Agent Orchestrator Edge Function
 * ============================================================
 * Handles three actions:
 * 1. "chat"      — Conversational planning with the user
 * 2. "start_run" — Kicks off row-by-row processing
 * 3. "stop"      — Stops a running job
 * 
 * The chat phase uses Claude to understand the user's intent
 * and configure the agent. The run phase processes rows
 * sequentially, writing results back to the sheet.
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { buildChatPrompt, buildRowPrompt, buildToolDefinitions, parseAgentConfig } from '../lib/prompt-builder.ts';
import { executeToolCalls } from '../lib/tools.ts';
import { SheetsClient } from '../lib/sheets-api.ts';
import type { ChatRequest, StartRunRequest, StopRunRequest, ChatResponse, AgentConfig, SheetContext, RowData } from '../lib/types.ts';

// =============================================================
// CONFIG
// =============================================================

const ANTHROPIC_API_KEY = Deno.env.get('ANTHROPIC_API_KEY') || '';
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
const MODEL = 'claude-sonnet-4-5-20250929';
const MAX_TOOL_ROUNDS = 5; // Max tool-use loops per row

// =============================================================
// MAIN HANDLER
// =============================================================

Deno.serve(async (req) => {
  // CORS headers
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Spreadsheet-Id, X-User-Email',
      },
    });
  }

  try {
    const body = await req.json();
    const userEmail = req.headers.get('X-User-Email') || body.userEmail;

    // Initialize Supabase client
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    // Ensure user exists
    const user = await ensureUser(supabase, userEmail);

    switch (body.action) {
      case 'chat':
        return jsonResponse(await handleChat(body as ChatRequest, user));

      case 'start_run':
        return jsonResponse(await handleStartRun(supabase, body as StartRunRequest, user));

      case 'stop':
        return jsonResponse(await handleStop(supabase, body as StopRunRequest));

      default:
        return jsonResponse({ error: 'Unknown action: ' + body.action }, 400);
    }
  } catch (error) {
    console.error('Agent run error:', error);
    return jsonResponse({ error: error.message || 'Internal server error' }, 500);
  }
});

// =============================================================
// CHAT HANDLER
// =============================================================

/**
 * Handles the conversational planning phase.
 * The user describes what they want, Claude analyzes the sheet
 * and proposes an agent configuration.
 */
async function handleChat(request: ChatRequest, user: any): Promise<ChatResponse> {
  const systemPrompt = buildChatPrompt(request.sheetContext);

  // Build messages array
  const messages = [
    ...(request.conversationHistory || []).map(m => ({
      role: m.role as 'user' | 'assistant',
      content: m.content,
    })),
    { role: 'user' as const, content: request.message },
  ];

  // Call Claude
  const response = await callClaude(systemPrompt, messages);

  if (!response) {
    return { error: 'Failed to get response from AI' };
  }

  // Extract text response
  const textContent = response.content
    .filter((c: any) => c.type === 'text')
    .map((c: any) => c.text)
    .join('\n');

  // Check if Claude included an agent_config block (ready to run)
  const agentConfig = parseAgentConfig(textContent);

  if (agentConfig && agentConfig.action === 'start_run') {
    // Clean the config block out of the message
    const cleanMessage = textContent.replace(/```agent_config[\s\S]*?```/g, '').trim();

    return {
      message: cleanMessage || 'Ready to start processing!',
      agentConfig,
      suggestSave: true,
    };
  }

  return { message: textContent };
}

// =============================================================
// RUN HANDLER
// =============================================================

/**
 * Starts an agent run. Creates a job record in the database,
 * then processes rows sequentially in the background.
 */
async function handleStartRun(
  supabase: any,
  request: StartRunRequest,
  user: any
): Promise<ChatResponse> {
  const { agentConfig, sheetContext, spreadsheetId, sheetName } = request;

  // Determine which rows to process
  const rowsToProcess = getRowsToProcess(sheetContext, agentConfig);

  if (rowsToProcess.length === 0) {
    return { message: 'No rows to process. All rows either have output or are empty.' };
  }

  // Save agent if it doesn't exist yet
  let agentId = agentConfig.id;
  if (!agentId && agentConfig.name) {
    const { data: agent } = await supabase
      .from('agents')
      .insert({
        user_id: user.id,
        name: agentConfig.name,
        description: agentConfig.description || '',
        config: agentConfig,
        input_columns: agentConfig.inputColumns || [],
        output_column: agentConfig.outputColumn,
        status_column: agentConfig.statusColumn,
        instruction_column: agentConfig.instructionColumn,
      })
      .select('id')
      .single();

    if (agent) agentId = agent.id;
  }

  // Create run record
  const { data: run, error: runError } = await supabase
    .from('agent_runs')
    .insert({
      agent_id: agentId,
      user_id: user.id,
      spreadsheet_id: spreadsheetId,
      sheet_name: sheetName,
      config: agentConfig,
      status: 'running',
      total_rows: rowsToProcess.length,
      started_at: new Date().toISOString(),
    })
    .select('id')
    .single();

  if (runError || !run) {
    return { error: 'Failed to create run: ' + (runError?.message || 'Unknown') };
  }

  // Create run_rows records
  const rowRecords = rowsToProcess.map((rowNum, idx) => ({
    run_id: run.id,
    row_number: rowNum,
    input_data: getSampleRowData(sheetContext, rowNum),
    instruction: getRowInstruction(sheetContext, rowNum, agentConfig),
    status: 'pending',
  }));

  await supabase.from('run_rows').insert(rowRecords);

  // Process rows in background (non-blocking)
  processRowsAsync(supabase, run.id, agentConfig, sheetContext, spreadsheetId, sheetName, rowsToProcess);

  return {
    message: `Starting agent run on ${rowsToProcess.length} rows...`,
    jobId: run.id,
    totalRows: rowsToProcess.length,
    label: agentConfig.name || 'Processing rows',
  };
}

/**
 * Processes rows one by one. This runs in the background after
 * the HTTP response has been sent.
 */
async function processRowsAsync(
  supabase: any,
  runId: string,
  config: AgentConfig,
  sheetContext: SheetContext,
  spreadsheetId: string,
  sheetName: string,
  rows: number[]
) {
  // Initialize Sheets client for write-back
  const sheetsClient = new SheetsClient({
    spreadsheetId,
    serviceAccountKey: await getServiceAccountKey(supabase, spreadsheetId),
  });

  const toolDefinitions = buildToolDefinitions(config);
  let completedRows = 0;
  let errorRows = 0;

  for (const rowNumber of rows) {
    // Check if run was stopped
    const { data: run } = await supabase
      .from('agent_runs')
      .select('status')
      .eq('id', runId)
      .single();

    if (run?.status === 'stopped') {
      break;
    }

    // Get fresh row data from sheet
    let rowData: RowData;
    try {
      const values = await sheetsClient.readRow(sheetName, rowNumber, sheetContext.columnCount);
      rowData = { _rowNumber: rowNumber };
      sheetContext.headers.forEach((h, i) => {
        rowData[h.letter] = values[i] || '';
        rowData[h.name] = values[i] || '';
      });

      // Get per-row instruction
      if (config.instructionColumn) {
        rowData._instruction = rowData[config.instructionColumn] || config.defaultInstruction;
      }
    } catch (e) {
      // If we can't read fresh data, use cached sample data
      rowData = getSampleRowData(sheetContext, rowNumber) as RowData;
      rowData._rowNumber = rowNumber;
    }

    // Update status: processing
    const companyName = rowData[sheetContext.headers[0]?.name] || `Row ${rowNumber}`;
    await supabase
      .from('agent_runs')
      .update({
        current_row: rowNumber,
        current_company: String(companyName).substring(0, 100),
      })
      .eq('id', runId);

    // Write "Running" to status column
    if (config.statusColumn) {
      try {
        await sheetsClient.writeCell(sheetName, `${config.statusColumn}${rowNumber}`, '⏳ Running');
      } catch (e) {
        console.warn('Failed to write status:', e.message);
      }
    }

    // Process the row with Claude
    try {
      const result = await processRow(config, rowData, sheetContext, toolDefinitions);

      // Write result to sheet
      await sheetsClient.writeRowResult(
        sheetName,
        rowNumber,
        config.outputColumn || 'D',
        result.output,
        config.statusColumn,
        '✓ Complete'
      );

      // Update run_rows record
      await supabase
        .from('run_rows')
        .update({
          output: result.output,
          status: 'complete',
          input_tokens: result.inputTokens,
          output_tokens: result.outputTokens,
          cost: result.cost,
          model: MODEL,
          latency_ms: result.latencyMs,
          completed_at: new Date().toISOString(),
        })
        .eq('run_id', runId)
        .eq('row_number', rowNumber);

      completedRows++;
    } catch (error) {
      console.error(`Error processing row ${rowNumber}:`, error);
      errorRows++;

      // Write error to sheet
      if (config.statusColumn) {
        try {
          await sheetsClient.writeCell(sheetName, `${config.statusColumn}${rowNumber}`, '✗ Error');
        } catch (e) { /* ignore */ }
      }

      // Log error
      await supabase
        .from('run_rows')
        .update({
          status: 'error',
          error: error.message || 'Unknown error',
          completed_at: new Date().toISOString(),
        })
        .eq('run_id', runId)
        .eq('row_number', rowNumber);

      // Update run errors array
      await supabase.rpc('append_run_error', {
        run_id: runId,
        error_data: { row: rowNumber, error: error.message, timestamp: new Date().toISOString() },
      });
    }

    // Update progress
    await supabase
      .from('agent_runs')
      .update({
        completed_rows: completedRows,
        error_rows: errorRows,
      })
      .eq('id', runId);
  }

  // Mark run as complete
  await supabase
    .from('agent_runs')
    .update({
      status: 'complete',
      completed_rows: completedRows,
      error_rows: errorRows,
      completed_at: new Date().toISOString(),
    })
    .eq('id', runId);
}

// =============================================================
// ROW PROCESSOR
// =============================================================

/**
 * Processes a single row using Claude with tool access.
 * Handles the agentic loop: prompt → response → tool calls → repeat.
 */
async function processRow(
  config: AgentConfig,
  rowData: RowData,
  sheetContext: SheetContext,
  toolDefinitions: any[]
): Promise<{
  output: string;
  inputTokens: number;
  outputTokens: number;
  cost: number;
  latencyMs: number;
}> {
  const startTime = Date.now();
  const { system, user } = buildRowPrompt(config, rowData, sheetContext);

  let messages: any[] = [{ role: 'user', content: user }];
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let finalOutput = '';

  // Agentic loop (tool use rounds)
  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const response = await callClaude(system, messages, toolDefinitions.length > 0 ? toolDefinitions : undefined);

    if (!response) {
      throw new Error('No response from Claude');
    }

    totalInputTokens += response.usage?.input_tokens || 0;
    totalOutputTokens += response.usage?.output_tokens || 0;

    // Check for tool calls
    const toolUseBlocks = response.content.filter((c: any) => c.type === 'tool_use');

    if (toolUseBlocks.length > 0) {
      // Execute tools
      const toolResults = await executeToolCalls(
        toolUseBlocks.map((b: any) => ({ id: b.id, name: b.name, input: b.input }))
      );

      // Add assistant response and tool results to messages
      messages.push({ role: 'assistant', content: response.content });
      messages.push({
        role: 'user',
        content: toolResults.map(r => ({
          type: 'tool_result',
          tool_use_id: r.tool_use_id,
          content: r.content,
          is_error: r.is_error,
        })),
      });
    } else {
      // No tool calls — extract the final text output
      const textBlocks = response.content.filter((c: any) => c.type === 'text');
      finalOutput = textBlocks.map((c: any) => c.text).join('\n').trim();
      break;
    }
  }

  // Calculate cost (Sonnet 4.5: $3/M input, $15/M output)
  const cost = (totalInputTokens * 3 + totalOutputTokens * 15) / 1_000_000;

  return {
    output: finalOutput || 'No output generated',
    inputTokens: totalInputTokens,
    outputTokens: totalOutputTokens,
    cost,
    latencyMs: Date.now() - startTime,
  };
}

// =============================================================
// STOP HANDLER
// =============================================================

async function handleStop(supabase: any, request: StopRunRequest) {
  const { data, error } = await supabase
    .from('agent_runs')
    .update({ status: 'stopped', completed_at: new Date().toISOString() })
    .eq('id', request.jobId)
    .eq('status', 'running');

  if (error) {
    return { error: 'Failed to stop run: ' + error.message };
  }

  return { success: true, message: 'Run stopped' };
}

// =============================================================
// CLAUDE API
// =============================================================

async function callClaude(
  system: string,
  messages: any[],
  tools?: any[]
): Promise<any> {
  const body: any = {
    model: MODEL,
    max_tokens: 1024,
    system,
    messages,
  };

  if (tools && tools.length > 0) {
    body.tools = tools;
  }

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Claude API error (${response.status}): ${error}`);
  }

  return response.json();
}

// =============================================================
// HELPERS
// =============================================================

async function ensureUser(supabase: any, email: string) {
  // Try to find existing user
  let { data: user } = await supabase
    .from('agent_users')
    .select('*')
    .eq('email', email)
    .single();

  if (!user) {
    // Create new user
    const { data: newUser, error } = await supabase
      .from('agent_users')
      .insert({ email })
      .select('*')
      .single();

    if (error) throw new Error('Failed to create user: ' + error.message);
    user = newUser;
  }

  return user;
}

function getRowsToProcess(sheetContext: SheetContext, config: AgentConfig): number[] {
  if (sheetContext.emptyOutputRows && sheetContext.emptyOutputRows.count > 0 && config.skipCompleted !== false) {
    return sheetContext.emptyOutputRows.rows;
  }

  // Process all data rows
  const rows: number[] = [];
  for (let i = 2; i <= sheetContext.rowCount + 1; i++) {
    rows.push(i);
  }
  return rows;
}

function getSampleRowData(sheetContext: SheetContext, rowNumber: number): Record<string, any> {
  const sample = (sheetContext.sampleRows || []).find(r => r._rowNumber === rowNumber);
  return sample || {};
}

function getRowInstruction(sheetContext: SheetContext, rowNumber: number, config: AgentConfig): string {
  if (!config.instructionColumn) return config.defaultInstruction || '';
  
  const sample = getSampleRowData(sheetContext, rowNumber);
  const header = sheetContext.headers.find(h => h.letter === config.instructionColumn);
  return sample[header?.name || ''] || config.defaultInstruction || '';
}

async function getServiceAccountKey(supabase: any, spreadsheetId: string): Promise<any | undefined> {
  const { data } = await supabase
    .from('sheet_credentials')
    .select('credentials')
    .eq('spreadsheet_id', spreadsheetId)
    .eq('credential_type', 'service_account')
    .single();

  return data?.credentials;
}

function jsonResponse(body: any, status: number = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    },
  });
}
