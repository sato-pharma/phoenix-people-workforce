import { strict as assert } from "node:assert";
import { readFileSync, readdirSync } from "node:fs";

import { stripComments } from "./support/comment-strip.ts";
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
  HR_PAPER_ABSENCE_WARNING_V2,
  HR_PAPER_DEEMED_RESIGNATION_V1,
  HR_PAPER_DEEMED_RESIGNATION_V2,
  HR_PAPER_DISCIPLINARY_PENALTY_V1,
  HR_PAPER_DISCIPLINARY_WARNING_V1,
  HR_PAPER_DOCUMENTS_RECEIPT_V1,
  HR_PAPER_DOCUMENTS_RETURN_V1,
  HR_PAPER_EXIT_INTERVIEW_V1,
  HR_PAPER_EXPERIENCE_CERTIFICATE_V1,
  HR_PAPER_HANDOVER_RECORD_V1,
  HR_PAPER_HEALTH_INSURANCE_AUTHORIZATION_V1,
  HR_PAPER_INSURANCE_PRINT_LETTER_V1,
  HR_PAPER_NDA_V1,
  HR_PAPER_SALARY_ADJUSTMENT_V1,
  HR_PAPER_SOCIAL_INSURANCE_AUTHORIZATION_V1,
  HR_PAPER_SOCIAL_STATUS_V1,
  HR_PAPER_TRANSFER_DECISION_V1,
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
import { inlineLocalAssets } from "../src/lib/hiring-pack/paper-artwork.ts";
import {
  renderContractNonRenewalHtml,
  renderContractRenewalHtml,
} from "../src/lib/hiring-pack/render-renewal.ts";
import { renderContractHtml } from "../src/lib/hiring-pack/render-contract.ts";
import {
  buildExperienceCertificateEnValues,
  renderExperienceCertificateEnHtml,
} from "../src/lib/hiring-pack/experience-certificate-en.ts";
import { renderExperienceCertificateArHtml } from "../src/lib/hiring-pack/experience-certificate-ar.ts";
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
  OfficialPackFormDocument,
  OffboardingProfile,
} from "../src/lib/hiring-pack/types.ts";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  OFFICIAL_PACK_FORMS,
  type OfficialPackForm,
} from "../src/lib/hiring-pack/official-pack-forms.ts";
import { renderOfficialPackFormHtml } from "../src/lib/hiring-pack/render-official-form.ts";

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
  const start = html.indexOf('<article class="cert xc">');
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
  // EVERY VERSION, the archived ones included: a served notice reprints from its own version, so a
  // version that lost the threshold would reprint wrong for exactly the person it was served on.
  const versions = [
    [HR_PAPER_ABSENCE_WARNING_V1, HR_PAPER_DEEMED_RESIGNATION_V1],
    [HR_PAPER_ABSENCE_WARNING_V2, HR_PAPER_DEEMED_RESIGNATION_V2],
  ] as const;
  for (const [warningPaper, noticePaper] of versions) {
    const warning = textOf(warningPaper);
    const notice = textOf(noticePaper);

    // The first warning threatens the consequence; the notice declares it. Both must be phrased as
    // EXCEEDING ten days, never as reaching it.
    assert.ok(
      warning.includes("تجاوز عشرة أيام متصلة"),
      `${warningPaper.id}: the first warning must warn about EXCEEDING ten consecutive days. Article ` +
        "166 says «أكثر من عشرة أيام متتالية», so at exactly ten the deemed resignation has not " +
        "arisen and a notice issued then is premature.",
    );
    assert.ok(
      notice.includes("تجاوزت عشرة أيام متصلة") && notice.includes("أكثر من عشرة أيام متصلة"),
      `${noticePaper.id}: the deemed-resignation notice must both recite that the absence EXCEEDED ` +
        "ten consecutive days and rest its operative paragraph on the same threshold",
    );

    // And neither may state the bare "10 consecutive days" the owner's drafts did.
    for (const [name, text] of [[warningPaper.id, warning], [noticePaper.id, notice]] as const) {
      assert.ok(
        !/(?:لمدة|عن)\s+عشرة\s+أيام\s+متصلة/u.test(text),
        `${name}: "for ten consecutive days" is the pre-correction wording — the threshold is more than ten`,
      );
    }
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
  for (const notice of [HR_PAPER_DEEMED_RESIGNATION_V1, HR_PAPER_DEEMED_RESIGNATION_V2]) {
    assert.ok(
      notice.titleAr.includes("باعتبار العامل مستقيل"),
      `${notice.id}: the notice DECLARES a deemed resignation under Article 166`,
    );
    const text = textOf(notice);
    assert.ok(
      !text.includes("قبول إستقالة") && !text.includes("قبول استقالة"),
      `${notice.id}: it must never speak of ACCEPTING a resignation. The worker wrote none; accepting ` +
        "one that does not exist is what lets the whole notice be set aside, and a real resignation " +
        "is Article 167 with the labour office's approval — a different instrument entirely.",
    );
    assert.ok(
      text.includes("المادة (166)"),
      `${notice.id}: and it must cite the article it actually rests on`,
    );
    assert.ok(
      text.includes("لا يُعد هذا الإخطار فصلًا تأديبيًا"),
      `${notice.id}: it is not a disciplinary dismissal, and saying so is what keeps it a deemed resignation`,
    );
  }
}

/** The body of a paper — the recital of the facts, which is where the head office must not be. */
function recitalOf(template: HrPaperTemplate): string {
  return [...template.bodyParagraphsAr, ...template.operativeParagraphsAr].join("\n");
}

function testTheAbsencePapersRestOnWorkNotOnTheHeadOffice(): void {
  // 🔴 THE OWNER'S CORRECTION OF 2026-09-17. Version 1 of both papers recited absence from «مقر
  // عملكم … الكائن في» the head office, and the case that exposed it was a medical rep whose work is
  // in the field. Article 166 is about absence from WORK; a paper resting on the office hands the
  // worker his answer.
  for (const paper of [HR_PAPER_ABSENCE_WARNING_V2, HR_PAPER_DEEMED_RESIGNATION_V2]) {
    const recital = recitalOf(paper);
    assert.ok(
      !recital.includes("مقر عمل") &&
        !recital.includes("الحضور إلى") &&
        !recital.includes("{{COMPANY_HEAD_OFFICE_FULL}}"),
      `${paper.id}: the facts must not rest on attending the head office — that is not where a field ` +
        "employee works, and the address belongs in the company recital only",
    );
    assert.ok(
      recital.includes("انقطاعكم عن مباشرة مهام عملكم") && recital.includes("{{JOB_TITLE}}"),
      `${paper.id}: it recites a stop in carrying out the job, naming the job from the record`,
    );
    assert.ok(
      recital.includes("بالوسيلة المعتمدة وفقًا للمادة (8)"),
      `${paper.id}: and it rests on what مادة (8) makes provable — nothing recorded through the approved means`,
    );
    // ONE PAPER FOR EVERY EMPLOYEE. Field words on an office employee's warning are the same defect
    // turned round, so the job is named through the token and never typed in.
    assert.ok(
      !recital.includes("مندوب") && !recital.includes("الميدانية"),
      `${paper.id}: the wording must fit office and field staff alike`,
    );
    // The company recital at the top still carries the address — moved out of the facts, not deleted.
    assert.ok(
      paper.firstPartyLinesAr.some((line) => line.includes("{{COMPANY_HEAD_OFFICE_FULL}}")),
      `${paper.id}: the head office stays in the company recital`,
    );
  }

  const warning = HR_PAPER_ABSENCE_WARNING_V2;
  assert.ok(
    textOf(warning).includes("خمسة أيام عمل متصلة"),
    "the five days are WORK days: a rest day or public holiday is not an absence, and counting one " +
      "sends the warning a day early",
  );
  assert.ok(
    recitalOf(warning).includes("مستقيلًا حكمًا"),
    "the warning states the consequence in full rather than a vague «legal action»",
  );
  assert.ok(
    recitalOf(warning).includes("للمادة (167)") && recitalOf(warning).includes("لا تزال قائمة"),
    "it tells every absent employee the relationship stands until a resignation meeting Article 167 " +
      "is received — which shuts the «I had already resigned» defence",
  );

  // THE REGISTERED LETTER IS REQUIRED, not one option among several. Version 1 read «بخطاب موصى عليه
  // بعلم الوصول أو بأي وسيلة تُثبت العلم», which reads as permission to send it by message instead.
  const service = warning.serviceNoteAr ?? "";
  assert.ok(
    service.includes("بخطاب موصى عليه بعلم الوصول") && service.includes("لا يُغني عنه غيره"),
    "the warning's service note must make the registered letter Article 166 requires mandatory",
  );
  assert.ok(
    !/بعلم الوصول\s+أو/u.test(service),
    "and must never offer another means as an ALTERNATIVE to the registered letter",
  );
  assert.ok(
    textOf(HR_PAPER_DEEMED_RESIGNATION_V2).includes("سبق إنذاركم بخطاب موصى عليه بعلم الوصول"),
    "the notice recites that the warning went by registered letter — Article 166's precondition",
  );

  // THE OLD VERSIONS STAY PRINTABLE, byte for byte: a warning already served reprints as served.
  for (const [archived, current] of [
    [HR_PAPER_ABSENCE_WARNING_V1, HR_PAPER_ABSENCE_WARNING_V2],
    [HR_PAPER_DEEMED_RESIGNATION_V1, HR_PAPER_DEEMED_RESIGNATION_V2],
  ] as const) {
    assert.equal(hrPaperById(archived.id), archived, `${archived.id} must stay reachable from the archive`);
    const html = renderHrPaperHtml(packFixture(), 1, current, archived.id);
    assert.ok(
      html.includes("الحضور إلى مقر عملكم") && html.includes(archived.titleAr),
      `${archived.id}: a reprint of the archived version must reproduce its own text`,
    );
  }
  const current = renderHrPaperHtml(packFixture(), 1, HR_PAPER_ABSENCE_WARNING_V2);
  assert.ok(
    !current.includes("الحضور إلى مقر عملكم") && current.includes("إنذار أول بالانقطاع عن العمل"),
    "today's warning prints the corrected text",
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
  // SIXTEEN since 2026-09-13: the letters pack added nine of the owner's own papers.
  // EIGHTEEN since 2026-09-17: both absence papers gained a version 2, and version 1 of each stays.
  // NINETEEN since 2026-09-20: the Arabic HR letter (salaryLetterAr) joined beside the English one.
  assert.equal(
    HR_PAPERS.length,
    19,
    "six papers were supplied, the certificate makes seven, the letters pack adds nine, the two " +
      "absence papers each keep their archived version 1 beside version 2, and the Arabic HR letter is the nineteenth",
  );

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
    ["absenceWarning", HR_PAPER_ABSENCE_WARNING_V2],
    ["deemedResignation", HR_PAPER_DEEMED_RESIGNATION_V2],
    ["appointmentDocsReturn", HR_PAPER_DOCUMENTS_RETURN_V1],
    ["experienceCertificate", HR_PAPER_EXPERIENCE_CERTIFICATE_V1],
    ["disciplinaryWarning", HR_PAPER_DISCIPLINARY_WARNING_V1],
    ["disciplinaryPenalty", HR_PAPER_DISCIPLINARY_PENALTY_V1],
    ["transferDecision", HR_PAPER_TRANSFER_DECISION_V1],
    ["salaryAdjustment", HR_PAPER_SALARY_ADJUSTMENT_V1],
    ["socialInsuranceAuthorization", HR_PAPER_SOCIAL_INSURANCE_AUTHORIZATION_V1],
    ["healthInsuranceAuthorization", HR_PAPER_HEALTH_INSURANCE_AUTHORIZATION_V1],
    ["insurancePrintLetter", HR_PAPER_INSURANCE_PRINT_LETTER_V1],
    ["handoverRecord", HR_PAPER_HANDOVER_RECORD_V1],
    ["exitInterview", HR_PAPER_EXIT_INTERVIEW_V1],
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
    "BASE_SALARY_LEAD",
    "BASE_SALARY",
    "BASE_SALARY_WORDS",
    "COPIES_CLAUSE",
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
  for (const paper of [
    HR_PAPER_ABSENCE_WARNING_V1,
    HR_PAPER_ABSENCE_WARNING_V2,
    HR_PAPER_DEEMED_RESIGNATION_V1,
    HR_PAPER_DEEMED_RESIGNATION_V2,
  ]) {
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
  for (const paper of [
    HR_PAPER_ABSENCE_WARNING_V1,
    HR_PAPER_ABSENCE_WARNING_V2,
    HR_PAPER_DEEMED_RESIGNATION_V1,
    HR_PAPER_DEEMED_RESIGNATION_V2,
  ]) {
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

/**
 * The engine-turned band as the page DRAWS it.
 *
 * A paper in the HR premium identity (2026-10-12) draws it as an inline vector under its masthead —
 * Chrome rasterised the CSS tile into the PDF and it printed soft — while an archived version keeps the
 * house CSS tile it was signed with. A premium page still carries the house stylesheet for its
 * archived versions, so the tile's CSS is on it too; that is why a premium page must show the ELEMENT,
 * never merely the stylesheet.
 */
const PREMIUM_BAND = /<svg class="pm-band"[^>]*>[\s\S]*?<path d="M[^"]*Q[\s\S]*?<\/svg>/;
const HOUSE_BAND = /url\(data:image\/svg\+xml,[^)]*Q[^)]*\)/;
function drawsTheBand(html: string): boolean {
  return html.includes('class="pm-chrome"') ? PREMIUM_BAND.test(html) : HOUSE_BAND.test(html);
}

function testEveryPaperRendersOnTheHouseIdentity(): void {
  for (const paper of HR_PAPERS) {
    const html = renderHrPaperHtml(packFixture(), 1, paper);
    assert.ok(!html.includes("{{"), `${paper.id}: an unsubstituted token reached the page`);
    assert.ok(html.includes('<html lang="ar" dir="rtl">'), `${paper.id}: Arabic, right-to-left`);
    assert.ok(html.includes("نور عادل"), `${paper.id}: the Arabic name governs`);
    // Was `border-bottom: 0.7mm solid #0A6BA6` until 2026-09-09, when the owner replaced the filled
    // brand rule with the engine-turned band on every Sato template.
    assert.ok(
      drawsTheBand(html),
      `${paper.id}: the engine-turned band is the one element on every house document`,
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
    [HR_PAPER_ABSENCE_WARNING_V2, systemContractDefaults.absenceWarningCopies],
    [HR_PAPER_DEEMED_RESIGNATION_V2, systemContractDefaults.deemedResignationCopies],
    [HR_PAPER_DOCUMENTS_RETURN_V1, systemContractDefaults.appointmentDocsReturnCopies],
    [HR_PAPER_DISCIPLINARY_WARNING_V1, systemContractDefaults.disciplinaryWarningCopies],
    [HR_PAPER_DISCIPLINARY_PENALTY_V1, systemContractDefaults.disciplinaryPenaltyCopies],
    [HR_PAPER_TRANSFER_DECISION_V1, systemContractDefaults.transferDecisionCopies],
    [HR_PAPER_SALARY_ADJUSTMENT_V1, systemContractDefaults.salaryAdjustmentCopies],
    [HR_PAPER_SOCIAL_INSURANCE_AUTHORIZATION_V1, systemContractDefaults.socialInsuranceAuthorizationCopies],
    [HR_PAPER_HEALTH_INSURANCE_AUTHORIZATION_V1, systemContractDefaults.healthInsuranceAuthorizationCopies],
    [HR_PAPER_INSURANCE_PRINT_LETTER_V1, systemContractDefaults.insurancePrintLetterCopies],
    [HR_PAPER_HANDOVER_RECORD_V1, systemContractDefaults.handoverRecordCopies],
    [HR_PAPER_EXIT_INTERVIEW_V1, systemContractDefaults.exitInterviewCopies],
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
  // The paper HR prints — the certificate's own renderer since 2026-10-28 (`render-paper.ts`).
  const html = renderExperienceCertificateArHtml(
    packFixture({ departed: true, lastWorkingDate: "2026-08-31" }),
    1,
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
  // and off the absence-date warning that belongs to the two notices. It prints in the certificate's
  // own design, and the house renderer still draws the kind as a certificate, never as a letter.
  assert.ok(html.includes('<article class="copy xc xc--ar">'), "the certificate prints in its own design");
  assert.ok(
    renderHrPaperHtml(packFixture(), 1, HR_PAPER_EXPERIENCE_CERTIFICATE_V1).includes("copy--certificate"),
    "the certificate is not rendered as a letter",
  );
  assert.ok(
    !html.includes("The absence dates print blank"),
    "the absence-date warning belongs to the notices, not here",
  );
  // ...and the notices KEPT it, now that the banner is keyed on the tokens rather than the kind.
  assert.ok(
    renderHrPaperHtml(packFixture(), 1, HR_PAPER_ABSENCE_WARNING_V2).includes(
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
  // Set as the identity's two-weight title since 2026-10-28: a light "Certificate of" over a heavy
  // "Experience."
  assert.ok(/Certificate of\s*<b>Experience\.<\/b>/.test(html), "and carries its English title");
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
 *   · REAL TEXT — no `<img>` carrying content, and nothing that would rasterise. The marks are the
 *     only images on the page — the masthead's, and since 2026-10-12 the premium page chrome's
 *     watermark and emblem — and they are identity, not content.
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
  const content = (html.split("</header>")[1] ?? "").split('<div class="pm-chrome"')[0];
  assert.ok(!/<img/i.test(content), "no image below the letterhead carries content");

  const page = renderExperienceCertificateEnHtml(
    packFixture({ departed: true, lastWorkingDate: "2026-08-31" }),
    3,
  );
  assert.equal(
    page.split('<article class="cert xc">').length - 1,
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
    ["certificate of experience (Arabic)", renderExperienceCertificateArHtml(pack, 1)],
    ["certificate of experience (English)", renderExperienceCertificateEnHtml(pack, 1)],
    ["confidentiality undertaking", renderHrPaperHtml(pack, 1, HR_PAPER_NDA_V1)],
    ["social status sheet", renderHrPaperHtml(pack, 1, HR_PAPER_SOCIAL_STATUS_V1)],
    ["first absence warning", renderHrPaperHtml(pack, 1, HR_PAPER_ABSENCE_WARNING_V2)],
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

/**
 * EVERY MASTHEAD CARRIES THE BAND — checked on the RENDERED DOCUMENT, not on one stylesheet.
 *
 * There are THREE mastheads in this codebase, not one. `houseLetterhead()` draws the clearances,
 * the custody receipts and the worker data form; `render-contract.ts` and `render-hr-paper.ts`
 * each draw their own `.doc-mast`. Styling `.lh__rule` alone therefore reached five documents and
 * missed eight — and the first pass at this change reported success because it searched for the
 * selector it had just edited rather than for the band itself.
 *
 * So this renders real papers and searches the emitted HTML, and it also refuses the old 0.7 mm
 * filled bar anywhere, which is what a half-applied change leaves behind.
 */
function testEveryMastheadCarriesTheBand(): void {
  const pack = packFixture();
  const rendered: ReadonlyArray<readonly [string, string]> = [
    ["contract", renderContractHtml(pack, 1)],
    ["confidentiality undertaking", renderHrPaperHtml(pack, 1, HR_PAPER_NDA_V1)],
    ["absence warning", renderHrPaperHtml(pack, 1, HR_PAPER_ABSENCE_WARNING_V2)],
    ["experience certificate", renderExperienceCertificateArHtml(pack, 1)],
  ];

  for (const [name, html] of rendered) {
    // The three HR papers wear the HR premium identity (2026-10-12) and draw the band as an inline
    // vector under the premium masthead; the contract keeps the corporate dress by the owner's word the
    // same day, and with it the house band. `tests/hr-premium-identity.test.ts` pins which is which.
    assert.ok(
      drawsTheBand(html),
      `The ${name} does not carry the engine-turned band. A paper drawing its own masthead must take `
        + "it from houseBandBackground(), or from premiumMasthead() in premium-identity.ts.",
    );
    assert.ok(
      !/border-bottom:\s*0\.7mm solid/.test(html),
      `The ${name} still draws the old 0.7 mm filled brand rule, which the band replaced.`,
    );
  }
}


/**
 * NO HOUSE PAPER CARRIES A PRINTED SEAL — owner, 2026-09-29: "remove the sato pharma stamp/seal from
 * all hiring documents, leave it only in job offers".
 *
 * 🔴 COUNTED ON THE RENDERED DOCUMENT, because "the helper is gone" is not the same claim as "no
 * paper prints one". Between 2026-09-11 and 2026-09-29 seven renderers drew this seal from four
 * different signature-block shapes, and the reason it is worth a rendered count is that every way of
 * getting it wrong was silent: a company column whose heading is not الشركة, a second company column
 * on the same paper, a second signature block for a custody return, a fallback that landed the stamp
 * on the line somebody signs. The inverse is just as silent — a renderer put back, or a new paper
 * copying a neighbour, prints a stamp NOBODY PRESSED onto a document a court may read.
 *
 * The خاتم / خاتم الشركة column HEADINGS stay. They tell a human where the real stamp goes, and the
 * clearance certificate's own clause refuses the form until one is on it.
 *
 * The job offer is NOT in this list and keeps its seal — `src/lib/offers/render.ts`.
 */
function testNoHousePaperCarriesASeal(): void {
  const pack = packFixture();
  const rendered: ReadonlyArray<readonly [string, string]> = [
    ["employment contract", renderContractHtml(pack, 1)],
    ["employee clearance", renderClearanceEmployeeHtml(pack, 1)],
    ["laptop custody receipt", renderCustodyLaptopHtml(pack, 1)],
    ["worker data form", renderWorkerFormHtml(pack, 1)],
    ...HR_PAPERS.map((paper) => [paper.id, renderHrPaperHtml(pack, 1, paper)] as const),
  ];

  for (const [name, html] of rendered) {
    const seals = (html.match(/class="phx-seal"/g) ?? []).length;
    assert.equal(
      seals,
      0,
      `${name} prints ${seals} company seal(s). No hiring paper carries one (owner, 2026-09-29) — `
        + "a pre-stamped document is a document nobody stamped. The seal belongs to the job offer alone.",
    );
    assert.ok(
      !html.includes("sato-hr-seal"),
      `${name} still references the seal artwork, even if it draws no .phx-seal element.`,
    );
  }

  // THE PDF PATH MUST STILL BE ABLE TO INLINE EVERY REMAINING ASSET. `renderHiringPaperPdf` refuses
  // to file a document whose artwork it cannot read, so an artwork that is not allow-listed in
  // paper-artwork.ts is a hard failure at print time rather than a missing image.
  for (const [name, html] of rendered) {
    const { missing } = inlineLocalAssets(html);
    assert.deepEqual(
      missing,
      [],
      `${name} references artwork the PDF path cannot resolve: ${missing.join(", ")}. `
        + "Add it to the allow-list in paper-artwork.ts.",
    );
  }
}

/**
 * THE CUSTODY RETURN PROTOCOL IS NEVER PRE-SEALED.
 *
 * Kept as its own check after the blanket ban above, because this half is the sharpest case and the
 * one that would be argued back first: the return block is signed when the device actually comes
 * back — months later, and sometimes never. A seal printed there certifies a return that has not
 * happened, on a page the company issued itself.
 */
function testTheCustodyReturnProtocolIsNotSealed(): void {
  const html = renderCustodyLaptopHtml(packFixture(), 1);
  const returnBlock = html.slice(html.indexOf('<section class="ret">'));
  assert.ok(returnBlock.length > 0, "the custody receipt must still carry its return protocol");
  assert.ok(
    !returnBlock.includes('class="phx-seal"'),
    "The custody RETURN protocol is pre-sealed. That certifies a return that has not happened.",
  );
}

/**
 * THE خاتم الشركة BOX SURVIVES THE SEAL, AND IT IS EMPTY.
 *
 * Removing the printed stamp must not take the column with it. The certificate's signature row reads
 * الاسم والصفة / التوقيع / خاتم الشركة and the NDA's reads التوقيع والختم: those headings are the
 * instruction to whoever presses the real stamp, so deleting them would leave nowhere to press it
 * and would quietly make the clearance's بختم الشركة clause unsatisfiable.
 *
 * Since the certificate's own design (2026-10-28) all three of its boxes are BLANK on both languages:
 * "Blank box, sign by hand" — anyone with access to HR forms can print one, so none leaves without a
 * person signing it. A box holding anything but its caption is a printed signature or a printed seal.
 */
function testTheStampColumnSurvivesWithAnEmptyCell(): void {
  const certificates: ReadonlyArray<readonly [string, string, string]> = [
    ["Arabic certificate", renderExperienceCertificateArHtml(packFixture(), 1), "خاتم الشركة"],
    ["English certificate", renderExperienceCertificateEnHtml(packFixture(), 1), "Company stamp"],
  ];
  for (const [name, html, stampHeading] of certificates) {
    const row = /<div class="cert__signrow xc-cells">([\s\S]*?)<\/div>/.exec(html);
    assert.ok(row, `the ${name} must still carry its signing row`);
    const cells = [...row[1].matchAll(/<span class="xc-cell">([\s\S]*?)<\/span>/g)].map((m) => m[1]);
    assert.equal(cells.length, 3, `${name}: name and title / signature / company stamp`);
    assert.ok(cells[2].includes(stampHeading), `the ${name} keeps its Company stamp heading`);
    assert.deepEqual(
      cells.map((cell) => cell.replace(/<em class="xc-lbl">[^<]*<\/em>/, "").trim()),
      ["", "", ""],
      `every box on the ${name} is blank — signed and stamped by hand`,
    );
    assert.ok(!html.includes("phx-seal"), `no box on the ${name} is pre-stamped`);
  }

  // The NDA's التوقيع والختم column is the other shape, and it is blank too.
  const nda = renderHrPaperHtml(packFixture(), 1, HR_PAPER_NDA_V1);
  assert.ok(nda.includes("التوقيع والختم"), "the NDA keeps its signature-and-stamp column heading");
  const ndaBody = /<table class="doc-sig">[\s\S]*?<tbody>([\s\S]*?)<\/tbody>/.exec(nda);
  assert.ok(ndaBody, "the NDA must still carry its signature table");
  const ndaCells = [...ndaBody[1].matchAll(/<td class="doc-sig__cell"[\s\S]*?<\/td>/g)].map((m) => m[0]);
  assert.deepEqual(
    ndaCells.filter((cell) => cell.includes("phx-seal")),
    [],
    "no cell on the NDA is pre-stamped either",
  );
}

// ---------------------------------------------------------------------------------------------
// THE LETTERS PACK — 2026-09-13
// ---------------------------------------------------------------------------------------------

const LETTERS_PACK_PAPERS: readonly HrPaperTemplate[] = [
  HR_PAPER_DISCIPLINARY_WARNING_V1,
  HR_PAPER_DISCIPLINARY_PENALTY_V1,
  HR_PAPER_TRANSFER_DECISION_V1,
  HR_PAPER_SALARY_ADJUSTMENT_V1,
  HR_PAPER_SOCIAL_INSURANCE_AUTHORIZATION_V1,
  HR_PAPER_HEALTH_INSURANCE_AUTHORIZATION_V1,
  HR_PAPER_INSURANCE_PRINT_LETTER_V1,
  HR_PAPER_HANDOVER_RECORD_V1,
  HR_PAPER_EXIT_INTERVIEW_V1,
];

/** The printed copies of a house paper, with the banner and stylesheet cut away. */
function copiesOnly(html: string): string {
  const start = html.indexOf('<article class="copy');
  assert.ok(start >= 0, "a house paper must contain a copy");
  return html.slice(start);
}

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

function testTheLettersPackPapersAreFilledFromTheRecord(): void {
  const pack = packFixture();
  for (const paper of LETTERS_PACK_PAPERS) {
    const page = copiesOnly(renderHrPaperHtml(pack, 1, paper));
    assert.ok(page.includes("نور عادل"), `${paper.id}: the person it is printed for is named on it`);
    assert.ok(!page.includes("{{"), `${paper.id}: a token reached the page unfilled`);
    assert.ok(
      page.includes("ساتو فارما | إدارة الموارد البشرية"),
      `${paper.id}: the owner's own footer for the pack`,
    );
    assert.ok(
      !textOf(paper).includes("لسنة"),
      `${paper.id}: no law citation was added to the owner's wording — his papers cite none`,
    );
    assert.ok(!page.includes("شركة شركة"), `${paper.id}: the company name already begins «شركة»`);
    // NO SALARY FIGURE on any of them — the salary memo instructs payroll, it does not price anybody.
    for (const figure of ["11000", "11,000", "14300", "14,300"]) {
      assert.ok(!page.includes(figure), `${paper.id}: printed the salary figure ${figure}`);
    }
  }

  // The authorisation and print letters name the delegate by his national ID and insurance number.
  const social = copiesOnly(renderHrPaperHtml(pack, 1, HR_PAPER_SOCIAL_INSURANCE_AUTHORIZATION_V1));
  assert.ok(social.includes("29709091234567") && social.includes("123456789"));
  assert.ok(
    textOf(HR_PAPER_SOCIAL_INSURANCE_AUTHORIZATION_V1).includes(
      "(الاستعلام - س1 – س6 – س2 – التفتيش – متابعة صرف الإجازات – طباعة برينت منشأة – طباعة برينت للموظفين – تأمين السيارات)",
    ),
    "the list of what the delegate may do is the owner's, word for word",
  );

  // The handover record keeps the head office exactly as the owner confirmed it.
  assert.ok(
    textOf(HR_PAPER_HANDOVER_RECORD_V1).includes("8 ن مربع 1258 ز – شيراتون - القاهرة"),
    "the handover record's address is the one the owner confirmed on 2026-09-13",
  );

  // The salary memo's FIRST row is the person the pack is open for; the rows under it stay ruled.
  const memo = copiesOnly(renderHrPaperHtml(pack, 1, HR_PAPER_SALARY_ADJUSTMENT_V1));
  const table = memo.slice(memo.indexOf("بيان المذكورين"));
  assert.ok(table.indexOf("نور عادل") > 0, "the memo's first row names the person");
  assert.equal(count(table, "نور عادل"), 1, "and only the first row — the others are written in");
}

function testTheExitInterviewPrintsBothLanguagesAndNoAnswers(): void {
  const html = renderHrPaperHtml(packFixture(), 1, HR_PAPER_EXIT_INTERVIEW_V1);
  const page = copiesOnly(html);
  assert.equal(count(page, 'class="doc-list__box"'), 17 * 5, "seventeen rated questions, five empty boxes each");
  assert.equal(count(page, 'class="doc-open__item"'), 6, "six written questions");
  assert.equal(count(page, 'class="doc-open__line"'), 6 * 2, "two ruled lines under each");
  // Every English line is its own left-to-right block: 17 rated + 6 written + 9 grid labels.
  assert.equal(count(page, '<span class="doc-en" dir="ltr">'), 17 + 6 + 9);
  assert.ok(
    page.includes('<p class="doc-para" dir="ltr">The company confirms'),
    "the English paragraph runs left-to-right on its own",
  );
  assert.ok(page.includes('class="doc-list__rate"'), "the rating columns take a narrow box");
  assert.ok(html.includes("Every rating box prints blank"), "the banner speaks of ratings");
  assert.ok(!html.includes("certificates were handed over"), "not of certificates");
}

function testTheLettersPackGovernmentFormsPrintAsIssued(): void {
  const pack = packFixture();
  const forms = Object.entries(OFFICIAL_PACK_FORMS) as [OfficialPackFormDocument, OfficialPackForm][];
  assert.equal(forms.length, 8, "eight government forms came in the pack");
  for (const [document, form] of forms) {
    const one = renderOfficialPackFormHtml(document)(pack, 1);
    const body = one.slice(one.indexOf("<body>"));
    for (const artwork of form.pages) {
      assert.ok(existsSync(join(process.cwd(), "public", artwork)), `${document}: ${artwork} is on disk`);
      assert.ok(body.includes(artwork), `${document}: ${artwork} prints`);
    }
    assert.ok(!body.includes("نور عادل"), `${document}: nothing Phoenix wrote is on the office's form`);
    assert.equal(
      body.includes("photograph of a copy"),
      form.provisional,
      `${document}: the banner says so exactly when the artwork is a photograph`,
    );
    const two = renderOfficialPackFormHtml(document)(pack, 2);
    assert.equal(
      count(two.slice(two.indexOf("<body>")), form.pages[0]),
      2 * count(body, form.pages[0]),
      `${document}: two copies print every page twice`,
    );
  }
}

/**
 * THE CERTIFICATES KEEP ROOM TO SIGN AND STAMP IN, AND NEVER PUSH IT ONTO A SECOND SHEET.
 *
 * Since the certificate's own design (2026-10-28) its three boxes are blank on both languages and are
 * signed and stamped by hand INSIDE them. They take what the sheet has left: each copy is a column one
 * sheet tall, and the boxes grow into the space under the words. Measured in Chrome that day: 38 to
 * 40 mm with a short name, 25 to 30 mm with a four-part name and a two-line job title, and every
 * paper on one A4 sheet. The fixed 36 mm and 30 mm boxes before it had carried the long-name papers
 * onto a second sheet.
 *
 * PINNED ON THE EMITTED STYLESHEET, not the source: a box that cannot grow, a floor under 22 mm, or a
 * ceiling under 34 mm (the stamp HR presses) is what this refuses.
 */
function testTheCertificatesLeaveRoomToSignAndStamp(): void {
  const papers = [
    ["English", renderExperienceCertificateEnHtml(packFixture(), 1)],
    ["Arabic", renderExperienceCertificateArHtml(packFixture(), 1)],
  ] as const;
  for (const [name, html] of papers) {
    assert.ok(
      /\.xc \{ display: flex; flex-direction: column; \}/.test(html),
      `${name}: each copy is a column, so the signing block can take what the sheet has left`,
    );
    assert.ok(
      /@media print \{ \.xc \{ min-height: 296mm; \} \}/.test(html),
      `${name}: printed, the column is one sheet tall (296 mm, so rounding never spills an empty sheet)`,
    );
    assert.ok(/\.xc-sign \{[^}]*flex: 1 0 auto;/.test(html), `${name}: the signing block grows into the space left`);

    const cells = /\.xc-cells \{[^}]*\}/.exec(html)?.[0] ?? "";
    assert.ok(cells.includes("flex: 1 1 0;"), `${name}: the boxes grow and shrink with the space - got: ${cells}`);
    const floor = Number(/min-height:\s*(\d+(?:\.\d+)?)mm/.exec(cells)?.[1]);
    const ceiling = Number(/max-height:\s*(\d+(?:\.\d+)?)mm/.exec(cells)?.[1]);
    assert.ok(floor >= 22, `${name}: the boxes never fall under 22 mm, room to sign - got ${floor}`);
    assert.ok(ceiling >= 34, `${name}: the boxes reach the stamp's size when the sheet allows - got ${ceiling}`);
    assert.ok(
      !/\.xc-cell \{[^}]*(?<![-\w])height:/.test(html),
      `${name}: no fixed box height — that is what pushed a long name onto a second sheet`,
    );
  }
}

export function runHrFormsHousePapersTests(): void {
  testTheCertificatesLeaveRoomToSignAndStamp();
  testTheLettersPackPapersAreFilledFromTheRecord();
  testTheExitInterviewPrintsBothLanguagesAndNoAnswers();
  testTheLettersPackGovernmentFormsPrintAsIssued();
  testNoHousePaperCarriesASeal();
  testTheStampColumnSurvivesWithAnEmptyCell();
  testTheCustodyReturnProtocolIsNotSealed();
  testTheBandSurvivesAnInlineStyleAttribute();
  testTheBandTilesAtOneWavelength();
  testEveryMastheadCarriesTheBand();
  testTheAbsenceThresholdIsMoreThanTenDays();
  testTheSecondNoticeDeclaresRatherThanAcceptsAResignation();
  testTheAbsencePapersRestOnWorkNotOnTheHeadOffice();
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
  testNoPaperAssumesTheEmployeeIsAMan();
}

/**
 * The papers and their desk guidance speak about anyone.
 *
 * Found 2026-10-05, after the same defect was fixed on the field activity report: thirteen strings
 * here called the employee "he" — a field label, the resignation route's own description, six
 * printing notes and footnotes on the Hiring Pack screen, and the certificate and non-renewal
 * banners. Measured on production that day the workforce is 88 women, 87 men and 31 with no gender
 * recorded, so the masculine default was wrong for most of the people these papers are printed for.
 *
 * TWO FILES ARE EXEMPT, and both exemptions are the point rather than an oversight.
 */
function testNoPaperAssumesTheEmployeeIsAMan(): void {
  const MASCULINE = /\b(?:he|his|him|himself)\b/i;

  const EXEMPT = new Map([
    [
      "src/lib/hiring-pack/experience-certificate-en.ts",
      // `pronounsFor` resolves he/she/they from the SAME value as the honorific, so the page cannot
      // say "Ms. … he held the position". A certificate read at an embassy names a person, and the
      // recorded gender is the right source there. Neutralising this would be the regression.
      "pronouns are derived from the honorific, deliberately",
    ],
    [
      "src/lib/hiring-pack/template-registry.ts",
      // Dated provenance notes. Most of their "he" is the OWNER — "he re-sent it", "his draft" —
      // and rewriting a dated record to make a sweep clean destroys the account it exists to keep.
      "dated provenance notes, whose subject is usually the owner himself",
    ],
  ]);

  /** The match plus the prose around it, so a failure names the sentence and not just the word. */
  function offence(haystack: string): string | null {
    const hit = MASCULINE.exec(haystack);
    if (!hit) return null;
    const from = Math.max(0, hit.index - 70);
    return `"${hit[0]}" in: …${haystack.slice(from, hit.index + 70).replace(/\s+/g, " ")}…`;
  }

  // The detector must be able to SEE an offence, or the sweep below passes by being blind.
  assert.equal(offence("take his signature"), `"his" in: …take his signature…`);
  assert.equal(offence("take their signature"), null, "neutral prose is not flagged");
  assert.equal(offence("the theme of the shepherd"), null, "a word merely CONTAINING 'he' is not a pronoun");

  function walk(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory()) return walk(path);
      return /\.tsx?$/.test(entry.name) ? [path] : [];
    });
  }

  const files = [...walk("src/lib/hiring-pack"), ...walk("src/components/hiring-pack")];
  assert.ok(files.length > 50, `the sweep must actually reach the module — it found ${files.length} files`);

  let swept = 0;
  for (const file of files) {
    if (EXEMPT.has(file)) continue;
    swept += 1;
    const found = offence(stripComments(readFileSync(file, "utf8")));
    assert.equal(found, null, `${file}: a paper's own wording must not assume the employee is a man — ${found}`);
  }
  assert.ok(swept > 50, `every non-exempt file is swept — only ${swept} were`);

  // An exemption that no longer names a real file is an exemption nobody is checking.
  for (const [file, why] of EXEMPT) {
    assert.ok(readFileSync(file, "utf8").length > 0, `${file} is exempt because ${why}, and must still exist`);
  }
}
