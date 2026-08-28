import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  buildDoctorCoverageBoard,
  type DoctorCoverageOrgNode,
  type DoctorCoveragePlanInput,
  type DoctorCoverageVisitInput,
} from "../src/lib/crm/sfe-doctor-coverage.ts";
import { crmTerritoryFrom, splitCrmRepName } from "../src/lib/crm/rep-name.ts";
import { CAMPAIGN_TYPE } from "../src/lib/crm/visit-types.ts";

// WHAT A REP IS CALLED — the owner's instruction of 2026-08-27: "show the real name and keep the
// territory".
//
// The CRM's `agent_name` is a LOGIN HANDLE with a territory bolted on the end:
// "Aisha.Ehab ( Minia 2 / E )". Rendering it whole put a handle in front of a manager, breaking the
// standing rule that a human-readable name is always shown. Dropping it whole would have thrown
// away the territory, which is the half a manager reads to tell two reps apart. So the name now
// comes from the employee DIRECTORY and the bracket comes from the CRM.
//
// Measured on production 2026-08-27 over the four-month read window: of 102 agents carrying a CRM
// name, all 102 had a directory row and 100 changed. The longest label grew from 41 to 70
// characters, which is why the desktop cells that render it are held to one line.

const MONTH = "2026-08";

let nextVisitId = 1;

function visit(overrides: Partial<DoctorCoverageVisitInput> = {}): DoctorCoverageVisitInput {
  return {
    agent_crm_id: 100,
    agent_hr_id: "M-1",
    agent_name: "Aisha.Ehab ( Minia 2 / E )",
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

const org = (rows: Record<string, { managerHrId: string | null; title: string | null }>) =>
  new Map<string, DoctorCoverageOrgNode>(Object.entries(rows));

/** Build a one-rep board and return what that rep ends up being called. */
function nameOf(agentName: string | null, directory: Array<[string, string]>, hrId = "M-1"): string {
  const board = buildDoctorCoverageBoard(
    [visit({ agent_hr_id: hrId, agent_name: agentName })],
    MONTH,
    {
      planRows: [plan({ agent_hr_id: hrId })],
      repNameByHrId: new Map(directory),
    },
  );
  return board.reps[0]!.repName;
}

export function runDoctorCoverageRepNameTests() {
  // ── THE HEADLINE: the directory names the person, the CRM names the territory ─────────────────
  assert.equal(
    nameOf("Aisha.Ehab ( Minia 2 / E )", [["m-1", "Aisha Ehab Mostafa Kamel"]]),
    "Aisha Ehab Mostafa Kamel ( Minia 2 / E )",
    "THE HEADLINE RULE: the real name comes from the employee directory and the territory is kept from the CRM — never the login handle the CRM leads with",
  );

  // ── The pathological production row: a CRM name that is territory and NOTHING else ────────────
  //
  // Six agents in the August window carried an agent_name of exactly "( Behira 2 / C )". That
  // rendered a coverage row belonging to no visible person at all — worse than a handle, because
  // there was nothing to look up. The same rule fixes it for free.
  assert.equal(
    nameOf("( Behira 2 / C )", [["m-1", "Samia Raafat Khaled Mohamed Elgendy"]]),
    "Samia Raafat Khaled Mohamed Elgendy ( Behira 2 / C )",
    "a CRM name that is territory and nothing else must still produce a named person, not a bare bracket",
  );

  // ── No territory in the CRM name: the real name stands alone, with no empty brackets ──────────
  assert.equal(
    nameOf("Mahmoud. ElHassanein", [["m-1", "Mahmoud Elhassanein Sayed"]]),
    "Mahmoud Elhassanein Sayed",
    "with no bracket in the CRM name the directory name stands alone — never an empty '( )' stitched on",
  );

  // ── No directory row: keep the CRM name rather than throwing away the only name there is ──────
  assert.equal(
    nameOf("Aisha.Ehab ( Minia 2 / E )", []),
    "Aisha.Ehab ( Minia 2 / E )",
    "with no directory row the CRM name survives unchanged — a handle beats no name, and a name is not the place to start throwing",
  );

  // ── The vendor's spacing: trimmed at the edges, never rewritten inside ────────────────────────
  //
  // Production carries "( Mahalla  / A )" with a double space inside and "( Helwan-Maadi / C  )"
  // with one before the bracket. The interior is the vendor's text; only the outer padding goes.
  assert.equal(
    nameOf("Ashraf.Maged ( Mahalla  / A )", [["m-1", "Ashraf Maged Radwan"]]),
    "Ashraf Maged Radwan ( Mahalla  / A )",
    "spacing INSIDE the territory is the vendor's own text and must survive untouched",
  );
  assert.equal(
    nameOf("Fatma.Gharib ( Helwan-Maadi / C  )", [["m-1", "Fatma Gharib Ibrahim"]]),
    "Fatma Gharib Ibrahim ( Helwan-Maadi / C )",
    "padding at the EDGES of the bracket is ours to normalise",
  );

  // ── A bracket that is not a trailing territory is not one ─────────────────────────────────────
  assert.equal(
    nameOf("Ahmed (Acting) Fathy", [["m-1", "Ahmed Fathy Selim"]]),
    "Ahmed Fathy Selim",
    "only a bracket at the END is a territory — one in the middle of a name must not be lifted out and re-stamped on the end",
  );

  // ── An agent with no hr id at all keeps whatever the CRM calls him ────────────────────────────
  const crmOnly = buildDoctorCoverageBoard(
    [visit({ agent_crm_id: 777, agent_hr_id: null, agent_name: "Hoda.Samir ( Tanta / C )" })],
    MONTH,
    {
      planRows: [plan({ agent_crm_id: 777, agent_hr_id: null })],
      repNameByHrId: new Map([["m-1", "Someone Else Entirely"]]),
    },
  );
  assert.equal(
    crmOnly.reps[0]?.repName,
    "Hoda.Samir ( Tanta / C )",
    "a crm-keyed agent has no hr id to look up, so the directory cannot reach him and his CRM name stands",
  );

  // ── A CAMPAIGN-ONLY rep — no graded visit anywhere, so `latestRepName` never sees him ──────────
  //
  // This is the path that first shipped this fix broken: every fixture above has a graded visit,
  // so `latestRepName` was populated and the naming waterfall's first rung caught it. A rep whose
  // ENTIRE month is campaign work never reaches that map at all — the campaign fold-in used to
  // build its own name straight from the CRM string, bypassing `repNameFor` entirely, and that
  // second rule is exactly how three real reps (Adel.Srour, Ahmed.Sharaf, Omayma.Wael) kept their
  // login handle after every other row on the board had already switched to a real name. Caught by
  // browser verification against the served page, not by this suite, until this scenario existed.
  const campaignOnly = buildDoctorCoverageBoard([], MONTH, {
    campaignVisits: [
      visit({
        agent_crm_id: 300,
        agent_hr_id: "M-3",
        agent_name: "Adel.Srour ( Down-town / C )",
        contact_crm_id: 0,
        contact_name: null,
        speciality: null,
        visit_type: CAMPAIGN_TYPE,
      }),
    ],
    planRows: [],
    repNameByHrId: new Map([["m-3", "Adel Srour Fahmy"]]),
  });
  assert.equal(
    campaignOnly.reps[0]?.repName,
    "Adel Srour Fahmy ( Down-town / C )",
    "a rep with NO graded visit at all — the whole board's worth of evidence for him is a campaign call — must be named through the SAME waterfall as everyone else, not a second rule that only the campaign fold-in runs",
  );

  // ── A DISTRICT is named WITHOUT a territory, even though its manager's CRM name carries one ───
  //
  // Nosiba's CRM name says "( Minia 1 / E )", but the district beneath her spans Minia 1, Minia 2
  // and Bani Sweif. Stamping one of the three beside a combined panel would state something untrue
  // about the other two, so a district is named for the person and its territories are the rows
  // inside it.
  const withDistrict = buildDoctorCoverageBoard(
    [
      visit({ agent_crm_id: 100, agent_hr_id: "M-1", agent_name: "Aisha.Ehab ( Minia 2 / E )", contact_crm_id: 501 }),
      visit({ agent_crm_id: 900, agent_hr_id: "D-1", agent_name: "Nosiba.Salah ( Minia 1 / E )", contact_crm_id: 901 }),
    ],
    MONTH,
    {
      orgByHrId: org({
        "d-1": { managerHrId: null, title: "Medical Representative" },
        "m-1": { managerHrId: "d-1", title: "Medical Representative" },
      }),
      planRows: [plan({ agent_crm_id: 100, agent_hr_id: "M-1", contact_crm_id: 501 })],
      repNameByHrId: new Map([
        ["d-1", "Nosiba Salah Hussenin Moussa"],
        ["m-1", "Aisha Ehab Mostafa Kamel"],
      ]),
    },
  );
  assert.equal(
    withDistrict.managers[0]?.managerName,
    "Nosiba Salah Hussenin Moussa",
    "a DISTRICT carries no territory — its manager's own patch would misdescribe the combined panel beneath him",
  );
  assert.equal(
    withDistrict.reps[0]?.repName,
    "Aisha Ehab Mostafa Kamel ( Minia 2 / E )",
    "while a REP inside that district keeps his, because it is what tells him apart from the rep next door",
  );

  // ── Source contracts ─────────────────────────────────────────────────────────────────────────
  // The pattern moved to src/lib/crm/rep-name.ts when Reps Plans needed it too — one regex, two
  // boards. Pinned at its new home, and the old home is pinned to IMPORT rather than re-declare:
  // a second copy is how two boards start disagreeing about what a territory is.
  const repNameSource = readFileSync("src/lib/crm/rep-name.ts", "utf8");
  assert.match(
    repNameSource,
    /const CRM_TERRITORY = \/\\\(\\s\*\(\[\^\(\)\]\+\?\)\\s\*\\\)\\s\*\$\//,
    "the territory pattern must stay anchored at the END and refuse nested brackets — an unanchored one lifts a bracket out of the middle of a name",
  );

  const serviceSource = readFileSync("src/lib/crm/sfe-doctor-coverage.ts", "utf8");
  assert.ok(
    serviceSource.includes('import { crmTerritoryFrom } from "@/lib/crm/rep-name";'),
    "coverage must IMPORT the shared splitter, never carry its own copy of the pattern",
  );
  assert.ok(
    !serviceSource.includes("const CRM_TERRITORY ="),
    "and the private copy must stay deleted",
  );

  const tablesSource = readFileSync("src/components/crm/doctor-coverage-tables.tsx", "utf8");
  const nowrapCells = tablesSource.match(/whitespace-nowrap[^>]*>\{(?:row|rep)\.repName\}/g) ?? [];
  assert.equal(
    nowrapCells.length,
    3,
    "all three desktop cells rendering a rep name must hold it on one line — the label grew from 41 to 70 characters, and wrapping is forbidden here exactly as an ellipsis is",
  );
  assert.doesNotMatch(
    tablesSource,
    /truncate[^"]*>\{(?:row|rep)\.repName\}/,
    "and it must never be truncated — the owner's rule is that text is never elided",
  );

  // ── Splitting the handle, for a card that must not wrap ──────────────────────────────────────
  // Reps Plans shows one card per rep on a phone. Its title WRAPS below md and has to keep doing
  // so: #2268 (2026-08-21) measured whitespace-nowrap taking a 375px page out to 455px of sideways
  // scroll, and the owner rejects an ellipsis everywhere. So the fix for a wrapping name is a
  // SHORTER STRING, not a nowrap — the person in the title, the territory one line below.
  assert.deepEqual(
    splitCrmRepName("Adel.Srour ( Down-town / C )"),
    { name: "Adel.Srour", territory: "Down-town / C" },
    "a handle splits into the person half and the territory half",
  );
  assert.deepEqual(
    splitCrmRepName("Nermeen.Salah"),
    { name: "Nermeen.Salah", territory: null },
    "a handle with no bracket keeps its whole name and reports no territory",
  );
  assert.deepEqual(
    splitCrmRepName("( Behira 2 / C )"),
    { name: "", territory: "Behira 2 / C" },
    "the pathological handle that is territory and NOTHING else leaves an empty person half, so the caller can decide rather than being handed an invented label",
  );
  assert.deepEqual(
    splitCrmRepName("Ahmed (Ali) Hassan ( Tanta / P )"),
    { name: "Ahmed (Ali) Hassan", territory: "Tanta / P" },
    "a bracket in the MIDDLE of a name is part of the name — only the trailing group is a territory",
  );
  assert.deepEqual(splitCrmRepName(null), { name: "", territory: null }, "a missing name never throws");
  assert.equal(crmTerritoryFrom("Aisha.Ehab ( Minia 2 / E )"), "Minia 2 / E");
  assert.equal(crmTerritoryFrom(""), null);

  const repsPlansSource = readFileSync("src/components/crm/reps-plans-tables.tsx", "utf8");
  assert.ok(
    repsPlansSource.includes("splitCrmRepName(row.repName)"),
    "the Reps Plans card must split the handle rather than printing it whole",
  );
  assert.ok(
    !/whitespace-nowrap[^>]*>\{cardTitle\}/.test(repsPlansSource),
    "and it must NOT pin the card title to one line — that is the change #2268 reverted, and it returns a sideways-scrolling phone page",
  );
}
