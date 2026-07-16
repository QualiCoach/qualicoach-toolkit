// ============================================================================
// job-router.js
// The central orchestration function. Runs on a schedule (see netlify.toml),
// picks up pending jobs, dispatches each to its registered agent via the
// Claude API, and writes the result to orchestration_drafts as
// pending_review. Never publishes anything itself — see the review-draft
// function and, later, the per-system publisher functions.
//
// Required env vars (set in Netlify site settings, never committed):
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY   (service role — server-side only, bypasses RLS)
//   ANTHROPIC_API_KEY
// ============================================================================

const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const DEFAULT_MAX_TOKENS = 4096;
const BATCH_SIZE = 5; // jobs processed per invocation, kept small and sequential

// Standard (post-introductory) per-million-token pricing in USD.
// Verify current rates at https://platform.claude.com/docs/en/about-claude/pricing
// before relying on this for real budgeting — Anthropic's introductory
// pricing for Sonnet 5 ($2/$10) runs through Aug 31, 2026, after which
// standard pricing ($3/$15, reflected below) applies. Using the standard
// rate here so cost estimates don't silently under-report once intro
// pricing ends.
const PRICING_PER_MILLION_TOKENS = {
  'claude-sonnet-5': { input: 3, output: 15 },
  'claude-opus-4-8': { input: 5, output: 25 },
  'claude-haiku-4-5-20251001': { input: 1, output: 5 },
};

function estimateCostUsd(model, inputTokens, outputTokens) {
  const rates = PRICING_PER_MILLION_TOKENS[model] || PRICING_PER_MILLION_TOKENS['claude-sonnet-5'];
  return (inputTokens / 1_000_000) * rates.input + (outputTokens / 1_000_000) * rates.output;
}

async function callClaude(agent, job) {
  const userMessage =
    typeof job.input_payload === 'string'
      ? job.input_payload
      : JSON.stringify(job.input_payload, null, 2);

  const maxTokens =
    (job.input_payload && job.input_payload.max_tokens) || DEFAULT_MAX_TOKENS;

  const response = await fetch(ANTHROPIC_API_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': ANTHROPIC_VERSION,
    },
    body: JSON.stringify({
      model: agent.model,
      max_tokens: maxTokens,
      system: agent.system_prompt,
      messages: [{ role: 'user', content: userMessage }],
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Anthropic API error ${response.status}: ${errorText}`);
  }

  return response.json();
}

async function markJobFailed(job, message) {
  const retryCount = (job.retry_count || 0) + 1;
  const maxRetries = job.max_retries ?? 2;
  const nextStatus = retryCount > maxRetries ? 'needs_review' : 'pending';

  const { error } = await supabase
    .from('orchestration_jobs')
    .update({
      status: nextStatus,
      retry_count: retryCount,
      error_message: message,
    })
    .eq('id', job.id);

  if (error) {
    console.error(`Failed to update job ${job.id} after failure:`, error.message);
  }
}

async function processJob(job) {
  const { error: markRunningError } = await supabase
    .from('orchestration_jobs')
    .update({ status: 'running', started_at: new Date().toISOString() })
    .eq('id', job.id);

  if (markRunningError) {
    console.error(`Failed to mark job ${job.id} running:`, markRunningError.message);
    return;
  }

  const { data: agent, error: agentError } = await supabase
    .from('orchestration_agent_registry')
    .select('*')
    .eq('agent_name', job.agent_name)
    .eq('active', true)
    .single();

  if (agentError || !agent) {
    await markJobFailed(
      job,
      `No active agent registered for agent_name "${job.agent_name}"`
    );
    return;
  }

  try {
    const response = await callClaude(agent, job);
    const textBlock = (response.content || []).find((block) => block.type === 'text');
    const draftBody = textBlock ? textBlock.text : '';

    const inputTokens = response.usage?.input_tokens || 0;
    const outputTokens = response.usage?.output_tokens || 0;
    const costUsd = estimateCostUsd(agent.model, inputTokens, outputTokens);

    const { error: draftError } = await supabase.from('orchestration_drafts').insert({
      job_id: job.id,
      draft_type: job.job_type,
      system: job.system,
      title: (job.input_payload && job.input_payload.title) || job.job_type,
      content: { body: draftBody, raw_input: job.input_payload },
      status: 'pending_review',
    });

    if (draftError) {
      throw new Error(`Failed to save draft: ${draftError.message}`);
    }

    const { error: auditError } = await supabase.from('audit_agent_actions').insert({
      job_id: job.id,
      agent_name: agent.agent_name,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      cost_usd: costUsd,
    });

    if (auditError) {
      // Non-fatal — the draft already saved successfully. Log and move on.
      console.error(`Failed to write audit log for job ${job.id}:`, auditError.message);
    }

    const { error: completeError } = await supabase
      .from('orchestration_jobs')
      .update({
        status: 'complete',
        completed_at: new Date().toISOString(),
        cost_usd: costUsd,
      })
      .eq('id', job.id);

    if (completeError) {
      console.error(`Failed to mark job ${job.id} complete:`, completeError.message);
    }
  } catch (err) {
    await markJobFailed(job, err.message);
  }
}

exports.handler = async () => {
  const { data: jobs, error } = await supabase
    .from('orchestration_jobs')
    .select('*')
    .eq('status', 'pending')
    .order('created_at', { ascending: true })
    .limit(BATCH_SIZE);

  if (error) {
    console.error('Failed to fetch pending jobs:', error.message);
    return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
  }

  if (!jobs || jobs.length === 0) {
    return { statusCode: 200, body: JSON.stringify({ processed: 0 }) };
  }

  // Sequential on purpose: avoids bursting the Anthropic API with a batch
  // of concurrent requests, and keeps failure isolation simple (one bad
  // job doesn't race with or corrupt another's state).
  for (const job of jobs) {
    await processJob(job);
  }

  return { statusCode: 200, body: JSON.stringify({ processed: jobs.length }) };
};
