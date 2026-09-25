---
name: sentry-orphaned-cron-monitors-false-outage-alerts
description: "SUPERSEDED (Vercel/Cloud Run/GCP era) — Removing Sentry.withMonitor left 7 server-side Sentry cron monitors alive — they now fire false \"Cron failure\" outage alerts. Must delete them in Sentry."
metadata: 
  node_type: memory
  type: project
  originSessionId: 516a53ef-c89e-4a6c-a03a-f0eb456de1af
  modified: 2026-07-31T20:56:26.259Z
---

> **SUPERSEDED 2026-08-19 — history only, do NOT act on anything below.** This file describes the
> Vercel / GCP Cloud Run / Sentry / npm era. Since 2026-08-01 production is **Railway** (service
> `phoenix-people-workforce`, region `europe-west4`): a merge to `main` ships to production
> immediately, there is no deploy cron and no `gcloud` path, GCP billing is closed (every API
> returns `BILLING_DISABLED`), and the live scheduler is the third-party cron-job.org. Current
> truth: `AGENTS.md` §2/§3 and the Railway lines in `MEMORY.md`.

**✅ RESOLVED 2026-07-31 ~21:05Z — all 7 monitors MUTED** (verified: every row in Manage Monitors reads `MUTED = Yes`), and the one issue that had already fired (PHX-B9-J) is resolved with an explanatory comment. Muted, not deleted — deliberately reversible during the rollback soak; they vanish for good when the subscription is cancelled.

**How it was actually done** (the two API routes are dead ends — don't retry them): the Sentry MCP is read-only for monitors/rules, and the `SENTRY_AUTH_TOKEN` in Secret Manager 403s on **both** `sentry.io` and `de.sentry.io` (it is release-scoped, not a region problem). The working path was the **logged-in browser**, via the **Manage Monitors** dialog's bulk *Mute* action on `/insights/crons/` — its `MUTED` column is the only reliable state readout. Per-monitor Mute buttons are unreliable to script: the page takes 15-25s to hydrate and early clicks silently no-op, and clicking blind risks *unmuting* an already-muted monitor. Sentry's UI is also heavy enough that screenshots hit CDP timeouts — use `find` on the a11y tree to verify instead.

**URL gotchas:** the org is EU-region (`de.sentry.io` per `whoami`) but the console lives at `phoenix-workforce.sentry.io`; `sentry.io/organizations/phoenix-workforce/...` returns "organization not found", and the API `webUrl` values (`/crons/phx-b9/<slug>/`) are stale 404s — the live paths are `/insights/crons/` and `/issues/alerts/rules/crons/phx-b9/<slug>/details/`.

**Discovered 2026-07-31 20:26Z, ~7 minutes after the Sentry-free build went live in production.**

Deleting `Sentry.withMonitor(...)` from the 8 cron routes removed the **check-ins**, but the **monitors themselves live server-side in Sentry** and were left untouched. Sentry cron monitors alert on the *absence* of a check-in — so every orphaned monitor goes red on its next missed window and creates a `Cron failure: <slug>` issue with category `outage`, which the project's issue-alert rules then email.

First confirmed casualty: issue **PHX-B9-J "Cron failure: notifications-process"**, created ~1 min after `notifications-process` (`*/5`, 5-min margin) missed its window.

**7 orphaned monitors in `phoenix-workforce/phx-b9`** (note: no `background-jobs` monitor ever existed — Sentry had 7, the app has 8 jobs):
`notifications-process` · `inbound-intake` · `recruitment-email-intake` · `ireports360-visits-sync` · `ireports360-visits-live-sync` · `notifications-daily` · `ireports360-visits-reconcile`
Console: `https://phoenix-workforce.sentry.io/crons/phx-b9/<slug>/`

**Two enabled issue-alert rules** route those to email: `Error Spike` (id 713796, >20 events/15m, env=production) and `Send a notification for high priority issues` (id 712459, the default rule, no env filter).

**Neither can be changed from this session:** the Sentry MCP connector exposes only read tools for alert rules and monitors (`find_alert_rules`, `get_alert_rule`, `find_monitors`, `get_monitor_details` — all `readOnlyHint: true`), and the `SENTRY_AUTH_TOKEN` in GCP Secret Manager is release/sourcemap-scoped: `GET /api/0/projects/phoenix-workforce/phx-b9/rules/` returns **403**. Fixing this needs either the Sentry dashboard or a user auth token with `alerts:write` + `project:write`.

**Correct fix (root cause):** delete the 7 monitors. Disabling the alert rules only silences the emails; the monitors stay red.

**Lesson for any future monitored-service removal:** removing the *client* check-in code without removing the *server-side* monitor inverts a dead-man's-switch into a false-alarm generator. `docs/email-deliverability-and-rollout.md` §5 already carried a "delete orphaned Sentry monitors" task; PR #1514 marked it obsolete on the reasoning that Sentry was going away — true eventually, but it left a noise window during the 1–2 week rollback soak.

Related: [[claude-config-audit-2026-07-31]] · [[healthchecks-live-8-checks-configured]]
