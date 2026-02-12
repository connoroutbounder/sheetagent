/**
 * ============================================================
 * sheets-callback/index.ts — Sheet Write-back Endpoint
 * ============================================================
 * Fallback write mechanism: if the backend can't write directly
 * via service account, the sidebar can poll this endpoint and
 * relay writes through Apps Script.
 * 
 * Also handles webhook-style callbacks for async operations.
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-User-Email, X-Spreadsheet-Id',
      },
    });
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  try {
    if (req.method === 'GET') {
      // Poll for pending writes for a specific spreadsheet
      const url = new URL(req.url);
      const spreadsheetId = url.searchParams.get('spreadsheetId') || req.headers.get('X-Spreadsheet-Id');

      if (!spreadsheetId) {
        return json({ error: 'Missing spreadsheetId' }, 400);
      }

      // Get pending writes from a queue table (if you implement one)
      // For now, return empty — the service account handles writes
      return json({ writes: [] });
    }

    if (req.method === 'POST') {
      const body = await req.json();

      // Acknowledge write completion (from Apps Script relay)
      if (body.action === 'write_complete') {
        // Mark the queued write as complete
        return json({ success: true });
      }

      // Store service account credentials
      if (body.action === 'store_credentials') {
        const userEmail = req.headers.get('X-User-Email') || body.userEmail;
        
        const { data: user } = await supabase
          .from('agent_users')
          .select('id')
          .eq('email', userEmail)
          .single();

        if (!user) return json({ error: 'User not found' }, 404);

        const { error } = await supabase
          .from('sheet_credentials')
          .upsert({
            user_id: user.id,
            spreadsheet_id: body.spreadsheetId,
            credential_type: body.credentialType || 'service_account',
            credentials: body.credentials,
          }, {
            onConflict: 'user_id,spreadsheet_id',
          });

        if (error) return json({ error: error.message }, 500);
        return json({ success: true });
      }

      return json({ error: 'Unknown action' }, 400);
    }

    return json({ error: 'Method not allowed' }, 405);
  } catch (error) {
    console.error('Sheets callback error:', error);
    return json({ error: error.message || 'Internal server error' }, 500);
  }
});

function json(body: any, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    },
  });
}
