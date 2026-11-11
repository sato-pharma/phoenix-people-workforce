import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

import { autoFillHiringPackFacts } from "../src/lib/hiring-pack/auto-fill.ts";
import { governorateArForPlace } from "../src/lib/hiring-pack/national-id.ts";
import { emptyProfile } from "../src/lib/hiring-pack/service.ts";
import type { HiringPackEmployeeFacts, HiringPackProfile } from "../src/lib/hiring-pack/types.ts";
import { stripComments } from "./support/comment-strip.ts";

/**
 * The hiring papers fill every blank the system can answer — and never touch an answer.
 *
 * Before this, every derivation here existed and none reached a paper (owner, 2026-11-11: "make
 * sure that hiring pack is pulling all data needed auto with minimum manual work"). Measured on
 * production that day: birthplace blank on the papers for 124 of 132 current staff, qualification
 * for 95, the Arabic job title for 22, Form 1's governorate for all 132.
 */

// 1997-09-09, Dakahlia (12), male serial digit.
const NATIONAL_ID = "29709091234577";

function employee(overrides: Partial<HiringPackEmployeeFacts> = {}): HiringPackEmployeeFacts {
  return {
    hrId: "H-7001",
    fullName: "Karim Nabil",
    nameAr: "كريم نبيل",
    nationalId: NATIONAL_ID,
    gender: "male",
    socialInsuranceNumber: null,
    socialInsuranceWage: null,
    baseSalary: 11000,
    grossSalary: 14300,
    birthDate: null,
    hireDate: "2026-11-15",
    jobTitle: "Medical Representative",
    departmentAr: "المبيعات",
    departmentId: 1,
    lineId: 1,
    residenceAddress: "5 شارع الجمهورية",
    residenceCity: "القاهره",
    mobileNumber: "01000000000",
    workEmail: null,
    employmentStatus: "active",
    departed: false,
    lastWorkingDate: null,
    recordBirthPlace: null,
    recordQualification: null,
    education: "Science",
    ...overrides,
  };
}

function profile(overrides: Partial<HiringPackProfile> = {}): HiringPackProfile {
  return { ...emptyProfile("H-7001"), ...overrides };
}

function testABlankRecordIsFilledFromWhatTheSystemKnows(): void {
  const filled = autoFillHiringPackFacts(employee(), profile());

  assert.equal(filled.employee.birthDate, "1997-09-09", "the birth date comes from the national ID");
  assert.equal(filled.profile.birthPlace, "الدقهلية", "the birthplace is the ID's governorate of birth");
  assert.equal(filled.profile.jobTitleAr, "مندوب دعاية طبية", "the owner's confirmed Arabic job title");
  assert.equal(filled.profile.qualification, "بكالوريوس علوم", "the qualification from the education on record");
  assert.equal(filled.profile.addressGovernorate, "القاهرة", "Form 1's governorate from the residence city, spelled properly");
  assert.deepEqual(
    filled.autoFilled.slice().sort(),
    ["addressGovernorate", "birthDate", "birthPlace", "jobTitleAr", "qualification"],
    "every value worked out is reported, so the screen can say where it came from",
  );
}

function testAStoredAnswerIsNeverReplaced(): void {
  const stored = profile({
    birthPlace: "المنصورة",
    jobTitleAr: "مندوب مبيعات",
    qualification: "بكالوريوس صيدلة",
    addressGovernorate: "الجيزة",
  });
  const record = employee({ birthDate: "1997-09-10" });
  const filled = autoFillHiringPackFacts(record, stored);

  assert.equal(filled.employee.birthDate, "1997-09-10", "a stored birth date stands even where the ID disagrees");
  assert.equal(filled.profile.birthPlace, "المنصورة");
  assert.equal(filled.profile.jobTitleAr, "مندوب مبيعات");
  assert.equal(filled.profile.qualification, "بكالوريوس صيدلة");
  assert.equal(filled.profile.addressGovernorate, "الجيزة");
  assert.deepEqual(filled.autoFilled, [], "nothing was worked out over an answer");

  // The paper's own answer outranks the Employee Master's copy too, not just the national ID.
  const withRecord = autoFillHiringPackFacts(employee({ recordBirthPlace: "القاهرة" }), stored);
  assert.equal(withRecord.profile.birthPlace, "المنصورة", "the hiring profile's birthplace beats the record's");
  assert.ok(!withRecord.autoFilled.includes("birthPlace"), "and is not reported as worked out");

  // Never mutated: the stored objects are what a Save compares against.
  const blank = profile();
  const blankEmployee = employee();
  autoFillHiringPackFacts(blankEmployee, blank);
  assert.equal(blank.birthPlace, null, "the stored profile is not mutated");
  assert.equal(blankEmployee.birthDate, null, "the stored employee is not mutated");
}

function testTheEmployeeMastersOwnCopiesComeFirst(): void {
  // HR typed a precise birthplace on the Employee Master; it outranks the ID's bare governorate.
  const filled = autoFillHiringPackFacts(
    employee({ recordBirthPlace: "قنا - مركز نجع حمادي", recordQualification: "بكالوريوس طب بيطري" }),
    profile(),
  );
  assert.equal(filled.profile.birthPlace, "قنا - مركز نجع حمادي");
  assert.equal(filled.profile.qualification, "بكالوريوس طب بيطري", "an Arabic qualification on the record is used as written");

  // An English "Bachelor" has no confirmed Arabic, so the education answers instead.
  const bachelor = autoFillHiringPackFacts(employee({ recordQualification: "Bachelor", education: "Vet" }), profile());
  assert.equal(bachelor.profile.qualification, "بكالوريوس طب بيطري");
}

function testWhatCannotBeKnownStaysBlank(): void {
  const filled = autoFillHiringPackFacts(
    employee({
      nationalId: null,
      jobTitle: "Space Pilot",
      education: "Basic education stage",
      residenceCity: null,
      residenceAddress: "Nasr City, Cairo",
    }),
    profile(),
  );
  assert.equal(filled.employee.birthDate, null, "no ID, no birth date");
  assert.equal(filled.profile.birthPlace, null, "no ID and no record, no birthplace");
  assert.equal(filled.profile.jobTitleAr, null, "a title the owner never answered is not guessed");
  assert.equal(filled.profile.qualification, null, "an education with no confirmed Arabic is not guessed");
  assert.equal(
    filled.profile.addressGovernorate,
    null,
    "the governorate is read from the city box only — never guessed from a free-text address",
  );
  assert.deepEqual(filled.autoFilled, []);

  assert.equal(governorateArForPlace("El-Minia"), "المنيا", "English spellings of a governorate are recognised");
  assert.equal(governorateArForPlace("الاسكندريه"), "الإسكندرية");
  assert.equal(governorateArForPlace("Atlantis"), null);
}

function testThePapersAndTheBoardsUseIt(): void {
  // The defect this fixes was a derivation nothing called. Pin the three callers by their call.
  const service = stripComments(readFileSync("src/lib/hiring-pack/service.ts", "utf8"));
  assert.ok(
    /autoFillHiringPackFacts\(storedEmployee, storedProfile\)/.test(service),
    "getHiringPack — what every paper prints from — must fill the blanks before it returns",
  );
  for (const file of ["src/lib/hiring-pack/field-fill-rate.ts", "src/lib/hiring-pack/readiness.ts"]) {
    assert.ok(
      /autoFillHiringPackFacts\(/.test(stripComments(readFileSync(file, "utf8"))),
      `${file} must count what the paper prints, through the same auto-fill`,
    );
  }
}

export function runHiringPackAutoFillTests(): void {
  testABlankRecordIsFilledFromWhatTheSystemKnows();
  testAStoredAnswerIsNeverReplaced();
  testTheEmployeeMastersOwnCopiesComeFirst();
  testWhatCannotBeKnownStaysBlank();
  testThePapersAndTheBoardsUseIt();
}
