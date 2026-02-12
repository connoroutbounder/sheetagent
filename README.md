# ⚡ Google Sheets Agent Builder

A sidebar-native AI agent builder for Google Sheets. Build, configure, and run AI agents that process your spreadsheet data row by row — through natural language conversation.

## How It Works

1. **Open the sidebar** in any Google Sheet
2. **Describe what you need** — "For each company, visit their website and find their ICP"
3. **The agent analyzes your sheet** — detects headers, data types, input/output columns
4. **Approve the plan** and watch it run — results stream into your sheet in real time
5. **Save as a reusable agent** — run it again on any sheet with a similar structure

## Architecture

```
┌─────────────────────────────┐
│   Google Sheets Sidebar     │  ← Chat UI + Sheet Context Reader
│   (Apps Script HTML)        │
└─────────────┬───────────────┘
              │ UrlFetchApp (webhook)
┌─────────────▼───────────────┐
│   Apps Script Relay         │  ← Auth bridge, Sheet R/W, trigger mgmt
│   (Code.gs)                 │
└─────────────┬───────────────┘
              │ HTTPS
┌─────────────▼───────────────┐
│   Supabase Edge Functions   │  ← Agent orchestration, CRUD, status
│   (Deno/TypeScript)         │
└─────────────┬───────────────┘
              │
┌─────────────▼───────────────┐
│   AI Execution Engine       │  ← Claude API + Tools (scrape, search)
│   (Claude Sonnet 4.5)       │
└─────────────────────────────┘
```

## Project Structure

```
sheets-agent-builder/
├── apps-script/                    # Google Sheets Add-on
│   ├── Code.gs                     # Entry point, menu, triggers
│   ├── SheetContext.gs             # Sheet intelligence (headers, types, analysis)
│   ├── ApiClient.gs               # HTTP client for backend
│   ├── sidebar.html               # Chat UI (HTML + CSS + JS)
│   ├── settings.html              # Settings dialog
│   └── appsscript.json            # Manifest & OAuth scopes
├── supabase/                       # Backend
│   ├── functions/
│   │   ├── agent-run/index.ts     # Chat + row processing orchestrator
│   │   ├── agent-crud/index.ts    # Save/load/delete agents
│   │   ├── agent-status/index.ts  # Job progress polling
│   │   └── sheets-callback/       # Write-back fallback
│   ├── migrations/
│   │   └── 001_agents.sql         # DB schema (agents, runs, users)
│   └── lib/
│       ├── prompt-builder.ts      # System/row prompt assembly
│       ├── tools.ts               # Web scrape, search, extract
│       ├── sheets-api.ts          # Google Sheets API v4 wrapper
│       └── types.ts               # Shared TypeScript types
├── package.json
└── README.md
```

## Setup

### Prerequisites

- [Supabase CLI](https://supabase.com/docs/guides/cli) installed
- [clasp](https://github.com/google/clasp) (Google Apps Script CLI) installed
- A Supabase project
- Anthropic API key
- Firecrawl API key (for web scraping) — optional
- Serper API key (for web search) — optional

### 1. Supabase Backend

```bash
# Link to your Supabase project
supabase link --project-ref YOUR_PROJECT_REF

# Run the database migration
supabase db push

# Set environment variables
supabase secrets set ANTHROPIC_API_KEY=sk-ant-...
supabase secrets set FIRECRAWL_API_KEY=fc-...
supabase secrets set SERPER_API_KEY=...

# Deploy edge functions
supabase functions deploy agent-run
supabase functions deploy agent-crud
supabase functions deploy agent-status
supabase functions deploy sheets-callback
```

### 2. Google Sheets Add-on

```bash
# Login to clasp
clasp login

# Create a new Apps Script project (or clone existing)
cd apps-script
clasp create --type sheets --title "Agent Builder"

# Push the code
clasp push

# Open in browser to test
clasp open
```

### 3. Configure the Add-on

1. Open any Google Sheet
2. Go to **Extensions → Apps Script**
3. In Script Properties, set `BACKEND_URL` to your Supabase functions URL:
   ```
   https://YOUR_PROJECT.supabase.co/functions/v1
   ```
4. Reload the sheet — you'll see the **⚡ Agent Builder** menu

### 4. Service Account (for async write-back)

For the backend to write results directly to sheets:

1. Create a service account in Google Cloud Console
2. Enable the Google Sheets API
3. Download the JSON key
4. Share your target spreadsheets with the service account email
5. Upload the key via the sheets-callback endpoint:

```bash
curl -X POST YOUR_SUPABASE_URL/functions/v1/sheets-callback \
  -H "Content-Type: application/json" \
  -H "X-User-Email: you@example.com" \
  -d '{
    "action": "store_credentials",
    "spreadsheetId": "YOUR_SHEET_ID",
    "credentials": { ...service_account_json... }
  }'
```

## Key Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| **Execution model** | Row-by-row (v1) | Better UX with real-time progress; optimize to micro-batches later |
| **Apps Script role** | Relay only | Avoids 6-min execution limit; backend owns all processing |
| **Auth strategy** | Hybrid | Apps Script reads (user's auth), backend writes (service account) |
| **Agent storage** | Supabase Postgres | Portable, shareable, enables future marketplace |
| **AI model** | Claude Sonnet 4.5 | Best balance of quality, speed, and cost for row processing |
| **Write-back** | Service account + fallback | Primary: direct Sheets API; Fallback: relay through Apps Script |

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `ANTHROPIC_API_KEY` | ✅ | Claude API key |
| `SUPABASE_URL` | ✅ | Auto-set by Supabase |
| `SUPABASE_SERVICE_ROLE_KEY` | ✅ | Auto-set by Supabase |
| `FIRECRAWL_API_KEY` | Optional | For web scraping (falls back to basic fetch) |
| `SERPER_API_KEY` | Optional | For web search |

## Database Schema

**4 core tables:**

- **`agent_users`** — User tracking by Google email
- **`agents`** — Saved agent configurations (prompt, column mapping, tools)
- **`agent_runs`** — Execution history with progress tracking
- **`run_rows`** — Per-row results, costs, and error logs

All tables have RLS policies. Edge functions use the service role to bypass.

## Cost Estimates

Using Claude Sonnet 4.5 ($3/M input, $15/M output):

| Scenario | Input tokens/row | Output tokens/row | Cost/row | 100 rows |
|----------|-----------------|-------------------|----------|----------|
| Simple lookup | ~500 | ~100 | ~$0.003 | ~$0.30 |
| With web scrape | ~2,000 | ~150 | ~$0.008 | ~$0.80 |
| With scrape + search | ~3,500 | ~200 | ~$0.014 | ~$1.40 |

## Roadmap

- [ ] Agent marketplace (share agents between users)
- [ ] Micro-batch processing (5 rows at a time)
- [ ] Scheduled runs (daily/weekly triggers)
- [ ] Multi-sheet workflows (read from one, write to another)
- [ ] Custom tool registration (user-provided APIs)
- [ ] Claude Haiku fallback for bulk/simple tasks
- [ ] Usage dashboard and billing
