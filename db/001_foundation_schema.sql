-- ============================================================================
-- QualiCoach Orchestration Foundation — Migration 001
-- ============================================================================
-- Run this in the Supabase SQL editor (or via `supabase db push` if you set
-- up the Supabase CLI locally). Safe to re-run: every statement is
-- idempotent (IF NOT EXISTS / OR REPLACE) except the table creates, which
-- will simply no-op if the tables already exist.
--
-- NOTE ON SCHEMA DESIGN: the architecture doc sketches logical groupings
-- (orchestration / memory / business / audit). Rather than using real
-- Postgres schemas, we use prefixed table names in the default `public`
-- schema. Supabase's REST/PostgREST layer only auto-exposes `public` —
-- using real schemas would require an extra dashboard config step for no
-- real benefit at this scale. Prefixes (orchestration_, audit_) give us the
-- same organizational clarity without that friction.
-- ============================================================================

create extension if not exists pgcrypto;

-- ----------------------------------------------------------------------------
-- orchestration_agent_registry
-- One row per agent. This is what makes prompts reusable and versioned
-- instead of hardcoded strings scattered across functions. Adding a new
-- agent to the system is an INSERT here, not a code deploy.
-- ----------------------------------------------------------------------------
create table if not exists orchestration_agent_registry (
  id uuid primary key default gen_random_uuid(),
  agent_name text not null unique,           -- e.g. 'youtube_script_agent'
  system text not null check (system in (
    'content_creation', 'research_assistant', 'lead_generation',
    'operations', 'analytics'
  )),
  description text,
  system_prompt text not null,
  model text not null default 'claude-sonnet-5',
  approval_tier smallint not null default 1 check (approval_tier in (1, 2, 3)),
  -- Tier 1: always human-reviewed (default and recommended for everything at launch)
  -- Tier 2: fast-approve eligible (internal-only outputs)
  -- Tier 3: auto-run eligible (opt-in only, after a track record — not used yet)
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table orchestration_agent_registry is
  'Registry of every agent the router can dispatch to. One row = one reusable prompt + config.';

-- ----------------------------------------------------------------------------
-- orchestration_jobs
-- The spine of the system. Every unit of work is a row here.
-- ----------------------------------------------------------------------------
create table if not exists orchestration_jobs (
  id uuid primary key default gen_random_uuid(),
  job_type text not null,                    -- human-readable category, e.g. 'youtube_script'
  agent_name text not null references orchestration_agent_registry(agent_name),
  system text not null check (system in (
    'content_creation', 'research_assistant', 'lead_generation',
    'operations', 'analytics'
  )),
  input_payload jsonb not null default '{}'::jsonb,
  status text not null default 'pending' check (status in (
    'pending', 'running', 'complete', 'failed', 'needs_review'
  )),
  retry_count smallint not null default 0,
  max_retries smallint not null default 2,
  cost_usd numeric(10, 4) default 0,
  error_message text,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz
);

comment on table orchestration_jobs is
  'One row per unit of work. status=needs_review means it failed past max_retries and needs a human look, not approval — see orchestration_drafts for content approval.';

create index if not exists idx_jobs_status_created
  on orchestration_jobs (status, created_at);
create index if not exists idx_jobs_system
  on orchestration_jobs (system);

-- ----------------------------------------------------------------------------
-- orchestration_drafts
-- Every agent output that touches the outside world lands here first.
-- Nothing downstream reads raw agent output — only approved drafts.
-- ----------------------------------------------------------------------------
create table if not exists orchestration_drafts (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references orchestration_jobs(id) on delete cascade,
  draft_type text not null,
  system text not null,
  title text,
  content jsonb not null,                    -- { body: "...", raw_input: {...}, ... }
  status text not null default 'pending_review' check (status in (
    'pending_review', 'approved', 'rejected', 'published'
  )),
  reviewer_notes text,
  approved_at timestamptz,
  published_at timestamptz,
  created_at timestamptz not null default now()
);

comment on table orchestration_drafts is
  'Draft-first pattern: every agent action lands here as pending_review. Approval is a separate explicit step — see review-draft function.';

create index if not exists idx_drafts_status
  on orchestration_drafts (status, created_at);
create index if not exists idx_drafts_job_id
  on orchestration_drafts (job_id);

-- ----------------------------------------------------------------------------
-- audit_agent_actions
-- Full log of every API call: cost, token usage, which agent, which job.
-- This is the safety net for "what did this cost me" and "what ran".
-- ----------------------------------------------------------------------------
create table if not exists audit_agent_actions (
  id uuid primary key default gen_random_uuid(),
  job_id uuid references orchestration_jobs(id) on delete set null,
  agent_name text not null,
  input_tokens integer not null default 0,
  output_tokens integer not null default 0,
  cost_usd numeric(10, 4) not null default 0,
  created_at timestamptz not null default now()
);

comment on table audit_agent_actions is
  'Cost and usage log, one row per API call. Query this for spend tracking and to feed the Analytics system later.';

create index if not exists idx_audit_created
  on audit_agent_actions (created_at);

-- ----------------------------------------------------------------------------
-- updated_at trigger for agent_registry
-- ----------------------------------------------------------------------------
create or replace function set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_agent_registry_updated_at on orchestration_agent_registry;
create trigger trg_agent_registry_updated_at
  before update on orchestration_agent_registry
  for each row execute function set_updated_at();

-- ----------------------------------------------------------------------------
-- Row Level Security
-- These tables are only ever written to by server-side Netlify Functions
-- using the service role key, which bypasses RLS entirely. We still enable
-- RLS with no policies as defense-in-depth: if a client-side key were ever
-- used against these tables by mistake, it gets nothing rather than
-- everything.
-- ----------------------------------------------------------------------------
alter table orchestration_agent_registry enable row level security;
alter table orchestration_jobs enable row level security;
alter table orchestration_drafts enable row level security;
alter table audit_agent_actions enable row level security;

-- ============================================================================
-- Seed: one placeholder agent so you can smoke-test the router end to end
-- before building the first real Content Creation agent. Safe to delete
-- once you register your first real agent.
-- ============================================================================
insert into orchestration_agent_registry (agent_name, system, description, system_prompt, model, approval_tier)
values (
  'smoke_test_agent',
  'operations',
  'Placeholder agent for verifying the job router works end to end. Delete once real agents exist.',
  'You are a smoke-test agent for the QualiCoach orchestration system. Respond with a short confirmation that you received the input, and echo back the topic you were given.',
  'claude-sonnet-5',
  1
)
on conflict (agent_name) do nothing;
