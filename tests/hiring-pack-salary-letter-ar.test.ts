import assert from "node:assert/strict";

import { COMPANY_DETAILS_DEFAULT } from "../src/lib/hiring-pack/company-details.ts";
import {
  assertBuiltInTablesAreComplete,
  documentDefaultCopies,
  documentGroup,
} from "../src/lib/hiring-pack/document-registry.ts";
import {
  buildFormsDrive,
  documentAudience,
  folderOfDocument,
} from "../src/lib/hiring-pack/forms-drive.ts";
import { documentCarriesHousePageNumbers } from "../src/lib/hiring-pack/house-identity.ts";
import { HR_PAPER_SALARY_LETTER_AR_V1 } from "../src/lib/hiring-pack/hr-paper-text.ts";
import { buildManualHiringPack, manualPaperInputs } from "../src/lib/hiring-pack/manual-pack.ts";
import { renderHrPaperHtml } from "../src/lib/hiring-pack/render-hr-paper.ts";
import { currentTemplateVersion } from "../src/lib/hiring-pack/template-registry.ts";
import { calculateBasicSalary } from "../src/lib/payroll/policy.ts";

// ─────────────────────────────────────────────────────────────────────────────────────────────
// THE ARABIC HR LETTER — the Arabic counterpart of `hiring-pack-salary-letter.test.ts`. Both must
// state the SAME basic salary off the SAME `calculateBasicSalary` figure, so the two never disagree
// about one employee's number.
// ─────────────────────────────────────────────────────────────────────────────────────────────

const SAMPLE: Record<string, string> = {
  "employee.nameAr": "شخص عيّنة",
  "employee.nationalId": "29001011234567",
  "employee.hrId": "T-1",
  "profile.jobTitleAr": "مندوب دعاية طبية",
  "employee.departmentAr": "المبيعات",
  "employee.hireDate": "2023-03-01",
  "employee.baseSalary": "18000",
};

/** The printed page only — the on-screen banner names the base salary on purpose, the page never. */
function pageOf(html: string): string {
  return [...html.matchAll(/<article class="copy[\s\S]*?<\/article>/g)].map((m) => m[0]).join("\n");
}

/** The body cells of the signature table, in order. */
function signatureCells(html: string): string[] {
  const table = /<table class="doc-sig">[\s\S]*?<tbody>([\s\S]*?)<\/tbody>/.exec(html);
  assert.ok(table, "the page must carry its signature table");
  return [...table[1].matchAll(/<td class="doc-sig__cell"[\s\S]*?<\/td>/g)].map((m) => m[0]);
}

function renderHtml(pack: ReturnType<typeof buildManualHiringPack>, copies = 1): string {
  return renderHrPaperHtml(pack, copies, HR_PAPER_SALARY_LETTER_AR_V1);
}

/**
 * THE ARABIC CERTIFICATE'S OWN LAYOUT — the same one-column, one-seal shape as the certificate of
 * experience and as the English letter: company block, identity grid, and the Company stamp box
 * carrying the seal.
 */
function testTheLetterWearsTheCertificatesLayout() {
  const pack = buildManualHiringPack(SAMPLE, COMPANY_DETAILS_DEFAULT);
  const html = renderHtml(pack);
  const page = pageOf(html);

  assert.ok(page.includes('class="doc-ident"'), "the employee's details sit in a ruled grid");
  assert.ok(page.includes("copy--salaryLetter"), "the letter carries its own kind, not the certificate's");
  assert.equal((html.match(/class="phx-seal"/g) ?? []).length, 1, "exactly one seal on the letter");
  const cells = signatureCells(page);
  assert.equal(cells.length, 3, "name and title, signature, company stamp");
  assert.ok(cells[2].includes('class="phx-seal"'), "the seal sits in the Company stamp box");
  assert.ok(!cells[1].includes('class="phx-seal"'), "never over the line somebody signs");
  assert.ok(!page.includes("border-radius"), "every corner square, by absence");
}

function testTheLetterStatesTheBasicSalary() {
  const pack = buildManualHiringPack(SAMPLE, COMPANY_DETAILS_DEFAULT);
  const page = pageOf(renderHtml(pack));

  assert.equal(calculateBasicSalary({ baseSalary: 18000 }), 12600);
  assert.ok(page.includes("12,600"), "the letter must print the BASIC salary — 70% of an 18,000 base");
  assert.ok(!page.includes("18,000"), "the base salary must never reach the page");
  assert.ok(
    page.includes("اثنا عشر ألفاً وستمائة جنيه مصري"),
    "the amount is written out in Arabic words (تفقيط)",
  );
  assert.ok(page.includes("فقط لا غير"), "the words are fenced the way every other amount in this system is");
  assert.ok(page.includes("ويتقاضى أجرًا أساسيًا شهريًا"), "a serving employee's salary is in the present tense");
  assert.ok(!page.includes("صافي"), "the page never states a net salary");
  assert.ok(!page.includes("إجمالي"), "the page never states a gross salary");
}

function testNoBaseSalaryIsABlankNeverZero() {
  const { "employee.baseSalary": _dropped, ...withoutSalary } = SAMPLE;
  const pack = buildManualHiringPack(withoutSalary, COMPANY_DETAILS_DEFAULT);
  const page = pageOf(renderHtml(pack));

  assert.ok(
    page.includes('class="rule-line" data-hp-key="BASIC_SALARY"'),
    "a missing salary prints a rule for a pen",
  );
  assert.ok(!page.includes("٠ جنيه") && !page.includes("0 جنيه"), "a zero on a letter to a bank says the employee is unpaid");
  assert.ok(!page.includes('data-hp-key="BASIC_SALARY_WORDS"') === false, "sanity: the token key itself still appears somewhere");
  assert.ok(
    page.includes('class="rule-line" data-hp-key="BASIC_SALARY_WORDS"'),
    "no words are spelled out for a figure that is not there — it rules too",
  );
}

function testALeaverGetsThePastTense() {
  const pack = buildManualHiringPack(
    { ...SAMPLE, "offboarding.lastWorkingDate": "2026-08-31" },
    COMPANY_DETAILS_DEFAULT,
  );
  const page = pageOf(renderHtml(pack));

  assert.ok(
    page.includes("وقد انتهت خدمته لدى الشركة"),
    "a leaver's letter states that his service ended",
  );
  assert.ok(
    page.includes("وكان آخر أجر أساسي شهري يتقاضاه"),
    "and states his LAST basic salary, in the past tense",
  );
  assert.ok(!page.includes("ويتقاضى أجرًا أساسيًا شهريًا"), "it never states a leaver's salary in the present tense");
}

function testItIsWiredIn() {
  assert.deepEqual(assertBuiltInTablesAreComplete(), []);
  assert.equal(documentGroup("salaryLetterAr"), "other");
  assert.equal(folderOfDocument(buildFormsDrive(), "salaryLetterAr")?.id, "letters");
  assert.equal(documentAudience("salaryLetterAr"), "everyone", "the letter is for people still employed");
  assert.equal(documentDefaultCopies("salaryLetterAr"), 2);
  assert.equal(documentCarriesHousePageNumbers("salaryLetterAr"), true);
  assert.equal(currentTemplateVersion("salaryLetterAr").id, "salary-letter-ar-v1");
}

function testATypedInLetterAsksForTheBaseSalary() {
  const pack = buildManualHiringPack(SAMPLE, COMPANY_DETAILS_DEFAULT);
  const keys = manualPaperInputs("salaryLetterAr", pack, renderHtml(pack), false).map(
    (input) => input.key,
  );
  for (const key of ["employee.nameAr", "profile.jobTitleAr", "employee.baseSalary"]) {
    assert.ok(keys.includes(key), `a typed-in Arabic HR letter must offer a box for ${key}`);
  }
}

export function runHiringPackSalaryLetterArTests() {
  testTheLetterWearsTheCertificatesLayout();
  testTheLetterStatesTheBasicSalary();
  testNoBaseSalaryIsABlankNeverZero();
  testALeaverGetsThePastTense();
  testItIsWiredIn();
  testATypedInLetterAsksForTheBaseSalary();
}
