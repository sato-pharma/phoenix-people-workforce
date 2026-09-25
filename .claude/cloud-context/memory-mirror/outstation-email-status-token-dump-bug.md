---
name: outstation-email-status-token-dump-bug
description: "Outstation submit-alert email had blank Line/Area/Manager/Approval-Flow + raw ISO dates + a Status token dumping ALL metrics as one wall of text; PR #1424 (MERGED) fixed the SHARED default context, not just outstation"
metadata: 
  node_type: memory
  type: project
  originSessionId: be399c8c-a72f-46a4-9bad-8d0f0c78085f
  modified: 2026-07-29T07:50:33.370Z
---

**Status: PR #1424 confirmed MERGED 2026-07-28T12:25:31Z** (re-verified 2026-07-29 via `gh pr view`).

The outstation-submitted email (→ Super Admin + CEO on every submission, see [[outstation-expense-notifications-reject-only]]) had a template (admin-edited 2026-07-22, DB `email_templates.outstation`) that was well-formed, but `src/lib/notifications/email.ts`'s SHARED default context builder (`sendNotificationEmailDirect`'s `context: {...}` object literal feeding `sendTemplatedEmail`) never populated `managerName`/`duration`/`approvalFlow` at all, and `status` was wired to `notificationMetricStatus(input)` — a function that joined **every single metric** into one `"Label: value | Label: value | ..."` string, instead of the caller's own short `{label:"Status", value:...}` metric that vacation/probation/resignation/excuses/contracts already supply correctly. With outstation's ~20 metrics, that produced a giant wall of text filling the whole email; `Line`/`Area` were also blank because outstation only emitted a combined `"Line / Area"` metric while the template needs them separate.

**Distinct from [[probation-email-no-data-token-gap]] and [[email-render-map-vs-placeholderhints]]**: those tokens (`managerName`, `duration`, `approvalFlow`, `status`) were ALREADY registered in `TOKEN_REGISTRY`/`contextVariables()` (verified: `tests/email-render-harness.test.ts` + the token-registry-consistency test both passed before AND after this fix) — the gap here was purely that `sendNotificationEmailDirect`'s own object literal never set a value for them, so every migrated-template caller got `undefined`/blank UNLESS it separately overrode via `email.templateContext` (which `contract_renewal` already does for `status` — that's why it was unaffected). This is the shared DEFAULT plumbing, not one domain's `templateContext` gap.

**Blast radius (confirmed via prod `email_templates` query)**: `status` token used by 6 active templates — outstation, coaching_report, excuse_decision, general, probation, weekly_plans — ALL were getting the metrics-dump instead of their real status. `managerName` used by 2 — outstation, leave_rejection (leave_rejection's Manager Name field was ALSO silently blank, unrelated to today's report). `duration` used by 2 — outstation, excuse_decision. `approvalFlow` — outstation only.

**Fix (PR #1424, branch `codex/outstation-email-notification-fix`, unmerged at time of writing — re-verify merged state before relying on this)**: `notificationMetricStatus()` removed; `status` now reads `metricValue(input, "Status")`. Added `managerName`/`duration`/`approvalFlow` as `metricValue()` lookups in the shared context. Outstation's own metrics array (`notifyOutstationSubmitted` in `src/lib/outstation/service.ts`) now supplies separate `Line`/`Area`/`Manager`/`Approval Flow`/`Status` metrics and formats trip dates via `formatDateValue` instead of raw ISO. Manager name is read from the already-loaded employee directory (`EmployeeDirectoryRow.managerName`), no extra query needed.

**How to apply:** if a future report says an email field is blank, check BOTH layers: (1) is the token in `TOKEN_REGISTRY`/`contextVariables()` at all (the [[email-render-map-vs-placeholderhints]] gap), and (2) does `sendNotificationEmailDirect`'s context object literal (or the caller's `email.templateContext` override) actually set a value for it (this gap, and [[probation-email-no-data-token-gap]]). A token can pass every registry/consistency test and still render blank if nobody's object literal writes to that key — the harness tests token *coverage*, not that every caller populates every token with real data.
