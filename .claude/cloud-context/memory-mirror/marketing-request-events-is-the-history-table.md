---
name: marketing-request-events-is-the-history-table
description: "marketing_request_events is live in PROD since 2026-08-13 — the module's only history; events deliberately have NO FK so they outlive a deleted request."
metadata: 
  node_type: memory
  type: project
  originSessionId: 4d615aae-6dc5-4362-b4f4-d602d9620a11
  modified: 2026-08-13T02:02:31.503Z
---

Applied to **production** (`ozucdzovmcqvepbozvqf`) on 2026-08-13, migration
`20260813150000_marketing_request_events.sql`. Before it, `pg_trigger` on every marketing table
returned **zero rows** and there was no history table anywhere — which is why the 2026-08-09
deletion took five sources to reconstruct and still could not be told apart from an accident.

**Live state at apply:** 11 backfilled events for the 2 production requests (2 created + 2
submitted + 5 step_decided + 2 status_changed). 4 triggers across `marketing_requests`,
`marketing_request_approval_steps` and the events table itself.

**Two design choices that look like bugs and are not:**

- **`request_id` carries NO foreign key.** Every other child of `marketing_requests` is
  `ON DELETE CASCADE`. An audit row that dies with its request cannot testify about the deletion.
  Events outliving their request is the whole point — an "orphan" event is correct, not drift.
  `request_code` is denormalised for the same reason.
- **`actor_hr_id` is nullable and best-effort.** A trigger cannot see the app user, only what the
  row carries. **NULL means "not recorded" and must never render as "system".**

**Backfilled rows carry `payload->>'backfilled' = 'true'`** so a derived event is never mistaken
for a captured one. A step with `decision_at IS NULL` deliberately produces **no** event — staging
holds 546 steps marked `approved` with no decider and no time (the bulk importer manufactured
them), and inventing a timestamp would be worse than silence.

**How to apply:** this table is the foundation for the real request timeline (the tracking rebuild).
Read it rather than reconstructing history from `marketing_requests` timestamps. It is append-only
and enforced — see [[append-only-tables-need-a-truncate-trigger]].

Note the underlying data defects it does NOT fix: the decision RPC still leaves rungs `pending`
after a reject, a reject still NULLs `returned_at`, and an advisory comment still overwrites the
previous one in `decision_note` (though each comment now survives as a `step_commented` event).
