---
name: marketing-xlsx-requests-were-test-data-deleted-on-purpose
description: "The 216 xlsx_import marketing requests deleted from prod on 2026-08-09 were owner-intentional test data — never raise it as data loss."
metadata: 
  node_type: memory
  type: project
  originSessionId: 4d615aae-6dc5-4362-b4f4-d602d9620a11
  modified: 2026-08-12T21:18:33.552Z
---

On **2026-08-09 between 19:45 and 20:07 Cairo**, 216 rows were deleted from `marketing_requests`
(plus 546 `marketing_request_approval_steps`, 361 `marketing_request_pharmacies`, 316
`marketing_request_products` — 1,441 rows total). Production dropped from 218 requests to 2.

**Owner ruling 2026-08-13: this was deliberate.** They were an XLSX set imported *after* the module
went live, kept only to exercise the reporting surfaces. He does not want them back. **No recovery
was performed and none is wanted.**

**Why:** an audit will re-discover this and it looks exactly like an accident — `n_tup_del = 218`,
four tables autovacuumed inside 200 ms, the ROI refresh log falling 128 → 1, a 218-row June JSON
backup on the laptop, and PR #1952 fingerprinting 218 requests that morning. Five independent
sources, no audit row, no trigger, no tombstone. I raised it as a P0 data-loss incident with a
3-day recovery deadline; it was not one.

**How to apply:**
- If you find this deletion, it is **closed**. Do not raise it, do not restore it, do not open a
  clone project.
- `/admin/archived-marketing-requests` renders `origin='xlsx_import'` and is therefore **permanently
  empty — a page to delete, not a bug to fix**.
- The ROI/coverage surfaces reporting on ~1 request is **expected**, not broken.
- What *is* still a real finding: the database recorded nothing about a 1,441-row deletion. That is
  the argument for an append-only events table + triggers, which the marketing module has none of
  ([[no-triggers-or-history-table-on-marketing-requests]]).

Related: [[production-supabase-has-no-pitr-only-daily-backups]] ·
[[marketing-case-file-data-layer-has-no-ui]]
