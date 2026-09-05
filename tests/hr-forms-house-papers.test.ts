import { strict as assert } from "node:assert";

import { systemContractDefaults } from "../src/config/system-settings.ts";
import { currentContractTemplate } from "../src/lib/hiring-pack/contract-text.ts";
import {
  HR_PAPER_BLANK_RULE,
  hrPaperTemplateStrings,
  hrPaperTemplateTokens,
} from "../src/lib/hiring-pack/hr-paper-template.ts";
import type { HrPaperTemplate } from "../src/lib/hiring-pack/hr-paper-template.ts";
import {
  HR_PAPERS,
  HR_PAPER_ABSENCE_WARNING_V1,
  HR_PAPER_DEEMED_RESIGNATION_V1,
  HR_PAPER_DOCUMENTS_RECEIPT_V1,
  HR_PAPER_DOCUMENTS_RETURN_V1,
  HR_PAPER_NDA_V1,
  HR_PAPER_SOCIAL_STATUS_V1,
  hrPaperById,
} from "../src/lib/hiring-pack/hr-paper-text.ts";
import {
  buildHrPaperValues,
  renderHrPaperHtml,
} from "../src/lib/hiring-pack/render-hr-paper.ts";
import { PRINT_BANNER_CSS } from "../src/lib/hiring-pack/render-shared.ts";
import {
  collectHiringPackGaps,
  emptyOffboardingProfile,
  resolveContractTerms,
} from "../src/lib/hiring-pack/service.ts";
import { currentTemplateVersion } from "../src/lib/hiring-pack/template-registry.ts";
import {
  HIRING_PACK_DOCUMENTS,
  HOUSE_PAPER_DOCUMENTS,
  SIGNABLE_DOCUMENTS,
  isSignableDocument,
} from "../src/lib/hiring-pack/types.ts";
import type {
  HiringPackData,
  HiringPackEmployeeFacts,
  HiringPackProfile,
  OffboardingProfile,
} from "../src/lib/hiring-pack/types.ts";

/**
 * SATO'S SIX OWN HR PAPERS.
 *
 * The owner supplied them on 2026-09-05 as Word files and asked for them in the house identity and
 * in the system. Four corrections were made to his drafts; two of them are legal and both would
 * otherwise print a paper that reads perfectly and is wrong, so both are pinned here.
 *
 *   🔴 THE ABSENCE THRESHOLD. Article 166 deems a worker resigned after MORE THAN ten consecutive
 *      days; his notices acted at ten. A notice served on day ten is premature and the deemed
 *      resignation it declares can be set aside. `testTheAbsenceThresholdIsMoreThanTenDays` is the
 *      guard, and it checks the CONTRACT still says the same thing, so a contract redraft that
 *      changed the number would turn this red rather than leave the two disagreeing.
 *
 *   🔴 THE SECOND NOTICE WAS «إخطار بقبول إستقالة». Under 166 there is no resignation to accept.
 *      Article 167 — a real resignation, signed by the worker and approved by the labour office — is
 *      a different instrument, and مادة (12) of our contract describes THAT one. A paper claiming to
 *      accept a resignation nobody wrote invites the argument that none exists.
 *
 * The rest of this file is the same shape as `hr-forms-renewal.test.ts`: what must be filled, what
 * must stay blank, and that the emitted artifact — never the source — carries the house identity.
 */

// ---------------------------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------------------------

function employeeFixture(
  overrides: Partial<HiringPackEmployeeFacts> = {},
): HiringPackEmployeeFacts {
  return {
    hrId: "H-3003",
    fullName: "Nour Adel",
    nameAr: "نور عادل",
    nationalId: "29709091234567",
    gender: "female",
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
    contractSignatoryNameAr: null,
    contractSignatoryTitleAr: null,
    contractObjectiveReasonCode: null,
    ndaSignedDate: null,
    ndaPrintedAt: null,
    updatedAt: null,
    ...overrides,
  };
}

function packFixture(
  employeeOverrides: Partial<HiringPackEmployeeFacts> = {},
  profileOverrides: Partial<HiringPackProfile> = {},
): HiringPackData {
  const employee = employeeFixture(employeeOverrides);
  const profile = profileFixture(profileOverrides);
  const offboarding: OffboardingProfile = emptyOffboardingProfile("H-3003");
  return {
    employee,
    profile,
    offboarding,
    exit: null,
    renewal: null,
    suggestedJobTitleAr: null,
    gaps: collectHiringPackGaps(employee, profile, offboarding, null),
    terms: resolveContractTerms(employee, profile, offboarding, null),
  };
}

function copyCount(html: string): number {
  return html.split('<article class="copy').length - 1;
}

/** Everything a paper prints, as one string — prose, grids and all. */
function textOf(template: HrPaperTemplate): string {
  return hrPaperTemplateStrings(template).join("\n");
}

// ---------------------------------------------------------------------------------------------
// 🔴 The two legal corrections
// ---------------------------------------------------------------------------------------------

function testTheAbsenceThresholdIsMoreThanTenDays(): void {
  const warning = textOf(HR_PAPER_ABSENCE_WARNING_V1);
  const notice = textOf(HR_PAPER_DEEMED_RESIGNATION_V1);

  // The first warning threatens the consequence; the notice declares it. Both must be phrased as
  // EXCEEDING ten days, never as reaching it.
  assert.ok(
    warning.includes("تجاوز عشرة أيام متصلة"),
    "the first warning must warn about EXCEEDING ten consecutive days. Article 166 says «أكثر من " +
      "عشرة أيام متتالية», so at exactly ten the deemed resignation has not arisen and a notice " +
      "issued then is premature.",
  );
  assert.ok(
    notice.includes("تجاوزت عشرة أيام متصلة") && notice.includes("أكثر من عشرة أيام متصلة"),
    "the deemed-resignation notice must both recite that the absence EXCEEDED ten consecutive days " +
      "and rest its operative paragraph on the same threshold",
  );

  // And neither may state the bare "10 consecutive days" the owner's drafts did.
  for (const [name, text] of [["warning", warning], ["notice", notice]] as const) {
    assert.ok(
      !/(?:لمدة|عن)\s+عشرة\s+أيام\s+متصلة/u.test(text),
      `${name}: "for ten consecutive days" is the pre-correction wording — the threshold is more than ten`,
    );
  }

  // THE CONTRACT MUST STILL AGREE. If a redraft changed مادة (8), these papers would be citing a
  // clause that no longer says what they say — the same drift the renewal cross-reference test
  // exists to catch, on a paper that ends somebody's service.
  const article8 = currentContractTemplate().articles[7];
  assert.equal(article8?.number, "مادة (8)");
  assert.ok(
    article8.body.includes("أكثر من عشرة أيام متصلة"),
    "مادة (8) of the contract must still set the same threshold these notices cite. If the contract " +
      "changed, re-resolve the notices against it — do not just update this test.",
  );
}

function testTheSecondNoticeDeclaresRatherThanAcceptsAResignation(): void {
  const notice = HR_PAPER_DEEMED_RESIGNATION_V1;
  assert.ok(
    notice.titleAr.includes("باعتبار العامل مستقيل"),
    "the notice DECLARES a deemed resignation under Article 166",
  );
  const text = textOf(notice);
  assert.ok(
    !text.includes("قبول إستقالة") && !text.includes("قبول استقالة"),
    "it must never speak of ACCEPTING a resignation. The worker wrote none; accepting one that does " +
      "not exist is what lets the whole notice be set aside, and a real resignation is Article 167 " +
      "with the labour office's approval — a different instrument entirely.",
  );
  assert.ok(
    text.includes("المادة (166)"),
    "and it must cite the article it actually rests on",
  );
  assert.ok(
    text.includes("لا يُعد هذا الإخطار فصلًا تأديبيًا"),
    "it is not a disciplinary dismissal, and saying so is what keeps it a deemed resignation",
  );
}

// ---------------------------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------------------------

function testAllSixAreRegisteredAndCurrent(): void {
  assert.equal(HR_PAPERS.length, 6, "six papers were supplied and six are registered");

  for (const document of HOUSE_PAPER_DOCUMENTS) {
    assert.ok(
      HIRING_PACK_DOCUMENTS.includes(document),
      `${document} must be in HIRING_PACK_DOCUMENTS or nothing can print it`,
    );
    if (document === "nda") continue;
    assert.ok(
      !SIGNABLE_DOCUMENTS.includes(document),
      `${document} records no signature against the person — see the note in SIGNABLE_DOCUMENTS`,
    );
  }

  // THE NDA IS THE EXCEPTION AND MUST STAY ONE. It is signed once in a career, like the contract,
  // and got its own column on 2026-09-05. Asserted positively rather than left out of the loop, so
  // that losing the register would go red instead of quietly rejoining the other five.
  assert.ok(
    SIGNABLE_DOCUMENTS.includes("nda"),
    "the confidentiality undertaking records its signature against the person — it is signed once " +
      "in a career, unlike the five house papers around it",
  );
  assert.equal(isSignableDocument("nda"), true);

  const pairs: ReadonlyArray<readonly [string, HrPaperTemplate]> = [
    ["nda", HR_PAPER_NDA_V1],
    ["appointmentDocsReceipt", HR_PAPER_DOCUMENTS_RECEIPT_V1],
    ["socialStatusSheet", HR_PAPER_SOCIAL_STATUS_V1],
    ["absenceWarning", HR_PAPER_ABSENCE_WARNING_V1],
    ["deemedResignation", HR_PAPER_DEEMED_RESIGNATION_V1],
    ["appointmentDocsReturn", HR_PAPER_DOCUMENTS_RETURN_V1],
  ];
  for (const [document, template] of pairs) {
    const version = currentTemplateVersion(document as (typeof HOUSE_PAPER_DOCUMENTS)[number]);
    assert.equal(
      version.id,
      template.id,
      `the registry's current ${document} must be the text that exists`,
    );
    assert.equal(hrPaperById(template.id)?.id, template.id);
  }
  assert.equal(hrPaperById("contract-v4"), null, "a contract id is not a house paper");
}

function testEveryPaperHasUniqueIdAndKnownTokens(): void {
  const ids = HR_PAPERS.map((paper) => paper.id);
  assert.equal(new Set(ids).size, ids.length, "two papers sharing an id makes one unreachable");

  const known = new Set<string>([
    "ISSUE_DATE",
    "ISSUE_DAY_NAME",
    "COMPANY_NAME",
    "COMPANY_LEGAL_FORM",
    "COMPANY_HEAD_OFFICE_FULL",
    "COMPANY_CITY",
    "COMMERCIAL_REGISTER",
    "COMMERCIAL_REGISTER_OFFICE",
    "UNIFIED_REGISTER",
    "TAX_CARD",
    "COMPANY_INSURANCE_NUMBER",
    "COMPANY_INSURANCE_OFFICE",
    "CONTRACT_SIGNATORY",
    "CONTRACT_SIGNATORY_TITLE",
    "EMPLOYEE_NAME",
    "HR_ID",
    "NATIONAL_ID",
    "INSURANCE_NUMBER",
    "JOB_TITLE",
    "DEPARTMENT",
    "ADDRESS",
    "PHONE",
    "EMAIL",
    "NATIONALITY",
    "RELIGION",
    "GENDER",
    "BIRTH_DATE",
    "BIRTH_PLACE",
    "MILITARY_STATUS",
    "MARITAL_STATUS",
    "QUALIFICATION",
    "HIRE_DATE",
    "CONTRACT_DATE",
    "LAST_WORKING_DATE",
    "ABSENCE_FROM",
    "ABSENCE_TO",
    "FIRST_WARNING_FROM",
    "FIRST_WARNING_TO",
    "COMPLETION_DEADLINE",
  ]);
  for (const paper of HR_PAPERS) {
    for (const token of hrPaperTemplateTokens(paper)) {
      assert.ok(
        known.has(token),
        `"${paper.id}" uses {{${token}}}, which is not an HrPaperToken — it would print literally`,
      );
    }
  }
}

// ---------------------------------------------------------------------------------------------
// What is filled and what must stay blank
// ---------------------------------------------------------------------------------------------

function testTheCompanyIsNoLongerABlank(): void {
  // The owner's warnings read «بشركة ........................ الكائن مقرها في ...............» on
  // papers this company issues about its own staff.
  for (const paper of [HR_PAPER_ABSENCE_WARNING_V1, HR_PAPER_DEEMED_RESIGNATION_V1]) {
    const html = renderHrPaperHtml(packFixture(), 1, paper);
    assert.ok(
      html.includes("ساتو فارما"),
      `${paper.id}: the company must be named from settings, not left for a pen`,
    );
    assert.ok(
      html.includes("82894"),
      `${paper.id}: and its commercial register, so the recital matches the contract's`,
    );
  }
}

function testTheDatesThatCouldEndAServiceStayBlank(): void {
  for (const paper of [HR_PAPER_ABSENCE_WARNING_V1, HR_PAPER_DEEMED_RESIGNATION_V1]) {
    const values = buildHrPaperValues(packFixture());
    for (const token of ["ABSENCE_FROM", "ABSENCE_TO"] as const) {
      const value = values[token];
      assert.ok(
        value === undefined || value === "",
        `${paper.id}: ${token} must never be filled. Attendance is not resolved here, and a wrong ` +
          "date on a notice that leads to loss of service cannot be walked back.",
      );
    }
    const html = renderHrPaperHtml(packFixture(), 1, paper);
    assert.ok(
      html.includes('data-hp-key="ABSENCE_FROM"'),
      `${paper.id}: the blank still carries its key so the fill screen can complete it`,
    );
  }
}

function testTheChecklistBoxesAreAlwaysEmpty(): void {
  const html = renderHrPaperHtml(packFixture(), 1, HR_PAPER_DOCUMENTS_RECEIPT_V1);
  const boxes = html.match(/<td class="doc-list__box"><\/td>/g) ?? [];
  assert.equal(
    boxes.length,
    HR_PAPER_DOCUMENTS_RECEIPT_V1.checklist!.rows.length *
      HR_PAPER_DOCUMENTS_RECEIPT_V1.checklist!.columnsAr.length,
    "every verdict box prints empty — there is no register of which certificates were handed over, " +
      "and a ticked box on a signed form asserts that a document was seen",
  );
}

function testTheChecklistIsNumberedWithoutAGap(): void {
  const rows = HR_PAPER_DOCUMENTS_RECEIPT_V1.checklist!.rows;
  assert.deepEqual(
    rows.map((row) => row.number),
    Array.from({ length: rows.length }, (unused, index) => String(index + 1)),
    "the serial runs 1..N with no gap. The owner's original skipped eleven, and a missing number on " +
      "a form somebody signs invites the question of what used to be on that line.",
  );
}

function testTheServiceSheetLeavesUnknownFactsBlank(): void {
  const values = buildHrPaperValues(packFixture());
  for (const token of ["RELIGION", "MILITARY_STATUS", "MARITAL_STATUS"] as const) {
    const value = values[token];
    assert.ok(
      value === undefined || value === "",
      `${token} must stay blank: this system holds no record of it, and the sheet is signed by the ` +
        "employee as true — a value nobody asked him is the one thing that must never be on it",
    );
  }
  // What IS known is filled, or the sheet would be a blank form with a letterhead.
  assert.equal(values.GENDER, "أنثى", "gender is derived for the sheet, from employees.gender");
  assert.equal(values.NATIONAL_ID, "29709091234567");
  assert.equal(values.JOB_TITLE, "مندوب دعاية طبية");
}

function testTheJobTitleIsArabicOnly(): void {
  const html = renderHrPaperHtml(packFixture({}, { jobTitleAr: null }), 1, HR_PAPER_NDA_V1);
  assert.ok(
    !html.includes("Medical Representative"),
    "no fallback to the English job title on an Arabic instrument — owner, 2026-08-31",
  );
}

// ---------------------------------------------------------------------------------------------
// The emitted artifact
// ---------------------------------------------------------------------------------------------

function testEveryPaperRendersOnTheHouseIdentity(): void {
  for (const paper of HR_PAPERS) {
    const html = renderHrPaperHtml(packFixture(), 1, paper);
    assert.ok(!html.includes("{{"), `${paper.id}: an unsubstituted token reached the page`);
    assert.ok(html.includes('<html lang="ar" dir="rtl">'), `${paper.id}: Arabic, right-to-left`);
    assert.ok(html.includes("نور عادل"), `${paper.id}: the Arabic name governs`);
    assert.ok(
      html.includes("border-bottom: 0.7mm solid #0A6BA6"),
      `${paper.id}: the brand rule is the one element on every house document`,
    );
    assert.ok(
      html.includes("/brand/sato-pharma-logo-on-light.svg"),
      `${paper.id}: always the on-light mark — the stock file's white SATO vanishes on paper`,
    );
    assert.ok(
      !html.replace(PRINT_BANNER_CSS, "").includes("border-radius"),
      `${paper.id}: the square-edge golden rule, measured on the document rather than on the ` +
        "shared on-screen banner",
    );
    assert.ok(html.includes(paper.titleAr), `${paper.id}: its own title is on the page`);
  }
}

function testCopyCountsAreEachPapersOwnRequirement(): void {
  const expected: ReadonlyArray<readonly [HrPaperTemplate, number]> = [
    [HR_PAPER_NDA_V1, systemContractDefaults.ndaCopies],
    [HR_PAPER_DOCUMENTS_RECEIPT_V1, systemContractDefaults.appointmentDocsReceiptCopies],
    [HR_PAPER_SOCIAL_STATUS_V1, systemContractDefaults.socialStatusSheetCopies],
    [HR_PAPER_ABSENCE_WARNING_V1, systemContractDefaults.absenceWarningCopies],
    [HR_PAPER_DEEMED_RESIGNATION_V1, systemContractDefaults.deemedResignationCopies],
    [HR_PAPER_DOCUMENTS_RETURN_V1, systemContractDefaults.appointmentDocsReturnCopies],
  ];
  for (const [paper, copies] of expected) {
    assert.equal(copyCount(renderHrPaperHtml(packFixture(), copies, paper)), copies);
  }
  assert.equal(
    systemContractDefaults.socialStatusSheetCopies,
    1,
    "the service-file sheet is filed and never handed over, so a second copy is one to shred",
  );
}

function testTheNdaNamesTheArticleItSupplements(): void {
  const text = textOf(HR_PAPER_NDA_V1);
  assert.ok(
    text.includes("لمادة (7)"),
    "the NDA supplements مادة (7) of the contract and now says so — the owner's draft called itself " +
      "a supplement without naming what it supplemented, leaving the relationship to be argued",
  );
  const article7 = currentContractTemplate().articles[6];
  assert.equal(article7?.number, "مادة (7)");
  assert.ok(
    article7.body.includes("السرية") || (article7.titleAr ?? "").includes("السرية"),
    "and مادة (7) must still be the confidentiality article. If the contract was renumbered, " +
      "re-resolve this reference by SUBJECT rather than updating the test.",
  );
}

function testAnAbsentValueStillPrintsARule(): void {
  const bare = packFixture({ nationalId: null, birthDate: null }, { birthPlace: null });
  const html = renderHrPaperHtml(bare, 1, HR_PAPER_SOCIAL_STATUS_V1);
  assert.ok(
    html.includes(HR_PAPER_BLANK_RULE),
    "an absent value prints a visible run of dots, never closing up silently",
  );
  assert.ok(!html.includes("{{"), "and no raw token survives");
}

export function runHrFormsHousePapersTests(): void {
  testTheAbsenceThresholdIsMoreThanTenDays();
  testTheSecondNoticeDeclaresRatherThanAcceptsAResignation();
  testAllSixAreRegisteredAndCurrent();
  testEveryPaperHasUniqueIdAndKnownTokens();
  testTheCompanyIsNoLongerABlank();
  testTheDatesThatCouldEndAServiceStayBlank();
  testTheChecklistBoxesAreAlwaysEmpty();
  testTheChecklistIsNumberedWithoutAGap();
  testTheServiceSheetLeavesUnknownFactsBlank();
  testTheJobTitleIsArabicOnly();
  testEveryPaperRendersOnTheHouseIdentity();
  testCopyCountsAreEachPapersOwnRequirement();
  testTheNdaNamesTheArticleItSupplements();
  testAnAbsentValueStillPrintsARule();
}
