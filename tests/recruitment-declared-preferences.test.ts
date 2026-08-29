import assert from "node:assert/strict";

import { candidateScreeningFacts } from "../src/lib/recruitment/candidate-screening-facts.ts";

/**
 * The WhatsApp apply flow asks three questions and writes the answers to `preferred_region_code`,
 * `preferred_region_name` and `preferred_area_name`. Until this change nothing read them back: the
 * Region column, the Region filter and the screening card all derived a region from the governorate
 * printed on the CV, so an applicant's own answer was stored and never shown.
 *
 * Every fixture below is a shape measured in production on 2026-08-29, not an invented one.
 */
export function runRecruitmentDeclaredPreferencesTests() {
  // --- THE HEADLINE. Three of the nine people who answered have NO governorate on their CV, so
  // --- `candidateRegionForGovernorate` had nothing to work with and the cell rendered blank —
  // --- while the row held an exact region AND an exact area they had tapped themselves.
  const noAddress = candidateScreeningFacts({
    governorate: null,
    preferredAreaName: "Haram - Faisal",
    preferredRegionCode: "GZ",
  });
  assert.ok(noAddress.region, "a tapped region must resolve with no governorate at all — this is the whole defect");
  assert.equal(noAddress.region!.value.code, "GZ");
  assert.equal(noAddress.region!.value.label, "Giza");
  assert.equal(noAddress.region!.value.declared, true);
  assert.equal(noAddress.region!.confirmed, true, "a person tapped it; nothing about it is hedged");
  assert.equal(noAddress.area?.value, "Haram - Faisal");

  // --- The applicant outranks the CV, and the two really do disagree: this shape is live, an
  // --- Alexandria address against a tapped Giza. A CV says where somebody LIVES; the question they
  // --- answered was where they want to WORK, and only one of those is the screener's question.
  const disagrees = candidateScreeningFacts({
    governorate: "Alexandria",
    preferredAreaName: "Haram - Faisal",
    preferredRegionCode: "GZ",
  });
  assert.equal(disagrees.region!.value.code, "GZ", "the applicant's own answer must beat the CV address");
  assert.equal(disagrees.governorate?.value, "Alexandria", "and the CV address must NOT be overwritten by it");

  // --- A TYPED region is free text from "My region is not listed", and in production it is a PLACE
  // --- rather than a region label. Both live values resolve through the same governorate map the
  // --- CV path uses, which is why they are put through it instead of being shown as unknown.
  for (const typed of ["Minya", "Minia Government ( Minia North )"]) {
    const facts = candidateScreeningFacts({ governorate: null, preferredRegionName: typed });
    assert.equal(facts.region?.value.code, "UE", `"${typed}" must recover Upper Egypt`);
    assert.equal(facts.region?.value.declared, true);
  }

  // --- A typed answer the map cannot place keeps their words and NO code. Guessing a region here
  // --- would file somebody under a region they explicitly said was not theirs; the null code sends
  // --- them to the filter's Unknown bucket instead, which is a true statement.
  const unplaceable = candidateScreeningFacts({ governorate: null, preferredRegionName: "Somewhere else entirely" });
  assert.equal(unplaceable.region?.value.code, null);
  assert.equal(unplaceable.region?.value.label, "Somewhere else entirely");
  assert.equal(unplaceable.region?.value.declared, true);

  // --- The stored code is TEXT, so it is validated rather than trusted. An unrecognised code would
  // --- otherwise index the label map to undefined and render an empty cell — indistinguishable on
  // --- screen from "never answered", which is the worst possible failure for this feature.
  const junkCode = candidateScreeningFacts({ governorate: "Sohag", preferredRegionCode: "ZZ" });
  assert.equal(junkCode.region?.value.code, "UE", "a junk code must fall back to the CV, not blank the cell");
  assert.equal(junkCode.region?.value.declared, false);
  assert.equal(junkCode.region?.value.label, "Upper Egypt");

  // --- AND THE REGRESSION HALF. 448 of 457 candidates never answered, so the old path is still the
  // --- one nearly every row takes and it must behave exactly as before — same code, same label,
  // --- and `declared` false so the tooltip cannot claim somebody chose it.
  const cvOnly = candidateScreeningFacts({ governorate: "Gharbia" });
  assert.equal(cvOnly.region?.value.code, "D1");
  assert.equal(cvOnly.region?.value.label, "Delta (1)");
  assert.equal(cvOnly.region?.value.declared, false);
  assert.equal(cvOnly.region?.confirmed, true);
  assert.equal(cvOnly.area, null, "no area exists for anyone who was never asked");

  // --- A hedged CV read stays hedged. The confirmed flag drives the italic/grey treatment, and a
  // --- derived region must never inherit the certainty a declared one carries.
  const hedged = candidateScreeningFacts({ cvUnconfirmed: { governorate: "Gharbia" }, governorate: null });
  assert.equal(hedged.region?.value.code, "D1");
  assert.equal(hedged.region?.confirmed, false, "a region read off the CV by the extractor is not settled");
  assert.equal(hedged.region?.value.declared, false);

  // --- Nothing anywhere stays nothing. The cell prints "Not on file" off this, so inventing a
  // --- region here would put a place on a row that has none.
  const empty = candidateScreeningFacts({});
  assert.equal(empty.region, null);
  assert.equal(empty.area, null);

  // --- Blank and whitespace are absences, not answers — the columns are nullable text and an
  // --- empty string reaching the label would render a region-shaped blank.
  const blank = candidateScreeningFacts({
    governorate: "Sohag",
    preferredAreaName: "   ",
    preferredRegionCode: "",
    preferredRegionName: "  ",
  });
  assert.equal(blank.region?.value.code, "UE", "empty answers must fall through to the CV");
  assert.equal(blank.region?.value.declared, false);
  assert.equal(blank.area, null);

  // --- An area with no region still shows. The flow can stop between question 2 and question 3,
  // --- and one live session is in exactly that state — dropping the area because the region came
  // --- from the CV would discard the more precise of the two facts.
  const areaOnly = candidateScreeningFacts({ governorate: "Sohag", preferredAreaName: "Sohag2" });
  assert.equal(areaOnly.area?.value, "Sohag2");
  assert.equal(areaOnly.region?.value.code, "UE");
}
