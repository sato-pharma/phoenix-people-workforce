---
name: early-birds-is-in-app-and-telegram-never-email
description: "Owner rule — Early Birds is in-app + Telegram only, and a backfill WINDOW is not a floor"
metadata: 
  node_type: memory
  type: project
  originSessionId: 1e2a5a44-09c1-4b95-8b3b-ec6446552f83
  modified: 2026-08-09T09:43:34.636Z
---

Two standing rules for the Early Birds module, both owner decisions on **2026-08-09**.

**1. In-app and Telegram only. Never email.** (#1945)
Enforced by `src/lib/notifications/early-birds-channel-guard.ts`, a hard post-filter keyed on
**module**, applied last in `basePolicyChannels`. A `policy.ts` edit alone does **not** hold: email
re-enters from an explicit call-site `channels`, from code defaults in `resolveBasePolicyChannels`
(several are literally `["in_app","email"]`), and above all from the **Telegram-failure fallback,
which re-enters with `["email","in_app"]`** — the single most likely path, because Telegram failing
is the expected case (see [[telegram-reaches-only-two-accounts]]). Same pattern as
`payslip-channel-guard.ts` / `marketing-sla-channel-guard.ts`; keep the three separate.
`early_birds` also needs its explicit row in `defaultTelegramPolicies` — the unknown-module
fail-safe **disables** Telegram, which with email blocked would leave one channel.

**2. `EARLY_BIRDS_BACKFILL_PERIODS` is a WINDOW, not a floor.** (#1940)
It is relative to today, so it slides backwards over fortnights that pre-date the module, and each
looks like a gap the scheduler exists to heal. Measured before unblocking the poller: the first
tick would have closed **46 districts** across 2026-06-H1, 2026-06-H2 and the rest of 2026-07-H1,
sent 46 recommendations, and auto-crowned all 46 five days later — the original auto-crown incident
at 2.4x scale. The floor is **`EARLY_BIRDS_EARLIEST_PERIOD_KEY = "2026-08-H1"`**; period keys are
fixed-width `YYYY-MM-Hn` so a string compare is a date compare.

**Why:** both failures are silent. The channel one sends mail the owner banned; the backfill one
awards fortnights nobody was watching, off a CRM mirror that has since been reconciled.

**How to apply:** before re-enabling `PHOENIX_LIVE_CRM_POLL`, dry-run
`resolveDueEarlyBirdsPeriods` against live snapshot counts and state the district count out loud.
Setting the Railway variable is **not enough — the process must restart** to pick it up
(`--skip-deploys` then a deploy, or `railway redeploy`); confirm with `[crm:live-poll] started` in
`railway logs`. Related: [[railway-merge-is-the-production-deploy]],
[[verify-notification-deliveries-before-claiming-a-send]].
