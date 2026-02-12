/**
 * ============================================================
 * agent-crud/index.ts — Agent CRUD Operations
 * ============================================================
 * Handles saving, listing, loading, and deleting agent configs.
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
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-User-Email',
      },
    });
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const userEmail = req.headers.get('X-User-Email');

  try {
    if (req.method === 'GET') {
      const url = new URL(req.url);
      const action = url.searchParams.get('action');
      const email = url.searchParams.get('email') || userEmail;

      // Health check
      if (action === 'ping') {
        return json({ success: true, message: 'Agent Builder API is running' });
      }

      // List agents
      if (action === 'list') {
        const { data: user } = await supabase
          .from('agent_users')
          .select('id')
          .eq('email', email)
          .single();

        if (!user) return json({ agents: [] });

        const { data: agents, error } = await supabase
          .from('agents')
          .select('id, name, description, icon, config, total_runs, last_run_at, created_at, updated_at')
          .eq('user_id', user.id)
          .order('updated_at', { ascending: false });

        if (error) return json({ error: error.message }, 500);

        return json({
          agents: (agents || []).map(a => ({
            id: a.id,
            name: a.name,
            description: a.description,
            icon: a.icon,
            runs: a.total_runs,
            lastRun: a.last_run_at,
            config: a.config,
            createdAt: a.created_at,
          })),
        });
      }

      // Get single agent
      if (action === 'get') {
        const agentId = url.searchParams.get('id');
        const { data: agent, error } = await supabase
          .from('agents')
          .select('*')
          .eq('id', agentId)
          .single();

        if (error || !agent) return json({ error: 'Agent not found' }, 404);
        return json({ agent });
      }

      return json({ error: 'Unknown action' }, 400);
    }

    if (req.method === 'POST') {
      const body = await req.json();
      const email = body.userEmail || userEmail;

      // Register user
      if (body.action === 'register') {
        const { data: existing } = await supabase
          .from('agent_users')
          .select('id')
          .eq('email', email)
          .single();

        if (existing) {
          return json({ token: 'ok', userId: existing.id });
        }

        const { data: newUser, error } = await supabase
          .from('agent_users')
          .insert({
            email,
            spreadsheet_ids: body.spreadsheetId ? [body.spreadsheetId] : [],
          })
          .select('id')
          .single();

        if (error) return json({ error: error.message }, 500);
        return json({ token: 'ok', userId: newUser.id });
      }

      // Save agent
      if (body.action === 'save') {
        const { data: user } = await supabase
          .from('agent_users')
          .select('id')
          .eq('email', email)
          .single();

        if (!user) return json({ error: 'User not found' }, 404);

        const config = body.agentConfig;

        // Upsert: update if ID exists, insert if not
        if (config.id) {
          const { data, error } = await supabase
            .from('agents')
            .update({
              name: config.name,
              description: config.description,
              config: config,
              input_columns: config.inputColumns || [],
              output_column: config.outputColumn,
              status_column: config.statusColumn,
              instruction_column: config.instructionColumn,
            })
            .eq('id', config.id)
            .eq('user_id', user.id)
            .select('id')
            .single();

          if (error) return json({ error: error.message }, 500);
          return json({ success: true, agentId: data.id });
        } else {
          const { data, error } = await supabase
            .from('agents')
            .insert({
              user_id: user.id,
              name: config.name || 'Untitled Agent',
              description: config.description || '',
              icon: config.icon || '🤖',
              config: config,
              input_columns: config.inputColumns || [],
              output_column: config.outputColumn,
              status_column: config.statusColumn,
              instruction_column: config.instructionColumn,
            })
            .select('id')
            .single();

          if (error) return json({ error: error.message }, 500);
          return json({ success: true, agentId: data.id });
        }
      }

      // Delete agent
      if (body.action === 'delete') {
        const { data: user } = await supabase
          .from('agent_users')
          .select('id')
          .eq('email', email)
          .single();

        if (!user) return json({ error: 'User not found' }, 404);

        const { error } = await supabase
          .from('agents')
          .delete()
          .eq('id', body.agentId)
          .eq('user_id', user.id);

        if (error) return json({ error: error.message }, 500);
        return json({ success: true });
      }

      return json({ error: 'Unknown action' }, 400);
    }

    return json({ error: 'Method not allowed' }, 405);
  } catch (error) {
    console.error('Agent CRUD error:', error);
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
