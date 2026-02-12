/**
 * ============================================================
 * agent-status/index.ts — Job Status Polling Endpoint
 * ============================================================
 * Called every 2 seconds by the sidebar to get progress updates
 * for a running agent job. Returns row count, current row, 
 * and completion status.
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-User-Email',
      },
    });
  }

  try {
    const url = new URL(req.url);
    const jobId = url.searchParams.get('jobId');

    if (!jobId) {
      return json({ error: 'Missing jobId parameter' }, 400);
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    const { data: run, error } = await supabase
      .from('agent_runs')
      .select('status, total_rows, completed_rows, error_rows, current_row, current_company, errors, config')
      .eq('id', jobId)
      .single();

    if (error || !run) {
      return json({ error: 'Job not found' }, 404);
    }

    // Fetch completed rows that haven't been written to the sheet yet
    const { data: pendingRows } = await supabase
      .from('run_rows')
      .select('row_number, output, status')
      .eq('run_id', jobId)
      .eq('status', 'complete')
      .eq('written_to_sheet', false);

    // Build pending writes array for the sidebar to handle
    const pendingWrites = (pendingRows || []).map((r: any) => ({
      row: r.row_number,
      output: r.output,
    }));

    // If sidebar acknowledges writes, mark them as written
    const ackRows = url.searchParams.get('ackRows');
    if (ackRows) {
      const rowNumbers = ackRows.split(',').map(Number).filter(n => !isNaN(n));
      if (rowNumbers.length > 0) {
        await supabase
          .from('run_rows')
          .update({ written_to_sheet: true })
          .eq('run_id', jobId)
          .in('row_number', rowNumbers);
      }
    }

    return json({
      status: run.status,
      totalRows: run.total_rows,
      completedRows: run.completed_rows,
      errorRows: run.error_rows,
      currentRow: run.current_row,
      currentCompany: run.current_company,
      errors: run.error_rows > 0 ? (run.errors || []).slice(-5) : [],
      pendingWrites,
      outputColumn: run.config?.outputColumn || 'B',
      statusColumn: run.config?.statusColumn || null,
    });
  } catch (error) {
    console.error('Status error:', error);
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
