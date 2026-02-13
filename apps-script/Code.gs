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
 * Homepage trigger for the add-on card interface.
 * Called when the add-on is opened from the Extensions menu.
 * Opens the sidebar automatically.
 */
function onHomepage(e) {
  showSidebar();
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
 * Writes multiple rows of data to the sheet, starting at the first empty row.
 * Used for bulk imports (e.g. pulling data from an Apollo list).
 *
 * @param {Object} bulkWrite - { columns: ["A","B"], rows: [["val1","val2"], ...], startRow?: number }
 * @returns {Object} { success, rowsWritten, startRow }
 */
function writeBulkRows(bulkWrite) {
  // Support writing to a specific sheet by name, or fall back to active sheet
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet;
  if (bulkWrite.sheetName) {
    sheet = ss.getSheetByName(bulkWrite.sheetName);
    if (!sheet) {
      // Create the sheet if it doesn't exist
      sheet = ss.insertSheet(bulkWrite.sheetName);
    }
  } else {
    sheet = ss.getActiveSheet();
  }
  var columns = bulkWrite.columns || ['A', 'B'];
  var rows = bulkWrite.rows || [];
  
  if (rows.length === 0) {
    return { success: false, error: 'No rows to write' };
  }
  
  // Find the first empty row after existing data
  var startRow = bulkWrite.startRow;
  if (!startRow) {
    var lastRow = sheet.getLastRow();
    startRow = lastRow + 1;
    // Safety: never write before row 2 (row 1 is headers)
    if (startRow < 2) startRow = 2;
  }
  
  // Convert column letters to 1-based column indices (A=1, B=2, ..., Z=26, AA=27, etc.)
  var colIndices = columns.map(function(c) {
    var idx = 0;
    for (var i = 0; i < c.length; i++) {
      idx = idx * 26 + (c.charCodeAt(i) - 64);
    }
    return idx;
  });
  
  var minCol = Math.min.apply(null, colIndices);
  var maxCol = Math.max.apply(null, colIndices);
  var numCols = maxCol - minCol + 1;
  
  // Build a 2D values array for batch setValues (MUCH faster than cell-by-cell)
  var values = [];
  for (var i = 0; i < rows.length; i++) {
    var row = new Array(numCols);
    // Fill with existing cell values first (preserve data in columns we're not writing to)
    for (var k = 0; k < numCols; k++) {
      row[k] = '';
    }
    // Place values at the correct column offsets
    for (var j = 0; j < columns.length; j++) {
      var colOffset = colIndices[j] - minCol;
      row[colOffset] = (j < rows[i].length) ? (rows[i][j] || '') : '';
    }
    values.push(row);
  }
  
  // Single batch write — 100-1000x faster than individual setValue calls
  var range = sheet.getRange(startRow, minCol, rows.length, numCols);
  range.setValues(values);
  SpreadsheetApp.flush();
  
  return { success: true, rowsWritten: rows.length, startRow: startRow };
}

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
    zerobounceApiKey: props.getProperty('zerobounce_api_key') ? '••••••••' : '',
    hasZerobounceApiKey: !!props.getProperty('zerobounce_api_key'),
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
  if (settings.zerobounceApiKey && settings.zerobounceApiKey !== '••••••••') {
    PropertiesService.getUserProperties().setProperty('zerobounce_api_key', settings.zerobounceApiKey);
  }
  return { success: true };
}

/**
 * Tests the Apollo.io API connection using the user's saved key.
 * Makes a lightweight search call to verify the key works.
 */
function testApolloConnection() {
  var key = PropertiesService.getUserProperties().getProperty('apollo_api_key');
  if (!key) {
    return { success: false, message: 'No Apollo API key saved. Enter your key and click Save first.' };
  }
  
  try {
    var response = UrlFetchApp.fetch('https://api.apollo.io/api/v1/mixed_people/api_search', {
      method: 'post',
      contentType: 'application/json',
      headers: { 'X-Api-Key': key },
      payload: JSON.stringify({
        api_key: key,
        q_organization_domains: 'apollo.io',
        per_page: 1,
      }),
      muteHttpExceptions: true,
    });
    
    var code = response.getResponseCode();
    if (code === 200) {
      var data = JSON.parse(response.getContentText());
      var count = (data.people || []).length;
      return { success: true, message: '✅ Apollo.io connected! Found ' + count + ' test result(s).' };
    } else if (code === 401 || code === 403) {
      return { success: false, message: 'Invalid API key (HTTP ' + code + '). Check your key at Apollo Settings.' };
    } else {
      return { success: false, message: 'Apollo returned HTTP ' + code + ': ' + response.getContentText().substring(0, 200) };
    }
  } catch(e) {
    return { success: false, message: 'Connection failed: ' + e.toString() };
  }
}

/**
 * Tests the ZeroBounce API connection using the user's saved key.
 * Makes a lightweight credits check to verify the key works.
 */
function testZerobounceConnection() {
  var key = PropertiesService.getUserProperties().getProperty('zerobounce_api_key');
  if (!key) {
    return { success: false, message: 'No ZeroBounce API key saved. Enter your key and click Save first.' };
  }
  
  try {
    var response = UrlFetchApp.fetch('https://api.zerobounce.net/v2/getcredits?api_key=' + encodeURIComponent(key), {
      muteHttpExceptions: true,
    });
    
    var code = response.getResponseCode();
    if (code === 200) {
      var data = JSON.parse(response.getContentText());
      if (data.Credits !== undefined) {
        return { success: true, message: '✅ ZeroBounce connected! Credits remaining: ' + data.Credits };
      }
      return { success: false, message: 'Invalid API key — no credits data returned.' };
    } else {
      return { success: false, message: 'ZeroBounce returned HTTP ' + code + '. Check your API key.' };
    }
  } catch(e) {
    return { success: false, message: 'Connection failed: ' + e.toString() };
  }
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
