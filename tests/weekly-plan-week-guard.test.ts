import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { pickedPeriodIsShown } from "../src/lib/weekly-planning/plan-editor-state.ts";
import {
  buildEmployeePlanPeriod,
  isPastPlanWeek,
  shiftIsoDate,
  FIELD_WORKWEEK,
  HEAD_OFFICE_WORKWEEK,
} from "../src/lib/weekly-planning/plan-v1.ts";
import { stripComments } from "./support/comment-strip.ts";

// THE WRONG-WEEK GUARD (owner, 2026-09-26): "make the week not auto selected — make a droplist
// unselected and he manual select, and mark submitted weeks green in the droplist, and if [he]
// chose a week that['s] before [now] ask him and flag but no block."
//
// This test pins the one piece of that guard that has no UI: isPastPlanWeek, the "off-window"
// decision, plus the two source wirings that must not silently regress —
//   1. createEmployeePlan sets off_window_flagged from isPastPlanWeek, WEEKLY only, and
//   2. the migration adds the column.
// The dropdown-unselected, green-mark and confirm behaviours are exercised in the browser; the
// rule itself is arithmetic and is pinned here so a "<" that drifts to "<=" (which would flag the
// current week) or a wrong anchor is caught in CI.

const SERVICE_SOURCE = readFileSync(
  fileURLToPath(new URL("../src/lib/weekly-planning/service.ts", import.meta.url)),
  "utf8",
);

const MIGRATION_SOURCE = readFileSync(
  fileURLToPath(
    new URL("../supabase/migrations/20260926120000_employee_plan_headers_off_window_flag.sql", import.meta.url),
  ),
  "utf8",
);

function assertWorkweek(label: string, workweek: typeof FIELD_WORKWEEK, midWeekToday: string) {
  const current = buildEmployeePlanPeriod("weekly", midWeekToday, workweek);
  const currentStart = current.periodStartDate;
  const previousStart = shiftIsoDate(currentStart, -7);
  const nextStart = shiftIsoDate(currentStart, 7);
  const twoBackStart = shiftIsoDate(currentStart, -14);

  // The current week is NEVER off-window, even asked mid-week.
  assert.equal(
    isPastPlanWeek({ periodStartDate: currentStart, todayIso: midWeekToday, workweek }),
    false,
    `${label}: the current week is on-window`,
  );

  // …and still on-window when the plan is filed on the week's LAST working day. This is the check
  // that would fail if the comparison were "<=" instead of "<".
  assert.equal(
    isPastPlanWeek({ periodStartDate: currentStart, todayIso: current.periodEndDate, workweek }),
    false,
    `${label}: the current week is on-window even on its last working day`,
  );

  // A fully-elapsed earlier week IS off-window.
  assert.equal(
    isPastPlanWeek({ periodStartDate: previousStart, todayIso: midWeekToday, workweek }),
    true,
    `${label}: last week is off-window`,
  );
  assert.equal(
    isPastPlanWeek({ periodStartDate: twoBackStart, todayIso: midWeekToday, workweek }),
    true,
    `${label}: a week two back is off-window`,
  );

  // A future week (the on-time case — plans are filed BEFORE the week) is never off-window.
  assert.equal(
    isPastPlanWeek({ periodStartDate: nextStart, todayIso: midWeekToday, workweek }),
    false,
    `${label}: next week is never off-window`,
  );
}

export function runWeeklyPlanWeekGuardTests() {
  // ── The arithmetic, on BOTH role-aware workweeks ───────────────────────────
  // Field Force anchors on Saturday, Head Office on Sunday; the guard must use the plan's own
  // workweek to decide "the current week", never a fixed calendar week.
  assertWorkweek("Field Force (Sat-anchored)", FIELD_WORKWEEK, "2026-09-23"); // a Wednesday
  assertWorkweek("Head Office (Sun-anchored)", HEAD_OFFICE_WORKWEEK, "2026-09-23");

  // The two workweeks can disagree about which week a date sits in — the guard must not hard-code
  // one anchor. On 2026-09-19 (a Saturday) the Field week has just begun while Head Office is still
  // in the week that started 2026-09-13.
  const fieldStart = buildEmployeePlanPeriod("weekly", "2026-09-19", FIELD_WORKWEEK).periodStartDate;
  const headStart = buildEmployeePlanPeriod("weekly", "2026-09-19", HEAD_OFFICE_WORKWEEK).periodStartDate;
  assert.notEqual(fieldStart, headStart, "Field and Head Office anchor a Saturday to different weeks");

  // ── Source wiring 1: createEmployeePlan sets the flag, weekly only ─────────
  assert.ok(
    /off_window_flagged:\s*offWindowFlagged/.test(SERVICE_SOURCE),
    "createEmployeePlan must write off_window_flagged into the header insert",
  );
  assert.ok(
    /const offWindowFlagged\s*=\s*[\s\S]*?input\.planKind === "weekly"[\s\S]*?isPastPlanWeek\(/.test(SERVICE_SOURCE),
    "the flag must be computed from isPastPlanWeek, guarded to weekly plans only",
  );

  // ── Source wiring 2: the migration adds the column ─────────────────────────
  assert.ok(
    /add column if not exists off_window_flagged boolean not null default false/i.test(MIGRATION_SOURCE),
    "the migration must add employee_plan_headers.off_window_flagged, defaulting false",
  );

  runPeriodPickTests();
}

// ── Picking the week that is already on screen ───────────────────────────────
// The picker called resetRows unconditionally, so choosing the week already shown (the usual way to
// "confirm" a fresh weekly plan's default week) replaced every row with the bare defaults. The
// approved-leave and holiday rows are re-added only by the prefill effect, which does not re-run
// because nothing it depends on changed - while the "Auto-synced into this plan" banner kept
// claiming they were there. The same hole sat behind Reset working days and Discard draft.
function runPeriodPickTests() {
  const fieldWeek = buildEmployeePlanPeriod("weekly", "2026-10-21", FIELD_WORKWEEK);
  assert.equal(fieldWeek.periodStartDate, "2026-10-17", "sanity: the Field Force week shown starts Saturday 17 Oct");
  for (const picked of ["2026-10-17", "2026-10-19", "2026-10-22"]) {
    assert.equal(
      pickedPeriodIsShown({ kind: "weekly", pickedAnchorDate: picked, shownPeriodStartDate: fieldWeek.periodStartDate, workweek: FIELD_WORKWEEK }),
      true,
      `${picked} is inside the week already shown`,
    );
  }
  for (const picked of ["2026-10-10", "2026-10-24", "2026-10-31"]) {
    assert.equal(
      pickedPeriodIsShown({ kind: "weekly", pickedAnchorDate: picked, shownPeriodStartDate: fieldWeek.periodStartDate, workweek: FIELD_WORKWEEK }),
      false,
      `${picked} is another week`,
    );
  }
  // The same date can be a different week for a different workweek (Head Office starts Sunday).
  assert.equal(
    pickedPeriodIsShown({ kind: "weekly", pickedAnchorDate: "2026-10-17", shownPeriodStartDate: "2026-10-18", workweek: HEAD_OFFICE_WORKWEEK }),
    false,
    "Saturday 17 Oct belongs to the Head Office week that began Sunday 11 Oct, not the one starting 18 Oct",
  );
  assert.equal(
    pickedPeriodIsShown({ kind: "monthly", pickedAnchorDate: "2026-10-17", shownPeriodStartDate: "2026-10-01", workweek: FIELD_WORKWEEK }),
    true,
    "any day of the month shown is that month",
  );
  assert.equal(
    pickedPeriodIsShown({ kind: "monthly", pickedAnchorDate: "2026-11-01", shownPeriodStartDate: "2026-10-01", workweek: FIELD_WORKWEEK }),
    false,
    "the first of the next month is another month",
  );

  // The component wiring, sliced to the functions so a match elsewhere cannot satisfy it.
  const workspace = stripComments(readFileSync("src/components/employee-portal/plans-workspace.tsx", "utf8"));
  const pickStart = workspace.indexOf("function onAnchorChange(");
  assert.ok(pickStart >= 0, "onAnchorChange must exist - this test slices it by marker");
  const pick = workspace.slice(pickStart, workspace.indexOf("\n  }\n", pickStart));
  const sameWeekAt = pick.indexOf("pickedPeriodIsShown(");
  const resetAt = pick.indexOf("resetRows(activeKind, nextAnchorDate)");
  assert.ok(sameWeekAt >= 0 && resetAt > sameWeekAt, "onAnchorChange must test for the week already shown BEFORE it resets the rows");
  assert.match(
    pick.slice(sameWeekAt, resetAt),
    /setWeekChosen\(true\);\s*return;/,
    "picking the week already shown only confirms the choice and returns without touching the rows",
  );
  assert.ok(
    pick.indexOf("window.confirm(") >= 0 && pick.indexOf("window.confirm(") < sameWeekAt,
    "the past-week confirmation still comes first",
  );

  const resetStart = workspace.indexOf("function resetRows(");
  assert.ok(resetStart >= 0, "resetRows must exist - this test slices it by marker");
  const reset = workspace.slice(resetStart, workspace.indexOf("\n  }\n", resetStart));
  assert.match(
    reset,
    /prefillState\.scopeKey === freshScopeKey \? mergePrefillIntoRows\(fresh, prefillState\.items\) : fresh/,
    "a reset onto the period already on screen re-adds the approved-leave and holiday rows the prefill already fetched",
  );
}
