import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import JSZip from "jszip";

import {
  BANK_LETTER_HEADINGS,
  bankLetterDateLine,
  bankLetterFileName,
  bankLetterGaps,
  bankLetterJobTitle,
  bankLetterRows,
  formatBankLetterSalary,
  hasFabAccount,
  preselectedForBankLetter,
  sortForBankLetter,
} from "../src/lib/hiring-pack/bank-account-letter.ts";
import type { BankLetterEmployee } from "../src/lib/hiring-pack/bank-account-letter.ts";
import { BANK_LETTER_COLUMN_WIDTHS, buildBankAccountLetterDocx } from "../src/lib/hiring-pack/bank-account-letter-docx.ts";

// The bank account-opening letter (owner, 2026-10-31: "build the bank account letter in Phoenix
// exactly to export fields as the one i uploaded"). What this pins, because none of it throws when
// it goes wrong:
//   1. THE COLUMNS ARE THE ORIGINAL'S, IN ITS ORDER — a blank-headed serial, الاسم, الرقم القومي,
//      رقم للتواصل, العنوان, الوظيفة, الأجر — and the table reads right to left (`bidiVisual`).
//   2. THE WAGE IS THE BASE SALARY, a plain integer ("Base for everyone", owner 2026-10-31).
//   3. WHO ARRIVES TICKED: everyone without a First Abu Dhabi Bank account on their record.
//   4. A LONG LIST PRINTS ACROSS PAGES CLEANLY: the heading row repeats (`tblHeader`) and no row
//      splits across a page (`cantSplit`).
//   5. NO SEAL — hiring documents carry none — and the only pictures are the logo and the band.
//   6. THE LETTER IS DATED THE DAY IT IS EXPORTED, in Cairo (owner, 2026-11-04: "dated with today date").
//   7. THE ROUTE AUDITS BEFORE IT HANDS OVER THE FILE, and refuses a paper-scoped or salary-blind seat.
// Every person below is invented.

function person(overrides: Partial<BankLetterEmployee>): BankLetterEmployee {
  return {
    address: "12 شارع النصر - مدينة نصر - القاهرة",
    bankName: null,
    baseSalary: 18000,
    displayName: "Test Person",
    hireDate: "2026-10-01",
    hrId: "T-1",
    jobTitleAr: "مندوب دعاية طبية",
    jobTitleEn: "Medical Representative",
    mobile: "01000000000",
    nameAr: "شخص تجريبي أول",
    nationalId: "30001010100011",
    ...overrides,
  };
}

const PNG_STUB = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function textsOf(xml: string): string[] {
  return [...xml.matchAll(/<w:t(?: [^>]*)?>([^<]*)<\/w:t>/g)].map((match) => match[1]);
}

export async function runHiringPackBankAccountLetterTests() {
  // ── 3. who arrives ticked ─────────────────────────────────────────────────────────────────────
  const staff = [
    person({ bankName: "FAB", hrId: "T-FAB" }),
    person({ bankName: " fab ", hrId: "T-FAB-SPACED" }),
    person({ bankName: "CIB", hrId: "T-CIB" }),
    person({ bankName: "QNB", hrId: "T-QNB" }),
    person({ bankName: null, hrId: "T-NONE" }),
  ];
  assert.deepEqual(preselectedForBankLetter(staff), ["T-CIB", "T-QNB", "T-NONE"], "everyone without FAB arrives ticked, FAB never");
  assert.equal(hasFabAccount({ bankName: " fab " }), true, "a FAB code is read case- and space-blind");

  // ── 2. the wage ──────────────────────────────────────────────────────────────────────────────
  assert.equal(formatBankLetterSalary(18000), "18000", "the base salary prints as a plain integer, no separators");
  assert.equal(formatBankLetterSalary(18000.4), "18000");
  assert.equal(formatBankLetterSalary(null), "");
  assert.equal(formatBankLetterSalary(0), "", "a zero salary prints blank, never 0");

  // ── the gaps the screen names ────────────────────────────────────────────────────────────────
  assert.deepEqual(bankLetterGaps(person({})), [], "a complete record has no gap");
  assert.deepEqual(bankLetterGaps(person({ nationalId: "3000101010001" })), ["nationalId"], "a national ID is 14 digits");
  assert.deepEqual(
    bankLetterGaps(person({ address: " ", baseSalary: null, jobTitleAr: null, mobile: null, nameAr: null, nationalId: null })),
    ["nameAr", "nationalId", "mobile", "address", "jobTitleAr", "baseSalary"],
  );
  assert.equal(bankLetterJobTitle(person({ jobTitleAr: null })), "Medical Representative", "no Arabic title → the English one");

  // ── the order: by Arabic job title, then Arabic name ──────────────────────────────────────────
  const sorted = sortForBankLetter([
    person({ hrId: "rep-b", nameAr: "ياسر" }),
    person({ hrId: "hr", jobTitleAr: "أخصائي موارد بشرية", nameAr: "هالة" }),
    person({ hrId: "rep-a", nameAr: "أحمد" }),
  ]);
  assert.deepEqual(sorted.map((employee) => employee.hrId), ["hr", "rep-a", "rep-b"]);

  // ── the printed rows ─────────────────────────────────────────────────────────────────────────
  const rows = bankLetterRows([person({ address: "ش  الجيش   - طنطا" }), person({ hrId: "T-2", nameAr: "شخص & ثاني" })]);
  assert.deepEqual(rows[0], ["1", "شخص تجريبي أول", "30001010100011", "01000000000", "ش الجيش - طنطا", "مندوب دعاية طبية", "18000"]);
  assert.equal(rows[1][0], "2", "the serial counts from 1");
  assert.equal(bankLetterFileName("2026-10-31"), "sato-pharma-bank-accounts-2026-10-31.docx");

  // ── 1, 4, 5. the Word file itself ─────────────────────────────────────────────────────────────
  const docx = await buildBankAccountLetterDocx({
    companyNameAr: "ساتو فارما",
    date: "2026-11-04",
    companyNameEn: "Sato Pharma",
    headOfficeAr: "القاهرة",
    images: { bandPng: PNG_STUB, logoPng: PNG_STUB },
    rows,
  });
  const zip = await JSZip.loadAsync(docx);
  const document = await zip.file("word/document.xml")!.async("string");

  const tables = document.match(/<w:tbl>/g) ?? [];
  assert.equal(tables.length, 1, "one table");
  const trs = document.match(/<w:tr>[\s\S]*?<\/w:tr>/g) ?? [];
  assert.equal(trs.length, rows.length + 1, "a heading row plus one row per person");
  const [headingRow = "", firstRow = ""] = trs;
  const headingTexts = textsOf(headingRow);
  assert.deepEqual(headingTexts, [...BANK_LETTER_HEADINGS], "the seven headings, in the original letter's order");
  assert.deepEqual(BANK_LETTER_HEADINGS, ["", "الاسم", "الرقم القومي", "رقم للتواصل", "العنوان", "الوظيفة", "الأجر"]);
  assert.deepEqual(textsOf(firstRow), [...rows[0]], "a row prints exactly what bankLetterRows gave it");
  assert.equal(BANK_LETTER_COLUMN_WIDTHS.length, BANK_LETTER_HEADINGS.length, "one width per column");
  assert.match(document, /<w:tblPr><w:bidiVisual\/>/, "the table reads right to left, the serial on the right");
  assert.match(headingRow, /<w:tblHeader\/>/, "the heading row repeats on every page");
  for (const tr of trs) assert.match(tr, /<w:cantSplit\/>/, "no row splits across a page");
  assert.ok(document.includes("شخص &amp; ثاني"), "text is XML-escaped");
  assert.ok(document.includes("18000"), "the base salary is in the file");
  assert.equal(bankLetterDateLine("2026-11-04"), "التاريخ: 04/11/2026");
  assert.throws(() => bankLetterDateLine("4 Nov 2026"), "a date that is not YYYY-MM-DD is refused, never printed");
  const dateAt = document.indexOf("التاريخ: 04/11/2026");
  assert.ok(dateAt > 0 && dateAt < document.indexOf("السادة"), "the date line is in the letter, above the address to the bank");

  const files = Object.keys(zip.files).filter((name) => !zip.files[name].dir);
  const media = files.filter((name) => name.startsWith("word/media/")).sort();
  assert.deepEqual(media, ["word/media/sato-house-band.png", "word/media/sato-pharma-logo.png"], "the only pictures are the logo and the band");
  assert.ok(!files.some((name) => /seal|stamp|khetm/i.test(name)), "no seal on a hiring document");
  for (const part of ["[Content_Types].xml", "_rels/.rels", "word/_rels/document.xml.rels", "word/header1.xml", "word/footer1.xml", "word/styles.xml"]) {
    assert.ok(files.includes(part), `${part} is in the package`);
  }

  // ── 6. the route: its gate, and the audit row before the file ─────────────────────────────────
  const route = readFileSync(join(process.cwd(), "app/api/hiring-pack/bank-account-letter/route.ts"), "utf8");
  assert.match(route, /forms\.paperScope !== null\)/, "a paper-scoped seat is refused");
  const audit = route.indexOf("writeRequiredAuditLog({");
  const file = route.indexOf("new Response(");
  assert.ok(audit > 0 && file > audit, "the audit row is written BEFORE the file is returned");
  assert.match(route, /entityType: "bank_account_letter_export"/);
  assert.match(route, /date: today/, "the letter is dated with the Cairo day the file is exported");
}
