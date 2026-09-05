// Does one employee's payslip come off the printer as ONE sheet of paper?
//
// ─────────────────────────────────────────────────────────────────────────────────────────────────
// WHY THIS IS A SCRIPT AND NOT A TEST. It launches real Chromium, and the house rule is that the
// test suite does not: CI's runner is not the app container, so a required check that depends on a
// browser being present goes red for everyone the day the runner image changes. This is the check
// that actually answers the question, run on demand:
//
//   node scripts/check-payslip-page-fit.mjs
//
// `tests/payslip-document.test.ts` carries the deterministic half — the spacing budget and the
// screen-scoped breakpoint — which is what a required check can honestly assert.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────────
// WHAT WENT WRONG, so the next person does not spend the evening the way this one was spent. The
// redesigned payslip shipped rendering TWO pages, the second holding nothing but the footer. The
// sheet was 308.1 mm against A4's 297 mm — eleven millimetres of ordinary overflow.
//
// Two false trails, both worth naming:
//
//   1. Measuring at the DEFAULT 800x600 viewport reports 527 mm, because the phone breakpoint
//      applies there and the sheet stacks. That is a number about the phone layout, not about
//      paper. Measure at a viewport WIDER than the breakpoint; `.ps` is `width: 210mm` either way,
//      so the sheet then lays out exactly as it will on A4.
//   2. A4 is 793.7 px at 96 dpi, six pixels inside the 800 px breakpoint, which looks like a
//      smoking gun and is not one — Chromium's print layout did not apply it, and scoping the
//      query to `screen` changed the exported PDF by zero bytes. It is scoped anyway, as a guard.
//
// The ellipsis and Arabic assertions ride along because this is the only place a REAL PDF exists:
// the amount in words cannot be checked any other way, and a PDF text layer stores SHAPED Arabic in
// VISUAL order, which is its own trap — see `arabicPresent`.

import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// `fileURLToPath`, never `new URL(...).pathname`. The latter is PERCENT-ENCODED — this repo lives
// under "Phoenix Workforce" — and feeding it back through `pathToFileURL` encodes the % again, so
// the import resolves against a path containing "%2520" and fails as module-not-found.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const load = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href);

const { buildPayslipDocument } = await load("src/lib/payroll/payslip-document.ts");
const { inlineLocalAssets } = await load("src/lib/hiring-pack/paper-artwork.ts");
const { withChromiumPage, isChromiumAvailable } = await load("src/lib/pdf/chromium.ts");

if (!(await isChromiumAvailable())) {
  console.error("Chromium is not available on this machine, so nothing was checked.");
  console.error("This script needs a browser; it is deliberately not part of the test suite.");
  process.exit(2);
}

const BASE = {
  area: "Cairo 1", batchId: "b", baseSalary: 9000, bonus: 500, calendarDays: 31, crm: 0,
  employeeCode: "A-000", hrId: "a-000", employmentIncomeTax: 620, expenses: 1500,
  extraCostOfLiving: 300, fingerPrint: 100, firstPart: 6000, fuelAllowance: 750,
  fullName: "Ahmed Specimen Mohamed", governmentalDeductions: 1770, grossSalary: 12857.14,
  hireDate: "2024-03-01", nameAr: "أحمد نموذج محمد", id: "r", incentive: 2400,
  jobTitle: "Medical Representative", line: "CNS", loans: 1000, medicalInsurance: 250,
  monthSalary: 15300, netSalary: 11200, otherAdditions: 0, otherDeductions: 0, overtime: 0,
  payrollComment: "Fuel allowance prorated for the two days of unpaid leave taken on 12 and 13 August.",
  paymentMode: "bank", secondPart: 9300, socialInsurance: 1150, totalAdditions: 5450,
  totalDeductions: 1350, unpaidVacations: 0, workingDays: 26,
};

// The worst REALISTIC sheet as well as the ordinary one. A fix that only fits the specimen has
// fixed nothing: this is the shape — a two-line comment and a long name — that was still spilling
// after the first two spacing passes.
const CASES = [
  ["no comment", { ...BASE, payrollComment: null }],
  ["ordinary", BASE],
  ["long comment + long names", {
    ...BASE,
    fullName: "Abdelrahman Mohamed Abdelaziz Elsayed Ibrahim",
    jobTitle: "Senior Medical Representative — Central Cairo",
    payrollComment:
      "Fuel allowance prorated for the two days of unpaid leave taken on 12 and 13 August, and the "
      + "incentive reflects the revised Q3 achievement after the closing was re-stamped on 2 September.",
  }],
];

const A4_HEIGHT_PX = (297 / 25.4) * 96;
const mm = (px) => (px / 96 * 25.4).toFixed(1);

/**
 * Is this Arabic word in the PDF's text layer?
 *
 * A PDF stores SHAPED Arabic — presentation forms, U+FE70–FEFF — laid out in VISUAL order, so the
 * word arrives reversed. LAM-ALEF IS THE CATCH: it is a single glyph that NFKC expands to lam+alef
 * in LOGICAL order, so a naive character reversal produces "ال" where the document holds "لا", and
 * "ثلاثمائة" reads as ABSENT from a payslip that plainly prints it. Reverse by unit instead.
 *
 * Getting shaped forms back at all is itself the evidence that Chromium shaped the text: pdf-lib
 * with a Unicode font would have emitted isolated letters in logical order, and with the standard
 * fonts nothing at all.
 */
function arabicPresent(haystack, word) {
  const reversed = (word.match(/لا|[\s\S]/g) ?? []).reverse().join("");
  return haystack.includes(word) || haystack.includes(reversed);
}

const { PDFParse } = await load("node_modules/pdf-parse/dist/pdf-parse/esm/index.js");

let failures = 0;
await withChromiumPage(async (page) => {
  for (const [label, record] of CASES) {
    const { html, missing } = inlineLocalAssets(buildPayslipDocument([record], 8, 2026, "approved"));
    if (missing.length > 0) {
      console.error(`  FAIL  ${label}: artwork missing — ${missing.join(", ")}`);
      failures += 1;
      continue;
    }

    // Measured at a viewport WIDER than the phone breakpoint — see the note at the top.
    await page.setViewport({ width: 1200, height: 1400 });
    await page.setContent(html, { timeout: 30_000, waitUntil: "domcontentloaded" });
    await page.evaluate(
      "(async () => { try { await document.fonts.ready; } catch {} "
        + "await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))); })()",
    );
    const height = await page.evaluate("document.querySelector('.ps').getBoundingClientRect().height");

    await page.emulateMediaType("print");
    const pdf = await page.pdf({ printBackground: true, preferCSSPageSize: true, timeout: 30_000 });

    const parser = new PDFParse({ data: Buffer.from(pdf) });
    const parsed = await parser.getText();
    const text = parsed.text.replace(/\s+/g, " ");
    const arabic = [...parsed.text.normalize("NFKC")].filter((c) => /[؀-ۿ]/.test(c)).join("");
    await parser.destroy();

    const checks = [
      ["one page", parsed.total === 1],
      ["fits A4", height <= A4_HEIGHT_PX],
      ["Arabic title", arabicPresent(arabic, "قسيمة")],
      ["amount in words", ["خمسة", "ثلاثمائة", "جنيه"].every((w) => arabicPresent(arabic, w))],
      ["the month figure", text.includes("15,300.00")],
      ["no ellipsis", !text.includes("..") && !text.includes("…")],
      ["no Phoenix branding", !/phoenix/i.test(text)],
    ];
    const bad = checks.filter(([, ok]) => !ok).map(([name]) => name);
    failures += bad.length;

    const verdict = height <= A4_HEIGHT_PX
      ? `${mm(A4_HEIGHT_PX - height)}mm spare`
      : `OVER by ${mm(height - A4_HEIGHT_PX)}mm`;
    console.log(
      `${bad.length === 0 ? "ok  " : "FAIL"}  ${label.padEnd(28)} `
      + `${mm(height).padStart(6)}mm, ${String(parsed.total)} page(s), ${verdict}`
      + (bad.length ? `  <- ${bad.join(", ")}` : ""),
    );
  }
});

console.log(failures === 0
  ? "\nEvery payslip fits one sheet, with the Arabic intact."
  : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
