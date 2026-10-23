---
name: railway-ts-is-the-only-deploy-config-and-a-dashboard-edit-stays
description: Since 23 Oct 2026 .railway/railway.ts is the only Railway deploy config (both railway.toml retired, #6286); nothing re-applies it at a deploy, so a dashboard edit STAYS — scripts/check-railway-deploy-settings.mjs (daily, in secret-drift-check.yml, #6287) is what catches it.
metadata:
  type: project
---

On 2026-10-23 (PR #6286, merged 05:38 Cairo as d92230323) both `railway.toml` files were retired and
`.railway/railway.ts` (railway/iac) became the only deploy config. The toml used to be re-applied at
EVERY deploy, so a dashboard change snapped back; the authoring file is applied only by a hand-run
`railway config apply`, so a dashboard change now persists silently.

Measured at the cutover: the website's stored healthcheck window was 300 s while every file said 900 s
(the toml had been masking it). The app-only apply stored 900; the first deploy after the merge
(cc096092) logged `Path: /api/readyz`, `Retry window: 15m0s`, healthcheck succeeded. Restart policy
ON_FAILURE / 10 is stored on every service. A plan from the committed file before refresh would have
made 17 destroys — always read the plan before an apply, and every apply needs the owner's word.

`scripts/check-railway-deploy-settings.mjs` (third leg of `.github/workflows/secret-drift-check.yml`,
PR #6287) compares healthcheck, restart policy and every volume mount per service against production,
and names a live volume the file does not declare. Exit 0 match · 1 drift (Telegram + step summary,
job stays green so it cannot withhold a deploy) · 2 cannot tell (warning, never a pass).

**Why:** without it a dashboard edit that shortens the window or detaches the tablet disk goes unseen.
**How to apply:** a drift finding is fixed in `.railway/railway.ts` and applied on his word; never
"fix" it by editing the dashboard back. Related: [[adding-a-railway-volume-removes-the-running-deployment-first]], [[the-release-gate-lets-railway-build-while-ci-runs]].
