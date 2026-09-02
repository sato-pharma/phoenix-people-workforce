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
      // Shaped like production: the CEO sits above the National Sales Manager. That matters — a
      // tree truncated at the NSM would make HIM the root, and the root is dropped as the company.
      orgByHrId: org({
        aa: { managerHrId: null, title: "Ceo" },
        "d-1": { managerHrId: "n-1", title: "District Sales Manager" },
        "d-2": { managerHrId: "n-1", title: "District Sales Manager" },
        "m-1": { managerHrId: "d-1", title: "Medical Representative" },
        "m-2": { managerHrId: "d-2", title: "Medical Representative" },
        "n-1": { managerHrId: "aa", title: "National Sales Manager" },
      }),
      planRows: [
        plan({ agent_crm_id: 100, agent_hr_id: "M-1", contact_crm_id: 501 }),
        plan({ agent_crm_id: 200, agent_hr_id: "M-2", contact_crm_id: 601 }),
      ],
      repNameByHrId: new Map([
        ["aa", "Anwar Gaweesh"],
        ["d-1", "District One"],
        ["d-2", "District Two"],
        ["m-1", "Rep One"],
        ["m-2", "Rep Two"],
        ["n-1", "National Boss"],
      ]),
    },
  );
  const national = twoLevels.managers.find((row) => row.hrId === "n-1");
  assert.equal(twoLevels.managers.length, 3, "two districts and the level above them — the CEO above THAT is the company, and gets no row");
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

  // ── A Product Manager holds no personal list either — but unlike a manager, he STAYS a rep row ──
  //
  // Owner's ruling 2026-08-27: exclude a Product Manager from the "no list" tallies, the same as a
  // District Manager, because he owns a brand rather than a territory of reps — but never pull his
  // row out of the rep table the way a manager is pulled. His own board access is scoped to his
  // product line and built from this same table, so removing him here would take his own view away
  // along with the false alarm. Production, 2026-08: Ahmed Sharaf (B-155), 17 campaign calls, no
  // list since at least June.
  const productManager = buildDoctorCoverageBoard([visit({ contact_crm_id: 501 })], MONTH, {
    campaignVisits: [
      visit({
        agent_crm_id: 900,
        agent_hr_id: "PM-1",
        agent_name: "A.Sharaf ( PM / P )",
        contact_crm_id: 0,
        contact_name: "",
        crm_contact_grade: null,
        speciality: null,
        visit_type: CAMPAIGN_TYPE,
      }),
    ],
    orgByHrId: org({
      "m-1": { managerHrId: null, title: "Medical Representative" },
      "pm-1": { managerHrId: null, title: "Product Manager" },
    }),
    planRows: [plan({ contact_crm_id: 501 })],
    repNameByHrId: new Map([
      ["m-1", "Rep One"],
      ["pm-1", "Ahmed Sharaf"],
    ]),
  });
  assert.deepEqual(
    productManager.reps.map((rep) => rep.repKey).sort(),
    ["hr:m-1", "hr:pm-1"],
    "a Product Manager is not a structural manager (no reports beneath him) and must stay a plain rep row — pulling him out would take his own product-line view away with it",
  );
  assert.equal(
    productManager.reps.find((rep) => rep.repKey === "hr:pm-1")?.hasPanel,
    false,
    "his row still honestly reports no assigned list — only the company tally treats it as expected, not the row itself",
  );
  assert.equal(
    productManager.totals.repsWithNoList,
    0,
    "THE HEADLINE RULE: a Product Manager holding no personal list must not inflate the 'reps waiting on a list' tile — same rule as a District Manager, different reason",
  );
  assert.equal(productManager.totals.repsAllCampaign, 0, "nor the campaign-only tile");

  // Control: a different staff title doing the identical campaign-only work IS still counted — the
  // exclusion is an exact title match, never a prefix or a "contains".
  const groupProductManager = buildDoctorCoverageBoard([visit({ contact_crm_id: 501 })], MONTH, {
    campaignVisits: [
      visit({
        agent_crm_id: 901,
        agent_hr_id: "GPM-1",
        agent_name: "G.Product ( HQ / P )",
        contact_crm_id: 0,
        contact_name: "",
        crm_contact_grade: null,
        speciality: null,
        visit_type: CAMPAIGN_TYPE,
      }),
    ],
    orgByHrId: org({
      "m-1": { managerHrId: null, title: "Medical Representative" },
      "gpm-1": { managerHrId: null, title: "Group Product Manager" },
    }),
    planRows: [plan({ contact_crm_id: 501 })],
    repNameByHrId: new Map([
      ["m-1", "Rep One"],
      ["gpm-1", "Some GPM"],
    ]),
  });
  assert.equal(
    groupProductManager.totals.repsWithNoList,
    1,
    "a Group Product Manager is a different, more senior title and is deliberately NOT exempted — nobody holding it showed up in this tally in production, and the match must stay exact rather than widen on its own",
  );

  // ── A manager whose recorded report produced no row this month still gets his district ──────────
  //
  // Ahmed Nagy (PD-0006), production, 2026-08: one direct report on paper (Bahaa Gamal, PD-0007),
  // resigned, and therefore absent from repRows entirely — resigned agents are filtered out
  // upstream, the same door that keeps a leaver's visits off every other rep's board. The upward
  // walk above only discovers a manager by climbing FROM a rep who has a row, so a manager whose
  // only report has no row at all was invisible to it, and fell back to reading as an ordinary rep
  // with no list despite being a manager. Owner's ruling 2026-08-27: keep him as a district — of an
  // empty roster right now — instead.
  const managerWithNoActiveReports = buildDoctorCoverageBoard([visit({ contact_crm_id: 501 })], MONTH, {
    campaignVisits: [
      visit({
        agent_crm_id: 950,
        agent_hr_id: "DM-EMPTY",
        agent_name: "E.Manager ( Delta / C )",
        contact_crm_id: 0,
        contact_name: "",
        crm_contact_grade: null,
        speciality: null,
        visit_type: CAMPAIGN_TYPE,
      }),
    ],
    orgByHrId: org({
      "m-1": { managerHrId: null, title: "Medical Representative" },
      "dm-empty": { managerHrId: null, title: "District Sales Manager" },
      // Recorded in the directory, but produces no visit, plan or campaign row anywhere in this
      // fixture — exactly how a departed agent's data is excluded upstream.
      "resigned-1": { managerHrId: "dm-empty", title: "Medical Representative" },
    }),
    planRows: [plan({ contact_crm_id: 501 })],
    repNameByHrId: new Map([
      ["m-1", "Rep One"],
      ["dm-empty", "Empty Manager"],
    ]),
  });
  assert.deepEqual(
    managerWithNoActiveReports.reps.map((rep) => rep.repKey),
    ["hr:m-1"],
    "the manager must not read as an ordinary rep just because his one recorded report produced no row this month — only the unrelated control rep remains",
  );
  assert.equal(managerWithNoActiveReports.managers.length, 1, "he still gets exactly one district row");
  const emptyDistrict = managerWithNoActiveReports.managers[0]!;
  assert.equal(emptyDistrict.managerName, "Empty Manager");
  assert.equal(emptyDistrict.isDistrict, true, "no other manager sits beneath him");
  assert.equal(emptyDistrict.teamSize, 0, "his roster is genuinely empty of ACTIVE reports right now");
  assert.equal(
    emptyDistrict.campaignCalls,
    1,
    "but his own field work still belongs to his district, not to a rep row that no longer exists",
  );
  assert.equal(
    managerWithNoActiveReports.totals.repsWithNoList,
    0,
    "and he must never be counted as a rep waiting on a list either",
  );

  // ── THE COMPANY IS NOT A DISTRICT, AND A VIEWER IS NOT SHOWN HIS OWN NUMBERS TWICE ───────────
  //
  // Owner, 2026-08-28, on opening the board: "I see the CEO have assigned visits appeared in the
  // district manager page… He never assigned to visits."
  //
  // The walk gives a row to every ancestor, so it reached the top of the tree — in production the
  // CEO (`AA`), whom all three National Sales Managers report to — and handed him whatever the
  // board was scoped to as though it were his own assigned doctor list.
  const LADDER = {
    orgByHrId: org({
      aa: { managerHrId: null, title: "Ceo" },
      "n-1": { managerHrId: "aa", title: "National Sales Manager" },
      "d-1": { managerHrId: "n-1", title: "District Sales Manager" },
      "m-1": { managerHrId: "d-1", title: "Medical Representative" },
      "m-2": { managerHrId: "d-1", title: "Medical Representative" },
    }),
    planRows: [
      plan({ agent_crm_id: 100, agent_hr_id: "M-1", contact_crm_id: 501 }),
      plan({ agent_crm_id: 200, agent_hr_id: "M-2", contact_crm_id: 601 }),
    ],
    repNameByHrId: new Map([
      ["aa", "Anwar Gaweesh"],
      ["n-1", "Nabil National"],
      ["d-1", "Dalia District"],
      ["m-1", "Rep One"],
      ["m-2", "Rep Two"],
    ]),
  };
  const LADDER_VISITS = [
    visit({ agent_crm_id: 100, agent_hr_id: "M-1", contact_crm_id: 501 }),
    visit({ agent_crm_id: 200, agent_hr_id: "M-2", agent_name: "Rep Two", contact_crm_id: 601 }),
  ];

  const companyView = buildDoctorCoverageBoard(LADDER_VISITS, MONTH, LADDER);
  assert.ok(
    !companyView.managers.some((row) => row.hrId === "aa"),
    "THE HEADLINE: the top of the reporting tree gets NO manager row — the CEO has never held an assigned doctor list, and the board already states the company in its totals",
  );
  assert.deepEqual(
    [...companyView.managers.map((row) => row.hrId)].sort(),
    ["d-1", "n-1"],
    "the district and the National Sales Manager above it stay real rows — only the company root is dropped, and structurally, never by job title",
  );

  // A SCOPED viewer gets no row for anyone above his own seat. His board holds only his own reps,
  // so such a row can only be his own numbers under somebody else's name — and it states something
  // false about a person who manages more reps than this viewer is allowed to see.
  const asDistrictManager = buildDoctorCoverageBoard(LADDER_VISITS, MONTH, { ...LADDER, viewerHrId: "D-1" });
  assert.deepEqual(
    asDistrictManager.managers.map((row) => row.hrId),
    ["d-1"],
    "a District Manager sees his OWN district and nothing above it — not his National Sales Manager, and not the CEO",
  );
  assert.equal(
    asDistrictManager.managers[0]?.panelSize,
    2,
    "and his own district row is unchanged — the walk stops AT the viewer, not before him",
  );
  // Upper-cased and padded on purpose: an hr id arrives from the session in its own casing while the
  // org tree is keyed lower-cased. One mismatched character would silently mean "the viewer is
  // nowhere in this tree", the walk would climb to the top again, and the CEO row would come back.
  assert.deepEqual(
    buildDoctorCoverageBoard(LADDER_VISITS, MONTH, { ...LADDER, viewerHrId: "  D-1  " }).managers.map((r) => r.hrId),
    ["d-1"],
    "the viewer's hr id is matched case- and whitespace-insensitively, like every other key read out of the org tree",
  );

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

  // Three further source pins stood here and are gone with the files they read.
  //
  // The first required both doctor-coverage pages to hand the service the viewer's identity, since
  // the page is the only place holding an AccessContext and a missing argument cannot be caught
  // downstream. The owner retired that board on 2026-08-28 and both pages became redirect stubs.
  //
  // The other two read doctor-coverage-tables.tsx and doctor-coverage-board.tsx — that the district
  // table existed, that it sorted a panel-less rep as MISSING rather than as 0, and that the board
  // hid the district section when there was no org tree. Those components were deleted on
  // 2026-09-02: nothing had imported them since the retirement, so they were shells no route could
  // render. An assertion against a file that is not there does not guard a rule, it only fails.
  //
  // The rules themselves are not withdrawn, and the rebuild must honour them. They are recorded
  // here rather than in a commit message because this is where the next person will look: a rep
  // with no panel sorts as MISSING in both directions (a plain 0 puts every rep with no list at the
  // top of a worst-first table), and a district section with no org tree behind it is hidden rather
  // than drawn empty, which would read as 'nobody manages anyone'.
  //
  // Everything above this line is behavioural — it exercises buildDoctorCoverageBoard directly and
  // is unaffected by any of it.
}
