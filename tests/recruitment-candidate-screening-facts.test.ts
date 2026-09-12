import assert from "node:assert/strict";

import { candidateRegionCodes } from "../src/lib/recruitment/candidate-region.ts";
import {
  candidateAgeInYears,
  candidateScreeningChecks,
  candidateScreeningFacts,
  candidateScreeningRoleFamily,
  formatYearsOfExperience,
  unconfirmedCvFactsFromExtraction,
} from "../src/lib/recruitment/candidate-screening-facts.ts";

export function runCandidateScreeningFactsTests() {
  // --- THE WHATSAPP ANSWERS REACH A SCREEN AT ALL. The owner reported that not all of the
  // --- questions he answers on WhatsApp showed up while screening, and he was right: the area was
  // --- resolved here and rendered by nobody, the background and the salary were stored and read by
  // --- nothing, and the experience band never even reached the Candidate type. Each of these is a
  // --- fact only the applicant can supply, so a null here is data loss, not a hedge.
  const answered = candidateScreeningFacts({
    declaredBackground: "Veterinary",
    declaredExperience: "1 - 3 years",
    declaredExpectedSalary: "25 k to 30 k",
    preferredAreaName: "Alexandria 2",
    preferredRegionCode: candidateRegionCodes[0],
  });
  assert.deepEqual(answered.background, { confirmed: true, value: "Veterinary" });
  assert.deepEqual(answered.declaredExperience, { confirmed: true, value: "1 - 3 years" });
  assert.deepEqual(answered.expectedSalary, { confirmed: true, value: "25 k to 30 k" });
  assert.deepEqual(answered.area, { confirmed: true, value: "Alexandria 2" });
  assert.equal(answered.region?.value.declared, true);

  // --- The salary a person TYPED outranks the parsed figure, always. The figure is lossy by
  // --- construction — "25 k to 30 k" has no single number in it — so printing one where the
  // --- applicant gave a range would show a precision nobody offered.
  const bothSalaries = candidateScreeningFacts({
    declaredExpectedSalary: "Negotiable",
    expectedSalary: 12000,
  });
  assert.deepEqual(bothSalaries.expectedSalary, { confirmed: true, value: "Negotiable" });

  // --- A figure typed into the ATS by hand, or stored before the verbatim column existed, still
  // --- shows — formatted, so "12000" does not read as a year.
  assert.deepEqual(candidateScreeningFacts({ expectedSalary: 12000 }).expectedSalary, {
    confirmed: true,
    value: "12,000",
  });

  // --- Nobody answered: three nulls, not three empty strings. A blank string would render an empty
  // --- cell under a heading, which reads as a broken screen rather than as "not asked".
  const silent = candidateScreeningFacts({ declaredBackground: "  ", declaredExperience: "" });
  assert.equal(silent.background, null);
  assert.equal(silent.declaredExperience, null);
  assert.equal(silent.expectedSalary, null);

  // --- A DECLARED region survives with no address at all. 20 candidates in production are in
  // --- exactly this state, and while the region rode as a hint on the "Lives in" cell — which is
  // --- only rendered when there IS a governorate — their answer had nowhere to appear.
  const noAddress = candidateScreeningFacts({ preferredRegionCode: candidateRegionCodes[0] });
  assert.equal(noAddress.governorate, null);
  assert.equal(noAddress.region?.value.declared, true, "the region they asked for must survive a missing address");

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

  // --- THE FOUR CHECKS A SCREENER MAKES, AND THE HOLES SAID OUT LOUD. Screening one vacant seat on
  // --- 2026-09-11 meant opening every CV to find the degree, the gender, the age and the military
  // --- status, because not one of them was printed anywhere. Printed now - and an unanswered one
  // --- has to READ as unanswered, because a blank cell looks like a rendering fault and a 0 looks
  // --- like an answer.
  type Check = ReturnType<typeof candidateScreeningChecks>[number];
  const byLabel = (candidate: Parameters<typeof candidateScreeningChecks>[0], now?: Date) => {
    const found = new Map<string, Check>();
    for (const check of candidateScreeningChecks(candidate, now)) found.set(check.label, check);
    return found;
  };

  const known = byLabel(
    {
      dateOfBirth: "1997-04-11",
      declaredBackground: "Pharmacy",
      gender: "male",
      militaryStatus: "exempted",
    },
    new Date(2026, 8, 12),
  );
  assert.equal(known.get("Degree rule")?.value, "Pharmacy", "the degree rule reuses the existing gate");
  assert.equal(known.get("Gender")?.value, "Male");
  assert.equal(known.get("Age")?.value, "29", "born April 1997, read on 12 September 2026");
  assert.equal(known.get("Age")?.hint, "1997-04-11", "the date sits under the age so it can be checked");
  assert.equal(known.get("Military service")?.value, "Exempted");

  // The headline assertion: an empty record still prints all four, and every one of them is null -
  // which the renderer turns into "not on file", never a blank and never a zero.
  const empty = candidateScreeningChecks({});
  assert.deepEqual(
    empty.map((check) => check.label),
    ["Degree rule", "Gender", "Age", "Military service"],
    "every check is printed even when nothing is known",
  );
  assert.deepEqual(
    empty.map((check) => check.value),
    [null, null, null, null],
    "nothing on file reads as nothing on file - never 0, never blank",
  );

  // A degree that is not one of the five is a VERDICT, not a hole, and it says which.
  const refused = byLabel({ declaredBackground: "Law" });
  assert.equal(refused.get("Degree rule")?.value, "Not one of the five eligible degrees");

  // The CV's faculty answers when the applicant never did - the same order judgeBackground uses.
  const fromCv = byLabel({ faculty: "Faculty of Veterinary Medicine" });
  assert.equal(fromCv.get("Degree rule")?.value, "Veterinary");

  // --- Age is parsed by hand rather than through `new Date`, so a birthday cannot land a day early
  // --- for a reader east of Greenwich, and a mis-parsed date is refused instead of printed.
  assert.equal(candidateAgeInYears("1997-04-11", new Date(2026, 3, 10)), 28, "the day before the birthday");
  assert.equal(candidateAgeInYears("1997-04-11", new Date(2026, 3, 11)), 29, "the birthday itself");
  assert.equal(candidateAgeInYears(null), null);
  assert.equal(candidateAgeInYears("not a date"), null);
  assert.equal(candidateAgeInYears("2025-01-01", new Date(2026, 8, 12)), null, "a one-year-old is a bad date");
}
