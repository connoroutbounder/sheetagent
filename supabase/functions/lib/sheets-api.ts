/**
 * ============================================================
 * sheets-api.ts — Google Sheets API v4 Wrapper
 * ============================================================
 * Handles reading from and writing to Google Sheets from the
 * backend. Uses a service account for async operations.
 */

// =============================================================
// TYPES
// =============================================================

interface SheetsConfig {
  spreadsheetId: string;
  serviceAccountKey?: any; // Parsed JSON key
  accessToken?: string;    // OAuth token from Apps Script
}

interface CellUpdate {
  cell: string;   // A1 notation: "D3"
  value: string;
}

interface BatchUpdate {
  sheetName: string;
  updates: CellUpdate[];
}

// =============================================================
// GOOGLE AUTH
// =============================================================

/**
 * Gets an access token from a service account key.
 * Uses the JWT grant flow (no user interaction needed).
 */
async function getServiceAccountToken(key: any): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  
  // Build JWT header and claims
  const header = { alg: 'RS256', typ: 'JWT' };
  const claims = {
    iss: key.client_email,
    scope: 'https://www.googleapis.com/auth/spreadsheets',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  };
  
  // Encode JWT
  const encoder = new TextEncoder();
  const headerB64 = btoa(JSON.stringify(header)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  const claimsB64 = btoa(JSON.stringify(claims)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  const unsignedJwt = `${headerB64}.${claimsB64}`;
  
  // Sign with service account private key
  const privateKey = await crypto.subtle.importKey(
    'pkcs8',
    pemToArrayBuffer(key.private_key),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  );
  
  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    privateKey,
    encoder.encode(unsignedJwt)
  );
  
  const signatureB64 = btoa(String.fromCharCode(...new Uint8Array(signature)))
    .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  
  const jwt = `${unsignedJwt}.${signatureB64}`;
  
  // Exchange JWT for access token
  const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`,
  });
  
  const tokenData = await tokenResponse.json();
  
  if (!tokenData.access_token) {
    throw new Error(`Auth failed: ${JSON.stringify(tokenData)}`);
  }
  
  return tokenData.access_token;
}

/**
 * Converts PEM private key to ArrayBuffer for crypto.subtle.
 */
function pemToArrayBuffer(pem: string): ArrayBuffer {
  const b64 = pem
    .replace('-----BEGIN PRIVATE KEY-----', '')
    .replace('-----END PRIVATE KEY-----', '')
    .replace(/\s/g, '');
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

// =============================================================
// SHEETS CLIENT
// =============================================================

export class SheetsClient {
  private spreadsheetId: string;
  private accessToken: string | null = null;
  private serviceAccountKey: any;
  
  constructor(config: SheetsConfig) {
    this.spreadsheetId = config.spreadsheetId;
    this.accessToken = config.accessToken || null;
    this.serviceAccountKey = config.serviceAccountKey;
  }
  
  /**
   * Ensures we have a valid access token.
   */
  private async ensureAuth(): Promise<string> {
    if (this.accessToken) return this.accessToken;
    
    if (this.serviceAccountKey) {
      this.accessToken = await getServiceAccountToken(this.serviceAccountKey);
      return this.accessToken;
    }
    
    throw new Error('No authentication method available. Provide accessToken or serviceAccountKey.');
  }
  
  /**
   * Writes a single value to a cell.
   */
  async writeCell(sheetName: string, cell: string, value: string): Promise<void> {
    const token = await this.ensureAuth();
    const range = `'${sheetName}'!${cell}`;
    
    const response = await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${this.spreadsheetId}/values/${encodeURIComponent(range)}?valueInputOption=USER_ENTERED`,
      {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          range,
          majorDimension: 'ROWS',
          values: [[value]],
        }),
      }
    );
    
    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Sheets API error (${response.status}): ${error}`);
    }
  }
  
  /**
   * Writes multiple cells in a single batch request.
   * This is the primary write method — more efficient than individual writes.
   */
  async writeBatch(sheetName: string, updates: CellUpdate[]): Promise<void> {
    if (updates.length === 0) return;
    
    const token = await this.ensureAuth();
    
    const data = updates.map(u => ({
      range: `'${sheetName}'!${u.cell}`,
      majorDimension: 'ROWS',
      values: [[u.value]],
    }));
    
    const response = await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${this.spreadsheetId}/values:batchUpdate`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          valueInputOption: 'USER_ENTERED',
          data,
        }),
      }
    );
    
    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Sheets batch write error (${response.status}): ${error}`);
    }
  }
  
  /**
   * Reads a range of cells.
   */
  async readRange(sheetName: string, range: string): Promise<any[][]> {
    const token = await this.ensureAuth();
    const fullRange = `'${sheetName}'!${range}`;
    
    const response = await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${this.spreadsheetId}/values/${encodeURIComponent(fullRange)}`,
      {
        headers: {
          'Authorization': `Bearer ${token}`,
        },
      }
    );
    
    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Sheets read error (${response.status}): ${error}`);
    }
    
    const data = await response.json();
    return data.values || [];
  }
  
  /**
   * Reads a single row by row number (1-indexed).
   */
  async readRow(sheetName: string, rowNumber: number, numCols: number): Promise<any[]> {
    const range = `A${rowNumber}:${colLetter(numCols - 1)}${rowNumber}`;
    const values = await this.readRange(sheetName, range);
    return values[0] || [];
  }
  
  /**
   * Writes the output and status for a processed row.
   * Convenience method for the most common write pattern.
   */
  async writeRowResult(
    sheetName: string,
    rowNumber: number,
    outputCol: string,
    output: string,
    statusCol?: string,
    status?: string
  ): Promise<void> {
    const updates: CellUpdate[] = [
      { cell: `${outputCol}${rowNumber}`, value: output },
    ];
    
    if (statusCol && status) {
      updates.push({ cell: `${statusCol}${rowNumber}`, value: status });
    }
    
    await this.writeBatch(sheetName, updates);
  }
}

/**
 * Helper: converts 0-based column index to letter.
 */
function colLetter(index: number): string {
  let letter = '';
  let temp = index;
  while (temp >= 0) {
    letter = String.fromCharCode((temp % 26) + 65) + letter;
    temp = Math.floor(temp / 26) - 1;
  }
  return letter;
}
