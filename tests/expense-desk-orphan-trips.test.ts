/**
 * Expense Approvals — A PAID TRIP WHOSE REQUEST WAS DELETED IS STILL ON A SCREEN, pinned.
 *
 * Owner, 2026-11-23, about 22:50 Cairo: "Expense page is not showing all the expenses. I am confident
 * of this. Where are the rest of the requests of the people?" Read on production that night: every one
 * of the 364 requests was on the page (66 waiting, 298 in History) and the 327 sheet trips sat behind
 * History's sheet press. But 9 approved trips (April to June 2026, three people, 4,332.35 EGP) stood in
 * payroll as `OUTSTATION-<id>` with their request deleted: the desk could not show them (no request)
 * and the sheet list dropped every `OUTSTATION-` row, so they were on no screen at all.
 *
 *   1. The sheet list keeps every payroll row that did not come from a request.
 *   2. It keeps a request's row when that request no longer exists, marked `requestDeleted`.
 *   3. It leaves out a row whose request still exists: the desk shows that one, never twice.
 *   4. The loader asks which request ids exist, and a failed read throws rather than guessing.
 *   5. The screen says the trip was filed in Phoenix and its request deleted.
 */
import assert from "node:assert/strict";
import fs from "node:fs";

import { sheetHistoryRows } from "@/lib/outstation/approvals/history";

export async function runExpenseDeskOrphanTripsTests() {
  const rows = [
    { name: "sheet trip", tripId: "SHEET-2026-03-14-7" },
    { name: "request still there", tripId: "OUTSTATION-293" },
    { name: "request deleted", tripId: "OUTSTATION-31" },
    { name: "another sheet trip", tripId: "IMPORT-55" },
  ];
  const kept = sheetHistoryRows(rows, new Set([293]));

  // 1 + 3. Sheet trips stay; a live request's row is left to the desk.
  assert.deepEqual(
    kept.map((entry) => entry.row.name),
    ["sheet trip", "request deleted", "another sheet trip"],
    "HEADLINE: the list keeps the sheet trips and the deleted request's trip, never a live request's",
  );
  // 2. The deleted request's trip is marked so.
  assert.deepEqual(
    kept.map((entry) => entry.requestDeleted),
    [false, true, false],
    "HEADLINE: only the trip whose request is gone reads as deleted",
  );
  // Nothing exists: every request row is an orphan. Everything exists: none is.
  assert.equal(sheetHistoryRows(rows, new Set()).length, 4);
  assert.equal(sheetHistoryRows(rows, new Set([293, 31])).length, 2);

  // 4. The loader feeds it the ids that exist, and a failed read throws.
  const history = fs.readFileSync("src/lib/outstation/approvals/history.ts", "utf8");
  const loader = history.slice(history.indexOf("async function readExistingRequestIds"), history.indexOf("export async function loadSheetHistory"));
  assert.ok(loader.includes('.from("outstation_expense_requests").select("id")'), "it reads request ids only");
  assert.ok(loader.includes("if (error) throw error;"), "HEADLINE: a failed read throws; a hidden request never reads as deleted");
  assert.ok(history.includes("const existing = await readExistingRequestIds(requestIds);"));
  assert.ok(history.includes("return sheetHistoryRows(rows, existing)"), "the loader goes through the one rule");

  // 5. The screen says so.
  const screen = fs.readFileSync("src/components/outstation/approvals-desk/desk-history.tsx", "utf8");
  assert.ok(screen.includes("trip.requestDeleted ? `${decision} · filed in Phoenix, request deleted` : decision"), "HEADLINE: the row says the request was deleted");
}
