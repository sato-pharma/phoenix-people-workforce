import assert from "node:assert/strict";

import { isMedicalRep, isMedicalRepJobTitle } from "../src/lib/crm/medical-rep.ts";
import { isAgentInScope, type DoctorCoverageScope } from "../src/lib/crm/doctor-coverage-roles.ts";

/**
 * WHO COUNTS AS A MEDICAL REP, and who counts as inside a viewer's reach.
 *
 * Both rules are pure, both decide whether a person is SHOWN, and both fail silently when wrong —
 * a dropped rep produces no error, just a slightly shorter board. That is what these assertions are
 * for.
 */
export function runCrmMedicalRepTests() {
  // ── THE TITLE ARM ─────────────────────────────────────────────────────────────────────────────
  // Production carries exactly one rep spelling today — "Medical Representative", on 126 employees,
  // with no variants at all (measured 2026-09-03). The looser match is for the ones a future import
  // will invent.
  assert.equal(isMedicalRepJobTitle("Medical Representative"), true, "the one spelling production actually uses");
  assert.equal(isMedicalRepJobTitle("Medical Rep"), true, "and the short form");
  assert.equal(isMedicalRepJobTitle("  MEDICAL   representative "), true, "case and spacing are normalised");
  assert.equal(isMedicalRepJobTitle("Senior Medical Representative"), true, "a seniority prefix is still a rep");

  assert.equal(isMedicalRepJobTitle(null), false, "no title is no evidence");
  assert.equal(isMedicalRepJobTitle(""), false);
  assert.equal(isMedicalRepJobTitle("   "), false, "and neither is whitespace");
  assert.equal(isMedicalRepJobTitle("District Sales Manager"), false, "the 29 DSMs are not reps");
  assert.equal(isMedicalRepJobTitle("Product Manager"), false, "nor is head office");
  assert.equal(isMedicalRepJobTitle("National Sales Manager"), false);

  // No production title matches both patterns today. This is the guard for the day one does: the
  // exclusion is the SAFE direction, because a manager wrongly shown is a visible mistake somebody
  // reports, and a rep wrongly hidden is an invisible one nobody does.
  assert.equal(
    isMedicalRepJobTitle("Medical Representatives Manager"),
    false,
    "a manager word makes the title a manager's, whatever else it says",
  );

  // ── THE TWO ARMS, IN ORDER ────────────────────────────────────────────────────────────────────
  // The SEAT answers when there is one; the job title answers only when the organogram is silent.
  assert.equal(isMedicalRep({ placement: { hasRepSeat: true }, jobTitle: null }), true, "a rep seat needs no title");
  assert.equal(
    isMedicalRep({ placement: { hasRepSeat: false }, jobTitle: "Medical Representative" }),
    false,
    "THE DIRECTION THAT MATTERS: a seated manager stays out even when a stale HR row calls him a rep",
  );
  assert.equal(
    isMedicalRep({ placement: null, jobTitle: "Medical Representative" }),
    true,
    "an UNSEATED person the directory calls a rep is kept — 26 such people logged 1,412 visits in August",
  );
  assert.equal(
    isMedicalRep({ placement: null, jobTitle: "Product Manager" }),
    false,
    "while an unseated head-office title is not a rep",
  );
  assert.equal(
    isMedicalRep({ placement: null, jobTitle: null }),
    false,
    "and no seat plus no title is no evidence, which is not a rep",
  );

  // ── THE SCOPE CHECK ───────────────────────────────────────────────────────────────────────────
  const team: DoctorCoverageScope = {
    kind: "agents",
    basis: "team",
    agentHrIds: ["AI-0001", "b-12"],
    label: "District Manager · own team",
  };
  const company: DoctorCoverageScope = { kind: "company", basis: "company", label: "Super Admin · all lines" };
  const none: DoctorCoverageScope = { kind: "none", reason: "no team" };

  assert.equal(isAgentInScope(company, "anyone"), true, "company scope keeps everything");
  assert.equal(isAgentInScope(company, null), true, "including a row whose identity never resolved");
  assert.equal(isAgentInScope(none, "AI-0001"), false, "a `none` scope keeps nobody — every failure path fails CLOSED");

  assert.equal(isAgentInScope(team, "AI-0001"), true, "an id on the list is in reach");
  assert.equal(isAgentInScope(team, "AI-0002"), false, "and one that is not, is not");

  // MIXED CASE ON BOTH SIDES. One `.eq` against a single casing once hid 28% of reps' own orders,
  // and a row matching nobody reads as "not on your team" rather than as a bug.
  assert.equal(isAgentInScope(team, "ai-0001"), true, "the row's case does not matter");
  assert.equal(isAgentInScope(team, "  B-12  "), true, "nor does the stored case, nor surrounding space");

  // FAILS CLOSED on a missing id: it cannot be PROVEN to belong to this manager, and showing him
  // somebody else's rep is a silent confidentiality breach where hiding one is a gap that gets
  // reported the same day.
  assert.equal(isAgentInScope(team, null), false, "a row with no hr id is never assumed to be yours");
  assert.equal(isAgentInScope(team, ""), false);
  assert.equal(isAgentInScope(team, "   "), false, "and a blank id is not an id");
}
