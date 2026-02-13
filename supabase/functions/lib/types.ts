/**
 * ============================================================
 * types.ts — Shared Type Definitions
 * ============================================================
 */

// =============================================================
// SHEET CONTEXT (from Apps Script)
// =============================================================

export interface SheetHeader {
  index: number;
  letter: string;
  name: string;
  raw: any;
}

export interface ColumnAnalysis {
  index: number;
  letter: string;
  name: string;
  type: string;
  fillRate: number;
  totalRows: number;
  filledRows: number;
  emptyRows: number;
  uniqueValues: number;
  sampleValues: string[];
  looksLikeOutput: boolean;
  looksLikeStatus: boolean;
  looksLikeInstruction: boolean;
}

export interface EmptyOutputRows {
  count: number;
  rows: number[];
  outputColumn: string;
}

export interface SheetContext {
  spreadsheetId: string;
  spreadsheetName: string;
  sheetName: string;
  sheetId: number;
  isEmpty: boolean;
  headers: SheetHeader[];
  rowCount: number;
  columnCount: number;
  columns: ColumnAnalysis[];
  sampleRows: Record<string, any>[];
  emptyOutputRows: EmptyOutputRows;
  allSheets: Array<{ name: string; id: number; rowCount: number }>;
  namedRanges: Array<{ name: string; range: string }>;
}

// =============================================================
// AGENT CONFIG
// =============================================================

export interface AgentConfig {
  // Identity
  name?: string;
  description?: string;
  icon?: string;
  
  // Core config
  action?: string;
  systemPrompt?: string;
  defaultInstruction?: string;
  inputColumns?: string[];
  instructionColumn?: string;
  outputColumn?: string;
  statusColumn?: string;
  outputFormat?: string;
  
  // Tools & model
  tools?: string[];
  model?: string;
  maxTokens?: number;
  
  // Execution
  skipCompleted?: boolean;
  batchSize?: number;
  
  // From DB
  id?: string;
  userId?: string;
}

// =============================================================
// ROW DATA
// =============================================================

export interface RowData {
  _rowNumber: number;
  _instruction?: string;
  [key: string]: any;
}

// =============================================================
// API PAYLOADS
// =============================================================

export interface ChatRequest {
  action: 'chat';
  message: string;
  sheetContext: SheetContext;
  spreadsheetId: string;
  sheetName: string;
  userEmail: string;
  conversationHistory?: Array<{ role: string; content: string }>;
  memory?: string;  // Persistent context: company info, brand voice, custom rules
}

export interface StartRunRequest {
  action: 'start_run';
  agentConfig: AgentConfig;
  sheetContext: SheetContext;
  spreadsheetId: string;
  sheetName: string;
  userEmail: string;
  memory?: string;  // Persistent context: company info, brand voice, custom rules
}

export interface StopRunRequest {
  action: 'stop';
  jobId: string;
}

export interface BulkWriteData {
  columns: string[];     // Column letters, e.g. ["A", "B"]
  rows: string[][];      // Array of row data, e.g. [["McDonald's", "mcdonalds.com"], ...]
  startRow?: number;     // Optional: explicit start row. Default: first empty row after existing data
  sheetName?: string;    // Optional: target sheet name. Default: active sheet. Auto-creates if missing.
}

export interface ChatResponse {
  message?: string;
  jobId?: string;
  totalRows?: number;
  label?: string;
  agentConfig?: AgentConfig;
  bulkWrite?: BulkWriteData;
  suggestSave?: boolean;
  error?: string;
  continuing?: boolean;
}

export interface JobStatus {
  status: 'queued' | 'running' | 'complete' | 'stopped' | 'error';
  totalRows: number;
  completedRows: number;
  errorRows: number;
  currentRow?: number;
  currentCompany?: string;
  errors?: Array<{ row: number; error: string }>;
  error?: string;
}

// =============================================================
// DATABASE RECORDS
// =============================================================

export interface AgentRecord {
  id: string;
  user_id: string;
  name: string;
  description: string;
  icon: string;
  config: AgentConfig;
  input_columns: string[];
  output_column: string;
  status_column: string;
  instruction_column: string;
  total_runs: number;
  total_rows_processed: number;
  last_run_at: string;
  avg_cost_per_row: number;
  is_public: boolean;
  created_at: string;
  updated_at: string;
}

export interface RunRecord {
  id: string;
  agent_id: string;
  user_id: string;
  spreadsheet_id: string;
  sheet_name: string;
  config: AgentConfig;
  status: 'queued' | 'running' | 'complete' | 'stopped' | 'error';
  total_rows: number;
  completed_rows: number;
  error_rows: number;
  current_row: number;
  current_company: string;
  total_input_tokens: number;
  total_output_tokens: number;
  total_cost: number;
  errors: Array<{ row: number; error: string; timestamp: string }>;
  started_at: string;
  completed_at: string;
  created_at: string;
}
