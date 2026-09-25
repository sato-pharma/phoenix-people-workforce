---
name: local-env-already-points-at-production
description: "CRITICAL — this machine's .env.local is configured against the PRODUCTION Supabase project (ozucdzovmcqvepbozvqf), not staging or a dedicated dev project. Local pnpm run dev already reads/writes real prod data."
metadata: 
  node_type: memory
  type: project
  originSessionId: df6ef377-8da9-4717-a7e7-54bfb5bfd368
  modified: 2026-07-30T04:26:06.438Z
---

`.env.local` in the primary worktree (`F:\Phoenix Workforce\phoenix-workforce`) has
`NEXT_PUBLIC_SUPABASE_URL=https://ozucdzovmcqvepbozvqf.supabase.co` and
`SUPABASE_PROJECT_REF=ozucdzovmcqvepbozvqf` — that ref is **production** per AGENTS.md
("Production Supabase project ref: `ozucdzovmcqvepbozvqf`"), not the staging ref
(`cifwmndunmlxjhyjugxa`). Confirmed 2026-07-28 by reading the file directly and cross-checking the
anon-key JWT payload (`"ref":"ozucdzovmcqvepbozvqf"`).

**Why this matters:** `pnpm run dev` on localhost is NOT a sandbox on this machine — it already
talks to the live production database, through the app's normal code paths (not a scoped read-only
MCP query). Anything that mutates data through the local UI — approvals, form submissions,
dev-preview's "Launch preview as ..." real-employee session switch, etc. — is a REAL change to REAL
production data, indistinguishable from doing it on `phoenix-hr.satopharma.com` itself. This is why
`/admin/dev-preview`'s employee picker found genuine real employees (e.g. a real Training Manager)
during local testing — [[windows-dev-server-turbopack-switch]] — it was never talking to synthetic
or staging data.

**How to apply:** before doing anything beyond read-only page loads/navigation in a local dev
session on this machine, pause and treat it with the same care as a production change per
AGENTS.md's approval matrix (migrations, bulk data, auth/RLS/payroll changes still need the same
explicit approvals whether triggered from `localhost:3000` or the real domain). Don't assume
"it's just local" means low-stakes. If a task specifically needs an isolated/synthetic backend,
that would require deliberately repointing `.env.local` at the staging project instead (ref
`cifwmndunmlxjhyjugxa`) — not the default state today.

**Consequence for error triage (confirmed 2026-07-30, cost me a false "production outage" call):**
local dev sessions also write into the **production `public.app_error_events` table**, so that table
is NOT a clean production signal. In the 7 days to 2026-07-30 it held 103 `environment='development'`
rows vs 46 real `environment='production'` rows. The dev rows look alarming and cluster on whatever
module is being built locally (that morning: a burst of `S1_LINES/CompanyAchieversTab/months/
currentLine/Download/ExportButton is not defined` on `/business-review-s1`, plus
`buildEmployee360Picker`/`isEmployee360ExcludedSubject` on `/employee-portals/employee-360`) — they
are just the normal iterate-and-reload cycle of an unfinished local page, not user-facing breakage.

**How to apply:** ALWAYS filter `app_error_events` by `environment='production'` before drawing any
conclusion about production health. The fast tell without a filter is the `release` column —
real production rows carry `sha-XXXXXXXX` (set from `COMMIT_SHA` at deploy), local dev rows carry
`unknown`. A route that only just merged but shows errors timestamped *before* its deploy is the
other giveaway. Same caution applies to any other prod table the app writes to on page load.

**Separate, smaller bug noticed in passing (not yet fixed):** `.env.local`'s `CLOUDFLARE_API_TOKEN`
line and a `SUPABASE_DB_URL=postgresql://postgres.ozucdzovmcqvepbozvqf:...@aws-1-eu-central-1.pooler.supabase.com:5432/postgres`
line are mashed together on one line with the DB URL's characters space-separated (looks like a
paste/save corruption) — `SUPABASE_DB_URL` is effectively unset as a result (`grep -c
SUPABASE_DB_URL .env.local` → 0). Doesn't affect the Next.js app itself (which doesn't read
`SUPABASE_DB_URL`), only scripts that would use a direct Postgres connection string. Not fixed —
flagged to the owner, fix on request only (touching a secrets file uninvited felt like the wrong
call).
