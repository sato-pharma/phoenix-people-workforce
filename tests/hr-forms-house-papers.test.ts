import { strict as assert } from "node:assert";

import { COMPANY_DETAILS_DEFAULT } from "../src/lib/hiring-pack/company-details.ts";
import {
  HOUSE_BAND_HEIGHT_MM,
  HOUSE_BAND_WAVELENGTH_MM,
  HOUSE_COLORS,
  HOUSE_IDENTITY_CSS,
  houseEngineTurnedBand,
} from "../src/lib/hiring-pack/house-identity.ts";

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
  HR_PAPER_EXPERIENCE_CERTIFICATE_V1,
  HR_PAPER_NDA_V1,
  HR_PAPER_SOCIAL_STATUS_V1,
  hrPaperById,
} from "../src/lib/hiring-pack/hr-paper-text.ts";
import {
  buildHrPaperValues,
  renderHrPaperHtml,
} from "../src/lib/hiring-pack/render-hr-paper.ts";
import {
  describeServiceDuration,
  describeServiceDurationEn,
  PRINT_BANNER_CSS,
  todayInCairo,
} from "../src/lib/hiring-pack/render-shared.ts";
import {
  renderClearanceCompanyHtml,
  renderClearanceEmployeeHtml,
} from "../src/lib/hiring-pack/render-clearance.ts";
import {
  renderCustodyLaptopHtml,
  renderCustodyMobileHtml,
} from "../src/lib/hiring-pack/render-custody.ts";
import { renderWorkerFormHtml } from "../src/lib/hiring-pack/render-worker-form.ts";
import {
  renderContractNonRenewalHtml,
  renderContractRenewalHtml,
} from "../src/lib/hiring-pack/render-renewal.ts";
import { renderContractHtml } from "../src/lib/hiring-pack/render-contract.ts";
import {
  buildExperienceCertificateEnValues,
  renderExperienceCertificateEnHtml,
} from "../src/lib/hiring-pack/experience-certificate-en.ts";
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
    // Null: no device chosen. A custody receipt printed without one carries ruled blanks
    // through its technical block, which is what these fixtures are about.
    custodyDevice: null,
    renewal: null,
    company: COMPANY_DETAILS_DEFAULT,
    suggestedJobTitleAr: null,
    gaps: collectHiringPackGaps(employee, profile, offboarding, null),
    terms: resolveContractTerms(employee, profile, offboarding, null),
  };
}

function copyCount(html: string): number {
  return html.split('<article class="copy').length - 1;
}

/**
 * The printed certificate, with the on-screen banner and the stylesheet cut away.
 *
 * The banner is `.no-print` guidance for whoever is printing and it NAMES the three things the
 * certificate leaves out, so a sweep of the whole page for "salary" finds the warning about salary
 * and reports the document as breaching its own rule. What a reader receives is the article.
 */
function certificateOnly(html: string): string {
  const start = html.indexOf('<article class="cert">');
  const end = html.lastIndexOf("</article>");
  assert.ok(start >= 0 && end > start, "the certificate page must contain a certificate");
  return html.slice(start, end);
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

function testEveryPaperIsRegisteredAndCurrent(): void {
  // SIX supplied by the owner on 2026-09-05, plus the certificate of experience drawn on
  // 2026-09-06. Hard-coded on purpose, like the count in the registry test: adding a paper to this
  // module touches nine files, and a number somebody has to change is what makes that a decision
  // rather than an omission.
  assert.equal(HR_PAPERS.length, 7, "six papers were supplied, and the certificate makes seven");

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
    ["experienceCertificate", HR_PAPER_EXPERIENCE_CERTIFICATE_V1],
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
    "SERVICE_END",
    "SERVICE_STATUS",
    "SERVICE_DURATION",
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

// ---------------------------------------------------------------------------------------------
// 🔴 The certificate of experience
// ---------------------------------------------------------------------------------------------

/**
 * THE ONE ERROR ON THIS PAPER THAT COSTS SOMEBODY A JOB: describing a serving employee as having
 * left, or a leaver as still employed.
 *
 * The certificate is issued to both — a leaver takes it to his next employer, and a man at his desk
 * takes one to an embassy — and it says the opposite thing in each case. The three tokens that carry
 * that are resolved from `employee.departed`, and this pins all three in BOTH states, plus the case
 * that reads either way if it is got wrong: a leaver whose last working date nobody ever recorded.
 * An absent date means "unrecorded", never "still here".
 */
function testTheCertificateStatesServiceBothWays(): void {
  const leaver = packFixture({
    hireDate: "2023-03-01",
    departed: true,
    lastWorkingDate: "2026-08-31",
  });
  const serving = packFixture({ hireDate: "2023-03-01", departed: false, lastWorkingDate: null });

  const leaverValues = buildHrPaperValues(leaver);
  assert.ok(
    leaverValues.SERVICE_END?.includes("31 / 08 / 2026"),
    "a leaver's period closes on his last working day",
  );
  assert.ok(
    leaverValues.SERVICE_STATUS?.includes("انتهت خدمته"),
    "a leaver is stated to have ended service",
  );
  // 1 Mar 2023 to 31 Aug 2026 is three years and six months, because the last working day is a day
  // WORKED. Five months and thirty days would read as the company shaving the end of his service.
  assert.equal(leaverValues.SERVICE_DURATION, "3 سنوات و6 أشهر");

  const servingValues = buildHrPaperValues(serving);
  assert.equal(
    servingValues.SERVICE_END,
    "تاريخه",
    "a serving employee's period closes at the issue date in words, never on a dotted rule",
  );
  assert.ok(
    servingValues.SERVICE_STATUS?.includes("لا يزال على رأس العمل"),
    "a serving employee is stated to be still employed",
  );
  assert.ok(
    (servingValues.SERVICE_DURATION ?? "").length > 0,
    "a serving employee's span is counted to today",
  );

  const undated = buildHrPaperValues(
    packFixture({ hireDate: "2023-03-01", departed: true, lastWorkingDate: null }),
  );
  assert.ok(
    undated.SERVICE_STATUS?.includes("انتهت خدمته"),
    "a leaver whose date nobody recorded is still a leaver — the flag decides, not the date",
  );
  assert.equal(undated.SERVICE_END, "", "and his period end rules rather than defaulting to today");
  assert.equal(undated.SERVICE_DURATION, "", "and his span rules rather than being counted to today");
}

/**
 * WHAT THE CERTIFICATE DELIBERATELY DOES NOT SAY — asserted on the EMITTED PAGE, never on the
 * template, because that is the artifact a future employer reads.
 *
 * Each of the three is an omission somebody decided on, not an unfinished half, so each is pinned:
 * a later session adding a salary line or «حسن السير والسلوك» to make the paper look more like the
 * Egyptian house style turns this red rather than shipping a testimonial the company never made.
 */
function testTheCertificateOmitsPaySeparationAndConduct(): void {
  const html = renderHrPaperHtml(
    packFixture({ departed: true, lastWorkingDate: "2026-08-31" }),
    1,
    HR_PAPER_EXPERIENCE_CERTIFICATE_V1,
  );

  for (const forbidden of ["11,000", "11000", "14,300", "الأجر", "راتب", "مرتب"]) {
    assert.ok(!html.includes(forbidden), `a certificate of experience states no pay — found "${forbidden}"`);
  }
  for (const forbidden of ["استقالة", "استقال", "فصل", "سبب"]) {
    assert.ok(
      !html.includes(forbidden),
      `a certificate of experience states no reason for leaving — found "${forbidden}"`,
    );
  }
  for (const forbidden of ["حسن السير", "السلوك", "تزكية"]) {
    assert.ok(
      !html.includes(forbidden),
      `this paper prints from a button for anybody, so it makes no testimonial — found "${forbidden}"`,
    );
  }

  // It is its own kind, which is what keeps it out of the pool an archived LETTER resolves within
  // and off the absence-date warning that belongs to the two notices.
  assert.ok(html.includes("copy--certificate"), "the certificate is not rendered as a letter");
  assert.ok(
    !html.includes("The absence dates print blank"),
    "the absence-date warning belongs to the notices, not here",
  );
  // ...and the notices KEPT it, now that the banner is keyed on the tokens rather than the kind.
  assert.ok(
    renderHrPaperHtml(packFixture(), 1, HR_PAPER_ABSENCE_WARNING_V1).includes(
      "The absence dates print blank",
    ),
    "the absence warning must keep its own warning",
  );

  // Nobody signs it back: it is addressed to a reader outside the company.
  assert.ok(!html.includes("العامل — المُقِر"), "the employee is the subject, not a party");
}

/**
 * The Arabic span, which counts in three bands either side of one, two and ten.
 *
 * Pinned separately from the certificate because getting the agreement wrong is invisible to anyone
 * reading the code — «3 سنة» is grammatical nonsense that renders perfectly.
 */
function testTheServiceSpanCountsInArabic(): void {
  const cases: ReadonlyArray<readonly [string, string, string]> = [
    ["2023-03-01", "2026-08-31", "3 سنوات و6 أشهر"],
    ["2023-03-15", "2026-08-31", "3 سنوات و5 أشهر و17 يومًا"],
    ["2025-01-01", "2025-12-31", "سنة واحدة"],
    ["2024-01-01", "2025-12-31", "سنتان"],
    ["2026-02-01", "2026-02-28", "شهر واحد"],
    ["2026-01-01", "2026-02-28", "شهران"],
    ["2026-01-10", "2026-01-10", "يوم واحد"],
    ["2026-01-10", "2026-01-11", "يومان"],
    ["2026-01-10", "2026-01-14", "5 أيام"],
    ["2026-01-01", "2026-01-15", "15 يومًا"],
    ["2014-06-01", "2026-08-31", "12 سنة و3 أشهر"],
  ];
  for (const [from, to, expected] of cases) {
    assert.equal(describeServiceDuration(from, to), expected, `${from} → ${to}`);
  }
  assert.equal(describeServiceDuration("2023-03-01", null), "", "a missing end rules");
  assert.equal(
    describeServiceDuration("2026-03-01", "2023-03-01"),
    "",
    "a reversed period rules rather than printing a negative span",
  );
}

// ---------------------------------------------------------------------------------------------
// 🔴 The certificate of experience — ENGLISH
// ---------------------------------------------------------------------------------------------

/**
 * THE TWO CERTIFICATES MUST NEVER DISAGREE ABOUT ONE EMPLOYMENT.
 *
 * They are printed minutes apart for the same person, who carries both to the same embassy. A pair
 * that states two different lengths of service is worse than either being wrong alone, because the
 * reader can see that the company does not know. `service-period.ts` is the single resolver behind
 * both, and this is what stops somebody re-deriving the period in one of them.
 */
function testBothCertificatesStateTheSamePeriod(): void {
  const today = todayInCairo();

  // A LEAVER. Both close the period on the same day and state the same length, each in its own
  // language and its own date format.
  const leaver = packFixture({
    hireDate: "2023-03-01",
    departed: true,
    lastWorkingDate: "2026-08-31",
  });
  const leaverAr = buildHrPaperValues(leaver);
  const leaverEn = buildExperienceCertificateEnValues(leaver);
  assert.ok(leaverAr.SERVICE_END?.includes("31 / 08 / 2026"));
  assert.equal(leaverEn.serviceEnd, "31 August 2026", "the same day, spelled out for a foreign reader");
  assert.equal(leaverAr.SERVICE_DURATION, "3 سنوات و6 أشهر");
  assert.equal(leaverEn.serviceDuration, "3 years and 6 months", "and the same length of service");

  // STILL SERVING. Both close at the issue date — in words, never on a rule — and both count to it,
  // so the two spans are the same span even though neither is a fixed string.
  const serving = packFixture({ hireDate: "2023-03-01", departed: false, lastWorkingDate: null });
  const servingAr = buildHrPaperValues(serving);
  const servingEn = buildExperienceCertificateEnValues(serving);
  assert.equal(servingAr.SERVICE_END, "تاريخه");
  assert.equal(servingEn.serviceEnd, "the date of this certificate");
  assert.equal(
    servingAr.SERVICE_DURATION,
    describeServiceDuration("2023-03-01", today),
    "the Arabic span is counted to today, not to an absent last working day",
  );
  assert.equal(
    servingEn.serviceDuration,
    describeServiceDurationEn("2023-03-01", today),
    "and the English span is counted to the same day",
  );
  assert.ok(servingEn.serviceDuration.length > 0, "a serving employee's span is stated, not ruled");

  // 🔴 A LEAVER NOBODY DATED. Both must still read as departed, and BOTH must decline to state a
  // span rather than one of them quietly counting to today — which is the divergence that would let
  // an employee carry two certificates giving two different lengths of service.
  const undated = packFixture({ hireDate: "2023-03-01", departed: true, lastWorkingDate: null });
  const undatedAr = buildHrPaperValues(undated);
  const undatedEn = buildExperienceCertificateEnValues(undated);
  assert.ok(undatedAr.SERVICE_STATUS?.includes("انتهت خدمته"));
  assert.equal(undatedEn.departed, true);
  assert.equal(undatedAr.SERVICE_DURATION, "", "the Arabic certificate rules the span");
  assert.equal(undatedEn.countable, false, "and the English one declines to state one too");
  assert.equal(undatedEn.serviceDuration, "");

}

/**
 * The English page: what it says, how it says it, and the three things it does not.
 *
 * Asserted on the emitted HTML rather than the values, for the reason every paper in this module is:
 * the artifact is what a stranger in another country reads.
 */
function testTheEnglishCertificateReadsCorrectly(): void {
  const leaver = packFixture({
    hireDate: "2023-03-01",
    departed: true,
    lastWorkingDate: "2026-08-31",
  });
  const page = renderExperienceCertificateEnHtml(leaver, 1);
  // THE BANNER IS NOT THE DOCUMENT. It is `.no-print` guidance for whoever is printing, and it names
  // the three omissions precisely in order to warn about them — so sweeping the whole page for the
  // word "salary" finds the warning and reports the certificate as breaching its own rule. Every
  // content assertion below reads the certificate only.
  const html = certificateOnly(page);

  assert.ok(page.includes('<html lang="en" dir="ltr">'), "the English certificate lays out LTR");
  assert.ok(!/\{\{[A-Z_]+\}\}/.test(html), "no unsubstituted token reaches the page");
  assert.ok(html.includes("To whom it may concern"), "it opens as a letter to a third party");
  assert.ok(html.includes("Certificate of Experience"), "and carries its English title");
  assert.ok(html.includes("شهادة خبرة"), "with the Arabic name under it, per the house identity");

  // THE MONTH IS SPELLED OUT. "08 / 09 / 2026" is two different days either side of the Atlantic,
  // and this is the copy read by somebody who does not know which convention we use.
  assert.ok(html.includes("01 March 2023"), "the start date names its month");
  assert.ok(html.includes("31 August 2026"), "and so does the last working day");
  assert.ok(!html.includes("31 / 08 / 2026"), "the Arabic paper's numeric format does not leak in");

  assert.ok(html.includes("3 years and 6 months"), "the span is stated in English");
  assert.ok(
    html.includes("no longer in the employment of the company"),
    "a leaver is stated to have left",
  );

  // The same three omissions as the Arabic paper, and they matter more here rather than less.
  for (const forbidden of ["11,000", "11000", "14,300", "Salary", "salary", "Basic"]) {
    assert.ok(!html.includes(forbidden), `the English certificate states no pay — found "${forbidden}"`);
  }
  for (const forbidden of ["resigned", "resignation", "dismissed", "terminated", "reason for"]) {
    assert.ok(
      !html.includes(forbidden),
      `the English certificate states no reason for leaving — found "${forbidden}"`,
    );
  }
  for (const forbidden of ["conduct", "satisfactor", "recommend", "diligent", "good standing"]) {
    assert.ok(
      !html.includes(forbidden),
      `this paper prints from a button for anybody, so it makes no testimonial — found "${forbidden}"`,
    );
  }

  // Nobody signs it back: it is addressed to a reader outside the company.
  assert.ok(html.includes("Human Resources"), "the company signs it");
  assert.ok(html.includes("Company stamp"), "and stamps it");
  assert.ok(!html.includes("Employee signature"), "the employee is the subject, not a party");

  const serving = certificateOnly(
    renderExperienceCertificateEnHtml(
      packFixture({ hireDate: "2023-03-01", departed: false, lastWorkingDate: null }),
      1,
    ),
  );
  assert.ok(
    serving.includes("remains in the employment of the company"),
    "a serving employee is stated to be still employed",
  );
  assert.ok(
    serving.includes("the date of this certificate"),
    "and his period closes at the issue date in words, never on a rule",
  );
}

/**
 * The honorific and the pronoun come from ONE value, so they cannot contradict each other.
 *
 * "Ms. Nour Adel … he held the position" is the kind of error a reader notices before they read
 * anything else on the page, and it is exactly what two independent lookups produce.
 */
function testTheEnglishCertificateAgreesWithItself(): void {
  const female = certificateOnly(renderExperienceCertificateEnHtml(packFixture({ gender: "female" }), 1));
  assert.ok(female.includes("Ms."), "a recorded gender is used");
  assert.ok(female.includes("she held the position"), "and the pronoun follows it");
  // A WORD BOUNDARY, because "she held" CONTAINS "he held" — a plain substring check here fails on
  // the correct output and would have been "fixed" by deleting the assertion.
  // WRITTEN WITH AN EXPLICIT CHARACTER CLASS, never a backslash escape. This line was first
  // authored through a heredoc, which ate the backslash and left the BACKSPACE byte it stood for:
  // the regex then matched nothing, the negated assertion passed for every input, and it pinned
  // nothing at all. tests/heredoc-backslash-damage.test.ts caught it in the required validate job.
  assert.ok(
    !/(^|[^s])he held the position/.test(female),
    "never the other pronoun on the same page as Ms.",
  );

  const male = certificateOnly(renderExperienceCertificateEnHtml(packFixture({ gender: "male" }), 1));
  assert.ok(male.includes("Mr.") && male.includes("he held the position"));

  // Nobody recorded one. "Mr./Ms." and "they" is a form, not a guess about a real person.
  const unknown = certificateOnly(renderExperienceCertificateEnHtml(packFixture({ gender: null }), 1));
  assert.ok(unknown.includes("Mr./Ms."), "an unrecorded gender is not guessed");
  assert.ok(unknown.includes("they held the position"), "and the pronoun does not guess either");
}

/** The English span, which counts the last working day as a day worked, exactly as the Arabic does. */
function testTheEnglishSpanCountsTheLastDay(): void {
  const cases: ReadonlyArray<readonly [string, string, string]> = [
    ["2023-03-01", "2026-08-31", "3 years and 6 months"],
    ["2025-01-01", "2025-12-31", "1 year"],
    ["2024-01-01", "2025-12-31", "2 years"],
    ["2026-02-01", "2026-02-28", "1 month"],
    ["2026-01-10", "2026-01-10", "1 day"],
    ["2026-01-10", "2026-01-14", "5 days"],
    ["2023-03-15", "2026-08-31", "3 years, 5 months and 17 days"],
  ];
  for (const [from, to, expected] of cases) {
    assert.equal(describeServiceDurationEn(from, to), expected, `${from} → ${to}`);
  }
  assert.equal(describeServiceDurationEn("2023-03-01", null), "", "a missing end rules");
  assert.equal(describeServiceDurationEn("2026-03-01", "2023-03-01"), "", "so does a reversed one");
}

/**
 * 🔴 THE CANVA CONSTRAINTS, pinned so a later session cannot tidy them away.
 *
 * The owner asked (2026-09-06) for a PDF that stays editable when imported into a design tool. Three
 * properties of THIS page are what make that work, and every one of them looks like a style choice
 * somebody could "improve":
 *
 *   · NO TABLE in the certificate. Every cell border becomes its own vector rectangle on import and
 *     every cell its own text box, so the Arabic paper's seven-row identity grid would arrive as
 *     roughly forty elements. The facts belong in the sentence here, which is how an English
 *     certificate of experience is written anyway.
 *   · ONE ARTICLE PER COPY, so one copy is one page and one page is one artboard.
 *   · REAL TEXT — no `<img>` carrying content, and nothing that would rasterise. The mark is the one
 *     image on the page and it is identity, not content.
 *
 * Verified beyond this on the real PDF, which needs Chromium and so is not run here: single A4 page,
 * three embedded fonts, and 818 characters of English recovered by `pdfjs` — the same extraction an
 * importer performs. The two ARABIC lines (the company's Arabic name and the Arabic title) come back
 * as reversed presentation forms, which is PDF text extraction and not something CSS can fix; they
 * are two identity elements a Canva user deletes, and the English body is unaffected.
 */
function testTheEnglishCertificateStaysImportable(): void {
  const html = certificateOnly(
    renderExperienceCertificateEnHtml(packFixture({ departed: true, lastWorkingDate: "2026-08-31" }), 1),
  );

  assert.ok(
    !/<table/i.test(html),
    "the English certificate must not use a table — every cell border becomes its own element when " +
      "the PDF is imported into a design tool, which is what this page is shaped to survive",
  );
  assert.ok(!/<img/i.test(html.split("</header>")[1] ?? ""), "no image below the letterhead carries content");

  const page = renderExperienceCertificateEnHtml(
    packFixture({ departed: true, lastWorkingDate: "2026-08-31" }),
    3,
  );
  assert.equal(
    page.split('<article class="cert">').length - 1,
    3,
    "one article per copy, so one copy is one page and one page is one artboard",
  );
}


/**
 * EVERY HOUSE COLOUR SURVIVES A BROWSER PRINT.
 *
 * The owner printed a clearance on 2026-09-06 and got a black-and-white page while the preview
 * beside it was blue. Chrome's print dialog ships with "Background graphics" UNTICKED, and every
 * coloured area on these papers is a CSS background — the 6% zebra bands and the .lh__rule that
 * house-identity.ts calls the one element on every document. So the browser dropped all of them.
 *
 * IT WAS INVISIBLE FROM BOTH OF THE PLACES ANYBODY LOOKS. The screen was right, and the saved PDF
 * was right too, because paper-pdf.ts passes printBackground: true. Only the printer disagreed,
 * which is why it lasted: the two paths a developer checks both looked correct.
 *
 * Stated as an INVARIANT rather than a list, so a document added later is covered without anybody
 * remembering this: if a page paints a house colour as a background, it must also tell the browser
 * to keep it. Measured on the emitted PDF at the time of the fix — rendering the clearance with
 * printBackground false lost the tint before, and loses nothing after.
 */
function testEveryHouseColourSurvivesABrowserPrint(): void {
  const pack = packFixture({ departed: true, lastWorkingDate: "2026-08-31" });

  const pages: ReadonlyArray<readonly [string, string]> = [
    ["employee clearance", renderClearanceEmployeeHtml(pack, 1)],
    ["company clearance", renderClearanceCompanyHtml(pack, 1)],
    ["laptop custody receipt", renderCustodyLaptopHtml(pack, 1)],
    ["phone custody receipt", renderCustodyMobileHtml(pack, 1)],
    ["worker data form", renderWorkerFormHtml(pack, 1)],
    ["contract renewal annex", renderContractRenewalHtml(pack, 1)],
    ["non-renewal notice", renderContractNonRenewalHtml(pack, 1)],
    ["employment contract", renderContractHtml(pack, 1)],
    ["certificate of experience (Arabic)", renderHrPaperHtml(pack, 1, HR_PAPER_EXPERIENCE_CERTIFICATE_V1)],
    ["certificate of experience (English)", renderExperienceCertificateEnHtml(pack, 1)],
    ["confidentiality undertaking", renderHrPaperHtml(pack, 1, HR_PAPER_NDA_V1)],
    ["social status sheet", renderHrPaperHtml(pack, 1, HR_PAPER_SOCIAL_STATUS_V1)],
    ["first absence warning", renderHrPaperHtml(pack, 1, HR_PAPER_ABSENCE_WARNING_V1)],
  ];

  // Pages proven to paint no house colour at all, and therefore exempt from the invariant checked
  // below. Keep this empty unless a page is shown — by this very test failing on it below — to
  // carry no background colour at all; naming it here (with a one-line reason) is how a genuine
  // non-user opts out without silently doing the same for a page that broke by accident.
  const exemptFromHouseColourCheck: ReadonlySet<string> = new Set();

  const pagesThatDidNotMatch: string[] = [];
  let pagesCheckedForPrintColorAdjust = 0;

  for (const [name, html] of pages) {
    // Does this page paint a house colour as a background at all? Written against the colours
    // rather than the word "background" so a page that only uses type and rules is not required to
    // carry a declaration it has no use for.
    const paintsAHouseColour = [HOUSE_COLORS.tint, HOUSE_COLORS.blue, HOUSE_COLORS.deep].some(
      (colour) =>
        new RegExp(`background[^;}]*${colour.replace("#", "#?")}`, "i").test(html) ||
        /background:\s*var\(--phx-doc-(blue|tint|deep)\)/i.test(html),
    );
    if (!paintsAHouseColour) {
      pagesThatDidNotMatch.push(name);
      continue;
    }
    pagesCheckedForPrintColorAdjust++;

    // THE LEADING BOUNDARY IS LOAD-BEARING. Written without it, this pattern also matches
    // "-webkit-print-color-adjust", so a page carrying only the vendor spelling satisfied the
    // standard-spelling check and this assertion could never fail on its own. Caught by mutating
    // the fix out and watching the WRONG assertion report it.
    assert.ok(
      /(^|[^-])print-color-adjust:\s*exact/i.test(html),
      `${name} paints a house colour as a background but never declares print-color-adjust: exact, ` +
        "so a browser drops it when the operator prints — the screen and the saved PDF both stay " +
        "correct, which is what makes this invisible",
    );
    assert.ok(
      /-webkit-print-color-adjust:\s*exact/i.test(html),
      `${name} needs the -webkit- spelling too; Chrome is what the field prints from`,
    );
  }

  // THE LOOP ABOVE CAN GO SILENTLY VACUOUS, which is the same shape PR #3370 fixed one layer up:
  // `paintsAHouseColour` is a regex built off the current `HOUSE_COLORS` values and the
  // `--phx-doc-*` variable names, so renaming a CSS custom property, writing a colour as `rgb()`,
  // or splitting `background-color` onto its own declaration line makes every page stop matching.
  // Every iteration then hits `continue`, neither assertion above runs even once, and this test
  // stays green while the guard it names protects nothing. Compared against `pages.length` rather
  // than a literal count, so a paper added later does not need this line touched to stay covered.
  const expectedPagesChecked = pages.length - exemptFromHouseColourCheck.size;
  const unexplainedSkips =
    pagesThatDidNotMatch.filter((name) => !exemptFromHouseColourCheck.has(name)).join(", ") ||
    "(none by name — check exemptFromHouseColourCheck itself for a stale entry)";
  assert.equal(
    pagesCheckedForPrintColorAdjust,
    expectedPagesChecked,
    `expected ${expectedPagesChecked} of ${pages.length} pages to paint a house colour and reach ` +
      `the print-color-adjust assertions, but only ${pagesCheckedForPrintColorAdjust} did. ` +
      `Page(s) that stopped matching paintsAHouseColour: ${unexplainedSkips}. Either the regex no ` +
      "longer recognises a real background declaration on that page (a renamed --phx-doc- " +
      "variable, a colour rewritten as rgb(), background-color split onto its own line) and the " +
      "print-color-adjust invariant is no longer covering it, or the page has genuinely stopped " +
      "painting a house colour and belongs in exemptFromHouseColourCheck with a one-line reason " +
      "— never widen this assertion to make a silent skip pass.",
  );
}

/**
 * THE ENGINE-TURNED BAND MUST SURVIVE AN INLINE STYLE ATTRIBUTE.
 *
 * The band is a data URI, and the obvious way to write one — leaving the SVG's own attribute
 * quotes alone and wrapping the URI in double quotes — renders perfectly in a stylesheet and then
 * silently destroys any element that uses it in `style="…"`, because the first `"` inside
 * `url("data:…")` closes the attribute. Measured 2026-09-09: four demo strips rendered blank with
 * no console error. Same shape as the quoted font stack that once deleted the hiring pack footer.
 *
 * So this pins the property that prevents it — no quotes and no spaces anywhere inside `url(…)` —
 * rather than pinning the exact bytes, which would fail on any harmless change to the curve.
 */
function testTheBandSurvivesAnInlineStyleAttribute(): void {
  for (const ink of [HOUSE_COLORS.deep, HOUSE_COLORS.blue, HOUSE_COLORS.light, HOUSE_COLORS.ink]) {
    const band = houseEngineTurnedBand(ink);
    const inside = band.slice(band.indexOf("(") + 1, band.lastIndexOf(")"));

    assert.ok(
      band.startsWith("url(data:image/svg+xml,"),
      `The band must be an inline SVG data URI — got "${band.slice(0, 40)}…".`,
    );
    assert.ok(
      !/["']/.test(inside),
      "The band's URI carries a quote. In an inline style attribute that closes the attribute and "
        + "the element renders blank, with no error anywhere. Percent-encode it.",
    );
    assert.ok(
      !/\s/.test(inside),
      "The band's URI carries whitespace, which ends the CSS url() token. Percent-encode it.",
    );
    assert.ok(
      !/[<>#]/.test(inside),
      "The band's URI carries a raw <, > or #. An unescaped # starts a fragment identifier and the "
        + "browser drops the rest of the image.",
    );
    // Decoded, so these assert the SVG itself rather than one particular way of encoding it.
    const svg = decodeURIComponent(inside.replace(/^data:image\/svg\+xml,/, ""));
    assert.ok(
      svg.includes(`stroke="${ink}"`),
      `The band must be drawn in the ink it was asked for — ${ink} is missing from the SVG.`,
    );
    assert.ok(
      svg.includes('fill="none"'),
      "The band is line, not area: its paths must not be filled.",
    );
    assert.equal(
      (svg.match(/<path/g) ?? []).length,
      2,
      "The band is two passes half a wavelength apart — one pass is a wave, not engine turning.",
    );
  }
}

/**
 * The band tiles at exactly one wavelength, and the letterhead carries it.
 *
 * A tile of any other width shows a kink at every repeat — once per 6 mm across the page — because
 * a sine only returns to the same value AND the same slope after a whole period.
 */
function testTheBandTilesAtOneWavelength(): void {
  const rule = HOUSE_IDENTITY_CSS.match(/\.lh__rule \{[\s\S]*?\}/)?.[0];
  assert.ok(rule, "The letterhead rule is the one element on every house document; it is missing.");
  assert.ok(
    rule.includes(`${HOUSE_BAND_WAVELENGTH_MM}mm ${HOUSE_BAND_HEIGHT_MM}mm`),
    `The band must be sized to exactly one wavelength (${HOUSE_BAND_WAVELENGTH_MM}mm) or it seams.`,
  );
  assert.ok(rule.includes("repeat-x"), "The band must repeat across the page, not sit once.");
  assert.ok(
    !/height:\s*\.7mm/.test(rule),
    "The 0.7 mm filled bar was replaced by the band; a filled bar here would breach the ink rule.",
  );
}

export function runHrFormsHousePapersTests(): void {
  testTheBandSurvivesAnInlineStyleAttribute();
  testTheBandTilesAtOneWavelength();
  testTheAbsenceThresholdIsMoreThanTenDays();
  testTheSecondNoticeDeclaresRatherThanAcceptsAResignation();
  testEveryPaperIsRegisteredAndCurrent();
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
  testTheCertificateStatesServiceBothWays();
  testTheCertificateOmitsPaySeparationAndConduct();
  testTheServiceSpanCountsInArabic();
  testBothCertificatesStateTheSamePeriod();
  testTheEnglishCertificateReadsCorrectly();
  testTheEnglishCertificateAgreesWithItself();
  testTheEnglishSpanCountsTheLastDay();
  testTheEnglishCertificateStaysImportable();
  testEveryHouseColourSurvivesABrowserPrint();
}
