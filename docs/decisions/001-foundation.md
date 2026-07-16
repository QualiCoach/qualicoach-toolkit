# ADR 001 — Orchestration foundation

**Date:** 2026-07-15
**Status:** Built, pending your first real agent to validate end to end

## Decision

Build the orchestration spine as three tables (`orchestration_jobs`,
`orchestration_drafts`, `orchestration_agent_registry`) plus an audit log
(`audit_agent_actions`) in Supabase, a single scheduled Netlify Function
(`job-router`) that polls and dispatches, and a plain HTML approval page
backed by two functions (`list-drafts`, `review-draft`).

## Why

- **No orchestration framework.** LangGraph/CrewAI/AutoGen solve problems
  (agent negotiation, complex branching) we don't have yet. A SQL table is
  debuggable with a query; a framework's internal state usually isn't.
- **Prefixed tables in `public`, not real Postgres schemas.** Supabase's
  REST layer only exposes `public` by default. Real schemas would need an
  extra dashboard step for no functional benefit at this scale.
- **Plain HTML for the approval page, not React.** One user, one page, two
  actions (approve/reject). A framework adds a build step for no benefit
  here — revisit if the review UI grows real complexity (filtering, bulk
  actions across systems) or a second reviewer joins.
- **Shared-secret auth (`ADMIN_TOKEN`) instead of real auth.** Same
  reasoning — single user today. Swap for Supabase Auth the moment a second
  person needs access; nothing else in this design has to change to support
  that.
- **Sequential job processing, not parallel.** Avoids bursting the
  Anthropic API and keeps failure isolation simple. Revisit if job volume
  grows enough that 5-per-5-minutes becomes a bottleneck.
- **Publishing is explicitly out of scope here.** Approving a draft in this
  step marks it `approved` and stops. The actual push to Squarespace/
  Gmail/Stripe/Calendar is a separate "publisher" function built per system,
  starting with Content Creation (see architecture doc, Section 10).

## What this does NOT do yet

- No agents are registered except a `smoke_test_agent` placeholder for
  verifying the pipeline works.
- No publisher functions exist — `approved` drafts don't do anything yet
  beyond changing status.
- No memory/embeddings layer — agents don't have brand-voice context beyond
  whatever's in their system prompt.

These are all intentional — each is a distinct future step, not an
oversight.
