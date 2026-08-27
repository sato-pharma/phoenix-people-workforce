import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  buildDoctorCoverageBoard,
  type DoctorCoverageOrgNode,
  type DoctorCoveragePlanInput,
  type DoctorCoverageVisitInput,
} from "../src/lib/crm/sfe-doctor-coverage.ts";
import { CAMPAIGN_TYPE } from "../src/lib/crm/visit-types.ts";

// The DISTRICT rollup — the owner's ruling of 2026-08-27, in his own words:
//
//   "the concept of CRM that the district manager doesn't have a list. The list of the district
//    manager is the list of his teams. For example, I have four in my team and four everyone have
//    hundred, then I am district manager. My list is for hundred… as she isn't submitting visits
//    by her hand."
//
// Before this, every District Sales Manager and the one medical rep ACTING as a district manager
// sat in the rep table with no list and no percentage, indistinguishable from a new hire whose list
// has not loaded. Measured on production for August 2026 by building the same board twice, with the
// org tree and without: 86 rep rows became 72, "reps with no list" fell from 18 to 4, and every
// company tile stayed identical to the digit.

const MONTH = "2026-08";

let nextVisitId = 1;

function visit(overrides: Partial<DoctorCoverageVisitInput> = {}): DoctorCoverageVisitInput {
  return {
    agent_crm_id: 100,
    agent_hr_id: "M-1",
    agent_name: "Rep One",
    contact_crm_id: 500,
    contact_name: "Dr. Test",
    crm_contact_grade: "B",
    crm_save_date: null,
    crm_visit_id: nextVisitId++,
    double_crm_id: null,
    speciality: "Pediatrics",
    visit_date: "2026-08-05",
    visit_type: 0,
    ...overrides,
  };
}

function plan(overrides: Partial<DoctorCoveragePlanInput> = {}): DoctorCoveragePlanInput {
  return {
    agent_crm_id: 100,
    agent_hr_id: "M-1",
    contact_crm_id: 500,
    contact_grade: "B",
    contact_name: "Dr. Test",
    plan_date: "2026-08-04",
    speciality: "Pediatrics",
    ...overrides,
  };
}

/** The org tree, as the caller would build it from the employee directory: lower-cased hr id ->
 * that employee's manager and title. Every fixture below grades its doctors B, so one visit meets
 * the norm and the arithmetic on each district stays readable. */
const org = (rows: Record<string, { managerHrId: string | null; title: string | null }>) =>
  new Map<string, DoctorCoverageOrgNode>(Object.entries(rows));

export function runDoctorCoverageDistrictTests() {
  // ── A district's panel is the union of its team's lists, and its coverage is what they covered ─
  //
  // Two reps under one District Manager. Rep One holds 2 doctors and covered 1; Rep Two holds 3 and
  // covered 2. The district must therefore read 5 assigned, 3 covered, 60% — a plain sum, with no
  // second scoring pass anywhere, which is what makes a district reconcile with the reps inside it.
  const twoReps = buildDoctorCoverageBoard(
    [
      visit({ agent_crm_id: 100, agent_hr_id: "M-1", contact_crm_id: 501 }),
      visit({ agent_crm_id: 200, agent_hr_id: "M-2", agent_name: "Rep Two", contact_crm_id: 601 }),
      visit({ agent_crm_id: 200, agent_hr_id: "M-2", agent_name: "Rep Two", contact_crm_id: 602 }),
    ],
    MONTH,
    {
      orgByHrId: org({
        "d-1": { managerHrId: null, title: "District Sales Manager" },
        "m-1": { managerHrId: "d-1", title: "Medical Representative" },
        "m-2": { managerHrId: "d-1", title: "Medical Representative" },
      }),
      planRows: [
        plan({ agent_crm_id: 100, agent_hr_id: "M-1", contact_crm_id: 501 }),
        plan({ agent_crm_id: 100, agent_hr_id: "M-1", contact_crm_id: 502 }),
        plan({ agent_crm_id: 200, agent_hr_id: "M-2", contact_crm_id: 601 }),
        plan({ agent_crm_id: 200, agent_hr_id: "M-2", contact_crm_id: 602 }),
        plan({ agent_crm_id: 200, agent_hr_id: "M-2", contact_crm_id: 603 }),
      ],
      repNameByHrId: new Map([
        ["d-1", "Dalia District"],
        ["m-1", "Rep One"],
        ["m-2", "Rep Two"],
      ]),
    },
  );

  assert.equal(twoReps.managers.length, 1, "one manager with reps beneath him gets exactly one district row");
  const district = twoReps.managers[0]!;
  assert.equal(district.managerName, "Dalia District", "a district is NAMED from the employee directory, never from a CRM login handle");
  assert.equal(
    district.panelSize,
    5,
    "THE HEADLINE RULE: a district's panel is its team's assigned lists combined (2 + 3), never a list of the manager's own",
  );
  assert.equal(district.green, 3, "and its covered count is what the team covered (1 + 2)");
  assert.equal(district.coveragePct, 60, "3 of 5 = 60%");
  assert.equal(district.teamSize, 2, "two reps beneath him");
  assert.deepEqual(district.teamRepKeys, ["hr:m-1", "hr:m-2"], "the row carries its reps so the table can open it");
  assert.equal(district.isDistrict, true, "no other manager sits beneath him, so this is a district and not a region");
  assert.equal(district.title, "District Sales Manager", "the title is carried for display");

  // The district reconciles with the reps inside it, by construction rather than by coincidence.
  const teamPanel = twoReps.reps.reduce((sum, rep) => sum + rep.panelSize, 0);
  assert.equal(teamPanel, district.panelSize, "sum of the rep rows must equal the district row");
  assert.equal(twoReps.totals.activePanel, district.panelSize, "and both must equal the company tile");

  // ── The manager himself leaves the rep table ──────────────────────────────────────────────────
  //
  // This is the visible half of the owner's correction. A District Manager logging campaign work and
  // holding no list used to appear as a rep with no panel; he now appears once, as his district.
  const managerWithCampaign = buildDoctorCoverageBoard([visit({ contact_crm_id: 501 })], MONTH, {
    campaignVisits: [
      visit({
        agent_crm_id: 900,
        agent_hr_id: "D-1",
        agent_name: "D.Manager",
        contact_crm_id: 0,
        contact_name: "",
        crm_contact_grade: null,
        speciality: null,
        visit_type: CAMPAIGN_TYPE,
      }),
    ],
    orgByHrId: org({
      "d-1": { managerHrId: null, title: "District Sales Manager" },
      "m-1": { managerHrId: "d-1", title: "Medical Representative" },
    }),
    planRows: [plan({ contact_crm_id: 501 })],
    repNameByHrId: new Map([
      ["d-1", "Dalia District"],
      ["m-1", "Rep One"],
    ]),
  });
  assert.deepEqual(
    managerWithCampaign.reps.map((rep) => rep.repKey),
    ["hr:m-1"],
    "the manager must NOT sit in the rep table — his row is his district, and a manager with no list of his own is the rule here, not a gap",
  );
  assert.deepEqual(
    managerWithCampaign.repOptions.map((option) => option.repKey),
    ["hr:m-1"],
    "and the rep picker must not offer a name the rep table can no longer show",
  );
  assert.equal(
    managerWithCampaign.totals.repsWithNoList,
    0,
    "a District Manager holding no personal list must not be counted as a rep waiting on one — that count read 18 in August 2026 when only 4 were reps",
  );
  assert.equal(
    managerWithCampaign.totals.repsAllCampaign,
    0,
    "nor as a campaign-only REP; that tile read 14 in August 2026 and 4 once managers stopped counting",
  );
  assert.equal(
    managerWithCampaign.managers[0]?.campaignCalls,
    1,
    "his campaign call is not lost — it belongs to his district",
  );
  assert.equal(
    managerWithCampaign.totals.campaignCalls,
    1,
    "and it still reaches the company tile: real work done in scope must not vanish the day districts arrive",
  );

  // ── Membership is STRUCTURAL, never by job title ──────────────────────────────────────────────
  //
  // The case that prompted the whole change: one medical rep is ACTING as a district manager with
  // reps reporting to her. The owner's instruction was to move the reps, never her title — so the
  // board must read the reporting line, not the words "District Sales Manager". Job titles here are
  // free text and misspelt often enough that a title match already hides 9 of 27 real DMs.
  const acting = buildDoctorCoverageBoard([visit({ contact_crm_id: 501 })], MONTH, {
    orgByHrId: org({
      "b-1": { managerHrId: null, title: "Medical Representative" },
      "m-1": { managerHrId: "b-1", title: "Medical Representative" },
    }),
    planRows: [plan({ contact_crm_id: 501 })],
    repNameByHrId: new Map([
      ["b-1", "Nosiba Salah"],
      ["m-1", "Rep One"],
    ]),
  });
  assert.equal(
    acting.managers[0]?.managerName,
    "Nosiba Salah",
    "a MEDICAL REP with reps beneath her gets a district row — membership is 'does anyone report to me', never the job title",
  );
  assert.equal(acting.managers[0]?.title, "Medical Representative", "and her title is reported unchanged, because the owner said to move the reps and not her title");
  assert.equal(acting.managers[0]?.panelSize, 1, "her panel is her team's list");

  // ── isDistrict tells a district from a region, structurally ───────────────────────────────────
  const twoLevels = buildDoctorCoverageBoard(
    [
      visit({ agent_crm_id: 100, agent_hr_id: "M-1", contact_crm_id: 501 }),
      visit({ agent_crm_id: 200, agent_hr_id: "M-2", agent_name: "Rep Two", contact_crm_id: 601 }),
    ],
    MONTH,
    {
      orgByHrId: org({
        "d-1": { managerHrId: "n-1", title: "District Sales Manager" },
        "d-2": { managerHrId: "n-1", title: "District Sales Manager" },
        "m-1": { managerHrId: "d-1", title: "Medical Representative" },
        "m-2": { managerHrId: "d-2", title: "Medical Representative" },
        "n-1": { managerHrId: null, title: "National Sales Manager" },
      }),
      planRows: [
        plan({ agent_crm_id: 100, agent_hr_id: "M-1", contact_crm_id: 501 }),
        plan({ agent_crm_id: 200, agent_hr_id: "M-2", contact_crm_id: 601 }),
      ],
      repNameByHrId: new Map([
        ["d-1", "District One"],
        ["d-2", "District Two"],
        ["m-1", "Rep One"],
        ["m-2", "Rep Two"],
        ["n-1", "National Boss"],
      ]),
    },
  );
  const national = twoLevels.managers.find((row) => row.hrId === "n-1");
  assert.equal(twoLevels.managers.length, 3, "two districts and the level above them");
  assert.equal(national?.isDistrict, false, "a manager with other managers beneath him is a region, not a district");
  assert.equal(
    twoLevels.managers.filter((row) => row.isDistrict).length,
    2,
    "his two District Managers are districts",
  );
  assert.equal(national?.panelSize, 2, "a region rolls up EVERY rep beneath it at any depth, not just its direct reports");
  assert.equal(
    national?.teamSize,
    2,
    "and it expands to the reps, never to the District Managers, whose own rows would double what is on screen",
  );

  // ── A rep the org tree cannot place stays a rep ───────────────────────────────────────────────
  //
  // Five agents on the August 2026 board had no employee record at all — they look like real reps
  // whose HR record simply lags their CRM account. Dropping them would hide real coverage.
  const crmOnly = buildDoctorCoverageBoard(
    [visit({ agent_crm_id: 777, agent_hr_id: null, agent_name: "Rep Nine", contact_crm_id: 33 })],
    MONTH,
    {
      orgByHrId: org({ "d-1": { managerHrId: null, title: "District Sales Manager" } }),
      planRows: [plan({ agent_crm_id: 777, agent_hr_id: null, contact_crm_id: 33 })],
    },
  );
  assert.equal(crmOnly.reps.length, 1, "an agent with no hr id has no place in the tree and must stay a rep row");
  assert.equal(crmOnly.reps[0]?.repKey, "crm:777");
  assert.equal(crmOnly.managers.length, 0, "and produces no district");

  // ── No org tree at all: the board behaves exactly as it did before districts existed ──────────
  const noTree = buildDoctorCoverageBoard([visit({ contact_crm_id: 501 })], MONTH, {
    planRows: [plan({ contact_crm_id: 501 })],
  });
  assert.deepEqual(noTree.managers, [], "no org tree means no district rows — never an inferred hierarchy");
  assert.equal(noTree.reps.length, 1, "and every agent stays a rep");

  // ── A cycle in the directory must not hang the board ──────────────────────────────────────────
  // A reports to B reports to A is a data fault, not a shape to support. The walk has to stop.
  const cyclic = buildDoctorCoverageBoard([visit({ contact_crm_id: 501 })], MONTH, {
    orgByHrId: org({
      "d-1": { managerHrId: "d-2", title: "District Sales Manager" },
      "d-2": { managerHrId: "d-1", title: "National Sales Manager" },
      "m-1": { managerHrId: "d-1", title: "Medical Representative" },
    }),
    planRows: [plan({ contact_crm_id: 501 })],
    repNameByHrId: new Map([["m-1", "Rep One"]]),
  });
  assert.equal(cyclic.managers.length, 2, "both links of the cycle collect the rep, and the walk terminates");
  assert.equal(cyclic.reps.length, 1, "the rep is unharmed by his managers' bad records");

  // ── A manager who genuinely holds a list of his own keeps his rep row ─────────────────────────
  //
  // Rare, and it should stay rare — but if it happens, his own list must be scored somewhere rather
  // than disappearing into a district total with no line of its own.
  const managerWithOwnList = buildDoctorCoverageBoard(
    [
      visit({ agent_crm_id: 100, agent_hr_id: "M-1", contact_crm_id: 501 }),
      visit({ agent_crm_id: 900, agent_hr_id: "D-1", agent_name: "D.Manager", contact_crm_id: 701 }),
    ],
    MONTH,
    {
      orgByHrId: org({
        "d-1": { managerHrId: null, title: "District Sales Manager" },
        "m-1": { managerHrId: "d-1", title: "Medical Representative" },
      }),
      planRows: [
        plan({ agent_crm_id: 100, agent_hr_id: "M-1", contact_crm_id: 501 }),
        plan({ agent_crm_id: 900, agent_hr_id: "D-1", contact_crm_id: 701 }),
      ],
      repNameByHrId: new Map([
        ["d-1", "Dalia District"],
        ["m-1", "Rep One"],
      ]),
    },
  );
  assert.equal(
    managerWithOwnList.reps.length,
    2,
    "a manager holding an assigned list of his own stays in the rep table too — his list has to be scored somewhere",
  );
  assert.equal(
    managerWithOwnList.managers[0]?.panelSize,
    2,
    "and his own list is still part of his district's panel",
  );
  assert.equal(managerWithOwnList.managers[0]?.teamSize, 1, "but he is not a member of his own team");

  // ── Source contracts ─────────────────────────────────────────────────────────────────────────
  const serviceSource = readFileSync("src/lib/crm/sfe-doctor-coverage.ts", "utf8");
  assert.match(
    serviceSource,
    /orgByHrId\?: ReadonlyMap<string, DoctorCoverageOrgNode>/,
    "the org tree must be an explicit OPTION supplied by the caller — a hierarchy inferred from visit patterns is how a board starts asserting who reports to whom on a coincidence",
  );
  assert.doesNotMatch(
    serviceSource,
    /District Sales Manager"\s*===|jobTitle\s*===|title\s*===\s*"District/,
    "membership must never be decided by comparing a job title string — free text, and misspelt enough to hide 9 of 27 real District Managers",
  );

  const tablesSource = readFileSync("src/components/crm/doctor-coverage-tables.tsx", "utf8");
  assert.match(tablesSource, /DoctorCoverageDistrictTable/, "the districts need their own table");
  assert.match(
    tablesSource,
    /r\.hasPanel \? r\.coveragePct : null/,
    "a row with no panel must sort as MISSING, not as 0 — the hook sinks a missing value in both directions, and a plain 0 puts every rep with no list back at the top of a worst-first table",
  );

  const boardSource = readFileSync("src/components/crm/doctor-coverage-board.tsx", "utf8");
  assert.match(boardSource, /title="Coverage by district"/, "the board must carry a district section");
  assert.match(
    boardSource,
    /board\.managers\.length > 0 \?/,
    "and must hide it when there is no org tree, rather than showing an empty section that reads as 'nobody manages anyone'",
  );
}
