import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

import { countTeamPlanCompliance, type RepWeekPlanRow } from "../src/lib/employee-360/team-plan-compliance.ts";

// Employee 360's "Plans submitted" / "Plans approved" tiles: a Medical Rep's week is a Phoenix CRM
// plan, counted once per week by its plan of record (owner, 2026-10-19).
export function runEmployee360TeamPlanComplianceTests() {
  const repKeyBySeat = new Map([
    ["REP-1", "a-1"],
    ["REP-2", "a-2"],
    ["REP-3", "a-3"],
  ]);
  const team = new Set(["a-1", "a-2", "a-3"]);
  const repKeyOf = (hrId: string | null | undefined) => {
    const key = String(hrId ?? "").trim().toLowerCase();
    return key && team.has(key) ? key : null;
  };
  const week = (overrides: Partial<RepWeekPlanRow>): RepWeekPlanRow => ({
    seatId: "REP-1",
    weekStart: "2026-10-10",
    status: "submitted",
    submittedAt: "2026-10-08T10:00:00Z",
    submittedByHrId: "A-1",
    ...overrides,
  });

  assert.deepEqual(countTeamPlanCompliance({ rows: [], repKeyBySeat, repKeyOf }), { submitted: 0, approved: 0 });

  // Once per week: the same week read twice is one plan, and a rep is one rep however many weeks.
  assert.deepEqual(
    countTeamPlanCompliance({
      rows: [week({}), week({}), week({ weekStart: "2026-10-17", status: "approved" })],
      repKeyBySeat,
      repKeyOf,
    }),
    { submitted: 1, approved: 1 },
    "one rep with two weeks is one rep submitted and one rep approved",
  );

  // A returned week was sent and is being reworked: still submitted, not approved. A draft is nothing.
  assert.deepEqual(
    countTeamPlanCompliance({
      rows: [
        week({ seatId: "REP-1", status: "returned", submittedByHrId: "A-1" }),
        week({ seatId: "REP-2", status: "draft", submittedAt: null, submittedByHrId: null }),
        week({ seatId: "REP-3", status: "approved", submittedByHrId: "A-3" }),
      ],
      repKeyBySeat,
      repKeyOf,
    }),
    { submitted: 2, approved: 1 },
    "a returned week counts as submitted, a draft never does",
  );
  assert.equal(
    countTeamPlanCompliance({ rows: [week({ status: "draft" })], repKeyBySeat, repKeyOf }).submitted,
    0,
    "a draft is not a submission even if it was once sent",
  );

  // Attribution: whoever sent it if they are on the team, else the rep holding the seat now.
  assert.deepEqual(
    countTeamPlanCompliance({ rows: [week({ seatId: "REP-2", submittedByHrId: "Z-99" })], repKeyBySeat, repKeyOf }),
    { submitted: 1, approved: 0 },
    "a week sent by someone outside the team still counts for the rep holding the territory",
  );
  assert.deepEqual(
    countTeamPlanCompliance({ rows: [week({ seatId: "UNKNOWN", submittedByHrId: "Z-99" })], repKeyBySeat, repKeyOf }),
    { submitted: 0, approved: 0 },
    "a week that belongs to nobody on the team counts for nobody",
  );

  // The loader reads the reps' Phoenix CRM weeks, never the legacy Plans tab a Medical Rep cannot file.
  const loader = readFileSync("src/lib/employee-360/team-lifecycle.ts", "utf8");
  assert.match(loader, /\.from\("phoenix_crm_plans"\)/, "the tiles read the reps' Phoenix CRM weeks");
  assert.match(loader, /\.eq\("is_test", false\)/, "and only the real world");
  assert.doesNotMatch(loader, /\.from\("employee_plan_headers"\)/, "the legacy Plans tab holds no Medical Rep plan, so it read 0 for every field team");
  assert.match(loader, /countTeamPlanCompliance\(\{/, "the counting goes through the one pure rule");
}
