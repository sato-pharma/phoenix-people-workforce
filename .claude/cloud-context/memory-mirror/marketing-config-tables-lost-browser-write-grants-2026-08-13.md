---
name: marketing-config-tables-lost-browser-write-grants-2026-08-13
description: "Six marketing config tables lost their anon/authenticated write grants in production on 2026-08-13 — do not redo or undo; SELECT was deliberately kept."
metadata: 
  node_type: memory
  type: project
  originSessionId: 4d615aae-6dc5-4362-b4f4-d602d9620a11
  modified: 2026-08-13T10:50:40.927Z
---

Applied to **production** (`ozucdzovmcqvepbozvqf`) on 2026-08-13 with the owner's explicit
approval, migration `20260813210000_marketing_config_tables_revoke_browser_writes.sql`.
**Do not re-apply and do not revert.**

`INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER` revoked from `anon` and `authenticated` on:

`marketing_control_settings` · `marketing_distributors` · `marketing_products` ·
`marketing_request_types` · `marketing_review_routing` · `marketing_workflow_steps`

**`SELECT` was deliberately KEPT** — each table has a permissive SELECT-only RLS policy for
`authenticated` that someone wrote on purpose, and every reader in the app is server-side. Do not
"finish the job" by revoking SELECT.

**Why it mattered, precisely.** All six had RLS on with a SELECT-only policy, so the DML grants were
already inert. **TRUNCATE is not covered by RLS** — no policy can stop it and the grant was the only
control. Measured as the `anon` role on staging with the grant restored, in a rolled-back
transaction:

- `marketing_control_settings` (0 inbound FKs) — **TRUNCATE SUCCEEDED, 8 rows to 0**
- `marketing_review_routing` (0 inbound FKs) — **TRUNCATE SUCCEEDED, 3 rows to 0**
- the other four — refused with `0A000`, but only because an inbound foreign key said no, not by
  any deliberate control

**The audit ticket named `marketing_request_types`, which is one of the FK-protected four.** The real
exposure was on two tables it never mentioned. Measure per table; do not fix this class of finding
from the ticket.

**Severity was defence in depth, NOT remotely exploitable** — PostgREST exposes no TRUNCATE verb, so
the public anon key alone could not fire one. Do not re-raise this as a P0.

Root cause is Supabase's default privileges granting the full set to every new `public` table —
the same mechanism behind [[append-only-tables-need-a-truncate-trigger]]. **The default ACL is
unchanged**, so any table created in `public` from now on inherits the same full grant set.

Verified on production after the apply: `anon` TRUNCATE/DELETE/INSERT/UPDATE all false,
`authenticated` TRUNCATE/DELETE false and SELECT true, `service_role` SELECT/INSERT/UPDATE/DELETE
all true. Behaviourally: anon TRUNCATE on both previously-emptiable tables refused with
`insufficient_privilege`, `authenticated` SELECT still permitted, `service_role` intact.

The revoke names `anon`/`authenticated` by name and **never PUBLIC** — revoking PUBLIC on a default
ACL also strips `service_role` ([[revoke-from-public-strips-service-role-on-default-acl]]).

Rollback, if ever needed, is one statement per table:
`grant delete, insert, references, trigger, truncate, update on <table> to anon, authenticated;`
