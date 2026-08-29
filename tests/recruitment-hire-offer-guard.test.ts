import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  assertOfferAcceptedForHire,
  compareHireTermsToOffer,
  describeHireTermMismatches,
  type HiredEmployeeTerms,
  type OfferTermsForHire,
} from "../src/lib/recruitment/hire-offer-guard.ts";

// The hire link between an approved offer and a real salary. Two rules with different
// strengths, and both are easy to weaken by accident:
//   * no accepted offer -> REFUSE, before anything is written
//   * terms differ      -> FLAG, never refuse
//
// The static half of this file matters as much as the behavioural half. The refusal is
// only worth anything if it runs BEFORE the update, and the terms comparison is only
// worth anything if the employee lookup actually finds the employee — HR ids are mixed
// case (178 of 179 in production), so an .eq would match nothing and every hire would
// silently report "no mismatches".

function read(relativePath: string): string {
  return readFileSync(path.join(process.cwd(), relativePath), "utf8");
}

function functionBody(source: string, signature: string): string {
  const start = source.indexOf(signature);
  assert.ok(start >= 0, `${signature} not found`);
  const rest = source.slice(start + signature.length);
  const nextExport = rest.indexOf("\nexport ");
  return nextExport >= 0 ? rest.slice(0, nextExport) : rest;
}

const acceptedOffer: OfferTermsForHire = {
  jobTitle: "Medical Rep",
  monthlyGross: 12000,
  startDate: "2026-09-01",
  response: "accepted",
};

const matchingEmployee: HiredEmployeeTerms = {
  jobTitle: "Medical Rep",
  grossSalary: 12000,
  hireDate: "2026-09-01",
};

export function runRecruitmentHireOfferGuardTests() {
  // ---------------------------------------------------------------------------
  // Rule 1 — refuse a hire with no accepted offer behind it.
  // ---------------------------------------------------------------------------

  assert.throws(
    () => assertOfferAcceptedForHire(null),
    /no offer has been prepared/,
    "a hire with no offer at all is refused",
  );

  for (const response of [null, "declined", "expired"]) {
    assert.throws(
      () => assertOfferAcceptedForHire({ ...acceptedOffer, response }),
      /has not been accepted/,
      `a hire is refused when the offer response is ${response ?? "unrecorded"}`,
    );
  }

  assert.doesNotThrow(
    () => assertOfferAcceptedForHire(acceptedOffer),
    "an accepted offer passes the gate",
  );

  // The message has to tell a tired recruiter what to do, not just say no.
  try {
    assertOfferAcceptedForHire(null);
    assert.fail("expected a refusal");
  } catch (error) {
    assert.match(
      error instanceof Error ? error.message : String(error),
      /Prepare the offer/,
      "the refusal explains the way forward",
    );
  }

  // ---------------------------------------------------------------------------
  // Rule 2 — flag differing terms, never refuse them.
  // ---------------------------------------------------------------------------

  assert.deepEqual(
    compareHireTermsToOffer(acceptedOffer, matchingEmployee),
    [],
    "an employee matching the approved offer produces no flags",
  );
  assert.equal(describeHireTermMismatches([]), null, "no mismatches summarises to nothing");

  // Salary — the one that costs money.
  const salaryFlags = compareHireTermsToOffer(acceptedOffer, { ...matchingEmployee, grossSalary: 15000 });
  assert.equal(salaryFlags.length, 1, "a different salary is flagged");
  assert.equal(salaryFlags[0].field, "monthlyGross");
  assert.equal(salaryFlags[0].offered, 12000);
  assert.equal(salaryFlags[0].hired, 15000);
  assert.match(salaryFlags[0].detail, /12000/, "the flag names the approved figure");
  assert.match(salaryFlags[0].detail, /15000/, "the flag names the figure actually paid");

  // Storage noise is not a renegotiation; a piastre either way is.
  assert.deepEqual(
    compareHireTermsToOffer(acceptedOffer, { ...matchingEmployee, grossSalary: 12000.005 }),
    [],
    "sub-piastre difference is storage noise, not a mismatch",
  );
  assert.equal(
    compareHireTermsToOffer(acceptedOffer, { ...matchingEmployee, grossSalary: 12000.02 }).length,
    1,
    "a difference above the epsilon is flagged",
  );

  // A missing salary must flag, not pass. This is the fail-open shape that would
  // otherwise let an employee with no gross recorded look like a clean match.
  const noSalary = compareHireTermsToOffer(acceptedOffer, { ...matchingEmployee, grossSalary: null });
  assert.equal(noSalary.length, 1, "an employee with no gross salary is flagged, never passed");
  assert.equal(noSalary[0].hired, null);
  assert.match(noSalary[0].detail, /no gross salary recorded/);

  // Job title — compared on meaning, not on typing.
  assert.deepEqual(
    compareHireTermsToOffer(acceptedOffer, { ...matchingEmployee, jobTitle: "  medical   REP " }),
    [],
    "case and whitespace differences in the title are not mismatches",
  );
  const titleFlags = compareHireTermsToOffer(acceptedOffer, { ...matchingEmployee, jobTitle: "District Manager" });
  assert.equal(titleFlags.length, 1, "a genuinely different title is flagged");
  assert.equal(titleFlags[0].field, "jobTitle");

  // Start date — the employee column is a date, the offer's can arrive as a timestamp.
  assert.deepEqual(
    compareHireTermsToOffer(acceptedOffer, { ...matchingEmployee, hireDate: "2026-09-01T00:00:00.000Z" }),
    [],
    "a timestamp and a date for the same day are not a mismatch",
  );
  const dateFlags = compareHireTermsToOffer(acceptedOffer, { ...matchingEmployee, hireDate: "2026-10-01" });
  assert.equal(dateFlags.length, 1, "a different start date is flagged");
  assert.equal(dateFlags[0].field, "startDate");

  // Terms the offer never stated cannot be violated.
  assert.deepEqual(
    compareHireTermsToOffer(
      { jobTitle: null, monthlyGross: null, startDate: null, response: "accepted" },
      { jobTitle: "Anything", grossSalary: 99999, hireDate: "2030-01-01" },
    ),
    [],
    "an offer that approved no terms flags nothing",
  );

  // Every term wrong at once still reports every term, not just the first.
  const allWrong = compareHireTermsToOffer(acceptedOffer, {
    jobTitle: "District Manager",
    grossSalary: 30000,
    hireDate: "2027-01-01",
  });
  assert.equal(allWrong.length, 3, "all three differing terms are reported together");
  assert.ok(describeHireTermMismatches(allWrong)?.includes("30000"), "the summary carries the figures");

  // An unresolvable employee is REPORTED, never treated as a clean match.
  const missing = compareHireTermsToOffer(acceptedOffer, null);
  assert.equal(missing.length, 1, "an unresolved employee is reported");
  assert.equal(missing[0].field, "employeeRecord");
  assert.match(missing[0].detail, /checked against nothing/);

  // ---------------------------------------------------------------------------
  // Wiring — the rules above are worthless if the caller runs them in the wrong
  // order or looks the employee up in a way that never matches.
  // ---------------------------------------------------------------------------

  const applications = read("src/lib/recruitment/applications.ts");
  const markHired = functionBody(applications, "export async function markApplicationHired");

  const refusalAt = markHired.indexOf("assertOfferAcceptedForHire");
  const updateAt = markHired.indexOf('.from("ats_applications")');
  assert.ok(refusalAt >= 0, "markApplicationHired must call assertOfferAcceptedForHire");
  assert.ok(updateAt >= 0, "markApplicationHired must still update ats_applications");
  assert.ok(
    refusalAt < updateAt,
    "the accepted-offer refusal must run BEFORE the stage is written, or a refused hire still mutates the row",
  );

  assert.ok(
    markHired.indexOf("compareHireTermsToOffer") < updateAt,
    "the terms comparison must be computed before the write, so the audit event can carry it",
  );
  assert.match(markHired, /termMismatches/, "the mismatches must reach the caller");

  // The mixed-case HR id trap: .eq matches nothing for 178 of 179 real employees, and
  // the comparison would then report a clean match for every hire.
  const lookup = functionBody(applications, "async function loadHiredEmployeeTerms");
  assert.match(lookup, /\.ilike\(\s*"hr_id"/, "the employee lookup must be case-insensitive on hr_id");
  assert.doesNotMatch(
    lookup,
    /\.eq\(\s*"hr_id"/,
    "a plain .eq on hr_id silently matches nothing here — mixed case is the norm",
  );

  // The guard's own module must not quietly gain a throw on the flagging path.
  const guard = read("src/lib/recruitment/hire-offer-guard.ts");
  const compare = functionBody(guard, "export function compareHireTermsToOffer");
  assert.doesNotMatch(
    compare,
    /throw /,
    "comparing terms must never throw — the system flags a difference, it does not reject the hire",
  );
}
