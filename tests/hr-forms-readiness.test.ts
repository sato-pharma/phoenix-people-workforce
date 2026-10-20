import { strict as assert } from "node:assert";

import {
  JOB_TITLE_AR_SEEDS,
  QUALIFICATION_AR_SEEDS,
  arabicAnswersOutstanding,
  resolveJobTitleAr,
  resolveQualificationAr,
  unconfirmedSeeds,
} from "../src/lib/hiring-pack/arabic-lookups.ts";
import {
  READINESS_DOCUMENTS,
  buildReadinessRow,
  enrichForReadiness,
  extractCompanyBlockers,
  summarizeReadiness,
} from "../src/lib/hiring-pack/readiness.ts";
import type { ReadinessRow } from "../src/lib/hiring-pack/readiness.ts";
import {
  DEFAULT_NATIONALITY_AR,
  DEFAULT_NATIONALITY_AR_FEMALE,
} from "../src/lib/hiring-pack/nationality.ts";
import { splitTaxRegistration } from "../src/lib/hiring-pack/render-shared.ts";
import { collectHiringPackGaps } from "../src/lib/hiring-pack/service.ts";
import type {
  HiringPackEmployeeFacts,
  HiringPackGap,
  HiringPackProfile,
} from "../src/lib/hiring-pack/types.ts";

/**
 * THE READINESS BOARD — who can be printed, for everybody at once.
 *
 * The board exists because the module could always say what ONE person was missing and could never
 * say that most of the company was missing the same thing. In production, 90 of 108 active employees
 * were complete and every Form 1 was blocked by two empty company settings, and no screen said so.
 *
 * What is defended here, and why each one would otherwise go wrong quietly:
 *
 *   1. A company-level gap counted per person. Two missing values would read as 216 problems and
 *      bury the 18 real ones underneath. The board must report them ONCE and count the people they
 *      would unblock, because that number is the argument for fixing them.
 *   2. An unconfirmed Arabic translation reaching a contract. Every seed ships `confirmed: false`
 *      and must stay inert until the owner answers the question sheet — a plausible translation
 *      nobody approved is exactly what gets signed without being read.
 *   3. A derived value overwriting a typed one, or a disagreement being silently resolved. Both end
 *      with a wrong identity on a paper filed with the Social Insurance Authority.
 *   4. The summary not adding up. A board whose columns do not sum to the headcount is a board
 *      nobody can act on, and the failure is invisible unless something asserts the arithmetic.
 */

// Two valid IDs for 1997-09-09 in Dakahlia (digits 8-9 = "12"), differing in ONE character: digit
// 13, the Authority's sex digit — odd male, even female. One character apart is what keeps the
// gendering assertions about the sex digit and nothing else.
const FEMALE_NATIONAL_ID = "29709091234567";
const MALE_NATIONAL_ID = "29709091234577";

function employeeFixture(overrides: Partial<HiringPackEmployeeFacts> = {}): HiringPackEmployeeFacts {
  return {
    hrId: "H-3003",
    fullName: "Nour Adel",
    nameAr: "نور عادل",
    // 1997-09-09, Dakahlia — the same id the worker-data fixture uses, so the two agree.
    nationalId: "29709091234567",
    // Left unrecorded so the fixtures exercise the national-ID derivation rather than masking it.
    gender: null,
    socialInsuranceNumber: "123456789",
    socialInsuranceWage: 6000,
    baseSalary: 11000,
    grossSalary: 14300,
    birthDate: "1997-09-09",
    hireDate: "2026-08-01",
    jobTitle: "Medical Representative",
    departmentAr: "المبيعات",
    departmentId: 1,
    lineId: 1,
    residenceAddress: "5 شارع الجمهورية، وسط البلد",
    residenceCity: "القاهرة",
    mobileNumber: "01200000000",
    workEmail: "nour@example.com",
    employmentStatus: "active",
    lastWorkingDate: null,
    departed: false,
    ...overrides,
  };
}

function profileFixture(overrides: Partial<HiringPackProfile> = {}): HiringPackProfile {
  return {
    hrId: "H-3003",
    nationality: "مصرية",
    qualification: "بكالوريوس صيدلة",
    birthPlace: "القاهرة",
    jobTitleAr: "مندوب دعاية طبية",
    occupationCode: "123456",
    insuranceOffice: "وسط البلد",
    addressBuilding: "05",
    addressDistrict: "01",
    addressStreet: "شارع الجمهورية",
    addressMarkaz: "02",
    addressGovernorate: "01",
    contractDurationMonths: 12,
    contractStartDate: "2026-08-01",
    contractEndDate: "2027-07-31",
    underperformanceThresholdPct: 70,
    underperformanceMonths: 3,
    trainingBondMonths: 12,
    notes: null,
    contractSignedDate: null,
    form1SignedDate: null,
    contractPrintedAt: null,
    form1PrintedAt: null,
    contractTemplateVersion: null,
    // Blank, which is the ordinary contract: the company's standing signatory signs it. A
    // value here means somebody else did, and replaces him everywhere the paper names him.
    contractSignatoryNameAr: null,
    contractSignatoryTitleAr: null,
    contractObjectiveReasonCode: null,
    ndaSignedDate: null,
    ndaPrintedAt: null,
    updatedAt: null,
    ...overrides,
  };
}

const gapsFor = (employee: HiringPackEmployeeFacts, profile: HiringPackProfile): HiringPackGap[] =>
  collectHiringPackGaps(employee, profile);

function rowFor(
  employeeOverrides: Partial<HiringPackEmployeeFacts> = {},
  profileOverrides: Partial<HiringPackProfile> = {},
): ReadinessRow {
  return buildReadinessRow(
    employeeFixture(employeeOverrides),
    profileFixture(profileOverrides),
    gapsFor,
  );
}

function testACompletePersonIsPrintable(): void {
  const row = rowFor();

  for (const document of READINESS_DOCUMENTS) {
    assert.deepEqual(
      row.blockers[document].map((gap) => gap.field),
      [],
      `a complete person must have no blocking gaps of their own on the ${document}`,
    );
  }

  // THE CONTRACT NEVER DEPENDS ON A COMPANY SETTING. The three company-level values — establishment
  // number, sector code, tax registration — are all Form 1 and Form 6 questions. So a complete
  // person's contract is printable today whatever state the settings are in, and asserting that
  // unconditionally is safe in a way asserting Form 1 would not be.
  assert.equal(row.ready.contract, true, "a complete person's contract must be printable");
  assert.equal(
    row.readyExceptCompanySettings.contract,
    false,
    "the contract cannot be waiting on a company setting — none of them reach it",
  );

  // Form 1 is ready exactly when nothing of the person's AND nothing of the company's is outstanding.
  // Written as an equivalence so it keeps holding after the owner fills the two empty settings.
  const form1CompanyGaps = extractCompanyBlockers(gapsFor(employeeFixture(), profileFixture())).filter(
    (gap) => gap.documents.includes("form1"),
  );
  assert.equal(
    row.ready.form1,
    form1CompanyGaps.length === 0,
    "Form 1 is ready only when the company-level values are filled too",
  );
  assert.equal(
    row.readyExceptCompanySettings.form1,
    form1CompanyGaps.length > 0,
    "a complete person with outstanding company settings must be counted as unlocked by them",
  );
}

function testCompanyGapsAreReportedOnceNotPerPerson(): void {
  const rows = [rowFor(), rowFor({ hrId: "H-3004" }), rowFor({ hrId: "H-3005" })];

  // THE POINT OF THE BOARD. A company-level value is never a person's blocker, however many people
  // it stops — otherwise two missing settings read as six problems across three people.
  for (const row of rows) {
    for (const document of READINESS_DOCUMENTS) {
      const leaked = row.blockers[document].filter((gap) => gap.source === "company-settings");
      assert.deepEqual(
        leaked.map((gap) => gap.field),
        [],
        `a company-settings gap must never appear as ${row.hrId}'s own blocker`,
      );
    }
  }

  const companyBlockers = extractCompanyBlockers(gapsFor(employeeFixture(), profileFixture()));
  const summary = summarizeReadiness(rows, companyBlockers);

  // Listed once each, whatever the headcount.
  const fields = summary.companyBlockers.map((gap) => gap.field);
  assert.deepEqual(fields, [...new Set(fields)], "each company blocker must be listed exactly once");
  for (const gap of summary.companyBlockers) {
    assert.equal(gap.source, "company-settings", "only company-level values belong in this list");
    assert.equal(gap.blocking, true, "an advisory is not a blocker");
  }
}

function testTheSummaryAddsUp(): void {
  const rows = [
    rowFor(),
    rowFor({ hrId: "H-2", nameAr: null }),
    rowFor({ hrId: "H-3", baseSalary: null }),
    // An UNSEEDED job title with no Arabic typed: still blocked, because there is nothing to fall
    // back on and a guess is exactly what must not happen.
    rowFor({ hrId: "H-4", jobTitle: "Chief Astronaut" }, { jobTitleAr: null }),
    // A SEEDED one with no Arabic typed prints, because the owner confirmed that wording. This row
    // is the difference the answered question sheet makes, stated as a test rather than as a note.
    rowFor({ hrId: "H-5" }, { jobTitleAr: null }),
  ];
  const summary = summarizeReadiness(rows, []);

  assert.equal(summary.people, 5, "the summary must count every row it was given");
  for (const document of READINESS_DOCUMENTS) {
    assert.equal(
      summary.ready[document] + summary.unlockedByCompanySettings[document] + summary.blocked[document],
      summary.people,
      `every person must land in exactly one bucket for the ${document}`,
    );
  }

  // The three incomplete people must actually be counted as blocked on the contract — a summary that
  // adds up while calling everyone ready would satisfy the arithmetic above and be useless.
  assert.equal(
    summary.blocked.contract,
    3,
    "a missing Arabic name, a missing salary and an UNSEEDED job title each block the contract",
  );
  assert.equal(
    summary.ready.contract,
    2,
    "the complete person and the one whose Arabic title the owner confirmed both print",
  );
}

function testDerivationClosesTheGapsItFills(): void {
  // Nothing typed: no birth date on the record, no birthplace on the profile. Both are BLOCKING on
  // the contract, and both are sitting inside the national ID.
  const row = rowFor({ birthDate: null }, { birthPlace: null });

  assert.deepEqual(
    row.derived.slice().sort(),
    ["birthDate", "birthPlace"],
    "both values must be reported as derived rather than appearing from nowhere",
  );
  assert.deepEqual(
    row.blockers.contract.map((gap) => gap.field),
    [],
    "a derived birth date and birthplace must close their own gaps",
  );
  assert.equal(row.ready.contract, true, "deriving both must make the contract printable");

  // And the enrichment itself must not mutate what it was handed — the same facts feed the fill
  // screen, where a derived value masquerading as a stored one is the confusion being removed.
  const employee = employeeFixture({ birthDate: null });
  const profile = profileFixture({ birthPlace: null });
  const enriched = enrichForReadiness(employee, profile);
  assert.equal(employee.birthDate, null, "the input facts must not be mutated");
  assert.equal(profile.birthPlace, null, "the input profile must not be mutated");
  assert.equal(enriched.employee.birthDate, "1997-09-09", "the enriched copy carries the derived date");

  // An unreadable id derives nothing and the gaps stand — the person gets chased, which is correct.
  const noId = rowFor({ nationalId: null, birthDate: null }, { birthPlace: null });
  assert.deepEqual(noId.derived, [], "no id means nothing is derived");
  assert.equal(noId.ready.contract, false, "without an id those gaps must still block");
}

function testADisagreementIsShownAndNotResolved(): void {
  // The id reads 1997-09-09; the record says 1990-01-01. One is a typo and both reach a form.
  const row = rowFor({ birthDate: "1990-01-01" });

  assert.ok(row.idConflict, "a disagreement between the record and the id must be reported");
  assert.ok(row.idConflict?.includes("1990-01-01"), "the warning must name the stored date");
  assert.ok(row.idConflict?.includes("1997-09-09"), "the warning must name the id's own date");
  assert.deepEqual(row.derived, [], "a stored date is an answer — nothing was derived over it");

  // A warning is not a blocker: the paper still prints, because refusing to print would not tell
  // anybody which of the two dates is wrong.
  assert.equal(row.ready.contract, true, "a conflict warns, it does not block");

  const summary = summarizeReadiness([row, rowFor({ hrId: "H-9" })], []);
  assert.equal(summary.idConflicts, 1, "the board must count how many people need their card checked");
}

function testNoUnconfirmedArabicEverPrints(): void {
  // THE SAFETY PIN, written so it survives the owner confirming them. Each seed is checked against
  // its OWN flag rather than against the current all-unconfirmed state.
  for (const seed of JOB_TITLE_AR_SEEDS) {
    const resolved = resolveJobTitleAr(seed.en);
    if (seed.confirmed) {
      assert.equal(resolved, seed.ar, `a confirmed job title must resolve: ${seed.en}`);
    } else {
      assert.equal(resolved, null, `an unconfirmed job title must never resolve: ${seed.en}`);
    }
  }

  for (const seed of QUALIFICATION_AR_SEEDS) {
    const resolved = resolveQualificationAr(seed.en);
    if (seed.confirmed) {
      assert.equal(resolved, seed.ar, `a confirmed qualification must resolve: ${seed.en}`);
    } else {
      assert.equal(resolved, null, `an unconfirmed qualification must never resolve: ${seed.en}`);
    }
  }

  // Case folding: production holds `Science` and `science`, `Vet` and `veterinary`. All four must
  // reach the same seed, so the owner is asked once rather than four times.
  assert.equal(
    resolveQualificationAr("science"),
    resolveQualificationAr("Science"),
    "case must not create a second question",
  );
  assert.equal(
    resolveQualificationAr("veterinary"),
    resolveQualificationAr("Vet"),
    "a spelled-out alias must reach the same seed",
  );

  // A value that is ALREADY Arabic is the answer and needs no seed and no confirmation.
  assert.equal(
    resolveQualificationAr("ليسانس ألسن - جامعة عين شمس"),
    "ليسانس ألسن - جامعة عين شمس",
    "an Arabic qualification must pass through unchanged",
  );

  // While anything is unconfirmed, the board must be able to say how many QUESTIONS are open.
  const waiting = unconfirmedSeeds();
  assert.equal(
    arabicAnswersOutstanding(),
    waiting.jobTitles.length + waiting.qualifications.length,
    "the outstanding count must match the unconfirmed seeds",
  );

  // An unknown title has no seed at all — null, not a guess.
  assert.equal(resolveJobTitleAr("Chief Astronaut"), null, "an unseeded job title must resolve to null");
  assert.equal(resolveJobTitleAr(null), null, "a missing job title must resolve to null");
}

/**
 * THE DOUBLE-COUNT GUARD.
 *
 * The seed tables carry a headcount each, and summing them across both lists was the obvious way to
 * answer "how many people are waiting on the Arabic?". It is wrong: the job titles sum to the whole
 * payroll and the qualifications sum to most of it, so the total exceeds the headcount and anybody
 * missing BOTH values is counted twice. On a board printed beside "108 active employees" that reads
 * as a backlog nearly twice its real size. The count therefore comes from the ROWS, and this pins
 * that — one person missing both values must move the figure by exactly one.
 */
function testAPersonWaitingOnBothArabicValuesIsCountedOnce(): void {
  // UNSEEDED titles on purpose — a seeded one is filled in and is no longer waiting on anything.
  const missingBoth = rowFor(
    { hrId: "H-BOTH", jobTitle: "Chief Astronaut" },
    { jobTitleAr: null, qualification: null },
  );
  const missingOne = rowFor({ hrId: "H-ONE", jobTitle: "Chief Astronaut" }, { jobTitleAr: null });
  const complete = rowFor({ hrId: "H-OK" });

  // The fixture has to actually be missing both, or this test passes by describing nothing.
  const blockedFields = new Set(missingBoth.blockers.contract.map((gap) => gap.field));
  assert.ok(blockedFields.has("jobTitleAr"), "the fixture must be blocked on the Arabic job title");
  assert.ok(blockedFields.has("qualification"), "the fixture must be blocked on the qualification");

  assert.equal(
    summarizeReadiness([missingBoth], []).peopleWaitingOnArabicSeeds,
    1,
    "a person missing both Arabic values is one person, not two",
  );
  assert.equal(
    summarizeReadiness([missingBoth, missingOne, complete], []).peopleWaitingOnArabicSeeds,
    2,
    "only the people actually blocked on an Arabic value are counted",
  );
}

/**
 * THE ONES THE OWNER REWROTE HIMSELF.
 *
 * He did not accept the proposals for these: a District Sales Manager is contracted as
 * مدير دعاية طبية rather than the literal مدير مبيعات منطقة, and the HR management title as
 * مدير ادارة الموارد البشرية — his own, carried onto HR Manager when he was promoted on
 * 2026-10-09 and left on HR Section Head, the seat he is now recruiting for. And so on. Each of those looks, to anyone reading the file later,
 * like a translation that could be improved — which is exactly why they are pinned. The wording on
 * an employment contract is not a style question, and the person who would "fix" one of these is
 * not going to be the person who asked him.
 *
 * A DELIBERATE change still passes: update the line here in the same commit. What cannot happen is
 * the wording drifting without anybody noticing.
 */
function testTheOwnersOwnWordingIsNotTidiedAway(): void {
  const pinned: [string, string][] = [
    ["District Sales Manager", "مدير دعاية طبية"],
    ["National Sales Manager", "مدير مبيعات طبية"],
    ["Product Manager", "مدير تسويق"],
    ["Group Product Manager", "مدير تسويق"],
    ["HR Business Partner", "مشرف موارد بشرية"],
    ["HR Operations Coordinator", "اخصائي موارد بشرية"],
    // 2026-10-20: the holder of that title moved to the HR Operations Specialist seat and carries the
    // same Arabic he confirmed for her.
    ["HR Operations Specialist", "اخصائي موارد بشرية"],
    // His own title, 2026-10-09: "give HR Manager the Arabic مدير ادارة الموارد البشرية", after the
    // promotion moved `employees.job_title` for B-10 off HR Section Head. The old title keeps the
    // same wording while it is the seat he is recruiting for — the new holder's is his to give.
    ["HR Manager", "مدير ادارة الموارد البشرية"],
    ["HR Section Head", "مدير ادارة الموارد البشرية"],
    // Answered 2026-09-06. The proposal was أخصائي استقطاب المواهب, a literal rendering of "talent
    // acquisition"; he answered with the HR-specialist title he had already confirmed for
    // `HR Operations Coordinator`. Same shape as the seven above, and the literal translation is
    // exactly what a later editor would "correct" it back to.
    ["Talent Acquisition", "اخصائي موارد بشرية"],
  ];

  for (const [en, ar] of pinned) {
    assert.equal(resolveJobTitleAr(en), ar, `the owner's own wording for "${en}" must reach the contract`);
  }

  // Every seed was answered on 2026-09-03. The one question the 2026-10-20 rename opened — the
  // Arabic for "HR Generalist", the old seat's new title — he answered the same day: أخصائي موارد
  // بشرية. The list stays, empty, so the next unanswered seed is named here rather than slipped in.
  assert.equal(resolveJobTitleAr("HR Generalist"), "أخصائي موارد بشرية", "the owner's own wording for HR Generalist, 2026-10-20");
  const OPEN_SINCE_THE_RENAME: string[] = [];
  assert.equal(
    arabicAnswersOutstanding(),
    OPEN_SINCE_THE_RENAME.length,
    "every Arabic question the owner was asked has his answer",
  );
  for (const seed of JOB_TITLE_AR_SEEDS) {
    if (OPEN_SINCE_THE_RENAME.includes(seed.en)) {
      assert.equal(seed.confirmed, false, `"${seed.en}" is pinned as open — confirmed now? drop it from the list`);
      assert.equal(seed.people, 0, `"${seed.en}" may stay unconfirmed only while nobody holds the title`);
      assert.equal(resolveJobTitleAr(seed.en), null, `"${seed.en}" must not print an unconfirmed Arabic`);
      continue;
    }
    assert.equal(seed.confirmed, true, `"${seed.en}" must carry the owner's confirmation`);
  }
}

/**
 * A TAX NUMBER TYPED IN ARABIC-INDIC DIGITS MUST STILL REACH THE FORM.
 *
 * The owner supplied "٣١٨-١٠٨-٤٧٧", copied from the tax card. `splitTaxRegistration` groups on
 * `[^0-9]`, which does not consider ٣ a digit — so before this was fixed the whole string read as
 * one long separator, every group came back empty, and Form 1 printed three BLANK runs where the
 * tax registration belongs. No error, no warning: a government form filed without the number on it.
 */
function testATaxNumberInArabicDigitsStillReachesTheForm(): void {
  assert.deepEqual(
    splitTaxRegistration("٣١٨-١٠٨-٤٧٧"),
    ["318", "108", "477"],
    "Arabic-Indic digits must fold to the same three groups as ASCII",
  );
  assert.deepEqual(
    splitTaxRegistration("318-108-477"),
    ["318", "108", "477"],
    "the stored ASCII form must split the same way",
  );
  // Nine bare digits with no separators still split three-three-three.
  assert.deepEqual(
    splitTaxRegistration("318108477"),
    ["318", "108", "477"],
    "an unseparated number must still fill the three runs",
  );
  // And an empty setting stays empty rather than printing a stray zero.
  assert.deepEqual(splitTaxRegistration(""), ["", "", ""], "a blank setting must print nothing");
}

/**
 * THE DEFAULT MUST BE VISIBLE, AND MUST NEVER BECOME STORED DATA.
 *
 * Two failure modes, and they pull in opposite directions. Applied silently, a wrong nationality
 * reaches a signature with nothing on any screen to catch it. Applied to the stored profile, the
 * next save writes مصري onto 107 employee records as though a person had entered it, and the
 * assumption becomes indistinguishable from a fact. So it is reported as DERIVED and the enrichment
 * returns new objects — the save path keeps reading the profile it was handed.
 */
function testTheNationalityDefaultIsVisibleAndNeverStored() {
  const defaulted = rowFor({}, { nationality: null });

  for (const document of READINESS_DOCUMENTS) {
    assert.ok(
      !defaulted.blockers[document].some((gap) => gap.field === "nationality"),
      `a missing nationality must not block the ${document} — every paper prints the default`,
    );
  }

  assert.ok(
    defaulted.derived.includes("nationality"),
    "a defaulted nationality must be reported as derived, not applied silently",
  );
  assert.ok(
    !rowFor({}, { nationality: "سوداني" }).derived.includes("nationality"),
    "a recorded nationality is not a derived one, and must not be labelled as assumed",
  );

  // THE DEFAULT IS GENDERED, because Arabic inflects nationality: مصري for a man, مصرية for a
  // woman. These use assert.equal rather than a substring check on purpose — مصرية CONTAINS مصري,
  // so `includes(DEFAULT_NATIONALITY_AR)` is true of a woman's row and would certify the exact bug
  // this derivation fixes. Only an exact match tells the two forms apart.
  const enrichedNationality = (employee: Partial<HiringPackEmployeeFacts>) =>
    enrichForReadiness(employeeFixture(employee), profileFixture({ nationality: null })).profile
      .nationality;

  assert.equal(
    enrichedNationality({ nationalId: FEMALE_NATIONAL_ID, gender: null }),
    DEFAULT_NATIONALITY_AR_FEMALE,
    "a woman with no recorded nationality must be shown مصرية",
  );
  assert.equal(
    enrichedNationality({ nationalId: MALE_NATIONAL_ID, gender: null }),
    DEFAULT_NATIONALITY_AR,
    "a man with no recorded nationality must be shown مصري",
  );
  // A recorded gender outranks the ID — the ordering `national-id.ts` already keeps for birth date.
  assert.equal(
    enrichedNationality({ nationalId: FEMALE_NATIONAL_ID, gender: "male" }),
    DEFAULT_NATIONALITY_AR,
    "a stored gender must outrank the sex digit in the national ID",
  );
  // Neither source answers: fall back to the owner's stated default rather than guess or blank.
  assert.equal(
    enrichedNationality({ nationalId: null, gender: null }),
    DEFAULT_NATIONALITY_AR,
    "an unknowable sex must fall back to the masculine default, not to a blank",
  );

  // The enrichment must not write back. If it ever mutates, the default stops being a default.
  const stored = profileFixture({ nationality: null });
  enrichForReadiness(employeeFixture({ nationalId: FEMALE_NATIONAL_ID, gender: null }), stored);
  assert.equal(stored.nationality, null, "enrichment must not write the default onto the stored profile");
}

export function runHrFormsReadinessTests(): void {
  testACompletePersonIsPrintable();
  testCompanyGapsAreReportedOnceNotPerPerson();
  testTheSummaryAddsUp();
  testDerivationClosesTheGapsItFills();
  testADisagreementIsShownAndNotResolved();
  testNoUnconfirmedArabicEverPrints();
  testAPersonWaitingOnBothArabicValuesIsCountedOnce();
  testTheOwnersOwnWordingIsNotTidiedAway();
  testATaxNumberInArabicDigitsStillReachesTheForm();
  testTheNationalityDefaultIsVisibleAndNeverStored();
}
