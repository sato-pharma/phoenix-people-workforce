---
name: notification-duplicate-email-fanout-fix
description: "Root cause + fix for automated emails being sent 2-4x to the same inbox. PR #1259 MERGED 2026-07-22T17:27Z."
metadata: 
  node_type: memory
  type: project
  originSessionId: b8408319-c940-4023-9aab-6ce86fe5f37c
  modified: 2026-07-23T09:11:02.120Z
---

Root cause of "every automated email sent twice/triple" (owner report, 2026-07-22):
`createSystemNotification` (src/lib/notifications/system.ts) fanned out one independent
email per governed recipient. For "general"-type modules (outstation, vacation, marketing
requests, attendance digests, etc. — most business-workflow notifications), each
per-recipient send independently re-resolved and re-added a shared `HR_NOTIFICATION_EMAILS`
env address list. An event with N governed recipients (e.g. line manager + CEO + Super
Admin = 3) therefore delivered the same notification to shared inboxes N times. Confirmed
directly against production `notification_outbox`/`email_delivery_events` before fixing —
not just theorized. Ruled out first: Cloud Scheduler double-firing (checked job configs +
Cloud Run logs, clean) and outbox idempotency (claim/dedupe logic was already solid).

**Why:** `shouldUseWorkflowEmailEnvelope` — the existing "send one To/Cc email instead of
N" consolidation path — was gated behind a module allowlist AND a resolvable subject
employee HR ID, narrow enough that most duplicate-prone modules (attendance digests etc.)
fell through to the buggy per-recipient path instead of using it.

**Fix (PR #1259, branch `codex/notification-dup-email-fix`):** `shouldUseWorkflowEmailEnvelope`
now collapses ANY multi-recipient email event to one send (primary→To, rest→Cc) — dropped
the module allowlist and identity pre-check (the identity guard still runs downstream in
`buildChannelEmailInput`/`validateNotificationEmailIdentity`, just once instead of Nx).
In-app/Telegram stay per-recipient (correct, unaffected). Also added a hard-CC of
`omar.anwar@satopharma.com` on every automated notification email (owner request), excluded
from password-reset/account-setup links since those carry a one-time auth secret.

**How to apply:** If a future duplicate-email report comes in, check `email_notification_policies`
recipient_modes and whether the affected module goes through `createSystemNotification`'s
governance-resolution branch (multiple recipients, no explicit `recipientHrId`) vs the
direct `safeSendNotificationEmail`-with-a-single-resolved-list path (contract_renewal/birthday
style) — the envelope consolidation only applies to the former.

**Round 2 (same day, owner sent a screenshot of a live duplicated/garbled email):** the first
fix only covered the governance-resolution branch. Callers that loop `createSystemNotification`
with an EXPLICIT `recipientHrId` per recipient (the "explicit recipient" branch) bypassed
consolidation entirely — confirmed in `notifyOutstationSubmitted` (outstation, 3x) and
`notifyRecipients` in vacation/service.ts (HR acknowledgement, 4x). Added
`createSystemNotificationForRecipients(input, recipientHrIds)` to system.ts as the reusable
consolidation helper for this pattern (per-recipient idempotencyKey suffixing to avoid
`notification_events` row collisions on a shared eventKey) and wired it into both call sites
plus `runOutstationSlaDaily`. Also fixed a SEPARATE content bug the screenshot exposed: the
outstation submit email's `message` duplicated the entire metrics table as prose, and the
template's Amount/Trip-date fields rendered blank because the metrics used labels ("Expected
total"/"Claimed total", combined "Trip dates") that don't match what the OUTSTATION email
template looks up via `metricValue()` ("Amount", "Trip start", "Trip end" — confirmed correct
against the already-working `request_rejected` notification in the same file).

**Resolved, not a bug:** the THIRD apparent duplicated case — the weekly attendance digest
("Weekly attendance digest" / "Digest review needed" subjects, 2x per employee, seen in
production `notification_outbox` rows dated 2026-07-20) — turned out to be moot: the whole
feature was fully removed via [[attendance-weekly-digest-selfsettlement-spec]] (PR #1253,
merged to main 2026-07-22T12:21Z, zero digest tables left in production). That's WHY the
source wasn't findable in a fresh `origin/main` worktree — it wasn't hiding in an unmerged
branch, it's genuinely gone. What looked like the feature's source in the main repo's working
directory was from that repo's stale, un-rebased branch, not evidence of anything still live.
Background follow-up task was dismissed as moot.

Related: [[notification-recipients-and-migration-backlog-2026-07-19]], [[email-template-unification]].

**Update 2026-07-23:** PR #1259 MERGED to main.
