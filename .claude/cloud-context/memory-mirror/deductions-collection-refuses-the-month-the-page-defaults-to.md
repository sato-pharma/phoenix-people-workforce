---
name: deductions-collection-refuses-the-month-the-page-defaults-to
description: "\"N connector(s) failed\" on the deductions page is usually the current-month guard working, not a failure — the page defaults to a month collection always refuses."
metadata: 
  node_type: memory
  type: project
  originSessionId: de3d5355-ce2f-47ce-91e5-037397fd3f85
  modified: 2026-08-22T22:23:07.502Z
---

`/admin/deductions` seeds its month selector to the **current Cairo month** (deliberate — that is
the month the publish action files deductions under), but `isCollectableMonth` in
`src/lib/deductions/collect.ts` **refuses any month that has not finished**. So on the page's own
default view, "Run collection" is always refused — one refusal per connector.

Before PR #2306 the client rendered each refusal as `state: "failed"`, so the summary read
**"Collection complete: 0 new candidate(s). 6 connector(s) failed"** in red with a red cross, every
time, all month long. **Nothing had failed.** The owner hit exactly this on 2026-08-23.

**Do NOT "fix" the guard.** It exists because collecting an in-progress month charged real people
**39,225.73 EGP on 2026-08-03** — 72 candidates for 1–3 August, 69 of them CRM, which publishes with
**no approval step**, plus 28 more from two earlier accidental runs. All 100 are `superseded_at` in
production and `deductions_publications` is empty, so the accident is fully neutralised — but only
because somebody noticed. The guard is Cairo-based (a UTC clock waves through the first hours of a
Cairo month) and CI-pinned in `tests/deductions-current-month-guard.test.ts`.

PR #2306 added the matching UI — the button is disabled with a plain-words explanation — so the
symptom above should no longer appear. If it does, the UI guard has regressed, not the server one.
**Shipped:** squash `3a1d3e70`, merged 2026-08-23 01:28 Cairo, confirmed live via `/api/healthz`.
Pinned by the UI half of `tests/deductions-current-month-guard.test.ts` (source assertions), which
runs in the required CI `validate` job.

**Why:** a working safety guard presented as six red failures is how a tired session at 4am ends up
deleting the guard that protects real payroll.

**How to apply:** when told "collection failed", read the per-connector text before believing the
headline. If it says *has not finished*, the answer is "nothing is broken — pick a completed month",
never a code change to `isCollectableMonth`. Related: [[never-auto-publish-deductions-owner-confirms-first]],
[[two-live-deduction-engines-p0]], [[deductions-canonical-but-legacy-has-the-only-daily-cron]].
