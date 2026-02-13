/**
 * ============================================================
 * agent-run/index.ts — Agent Orchestrator Edge Function
 * ============================================================
 * Handles four actions:
 * 1. "chat"         — Conversational planning with the user
 * 2. "start_run"    — Kicks off row-by-row processing (first batch)
 * 3. "continue_run" — Processes next batch of rows
 * 4. "stop"         — Stops a running job
 * 
 * Rows are processed in batches of BATCH_SIZE to stay within
 * the Supabase Edge Function timeout. The sidebar chains
 * batches automatically — unlimited rows.
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { buildChatPrompt, buildRowPrompt, buildToolDefinitions, parseAgentConfig } from '../lib/prompt-builder.ts';
import { executeToolCalls, setApolloApiKey, setZerobounceApiKey, setGetsalesApiKey, getCachedListEntries } from '../lib/tools.ts';
import { SheetsClient } from '../lib/sheets-api.ts';
import type { ChatRequest, StartRunRequest, StopRunRequest, ChatResponse, AgentConfig, SheetContext, RowData } from '../lib/types.ts';

// =============================================================
// CONFIG
// =============================================================

const ANTHROPIC_API_KEY = Deno.env.get('ANTHROPIC_API_KEY') || '';
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
const ORCHESTRATOR_MODEL = 'claude-opus-4-0-20250514';  // Chat/planning — best reasoning
const WORKER_MODEL = 'claude-sonnet-4-5-20250929';      // Row processing — fast & cheap
const MAX_TOOL_ROUNDS = 5;
const BATCH_SIZE = 25; // Rows per batch — fits within ~150s timeout

// =============================================================
// MAIN HANDLER
// =============================================================

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Spreadsheet-Id, X-User-Email, X-Apollo-Api-Key, X-Zerobounce-Api-Key, X-Getsales-Api-Key, apikey',
      },
    });
  }

  try {
    const body = await req.json();
    const userEmail = req.headers.get('X-User-Email') || body.userEmail;

    // Set user-provided external API keys (from sidebar Settings)
    const apolloKey = req.headers.get('X-Apollo-Api-Key');
    if (apolloKey) setApolloApiKey(apolloKey);
    const zerobounceKey = req.headers.get('X-Zerobounce-Api-Key');
    if (zerobounceKey) setZerobounceApiKey(zerobounceKey);
    const getsalesKey = req.headers.get('X-Getsales-Api-Key');
    if (getsalesKey) setGetsalesApiKey(getsalesKey);

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const user = await ensureUser(supabase, userEmail);

    switch (body.action) {
      case 'chat':
        return jsonResponse(await handleChat(body as ChatRequest, user));

      case 'start_run':
        return jsonResponse(await handleStartRun(supabase, body as StartRunRequest, user));

      case 'continue_run':
        return jsonResponse(await handleContinueRun(supabase, body));

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

async function handleChat(request: ChatRequest, user: any): Promise<ChatResponse> {
  const systemPrompt = buildChatPrompt(request.sheetContext, request.memory);

  const messages: any[] = [
    ...(request.conversationHistory || []).map(m => ({
      role: m.role as 'user' | 'assistant',
      content: m.content,
    })),
    { role: 'user' as const, content: request.message },
  ];

  // Build tool definitions for chat phase — Apollo list tools + web tools
  // This allows the agent to call apollo_get_list_entries, apollo_get_lists, etc.
  // during the planning phase to fetch data for bulk_write operations
  const chatTools = buildToolDefinitions({
    tools: [
      'apollo_get_lists', 'apollo_get_list_entries', 'apollo_create_list',
      'apollo_enrich_company', 'apollo_search_people', 'apollo_find_email',
      'search', 'web_research',
    ],
  } as AgentConfig);

  // Multi-turn tool execution loop (same pattern as processRow)
  let finalTextContent = '';
  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const response = await callClaude(systemPrompt, messages, chatTools.length > 0 ? chatTools : undefined, ORCHESTRATOR_MODEL, 4096);

    if (!response) {
      return { error: 'Failed to get response from AI' };
    }

    const toolUseBlocks = response.content.filter((c: any) => c.type === 'tool_use');

    if (toolUseBlocks.length > 0) {
      // Execute the tools the agent called
      const toolResults = await executeToolCalls(
        toolUseBlocks.map((b: any) => ({ id: b.id, name: b.name, input: b.input }))
      );

      // Feed results back to continue the conversation
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
      // Loop continues — Claude will process tool results and respond
    } else {
      // No tool calls — extract final text
      finalTextContent = response.content
        .filter((c: any) => c.type === 'text')
        .map((c: any) => c.text)
        .join('\n');
      break;
    }
  }

  // ---------------------------------------------------------------
  // Check for bulk_write block (import data to sheet)
  // Three modes:
  //   1. source: "apollo_list" or "apollo_search" → populate rows from cached Apollo data
  //   2. Direct rows → use as-is (small datasets)
  // ---------------------------------------------------------------
  const bulkWriteMatch = finalTextContent.match(/```bulk_write\s*\n?([\s\S]*?)```/);
  if (bulkWriteMatch) {
    try {
      const bulkWrite = JSON.parse(bulkWriteMatch[1]);
      const cleanMessage = finalTextContent.replace(/```bulk_write[\s\S]*?```/g, '').trim();

      // If Claude used a cached source format (apollo_list OR apollo_search),
      // fill in rows from the cached entries
      if (bulkWrite.source === 'apollo_list' || bulkWrite.source === 'apollo_search' || bulkWrite.source === 'getsales_list') {
        const cached = getCachedListEntries();
        if (cached && cached.entries.length > 0) {
          const fields = bulkWrite.fields || (
            cached.type === 'accounts' ? ['name', 'domain'] : ['name', 'title', 'linkedin']
          );
          bulkWrite.rows = cached.entries.map((entry: Record<string, string>) =>
            fields.map((f: string) => entry[f] || '')
          );
          // Clean up non-standard fields before sending to sidebar
          // (preserve sheetName — it's passed to writeBulkRows)
          delete bulkWrite.source;
          delete bulkWrite.fields;
          delete bulkWrite.list_name;

          return {
            message: cleanMessage || `Writing ${bulkWrite.rows.length} entries to your sheet...`,
            bulkWrite,
          };
        } else {
          return {
            message: 'No cached data available. The Apollo search/list may have been empty or the fetch failed.',
          };
        }
      }

      // Direct rows mode (small datasets — Claude enumerated rows itself)
      return {
        message: cleanMessage || `Writing ${(bulkWrite.rows || []).length} rows to your sheet...`,
        bulkWrite,
      };
    } catch (e) {
      console.error('Failed to parse bulk_write:', e);
    }
  }

  // ---------------------------------------------------------------
  // Fallback: if any Apollo tool was called and cached data exists
  // but Claude didn't produce a bulk_write block, auto-construct one.
  // ---------------------------------------------------------------
  const cached = getCachedListEntries();
  if (cached && cached.entries.length > 0) {
    const defaultFields = cached.type === 'accounts'
      ? ['name', 'domain']
      : ['name', 'title', 'linkedin'];
    const columns = defaultFields.map((_f, i) => String.fromCharCode(65 + i)); // A, B, C...
    const rows = cached.entries.map((entry: Record<string, string>) =>
      defaultFields.map((f: string) => entry[f] || '')
    );

    return {
      message: finalTextContent || `Fetched ${rows.length} entries. Writing to columns ${columns.join(', ')}...`,
      bulkWrite: { columns, rows },
    };
  }

  // Check for agent_config block (start a row-by-row run)
  const agentConfig = parseAgentConfig(finalTextContent);
  if (agentConfig && agentConfig.action === 'start_run') {
    const cleanMessage = finalTextContent.replace(/```agent_config[\s\S]*?```/g, '').trim();
    return {
      message: cleanMessage || 'Ready to start processing!',
      agentConfig,
      suggestSave: true,
    };
  }

  return { message: finalTextContent };
}

// =============================================================
// RUN HANDLER — Start
// =============================================================

async function handleStartRun(
  supabase: any,
  request: StartRunRequest & { selectedRows?: number[] },
  user: any
): Promise<ChatResponse> {
  const { agentConfig, sheetContext, spreadsheetId, sheetName, selectedRows } = request;
  const memory = (request as any).memory || '';

  // Use explicitly selected rows if provided, otherwise auto-detect
  const rowsToProcess = (selectedRows && selectedRows.length > 0)
    ? selectedRows
    : getRowsToProcess(sheetContext, agentConfig);

  if (rowsToProcess.length === 0) {
    return { message: 'No rows to process. All rows either have output or are empty.' };
  }

  // Save agent if new
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

  // Create run record with ALL rows
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

  // Create ALL run_rows records upfront
  const rowRecords = rowsToProcess.map((rowNum) => ({
    run_id: run.id,
    row_number: rowNum,
    input_data: getSampleRowData(sheetContext, rowNum),
    instruction: getRowInstruction(sheetContext, rowNum, agentConfig),
    status: 'pending',
  }));

  await supabase.from('run_rows').insert(rowRecords);

  // Process FIRST BATCH in background
  const firstBatch = rowsToProcess.slice(0, BATCH_SIZE);
  processBatchAsync(supabase, run.id, agentConfig, sheetContext, spreadsheetId, sheetName, firstBatch, memory);

  return {
    message: `Starting agent run on ${rowsToProcess.length} rows (batch 1 of ${Math.ceil(rowsToProcess.length / BATCH_SIZE)})...`,
    jobId: run.id,
    totalRows: rowsToProcess.length,
    label: agentConfig.name || 'Processing rows',
  };
}

// =============================================================
// RUN HANDLER — Continue (next batch)
// =============================================================

async function handleContinueRun(
  supabase: any,
  body: any
): Promise<ChatResponse> {
  const { jobId, sheetContext, spreadsheetId, sheetName, memory } = body;

  if (!jobId) {
    return { error: 'Missing jobId' };
  }

  // Get the run record
  const { data: run } = await supabase
    .from('agent_runs')
    .select('*')
    .eq('id', jobId)
    .single();

  if (!run) {
    return { error: 'Run not found' };
  }

  if (run.status === 'stopped') {
    return { message: 'Run was stopped' };
  }

  // Get all pending rows for this run
  const { data: pendingRows } = await supabase
    .from('run_rows')
    .select('row_number')
    .eq('run_id', jobId)
    .eq('status', 'pending')
    .order('row_number', { ascending: true })
    .limit(BATCH_SIZE);

  if (!pendingRows || pendingRows.length === 0) {
    // No more rows — mark complete
    await supabase
      .from('agent_runs')
      .update({
        status: 'complete',
        completed_at: new Date().toISOString(),
      })
      .eq('id', jobId);

    return { message: 'All rows processed' };
  }

  const batchRows = pendingRows.map((r: any) => r.row_number);
  const config = run.config as AgentConfig;

  // Use provided sheetContext or reconstruct from run data
  const ctx = sheetContext || { 
    headers: [], 
    columns: [], 
    sampleRows: [],
    rowCount: run.total_rows, 
    columnCount: 0,
    sheetName: run.sheet_name,
  };

  // Update run status back to running
  await supabase
    .from('agent_runs')
    .update({ status: 'running' })
    .eq('id', jobId);

  // Process this batch in background
  processBatchAsync(supabase, jobId, config, ctx, spreadsheetId || run.spreadsheet_id, sheetName || run.sheet_name, batchRows, memory || '');

  const totalPending = pendingRows.length;
  const batchNum = Math.ceil((run.total_rows - totalPending) / BATCH_SIZE) + 1;
  const totalBatches = Math.ceil(run.total_rows / BATCH_SIZE);

  return {
    message: `Processing batch ${batchNum} of ${totalBatches} (${batchRows.length} rows)...`,
    jobId,
    continuing: true,
  };
}

// =============================================================
// BATCH PROCESSOR
// =============================================================

/**
 * Processes a batch of rows. Runs in the background after
 * the HTTP response has been sent.
 * 
 * When the batch finishes, marks the run as:
 * - "batch_complete" if there are more pending rows
 * - "complete" if all rows are done
 */
async function processBatchAsync(
  supabase: any,
  runId: string,
  config: AgentConfig,
  sheetContext: SheetContext,
  spreadsheetId: string,
  sheetName: string,
  batchRows: number[],
  memory?: string
) {
  // Try to initialize Sheets client for direct write-back (optional)
  let sheetsClient: SheetsClient | null = null;
  try {
    const serviceAccountKey = await getServiceAccountKey(supabase, spreadsheetId);
    if (serviceAccountKey) {
      sheetsClient = new SheetsClient({ spreadsheetId, serviceAccountKey });
    }
  } catch (e) {
    // No service account — sidebar handles writes
  }

  const toolDefinitions = buildToolDefinitions(config);

  // Get current progress
  const { data: runData } = await supabase
    .from('agent_runs')
    .select('completed_rows, error_rows')
    .eq('id', runId)
    .single();

  let completedRows = runData?.completed_rows || 0;
  let errorRows = runData?.error_rows || 0;

  for (const rowNumber of batchRows) {
    // Check if run was stopped
    const { data: run } = await supabase
      .from('agent_runs')
      .select('status')
      .eq('id', runId)
      .single();

    if (run?.status === 'stopped') {
      break;
    }

    // Build row data from cached sheet context
    let rowData: RowData = { _rowNumber: rowNumber, ...getSampleRowData(sheetContext, rowNumber) };

    // Try to get fresh data from sheet if we have a sheets client
    if (sheetsClient) {
      try {
        const values = await sheetsClient.readRow(sheetName, rowNumber, sheetContext.columnCount);
        rowData = { _rowNumber: rowNumber };
        sheetContext.headers.forEach((h, i) => {
          rowData[h.letter] = values[i] || '';
          rowData[h.name] = values[i] || '';
        });
      } catch (e) {
        // Use cached data
      }
    }

    if (config.instructionColumn) {
      rowData._instruction = rowData[config.instructionColumn] || config.defaultInstruction;
    }

    const companyName = rowData[sheetContext.headers?.[0]?.name] || `Row ${rowNumber}`;
    await supabase
      .from('agent_runs')
      .update({
        current_row: rowNumber,
        current_company: String(companyName).substring(0, 100),
      })
      .eq('id', runId);

    try {
      const result = await processRow(config, rowData, sheetContext, toolDefinitions, memory);

      const hasWebTools = (config.tools || []).some(t => ['search', 'web_scrape', 'web_research'].includes(t));
      const hasApolloTools = (config.tools || []).some(t => t.startsWith('apollo_'));
      const hasZerobounceTools = (config.tools || []).some(t => t.startsWith('zerobounce_'));
      const hasGetsalesTools = (config.tools || []).some(t => t.startsWith('getsales_'));
      const modelParts = [WORKER_MODEL];
      if (hasWebTools) modelParts.push('perplexity/sonar');
      if (hasApolloTools) modelParts.push('apollo.io');
      if (hasZerobounceTools) modelParts.push('zerobounce');
      if (hasGetsalesTools) modelParts.push('getsales.io');
      const modelsUsed = modelParts.join(' + ');

      await supabase
        .from('run_rows')
        .update({
          output: result.output,
          status: 'complete',
          written_to_sheet: false,
          input_tokens: result.inputTokens,
          output_tokens: result.outputTokens,
          cost: result.cost,
          model: modelsUsed,
          latency_ms: result.latencyMs,
          completed_at: new Date().toISOString(),
        })
        .eq('run_id', runId)
        .eq('row_number', rowNumber);

      if (sheetsClient) {
        try {
          await sheetsClient.writeRowResult(
            sheetName, rowNumber,
            config.outputColumn || 'B', result.output,
            config.statusColumn, '✓ Complete'
          );
          await supabase
            .from('run_rows')
            .update({ written_to_sheet: true })
            .eq('run_id', runId)
            .eq('row_number', rowNumber);
        } catch (e) {
          // Sidebar handles write
        }
      }

      completedRows++;
    } catch (error) {
      console.error(`Error processing row ${rowNumber}:`, error);
      errorRows++;

      await supabase
        .from('run_rows')
        .update({
          status: 'error',
          error: error.message || 'Unknown error',
          completed_at: new Date().toISOString(),
        })
        .eq('run_id', runId)
        .eq('row_number', rowNumber);
    }

    // Update progress after each row
    await supabase
      .from('agent_runs')
      .update({
        completed_rows: completedRows,
        error_rows: errorRows,
      })
      .eq('id', runId);
  }

  // Check if there are more pending rows
  const { count } = await supabase
    .from('run_rows')
    .select('id', { count: 'exact', head: true })
    .eq('run_id', runId)
    .eq('status', 'pending');

  if (count && count > 0) {
    // More rows to process — signal sidebar to continue
    await supabase
      .from('agent_runs')
      .update({
        status: 'batch_complete',
        completed_rows: completedRows,
        error_rows: errorRows,
      })
      .eq('id', runId);
  } else {
    // All done
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
}

// =============================================================
// ROW PROCESSOR
// =============================================================

async function processRow(
  config: AgentConfig,
  rowData: RowData,
  sheetContext: SheetContext,
  toolDefinitions: any[],
  memory?: string
): Promise<{
  output: string;
  inputTokens: number;
  outputTokens: number;
  cost: number;
  latencyMs: number;
}> {
  const startTime = Date.now();
  const { system, user } = buildRowPrompt(config, rowData, sheetContext, memory);

  let messages: any[] = [{ role: 'user', content: user }];
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let finalOutput = '';

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const response = await callClaude(system, messages, toolDefinitions.length > 0 ? toolDefinitions : undefined);

    if (!response) {
      throw new Error('No response from Claude');
    }

    totalInputTokens += response.usage?.input_tokens || 0;
    totalOutputTokens += response.usage?.output_tokens || 0;

    const toolUseBlocks = response.content.filter((c: any) => c.type === 'tool_use');

    if (toolUseBlocks.length > 0) {
      const toolResults = await executeToolCalls(
        toolUseBlocks.map((b: any) => ({ id: b.id, name: b.name, input: b.input }))
      );

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
      const textBlocks = response.content.filter((c: any) => c.type === 'text');
      finalOutput = textBlocks.map((c: any) => c.text).join('\n').trim();
      break;
    }
  }

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
    .in('status', ['running', 'batch_complete']);

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
  tools?: any[],
  model?: string,
  maxTokens?: number
): Promise<any> {
  const body: any = {
    model: model || WORKER_MODEL,
    max_tokens: maxTokens || 1024,
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
  let { data: user } = await supabase
    .from('agent_users')
    .select('*')
    .eq('email', email)
    .single();

  if (!user) {
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
