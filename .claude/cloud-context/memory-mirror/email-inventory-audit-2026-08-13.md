---
name: email-inventory-audit-2026-08-13
description: "Email-reduction project — the inventory of live email triggers, and the 30-day-window trap that put 13 dead rows in the first draft"
metadata: 
  node_type: memory
  type: project
  originSessionId: 0ae8a0b0-d0e1-43b4-9ba8-570fdca85c41
  modified: 2026-08-13T11:02:10.622Z
---

Owner initiative started 2026-08-12: **cut the volume of irrelevant email** the platform sends.
Step 1 was a full inventory of every email trigger (module → trigger → recipients), delivered as
an XLSX with a Keep / Cut / Change recipient / Needs discussion dropdown per row. His worked
example: a plan submission should email, an *approval* should not, but a return/rejection should.

**The trap that cost a rework — do not repeat it.** The first draft was built from a
`notification_deliveries` query over "the last 30 days". That window (2026-07-13 → 2026-08-12)
straddled a wave of retirements the owner had already made, so **13 rows showed real send counts
for features that no longer exist**. He caught it immediately ("triggers I never saw or met").

**Rule: a send count in a trailing window proves a feature WAS alive, never that it IS.** Always
also check `max(created_at)` per event_type and reconcile any gap against `git log`. Conversely,
zero sends does NOT prove death — `probation.reminder_due` (the highest-volume trigger, ~500
attempts/month) had gone silent since 2026-08-02 yet is fully live: it drains a queue of scheduled
reminders and simply had nothing due. Prove liveness from **code + wiring**, not volume:
confirm the emitting function still exists AND that something actually calls it (the retired
`runDvPlannerWeeklyDigest` still exists but has zero callers outside tests).

Retirements found, all owner-made: probation day30/60/75 + DV snapshot + weekly digest (#1624 and
#1626, both 2026-08-02) · Private Calendar No Activity Days (#1588, 2026-08-01) · marketing SLA
escalation (#1904, 2026-08-08) and its due/overdue email channel (2026-07-25) · attendance stall
alert email (#1946, 2026-08-09) · attendance digest (2026-07-22) · outstation SLA reminder
(2026-07-22).

Audit never sends anything — see [[never-fire-bulk-emails-ever]] and
[[verify-notification-deliveries-before-claiming-a-send]].

🔴 **AMENDED 2026-09-29 — finding (1) below is NO LONGER the whole rule.** The owner instructed that
the probation module send its **Day 30 / 60 / 75** emails to **Yasmeena Elsafory (HR-009) alone, CC
Omar Gawish (B-10)**. Those three now ride their OWN notification type, `probation_milestone`, with
its own admin toggle (enabled). **The `probation` policy below stays `enabled = false` — it governs
the legacy per-manager reminders on the 5-minute cron, and flipping it would restart ~500 of those a
month.** So "do not re-enable probation email" still stands **for that policy**, and does NOT mean the
milestone emails are forbidden. See AGENTS.md §4 and
`src/lib/probation/intelligence/milestone-emails.ts`.

**Two findings from the deeper wiring pass on the remaining 93 rows.** (1) **RESOLVED 2026-08-13 —
owner confirmed probation email STAYS OFF.** It's been silently off since 2026-07-19 (one admin
toggle, `email_notification_policies` / `notification_type='probation'`, flipped by account
`admin-hr`, refusing every probation email with the logged reason `"Probation notifications are
disabled."`; in-app/Telegram/push unaffected). Owner ruled this is intentional, not a bug — **do
not suggest re-enabling it, do not treat the 279 logged refusals as broken**, this is now a product
rule like [[early-birds-is-in-app-and-telegram-never-email]]. (2) **RESOLVED 2026-08-13 — PR #2091
→ `23135232`, live in prod.** Two admin buttons were genuinely bulk-capable despite the standing
never-bulk-email rule: the Telegram-onboarding campaign's documented 250 cap was NOT enforced
server-side (`DEFAULT_CAMPAIGN_LIMIT` was only the fallback when no `limit` was supplied, not a
ceiling on one — fixed with `Math.min(requested, DEFAULT_CAMPAIGN_LIMIT)` in
`src/lib/notifications/telegram-onboarding.ts`, regression test
`tests/telegram-onboarding-campaign-cap.test.ts`, proven to fail against the reverted line before
trusting it). The password-link bulk tool (up to 100 emails/run, "select all filtered") was
investigated and found to need NO change — already hard-capped per-request, reports overflow as
`deferred` rather than dropping or auto-continuing it, and the UI shows the real count before
selection. Both audited findings from this project are now closed.

**Implemented 2026-08-13, merged as PR [#2088](https://github.com/it-gawish-hr/phoenix-people-workforce/pull/2088) → commit `9210bb41`, live in prod (confirmed via `/api/healthz`).**
Cut/trimmed: weekly-plans `manager_approve`/`hr_acknowledge`/approved-edit-request; direct-orders
`submitted`/`revived`/`released`/`cancelled` (courtesy copies to SFE Manager + Super Admin dropped,
approve-with-next-step narrowed to just the next approver); vacation's two confirmed duplicate-sends
(`manager_review:approve`, `next_manager_review` — same email fired twice, proved to the minute in
prod) plus the submit/resubmit self-confirmations; outstation `request_submitted` re-addressed from
the employee to the direct manager (with a manager→skip-level→Super-Admin fallback chain, needed
because a naive version would have zeroed out Super Admin oversight for every one of the CEO's direct
reports); internal-messages stopped auto-emailing every chat message and the "send as email"
checkbox no longer defaults to checked; marketing `request_submitted` self-confirmation cut.

**Process trap worth repeating for the next multi-file change like this:** 6 parallel implementing
agents each grep'd their own module's test files for now-invalid assertions — thorough, but not
exhaustive. CI's `validate` job caught one they all missed: `tests/marketing-premium-notifications.test.ts`
asserted a source-text occurrence COUNT (`templateContext` wiring appears exactly twice) that lived
in a file none of the six agents' per-module searches surfaced, because its name doesn't obviously
say "marketing." Lesson: after an agent-driven multi-file change, grep the WHOLE `tests/` tree for
every removed/renamed identifier yourself before trusting the pre-push gate — the pre-push hook here
only runs lint+typecheck locally, not the full suite; only GitHub's `validate` job does that, and it
runs after push. One real bug also slipped past agent self-review: removing the vacation
resubmit-confirmation email left `const directory = await getEmployeeDirectory()` behind as dead
code (caught by the pre-push lint gate, not by any agent). Also see
[[gh-pr-merge-local-cleanup-fails-in-shared-worktree]] for a merge-time false alarm hit in this same
session.
