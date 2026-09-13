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
import { buildManualHiringPack, manualPaperInputs } from "../src/lib/hiring-pack/manual-pack.ts";
import { stampPaperReference } from "../src/lib/hiring-pack/paper-reference.ts";
import { PRINT_BANNER_CSS } from "../src/lib/hiring-pack/render-shared.ts";
import {
  amountInWordsEn,
  buildSalaryLetterEnValues,
  renderSalaryLetterEnHtml,
} from "../src/lib/hiring-pack/salary-letter-en.ts";
import { currentTemplateVersion } from "../src/lib/hiring-pack/template-registry.ts";
import { calculateBasicSalary } from "../src/lib/payroll/policy.ts";

// ─────────────────────────────────────────────────────────────────────────────────────────────
// THE HR LETTER (the owner, 2026-09-13): "salary we put basic not net". The letter a bank or an
// embassy reads states the BASIC monthly salary — the payroll policy's own figure — and nothing else.
// ─────────────────────────────────────────────────────────────────────────────────────────────

const SAMPLE: Record<string, string> = {
  "employee.fullName": "Sample Person",
  "employee.gender": "male",
  "employee.hrId": "T-1",
  "employee.nationalId": "29001011234567",
  "employee.hireDate": "2023-03-01",
  "employee.jobTitle": "Medical Representative",
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

/**
 * THE LAYOUT THE OWNER CHOSE (2026-09-13, "this is better"): the Arabic certificate's — company
 * block, details grid, and a signature table with ONE seal, in the Company stamp box.
 */
function testTheLetterWearsTheArabicCertificatesLayout() {
  const pack = buildManualHiringPack(SAMPLE, COMPANY_DETAILS_DEFAULT);
  const html = renderSalaryLetterEnHtml(pack, 1);
  const page = pageOf(html);

  assert.ok(page.includes('class="doc-ident"'), "the employee's details sit in a ruled grid");
  assert.ok(page.includes("Issued by — the Company"), "the company block is on the page");
  assert.equal((html.match(/class="phx-seal"/g) ?? []).length, 1, "exactly one seal on the letter");
  const cells = signatureCells(page);
  assert.equal(cells.length, 3, "name and title, signature, company stamp");
  assert.ok(cells[2].includes('class="phx-seal"'), "the seal sits in the Company stamp box");
  assert.ok(!cells[1].includes('class="phx-seal"'), "never over the line somebody signs");
  assert.ok(
    !html.replace(PRINT_BANNER_CSS, "").includes("border-radius"),
    "every corner square, by absence",
  );

  const numbered = stampPaperReference(html, "HR-2026-000123", "salaryLetterEn");
  assert.ok(numbered.includes('data-hp-ref="HR-2026-000123"'), "the reference number is printed");
  assert.ok(
    /class="doc-mast__side doc-mast__id">[\s\S]*?<span class="hp-ref" data-hp-ref=/.test(numbered),
    "in the masthead's name block",
  );
  assert.ok(!numbered.includes('class="hp-ref hp-ref--fixed"'), "not in a loose corner line");
}

function testTheLetterStatesTheBasicSalary() {
  const pack = buildManualHiringPack(SAMPLE, COMPANY_DETAILS_DEFAULT);
  const page = pageOf(renderSalaryLetterEnHtml(pack, 1));

  assert.equal(buildSalaryLetterEnValues(pack).basicSalary, calculateBasicSalary({ baseSalary: 18000 }));
  assert.ok(page.includes("EGP 12,600.00"), "the letter must print the BASIC salary — 70% of an 18,000 base");
  assert.ok(!page.includes("18,000"), "the base salary must never reach the page");
  assert.ok(page.includes("Twelve thousand six hundred Egyptian pounds only"), "the amount is written in words");
  assert.ok(page.includes("basic monthly salary is"), "a serving employee's salary is in the present tense");
  assert.ok(!/\bnet\b/i.test(page), "the page never states a net salary");
  assert.ok(!/\bgross\b/i.test(page), "the page never states a gross salary");
}

function testNoBaseSalaryIsABlankNeverZero() {
  const { "employee.baseSalary": _dropped, ...withoutSalary } = SAMPLE;
  const pack = buildManualHiringPack(withoutSalary, COMPANY_DETAILS_DEFAULT);
  const page = pageOf(renderSalaryLetterEnHtml(pack, 1));

  assert.ok(
    page.includes('class="rule-line" data-hp-key="BASIC_SALARY_EN"'),
    "a missing salary prints a rule for a pen",
  );
  assert.ok(!page.includes("EGP 0.00"), "EGP 0.00 on a letter to a bank says the employee is unpaid");
  assert.ok(!page.includes("BASIC_SALARY_WORDS_EN"), "no words are written for a figure that is not there");
}

function testALeaverGetsThePastTense() {
  const pack = buildManualHiringPack(
    { ...SAMPLE, "offboarding.lastWorkingDate": "2026-08-31" },
    COMPANY_DETAILS_DEFAULT,
  );
  const page = pageOf(renderSalaryLetterEnHtml(pack, 1));

  assert.ok(page.includes("was employed by"), "a leaver's letter states the period of service");
  assert.ok(page.includes("last basic monthly salary was"), "and his LAST basic salary");
  assert.ok(!page.includes("currently holds"), "it never says a leaver is employed");
}

function testAmountInWords() {
  assert.equal(amountInWordsEn(1), "One Egyptian pound only");
  assert.equal(amountInWordsEn(12_600), "Twelve thousand six hundred Egyptian pounds only");
  assert.equal(
    amountInWordsEn(1234.5),
    "One thousand two hundred thirty-four Egyptian pounds and fifty piastres only",
  );
  assert.equal(amountInWordsEn(21_000.05), "Twenty-one thousand Egyptian pounds and five piastres only");
  assert.equal(amountInWordsEn(1_000_000), "One million Egyptian pounds only");
}

function testItIsWiredIn() {
  assert.deepEqual(assertBuiltInTablesAreComplete(), []);
  assert.equal(documentGroup("salaryLetterEn"), "other");
  assert.equal(folderOfDocument(buildFormsDrive(), "salaryLetterEn")?.id, "letters");
  assert.equal(documentAudience("salaryLetterEn"), "everyone", "the letter is for people still employed");
  assert.equal(documentDefaultCopies("salaryLetterEn"), 2);
  assert.equal(documentCarriesHousePageNumbers("salaryLetterEn"), true);
  assert.equal(currentTemplateVersion("salaryLetterEn").id, "salary-letter-en-v1");
}

function testATypedInLetterAsksForTheBaseSalary() {
  const pack = buildManualHiringPack(SAMPLE, COMPANY_DETAILS_DEFAULT);
  const keys = manualPaperInputs("salaryLetterEn", pack, renderSalaryLetterEnHtml(pack, 1), false).map(
    (input) => input.key,
  );
  for (const key of ["employee.fullName", "employee.jobTitle", "employee.baseSalary"]) {
    assert.ok(keys.includes(key), `a typed-in HR letter must offer a box for ${key}`);
  }
}

export function runHiringPackSalaryLetterTests() {
  testTheLetterStatesTheBasicSalary();
  testTheLetterWearsTheArabicCertificatesLayout();
  testNoBaseSalaryIsABlankNeverZero();
  testALeaverGetsThePastTense();
  testAmountInWords();
  testItIsWiredIn();
  testATypedInLetterAsksForTheBaseSalary();
}
