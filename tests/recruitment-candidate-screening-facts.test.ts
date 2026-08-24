import assert from "node:assert/strict";

import {
  candidateScreeningFacts,
  candidateScreeningRoleFamily,
  formatYearsOfExperience,
  unconfirmedCvFactsFromExtraction,
} from "../src/lib/recruitment/candidate-screening-facts.ts";

export function runCandidateScreeningFactsTests() {
  // --- THE SAFETY PROPERTY. A confirmed column always wins, so a CV read can never contradict what
  // --- a person typed or what intake already accepted. If this ever flips, a hedged guess starts
  // --- overwriting recorded fact on screen, which is the failure the "confirmed" flag exists to
  // --- prevent.
  const contested = candidateScreeningFacts({
    currentEmployer: "Sato Pharma",
    currentJobTitle: "District Manager",
    cvUnconfirmed: {
      currentEmployer: "Some Other Co",
      currentJobTitle: "Medical Rep",
      governorate: "Aswan",
      hasMedicalRepExperience: false,
      yearsExperience: 3,
    },
    governorate: "Alexandria",
    hasMedicalRepExperience: true,
    yearsExperience: 12,
  });
  assert.deepEqual(contested.roleTitle, { confirmed: true, value: "District Manager" });
  assert.deepEqual(contested.employer, { confirmed: true, value: "Sato Pharma" });
  assert.deepEqual(contested.years, { confirmed: true, value: 12 });
  assert.deepEqual(contested.pharmaRep, { confirmed: true, value: true });
  assert.deepEqual(contested.governorate, { confirmed: true, value: "Alexandria" });

  // --- The hedged read only ever fills a hole, and everything it fills is marked unconfirmed.
  const hedged = candidateScreeningFacts({
    cvUnconfirmed: {
      currentEmployer: "Asena pharma",
      currentJobTitle: "Sales supervisor (District manager)",
      governorate: "Alexandria",
      hasMedicalRepExperience: false,
      yearsExperience: 21,
    },
  });
  assert.equal(hedged.roleTitle?.confirmed, false);
  assert.equal(hedged.roleTitle?.value, "Sales supervisor (District manager)");
  assert.equal(hedged.years?.confirmed, false);
  assert.equal(hedged.employer?.value, "Asena pharma");

  // --- `false` is an ANSWER, not an absence. "Never worked as a medical rep" is exactly what a
  // --- screener of a pharma pool wants to know, and a plain falsy check throws it away — the same
  // --- trap the pool's experience filter already carries a comment about.
  assert.deepEqual(
    candidateScreeningFacts({ hasMedicalRepExperience: false }).pharmaRep,
    { confirmed: true, value: false },
    "a recorded 'no' is a finding and must survive as one",
  );
  assert.deepEqual(
    candidateScreeningFacts({ cvUnconfirmed: { hasMedicalRepExperience: false } }).pharmaRep,
    { confirmed: false, value: false },
    "a hedged 'no' is still an answer, just an unconfirmed one",
  );
  assert.equal(candidateScreeningFacts({}).pharmaRep, null, "no answer at all stays null");

  // --- Blank strings are not facts. A whitespace-only column must fall through to the CV rather
  // --- than render an empty cell that reads as a rendering fault.
  const blanked = candidateScreeningFacts({
    currentJobTitle: "   ",
    cvUnconfirmed: { currentJobTitle: "Medical Representative" },
  });
  assert.deepEqual(blanked.roleTitle, { confirmed: false, value: "Medical Representative" });

  // --- The years sanity cap. The CV reader derives this by counting work-history dates, and a
  // --- mis-parsed year read as a duration is the failure mode that prints "2001 yrs" on a row.
  assert.equal(candidateScreeningFacts({ yearsExperience: 2001 }).years, null);
  assert.equal(candidateScreeningFacts({ yearsExperience: -3 }).years, null);
  assert.equal(candidateScreeningFacts({ yearsExperience: Number.NaN }).years, null);
  assert.equal(candidateScreeningFacts({ yearsExperience: 60 })?.years?.value, 60);
  assert.equal(
    candidateScreeningFacts({ cvUnconfirmed: { yearsExperience: 2001 }, yearsExperience: null }).years,
    null,
    "the cap applies to the hedged read too, which is where the bad numbers come from",
  );

  // --- The region is the COMPANY's map, not geography's, and it inherits the confidence of the
  // --- governorate it was worked out from — a region shown in black off a guessed governorate
  // --- would launder a guess into a fact.
  const upper = candidateScreeningFacts({ governorate: "Sohag" });
  assert.equal(upper.region?.value.code, "UE");
  assert.equal(upper.region?.confirmed, true);
  const guessedPlace = candidateScreeningFacts({ cvUnconfirmed: { governorate: "Sohag" } });
  assert.equal(guessedPlace.region?.confirmed, false, "a region derived from a hedged governorate is hedged");
  assert.equal(candidateScreeningFacts({ governorate: "Atlantis" }).region, null);

  // --- THE ELIWA CASE. On 2026-08-24 a candidate sat on screen reading a District Manager role off
  // --- his email subject while the Role filter, which read `currentJobTitle` alone, could not find
  // --- him. The row and the filter must resolve the SAME family, so the fallback to the resolved
  // --- "Applying for" text — the thing already visible — is part of the contract, not a nicety.
  const noTitleOnFile = candidateScreeningFacts({});
  assert.equal(
    candidateScreeningRoleFamily(noTitleOnFile, "District Sales Manager, Alexandria"),
    "district_manager",
    "a candidate with no title column is still filed under what the row displays",
  );
  // --- and a title on file outranks the applied-for text, so the two cannot disagree in the other
  // --- direction either.
  assert.equal(
    candidateScreeningRoleFamily(
      candidateScreeningFacts({ currentJobTitle: "Medical Representative" }),
      "District Manager",
    ),
    "medical_rep",
  );
  assert.equal(candidateScreeningRoleFamily(noTitleOnFile, "   "), null, "nobody ever told us is not a family");

  // --- Formatting. A decimal year under 1 reads as nonsense in years, and a whole number must
  // --- never print as "8.0 yrs".
  assert.equal(formatYearsOfExperience(12), "12 yrs");
  assert.equal(formatYearsOfExperience(5.75), "5.8 yrs");
  assert.equal(formatYearsOfExperience(8), "8 yrs");
  assert.equal(formatYearsOfExperience(0.67), "8 mo");
  assert.equal(formatYearsOfExperience(0.02), "<1 mo");

  // --- LOW ONLY. A "high" value is already on the candidate's column, so reading it here would
  // --- print the same fact twice — once black as settled, once grey as a guess. All 250 stranded
  // --- values in production carry "low"; nothing here should ever pick up a "high" one.
  const fromExtraction = unconfirmedCvFactsFromExtraction({
    currentEmployer: { confidence: "low", value: "Asena pharma" },
    currentJobTitle: { confidence: "high", value: "Medical Representative" },
    governorate: { confidence: "low", value: "Alexandria" },
    hasMedicalRepExperience: { confidence: "low", value: false },
    yearsExperience: { confidence: "low", value: 21 },
  });
  assert.equal(fromExtraction.currentJobTitle, null, "a confident read belongs on the column, not in the hedged tier");
  assert.equal(fromExtraction.currentEmployer, "Asena pharma");
  assert.equal(fromExtraction.governorate, "Alexandria");
  assert.equal(fromExtraction.hasMedicalRepExperience, false);
  assert.equal(fromExtraction.yearsExperience, 21);

  // --- A missing, empty, or wrongly-typed extraction must yield nothing rather than throw: this
  // --- runs on every profile open, including candidates whose CV was never read.
  assert.deepEqual(unconfirmedCvFactsFromExtraction(null), {
    currentEmployer: null,
    currentJobTitle: null,
    governorate: null,
    hasMedicalRepExperience: null,
    yearsExperience: null,
  });
  const wrongTypes = unconfirmedCvFactsFromExtraction({
    hasMedicalRepExperience: { confidence: "low", value: "yes" },
    yearsExperience: { confidence: "low", value: "twelve" },
  });
  assert.equal(wrongTypes.hasMedicalRepExperience, null, "a string is not a boolean answer");
  assert.equal(wrongTypes.yearsExperience, null, "a string is not a number of years");
}
