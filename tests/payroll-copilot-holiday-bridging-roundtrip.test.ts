import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { POST as holidayBridgingPost } from "../app/api/payroll/copilot/[runId]/deductions/holiday-bridging/route.ts";
import {
  HOLIDAY_BRIDGING_DECISION_FIELDS_REQUIRED,
  holidayBridgingDecisionBody,
  toHolidayBridgingScreenRow,
  type HolidayBridgingScreenRow,
} from "../src/lib/payroll/copilot/holiday-bridging-row.ts";
import { DEV_AUTH_ENV, devAuthRequest, withPostgrestStandIn, writesTo, writtenRow, type Row } from "./support/postgrest-stand-in.ts";

// THE PAYROLL COPILOT'S HOLIDAY BRIDGING TAB: EXCLUDE AND INCLUDE REACH THE DATABASE (19 Nov 2026; money-integrity
// close-out §5 item 5, owner: "fix the Payroll Copilot Holiday Bridging tab's Exclude and Include").
//
// The tab posts back `{ requestId, employeeHrId, bridgingDate, action }` from the row the route's GET sent it, but the
// GET built each row by hand and left `requestId` out — so every Exclude and every Include answered 400 and no
// exclusion was ever recorded from the screen. The row and the body now come from one module
// (src/lib/payroll/copilot/holiday-bridging-row.ts). This file runs the round trip:
//
//   1. a domain candidate becomes a screen row carrying every field its decision posts, and the body built from that
//      row names the row's request, person and day, with the action that flips its state;
//   2. that body, POSTed to the REAL route as a Super Admin against the shared in-memory database
//      (tests/support/postgrest-stand-in.ts), records the exclusion against the right request — and an Include lifts
//      it again; a row with no request id (the old shape) is refused with the route's own words and writes nothing;
//   3. the GET builds its rows through that builder and the tab posts through that body builder. Read from the
//      source, because the GET refuses to compute anything without the live Google holiday calendar, which no test
//      may reach, and the tab is a browser component.

const RUN_ID = "5a1e0000-0000-4000-8000-000000000001";
const REQUEST_ID = "5a1e0000-0000-4000-8000-0000000000aa";
const SUPER_ADMIN = { hrId: "B-10", role: "Super Admin" };

/** A candidate exactly as listHolidayBridgingCandidates builds it: annual leave on the day before Armed Forces Day. */
const CANDIDATE = {
  adjacentTo: "before" as const,
  bridgingDate: "2026-10-05",
  employeeHrId: "MR-41",
  employeeName: "Stand-in Rep",
  excluded: false,
  existingExclusion: null,
  holidayEndDate: "2026-10-06",
  holidayName: "Armed Forces Day",
  holidayStartDate: "2026-10-06",
  id: `${REQUEST_ID}:2026-10-05`,
  requestId: REQUEST_ID,
  salaryDeductionAmount: 500,
  vacationType: "annual",
};

const ROUTE_PATH = `/api/payroll/copilot/${RUN_ID}/deductions/holiday-bridging`;
const post = (body: unknown) =>
  holidayBridgingPost(devAuthRequest("POST", ROUTE_PATH, SUPER_ADMIN, body), { params: Promise.resolve({ runId: RUN_ID }) });

export async function runPayrollCopilotHolidayBridgingRoundtripTests(): Promise<void> {
  // ── 1. The row carries what its decision posts ─────────────────────────────────────────────────
  const row: HolidayBridgingScreenRow = toHolidayBridgingScreenRow(CANDIDATE, "2024-01-15");
  assert.equal(row.requestId, REQUEST_ID, "HEADLINE: the screen row carries the request id its Exclude and Include post back");
  for (const [field, value] of Object.entries(row)) {
    assert.notEqual(value, undefined, `the screen row sets ${field}`);
  }
  assert.equal(row.hireDate, "2024-01-15", "and the hire date the route looked up");
  assert.ok(!("existingExclusion" in row), "the domain's own exclusion detail stays on the server");
  assert.deepEqual(
    holidayBridgingDecisionBody(row),
    { action: "exclude", bridgingDate: "2026-10-05", employeeHrId: "MR-41", requestId: REQUEST_ID },
    "a mandatory row's button posts Exclude, naming the row's request, person and day",
  );
  assert.equal(holidayBridgingDecisionBody({ ...row, excluded: true }).action, "include", "an excluded row's button posts Include");

  // ── 2. Through the real route: the exclusion is recorded, then lifted ───────────────────────────
  const tables: Record<string, Row[]> = { payroll_copilot_vacation_settlements: [] };
  await withPostgrestStandIn(
    { tables },
    async (seen) => {
      const excluded = await post(holidayBridgingDecisionBody(row));
      const excludedBody = (await excluded.json()) as Record<string, unknown>;
      assert.equal(excluded.status, 200, `HEADLINE: Exclude from the screen's own row is accepted (got ${excluded.status} ${JSON.stringify(excludedBody)})`);
      const inserts = writesTo(seen, "payroll_copilot_vacation_settlements").filter((entry) => entry.method === "POST");
      assert.equal(inserts.length, 1, "one exclusion row is written");
      const written = writtenRow(inserts[0]);
      assert.deepEqual(
        [written.settlement_method, written.start_date, written.vacation_request_ids, written.employee_hr_id, written.run_id],
        ["holiday_bridge_excluded", "2026-10-05", [REQUEST_ID], "MR-41", RUN_ID],
        "HEADLINE: the exclusion is recorded against the row's own request, person and day",
      );
      assert.equal(tables.payroll_copilot_vacation_settlements.length, 1, "and it is stored");

      const included = await post(holidayBridgingDecisionBody({ ...row, excluded: true }));
      assert.equal(included.status, 200, "Include again is accepted");
      const lifted = tables.payroll_copilot_vacation_settlements[0];
      assert.ok(lifted.superseded_at, "HEADLINE: Include lifts the exclusion — the day counts again");
    },
    { env: DEV_AUTH_ENV },
  );

  // The old shape — a row with no request id — is refused with the route's own words and writes nothing.
  await withPostgrestStandIn(
    { tables: { payroll_copilot_vacation_settlements: [] } },
    async (seen) => {
      // What the screen used to send: the row's request id was undefined, so JSON dropped the field.
      const refused = await post({ action: "exclude", bridgingDate: row.bridgingDate, employeeHrId: row.employeeHrId });
      const refusedBody = (await refused.json()) as Record<string, unknown>;
      assert.equal(refused.status, 400, "a decision with no request id is refused");
      assert.equal(refusedBody.message, HOLIDAY_BRIDGING_DECISION_FIELDS_REQUIRED, "in the route's own words");
      assert.deepEqual(writesTo(seen, "payroll_copilot_vacation_settlements"), [], "and nothing is written");
    },
    { env: DEV_AUTH_ENV },
  );

  // ── 3. The GET and the tab go through the shared builders ───────────────────────────────────────
  const route = readFileSync("app/api/payroll/copilot/[runId]/deductions/holiday-bridging/route.ts", "utf8");
  const getBody = route.slice(route.indexOf("export async function GET("), route.indexOf("export async function POST("));
  assert.ok(getBody.includes("candidates.map((c) => toHolidayBridgingScreenRow("), "HEADLINE: the GET builds every row through toHolidayBridgingScreenRow");
  assert.ok(!/candidates\.map\(\(c\) => \(\{/.test(getBody), "and never by hand again");
  const tab = readFileSync("src/components/payroll/copilot/tabs/holiday-bridging-tab.tsx", "utf8");
  assert.ok(tab.includes("holidayBridgingDecisionBody(row)"), "the tab posts the body built from its row");
  assert.ok(tab.includes("type HolidayBridgingScreenRow as HolidayBridgingCandidate"), "and reads rows of the shared type");
}
