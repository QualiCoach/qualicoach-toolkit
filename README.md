# QualiCoach Orchestration — Step 1: Foundation

This is the base layer everything else plugs into: a jobs table, a draft
table, an agent registry, a router that dispatches jobs to Claude, and a
one-page approval interface. See `docs/decisions/001-foundation.md` for the
reasoning behind each choice, and the full architecture doc for how this
fits into the five business systems.

## Setup (roughly 15 minutes)

**1. Database**
- Open your Supabase project → SQL Editor.
- Paste and run `db/001_foundation_schema.sql`. It's safe to re-run.
- This creates the four tables and seeds one `smoke_test_agent` row so you
  can verify the pipeline before building a real agent.

**2. Merge into your repo**
- Copy `netlify/functions/*.js` into your existing
  `QualiCoach/qualicoach-toolkit` repo's functions folder (or a new repo,
  your call).
- Merge the `[functions."job-router"]` and `[[redirects]]` blocks from
  `netlify.toml` into your existing config.
- Copy `admin/review.html` into your site's publish directory under
  `/admin/`.
- Add the dependency: `npm install @supabase/supabase-js`

**3. Environment variables**
In Netlify: Site settings → Environment variables. Set the four values from
`.env.example` with your real Supabase and Anthropic credentials, and a
long random string for `ADMIN_TOKEN`.

**4. Deploy**

**5. Smoke test**
- In the Supabase SQL editor, insert a test job:
  ```sql
  insert into orchestration_jobs (job_type, agent_name, system, input_payload)
  values ('smoke_test', 'smoke_test_agent', 'operations',
          '{"title": "Smoke test", "topic": "orchestration pipeline check"}');
  ```
- Wait up to 5 minutes for the scheduled router to pick it up (or trigger
  the function manually from the Netlify dashboard / CLI to test
  immediately).
- Visit `https://yoursite.com/admin/review`, enter your `ADMIN_TOKEN`, and
  confirm the draft shows up. Approve or reject it to confirm the full loop.

## Next step

Once the smoke test round-trips cleanly, we register the first real agent
(recommend: YouTube Script Agent, per the roadmap) and confirm the
end-to-end output quality before building the rest of Content Creation.
