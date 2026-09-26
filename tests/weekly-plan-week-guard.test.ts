import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  buildEmployeePlanPeriod,
  isPastPlanWeek,
  shiftIsoDate,
  FIELD_WORKWEEK,
  HEAD_OFFICE_WORKWEEK,
} from "../src/lib/weekly-planning/plan-v1.ts";

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
}
