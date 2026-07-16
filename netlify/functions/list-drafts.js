// ============================================================================
// list-drafts.js
// GET endpoint used by admin/review.html. Returns drafts pending review
// (plus a small window of recently-decided ones for context), newest first.
//
// Auth: single shared-secret header, since this is a single-user internal
// tool. If QualiCoach ever adds a second reviewer, swap this for Supabase
// Auth — the query logic below doesn't change.
// ============================================================================

const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

exports.handler = async (event) => {
  const token = event.headers['x-admin-token'];
  if (!token || token !== process.env.ADMIN_TOKEN) {
    return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized' }) };
  }

  const { data: pending, error: pendingError } = await supabase
    .from('orchestration_drafts')
    .select('id, job_id, draft_type, system, title, content, status, created_at')
    .eq('status', 'pending_review')
    .order('created_at', { ascending: false })
    .limit(100);

  if (pendingError) {
    return { statusCode: 500, body: JSON.stringify({ error: pendingError.message }) };
  }

  const { data: recent, error: recentError } = await supabase
    .from('orchestration_drafts')
    .select('id, job_id, draft_type, system, title, status, reviewer_notes, approved_at, created_at')
    .neq('status', 'pending_review')
    .order('created_at', { ascending: false })
    .limit(20);

  if (recentError) {
    return { statusCode: 500, body: JSON.stringify({ error: recentError.message }) };
  }

  return {
    statusCode: 200,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pending, recent }),
  };
};
