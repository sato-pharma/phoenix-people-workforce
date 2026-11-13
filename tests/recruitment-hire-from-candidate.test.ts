import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { rankHireSeats, type HireSeatCandidate } from "../src/lib/recruitment/workspace/hire.ts";
import {
  FROM_CANDIDATE_PARAM,
  offerComposerHref,
  offerTitleForRoleTab,
  workspaceCandidateHref,
} from "../src/lib/recruitment/workspace/links.ts";
import { stripComments } from "./support/comment-strip.ts";

// ─────────────────────────────────────────────────────────────────────────────
// "Mark as hired" from the recruitment workspace — the FIFTH door between the candidate, the seat
// and the Employee Master (owner's plan, Phase 4, 20 Oct 2026).
//
// The workspace offers the open seats that fit the person (their AU area's rep chair first, then a
// District Manager chair in their region, then any seat of their tab), hands over to Add Employee
// with `?fromCandidate=<id>`, and the employee save itself marks the candidate hired and closes the
// filled seat's requisition. Nothing is marked hired before the form is saved.
//
// The ranking and the links are pure and tested by behaviour; the door is source-pinned because the
// writer talks to the database (the four older doors are pinned the same way in offer-hire-sync).
// ─────────────────────────────────────────────────────────────────────────────

function code(file: string): string {
  return stripComments(readFileSync(file, "utf8"));
}

function flat(file: string): string {
  return code(file).replace(/\s+/g, " ");
}

/** The text of one exported function, from its signature to the next top-level `export`. */
function bodyOf(source: string, signature: string): string {
  const start = source.indexOf(signature);
  assert.ok(start >= 0, `${signature} must exist`);
  const rest = source.slice(start + signature.length);
  const next = /\sexport\s/.exec(rest);
  return source.slice(start, next ? start + signature.length + next.index : undefined);
}

function seat(overrides: Partial<HireSeatCandidate> & { vacancyId: string; label: string }): HireSeatCandidate {
  return {
    areaCode: null,
    regionCode: null,
    seatTier: null,
    seatVacant: null,
    tab: "medical_rep",
    ...overrides,
  };
}

const SEATS: HireSeatCandidate[] = [
  seat({ areaCode: "AB2", label: "Medical Representative · Smouha · CNS", regionCode: "AB", seatTier: "REP", vacancyId: "1" }),
  // The same area, but the org tree says the chair is taken: never offered.
  seat({ areaCode: "AB2", label: "Medical Representative · Smouha · Pedia", regionCode: "AB", seatTier: "REP", seatVacant: false, vacancyId: "2" }),
  seat({ areaCode: "AB3", label: "Medical Representative · Miami · CNS", regionCode: "AB", seatTier: "REP", vacancyId: "3" }),
  seat({ label: "District Sales Manager · Alexandria", regionCode: "AB", seatTier: "DM", tab: "district_manager", vacancyId: "4" }),
  seat({ areaCode: "CA1", label: "Medical Representative · Nasr City · CNS", regionCode: "CA", seatTier: "REP", vacancyId: "5" }),
  seat({ label: "Product Manager · CNS", tab: "product_manager", vacancyId: "6" }),
  // An Upper Egypt half: UE-1 is the apply flow's one Upper Egypt.
  seat({ label: "District Sales Manager · Upper Egypt 1", regionCode: "UE-1", seatTier: "ACTING_DM", tab: "district_manager", vacancyId: "7" }),
];

export function runRecruitmentHireFromCandidateTests(): void {
  // ── 1 · The seats to offer, best first ─────────────────────────────────────────────────────────
  const ranked = rankHireSeats([{ areaCode: "AB2", regionCode: "AB", roleTab: "medical_rep" }], SEATS);
  assert.deepEqual(
    ranked.map((option) => [option.vacancyId, option.match]),
    [
      ["1", "area"],
      ["4", "region"],
      ["3", "title"],
      ["5", "title"],
    ],
    "RED their own area's rep chair first, then a District Manager chair in their region, then the rest of their tab",
  );
  assert.equal(ranked[0].label, "Medical Representative · Smouha · CNS — in their area");
  assert.equal(ranked[1].label, "District Sales Manager · Alexandria — in their region");
  assert.equal(ranked[2].label, "Medical Representative · Miami · CNS", "a same-tab seat carries no suffix");
  assert.ok(!ranked.some((option) => option.vacancyId === "2"), "RED an occupied chair is never offered");
  assert.ok(!ranked.some((option) => option.vacancyId === "6"), "another tab's seat is not offered while their own tab has seats");

  // Upper Egypt: a UE-1 seat is the applicant's UE region.
  const upper = rankHireSeats([{ areaCode: null, regionCode: "UE", roleTab: "district_manager" }], SEATS);
  assert.deepEqual(upper[0], { label: "District Sales Manager · Upper Egypt 1 — in their region", match: "region", vacancyId: "7" });

  // Nobody filed them: every open seat, alphabetical, no suffix.
  const unplaced = rankHireSeats([], SEATS);
  assert.deepEqual(
    unplaced.map((option) => option.vacancyId),
    ["4", "7", "3", "5", "1", "6"],
    "every OPEN seat, alphabetical by label — the occupied one still left out",
  );
  assert.ok(unplaced.every((option) => option.match === "any" && !option.label.includes(" — in their")));

  // Filed somewhere with no seat at all: fall back to every open seat rather than an empty dialog.
  const nothingFits = rankHireSeats([{ areaCode: null, regionCode: null, roleTab: "office_coordinator" }], SEATS);
  assert.equal(nothingFits.length, 6, "no bucket held a seat, so every open seat is offered");

  // ── 2 · The links: ids and a title, never a name ─────────────────────────────────────────────
  assert.equal(FROM_CANDIDATE_PARAM, "fromCandidate", "the Add Employee form reads exactly this parameter");
  assert.equal(offerTitleForRoleTab("medical_rep"), "Medical Representative");
  assert.equal(offerTitleForRoleTab("district_manager"), "District Sales Manager");
  assert.equal(offerTitleForRoleTab("rm_am_nsm", "national_sales_manager"), "National Sales Manager");
  assert.equal(offerTitleForRoleTab("rm_am_nsm", "area_regional_manager"), null, "RED an Area/Regional Manager has no offer title yet — never guessed");
  assert.equal(offerTitleForRoleTab("other"), null);
  assert.equal(offerTitleForRoleTab(null), null);

  const candidateId = "0b5c8a52-3f0e-4d55-9a4c-2f1d6e7a8b90";
  const offer = new URL(offerComposerHref(candidateId, "42", "medical_rep"), "https://phoenix.test");
  assert.equal(offer.pathname, "/offers");
  assert.equal(offer.searchParams.get("candidate"), candidateId);
  assert.equal(offer.searchParams.get("vacancy"), "42");
  assert.equal(offer.searchParams.get("title"), "Medical Representative");
  assert.deepEqual([...offer.searchParams.keys()].sort(), ["candidate", "title", "vacancy"], "RED no name, email or phone in the URL");
  assert.equal(new URL(offerComposerHref(candidateId), "https://phoenix.test").search, `?candidate=${candidateId}`);

  const opened = new URL(workspaceCandidateHref(candidateId, "medical_rep"), "https://phoenix.test");
  assert.equal(opened.pathname, "/recruitment");
  assert.equal(opened.searchParams.get("candidate"), candidateId, "the workspace opens the CV it was handed");

  // ── 3 · The fifth door: the employee save marks the candidate hired and closes the seat ────────
  const sync = flat("src/lib/recruitment/offer-outcome-sync.ts");
  const door = bodyOf(sync, "export async function recordHireFromCandidate(");
  assert.match(door, /if \(!hrId \|\| !isUuid\(candidateId\)\) return/, "a body with no real candidate id marks nobody");
  assert.match(
    door,
    /\.from\("ats_candidates"\)\.select\("id,status"\)\.eq\("id", candidateId\)/,
    "RED the candidate is found by the id the form was opened for — never by name, email or phone",
  );
  assert.match(door, /row\.status === "hired"\) \{ candidate = "already"/, "a second save cannot stack a second history line");
  assert.match(door, /writeCandidateMove\( row, "hired",/, "moved to hired through the one writer that also writes the history line");
  assert.match(door, /\.eq\("status", "filled"\) ?\.in\("filled_by_hr_id", hrIdLookupKeys\(hrId\)\)/, "the vacancy actually filled is READ BACK, by the new HR id");
  assert.match(
    door,
    /runRequisitionWorkflow\(requisition\.id, "req_fill", systemAccessContext\)/,
    "RED the seat's still-open requisition is closed in the same save, as the autopilot would",
  );
  assert.ok(!/ilike\(|\.like\(|full_name|national_id/.test(door), "no fuzzy lookup of a person");

  const employees = flat("app/api/employees/route.ts");
  const recordAt = employees.indexOf("recordHireFromCandidate({");
  assert.ok(recordAt > 0, "RED the employee create route calls the fifth door");
  assert.match(
    employees,
    // Wrapped in the hire hand-off ledger since 2026-11-13 (REC-027) — still awaited, the same arguments.
    /if \(isNewEmployee && payload\.fromCandidateId\?\.trim\(\)\) \{ await handoff\.run\( "candidate_hired", [^;]*?\(\) => recordHireFromCandidate\(\{ actorHrId: access\.hrId \?\? null, candidateId: payload\.fromCandidateId \?\? "", hrId: newEmployeeHrId, \}\)/,
    "only on a NEW employee, with the new HR id",
  );
  assert.ok(
    recordAt < employees.indexOf("await provisionNewHireAccess("),
    "the candidate moves before any follow-up that can throw",
  );
  assert.match(employees, /candidateId: payload\.fromCandidateId \?\? null,/, "their CV is carried across when no file was chosen");

  const form = flat("src/components/employees/employee-management.tsx");
  assert.match(form, /searchParams\.get\(FROM_CANDIDATE_PARAM\)/, "the form reads the workspace's own parameter name");
  assert.match(
    form,
    /\.\.\.\(candidateLinkId \? \{ fromCandidateId: candidateLinkId \} : \{\}\)/,
    "RED the save sends the id held in the form's state, never one re-read from the URL",
  );

  const hire = flat("src/lib/recruitment/workspace/hire.ts");
  assert.match(hire, /FROM_CANDIDATE_PARAM/, "the hire link is built with the same parameter name");

  // ── 4 · The hire routes: who may see the dialog, who may open the door ───────────────────────
  const route = flat("app/api/recruitment/candidates/[id]/hire/route.ts");
  const get = bodyOf(route, "export async function GET(");
  const post = bodyOf(route, "export async function POST(");
  assert.match(get, /requireRecruitmentAccess\(request, "candidates", "read"\)/);
  assert.match(get, /assertCandidateVisible\(access, id\)/, "RED the Talent Acquisition fence holds on the dialog too");
  assert.match(post, /assertSameOriginMutation\(request\)/);
  assert.match(post, /requireRecruitmentAccess\(request, "employees", "update"\)/, "RED the door into Employee Master is Employee Master's own grant");
  assert.match(post, /assertCandidateVisible\(access, id\)/);
  assert.ok(!/\.update\(|\.insert\(/.test(route), "neither handler writes: the hire is the employee save");

  const draft = flat("app/api/recruitment/candidates/[id]/hire-draft/route.ts");
  assert.match(draft, /requireRecruitmentAccess\(request, "employees", "update"\)/);
  assert.match(draft, /assertCandidateVisible\(access, id\)/);
  assert.ok(!/workEmail/.test(draft), "a work email is IT's to assign, never pre-filled from the candidate");
}
