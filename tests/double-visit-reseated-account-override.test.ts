import assert from "node:assert/strict";

import type { CrmResolutionRow } from "../src/lib/crm/types.ts";
import { liveDoubleVisitRowsFromMirror, type MirrorVisitRow } from "../src/lib/double-visit-analytics/service.ts";
import type { EmployeeDirectoryRow } from "../src/lib/employees/employee-directory.ts";

// A DISTRICT MANAGER'S COVERAGE CARD LISTED A REP AS NEVER DOUBLE-VISITED WHILE THE PROBATION
// WATCHLIST BESIDE IT READ "DV DONE" (2026-10-26, the owner's screenshot of Weaam Mahmoud's portal).
// Both read the same three double visits with Mariam Younan (14, 17 and 20 Oct). The watchlist reads
// her probation case; the card reads Double Visit Analytics, which applied the saved identity mapping
// of her CRM account — 1437, "( Sohag 2 / A )", mapped on 28 Aug to Mostafa Khaled, who left on
// 30 Apr — as a bare crm_id → hr_id lookup, so every visit with her was credited to him. Account 1303
// (Norhan Gamal, mapped to Belal Gamal) had the same shape. The mapping must answer through the
// shared waterfall: scoped to the label it was saved against and to the mapped person's employment.

function employee(input: Partial<EmployeeDirectoryRow> & { hrId: string }): EmployeeDirectoryRow {
  return {
    areaName: "Sohag 2",
    crmId: null,
    crmUsername: null,
    departmentName: null,
    displayName: input.hrId,
    employmentStatus: "active",
    fullName: input.hrId,
    hireDate: null,
    jobTitle: "Medical Representative",
    lastWorkingDate: null,
    lineName: "Pedia",
    managerHrId: null,
    managerName: null,
    positionTitle: "Medical Representative",
    regionName: null,
    ...input,
  } as EmployeeDirectoryRow;
}

const EMPLOYEES: EmployeeDirectoryRow[] = [
  employee({
    hrId: "AI-0023",
    displayName: "Mariam Younan",
    crmId: "1437",
    crmUsername: "Mariam.Younan ( Sohag 2 / A )",
    hireDate: "2026-10-01",
  }),
  employee({
    hrId: "B-150",
    displayName: "Mostafa Khaled",
    employmentStatus: "resigned",
    hireDate: "2026-01-24",
    lastWorkingDate: "2026-04-30",
  }),
  employee({ hrId: "B-310", displayName: "New Rep", hireDate: "2026-06-01" }),
  employee({ hrId: "B-311", displayName: "Left Rep", employmentStatus: "resigned", lastWorkingDate: "2026-05-31" }),
  employee({
    hrId: "AI-0013",
    displayName: "Weaam Mahmoud",
    jobTitle: "District Sales Manager",
    positionTitle: "District Sales Manager",
  }),
];

let sequence = 0;
function visit(input: { agentCrm: number; agentHrId: string | null; agentName: string; date: string }): MirrorVisitRow {
  sequence += 1;
  return {
    agent_crm_id: input.agentCrm,
    agent_hr_id: input.agentHrId,
    agent_name: input.agentName,
    ampm: "AM",
    contact_name: `Dr ${sequence}`,
    crm_visit_id: 900000 + sequence,
    customer_name: null,
    double_crm_id: 1554,
    double_hr_id: "AI-0013",
    double_name: "Weaam Mahmoud",
    id: `00000000-0000-0000-0000-${sequence.toString(16).padStart(12, "0")}`,
    visit_date: input.date,
    visit_type: 0,
    visit_type_description: "Regular",
  } as MirrorVisitRow;
}

function creditedTo(rows: MirrorVisitRow[], resolutions: CrmResolutionRow[]): Array<string | null> {
  return liveDoubleVisitRowsFromMirror(rows, EMPLOYEES, resolutions).map((row) => row.visited_employee_hr_id);
}

export async function runDoubleVisitReseatedAccountOverrideTests(): Promise<void> {
  const october = [
    visit({ agentCrm: 1437, agentHrId: "AI-0023", agentName: "Mariam Younan Gaber Kends", date: "2026-10-14" }),
    visit({ agentCrm: 1437, agentHrId: "AI-0023", agentName: "Mariam Younan Gaber Kends", date: "2026-10-17" }),
    visit({ agentCrm: 1437, agentHrId: "AI-0023", agentName: "Mariam Younan Gaber Kends ( Sohag 2 / A )", date: "2026-10-20" }),
  ];

  // The production mapping, as stored: label-scoped to the leaver's own label.
  const labelled: CrmResolutionRow[] = [
    { crmId: 1437, crmName: "( Sohag 2 / A )", mappedHrId: "B-150", status: "mapped" },
  ];
  assert.deepEqual(
    creditedTo(october, labelled),
    ["AI-0023", "AI-0023", "AI-0023"],
    "a mapping to a leaver never takes the reseated account's new holder's visits from her",
  );

  // A legacy mapping saved with no label applies to every label — the employment span still refuses it.
  const unlabelled: CrmResolutionRow[] = [{ crmId: 1437, crmName: null, mappedHrId: "B-150", status: "mapped" }];
  assert.deepEqual(
    creditedTo(october, unlabelled),
    ["AI-0023", "AI-0023", "AI-0023"],
    "a label-less mapping cannot credit a leaver with work dated after his last working day",
  );

  // Inside the mapped person's own employment the mapping still answers — that is what it is for.
  const march = [visit({ agentCrm: 1437, agentHrId: null, agentName: "( Sohag 2 / A )", date: "2026-03-10" })];
  assert.deepEqual(creditedTo(march, labelled), ["B-150"], "the mapping still credits the leaver's own tenure");

  // The classic use: the mirror still stamps the leaver on his old account, and the mapping credits the
  // replacement, who holds no crm_id on the roster yet.
  const handedOver = [visit({ agentCrm: 9001, agentHrId: "B-311", agentName: "( Giza 1 / A )", date: "2026-07-05" })];
  const toReplacement: CrmResolutionRow[] = [{ crmId: 9001, crmName: null, mappedHrId: "B-310", status: "mapped" }];
  assert.deepEqual(creditedTo(handedOver, toReplacement), ["B-310"], "a mapping to the current holder still re-credits a stale stamp");

  // An account nobody mapped keeps the hr id the sync stamped.
  const unmapped = [visit({ agentCrm: 4242, agentHrId: "AI-0023", agentName: "Mariam Younan Gaber Kends", date: "2026-10-14" })];
  assert.deepEqual(creditedTo(unmapped, labelled), ["AI-0023"], "an unmapped account is credited as stamped");
}
