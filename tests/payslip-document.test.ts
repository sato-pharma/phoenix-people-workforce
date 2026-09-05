// The payslip document — SATO-DIS-2026-01 v1.0.
//
// EVERY ASSERTION HERE IS ON THE EMITTED ARTIFACT, never on the module's source. Three defects
// shipped in one night from source-reading "verification": an escaped slash that reached the browser
// unescaped, a font stack fixed in one copy and not its twin, and a quoted font family that closed
// a `style=""` attribute and deleted a footer. So this builds the document and reads what came out.

import assert from "node:assert/strict";

import { spellEgyptianAmount } from "../src/lib/hiring-pack/arabic-amount.ts";
import { houseLetterhead } from "../src/lib/hiring-pack/house-identity.ts";
import {
  assertEverySectionIsPlaced,
  buildPayslipDocument,
  buildPayslipSheet,
  PAYSLIP_DOCUMENT_CSS,
  payslipContentDisposition,
  payslipFileName,
} from "../src/lib/payroll/payslip-document.ts";
import {
  payrollSheetHeaders,
  payrollSheetSections,
} from "../src/lib/payroll/salary-sheet-fields.ts";
import type { SalaryRecord } from "../src/lib/payroll/types.ts";

/**
 * A specimen with a DISTINCT, non-round figure in every money column.
 *
 * Distinct on purpose: a document that dropped one component would still pass if two columns shared
 * a value, because the survivor's figure would satisfy the missing one's assertion.
 */
const RECORD: SalaryRecord = {
  area: "Cairo 1",
  batchId: "batch-1",
  baseSalary: 9001,
  bonus: 502,
  calendarDays: 31,
  crm: 13,
  employeeCode: "A-000",
  hrId: "a-000",
  employmentIncomeTax: 621,
  expenses: 1503,
  extraCostOfLiving: 304,
  fingerPrint: 105,
  firstPart: 6006,
  fuelAllowance: 757,
  fullName: "Ahmed Specimen Mohamed",
  governmentalDeductions: 1779,
  grossSalary: 12858,
  hireDate: "2024-03-01",
  nameAr: "أحمد نموذج محمد",
  id: "record-1",
  incentive: 2410,
  jobTitle: "Medical Representative",
  line: "CNS",
  loans: 1011,
  medicalInsurance: 252,
  monthSalary: 15300,
  netSalary: 11204,
  otherAdditions: 15,
  otherDeductions: 16,
  overtime: 17,
  payrollComment: "Fuel allowance prorated for two days of unpaid leave.",
  paymentMode: "bank",
  secondPart: 9294,
  socialInsurance: 1158,
  totalAdditions: 5458,
  totalDeductions: 1359,
  unpaidVacations: 18,
  workingDays: 26,
};

const SHEET = buildPayslipSheet(RECORD, 8, 2026, "approved", 1);
const DOCUMENT = buildPayslipDocument([RECORD], 8, 2026, "approved");

/** Columns printed in the identity block or the letterhead rather than in a component table. */
const IDENTITY_HEADERS = new Set([
  "#", "Month", "Year", "HR_ID", "Full Name", "Arabic Name", "Job Title", "Line", "Area",
  "Hire Date", "Working Days", "Payment Group", "Policy Comment",
]);

export function runPayslipDocumentTests() {
  // ── the mark, and whose document this is ───────────────────────────────────────────────────────
  // The payslip carried `phoenix-main-logo.png` until 2026-09-05. A company document wears the
  // COMPANY's identity; the app's brand belongs on the app's screens.
  assert.match(
    SHEET,
    /src="\/brand\/sato-pharma-logo-on-light\.svg"/,
    "The payslip must carry the Sato Pharma mark — the ON-LIGHT file, whose SATO wordmark is not white.",
  );
  assert.doesNotMatch(SHEET, /phoenix/i, "No Phoenix branding may appear on a company document.");
  assert.match(SHEET, /SATO-DIS-2026-01 v1\.0/, "The sheet states the standard it is drawn to.");

  // ── the square-edge rule (owner, 2026-09-04) ───────────────────────────────────────────────────
  // Measured on the stylesheet that ships, because a 4 px radius inherited from `tokens.css` is
  // invisible in a screenshot and survives review.
  const radii = PAYSLIP_DOCUMENT_CSS.match(/border-radius:\s*([^;]+);/g) ?? [];
  assert.ok(radii.length > 0, "The reset that pins square edges must be present.");
  for (const rule of radii) {
    assert.match(
      rule,
      /border-radius:\s*0\s*!important;/,
      `Every border-radius in the payslip must be a square-edge reset — found ${rule}`,
    );
  }

  // ── the ink rule ───────────────────────────────────────────────────────────────────────────────
  // Colour is carried by LINES AND TYPE. The only filled areas allowed are the 0.7 mm brand rule in
  // the letterhead and the 6 % zebra row the owner asked for by name. This counts every painted
  // background the document declares and names any third one.
  const backgrounds = (PAYSLIP_DOCUMENT_CSS.match(/background:\s*([^;]+);/g) ?? [])
    .map((rule) => rule.replace(/background:\s*/, "").replace(/;$/, "").trim())
    .filter((value) => value !== "#fff" && value !== "#ffffff" && value !== "none" && value !== "transparent");
  const allowed = new Set(["var(--phx-doc-tint)", "var(--phx-doc-blue)", "#eef2f6"]);
  for (const value of backgrounds) {
    assert.ok(
      allowed.has(value),
      `The ink rule allows the zebra tint, the brand rule and the on-screen ground only — found "${value}".`,
    );
  }
  assert.ok(
    backgrounds.includes("var(--phx-doc-tint)"),
    "The 6% zebra row is the one filled element the owner asked for by name; it must still be there.",
  );

  // ── no figure may be lost in the redesign ──────────────────────────────────────────────────────
  // The most expensive failure this change could cause is a money line quietly not printing. Every
  // sheet column that is not shown in the identity block must appear on the page, by NAME.
  for (const header of payrollSheetHeaders) {
    if (IDENTITY_HEADERS.has(header)) continue;
    assert.ok(
      SHEET.includes(`>${header}<`),
      `The payslip must still print the "${header}" component — a redesign that drops one is a wrong payslip.`,
    );
  }

  // Every band of the payroll sheet has a home. `payrollSheetSections` is positional, so a band
  // added there would otherwise print nowhere at all — and `ignoreBuildErrors` means a missing key
  // compiles, builds and deploys.
  assert.doesNotThrow(assertEverySectionIsPlaced, "Every payroll sheet band must map to a region.");
  assert.equal(
    payrollSheetSections.length,
    6,
    "Six bands are mapped. A new one needs a region in REGION_BY_TONE before it can print.",
  );

  // ── and it must land in the RIGHT column ───────────────────────────────────────────────────────
  // The check above only proves a component printed SOMEWHERE. Misrouting a band still prints every
  // name — measured: moving "Fixed Salary" into the payment strip left the loop above green — and a
  // deduction shown under "Fixed salary and additions" is a wrong payslip, not a cosmetic slip. So
  // each column is read separately and asked what it contains.
  const columns = [...SHEET.matchAll(/<div class="detail__col">([\s\S]*?)<\/table><\/div>/g)]
    .map((match) => match[1]);
  assert.equal(columns.length, 2, "The detail is two columns: earnings on the left, deductions on the right.");
  const [earnings, deductions] = columns;

  for (const label of ["Fixed Salary", "Additions", "Base Salary", "Incentive", "Fuel Allowance", "Total Additions"]) {
    assert.ok(earnings.includes(label), `"${label}" belongs in the earnings column.`);
    assert.ok(!deductions.includes(label), `…and must NOT appear among the deductions.`);
  }
  for (const label of [
    "Governmental Deductions", "Internal Deductions", "Social Insurance",
    "Employment Income Tax", "Loans", "Total Deductions",
  ]) {
    assert.ok(deductions.includes(label), `"${label}" belongs in the deductions column.`);
    assert.ok(!earnings.includes(label), `…and must NOT be printed as an addition.`);
  }

  // ── the figures themselves ─────────────────────────────────────────────────────────────────────
  // `Intl` puts a NON-BREAKING space (U+00A0) between "EGP" and the digits, not a plain one. Spelled
  // out here rather than reproduced by calling the same formatter the document calls: a test that
  // formats its own expectation agrees with the document by construction and would not notice the
  // currency changing. This was found by the assertion failing, not by reading the code.
  const egp = (figure: string) => `EGP\u00A0${figure}`;
  for (const [label, amount] of [
    ["base salary", "9,001.00"],
    ["gross salary", "12,858.00"],
    ["net salary", "11,204.00"],
    ["total additions", "5,458.00"],
    ["total deductions", "1,359.00"],
    ["month salary", "15,300.00"],
    ["first part", "6,006.00"],
    ["second part", "9,294.00"],
  ] as const) {
    assert.ok(
      SHEET.includes(egp(amount)),
      `The ${label} must print as EGP ${amount} — with a non-breaking space, so the amount never wraps.`,
    );
  }

  // ── the amount in words ────────────────────────────────────────────────────────────────────────
  // The same speller the employment contracts use, so the payslip and the contract cannot disagree
  // about how a number is said.
  const words = spellEgyptianAmount(RECORD.monthSalary);
  assert.equal(words, "خمسة عشر ألفاً وثلاثمائة جنيه مصري", "The speller's own output, pinned.");
  assert.ok(SHEET.includes(`فقط ${words} لا غير`), "The month salary must be written out in Arabic.");
  assert.match(
    SHEET,
    /<p class="hero__words" dir="rtl" lang="ar">/,
    "The Arabic line carries its OWN direction — a mixed line renders the English half backwards.",
  );

  // A zero month salary must print NO words line rather than "صفر جنيه": the speller returns "" on
  // purpose, because a spelled zero gets signed where an obvious gap gets questioned.
  const zeroed = buildPayslipSheet({ ...RECORD, monthSalary: 0 }, 8, 2026, "approved", 1);
  assert.doesNotMatch(zeroed, /hero__words/, "A zero month salary prints a gap, never a spelled zero.");

  // ── bilingual, two lines, never one mixed line ─────────────────────────────────────────────────
  assert.match(SHEET, /<h1 dir="ltr">Payslip<\/h1>/, "English leads on an English-facing paper.");
  assert.match(
    SHEET,
    /<p class="lh__ar" dir="rtl" lang="ar">قسيمة راتب<\/p>/,
    "…and the paper's Arabic name sits under it, on its own line with its own direction.",
  );

  // ── one employee, one sheet of paper ───────────────────────────────────────────────────────────
  // The redesign SHIPPED rendering two pages, the second holding nothing but the footer: the sheet
  // came to 308.1 mm against A4's 297 mm. The check that actually answers this launches Chromium
  // and lives in `scripts/check-payslip-page-fit.mjs`, because the house rule is that the suite does
  // not launch a browser — CI's runner is not the app container. What CAN be asserted here is the
  // thing that regressed: the amount of pure whitespace the layout spends vertically.
  const bandMargins = [...PAYSLIP_DOCUMENT_CSS.matchAll(/margin:\s*([\d.]+)mm 0 0/g)]
    .map((match) => Number(match[1]));
  const pagePadding = /\.ps \{[\s\S]*?padding:\s*([\d.]+)mm [\d.]+mm(?: ([\d.]+)mm)?;/.exec(PAYSLIP_DOCUMENT_CSS);
  assert.ok(pagePadding, "The sheet must declare its own page padding.");
  const verticalPadding = Number(pagePadding[1]) + Number(pagePadding[2] ?? pagePadding[1]);
  const whitespace = bandMargins.reduce((sum, mm) => sum + mm, 0) + verticalPadding;
  assert.ok(
    bandMargins.length >= 5,
    `Expected the band margins to be found; got ${bandMargins.length}. The selector shape changed.`,
  );
  assert.ok(
    whitespace <= 42,
    `The sheet spends ${whitespace}mm of vertical whitespace (page padding + band margins). The `
      + "budget is 42mm: above it the ordinary payslip stops fitting on one A4 sheet and the footer "
      + "prints alone on a second. Re-run scripts/check-payslip-page-fit.mjs after changing spacing.",
  );

  // A4 is 793.7px at 96dpi — SIX PIXELS inside this breakpoint. Chromium's print layout does not
  // currently apply it (measured: scoping this changed the exported PDF by zero bytes), but six
  // pixels is not a margin to depend on, and an unscoped rule that did apply would print every
  // payslip in the stacked phone layout.
  assert.match(
    PAYSLIP_DOCUMENT_CSS,
    /@media screen and \(max-width: 800px\)/,
    "The phone breakpoint must be scoped to screen — paper is 793.7px wide and is never a phone.",
  );

  // ── the saved file's name (owner's format, 2026-09-05) ─────────────────────────────────────────
  // "<Employee Name> - payslip.pdf". It leads with the PERSON, and the person is a NAME: the old
  // name was `phoenix-payslip-<hrId>-<period>.pdf`, which led with the app's brand and identified
  // the employee by a raw code — against the standing rule that people are shown by name.
  assert.equal(
    payslipFileName({ fullName: "Ahmed Specimen Mohamed", employeeCode: "A-000", hrId: "a-000" }, 8, 2026),
    "Ahmed Specimen Mohamed - payslip - August 2026.pdf",
    "The owner's format, exactly — name, then the month it covers.",
  );

  // Spaces SURVIVE. The old helper collapsed everything outside [a-z0-9._-] to hyphens, which is
  // how "Ahmed Specimen Mohamed" became "Ahmed-Specimen-Mohamed" — not a name, a slug.
  assert.ok(
    payslipFileName({ fullName: "Ahmed Specimen Mohamed", employeeCode: "", hrId: "" }, 8, 2026).includes(" Specimen "),
    "A name keeps its spaces.",
  );

  // Digits, apostrophes and hyphens are part of real names and must survive. This is the assertion
  // that catches a character class written as a RANGE — `[ -<]` reads as space-to-less-than and
  // silently deletes every digit and apostrophe, which looks like nothing at all in review.
  assert.equal(
    payslipFileName({ fullName: "Sara O'Brien Al-Sayed 2", employeeCode: "", hrId: "" }, 8, 2026),
    "Sara O'Brien Al-Sayed 2 - payslip - August 2026.pdf",
    "Apostrophes, hyphens and digits belong to the name, not to the illegal set.",
  );

  // What a filesystem genuinely refuses is removed, and nothing else.
  assert.equal(
    payslipFileName({ fullName: 'a/b:c*d?e"f<g>h|i', employeeCode: "", hrId: "" }, 8, 2026),
    "a b c d e f g h i - payslip - August 2026.pdf",
    "The Windows-illegal set becomes spaces; the name is not otherwise mangled.",
  );

  // A leading dot hides a file on Unix, so it is trimmed rather than passed through.
  assert.equal(
    payslipFileName({ fullName: "  ...Hidden Name  ", employeeCode: "", hrId: "" }, 8, 2026),
    "Hidden Name - payslip - August 2026.pdf",
    "Leading dots and surrounding space are trimmed.",
  );

  // The fallback chain. A file still needs a name when the record has none — an unnamed payslip is
  // a data problem, not a reason to fail somebody's download.
  assert.equal(
    payslipFileName({ fullName: "", employeeCode: "A-137", hrId: "a-137" }, 8, 2026),
    "A-137 - payslip - August 2026.pdf",
    "With no name, the employee code stands in.",
  );
  assert.equal(
    payslipFileName({ fullName: "", employeeCode: "", hrId: "" }, 8, 2026),
    "Employee - payslip - August 2026.pdf",
    "With nothing at all, the download still gets a name.",
  );

  // Two months of ONE employee must be two different files. Without the period they are the same
  // name, and a person saving a year of payslips gets "(1)", "(2)", "(3)" — the browser deciding
  // what the file should have said.
  const person = { fullName: "Ahmed Specimen Mohamed", employeeCode: "A-000", hrId: "a-000" };
  assert.notEqual(
    payslipFileName(person, 8, 2026),
    payslipFileName(person, 9, 2026),
    "Consecutive months must not produce the same filename.",
  );
  assert.equal(
    payslipFileName(person, 1, 2027),
    "Ahmed Specimen Mohamed - payslip - January 2027.pdf",
    "…and the month is spelled the way the document's own subtitle spells it.",
  );

  // ── the header that actually ships ─────────────────────────────────────────────────────────────
  const disposition = payslipContentDisposition(
    { fullName: "Ahmed Specimen Mohamed", employeeCode: "A-000", hrId: "a-000" }, 8, 2026,
  );
  assert.equal(
    disposition,
    `attachment; filename="Ahmed Specimen Mohamed - payslip - August 2026.pdf"; `
      + `filename*=UTF-8''${encodeURIComponent("Ahmed Specimen Mohamed - payslip - August 2026.pdf")}`,
    "Both RFC 6266 forms, in order.",
  );

  // A name is USER DATA on its way into a protocol header. A raw newline would split the header and
  // a double quote would end the filename early — so the ASCII fallback keeps neither, while the
  // UTF-8 form is percent-encoded and cannot carry either by construction.
  const hostile = payslipContentDisposition(
    { fullName: 'Ahmed" \r\nX-Injected: yes', employeeCode: "", hrId: "" }, 8, 2026,
  );
  assert.doesNotMatch(hostile, /[\r\n]/, "No control character may reach the header.");
  assert.equal(
    (hostile.match(/"/g) ?? []).length,
    2,
    "Exactly the two quotes that delimit the fallback — a name cannot add a third.",
  );

  // An Arabic name survives in the UTF-8 form even though the ASCII fallback cannot hold it, which
  // is the entire reason both forms are sent.
  const arabicName = payslipContentDisposition(
    { fullName: "محمد عبد الله", employeeCode: "A-9", hrId: "a-9" }, 8, 2026,
  );
  assert.match(
    arabicName,
    /filename="A-9 - payslip - August 2026\.pdf"/,
    "The ASCII fallback falls THROUGH to the employee code — stripping the assembled name instead "
      + "leaves \"- payslip.pdf\", which opens with a dash and identifies nobody.",
  );
  assert.ok(
    decodeURIComponent(arabicName.split("filename*=UTF-8''")[1]) === "محمد عبد الله - payslip - August 2026.pdf",
    "…while the UTF-8 form carries the real name intact.",
  );

  // ── the ellipsis ban (owner rule) ──────────────────────────────────────────────────────────────
  // The pdf-lib renderer this replaced cut any overrunning value and appended "..". Nothing in the
  // document may truncate, and nothing in the stylesheet may ask the browser to.
  assert.doesNotMatch(PAYSLIP_DOCUMENT_CSS, /text-overflow/, "Text is never truncated with an ellipsis.");
  assert.doesNotMatch(SHEET, /…/, "No ellipsis character may reach the page.");
  assert.match(
    PAYSLIP_DOCUMENT_CSS,
    /overflow-wrap:\s*anywhere/,
    "Long values wrap instead — wrapping is the permitted answer, cutting is not.",
  );

  // ── the fits-the-screen rule ───────────────────────────────────────────────────────────────────
  // The old sheet was a 960 px card wrapping an `overflow-y: auto` detail table. `overflow-x: auto`
  // over a min-width floor IS the bug, not the fix.
  assert.doesNotMatch(PAYSLIP_DOCUMENT_CSS, /overflow-x:\s*auto/, "No horizontal scroll container.");
  assert.match(
    PAYSLIP_DOCUMENT_CSS,
    /@media screen and \(max-width: 800px\)[\s\S]*?\.detail__col \{ flex-basis: 100%/,
    "The sheet must reflow to one column on a phone rather than scroll sideways.",
  );

  // ── the document as a whole ────────────────────────────────────────────────────────────────────
  assert.match(DOCUMENT, /^<!doctype html>/, "A whole document, servable as-is.");
  assert.match(DOCUMENT, /<html lang="en">/, "…declared English, which is what it is written in.");
  assert.match(DOCUMENT, /@page \{ size: A4; margin: 0; \}/, "A4, with the sheet holding its own margins.");
  assert.ok(DOCUMENT.includes(PAYSLIP_DOCUMENT_CSS), "The page ships the stylesheet this test measured.");

  // Two records make two sheets, and the batch page must break between them.
  const two = buildPayslipDocument([RECORD, { ...RECORD, employeeCode: "A-001" }], 8, 2026, "approved");
  assert.equal(two.match(/<article class="ps">/g)?.length, 2, "One sheet per employee.");
  assert.match(PAYSLIP_DOCUMENT_CSS, /page-break-after: always/, "…each on its own sheet of paper.");

  // ── the house letterhead stayed additive ───────────────────────────────────────────────────────
  // The bilingual fields were added to `houseLetterhead` for this document. Four Arabic instruments
  // share that function — the contract, both clearances and the worker data form — and none of them
  // was meant to move a single byte. This is that claim, checked rather than asserted in a comment.
  const arabicOnly = houseLetterhead({
    legalNameAr: "شركة ساتو فارما",
    legalNameEn: "Sato Pharma",
    purposeAr: "نسخة العامل",
    subtitleAr: "طبقاً لأحكام قانون العمل",
    titleAr: "عقد عمل",
  });
  assert.match(arabicOnly, /<h1>عقد عمل<\/h1>/, "An Arabic-only paper keeps the Arabic in the h1…");
  assert.doesNotMatch(arabicOnly, /dir="ltr">عقد عمل/, "…and gains no direction attribute it did not have.");
  assert.match(
    arabicOnly,
    /<p class="lh__purpose">نسخة العامل<\/p>/,
    "…and its purpose band is the ORIGINAL single-paragraph markup, not a generalised form of it.",
  );
  assert.doesNotMatch(arabicOnly, /lh__ar/, "…with no English-mode element emitted at all.");
}
