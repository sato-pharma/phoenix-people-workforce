---
name: dm-approval-chain-drops-the-ceo-never-the-nsm
description: "A District Manager's approval chain drops the CEO but must NEVER skip the National Sales Manager — \"skip the second step for every DM\" is the wrong implementation and silently removed the NSM for the 3 DMs who report through a Regional Manager."
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 38cac8f5-eef9-4ca8-9b4c-3c23b0534074
  modified: 2026-10-01T00:00:00.000Z
---

Owner rule, stated 2026-08-19 after spotting it live: **"Never skip the national sales manager in
anything regarding any district manager."** He saw DSM Ahmed Mohamed Abdallah (B-74) submit a
vacation request whose chain ran **Regional Manager → HR**, with the NSM missing.

This CORRECTS, but does not cancel, his 2026-08-15 rule (shipped as #2149): *drop the CEO from a
District Manager's approval chain*. Both hold at once. The trap is that they look like the same
rule and are not:

- **14 of 17 active DMs report straight to an NSM.** Their second (manager-of-manager) step *is*
  the CEO → correctly dropped.
- **3 report through Regional Sales Manager Hany Saad (PD-0001)** — B-74, B-154, PD-0010. Their
  second step is **NSM A-12 Ali Mohamed Ali Elsayed** → must be KEPT.

#2149 implemented the CEO drop as `requesterRole !== "District Manager"`, which removed the second
step for all 17 and so deleted the NSM for those 3. Fixed in #2196 by gating on **who the second
approver is**, not on the requester's role: a DM keeps the step only when that person classifies as
`nsm`. The shared gate is `shouldIncludeManagerOfManagerStep` in `src/lib/vacation/approval-flow.ts`,
used by all three call sites (chain, request row columns, submission preview).

**Applied to PRODUCTION 2026-08-19, do NOT undo.** #2196 merged to `main` as `65f7cd89` at 13:59
Cairo; **confirmed live** — `/api/healthz` on the public domain returned that revision at 14:01
Cairo, ~100s after the merge, and `app_error_events` recorded nothing new afterwards. Both of B-74's in-flight requests were repaired by hand in prod — a `manager_of_manager`
step (approver `A-12`) inserted into `v2_vacation_approval_steps`, `manager_of_manager_hr_id/_name`
set on the request, and the 16 Aug one moved back `pending_hr` -> `pending_manager` so Ali must
approve before HR records it. Owner approved that reversal explicitly. The rows were written
directly, so the app's own notification never fired; Ali was then notified separately at 14:06
Cairo with two **in-app-only** notifications (`createSystemNotification` with
`channels: ['in_app']`), events `4388e53d…` and `1c7b2455…`. **No email was sent** — proved by
before/after counts: `notification_deliveries` where `channel='email'` stayed at 4502 and
`notification_outbox` stayed at 1752 with 0 unsent. A completeness sweep confirmed no other
in-flight DM request is missing its NSM step.

**If you ever need to re-notify someone by hand, this is the safe recipe:** explicit
`channels: [...]` wins outright at `resolveBasePolicyChannels` (system.ts) and every downstream
guard only ever REMOVES channels, so `['in_app']` cannot reach email. Take the four counts above
before and after, and prove the email count did not move. See [[never-fire-bulk-emails-ever]].

**Why:** the chain is the company's real sign-off record, and a skipped approver is invisible — no
error, no warning, the request just quietly moves on. Two of B-74's requests reached HR without the
NSM ever seeing them.

**How to apply:** never express an approval-chain rule as "role X skips a step". Express it as
"this step is included when the approver is/isn't Y". Before changing any chain, run the DM
population split above and check both branches — the majority case will look correct while the
minority silently loses its approver. **Do not go looking for this same gap in Excuses** — a
District Manager cannot file an excuse at all (`EXCUSE_EXCLUDED_ROLES` in
`src/lib/excuses/service.ts` blocks District Manager + Regional Manager; excuses are a Head-Office
concept, owner confirmed again 2026-08-19), so there is no chain there to skip anyone. See
[[excuse-module-excludes-dsm-rm]]. Outstation keeps manager-of-manager for every role, so this
carve-out lived only in vacation. Related: [[marketing-manager-chain-target-is-sales-only]],
[[organogram-chart-source-is-au-seat-model-not-directory]].
