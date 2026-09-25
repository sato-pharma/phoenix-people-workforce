---
name: marketing-requests-archival-and-sla-guard
description: "93 marketing requests stuck in pending_approval with no approval step anyone can act on; guard+archived-status+email-retirement LIVE in production (PR #1349+#1350 merged); bulk archival of 81 rows NOT yet executed"
metadata: 
  node_type: memory
  type: project
  originSessionId: ca3ff325-bc00-4df1-b856-df76870bf385
  modified: 2026-07-27T16:00:37.700Z
---

Found auditing notification noise (2026-07-25): `marketing_requests/escalation` was firing
~85 events every morning for over a month. Real cause, NOT a backlog problem: **93 rows in
`pending_approval` have zero `current` row in `marketing_request_approval_steps`** — both the
approver-inbox read path and the decision RPC hard-require a `current` step with no bypass
for any role, so these 93 are architecturally undecidable by anyone. Root cause timing: these
93 rows date from a 2026-06-20 bulk-seed, which predates the real bulk-import tool
(`bulk-import.ts`, correct `current`-step handling) by over a week — seeded via an earlier/ad
hoc path and never repaired. `marketing_sla_reminder` has been fully disabled since
2026-07-22 as a blunt kill-switch (masks the symptom, also blocks legitimate future reminders
for healthy requests).

**Owner's remediation choice** (2026-07-25, NOT "repair all 93" or "archive all 93"):
archive any request — regardless of current status (approved/pending_approval/rejected
alike) — whose **ROI window has already elapsed before 2026-07-01**. ROI window = `pay_date`'s
month + `roi_duration_months`, reusing the app's own existing formula
(`roi-report-service.ts` `monthAdd`/`roiWindowLabel`, NOT reinvented). Verified count:
**81 of 217** total `marketing_requests` rows qualify (44 approved / 32 pending_approval /
5 rejected) — same 81 whether cutoff is 2026-07-01 or "today" 2026-07-25 (zero rows fall in
that gap).

**Critical gap the owner's rule does NOT close**: only **32 of the 93** originally-broken
rows get swept by the archive rule. **61 remain stuck** — no `current` step, ROI window still
open, still undecidable by anyone — after archival completes. A guard was added
(`runMarketingSlaDaily`, scoped strictly to `status === "pending_approval"`) so these 61 stop
generating a misleading "critical escalation" notification and instead emit one aggregate
`logWarning` per run (`event=marketing_pending_approval_missing_current_step`) — but this
does NOT repair them. Repairing needs a live-data check first (do they have step rows with no
`current`, cheap fix — or zero step rows, needs the fuller `createMarketingApprovalSteps`
resolution logic, currently private, NOT bulk-import's logic which never sets
`assigned_hr_id`). Explicitly deferred, not started — ask the owner before touching.

**Do NOT scope the guard to all 3 SLA-pending statuses** (`pending_validation`,
`pending_approval`, `returned`) — only `pending_approval`. The other two legitimately have
zero `current` steps by design (steps don't exist until a request enters `pending_approval`;
the decision RPC's "return" branch resets to `returned` with no replacement `current` step
until resubmission) — this was a real mistake in the first draft of this plan, caught during
design review before any code was written.

**Do NOT repurpose the existing `closed` status for archival.** `closed` feeds
`approvedMarketingRequestStatuses` (dashboard/finance "approved" totals in
`home-snapshot.ts`, `service.ts`) — folding rejected/pending rows into it would inflate those
figures. `archived` is a genuinely new terminal value, deliberately excluded from that list.

**New owner instruction, same day (2026-07-25), mid-build**: retire the email channel for
marketing SLA reminders/escalations *entirely and permanently* — not just fix the
data-integrity trigger above. Built `src/lib/notifications/marketing-sla-channel-guard.ts`,
same two-layer hard-post-filter pattern as `payslip-channel-guard.ts` (declarative
`channels` in `policy.ts` minus `"email"` for the 3 SLA entries, PLUS a hard filter in
`system.ts`'s `basePolicyChannels` that survives policy overrides/explicit call-site
channels/Telegram-failure fallback re-entry). Keyed on BOTH `module==="marketing_requests"`
AND eventType ∈ {`due_date_reminder`, `overdue_reminder`, `escalation`} — unlike payslip's
eventType-only match, because these 3 eventType strings are generic enough another module
could plausibly reuse one (grepped the whole tree, no collision today, but the module check
costs nothing). In-app/Telegram/push are unaffected; the other 6 `marketing_requests.*`
lifecycle notifications (submitted/assigned/approved/rejected/returned/completed) keep email.

**State as of 2026-07-25 19:56 Cairo — both PRs MERGED, both live in production:**
- **PR #1349** (app code: `archived` type + 5 label maps + SLA data-integrity guard + the
  email-retirement guard above + tests, 444 total test files passing) — merged
  (`5ef4d202`), deployed, confirmed live at 100% traffic on revision `phoenix-hr-00524-nej`
  (tag `sha-5ef4d202`). Production domain smoke-checked (HTTP 200).
- **PR #1350** (migration: widen `marketing_requests_status_check` to add `archived`) —
  merged (`730bf25e`) as a paper-trail close-out; the SQL itself was already applied
  directly to both staging and **production** earlier this session (verified via
  `pg_get_constraintdef` before/after) — merging this PR re-triggers a deploy but changes
  no runtime behavior (migrations don't auto-apply on merge). Registered in Supabase's own
  history as version `20260725180620` vs. the repo file's embedded `20260725190000` — same
  known drift pattern as [[mcp-apply-migration-version-drift]], not a new problem.
- **Net effect now live**: the `archived` status exists and is usable; the SLA scan no
  longer fires a misleading notification for the 61 still-broken no-current-step rows
  (logs one aggregate warning instead); marketing SLA reminders/escalations can never be
  emailed again, permanently, regardless of future policy edits.
- Bulk archival UPDATE (the 81 rows) — **EXECUTED. Verified live in production 2026-07-27**:
  `marketing_requests` status split is now `archived` 81 / `approved` 65 / `pending_approval` 61
  / `rejected` 10 = 217. The predicted post-archival remainder of 61 stuck rows is exactly right.
  (This entry previously said "still NOT executed anywhere" — that was wrong/stale.)
  Breakdown of the 61: **25 have ZERO approval-step rows** (full chain must be rebuilt) and
  **36 are stuck mid-chain** (1–3 approved steps, next step row never inserted → repair =
  generate the next step). Separately the 10 `rejected` rows also have zero steps, so their
  rejection has no audit trail. NOTE: there is no `is_current`/`current` COLUMN — "current step"
  must be derived as the lowest-`sequence` step with `status='pending'`, and **all 546 steps in
  production are `status='approved'`, so ZERO requests have an actionable current step.**
- `marketing_sla_reminder` — still fully disabled since 2026-07-22. Re-enabling (Phase D5)
  is the LAST step, now safe to do once D4 lands (the guard + email retirement are already
  live, so re-enabling will no longer spam — it'll log-warn for the 61 remainder and email
  nothing for any SLA event regardless).

**Sequencing, updated**: ~~migration on prod~~ DONE → ~~code (guard + email retirement)
deployed to prod~~ DONE → THEN bulk archival on prod (preview first, Phase D4, not started)
→ THEN re-enable the toggle (Phase D5) → verify next cron run only logs a warning for the
61, and confirm zero emails for any marketing SLA event type in that run's outbox/logs.

Related: [[notification-confidence-gate-and-paused-crons]], [[mcp-apply-migration-version-drift]].
