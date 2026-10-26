import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { clampToWindow } from "../src/lib/probation/intelligence/dv-validation.ts";

function src(p: string) { return readFileSync(p, "utf8"); }

// Manual probation scorecards (owner request 2026-08-20).
//
// The bug: every probation score hangs off a DV-Day, and DV-Days are born ONLY from CRM
// double-visit activity. The CNS National Sales Manager therefore owned exactly 2 DV-Days — both
// for the same rep — so he could score that one person and nobody else, while
// config.requirements.nsm = 1 demands an NSM component on every case in his line. That component
// was unfillable, permanently blocking decision-readiness for everyone else.
//
// The fix lets an evaluator OPEN a DV-Day by hand for a probationer already inside their probation
// read scope. These tests pin the three things that make that safe: the shared scope rule, the
// shared evaluator-role rule, and the fact that a manual day never claims field visits.
export function runProbationManualScorecardTests() {
  // ── Pure logic: the DV date is clamped into the probation window ──────────────────────────────
  // A manual day is dated "today", but a case can still be open past its end date — an unclamped
  // date would land outside the window every window-scoped reader filters on.
  assert.equal(clampToWindow("2026-08-20", "2026-05-16", "2026-08-14"), "2026-08-14", "past the end date clamps back to the end");
  assert.equal(clampToWindow("2026-05-01", "2026-05-16", "2026-08-14"), "2026-05-16", "before the start clamps up to the start");
  assert.equal(clampToWindow("2026-06-30", "2026-05-16", "2026-08-14"), "2026-06-30", "inside the window is unchanged");
  assert.equal(clampToWindow("2026-08-20", null, null), "2026-08-20", "no bounds means no clamping");
  assert.equal(clampToWindow("2026-08-20", null, "2026-08-14"), "2026-08-14", "an open start still clamps at the end");
  assert.equal(clampToWindow("2026-01-01", "2026-05-16", null), "2026-05-16", "an open end still clamps at the start");

  const service = src("src/lib/probation/intelligence/manual-dv-day.ts");

  // ── A manual day must never claim visits that did not happen ─────────────────────────────────
  assert.match(service, /MANUAL_DV_VALIDATION_REASON = "manual_scorecard"/, "manual days carry a stable, greppable reason");
  assert.match(service, /visit_count: 0/, "a manual DV-Day records zero visits");
  assert.match(service, /crm_source_ids: \[\]/, "a manual DV-Day cites no CRM activity");
  assert.match(service, /validation_reason: MANUAL_DV_VALIDATION_REASON/, "a manual DV-Day is stamped as manual, forever distinguishable from a captured field day");
  assert.match(service, /synced_at: null/, "a manual DV-Day is not a sync product");

  // ── ONE scope rule, ONE role rule — no second, softer copy ───────────────────────────────────
  // The scope boundary comes from the probation service (built on the same canReadProbationEmployee
  // the tracker applies per row), and the evaluator role comes from the CRM validation layer (where
  // DM is a relationship, not a title, and PM/GPM is not applicable on CNS).
  assert.match(service, /import \{ filterProbationScorableHrIds[\s\S]*?\} from "@\/lib\/probation\/service"/, "scope comes from the probation service");
  assert.match(service, /import \{[^}]*resolveEvaluatorRole[^}]*\} from "\.\/dv-validation"/, "evaluator role comes from the shared CRM validation rule");
  assert.doesNotMatch(service, /"National Sales Manager"/, "the role mapping is not re-implemented here");
  // Both gates are re-checked on the write path, not just when building the list.
  const openFn = service.slice(service.indexOf("export async function openManualScorecard"));
  assert.match(openFn, /filterProbationScorableHrIds\(access, \[employee\]\)/, "openManualScorecard re-checks scope");
  assert.match(openFn, /if \(!evaluatorRole\)/, "openManualScorecard re-checks the evaluator role");
  assert.match(openFn, /assertCaseAcceptsSubmissions\(probationCase\.id\)/, "a decided case stays locked to further input");
  assert.match(openFn, /employee === callerHrId/, "nobody opens a scorecard on themselves");

  // Idempotency: reuse an open DV-Day rather than stacking another, and survive the unique key.
  assert.match(openFn, /\.in\("dv_status", \[\.\.\.OPEN_DV_STATUSES\]\)/, "an already-open DV-Day is reused");
  assert.match(openFn, /isUniqueViolation\(insertError\)/, "the (evaluator, employee, date) unique key resolves to the existing row");
  assert.match(openFn, /already submitted a score for this probationer today/, "a same-day repeat says so instead of dead-ending on the form");

  // ── A leaver is never offered for scoring ────────────────────────────────────────────────────
  // A case stays open until a decision closes it, so three production cases belong to people who
  // have already resigned or been terminated. Both the list and the write path withhold them.
  assert.match(service, /import \{ isActiveLifecycleStatus \} from "@\/lib\/employees\/employee-directory"/, "lifecycle status comes from the shared directory rule");
  assert.match(service, /if \(!isActiveLifecycleStatus\(facts\?\.employmentStatus\)\) continue;/, "the launcher list skips anyone who has left");
  assert.match(openFn, /isActiveLifecycleStatus\(facts\.get\(employee\)\?\.employmentStatus\)/, "the write path refuses to score a leaver");

  // ── The scope helper the launcher leans on ───────────────────────────────────────────────────
  const probationService = src("src/lib/probation/service.ts");
  assert.match(probationService, /export async function filterProbationScorableHrIds/, "the scoring boundary is exported, not duplicated");
  assert.match(
    probationService,
    /function canScoreProbationEmployee[\s\S]*?canReadProbationEmployee\(access, employee, viewer, directory, viewerAllowedLines\)/,
    "scoring falls back to the SAME per-row rule getProbationRows applies",
  );

  // ── National Sales Manager is national (owner instruction 2026-08-20) ────────────────────────
  // The title is held once per line, so the read rule's same-line default confined each NSM to his
  // own line's probationers while requirements.nsm = 1 demanded an NSM score on EVERY case.
  const scoreFn = probationService.slice(
    probationService.indexOf("function canScoreProbationEmployee"),
    probationService.indexOf("async function filterProbationHrIds"),
  );
  assert.match(scoreFn, /access\.role === "National Sales Manager"/, "an NSM is not confined to his own line");
  // A per-user line_scope_override is how the owner deliberately pins a manager to named lines —
  // it must still win, so setting one is how an NSM gets narrowed back down without a code change.
  assert.match(scoreFn, /!\(viewerAllowedLines && viewerAllowedLines\.length > 0\)/, "an explicit line_scope_override still wins");
  // Scoring is the ONLY thing widened: the tracker and its exports keep the unwidened read rule.
  assert.match(
    probationService,
    /function loadProbationRows[\s\S]*?canReadProbationEmployee\(/,
    "the tracker still filters on the read rule, not the scoring rule",
  );
  assert.doesNotMatch(
    probationService,
    /function loadProbationRows[\s\S]*?canScoreProbationEmployee\(/,
    "the widened rule must not leak into the tracker or its exports",
  );

  // ── Route: coarse probation:read gate + CSRF, identity never taken from the body ─────────────
  const route = src("app/api/probation/scorecards/route.ts");
  assert.match(route, /assertSameOriginMutation\(request\)/, "POST is CSRF-guarded");
  assert.match(route, /assertPermission\(access, "probation", "read"\)/, "coarse gate matches the sibling DV feedback routes");
  assert.match(route, /openManualScorecard\(access, employeeHrId\)/, "the caller's own access context is the evaluator identity");
  assert.doesNotMatch(route, /evaluatorHrId|evaluatorRole.*body/, "the body never supplies who is scoring");
  assert.match(route, /lower\.includes\("conflict"\)\) return \{ status: 409/, "conflicts map to 409");

  // ── Portal wiring: launcher present, and DISJOINT from the CRM-fed inbox ─────────────────────
  const page = src("app/employee-portals/probation/page.tsx");
  assert.match(page, /listScorableProbationers\(access\)/, "page loads the scorable probationers");
  assert.match(page, /<ProbationScorecardLauncher probationers=\{scorableProbationers\}/, "launcher is rendered");
  assert.match(page, /\.filter\(\(p\) => !p\.openDvDayId\)/, "reps already in the feedback inbox are not repeated in the launcher");
  assert.match(page, /catch \{[\s\S]*?scorableProbationers = \[\];[\s\S]*?\}/, "the launcher load is best-effort and never breaks the tracker");
  // The panels must render even when the day-90 tracker window is empty — that window hides people
  // whose case is still open and still owes this evaluator a score.
  assert.match(page, /<ProbationFeedbackTasksPanel tasks=\{feedbackTasks\} \/>\s*\n\s*<ProbationScorecardLauncher/, "both panels render outside the hasTracker branch");
  assert.match(page, /!hasTracker && feedbackTasks\.length === 0 && scorableProbationers\.length === 0 && !showAnalytics/, "the empty state accounts for pending work with no tracker rows");
  // Owner rule: human-readable names and roles, never raw codes.
  assert.match(page, /evaluatorRoleLabel\(p\.evaluatorRole\)/, "the evaluator role is shown as a title, not a slug");
  assert.match(page, /resolveFeedbackTaskNames\(/, "task names that the tracker did not cover are resolved from the directory");

  // ── Launcher UI: matches the sibling inbox's design identity ─────────────────────────────────
  const launcher = src("src/components/employee-portal/probation-scorecard-launcher.tsx");
  assert.match(launcher, /Score a probationer/, "panel titled");
  assert.match(launcher, /return null/, "panel hides when there is nobody to score");
  assert.match(launcher, /rounded-lg border border-slate-200 bg-white/, "same shell as the feedback inbox");
  assert.match(launcher, /method: "POST"/, "opens the scorecard through the API");
  assert.match(launcher, /\/employee-portals\/probation\/feedback\/\$\{encodeURIComponent\(payload\.dvDayId\)\}/, "lands on the existing structured scorecard form");
  // Owner rules: never truncate with an ellipsis, never let a label wrap.
  assert.doesNotMatch(launcher, /truncate|text-ellipsis|…/, "no ellipsis truncation");
  assert.match(launcher, /whitespace-nowrap/, "labels do not wrap");
  assert.match(launcher, /min-w-0/, "the nowrap column still shrinks inside its flex row");
  // The list now spans every line, so it is grouped by line — a bare run of names would not say
  // which team each probationer is on.
  assert.match(launcher, /function groupByLine/, "the cross-line list is grouped by line");
  assert.match(launcher, /lineLabel: string/, "each row carries its line");
  assert.match(page, /lineLabel: p\.lineName \?\? "Unassigned line"/, "a case with no line still reads as words, not a blank");

  // ── A zero-visit day reads as a manual scorecard, not as a field day that found nothing ──────
  const form = src("src/components/probation/structured-feedback-form.tsx");
  assert.match(form, /const isManualScorecard = visitCount === 0/, "the form detects a manual scorecard");
  assert.match(form, /no field visits captured/, "the form says no visits were captured");
  const inbox = src("src/components/employee-portal/probation-feedback-tasks-panel.tsx");
  assert.match(inbox, /t\.visitCount === 0\s*\n?\s*\? `Scorecard opened/, "the inbox labels a manual day as a scorecard, not '0 visits'");
}
