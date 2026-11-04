import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  closingPeriodsOf,
  measureClosingSemesterAchievement,
} from "../src/lib/incentives/closing-semester-achievement.ts";
import { measurePediaAchievement } from "../src/lib/incentives/pedia-achievement.ts";
import { describeIncompleteWindow, resolveIncentiveWindow } from "../src/lib/incentives/semester.ts";
import type { AchievementRow } from "../src/lib/sales/monthly-targets.ts";
import { totalRows } from "../src/lib/sales/vs-target.ts";
import { stripComments } from "./support/comment-strip.ts";

/**
 * A manager's incentive is scored on the PUBLISHED CLOSING, not on the portal's per-person sales view.
 *
 * The incentive tab for the Pedia National Sales Manager printed TOTAL 60.5% and SATO 49.4% while the
 * closing, Sales vs Target, MRs Performance and DSMs Performance all put his line at 55.8% for the same
 * three months. The tab totalled the portal's per-person rows for the line; the closing totals the
 * engine rows, which also hold the direct orders and the vacant seats nobody sits in. The owner's
 * golden rule (AGENTS.md section 4) is that every sales and target figure equals the published closing.
 */

const root = fileURLToPath(new URL("..", import.meta.url));
/** Source with its comments removed, so a comment that explains a call can never satisfy a pin on the call. */
const code = (path: string) => stripComments(readFileSync(`${root}${path}`, "utf8").replace(/\r\n/g, "\n"));

function row(overrides: Partial<AchievementRow>): AchievementRow {
  return {
    achievementUnits: null,
    achievementValue: null,
    actualUnits: 0,
    actualValue: 0,
    areaCode: "A1",
    areaState: null,
    dmHrId: "D1",
    dmSeatId: "DS1",
    hasActual: true,
    hasTarget: true,
    isOther: false,
    lineCode: "pedia",
    period: "2026-07",
    productCode: "CA001",
    regionCode: "R1",
    repHrId: "R-1",
    repSeatId: "S1",
    targetUnits: null,
    targetValue: 0,
    ...overrides,
  };
}

/** One month of a Pedia line: a rep's two products, a direct order nobody owns, and a vacant seat. */
function month(period: string, scale: number): AchievementRow[] {
  return [
    row({ period, productCode: "GU001", actualValue: 500 * scale, targetValue: 800 * scale }),
    row({ period, productCode: "CA001", actualValue: 300 * scale, targetValue: 600 * scale }),
    // A direct order: sales with no occupant and no target. The per-person view cannot see it.
    row({ period, productCode: "CA001", areaCode: "DO", dmHrId: null, dmSeatId: null, repHrId: null, repSeatId: null, actualValue: 200 * scale, hasTarget: false, targetValue: null }),
    // A vacant seat: a target nobody sold against. The per-person view cannot see it either.
    row({ period, productCode: "GU001", areaCode: "A9", repHrId: null, actualValue: 0, hasActual: false, targetValue: 400 * scale }),
  ];
}

const near = (actual: number, expected: number, message: string) =>
  assert.ok(Math.abs(actual - expected) < 1e-9, `${message} (got ${actual}, expected ${expected})`);

export function runNsmIncentiveClosingTests() {
  // ── The measurement is the closing's total, direct orders and vacant seats included ───────────
  const window = ["2026-07", "2026-08"];
  const rows = [...month("2026-07", 1), ...month("2026-08", 2)];
  const measured = measureClosingSemesterAchievement({ rows, windowPeriods: window });

  // July: sales 500+300+200 = 1000, target 800+600+400 = 1800. August is twice that.
  near(measured.totalSales, 3000, "the direct order's sales are in the total");
  near(measured.totalTarget, 5400, "the vacant seat's target is in the total");
  near(measured.totalAchievementPercent, (3000 / 5400) * 100, "total achievement is sales over target of the WHOLE line");
  near(measured.satoSales, 1500, "Sato sales are GU001 and IV001 only");
  near(measured.satoTarget, 3600, "the vacant seat's Sato target is in the Sato half");
  near(measured.satoAchievementPercent, (1500 / 3600) * 100, "Sato achievement is over the whole line's Sato target");

  // It is the engine's own figure, not a re-division that could drift from it.
  const engine = totalRows(rows);
  near(measured.totalAchievementPercent, (engine.achievementValue ?? 0) * 100, "equals what the closing's totalRows prints");

  // ── The old per-person reading is a different, wrong number for the same line ─────────────────
  const perPerson = measurePediaAchievement({
    rows: rows
      .filter((r) => r.repHrId)
      .map((r) => ({
        hrId: r.repHrId,
        period: r.period,
        productCode: r.productCode,
        salesValue: r.actualValue,
        targetValue: r.targetValue ?? 0,
        territory: r.areaCode,
      })),
    windowPeriods: window,
  });
  assert.notEqual(
    Math.round(perPerson.totalAchievementPercent * 10),
    Math.round(measured.totalAchievementPercent * 10),
    "the fixture really does separate the per-person view from the closing, or the test proves nothing",
  );
  assert.ok(perPerson.satoAchievementPercent > measured.satoAchievementPercent, "dropping the vacant seat's Sato target flatters Sato");

  // ── The window is the semester's months only ──────────────────────────────────────────────────
  const withOutsider = [...rows, ...month("2026-09", 50)];
  near(
    measureClosingSemesterAchievement({ rows: withOutsider, windowPeriods: window }).totalSales,
    3000,
    "a month outside the window does not count",
  );

  // ── Which months the window is built from ─────────────────────────────────────────────────────
  assert.deepEqual(
    closingPeriodsOf([...rows, row({ period: "2026-10", actualValue: 0, hasActual: false, targetValue: 99 })]),
    ["2026-07", "2026-08"],
    "a month that exists only because a target was loaded is not a month the closing has sales for",
  );

  // ── The wiring: a manager's tab reads the closing, a rep's does not ───────────────────────────
  const service = code("src/lib/employee-portal/service.ts");
  assert.match(service, /loadPublishedClosingRowsForViewer\(access\)/, "the tab loads the viewer's published closing rows");
  assert.match(
    service,
    /closingIncentive\.boundKind === "line" \|\| closingIncentive\.boundKind === "areas"/,
    "only a line or area bound (NSM, DM, RM) takes the closing; a rep's own bound and a closed bound keep the portal view",
  );
  assert.match(service, /periods: closingRows \? closingPeriodsOf\(closingRows\)/, "the window is the closing's months for a manager");
  assert.match(service, /const semesterSales = closingSemester \? closingSemester\.totalSales/, "semester sales come from the closing");
  assert.match(service, /const semesterTarget = closingSemester \? closingSemester\.totalTarget/, "semester target comes from the closing");
  assert.match(service, /\? closingSemester\.totalAchievementPercent/, "the achievement the payout curve scores is the closing's");
  assert.match(service, /\(closingSemester \?\?\s*measurePediaAchievement\(/, "the Sato half is the closing's too");

  // A manager with no readable closing never falls back to the per-person figure this change calls wrong.
  assert.match(
    service,
    /\(closingIncentive === null \|\| closingIncentive\.boundKind === "none"\)/,
    "a failed load or a closed bound is UNAVAILABLE for a manager, not a reason to show the old number",
  );
  assert.match(service, /: closingUnavailable\s+\? measureClosingSemesterAchievement\(\{ rows: \[\], windowPeriods: \[\] \}\)/, "unavailable scores nothing");
  assert.match(service, /incentiveWindowNotice: closingUnavailable/, "and says so");
  const nothing = measureClosingSemesterAchievement({ rows: [], windowPeriods: [] });
  assert.equal(nothing.totalTarget, 0, "no closing → no target, which the tab renders as No target yet");
  assert.equal(nothing.satoTarget, 0, "and no Sato target");

  const loader = code("src/lib/employee-portal/sos-team-performance.ts");
  assert.match(
    loader,
    /selectRows\(scoped, activePeriodsOf\(scoped, publishedKeys\), null, publishedKeys\)/,
    "the rows are PUBLISHED months only, the same cut every closing page makes",
  );

  // ── The copy ──────────────────────────────────────────────────────────────────────────────────
  const dashboard = code("src/components/employee-portal/employee-portal-dashboard.tsx");
  assert.equal(/% to threshold/.test(dashboard), false, "a gap in percentage POINTS is never printed as a percent");
  assert.equal((dashboard.match(/points to 90%/g) ?? []).length, 2, "both cards say points to 90%");

  const midSemester = resolveIncentiveWindow({
    periods: ["2026-07", "2026-08", "2026-09"],
    todayPeriod: "2026-10",
  });
  assert.equal(
    describeIncompleteWindow(midSemester),
    "Provisional — Semester 2 2026 has 3 months still to come.",
    "the notice reads as a sentence: has, not is",
  );
  const gap = resolveIncentiveWindow({ periods: ["2026-08", "2026-09"], todayPeriod: "2026-10" });
  assert.equal(
    describeIncompleteWindow(gap),
    "Provisional — July has no published sales yet, and Semester 2 2026 has 3 months still to come.",
    "a missing month and months to come read as two clauses, not 'is July has'",
  );
}
