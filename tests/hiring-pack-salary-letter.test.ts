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

// ─────────────────────────────────────────────────────────────────────────────────────────────
// THE HR LETTER STATES THE BASE SALARY ON RECORD (the owner, 2026-10-28: "PUT THE BASE NOT THE BASIC
// SALARY"). From 2026-09-13 it stated the BASIC ("salary we put basic not net"); that is reversed, and
// the English letter now states the same figure as the Arabic one — the record's base, as it is.
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

/** The printed page only — the on-screen banner says things about the letter the page never does. */
function pageOf(html: string): string {
  return [...html.matchAll(/<article class="copy[\s\S]*?<\/article>/g)].map((m) => m[0]).join("\n");
}

/** The signing boxes of the first copy, in order — the certificate of experience's signing row. */
function signingCells(html: string): string[] {
  const row = /<div class="cert__signrow xc-cells">([\s\S]*?)<\/div>/.exec(html);
  assert.ok(row, "the page must carry the certificate's signing row");
  return [...row[1].matchAll(/<span class="xc-cell">([\s\S]*?)<\/span>/g)].map((m) => m[1]);
}

/**
 * THE CERTIFICATE OF EXPERIENCE'S DESIGN (owner, 2026-10-28: "SHOW ME HR LETTER WITH SAME IDENTITY",
 * then "Make it the HR letter"): the two-weight title beside the issuing company, the employee's
 * details as a ruled list, the words, the salary at a glance, and three BLANK signing boxes — the
 * Company stamp box says where to press one, and no seal is printed (owner, 2026-09-29).
 */
function testTheLetterWearsTheCertificatesDesign() {
  const pack = buildManualHiringPack(SAMPLE, COMPANY_DETAILS_DEFAULT);
  const html = renderSalaryLetterEnHtml(pack, 1);
  const page = pageOf(html);

  assert.ok(page.startsWith('<article class="copy xc xl xl--en">'), "the copy is the certificate's sheet, as an HR letter");
  assert.ok(page.includes("<h2>Salary<b>Certificate.</b></h2>"), "the two-weight title");
  assert.ok(page.includes('<dl class="xc-facts xc-fields">'), "the employee's details sit in a ruled list");
  assert.ok(page.includes("Issued by — the Company"), "the company block is on the page");
  assert.ok(!page.includes('class="doc-ident"') && !page.includes('class="doc-sig"'), "nothing of the old grid and table is left");
  assert.equal((html.match(/class="phx-seal"/g) ?? []).length, 0, "no printed seal on the letter");

  const cells = signingCells(page);
  assert.deepEqual(
    cells.map((cell) => /<em class="xc-lbl">([^<]*)<\/em>/.exec(cell)?.[1]),
    ["Name and title", "Signature", "Company stamp"],
    "name and title, signature, company stamp — the stamp box stays to say where to press one",
  );
  assert.deepEqual(
    cells.map((cell) => cell.replace(/<em class="xc-lbl">[^<]*<\/em>/, "").trim()),
    ["", "", ""],
    "every signing box is blank — signed and stamped by hand",
  );
  // A `border-radius: 0` reset is square-keeping (the shell asserts one); any other value is not.
  assert.ok(
    !/border-radius\s*:(?!\s*0(?:px|mm)?\s*(?:!important)?\s*[;}])/.test(html.replace(PRINT_BANNER_CSS, "")),
    "every corner square",
  );

  const numbered = stampPaperReference(html, "HR-2026-000123", "salaryLetterEn");
  assert.ok(numbered.includes('data-hp-ref="HR-2026-000123"'), "the reference number is printed");
  // The letter wears the HR premium masthead, which keeps an empty slot for the number at the end of
  // its name line.
  assert.ok(
    /<span class="pm-mast__ref" dir="rtl"><span class="hp-ref" data-hp-ref="HR-2026-000123">/.test(numbered),
    "in the premium masthead's reference slot",
  );
  assert.ok(!numbered.includes('class="hp-ref hp-ref--fixed"'), "not in a loose corner line");
}

function testTheLetterStatesTheBaseSalary() {
  const pack = buildManualHiringPack(SAMPLE, COMPANY_DETAILS_DEFAULT);
  const page = pageOf(renderSalaryLetterEnHtml(pack, 1));

  assert.equal(buildSalaryLetterEnValues(pack).baseSalary, 18000, "the base salary on record, as it is");
  assert.ok(page.includes("EGP 18,000.00"), "the letter prints the BASE salary — the 18,000 on the record");
  assert.ok(!page.includes("12,600"), "and never the basic derived from it (70% of 18,000)");
  assert.ok(page.includes("Eighteen thousand Egyptian pounds only"), "the amount is written in words — of the base");
  assert.ok(page.includes("base monthly salary is"), "a serving employee's salary is in the present tense");
  assert.ok(
    /<div class="xc-span xl-pay xl-pay--2">[\s\S]*?Base monthly salary<\/span><div class="xc-fig"><b>18,000<\/b><em>EGP<\/em>/.test(page),
    "the salary at a glance repeats the same base figure",
  );
  assert.ok(!/\bbasic\b/i.test(page), "the word basic is nowhere on the page");
  assert.ok(!/\bnet\b/i.test(page), "the page never states a net salary");
  assert.ok(!/\bgross\b/i.test(page), "the page never states a gross salary");
}

function testNoBaseSalaryIsABlankNeverZero() {
  const { "employee.baseSalary": _dropped, ...withoutSalary } = SAMPLE;
  const pack = buildManualHiringPack(withoutSalary, COMPANY_DETAILS_DEFAULT);
  const page = pageOf(renderSalaryLetterEnHtml(pack, 1));

  assert.ok(
    page.includes('class="rule-line" data-hp-key="BASE_SALARY_EN"'),
    "a missing salary prints a rule for a pen",
  );
  assert.ok(!page.includes("EGP 0.00"), "EGP 0.00 on a letter to a bank says the employee is unpaid");
  assert.ok(!page.includes("BASE_SALARY_WORDS_EN"), "no words are written for a figure that is not there");
  assert.ok(!page.includes("xl-pay"), "and no salary strip — an empty box there would read as a zero");
}

function testALeaverGetsThePastTense() {
  const pack = buildManualHiringPack(
    { ...SAMPLE, "offboarding.lastWorkingDate": "2026-08-31" },
    COMPANY_DETAILS_DEFAULT,
  );
  const page = pageOf(renderSalaryLetterEnHtml(pack, 1));

  assert.ok(page.includes("was employed by"), "a leaver's letter states the period of service");
  assert.ok(page.includes("last base monthly salary was"), "and his LAST base salary");
  assert.ok(
    /<div class="xc-span xl-pay xl-pay--3">[\s\S]*?Last working day[\s\S]*?Last base monthly salary<\/span>/.test(page),
    "the strip adds the last working day and names the salary as the last one",
  );
  assert.ok(!page.includes("currently holds"), "it never says a leaver is employed");
}

function testAmountInWords() {
  assert.equal(amountInWordsEn(1), "One Egyptian pound only");
  assert.equal(amountInWordsEn(12_600), "Twelve thousand six hundred Egyptian pounds only");
  assert.equal(amountInWordsEn(18_000), "Eighteen thousand Egyptian pounds only");
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
  testTheLetterStatesTheBaseSalary();
  testTheLetterWearsTheCertificatesDesign();
  testNoBaseSalaryIsABlankNeverZero();
  testALeaverGetsThePastTense();
  testAmountInWords();
  testItIsWiredIn();
  testATypedInLetterAsksForTheBaseSalary();
}
