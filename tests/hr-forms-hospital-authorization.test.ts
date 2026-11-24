import { strict as assert } from "node:assert";

import { COMPANY_DETAILS_DEFAULT } from "../src/lib/hiring-pack/company-details.ts";
import { HR_PAPER_BLANK_RULE } from "../src/lib/hiring-pack/hr-paper-template.ts";
import { HR_PAPER_HOSPITAL_AUTHORIZATION_V1, HR_PAPERS } from "../src/lib/hiring-pack/hr-paper-text.ts";
import { PAPER_FIELD_BINDINGS } from "../src/lib/hiring-pack/paper-fields.ts";
import { isPremiumPaper } from "../src/lib/hiring-pack/paper-pdf.ts";
import { buildHrPaperValues, renderHrPaperHtml } from "../src/lib/hiring-pack/render-hr-paper.ts";
import {
  collectHiringPackGaps,
  emptyOffboardingProfile,
  resolveContractTerms,
} from "../src/lib/hiring-pack/service.ts";
import { HOUSE_LETTER_DOCUMENTS } from "../src/lib/hiring-pack/types.ts";
import type {
  HiringPackData,
  HiringPackEmployeeFacts,
  HiringPackProfile,
} from "../src/lib/hiring-pack/types.ts";

/**
 * THE HOSPITAL AUTHORISATION LETTER (owner, 2026-11-24).
 *
 * A medical rep visits a hospital only with a letter from the company naming that ONE hospital —
 * the first was for Dr Rania Alaa at Kafr El Sheikh University Hospital. HR Forms now carries it for
 * every rep, with the hospital typed on the paper and kept on the person's hiring profile.
 *
 *   - the hospital fills all three places the letter names it (addressee, the visit, the limit);
 *   - with no hospital typed, all three are blank rules HR can click to fill — never an empty gap
 *     that prints a letter addressed to nobody;
 *   - the delegate is الدكتورة / والتي تعمل for a woman and الدكتور / والذي يعمل for a man;
 *   - it wears the HR premium identity, by his word "HR PREMIUM IDENTITY".
 */

const HOSPITAL = "مستشفى كفر الشيخ الجامعي";

function employeeFixture(overrides: Partial<HiringPackEmployeeFacts> = {}): HiringPackEmployeeFacts {
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
    authorizationHospitalAr: null,
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
  const offboarding = emptyOffboardingProfile("H-3003");
  return {
    employee,
    profile,
    offboarding,
    exit: null,
    custodyDevice: null,
    renewal: null,
    company: COMPANY_DETAILS_DEFAULT,
    suggestedJobTitleAr: null,
    gaps: collectHiringPackGaps(employee, profile, offboarding, null),
    terms: resolveContractTerms(employee, profile, offboarding, null),
  };
}

function render(data: HiringPackData): string {
  return renderHrPaperHtml(data, 1, HR_PAPER_HOSPITAL_AUTHORIZATION_V1);
}

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

function testTheHospitalFillsEveryPlaceTheLetterNamesIt(): void {
  const html = render(packFixture({}, { authorizationHospitalAr: HOSPITAL }));
  const filled = `<span class="fill" data-hp-key="HOSPITAL_NAME">${HOSPITAL}</span>`;
  assert.equal(count(html, filled), 3, "the addressee, the visit and the limit all name the one hospital");
  assert.ok(html.includes("ويقتصر هذا التفويض على"), "the letter limits itself to that hospital");
  assert.ok(html.includes("نور عادل"), "the rep is named");
  assert.ok(html.includes("29709091234567"), "the rep's national ID is printed");
}

function testWithNoHospitalTheLetterLeavesRulesToFill(): void {
  const html = render(packFixture());
  const rule = `<span class="rule-line" data-hp-key="HOSPITAL_NAME">${HR_PAPER_BLANK_RULE}</span>`;
  assert.equal(count(html, rule), 3, "each place the hospital goes is a rule HR can click and fill");
  assert.equal(count(html, 'data-hp-key="HOSPITAL_NAME">'), 3, "and nowhere else");
}

function testTheDelegateFollowsTheRepsGender(): void {
  const woman = buildHrPaperValues(packFixture({ gender: "female" }));
  assert.equal(woman.DELEGATE_TITLE, "الدكتورة");
  assert.equal(woman.DELEGATE_WORKS, "والتي تعمل");

  const man = buildHrPaperValues(packFixture({ gender: "male" }));
  assert.equal(man.DELEGATE_TITLE, "الدكتور");
  assert.equal(man.DELEGATE_WORKS, "والذي يعمل");

  const html = render(packFixture({ gender: "female" }, { authorizationHospitalAr: HOSPITAL }));
  assert.ok(html.includes("الدكتورة"), "a woman's letter calls her الدكتورة on the printed page");
}

function testItWearsTheHrPremiumIdentity(): void {
  assert.ok(isPremiumPaper(render(packFixture())), "the hospital letter wears the HR premium identity");
}

function testItIsAnHrFormsLetterWhoseHospitalIsKeptOnTheProfile(): void {
  assert.ok(HOUSE_LETTER_DOCUMENTS.includes("hospitalAuthorization"), "it is filed with the Letters on HR Forms");
  assert.ok(HR_PAPERS.includes(HR_PAPER_HOSPITAL_AUTHORIZATION_V1), "it is a registered HR paper");
  assert.deepEqual(
    { store: PAPER_FIELD_BINDINGS.HOSPITAL_NAME?.store, field: PAPER_FIELD_BINDINGS.HOSPITAL_NAME?.field },
    { store: "profile", field: "authorizationHospitalAr" },
    "the hospital typed on the paper is saved on the person's hiring profile",
  );
}

export function runHrFormsHospitalAuthorizationTests(): void {
  testTheHospitalFillsEveryPlaceTheLetterNamesIt();
  testWithNoHospitalTheLetterLeavesRulesToFill();
  testTheDelegateFollowsTheRepsGender();
  testItWearsTheHrPremiumIdentity();
  testItIsAnHrFormsLetterWhoseHospitalIsKeptOnTheProfile();
}
