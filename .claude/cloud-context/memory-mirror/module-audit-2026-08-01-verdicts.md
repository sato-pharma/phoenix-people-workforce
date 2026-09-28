---
name: module-audit-2026-08-01-verdicts
description: "Adversarial-verification verdicts (CONFIRMED / PARTIAL / refuted-sub-claim) for the 2026-08-01 module audit — the per-finding calls behind the cross-cutting themes in module-audit-2026-08-01-digest. POINT-IN-TIME: line refs have rotted and many findings may be fixed since, so verify each against live code before acting; the value that survives is the adversarial CORRECTION on each lead (what was overstated, what was refuted, what is genuinely still dangerous)."
metadata:
  node_type: memory
  type: project
  originSessionId: 40984f77-33d2-45f9-94fe-bf7b1b13be9d
  modified: 2026-09-26T02:20:49.689Z
---

# Adversarial-verification verdicts — 2026-08-01 module audit

**Read this as a snapshot, not current state.** These are the CONFIRMED/PARTIAL calls from the adversarial
pass over the 2026-08-01 audit leads (workflow `wf_6db2a1ad-d04`, completed on resume). The repo does
~46 commits/day, most of them fixes, so **line numbers here are stale and several of these are likely
already closed — re-verify against live code before acting on any one.** The durable payload is the
*correction* the verification applied to each lead: which were overstated, which sub-claims were refuted,
and the few that are genuinely dangerous. The cross-cutting patterns (nav-vs-server-gate drift;
tested-engine ≠ production-path; fail-open service-role guards) live in [[module-audit-2026-08-01-digest]].

## The findings that still matter most (real, and money/access/data-touching)

- 🔴 **outstation ticket-rule bypass → a pre-approved payroll row with no human gate.** `decideOutstationRequest`
  (`outstation/decision.ts`) is imported ONLY by its test; production re-implements the decision inline and
  DROPS the ticket rule. The ticket mandate is gated on `offlineCaptured`, which the online submit route
  reads straight from the client body — so any caller can self-flag "offline", skip the ticket, and land an
  outstation expense written pre-approved (`hrApproved:true`, status Approved, total = claimed). Worse than
  the original claim. (An instance of the digest's tested-engine ≠ production-path theme.)
- 🔴 **field-GPS centroid pass overwrites MANUAL brick pins.** `brick-centroids.ts` pass 1 upserts on
  `(source_type,source_key)` without checking the existing row's provider, so a re-run clobbers manual pins
  and nulls their `manual:<hrId>` attribution — the exact guard both offline scripts and the territory
  service say must always be present. Triggered by re-running a centroid build after pins are placed, which
  is the documented usage pattern.
- **/api/admin/data-backup/reset runs a destructive bulk wipe (~20+ tables) with NO audit trail** beyond the
  returned counts. Gated to sysadmin workspace + a literal "CONFIRM DELETE" string, so not unauthenticated —
  but genuinely unlogged.
- **`?? getSupabaseAdmin()` RLS fail-open** at the payroll service paths, and `listSalaryBatches` has no
  internal scope filter — over-grant lets SFE Manager see the full batch METADATA list (not amounts). Matters
  most where app-side scoping is absent (`listSalaryBatches`, the two `getLatest*` funcs); elsewhere it only
  removes defense-in-depth. (Digest's fail-open-service-role theme.)
- **Confidence-gate "held" emails are not terminal in the outbox** — `classifyOutboxSkip` has no held branch,
  so held mail retries on backoff, each retry inserts a new review row, a time-decaying hold (fanout 15-min
  window) can auto-send unreviewed at ~20-25 min, and approve-then-a-later-gate-passing-retry use different
  idempotency keys → double-delivery; deterministic holds burn all 5 attempts and leave up to 5 sibling held
  rows.

## CONFIRMED, with the correction that narrows or reframes them

- **weekly-planning — PlansWorkspace renders Approve/Return/Reject/bulk buttons for Super Admin** on
  manager/CEO queues the server then 403s. Correction: the SERVER is correctly locked (SA has NO standing
  bypass — owner-confirmed, and the Action Center implements it right with a test); the workspace is the
  outlier, and its comment claiming SA "mirrors the server guards" is a lie against the guard code. SA's real
  step (HR acknowledge) works.
- **weekly-planning — CEO and the literal 'Manager' role can't post plan comments** (`addPlanComment` needs
  `weekly_plans:update`, absent from their matrix rows) while the UI shows the composer. Correction: only the
  literal Manager + CEO; the actual manager-stage approver roles (District/Regional/National Sales/Product/
  GPM/SFE/Training/Marketing) all hold update and CAN comment. Bug vs intent, not design.
- **weekly-planning — revising an approved plan hits the active-period unique index** (parent header never
  demoted → 23505). Correction: the end user sees a friendly "you already have an active plan" message; the
  raw duplicate-key text surfaces only in the API body. Revise-as-draft works; only submission collides; it
  leaves orphan draft rows behind.
- **payroll — automated `publishToPayslips` never fires per-employee payslip-available notifications** (only
  executives get notified). The automated path reopened the gap the legacy workflow's approve step was built
  to close.
- **payroll — /download and /bank-file lack the approved/locked status gate that /payslips enforces** →
  pre-approval salary/bank data exportable. Correction: rows are per-role scoped (an Employee exports only
  their own draft rows), and the missing gate is partly by design (finance must pull the bank file at
  `part1_ready`, before approval); the real defect is the breadth of `payroll:export`, granted to nearly
  every role including Employee and Medical Rep.
- **auth — `getRequestIp` takes the leftmost `x-forwarded-for`**, which behind Cloud Run is client-supplied →
  IP blocklist + per-IP login throttle evadable, audit IPs spoofable. Correction: the per-ACCOUNT defenses
  (failed-login lockout keyed on loginId, actor-keyed rate limit) remain effective, so single-account brute
  force is still throttled; only IP-scoped defenses and audit-IP fidelity are compromised.
- **auth — password policy is length ≥ 8 only** at every write point (setup, change, route). No complexity,
  no common-password/dictionary check, no reuse history. bcrypt cost 12.
- **auth — PUT /api/admin/scope-visibility writes scope overrides with no audit log and no value validation**
  (an out-of-enum sales scope flows unchecked into `getSalesScope`). Admin/update-gated, so privileged silent
  tampering, not an unauthenticated hole.
- **sales — legacy Achievement pipeline allows two approved batches for the same line+month** (content-hash
  dedup only; no `(line,period,approved)` unique index like SoS has) and the UI never warns. Correction:
  Sales Queue uploads were retired at the UI and from rep-achievement analytics on 2026-07-29, but the
  endpoint stays intact (backs Reconciliation) with Approve/Replace/Delete live, and double counts still
  propagate to the sales dashboard, Overview, Platform Metrics and Command Center. The correct workflow is
  Replace (which marks the original replaced); the hole is approving a fresh non-replacement upload.
- **sales — `loadWeeklyFactUncached` + `loadSosByCustomerUncached` pass only `p_regions` and drop the area
  bound for seat-scoped DMs/RMs** → they see the whole widened region set (their region plus any foreign
  region merely containing one owned out-of-region area) on the Weekly and SoS-by-customer dashboards. The
  sibling SoS tabs DO pass `p_areas`, so it's inconsistent within the module; the fix needs new SQL
  signatures + area columns in the views. The `scope.ts` comment "every analytics_* RPC accepts p_areas" is
  false for these two.
- **comms — resignation workflow "complete" only mutates `employee_resignations`** (no employee termination,
  no access deactivation). Direction A confirmed + sharper: a resignation submitted via POST /api/resignations
  is never terminated by any workflow step — the employee stays active with live access after "Completed"
  unless someone separately calls the resign RPC. Direction B ("nothing ever advances") overstated: a human
  can advance the RPC-inserted row via the same dashboard buttons; the real cost is state inconsistency +
  false SLA nag emails.
- **comms — legacy probation terminate omits `suppressWorkflowNotification`** → a company-decided termination
  is announced with a voluntary "Resignation Submitted" email (the intelligence path suppresses it correctly).
  The SAME omission is in the contracts non-renewal terminal path. Recipients get doubled, contradictory
  notices.
- **territory — GET /api/territory-management/search gates only `sales:read` and `searchBricks` takes no
  AccessContext** → nationwide brick pins (names/ids/coords/provider) leak to roles the module excludes,
  including Medical Rep. The sibling map route passes access and re-checks scope, proving it's a gap. What
  leaks is reference geography, not sales figures — a fail-closed violation + recon surface.
- **territory — CRM check-in delete-reconciliation lacks the `synced_at >= runStartedAt` race guard the visits
  path has** → overlapping syncs can delete a check-in a concurrent sync just wrote. Bounded: 50%-of-window
  cap, best-effort (never fails the run), and self-heals on the next covering sync; interim cost is the
  visit's time resolution degrading from GPS tier to save tier.

## PARTIAL — overstated leads; do NOT act on the original framing

- **payroll "My Earnings" fabricated salary figures — OVERSTATED.** `empty.payroll` gates the whole section,
  so the worst case (no-data employee seeing pure fallback) can't happen. Fabrication needs an employee WITH
  records but missing salary fields → Base=0 / allowances-only (implausible-looking, not a convincing fake);
  base salary is never invented, only ECOL/fuel. Real residue: no "estimated/incomplete" marker, and the four
  headline stats come from the fixed-salary reference even when a record exists.
- **auth CSRF no-op — LITERAL claim confirmed, EXPLOIT refuted.** `assertSameOriginMutation`'s return is
  discarded (bare call) at force-logout + recruitment/intake/retry, so the in-route check is dead code — BUT
  `proxy.ts` middleware independently enforces the identical same-origin check on every /api mutation and
  neither route is exempt, so a cross-origin POST is still blocked. Lost defense-in-depth, not a live CSRF hole.
- 🔒 **outstation `notifyExpensesAddedToPayroll` built with zero callers — NOT a defect; do NOT wire it up.**
  It is a deliberate, lint-acknowledged, test-ENFORCED disconnection: `tests/outstation-notifications.test.ts`
  asserts its absence as governance rule 1 (the only outstation/expense email is the HR rejection). Wiring it
  breaks the test. At most a delete-vs-keep cleanup candidate.
- **outstation car-evidence cross-employee overwrite — REFUTED.** The `<hrId>` path segment is server-forced
  from the authenticated caller and `/` is stripped, so no cross-employee traversal. Real residue: a
  same-employee cross-REQUEST evidence-tamper vector (reuse a draft id to overwrite the photo behind your own
  already-approved claim).
- **outstation policy fields `gps_accuracy_threshold_meters` + `max_offline_sync_delay_hours` — CONFIRMED
  pure decoration.** CRUD-editable, enforced nowhere (`validateCapturedLocation` never reads them; no
  client-side gate either). An admin can set 5m / 1h and nothing changes.
- **sales — `deleteSourceOfSalesUploadBatch` doesn't refresh marketing ROI facts / invalidate cache;
  "indefinitely" OVERSTATED.** Every later validated SoS upload triggers a batch-scoped ROI refresh that heals
  any request whose ROI window overlaps the new periods; staleness is truly indefinite only for historical
  months no future upload overlaps (a manual Super Admin/CEO full refresh exists). The cache half is ≤5-min
  TTL, and the SoS dashboards stay correct (rollup cascade-deletes with the batch).
- **territory — `pinConfidence` provider-name switch; premise REFUTED.** "No writer produces these names" is
  wrong — `resolve-brick-pins.mjs` writes all four (the switch matches the offline taxonomy that seeded
  `geo_locations`). Real narrower defect: the three names the RUNTIME builder writes (`field_gps`,
  `locationiq`, `google`) have no case, so ground-truth field-GPS pins display at 50% "Unverified".
