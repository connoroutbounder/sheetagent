-- ============================================================
-- 001_agents.sql — Core schema for Google Sheets Agent Builder
-- ============================================================
-- Run this against your Supabase Postgres database.
-- Creates: users, agents, agent_runs, run_rows tables.

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================================
-- USERS
-- ============================================================
-- Lightweight user tracking. We use Google email as the primary identifier.

CREATE TABLE IF NOT EXISTS agent_users (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  email TEXT UNIQUE NOT NULL,
  display_name TEXT,
  spreadsheet_ids TEXT[] DEFAULT '{}',  -- Sheets they've used the builder with
  settings JSONB DEFAULT '{}',
  usage_credits INTEGER DEFAULT 100,     -- Free tier: 100 rows/month
  plan TEXT DEFAULT 'free',              -- free, pro, team
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_agent_users_email ON agent_users(email);

-- ============================================================
-- AGENTS
-- ============================================================
-- Saved agent configurations. Each agent is a reusable template
-- that maps instructions to sheet columns.

CREATE TABLE IF NOT EXISTS agents (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID REFERENCES agent_users(id) ON DELETE CASCADE,
  
  -- Agent identity
  name TEXT NOT NULL,
  description TEXT,
  icon TEXT DEFAULT '🤖',
  
  -- Core configuration
  config JSONB NOT NULL DEFAULT '{}',
  /*
    config schema:
    {
      "systemPrompt": "You are a B2B research agent...",
      "defaultInstruction": "Find the company's ICP",
      "inputColumns": ["A", "B"],        -- Which columns to read
      "instructionColumn": "C",           -- Optional per-row instructions
      "outputColumn": "D",               -- Where to write results
      "statusColumn": "E",               -- Optional status tracking
      "outputFormat": "1-2 sentences",    -- Output constraint
      "tools": ["web_scrape", "search"],  -- Enabled tools
      "model": "claude-sonnet-4-5-20250514",
      "maxTokens": 500,
      "skipCompleted": true,              -- Skip rows with existing output
      "batchSize": 1,                     -- Rows per batch (1 = row-by-row)
    }
  */
  
  -- Column mapping (denormalized for quick access)
  input_columns TEXT[] DEFAULT '{}',
  output_column TEXT,
  status_column TEXT,
  instruction_column TEXT,
  
  -- Stats
  total_runs INTEGER DEFAULT 0,
  total_rows_processed INTEGER DEFAULT 0,
  last_run_at TIMESTAMPTZ,
  avg_cost_per_row DECIMAL(10, 6),
  
  -- Sharing
  is_public BOOLEAN DEFAULT FALSE,
  shared_with TEXT[] DEFAULT '{}',       -- Email addresses
  
  -- Metadata
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_agents_user_id ON agents(user_id);
CREATE INDEX idx_agents_public ON agents(is_public) WHERE is_public = TRUE;

-- ============================================================
-- AGENT RUNS
-- ============================================================
-- Each execution of an agent on a sheet. Tracks progress and status.

CREATE TYPE run_status AS ENUM ('queued', 'running', 'complete', 'stopped', 'error');

CREATE TABLE IF NOT EXISTS agent_runs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  agent_id UUID REFERENCES agents(id) ON DELETE SET NULL,
  user_id UUID REFERENCES agent_users(id) ON DELETE CASCADE,
  
  -- Sheet context
  spreadsheet_id TEXT NOT NULL,
  sheet_name TEXT NOT NULL,
  
  -- Run configuration (snapshot of agent config at run time)
  config JSONB NOT NULL DEFAULT '{}',
  
  -- Progress
  status run_status DEFAULT 'queued',
  total_rows INTEGER DEFAULT 0,
  completed_rows INTEGER DEFAULT 0,
  error_rows INTEGER DEFAULT 0,
  current_row INTEGER,
  current_company TEXT,                  -- For display in progress bar
  
  -- Cost tracking
  total_input_tokens INTEGER DEFAULT 0,
  total_output_tokens INTEGER DEFAULT 0,
  total_cost DECIMAL(10, 6) DEFAULT 0,
  
  -- Errors
  errors JSONB DEFAULT '[]',
  /*
    errors schema:
    [{ "row": 5, "error": "Failed to scrape website", "timestamp": "..." }]
  */
  
  -- Timing
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_runs_user_id ON agent_runs(user_id);
CREATE INDEX idx_runs_status ON agent_runs(status) WHERE status IN ('queued', 'running');
CREATE INDEX idx_runs_spreadsheet ON agent_runs(spreadsheet_id);

-- ============================================================
-- RUN ROWS
-- ============================================================
-- Individual row results within a run. Enables retry, audit, and debugging.

CREATE TABLE IF NOT EXISTS run_rows (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  run_id UUID REFERENCES agent_runs(id) ON DELETE CASCADE,
  
  -- Row info
  row_number INTEGER NOT NULL,
  input_data JSONB NOT NULL DEFAULT '{}',    -- Snapshot of input cells
  instruction TEXT,                           -- The instruction for this row
  
  -- Result
  output TEXT,                               -- The generated output
  status TEXT DEFAULT 'pending',             -- pending, processing, complete, error
  error TEXT,
  
  -- AI metadata
  prompt TEXT,                               -- Full prompt sent to LLM
  input_tokens INTEGER,
  output_tokens INTEGER,
  cost DECIMAL(10, 6),
  model TEXT,
  latency_ms INTEGER,
  
  -- Timing
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_run_rows_run_id ON run_rows(run_id);
CREATE INDEX idx_run_rows_status ON run_rows(status) WHERE status IN ('pending', 'processing');

-- ============================================================
-- GOOGLE SHEETS CREDENTIALS
-- ============================================================
-- Stores service account credentials per user for async write-back.

CREATE TABLE IF NOT EXISTS sheet_credentials (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID REFERENCES agent_users(id) ON DELETE CASCADE,
  spreadsheet_id TEXT NOT NULL,
  
  -- The user's OAuth refresh token or service account key
  -- (encrypted at rest via Supabase Vault in production)
  credential_type TEXT DEFAULT 'service_account',  -- service_account, oauth
  credentials JSONB NOT NULL DEFAULT '{}',
  
  -- Permissions
  scopes TEXT[] DEFAULT ARRAY['https://www.googleapis.com/auth/spreadsheets'],
  
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  
  UNIQUE(user_id, spreadsheet_id)
);

-- ============================================================
-- FUNCTIONS
-- ============================================================

-- Auto-update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_agent_users_timestamp BEFORE UPDATE ON agent_users
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER update_agents_timestamp BEFORE UPDATE ON agents
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- Increment agent run stats after a run completes
CREATE OR REPLACE FUNCTION update_agent_stats()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.status IN ('complete', 'stopped') AND OLD.status = 'running' THEN
    UPDATE agents SET
      total_runs = total_runs + 1,
      total_rows_processed = total_rows_processed + NEW.completed_rows,
      last_run_at = NOW(),
      avg_cost_per_row = CASE 
        WHEN total_rows_processed + NEW.completed_rows > 0 
        THEN (COALESCE(avg_cost_per_row, 0) * total_rows_processed + NEW.total_cost) / (total_rows_processed + NEW.completed_rows)
        ELSE 0
      END
    WHERE id = NEW.agent_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_agent_stats_trigger AFTER UPDATE ON agent_runs
  FOR EACH ROW EXECUTE FUNCTION update_agent_stats();

-- ============================================================
-- ROW LEVEL SECURITY
-- ============================================================

ALTER TABLE agent_users ENABLE ROW LEVEL SECURITY;
ALTER TABLE agents ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE run_rows ENABLE ROW LEVEL SECURITY;

-- Users can only see their own data
-- (In production, use Supabase Auth JWT. For edge functions with service role, these are bypassed.)

CREATE POLICY "users_own_data" ON agent_users
  FOR ALL USING (email = current_setting('request.jwt.claims')::json->>'email');

CREATE POLICY "agents_own_data" ON agents
  FOR ALL USING (
    user_id IN (SELECT id FROM agent_users WHERE email = current_setting('request.jwt.claims')::json->>'email')
    OR is_public = TRUE
  );

CREATE POLICY "runs_own_data" ON agent_runs
  FOR ALL USING (
    user_id IN (SELECT id FROM agent_users WHERE email = current_setting('request.jwt.claims')::json->>'email')
  );

CREATE POLICY "run_rows_own_data" ON run_rows
  FOR ALL USING (
    run_id IN (
      SELECT id FROM agent_runs WHERE user_id IN (
        SELECT id FROM agent_users WHERE email = current_setting('request.jwt.claims')::json->>'email'
      )
    )
  );
