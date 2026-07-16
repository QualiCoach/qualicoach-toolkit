// ============================================================================
// review-draft.js
// POST endpoint used by admin/review.html. This is the single choke point
// where a human decision turns into a status change — nothing else in the
// system is allowed to move a draft out of pending_review.
//
// Body: { draft_id: string, action: 'approve' | 'reject', reviewer_notes?: string }
//
// NOTE: approving a draft here does NOT publish it yet. Publishing (pushing
// to Squarespace/Gmail/Stripe/Calendar) is deliberately out of scope for
// this foundation step — it gets built per-system, once each system's
// publisher exists (see the architecture doc, Section 10, steps 2+).
// For now, "approved" just means "cleared for publishing whenever that
// step exists" and is a safe, inspectable stopping point.
// ============================================================================

const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const VALID_ACTIONS = new Set(['approve', 'reject']);

exports.handler = async (event) => {
  const token = event.headers['x-admin-token'];
  if (!token || token !== process.env.ADMIN_TOKEN) {
    return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized' }) };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON body' }) };
  }

  const { draft_id, action, reviewer_notes } = body;

  if (!draft_id || !VALID_ACTIONS.has(action)) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: 'draft_id and a valid action (approve|reject) are required' }),
    };
  }

  const { data: existing, error: fetchError } = await supabase
    .from('orchestration_drafts')
    .select('id, status')
    .eq('id', draft_id)
    .single();

  if (fetchError || !existing) {
    return { statusCode: 404, body: JSON.stringify({ error: 'Draft not found' }) };
  }

  if (existing.status !== 'pending_review') {
    return {
      statusCode: 409,
      body: JSON.stringify({ error: `Draft is already "${existing.status}", not pending_review` }),
    };
  }

  const newStatus = action === 'approve' ? 'approved' : 'rejected';
  const update = {
    status: newStatus,
    reviewer_notes: reviewer_notes || null,
  };
  if (newStatus === 'approved') {
    update.approved_at = new Date().toISOString();
  }

  const { error: updateError } = await supabase
    .from('orchestration_drafts')
    .update(update)
    .eq('id', draft_id);

  if (updateError) {
    return { statusCode: 500, body: JSON.stringify({ error: updateError.message }) };
  }

  return {
    statusCode: 200,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ draft_id, status: newStatus }),
  };
};
