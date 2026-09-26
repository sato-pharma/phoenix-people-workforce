import assert from "node:assert/strict";

import {
  buildSpecialtyMix,
  specialtyMixFromTallies,
  describeSpecialtyMix,
  type SpecialtyVisitRow,
} from "@/lib/business-review/specialty-mix";

/**
 * What a list is made of — the owner's "how many specialties per every rep list, per the district
 * manager list", 2026-09-26.
 *
 * The two ways this goes wrong, and why each case below exists:
 *
 *   1. SUMMING instead of unioning. A doctor visited by two reps in one district is ONE doctor in
 *      that district's list, and a doctor visited in July and again in August is ONE doctor in the
 *      window. Summing inflates every level above the rep and inflates the window over the month.
 *   2. GUESSING at an unknown value. The vendor adds `speciality` values without notice — that is
 *      exactly how "Contract" and "Health Insurance" came to be scored as doctors, costing a fifth
 *      of the doctor panel. Anything the taxonomy has not seen must be SURFACED, not folded.
 */

const row = (
  contactCrmId: number | null,
  speciality: string | null,
  visits = 1,
): SpecialtyVisitRow => ({ contactCrmId, speciality, visits });

export function runBusinessReviewSpecialtyMixTests() {
  // ------------------------------------------------------------------ 1. a union, never a sum
  {
    const mix = buildSpecialtyMix([
      row(101, "Pediatrics", 3), // July, rep A
      row(101, "Pediatrics", 2), // August, rep B — the SAME doctor
      row(102, "Pediatrics", 1),
    ]);
    assert.equal(mix.customersTotal, 2, "two distinct doctors, not three rows and not five visits");
    assert.equal(mix.byKind.sp, 2);
    assert.equal(mix.visitsTotal, 6, "but every visit counts — they are events, not people");
    assert.equal(mix.specialities[0].customers, 2);
    assert.equal(mix.specialities[0].visits, 6);
  }

  // ------------------------------------------------------------------ 2. the three kinds
  {
    const mix = buildSpecialtyMix([
      row(1, "Internal Medicine"),
      row(2, "Pediatrics"),
      row(3, "Pharmacy"),
      row(4, "Hospital"),
      row(5, "Health Insurance"),
    ]);
    assert.equal(mix.byKind.sp, 2, "a doctor's medical specialty");
    assert.equal(
      mix.byKind.hcp,
      3,
      "a pharmacy, a hospital and an account are all places or accounts — never doctors",
    );
    assert.equal(mix.byKind.unclassified, 0);
    assert.equal(
      mix.byKind.sp + mix.byKind.hcp + mix.byKind.unclassified,
      mix.customersTotal,
      "the three kinds must sum to the total, or the mix panel lies",
    );
  }

  // ------------------------------------------------------------------ 3. an unknown value is shown
  {
    const mix = buildSpecialtyMix([
      row(1, "Pediatrics"),
      row(2, "Something The Vendor Added Last Tuesday"),
      row(3, null),
    ]);
    assert.equal(
      mix.byKind.unclassified,
      2,
      "an unseen value and a blank one are both unclassified — guessing is what cost a fifth of the panel",
    );
    assert.equal(mix.byKind.sp, 1, "and neither is quietly counted as a doctor");

    const blank = mix.specialities.find((s) => s.speciality === "");
    assert.ok(blank, "the blank bucket exists rather than being dropped");
    assert.equal(blank.label, "No speciality recorded", "and it is named, not shown as an empty cell");

    assert.ok(
      mix.specialities.some((s) => s.speciality === "Something The Vendor Added Last Tuesday"),
      "the unknown value is surfaced verbatim, so somebody can decide what it is",
    );
  }

  // ------------------------------------------------------------------ 4. a visit with no contact
  {
    const mix = buildSpecialtyMix([row(1, "Pediatrics", 2), row(null, "Pediatrics", 5)]);
    assert.equal(mix.customersTotal, 1, "an unattributable row carries no customer");
    assert.equal(mix.visitsTotal, 7, "but its VISITS are real fieldwork and are not dropped");
  }

  // ------------------------------------------------------------------ 5. ranked, and stable
  {
    const mix = buildSpecialtyMix([
      row(1, "Pharmacy"),
      row(2, "Pharmacy"),
      row(3, "Pharmacy"),
      row(4, "ENT"),
      row(5, "Pediatrics"),
      row(6, "Pediatrics"),
    ]);
    assert.deepEqual(
      mix.specialities.map((s) => s.speciality),
      ["Pharmacy", "Pediatrics", "ENT"],
      "most customers first, and ties broken by name so the same data renders the same order twice",
    );
  }

  // ------------------------------------------------------------------ 5b. from TALLIES, the merge path
  //
  // A district does NOT carry every visit row of every rep — the overlays accumulate a contact-id
  // SET and a visit count per speciality as they merge. This is the constructor that turns those
  // back into the same shape, and the property that matters is the same one: the ids UNION.
  {
    const mix = specialtyMixFromTallies(
      new Map([
        // Rep A and rep B both called on doctor 101 this window. One doctor in their district.
        ["Pediatrics", new Set([101, 102])],
        ["Pharmacy", new Set([300])],
      ]),
      new Map([
        ["Pediatrics", 9],
        ["Pharmacy", 4],
      ]),
    );
    assert.equal(mix.customersTotal, 3, "three distinct contacts");
    assert.equal(mix.byKind.sp, 2);
    assert.equal(mix.byKind.hcp, 1);
    assert.equal(mix.visitsTotal, 13, "and the visits add, because they are events");

    // 🔴 THE MERGE PROPERTY. A contact recorded under two spellings is ONE customer in the total,
    // even though it is counted under each speciality — so the total is computed from the union of
    // the SETS, never by adding the per-speciality counts. Adding them would give 4 here.
    const twoSpellings = specialtyMixFromTallies(
      new Map([
        ["Pediatrics", new Set([1, 2])],
        ["pediatrics ", new Set([2, 3])],
      ]),
      new Map([["Pediatrics", 2], ["pediatrics ", 2]]),
    );
    assert.equal(
      twoSpellings.customersTotal,
      3,
      "contact 2 appears under both spellings and is ONE customer — summing the buckets would say 4",
    );
    assert.equal(
      twoSpellings.byKind.sp,
      3,
      "and the per-kind count is a union too, for the same reason",
    );
  }

  // ------------------------------------------------------------------ 6. nothing at all
  {
    const mix = buildSpecialtyMix([]);
    assert.equal(mix.customersTotal, 0);
    assert.deepEqual(mix.specialities, []);
    assert.equal(describeSpecialtyMix(mix), "No customers were visited in this window.");
  }

  // ------------------------------------------------------------------ 7. the headline states a share
  {
    const mix = buildSpecialtyMix([
      row(1, "Pediatrics"),
      row(2, "Pediatrics"),
      row(3, "Pediatrics"),
      row(4, "Pharmacy"),
      row(5, "Whatever This Is"),
    ]);
    const line = describeSpecialtyMix(mix);
    assert.match(line, /5 customers/);
    assert.match(line, /3 doctors \(60%\)/, "the share, so a reader can judge it");
    assert.match(line, /1 pharmacies, hospitals and accounts/);
    assert.match(line, /1 the vendor has not classified/, "and the unclassified are named when present");

    // No verdict. There is no right proportion — a rep on a pharmacy-heavy brick may be correct —
    // and a band here would be the page telling him his list is wrong on evidence it does not have.
    for (const verdict of ["too many", "too few", "poor", "healthy", "should"]) {
      assert.ok(!line.toLowerCase().includes(verdict), `the headline must not judge the mix ("${verdict}")`);
    }
  }
}
