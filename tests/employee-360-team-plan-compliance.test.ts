import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

import { selectTeamLifecycleMembers } from "../src/lib/employee-360/team-lifecycle.ts";
import { countTeamPlanCompliance, type RepWeekPlanRow } from "../src/lib/employee-360/team-plan-compliance.ts";
import type { EmployeeDirectoryRow } from "../src/lib/employees/employee-directory.ts";
import { stripComments } from "./support/comment-strip.ts";

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

  // ── The team is the reps AND the district and regional managers beneath the subject ──
  // Owner, 2026-10-20: "every single role that is applicable to appear in a module — find it and
  // show it." A Regional or National Sales Manager's Team Compliance kept Medical Reps only, so the
  // district managers under him — their probation, weekly plans and no-activity flags — were absent.
  const person = (hrId: string, jobTitle: string) =>
    ({ hrId, jobTitle, positionTitle: jobTitle, displayName: hrId, fullName: hrId, employmentStatus: "active" }) as EmployeeDirectoryRow;
  const nsm = person("N-1", "National Sales Manager");
  const rsm = person("R-1", "Regional Manager");
  const dsm = person("D-1", "District Manager");
  const rep = person("M-1", "Medical Representative");
  const pm = person("P-1", "Product Manager");
  const outsider = person("D-9", "District Manager");
  const members = selectTeamLifecycleMembers({
    subjectHrId: "N-1",
    teamHrIds: ["N-1", "R-1", "D-1", "M-1", "P-1"],
    employees: [nsm, rsm, dsm, rep, pm, outsider, rep],
  });
  assert.deepEqual(members.reps.map((e) => e.hrId), ["M-1"], "the Medical Reps beneath him, each once");
  assert.deepEqual(
    members.managers.map((e) => e.hrId),
    ["R-1", "D-1"],
    "the regional and district managers beneath a National Sales Manager are on his team",
  );
  assert.ok(
    ![...members.reps, ...members.managers].some((e) => e.hrId === "N-1"),
    "the subject is never a member of his own team",
  );
  assert.ok(
    ![...members.reps, ...members.managers].some((e) => e.hrId === "D-9"),
    "a manager outside his subtree is not his",
  );
  assert.ok(
    ![...members.reps, ...members.managers].some((e) => e.hrId === "P-1"),
    "only the field chain's managers join — a Product Manager is not a district or regional manager",
  );
  // Only the people working today are on the team: Dina Hamdy's page read "Plans 3 / 10" over a team of four.
  const resigned = { ...person("M-2", "Medical Representative"), employmentStatus: "resigned" } as EmployeeDirectoryRow;
  const onLeave = { ...person("M-3", "Medical Representative"), employmentStatus: "on_leave" } as EmployeeDirectoryRow;
  assert.deepEqual(
    selectTeamLifecycleMembers({ subjectHrId: "D-1", teamHrIds: ["M-1", "M-2", "M-3"], employees: [rep, resigned, onLeave] }).reps.map((e) => e.hrId),
    ["M-1", "M-3"],
    "a rep who has left is not on the team; a rep on leave still is",
  );
  const lifecycleCode = stripComments(readFileSync("src/lib/employee-360/team-lifecycle.ts", "utf8"));
  assert.match(lifecycleCode, /probationDaysRemaining\(/, "probation is counted by the tracker's Cairo-calendar helper");
  assert.doesNotMatch(lifecycleCode, /"crm"/, "a CRM-data deduction is not a no-activity flag");
  assert.match(lifecycleCode, /if \(error\) throw error;\s*for \(const row of data/, "a failed flag read is \"—\", never zero");
  const forRegional = selectTeamLifecycleMembers({
    subjectHrId: "r-1",
    teamHrIds: ["R-1", "D-1", "M-1"],
    employees: [rsm, dsm, rep],
  });
  assert.deepEqual(
    forRegional.managers.map((e) => e.hrId),
    ["D-1"],
    "a Regional Manager's page carries his district managers, and never himself (HR ids compared canonically)",
  );

  // A manager's Phoenix CRM week climbs a two-step chain: `first_approved` is sent, not approved.
  assert.deepEqual(
    countTeamPlanCompliance({ rows: [week({ status: "first_approved" })], repKeyBySeat, repKeyOf }),
    { submitted: 1, approved: 0 },
    "a manager week waiting on its second approver counts as submitted, never as approved",
  );
  const lifecycleSource = stripComments(loader);
  assert.match(
    lifecycleSource,
    /loadManagerPlansInRange\(\{/,
    "the managers' weeks are read through the manager-plan adapter",
  );
  assert.match(
    lifecycleSource,
    /fetchManagerPlanCompliance\(teamManagers, input\.window\)/,
    "the team managers' weeks are counted beside the reps'",
  );
}
