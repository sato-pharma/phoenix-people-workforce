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
import {
  EMU_PER_MM,
  ID_SIDE_BOX_MM,
  fitIdPicture,
  idCardStatus,
  pickIdSides,
  pictureSize,
  type BankLetterIdPage,
} from "../src/lib/hiring-pack/bank-letter-id-pages.ts";

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
//   8. ONE A4 PAGE PER CHOSEN PERSON AFTER THE LETTER, the ID card front over back (owner, 2026-11-27:
//      "if I choose 10 people … I will also have 10 more papers"), with no letterhead, outside the
//      letter's page count, and an empty box — never a skipped person — where a side is not on file.
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
    idCard: "photos",
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

  // ── 8. the national ID pages ──────────────────────────────────────────────────────────────────
  const stored = (fileName: string, uploadedAt: string, contentType = "image/jpeg") => ({ contentType, fileName, uploadedAt });
  const named = pickIdSides([stored("national-id-back.jpg", "2026-11-01"), stored("national-id-front.jpg", "2026-11-02")]);
  assert.equal(named.front?.fileName, "national-id-front.jpg", "a name that says front is the front, whatever the upload order");
  assert.equal(named.back?.fileName, "national-id-back.jpg");
  assert.equal(named.status, "photos");
  const unnamed = pickIdSides([stored("scan-2.jpg", "2026-11-02"), stored("scan-1.jpg", "2026-11-01")]);
  assert.deepEqual([unnamed.front?.fileName, unnamed.back?.fileName], ["scan-1.jpg", "scan-2.jpg"], "unnamed pictures go in upload order, the first the front");
  const single = pickIdSides([stored("بطاقة.jpg", "2026-11-01")]);
  assert.equal(single.status, "one-photo");
  assert.equal(single.front?.fileName, "بطاقة.jpg", "one picture is printed as the front");
  assert.equal(idCardStatus([stored("بطاقة حسن.pdf", "2026-11-01", "application/pdf")]), "scan", "a PDF alone is a scan, which a Word page cannot carry");
  assert.equal(idCardStatus([]), "missing");

  const wide = fitIdPicture(1600, 1000);
  assert.equal(wide.cx, ID_SIDE_BOX_MM.width * EMU_PER_MM, "a landscape card fills the box width");
  assert.ok(wide.cy <= ID_SIDE_BOX_MM.height * EMU_PER_MM, "and never overruns its half of the page");
  const tall = fitIdPicture(1000, 1600);
  assert.equal(tall.cy, ID_SIDE_BOX_MM.height * EMU_PER_MM, "an upright photo fills the box height");
  assert.ok(Math.abs(tall.cx / tall.cy - 1000 / 1600) < 0.001, "never stretched");
  assert.ok(2 * ID_SIDE_BOX_MM.height + 40 <= 297 - 30, "two sides, the name and the captions fit one A4 page inside 15 mm margins");

  const png = new Uint8Array(33);
  png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(png.buffer).setUint32(16, 856);
  new DataView(png.buffer).setUint32(20, 540);
  assert.deepEqual(pictureSize(png), { contentType: "image/png", heightPx: 540, widthPx: 856 });
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x4a, 0x46, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x02, 0x1c, 0x03, 0x58, 0x03, 0x01, 0x22, 0x00]);
  assert.deepEqual(pictureSize(jpeg), { contentType: "image/jpeg", heightPx: 540, widthPx: 856 }, "the JPEG frame size is read past the APP0 segment");
  assert.equal(pictureSize(new Uint8Array([1, 2, 3])), null);

  const idPicture = { bytes: jpeg, contentType: "image/jpeg" as const, heightPx: 540, widthPx: 856 };
  const idPages: BankLetterIdPage[] = [
    { back: idPicture, front: idPicture, name: "شخص تجريبي أول", nationalId: "30001010100011", status: "photos" },
    { back: null, front: null, name: "شخص تجريبي ثان", nationalId: null, status: "missing" },
    { back: null, front: null, name: "شخص تجريبي ثالث", nationalId: "29912120100022", status: "scan" },
  ];
  const withIds = await JSZip.loadAsync(
    await buildBankAccountLetterDocx({
      companyNameAr: "ساتو فارما",
      companyNameEn: "Sato Pharma",
      date: "2026-11-27",
      headOfficeAr: "القاهرة",
      idPages,
      images: { bandPng: PNG_STUB, logoPng: PNG_STUB },
      rows: bankLetterRows([person({}), person({ hrId: "T-2" }), person({ hrId: "T-3" })]),
    }),
  );
  const idDocument = await withIds.file("word/document.xml")!.async("string");
  const sections = idDocument.match(/<w:sectPr>[\s\S]*?<\/w:sectPr>/g) ?? [];
  assert.equal(sections.length, 2, "the letter, then the ID pages as a section of their own");
  assert.match(sections[0], /r:id="rIdHeader"/, "the letter keeps the letterhead");
  assert.match(sections[1], /r:id="rIdHeaderBlank"/, "the ID pages carry an empty header, never the letterhead");
  assert.match(sections[1], /r:id="rIdFooterBlank"/, "and an empty footer");
  assert.match(sections[1], /<w:type w:val="nextPage"\/>/, "the ID pages start on a new page");
  assert.equal((idDocument.match(/<w:pageBreakBefore\/>/g) ?? []).length, idPages.length - 1, "every person after the first starts a new page — one page each");
  const idTexts = textsOf(idDocument);
  for (const page of idPages) assert.ok(idTexts.includes(page.name), `${page.name} heads their own page`);
  assert.equal(idTexts.filter((text) => text === "وجه البطاقة").length, idPages.length, "every page has the front, captioned");
  assert.equal(idTexts.filter((text) => text === "ظهر البطاقة").length, idPages.length, "and the back, captioned");
  assert.ok(idDocument.indexOf("وجه البطاقة") < idDocument.indexOf("ظهر البطاقة"), "the front is the top half, the back the bottom");
  assert.ok(idTexts.includes("لا توجد صورة لوجه البطاقة — تُلصق نسخة هنا"), "a missing side prints an empty box, never skips the person");
  assert.ok(idTexts.some((text) => text.includes("PDF")), "a PDF-only card says where to print it from");
  const idFiles = Object.keys(withIds.files).filter((name) => !withIds.files[name].dir);
  assert.deepEqual(
    idFiles.filter((name) => name.startsWith("word/media/id-card-")).sort(),
    ["word/media/id-card-1-back.jpeg", "word/media/id-card-1-front.jpeg"],
    "only the sides on file are carried",
  );
  for (const part of ["word/header2.xml", "word/footer2.xml"]) assert.ok(idFiles.includes(part), `${part} is in the package`);
  const rels = await withIds.file("word/_rels/document.xml.rels")!.async("string");
  assert.ok(rels.includes("media/id-card-1-front.jpeg") && rels.includes("header2.xml"), "each picture and the blank header are related");
  assert.ok((await withIds.file("[Content_Types].xml")!.async("string")).includes('Extension="jpeg"'), "Word is told what a .jpeg is");
  const footer = await withIds.file("word/footer1.xml")!.async("string");
  assert.ok(footer.includes("SECTIONPAGES") && !footer.includes("NUMPAGES"), "the letter counts its own pages, never the ID pages after it");
  assert.ok(!document.includes("<w:pageBreakBefore/>") && !files.includes("word/header2.xml"), "with no ID pages the letter is as it was");

  // ── 6. the route: its gate, and the audit row before the file ─────────────────────────────────
  const route = readFileSync(join(process.cwd(), "app/api/hiring-pack/bank-account-letter/route.ts"), "utf8");
  assert.match(route, /forms\.paperScope !== null\)/, "a paper-scoped seat is refused");
  const audit = route.indexOf("writeRequiredAuditLog({");
  const file = route.indexOf("new Response(");
  assert.ok(audit > 0 && file > audit, "the audit row is written BEFORE the file is returned");
  assert.match(route, /entityType: "bank_account_letter_export"/);
  assert.match(route, /date: today/, "the letter is dated with the Cairo day the file is exported");
  assert.match(route, /loadBankLetterIdPages\(chosen\)/, "the ID pages are the chosen people, in the letter's order");
  assert.match(route, /\s+idPages,\n/, "and they reach the Word file");
}
