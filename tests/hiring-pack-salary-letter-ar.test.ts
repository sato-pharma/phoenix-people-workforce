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
import { PRINT_BANNER_CSS } from "../src/lib/hiring-pack/render-shared.ts";
import { renderSalaryLetterArHtml } from "../src/lib/hiring-pack/salary-letter-ar.ts";
import { currentTemplateVersion } from "../src/lib/hiring-pack/template-registry.ts";

// ─────────────────────────────────────────────────────────────────────────────────────────────
// THE ARABIC HR LETTER — the Arabic counterpart of `hiring-pack-salary-letter.test.ts`. Since
// 2026-09-20 it states the BASE salary (and the English letter with it since 2026-10-28), carries no
// company seal, and writes how many copies it was drawn up in from the number chosen at print time.
// Since 2026-10-28 it wears the certificate of experience's design ("Make it the HR letter", both
// languages), drawn by `salary-letter-ar.ts` from the template's words, unchanged.
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

/** The printed page only — the on-screen banner says things about the letter the page never does. */
function pageOf(html: string): string {
  return [...html.matchAll(/<article class="copy[\s\S]*?<\/article>/g)].map((m) => m[0]).join("\n");
}

/** The body cells of the old signature table, in order — the dress an archived version prints in. */
function signatureCells(html: string): string[] {
  const table = /<table class="doc-sig">[\s\S]*?<tbody>([\s\S]*?)<\/tbody>/.exec(html);
  assert.ok(table, "the page must carry its signature table");
  return [...table[1].matchAll(/<td class="doc-sig__cell"[\s\S]*?<\/td>/g)].map((m) => m[0]);
}

/** The signing boxes of the first copy, in order — the certificate of experience's signing row. */
function signingCells(html: string): string[] {
  const row = /<div class="cert__signrow xc-cells xl-cells--2">([\s\S]*?)<\/div>/.exec(html);
  assert.ok(row, "the page must carry the certificate's two-box signing row");
  return [...row[1].matchAll(/<span class="xc-cell">([\s\S]*?)<\/span>/g)].map((m) => m[1]);
}

/** The letter as the print route draws it (`render-paper.ts`). */
function renderHtml(pack: ReturnType<typeof buildManualHiringPack>, copies = 1): string {
  return renderSalaryLetterArHtml(pack, copies);
}

/**
 * THE CERTIFICATE OF EXPERIENCE'S DESIGN (owner, 2026-10-28: "Make it the HR letter", both languages),
 * with NO COMPANY SEAL — the owner, 2026-09-20, "remove the stamp"; it was the FIRST paper to lose it.
 * The template signs with a name and a signature only, so the signing row has TWO blank boxes and no
 * «خاتم الشركة».
 */
function testTheLetterWearsTheCertificatesDesignWithoutASeal() {
  const pack = buildManualHiringPack(SAMPLE, COMPANY_DETAILS_DEFAULT);
  const html = renderHtml(pack);
  const page = pageOf(html);

  assert.ok(page.startsWith('<article class="copy xc xc--ar xl">'), "the copy is the certificate's Arabic sheet, as an HR letter");
  assert.ok(page.includes("<h2>شهادة <b>راتب</b></h2>"), "the two-weight title, its last word heavy");
  assert.ok(page.includes('<dl class="xc-facts xc-fields">'), "the employee's details sit in a ruled list");
  assert.ok(!page.includes('class="doc-ident"') && !page.includes('class="doc-sig"'), "nothing of the old grid and table is left");
  assert.equal((html.match(/class="phx-seal"/g) ?? []).length, 0, "no company seal anywhere on the letter");

  const cells = signingCells(page);
  assert.deepEqual(
    cells.map((cell) => /<em class="xc-lbl">([^<]*)<\/em>/.exec(cell)?.[1]),
    [...HR_PAPER_SALARY_LETTER_AR_V1.signatureColumns[0].fieldsAr],
    "name and title, and the signature — the template's own two labels, no stamp box",
  );
  assert.deepEqual(
    cells.map((cell) => cell.replace(/<em class="xc-lbl">[^<]*<\/em>/, "").trim()),
    ["", ""],
    "both boxes are blank — signed by hand",
  );
  assert.ok(!page.includes("خاتم الشركة"), "the Company stamp label is gone with the stamp");
  assert.ok(!page.includes("border-radius"), "every corner square, by absence");
  assert.ok(
    !/border-radius\s*:(?!\s*0(?:px|mm)?\s*(?:!important)?\s*[;}])/.test(html.replace(PRINT_BANNER_CSS, "")),
    "and nothing in the stylesheets rounds one",
  );

  // THE SIGNATURE BOX IS WHERE THE MOVED MARK LANDS: hand-placed marks are stored as a path inside
  // one copy, `section:nth-of-type(2) > div:nth-of-type(1) > span:nth-of-type(2)`. So the words and
  // the signing block are the copy's only two sections, and the signing row is the second one's
  // first div.
  const sections = page.split("</article>")[0].match(/<section[\s>][\s\S]*?<\/section>/g) ?? [];
  assert.equal(sections.length, 2, "the words and the signing block are the only two sections in a copy");
  const firstDiv = /<div[\s>][^]*?<\/div>/.exec(sections[1])?.[0] ?? "";
  assert.ok(firstDiv.startsWith('<div class="cert__signrow'), "the signing row is the signing section's first div");
  assert.ok(
    /^<div[^>]*><span class="xc-cell">[\s\S]*?<\/span><span class="xc-cell"><em class="xc-lbl">التوقيع:<\/em><\/span>/.test(firstDiv),
    "and its second box is the signature",
  );

  // The current version's id, as the Archive passes it, prints this design too.
  assert.ok(
    pageOf(renderSalaryLetterArHtml(pack, 1, HR_PAPER_SALARY_LETTER_AR_V1.id)).startsWith('<article class="copy xc xc--ar xl">'),
    "asking for version 1 by its id is asking for the current letter",
  );
}

/**
 * NO TEMPLATE CAN TURN A SEAL BACK ON — in the house papers' renderer, which still draws an archived
 * version of this letter in the dress it was signed in.
 *
 * This letter used to be kept clean by an `unsealed` flag, and the flag was the guard — with it off,
 * the signature table's fallback stamped column one, which is the line somebody signs. Since
 * 2026-09-29 the renderer draws no seal at all, so the guard is now the ABSENCE of any switch: a
 * template carrying a stray `unsealed: false` (or any other property) still renders blank cells.
 */
function testNoTemplatePropertyCanBringTheSealBack() {
  const pack = buildManualHiringPack(SAMPLE, COMPANY_DETAILS_DEFAULT);
  const forced = renderHrPaperHtml(pack, 1, {
    ...HR_PAPER_SALARY_LETTER_AR_V1,
    unsealed: false,
  } as typeof HR_PAPER_SALARY_LETTER_AR_V1);
  assert.equal(
    (forced.match(/class="phx-seal"/g) ?? []).length,
    0,
    "a leftover unsealed:false must not resurrect the stamp — the renderer has no seal to draw",
  );
  assert.ok(
    !signatureCells(pageOf(forced)).some((cell) => cell.includes("phx-seal")),
    "and no signature cell is stamped",
  );
}

/**
 * THE BASE SALARY, NOT THE BASIC — the owner, 2026-09-20: "you will not put the basic, you will put
 * the base and you will call it ويتقاضى أجرًا شهريًا مقداره".
 */
function testTheLetterStatesTheBaseSalary() {
  const pack = buildManualHiringPack(SAMPLE, COMPANY_DETAILS_DEFAULT);
  const page = pageOf(renderHtml(pack));

  assert.ok(page.includes("18,000"), "the letter prints the BASE salary — the 18,000 on the record");
  assert.ok(!page.includes("12,600"), "and never the basic derived from it (70% of 18,000)");
  assert.ok(
    /<div class="xc-span xl-pay xl-pay--2">[\s\S]*?الأجر الشهري<\/span><div class="xc-fig"><b>18,000<\/b><em>جنيه<\/em>/.test(page),
    "the salary at a glance repeats the same base figure, under the sentence that states it",
  );
  assert.ok(
    page.includes("ثمانية عشر ألف"),
    "the amount is written out in Arabic words (تفقيط) — of the base",
  );
  assert.ok(page.includes("فقط لا غير"), "the words are fenced the way every other amount in this system is");
  assert.ok(page.includes("ويتقاضى أجرًا شهريًا مقداره"), "the owner's own wording, present tense for a serving employee");
  assert.ok(!page.includes("أساسي") && !page.includes("الأساسي"), "the word basic is nowhere on the page");
  assert.ok(!page.includes("صافي"), "the page never states a net salary");
  assert.ok(!page.includes("إجمالي"), "the page never states a gross salary");
}

function testNoBaseSalaryIsABlankNeverZero() {
  const { "employee.baseSalary": _dropped, ...withoutSalary } = SAMPLE;
  const pack = buildManualHiringPack(withoutSalary, COMPANY_DETAILS_DEFAULT);
  const page = pageOf(renderHtml(pack));

  assert.ok(
    page.includes('class="rule-line" data-hp-key="BASE_SALARY"'),
    "a missing salary prints a rule for a pen",
  );
  assert.ok(!page.includes("٠ جنيه") && !page.includes("0 جنيه"), "a zero on a letter to a bank says the employee is unpaid");
  assert.ok(
    page.includes('class="rule-line" data-hp-key="BASE_SALARY_WORDS"'),
    "no words are spelled out for a figure that is not there — it rules too",
  );
  assert.ok(!page.includes("xl-pay"), "and no salary strip — an empty box there would read as a zero");
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
    page.includes("وكان آخر أجر شهري يتقاضاه"),
    "and states his LAST monthly salary, in the past tense",
  );
  assert.ok(!page.includes("ويتقاضى أجرًا شهريًا"), "it never states a leaver's salary in the present tense");
  assert.ok(
    /<div class="xc-span xl-pay xl-pay--3">[\s\S]*?آخر يوم عمل[\s\S]*?آخر أجر شهري<\/span>/.test(page),
    "the strip adds the last working day and names the salary as the last one",
  );
}

/**
 * THE COPIES SENTENCE FOLLOWS THE NUMBER CHOSEN AT PRINT TIME — «تحرر من نسختين نسخة تسلم …», and
 * "based on what I tell you, you write here". It used to be a fixed "two copies" in the letterhead
 * band, a claim that was false the first time somebody printed three.
 */
function testTheCopiesSentenceFollowsTheCount() {
  const pack = buildManualHiringPack(SAMPLE, COMPANY_DETAILS_DEFAULT);
  const clauseOf = (copies: number) => pageOf(renderHtml(pack, copies));

  assert.ok(clauseOf(1).includes("من نسخة واحدة تُسلَّم لصاحب الشأن"), "one copy: it is handed over");
  assert.ok(
    clauseOf(2).includes("من نسختين، نسخة تُسلَّم لصاحب الشأن ونسخة تُحفظ بملف الخدمة"),
    "two copies: the dual, one handed over and one kept",
  );
  assert.ok(clauseOf(3).includes("من ثلاث نسخ، نسخة تُسلَّم لصاحب الشأن وباقي النسخ تُحفظ"), "three: the counted plural");
  assert.ok(clauseOf(11).includes("من 11 نسخة"), "past ten the count is in digits with the singular");
  for (const copies of [1, 3, 4]) {
    assert.ok(!clauseOf(copies).includes("نسختين"), `${copies} copies never print the dual «نسختين»`);
  }
  // Every printed copy states the same count.
  assert.equal((clauseOf(3).match(/من ثلاث نسخ/g) ?? []).length, 3, "each of the three sheets carries it");
  // The letterhead band no longer makes a copy claim of its own to contradict it.
  assert.ok(!HR_PAPER_SALARY_LETTER_AR_V1.purposeAr.includes("نسخ"), "the purpose band says nothing about copies");
  // The PDF path draws one copy and stamps the rest: it must still state the count being printed.
  const stated = renderSalaryLetterArHtml(pack, 1, null, [], 4);
  assert.ok(pageOf(stated).includes("من أربع نسخ"), "a stated count overrides the one copy drawn");
}

/**
 * ONE FULL PAGE — the owner, 2026-09-20: "instead of condensing the page with the lower half empty,
 * re-space it and fit it in one page". In the certificate's design the copy is a column one printed
 * sheet tall and the signing block takes what the words leave, so a short letter and a long one both
 * fill exactly one sheet. Measured in headless Chrome on 2026-10-28: one page each for a serving
 * employee and a leaver with a long name.
 */
function testTheLetterFillsExactlyOnePage() {
  const html = renderHtml(buildManualHiringPack(SAMPLE, COMPANY_DETAILS_DEFAULT));
  const css = [...html.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join("\n");
  assert.match(css, /\.xc \{ display: flex; flex-direction: column; \}/, "each copy is a column");
  assert.match(css, /@media print \{ \.xc \{ min-height: 296mm; \} \}/, "one sheet tall, printed — 296 mm so rounding never spills an empty sheet");
  assert.match(css, /\.xc-sign \{[^}]*flex: 1 0 auto;/, "the signing block grows into the space the words leave");
  assert.match(css, /\.xl-cells--2 \{ grid-template-columns: 1\.15fr 1fr; \}/, "two boxes share the row the certificate's three do");
  assert.ok(!/\.xl[^{]*\{[^}]*background/.test(css), "spacing only — no filled area, per the ink rule");
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
  testTheLetterWearsTheCertificatesDesignWithoutASeal();
  testNoTemplatePropertyCanBringTheSealBack();
  testTheLetterStatesTheBaseSalary();
  testNoBaseSalaryIsABlankNeverZero();
  testALeaverGetsThePastTense();
  testTheCopiesSentenceFollowsTheCount();
  testTheLetterFillsExactlyOnePage();
  testItIsWiredIn();
  testATypedInLetterAsksForTheBaseSalary();
}
