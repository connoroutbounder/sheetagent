/**
 * ============================================================
 * Code.gs — Entry Point for Google Sheets Agent Builder
 * ============================================================
 * Handles menu creation, sidebar launch, triggers, and
 * serves as the bridge between the sidebar UI and Apps Script
 * server-side functions.
 */

// =============================================================
// CONFIG
// =============================================================

const CONFIG = {
  BACKEND_URL: PropertiesService.getScriptProperties().getProperty('BACKEND_URL') || 'https://YOUR_PROJECT.supabase.co/functions/v1',
  SIDEBAR_TITLE: 'Agent Builder',
  POLL_INTERVAL_MS: 2000,
  MAX_POLL_ATTEMPTS: 300, // 10 minutes max
};

// =============================================================
// MENU & TRIGGERS
// =============================================================

/**
 * Creates the custom menu when the spreadsheet opens.
 */
function onOpen(e) {
  SpreadsheetApp.getUi()
    .createMenu('⚡ Agent Builder')
    .addItem('Open Agent Builder', 'showSidebar')
    .addSeparator()
    .addItem('Run Last Agent', 'runLastAgent')
    .addItem('Stop Running Agent', 'stopRunningAgent')
    .addSeparator()
    .addItem('Settings', 'showSettings')
    .addToUi();
}

/**
 * Opens the sidebar chat interface.
 */
function showSidebar() {
  const html = HtmlService.createHtmlOutputFromFile('sidebar')
    .setTitle(CONFIG.SIDEBAR_TITLE)
    .setWidth(380);
  SpreadsheetApp.getUi().showSidebar(html);
}

/**
 * Shows settings dialog for API key configuration.
 */
function showSettings() {
  const html = HtmlService.createHtmlOutputFromFile('settings')
    .setTitle('Agent Builder Settings')
    .setWidth(400)
    .setHeight(300);
  SpreadsheetApp.getUi().showModalDialog(html, 'Agent Builder Settings');
}

/**
 * Homepage trigger for add-on card.
 */
function onHomepage(e) {
  return CardService.newCardBuilder()
    .setHeader(CardService.newCardHeader().setTitle('Agent Builder'))
    .addSection(
      CardService.newCardSection()
        .addWidget(CardService.newTextParagraph().setText('Open the sidebar to start building agents.'))
        .addWidget(
          CardService.newTextButton()
            .setText('Open Sidebar')
            .setOnClickAction(CardService.newAction().setFunctionName('showSidebar'))
        )
    )
    .build();
}

function onFileScopeGranted(e) {
  return onHomepage(e);
}

// =============================================================
// SIDEBAR ↔ SERVER BRIDGE FUNCTIONS
// =============================================================
// These functions are called from the sidebar via google.script.run

/**
 * Gets the full context of the active sheet for the agent.
 * Called when sidebar opens and when user switches sheets.
 */
function getSheetContext() {
  return SheetContext.capture();
}

/**
 * Gets the currently selected range context.
 */
function getSelectionContext() {
  return SheetContext.getSelection();
}

/**
 * Gets the user's email for auth.
 */
function getUserEmail() {
  return Session.getActiveUser().getEmail();
}

/**
 * Gets or creates a session token for backend auth.
 */
function getSessionToken() {
  const userProps = PropertiesService.getUserProperties();
  let token = userProps.getProperty('session_token');
  
  if (!token) {
    // Register with backend and get a session token
    const email = getUserEmail();
    const response = ApiClient.post('/agent-crud', {
      action: 'register',
      email: email,
      spreadsheetId: SpreadsheetApp.getActiveSpreadsheet().getId(),
    });
    
    if (response && response.token) {
      token = response.token;
      userProps.setProperty('session_token', token);
    }
  }
  
  return token;
}

/**
 * Sends user message to backend and returns agent response.
 * This is the main chat endpoint called from the sidebar.
 */
function sendMessage(message, context, history) {
  const payload = {
    action: 'chat',
    message: message,
    sheetContext: context || SheetContext.capture(),
    conversationHistory: history || [],
    spreadsheetId: SpreadsheetApp.getActiveSpreadsheet().getId(),
    sheetName: SpreadsheetApp.getActiveSheet().getName(),
    userEmail: getUserEmail(),
  };
  
  return ApiClient.post('/agent-run', payload);
}

/**
 * Starts an agent run on the current sheet.
 * Returns a jobId that the sidebar can poll for status.
 * If selectedRows is provided, only those rows will be processed.
 */
function startAgentRun(agentConfig, selectedRows) {
  const context = SheetContext.capture();
  
  const payload = {
    action: 'start_run',
    agentConfig: agentConfig,
    sheetContext: context,
    spreadsheetId: SpreadsheetApp.getActiveSpreadsheet().getId(),
    sheetName: SpreadsheetApp.getActiveSheet().getName(),
    userEmail: getUserEmail(),
  };
  
  // If specific rows are selected, override which rows to process
  if (selectedRows && selectedRows.length > 0) {
    payload.selectedRows = selectedRows;
  }
  
  return ApiClient.post('/agent-run', payload);
}

/**
 * Gets the currently selected row numbers in the sheet.
 * Returns an array of 1-indexed row numbers (excluding the header row).
 */
function getSelectedRows() {
  var sheet = SpreadsheetApp.getActiveSheet();
  var selection = sheet.getActiveRange();
  
  if (!selection) {
    return { hasSelection: false, rows: [], count: 0 };
  }
  
  var startRow = selection.getRow();
  var numRows = selection.getNumRows();
  var rows = [];
  
  for (var i = 0; i < numRows; i++) {
    var rowNum = startRow + i;
    if (rowNum > 1) { // Skip header row
      rows.push(rowNum);
    }
  }
  
  return {
    hasSelection: rows.length > 0,
    rows: rows,
    count: rows.length,
    range: selection.getA1Notation(),
  };
}

/**
 * Polls for job status. Called repeatedly from sidebar.
 * Also writes any pending results to the sheet (relay pattern).
 */
function getJobStatus(jobId, ackRows) {
  var url = '/agent-status?jobId=' + jobId;
  if (ackRows && ackRows.length > 0) {
    url += '&ackRows=' + ackRows.join(',');
  }
  
  var status = ApiClient.get(url);
  
  // If there are pending writes, write them to the sheet now
  if (status && status.pendingWrites && status.pendingWrites.length > 0) {
    var sheet = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();
    var outputCol = status.outputColumn || 'B';
    var statusCol = status.statusColumn || null;
    var writtenRows = [];
    
    status.pendingWrites.forEach(function(pw) {
      try {
        sheet.getRange(outputCol + pw.row).setValue(pw.output);
        if (statusCol) {
          sheet.getRange(statusCol + pw.row).setValue('✓ Complete');
        }
        writtenRows.push(pw.row);
      } catch (e) {
        Logger.log('Failed to write row ' + pw.row + ': ' + e.message);
      }
    });
    
    if (writtenRows.length > 0) {
      SpreadsheetApp.flush();
      status._ackRows = writtenRows;
    }
  }
  
  return status;
}

/**
 * Continues processing the next batch of rows for a job.
 * Called by the sidebar when it detects 'batch_complete' status.
 * Sends fresh sheet context so the backend has current row data.
 */
function continueAgentRun(jobId) {
  var context = SheetContext.capture();
  
  var payload = {
    action: 'continue_run',
    jobId: jobId,
    sheetContext: context,
    spreadsheetId: SpreadsheetApp.getActiveSpreadsheet().getId(),
    sheetName: SpreadsheetApp.getActiveSheet().getName(),
    userEmail: getUserEmail(),
  };
  
  return ApiClient.post('/agent-run', payload);
}

/**
 * Stops a running agent job.
 */
function stopRunningAgent(jobId) {
  if (!jobId) {
    const userProps = PropertiesService.getUserProperties();
    jobId = userProps.getProperty('current_job_id');
  }
  
  if (jobId) {
    return ApiClient.post('/agent-run', {
      action: 'stop',
      jobId: jobId,
    });
  }
  
  return { success: false, error: 'No running job found' };
}

/**
 * Runs the last used agent configuration.
 */
function runLastAgent() {
  const userProps = PropertiesService.getUserProperties();
  const lastConfig = userProps.getProperty('last_agent_config');
  
  if (lastConfig) {
    showSidebar();
    return startAgentRun(JSON.parse(lastConfig));
  } else {
    SpreadsheetApp.getUi().alert('No previous agent found. Open Agent Builder to create one.');
  }
}

// =============================================================
// AGENT CRUD (called from sidebar)
// =============================================================

/**
 * Lists all saved agents for the current user.
 */
function listAgents() {
  return ApiClient.get('/agent-crud?action=list&email=' + encodeURIComponent(getUserEmail()));
}

/**
 * Saves an agent configuration.
 */
function saveAgent(agentConfig) {
  return ApiClient.post('/agent-crud', {
    action: 'save',
    agentConfig: agentConfig,
    userEmail: getUserEmail(),
  });
}

/**
 * Deletes a saved agent.
 */
function deleteAgent(agentId) {
  return ApiClient.post('/agent-crud', {
    action: 'delete',
    agentId: agentId,
    userEmail: getUserEmail(),
  });
}

// =============================================================
// SHEET WRITE-BACK (called from backend via Apps Script Web App)
// =============================================================

/**
 * Writes a value to a specific cell. Used by the backend
 * as a fallback write-back method if service account isn't set up.
 */
function writeCell(sheetName, cell, value) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(sheetName);
  if (sheet) {
    sheet.getRange(cell).setValue(value);
    SpreadsheetApp.flush();
    return { success: true };
  }
  return { success: false, error: 'Sheet not found: ' + sheetName };
}

/**
 * Writes multiple values in batch.
 */
function writeBatch(sheetName, updates) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(sheetName);
  if (!sheet) return { success: false, error: 'Sheet not found' };
  
  updates.forEach(function(update) {
    sheet.getRange(update.cell).setValue(update.value);
  });
  
  SpreadsheetApp.flush();
  return { success: true, count: updates.length };
}

// =============================================================
// SETTINGS MANAGEMENT
// =============================================================

/**
 * Gets current settings.
 */
function getSettings() {
  const props = PropertiesService.getUserProperties();
  return {
    backendUrl: PropertiesService.getScriptProperties().getProperty('BACKEND_URL') || '',
    apiKey: props.getProperty('api_key') ? '••••••••' : '',
    hasApiKey: !!props.getProperty('api_key'),
    apolloApiKey: props.getProperty('apollo_api_key') ? '••••••••' : '',
    hasApolloApiKey: !!props.getProperty('apollo_api_key'),
  };
}

/**
 * Saves settings.
 */
function saveSettings(settings) {
  if (settings.backendUrl) {
    PropertiesService.getScriptProperties().setProperty('BACKEND_URL', settings.backendUrl);
  }
  if (settings.apiKey && settings.apiKey !== '••••••••') {
    PropertiesService.getUserProperties().setProperty('api_key', settings.apiKey);
  }
  if (settings.apolloApiKey && settings.apolloApiKey !== '••••••••') {
    PropertiesService.getUserProperties().setProperty('apollo_api_key', settings.apolloApiKey);
  }
  return { success: true };
}

/**
 * One-time setup: configure Supabase connection properties.
 * Run this function manually after deploying.
 */
function setupSupabase() {
  const props = PropertiesService.getScriptProperties();
  props.setProperty('BACKEND_URL', 'https://djvyqtiespdxevlqacue.supabase.co/functions/v1');
  props.setProperty('SUPABASE_ANON_KEY', 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRqdnlxdGllc3BkeGV2bHFhY3VlIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzA5MTU0NzAsImV4cCI6MjA4NjQ5MTQ3MH0.LNVXe6oQdNzWo2jA1h5M3ChdjpZ7drOrAkBqtSWjcJ4');
  Logger.log('Supabase properties set successfully!');
}
