import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Source-text regression guard (matching this repo's own idiom for pinning fixes to
// DB-querying functions the Node unit-test harness can't easily exercise end-to-end):
// getProbationDashboard and buildConsolidatedReport each independently derived "today" from
// `nowIso.slice(0, 10)` (as did probation-emails, deleted 2026-08-02)
// — a naive UTC-calendar-day slice, wrong for the ~1-3h/night Cairo is already on the next
// calendar day but the UTC instant hasn't rolled over yet. Each also called
// probationDaysRemaining(hireDate) with NO reference argument, silently defaulting to the live
// clock instead of the same `nowIso` the surrounding function was given — so a single
// dashboard row's `currentDay` (correctly threaded) and `daysRemaining` (silently not) could
// visibly disagree with each other near that boundary. Both the "today" derivation and the
// missing argument must be fixed together, in all three files, or this guard fails.

function src(path: string): string {
  return readFileSync(path, "utf8");
}

const NAIVE_UTC_SLICE = /nowIso\.slice\(0,\s*10\)/;
const CAIRO_TODAY_FROM_NOW_ISO = /currentCairoDateOnlyIso\(new Date\(nowIso\)\)/;

export function runProbationCairoTodayConsistencyTests() {
  const dashboard = src("src/lib/probation/intelligence/dashboard.ts");
  assert.doesNotMatch(dashboard, NAIVE_UTC_SLICE, "dashboard.ts must not derive today via a naive UTC slice of nowIso");
  assert.match(dashboard, CAIRO_TODAY_FROM_NOW_ISO, "dashboard.ts must derive today via the Cairo-aware helper");
  assert.match(
    dashboard,
    /probationDaysRemaining\(c\.hire_date,\s*new Date\(nowIso\)\)/,
    "getProbationDashboard must pass the same nowIso-derived reference to probationDaysRemaining as currentProbationDay receives",
  );

  const consolidatedReport = src("src/lib/probation/intelligence/consolidated-report.ts");
  assert.doesNotMatch(consolidatedReport, NAIVE_UTC_SLICE, "consolidated-report.ts must not derive today via a naive UTC slice of nowIso");
  assert.match(consolidatedReport, CAIRO_TODAY_FROM_NOW_ISO, "consolidated-report.ts must derive today via the Cairo-aware helper");
  assert.match(
    consolidatedReport,
    /probationDaysRemaining\(probationCase\.hireDate,\s*new Date\(nowIso\)\)/,
    "buildConsolidatedReport must pass the same nowIso-derived reference to probationDaysRemaining as currentProbationDay receives",
  );

  // probation-emails.ts was deleted 2026-08-02 (all three exports uncalled), so its two
  // Cairo-today call sites and the buildCaseContext threading guard are gone with it. The
  // dashboard.ts, consolidated-report.ts and service.ts guards below are unaffected.

  // probation/service.ts used to independently reinvent this exact math (its own local
  // daysRemaining()/probationEndDate()/probationDays=90) instead of importing the canonical
  // probation/date.ts helpers its own header comment says everything must use — two
  // implementations of the same rule that could silently drift, and both anchored the "today"
  // side of the calculation to the server's local/UTC midnight instead of Cairo's. Consolidated
  // onto the canonical (now Cairo-aware) helpers; the duplicates must not come back.
  const service = src("src/lib/probation/service.ts");
  assert.match(
    service,
    /import \{\s*probationDaysRemaining,\s*probationEndDate as canonicalProbationEndDate,\s*\} from "@\/lib\/probation\/date";/,
    "probation/service.ts must import the canonical probationEndDate/probationDaysRemaining from probation/date.ts",
  );
  assert.doesNotMatch(service, /function daysRemaining\(/, "the duplicate local daysRemaining() must not come back");
  assert.doesNotMatch(service, /function baseProbationEndDate\(/, "the duplicate local baseProbationEndDate() must not come back");
  assert.doesNotMatch(service, /function currentProbationEndDate\(/, "the duplicate local currentProbationEndDate() must not come back");
  assert.doesNotMatch(service, /const probationDays = 90;/, "the duplicate local probationDays constant must not come back");
  assert.doesNotMatch(service, /today\.setHours\(0, 0, 0, 0\)/, "service.ts must not reintroduce server-local-midnight day math");
  assert.match(
    service,
    /function todayDateOnly\(\) \{\s*return currentCairoDateOnlyIso\(\);\s*\}/,
    "todayDateOnly() must delegate to the canonical Cairo-aware currentCairoDateOnlyIso helper",
  );
}
