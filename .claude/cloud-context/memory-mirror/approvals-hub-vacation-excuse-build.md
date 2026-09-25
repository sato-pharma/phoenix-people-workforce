---
name: approvals-hub-vacation-excuse-build
description: "The Approvals Hub (Vacation + Excuse) is BUILT and live in BOTH shells — app/(admin)/admin/approvals-hub and app/employee-portals/approvals-hub, with a pending-count API — and the later Actions consolidation now sits beside it. This file holds the structure, the access model and the deferred items; it is not open work."
metadata: 
  node_type: memory
  type: project
  originSessionId: db90c0ef-8e72-4dda-bc89-00d392e2760c
---

Built 2026-07-04 per [[project-leave-excuse-approver-model]] + the approved plan
`.claude/plans/create-a-new-sidebar-mossy-cookie.md`. **NOT yet committed/pushed** — awaiting the
owner's explicit delivery approval ([[feedback-auto-git-workflow]] is LOCKED).

**Where:** isolated worktree `F:\Phoenix Workforce\_wt-approvals-hub`, branch
`codex/approvals-hub-vacation-excuse` (based on origin/main `babf0bf0`; NOTE origin/main has since
advanced via another session's fetch — rebase before PR). Built in a worktree because another
session was active in the primary tree.

**What shipped (Phase 1):** new sidebar section "Approvals Hub" (near top, both shells) with TWO
links — "Vacation Approvals" (all leave types incl. sick) + "Excuse Approvals" — each its own
2-tab page (Response / Response history), each with its own actionable-now pending badge. Separate
dedicated page per request (`/{admin|employee-portals}/approvals/{vacation|excuse}/[id]`) with full
details + stage tracker (timeline + waiting-age) + Approve(1-click)/Reject/Return, every action
confirms, reject+return require a reason, HR Acknowledge = Super Admin only when it's their turn.
Pending page grouped: Awaiting you / Coming to you (view-only, leave only) / Your own (read-only).
Gated to confirmed approver roles (admin: Super Admin/CEO/Finance Mgr/Financial Advisor; portal:
DM/RM/NSM/PM/GPM/Marketing Mgr/Manager). No approval workflow logic changed — reuses
`decideVacationRequest`/`decideExcuseRequestAsManager` + existing audit/notifications.

**Key files:** `src/lib/approvals-hub/service.ts` (buckets/badges/detail/href helpers),
`src/components/approvals-hub/*`, the 8 pages, `app/api/approvals/{vacation,excuse}/pending-count`.
Removed the Vacation Action Center (page + component + nav). Stripped leave/excuse from the combined
hub (`getAwaitingMyActionItems` filter; renamed nav link to "Other Approvals"). Repointed all
leave/excuse notification/CTA URLs to the new pages (vacation service ×6, excuse `actionCenterHref`,
`notifications/hrefs.ts` per-reader remap of legacy+new, CEO leave signal); removed the sick-leave
one-click token buttons. Registry: added `/admin/approvals/**` + `/employee-portals/approvals/**`
page entries (leave:read, so Finance Mgr/Financial Advisor aren't blocked by the /admin/** admin:read
catch-all) + the 2 count APIs.

**Validated:** typecheck ✓, lint ✓, `npm run test` 310 files ✓ (new `tests/approvals-hub.test.ts`),
production build ✓, dev-server smoke test ✓ (Super Admin admin pages 200 + count APIs; DM portal
pages 200 with grouped sections; Employee portal read-only 200).

**Phase 2 enhancements (2026-07-04, same day, still same branch/worktree, still uncommitted) — all
6 done:** (1) attachment evidence links — widened `createVacationAttachmentReviewUrl`'s gate beyond
HR/Super-Admin to also allow the currently-assigned active-turn approver (server-side, per-request);
also fixed a real consistency bug found while doing this — my own `isHrActor` helper used
`isHrAuthorityRole` (incl. Talent Acquisition) instead of vacation's real `isAllVacationVisibility`
(Super Admin/system only) — now exported+reused, one source of truth. (2) portal per-link pending
badge — exported admin's `NavBadge` component, reused verbatim in the portal sidebar (same
`nav-badge-store.ts` 30s-poll client, no new mechanism). (3) overdue highlighting — new
`sla-thresholds.ts` (pure, unit-tested: leave=3d/excuse=2d, matches `action-center-hub.tsx`'s
SLA_THRESHOLDS exactly) + `sla-badge.tsx` (chip for lists, badge for detail tracker). (4) history
filter+export — new `HistoryList` component (employee/date/decision/type filters +
`ExportXlsxButton`); type filter needed a `ResponderHistoryItem` (local type, NOT added to the
shared cross-module `HistoricalApprovalItem`) enriched via one small direct query per page load.
(5) company-wide "All Decisions" 3rd tab, Super-Admin/system-scope only (`isAllVacationVisibility`
gates both the tab's existence and the underlying query, defense-in-depth) — hoisted+exported
`decodeDecision` out of `action-center/service.ts` (was a private nested fn) to reuse instead of
duplicating. (6) blank-HR-ID system-actor bug — **investigated live, could NOT reproduce after the
Phase-1 HR-actor fix**: 4/4 consistent live retests returned the correct company-wide count with
zero errors even with full diagnostic logging added; root cause is most likely the dev-server
cold-compile race (~30s first-request) seen earlier, not a deterministic code defect. Static tracing
confirmed `canSeeVacation`/`isAllVacationVisibility`/`hrIdsMatch`/the report RPC's scoping are all
null-safe. Shipped anyway: permanent (non-DEBUG) error logging replacing every silent
`catch(() => null/0)` in the responder service, plus a unit test locking in the blank-hrId-Super-Admin
scenario — so a future regression is immediately visible instead of looking like "nothing pending."

**Phase 2 validated:** typecheck ✓, lint ✓, `npm run test` 310 files ✓, `npm run check:harden`
exit 0 ✓, live dev-server verification (evidence link renders for HR on a real prod compensatory
request; portal Vacation/Excuse Approvals links present for a District Manager; "All Decisions" tab
button appears for Super Admin, absent for District Manager; pending-count APIs correct; a real
0-age request correctly shows NO overdue chip, confirming the threshold logic isn't over-firing).

**Deferred (owner-confirmed order, unchanged):** (1) Weekly/Monthly Plan Approvals module, (2)
Marketing Requests Approvals module — links NOT added yet. Then (3) the who-approves-whom routing
corrections (Finance Mgr approves reports; Financial Advisor↔Finance Mgr; CEO↔Financial Advisor) —
separate workflow change. Minor residuals: "approval impact preview" nicety from the removed VAC
component (superseded by real attachment links + tracker, arguably better); combined-hub history
tab still lists leave/excuse (low impact); sick-leave "awaiting" inclusion is best-effort (legacy
flow isn't in `getVacationActionCenterData`) — worth a live sick-leave-request test before shipping
further.

**SHIPPED to PR 2026-07-04**: commit `1ec5185a`, pushed, **PR #814 open**
(https://github.com/Phoenix-HR/phoenix-people-workforce/pull/814), base `main` ← head
`codex/approvals-hub-vacation-excuse`, mergeable=clean (no conflicts, NOT rebased onto the newer
origin/main — rebase needs separate approval per AGENTS.md so it was skipped). Pre-push gate
(routes, migrations, lint, typecheck) passed. **NOT merged** — owner explicitly said commit+PR
only, no merge.

**Follow-up 2026-07-04, same PR, commit `eae09cfb`**: owner requested a 3rd tab — "My Requests" —
showing the caller's own submissions (pending AND decided) in one report that never drops an item
once it's responded to. Reused the EXISTING cross-module `getMyRequestItems`/`MyRequestItem`/
`MyRequestsList` (the same components the old combined hub's "My requests" tab already used) —
filtered per module in two new thin wrappers (`getMyVacationRequestItems`/`getMyExcuseRequestItems`
in `src/lib/approvals-hub/service.ts`), href repointed to the new per-request pages. This properly
**replaced and removed** the earlier "Your own requests" read-only pending-tab subsection (which
only showed in-flight submissions and silently dropped them once decided) — deleted the dead
`mine` bucket end-to-end (types, computation, UI, superseded test assertions) rather than leaving
it as unused cruft alongside the new tab. Live-verified against real prod data: A-9's own approved
compensatory leave now shows correctly in his My Requests tab with the right status + working link.
Validated: typecheck/lint/310 tests/`check:harden` all clean. Pushed — PR #814 updated, still open,
still not merged.

**Follow-up 2026-07-05 — Weekly/Monthly Plan Approvals module (3rd Approvals-Hub module), built in
the SAME worktree/branch, NOT yet committed** (user said "start" = build only; awaiting explicit
commit approval per [[feedback-auto-git-workflow]]). Owner's 4 MCQ decisions: (1) **consolidate
now, fix routing later** — keep today's plan routing untouched; (2) self-contained review page;
(3) weekly+monthly share one page; (4) show link to pure submitters (DM) for My Requests.
**Critical finding baked in:** today's plan workflow (`weekly-planning/workflow.ts` +
`assertCeoReviewer`) hard-wires *every* plan's 2nd approval to the **CEO** — there is NO
manager-of-manager step in code. So the owner's confirmed model (mgr→mgr-of-mgr→HR standard, CEO
only for PM) only matches the PM case today; honoring it fully = a workflow + DB-function migration,
explicitly **deferred**. This build is pure consolidation (0 workflow change): reuses
`decideEmployeePlan` (manager_*/ceo_* actions) + `acknowledgeEmployeePlan` (HR=Super Admin only via
`isHrReviewer`) + `resolveApproverPlanStage`. **What shipped:** 4-tab page (Response
awaiting/coming-to-you, History, My Requests, All-Decisions Super-Admin-only) in both shells at
`/{admin|employee-portals}/approvals/plan(/[id])`; self-contained per-plan page = read-only
day-by-day calendar (**extracted** `WeeklyPlanDetailView`→shared `src/components/action-center/
weekly-plan-calendar.tsx`, re-imported by the combined hub — one source) + 4-stage tracker
(Submitted→Direct Manager→CEO→HR; added a "submitted" case to RequestTracker) + `PlanDecisionActions`
(approve 1-click/reject+reason/return+reason/HR-acknowledge, confirm each; posts to existing
`/api/weekly-plans/[id]/decision` & `/acknowledge`). Plan href helpers + all plan responder fns in
`approvals-hub/service.ts`; `/api/approvals/plan/pending-count` + registry entry (weekly_plans:read);
nav links gated **admin = Super Admin+CEO**, **portal = DM/RM/NSM/PM/GPM/Marketing Mgr/Manager** (new
`showPlanApprovalsTab` flag mirrors the plan-builder roles); `plan-approvals-pending` badge (reuses
NavBadge). Notifications repointed: manager-review/CEO/HR-ack CTAs → new plan pages (via
`planReviewActionUrl` + `notifications/hrefs.ts` remap); **employee-facing** returned/rejected/
acknowledged stay on the planner; drift-check digest stays on the planner dashboard. weekly_plan
**stripped** from combined "Other Approvals" (`getAwaitingMyActionItems` filter). SLA plan=2.
**Validated:** typecheck/lint/**310 tests** (new plan assertions in `tests/approvals-hub.test.ts`)/
`check:harden` exit 0; all 4 routes + count API registered. **Live-verified vs prod** (0 plans
awaiting now → count 0 correct; used a real final_approved plan to confirm the read-only detail
renders calendar+4-stage tracker; All Decisions populated with real deciders; Super Admin sees All
Decisions, DM does not).

**Plan Phase-2 enhancements 2026-07-05 (same worktree/branch, still uncommitted; owner picked these
before committing, like the vacation/excuse Phase 2):** (1) **owner planner button** — on the
per-plan page, when the viewer is the plan's own submitter, a prominent "Open in my planner" button
(role-aware `plannerHref`) so a returned/draft plan is one click from editing; My Requests still
lands on the hub detail. (2) **refresh-on-conflict** — a stale/conflicting decide now `router.refresh()`s
so the card self-corrects. (3) superseded by (4). (4) **premium per-activity return composer** —
rewrote `plan-decision-actions.tsx`: "Return with notes" opens a purpose-built composer (general
reason + activities grouped by day, each flaggable with its own note) that POSTs the existing
`returnNotes:[{itemId,note}]` workflow (needed carrying plan item ids → new `returnableActivities`
on the detail + `buildReturnableActivities`). (5) **approver context panel** (`plan-approver-context.tsx`)
— reuses the existing `/api/approvals-hub/employee-context` endpoint (no new backend), shown **only
to approvers** (`!isOwner`), degrades to "Context unavailable" on 403. (6) **niche actions** —
surfaced `edit_requested` decisions (Allow edits / Keep locked → `/edit-request-decision`) and
"Request visit details" (→ `/request-visit-details`) in the hub; `edit_requested` added to the
awaiting bucket for the assigned manager/SA. Extras: **composition summary** (`plan-summary.tsx`
`PlanCompositionSummary` — premium stat chips by activity type + "N of M days empty" coverage),
**period badge** (`PlanPeriodBadge` upcoming/current/past), **overdue-first sort** (`byMostOverdue`).
All in `PlanApprovalDetail` (new fields: isOwner, plannerHref, returnableActivities,
isEditRequestDecision, canRequestVisitDetails, composition, periodStatus). **Validated:**
typecheck/lint/**310 tests**/`check:harden` exit 0. **Live-verified vs prod**: real plan detail
renders "Plan at a glance" with correct chips (Double visit/Office-Admin/Other, "6 activities · 5
days"), period badge "In progress", context-panel header, tracker. NOT live-exercised (prod has 0
plans awaiting action → no clickable pending): the interactive composer/action buttons/owner button
— covered by tests + typecheck; noted honestly.

**Deferred still:** Marketing Requests module, then the plan/leave who-approves-whom routing
corrections (the migration-backed change).

**Real production role-based e2e run 2026-07-05** (owner's ask: click-through test done AS PM/GPM/DM/
NSM, not Super Admin). Staging (`izhmxvgiktiafqusolot`) was tried first but its Data API is globally
down — `invalid value for parameter "work_mem": "32mb"` (lowercase unit) injected at the Supavisor
pooler/platform-config layer, invisible to SQL (confirmed: my own SQL session sees `work_mem=32768`
correctly; a raw REST call bypassing the app hits the same error, proving it's not our code). Neither
the SQL Editor (permission denied even for dashboard `postgres` role) nor the Supabase CLI
(`postgres-config get --experimental` → 403; this account's org only owns prod, not staging) could
fix it — needs staging-project-owner dashboard access or Supabase support. **Pivoted to production**
per owner's explicit approval, with a bounded, reversible throwaway-data protocol: synthetic
`E2E-TEST-*` submitters (loudly labeled "DO NOT ACTION (auto-deleted)"), rows inserted directly via
SQL already at `submitted`/`pending_manager` status (confirmed no DB triggers fire notifications —
only app code paths do), real approvers impersonated via `/api/dev-auth?role=X&hrId=Y` (works against
prod data since the gate is `NODE_ENV=development`, not which DB it's pointed at) rather than real
passwords. Real approvers used: PM Ahmed Sharaf (B-155), GPM Rasha Sabry (A-8), DM Mina Farouk
(B-116), NSM Amr Naguib (B-122), CEO Dr Anwar Gaweesh (AA), Super Admin.

**8/8 real click-through actions verified via direct DB queries (ground truth, not just HTTP
response — see bugs below)**: PM approve, GPM reject, DM return-with-per-activity-notes (the premium
composer — confirmed the note landed in `employee_plan_item_return_notes`), NSM approve, CEO
stage-2 approve, Super Admin HR-acknowledge, DM vacation-approve, PM excuse-return. All correct.

**2 real bugs found BY this e2e run and FIXED (same commit-pending worktree):**
1. **Plans HR-acknowledge was unreachable.** The real `ceo_approve` transition
   (`plan-v1.ts EMPLOYEE_PLAN_TRANSITIONS`) goes `manager_approved → final_approved` DIRECTLY —
   `"ceo_approved"` is a legacy CHECK-constraint enum value the live workflow never produces
   (confirmed: 0 production rows ever held it). My own `approvals-hub/service.ts` gated
   `canAcknowledge`/the HR-awaiting-bucket/`planStageLabel`/`hrStatus` on `status==="ceo_approved"`
   — meaning the Acknowledge button would never appear for ANY real plan. Fixed: all 5 sites now
   check `"final_approved"`; `PLAN_ACTIVE_STATUSES` updated; `planStageLabel`/`planReadOnlyReason`
   split `final_approved` (→ "HR acknowledgement", actionable) from `hr_acknowledged` (→ "Completed",
   terminal). Live-verified: Acknowledge button rendered + successfully transitioned
   `final_approved→hr_acknowledged` on the real seeded plan.
2. **`getManagerPendingExcuses`/`decideExcuseRequestAsManager` visibility gap — found, "fixed"
   WRONG, then corrected per owner pushback (see [[project-leave-excuse-approver-model]] governing
   principle #2 for the full, final rule + per-module status).** Initially widened both functions
   to `scope==="system" || role==="Super Admin"` (mirroring vacation's HR-ack pattern) so Super
   Admin could see/decide any pending excuse. **Owner immediately rejected this**: "Super Admin can
   approve anyone no i donot want this... if it is the manager's turn to respond system admin
   cannot respond until his turn comes." Correct resolution: excuse has NO HR-acknowledge stage at
   all (single-step, manager-only) — so unlike vacation/plans, Super Admin gets ZERO special
   excuse authority. **Reverted** to `scope==="system"` only (background/system-actor calls
   exclusively). This same clarification ALSO surfaced a real, more serious PRE-EXISTING violation
   in Plans (`assertManagerReviewer`/`assertCeoReviewer`/`resolveApproverPlanStage` in
   `weekly-planning/service.ts` — not written by me, predates this session) that let Super Admin
   decide ANY plan's manager or CEO stage instantly, bypassing whoever's actual turn it was —
   fixed by removing those bypasses (HR-acknowledge stays untouched, still Super-Admin-only,
   re-verified working). Vacation was independently audited and found ALREADY fully compliant, no
   change needed. Live re-verified end-to-end on real prod data: SA blocked (Forbidden) from
   plan-manager-stage, plan-CEO-stage, and excuse-manager-stage on items not his own; real PM/CEO
   still decide normally; SA's plan HR-Acknowledge still succeeds.

**1 real bug found, NOT fixed (pre-existing, out of scope, spawned as background task
`task_d64dd5e8`):** `decideEmployeePlan`'s reject/return path and `decideExcuseRequestAsManager`
run a post-mutation employee-notify call as a plain unguarded `await` (not `Promise.allSettled` like
the sibling `notifyPlanSubmitted` already correctly does) — if that notify throws (triggered here by
synthetic non-existent submitters; real-world trigger conditions not yet pinned down), the exception
propagates to the API route and reports the whole action as **failed** even though the DB mutation
had already succeeded moments earlier (confirmed via direct DB re-query both times). Risk: a
transient notify failure could make a real manager see "failed" and re-click/doubt a decision that
actually went through.

**Cleanup:** all seeded rows deleted via FK CASCADE (plan headers → items/decisions/return-notes/
hr-acks; vacation → approval-steps/events/tokens/evidence). Post-cleanup counts verified to exactly
match the pre-seed baseline (5 plan headers/43 items/11 vacations/2 excuses, 0 E2E rows remaining).
Full `check:harden` (lint+typecheck+310 tests+build) re-run clean after all fixes.
Staging service-role key was briefly exposed in-session (file-diff echo) — flagged to owner to
rotate; `.env.e2e.local` deleted after use.

**SHIPPED 2026-07-05: PR #814 (base Plans module + Phase 2 + the 3 authority fixes above, squash
`51ac25c7`) and PR #822 (notify-isolation fix, `9d45e868`) both merged to `main` and verified live
in production** (fresh Vercel deploy Ready, all 3 approval pages 200, no errors in prod logs) —
owner explicitly authorized "commit and push and open pr and merge" / "when ci green merge" for
each. This closes out the full Vacation+Excuse+Plan Approvals Hub effort from this session.

**Follow-up same day — portal sidebar section (PR #824, `73b1bf54`, also merged + prod-verified):**
owner asked for a sidebar "Approvals Hub" section — turned out the ADMIN shell already had this
exactly (built earlier), but the PORTAL shell was still bundling the 3 approval links into the
generic "My Workspace" group. Split them into their own "Approvals Hub" portal section (mirroring
admin), kept "Other Approvals" (residual combined inbox) in "My Workspace" same as admin. Added a
rail-mode icon + a unit test asserting the exact section boundary via regex on the source.

**Follow-up same day — hide Excuse Approvals from NSM only (PR #828, `3df66e13`, merged +
prod-verified):** owner: reps under a District Manager never route an excuse to the National Sales
Manager (excuse is direct-manager-only, no manager-of-manager step) and NSM-level excuse
submissions go through Head Office instead — NSM's Excuse Approvals page was always empty, remove
the link for that role only (Vacation + Plan stay). Vacation and Excuse previously shared ONE
portal visibility flag (`showApprovalsTab`) — split into `showVacationApprovalsTab` (unchanged
role list) and `showExcuseApprovalsTab` (same list minus National Sales Manager), mirroring how
Plans already had its own dedicated flag. Live-verified: NSM sees Vacation+Plan but not Excuse;
District Manager (regression check) still sees all three. **Gotcha hit mid-push:** a stale/corrupt
`.next/dev/types/routes.d.ts` (Next.js's own auto-generated dev route-types file, left over from a
prior `next dev` process, NOT source-controlled) made the pre-push typecheck hook fail with
nonsense syntax errors unrelated to any real code change — fix was `rm -rf .next` before retrying,
not a code fix. If a pre-push typecheck fails with garbled errors inside `.next/`, check for this
first before assuming a real regression.

**Running total this session: 4 PRs shipped, merged, and production-verified** — #814 (Approvals
Hub: Vacation+Excuse+Plan pages, My Requests, Phase 2, + the 3 approver-authority fixes), #822
(notify-isolation), #824 (portal sidebar section), #828 (NSM excuse hide). Each followed the same
rhythm: isolated worktree off fresh `origin/main` → implement → `check:harden` → live browser/API
verify against real prod data → commit/push/PR → wait for CI green → squash-merge → verify the
resulting Vercel production deploy (200s + clean logs). Established working pattern for this
session: owner says "commit and push and open pr" (sometimes bundled with "and merge", sometimes
followed by a separate "when ci green merge") — I no longer need to re-ask for merge approval on
each new low-risk nav/UI-only PR in this same session, but DO still verify CI genuinely passed
(not just "completed") and `mergeable` is not CONFLICTING/UNKNOWN before actually merging.

## 2026-09-04 — shipped in both shells

The description was a table of contents — *"status, branch/worktree, structure, deferred
items"* — which names the document instead of saying anything a session could search for.

On `main` today: `app/(admin)/admin/approvals-hub/page.tsx`,
`app/employee-portals/approvals-hub/page.tsx`, `app/api/approvals-hub/pending-count/route.ts`
and `app/api/approvals/badge-counts/route.ts`. The hub is also wired in
`src/config/system-navigation.ts`.

Note there are now **three** related surfaces — `approvals/`, `approvals-hub/` and
`action-center/` — because the later Actions consolidation was built beside this rather than
replacing it. Check which one a change belongs in before editing.
