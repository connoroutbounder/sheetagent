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
 */
function startAgentRun(agentConfig) {
  const context = SheetContext.capture();
  
  const payload = {
    action: 'start_run',
    agentConfig: agentConfig,
    sheetContext: context,
    spreadsheetId: SpreadsheetApp.getActiveSpreadsheet().getId(),
    sheetName: SpreadsheetApp.getActiveSheet().getName(),
    userEmail: getUserEmail(),
  };
  
  return ApiClient.post('/agent-run', payload);
}

/**
 * Polls for job status. Called repeatedly from sidebar.
 */
function getJobStatus(jobId) {
  return ApiClient.get('/agent-status?jobId=' + jobId);
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
  return { success: true };
}
