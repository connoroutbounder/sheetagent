/**
 * ============================================================
 * ApiClient.gs — HTTP Client for Backend Communication
 * ============================================================
 * Handles all communication between Apps Script and the
 * Supabase Edge Functions backend. Includes retry logic,
 * error handling, and auth token management.
 */

const ApiClient = {

  /**
   * Makes a POST request to the backend.
   * 
   * @param {string} endpoint - e.g., '/agent-run'
   * @param {Object} payload - Request body
   * @returns {Object} Parsed response
   */
  post: function(endpoint, payload) {
    return this._request('post', endpoint, payload);
  },

  /**
   * Makes a GET request to the backend.
   * 
   * @param {string} endpoint - e.g., '/agent-status?jobId=xxx'
   * @returns {Object} Parsed response
   */
  get: function(endpoint) {
    return this._request('get', endpoint, null);
  },

  /**
   * Core request handler with retry logic.
   * 
   * @private
   */
  _request: function(method, endpoint, payload) {
    const baseUrl = this._getBaseUrl();
    const url = baseUrl + endpoint;
    const token = this._getAuthToken();
    
    const headers = {
      'Authorization': 'Bearer ' + token,
      'apikey': token,
      'X-Spreadsheet-Id': SpreadsheetApp.getActiveSpreadsheet().getId(),
      'X-User-Email': Session.getActiveUser().getEmail(),
    };
    
    // Pass user-configured external API keys to the backend
    const userProps = PropertiesService.getUserProperties();
    const apolloKey = userProps.getProperty('apollo_api_key');
    if (apolloKey) {
      headers['X-Apollo-Api-Key'] = apolloKey;
    }
    const zerobounceKey = userProps.getProperty('zerobounce_api_key');
    if (zerobounceKey) {
      headers['X-Zerobounce-Api-Key'] = zerobounceKey;
    }
    const getsalesKey = userProps.getProperty('getsales_api_key');
    if (getsalesKey) {
      headers['X-Getsales-Api-Key'] = getsalesKey;
    }
    
    const options = {
      method: method,
      contentType: 'application/json',
      headers: headers,
      muteHttpExceptions: true,
    };
    
    if (payload && method === 'post') {
      options.payload = JSON.stringify(payload);
    }
    
    // Retry up to 3 times with exponential backoff
    let lastError = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const response = UrlFetchApp.fetch(url, options);
        const code = response.getResponseCode();
        const body = response.getContentText();
        
        if (code >= 200 && code < 300) {
          try {
            return JSON.parse(body);
          } catch(e) {
            return { success: true, raw: body };
          }
        }
        
        // Handle specific error codes
        if (code === 401) {
          // Token expired, clear and retry
          PropertiesService.getUserProperties().deleteProperty('session_token');
          if (attempt < 2) {
            Utilities.sleep(1000);
            continue;
          }
        }
        
        if (code === 429) {
          // Rate limited, wait and retry
          const waitMs = Math.pow(2, attempt + 1) * 1000;
          Utilities.sleep(waitMs);
          continue;
        }
        
        lastError = {
          success: false,
          error: 'HTTP ' + code,
          message: body,
        };
        
        // Don't retry 4xx errors (except 401 and 429)
        if (code >= 400 && code < 500) {
          return lastError;
        }
        
      } catch(e) {
        lastError = {
          success: false,
          error: 'Network error',
          message: e.toString(),
        };
      }
      
      // Exponential backoff
      if (attempt < 2) {
        Utilities.sleep(Math.pow(2, attempt) * 1000);
      }
    }
    
    return lastError || { success: false, error: 'Request failed after 3 attempts' };
  },

  /**
   * Gets the backend base URL from script properties.
   * @private
   */
  _getBaseUrl: function() {
    const url = PropertiesService.getScriptProperties().getProperty('BACKEND_URL');
    if (!url) {
      throw new Error('BACKEND_URL not configured. Go to ⚡ Agent Builder → Settings to set it up.');
    }
    return url.replace(/\/$/, ''); // Remove trailing slash
  },

  /**
   * Gets the auth token for Supabase Edge Function requests.
   * Supabase requires the anon key as a Bearer token.
   * @private
   */
  _getAuthToken: function() {
    // Use Supabase anon key from script properties, or fall back to default
    var anonKey = PropertiesService.getScriptProperties().getProperty('SUPABASE_ANON_KEY');
    if (anonKey) return anonKey;
    
    // Default anon key (public by design — Supabase anon keys are client-safe)
    return 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRqdnlxdGllc3BkeGV2bHFhY3VlIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzA5MTU0NzAsImV4cCI6MjA4NjQ5MTQ3MH0.LNVXe6oQdNzWo2jA1h5M3ChdjpZ7drOrAkBqtSWjcJ4';
  },

  /**
   * Tests the backend connection. Called from settings.
   * 
   * @returns {Object} Connection test result
   */
  testConnection: function() {
    try {
      const result = this.get('/agent-crud?action=ping');
      return {
        success: true,
        message: 'Connected to backend successfully',
        result: result,
      };
    } catch(e) {
      return {
        success: false,
        message: 'Connection failed: ' + e.toString(),
      };
    }
  },
};
