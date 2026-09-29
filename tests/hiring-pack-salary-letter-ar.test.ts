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
// THE ARABIC HR LETTER — the Arabic counterpart of `hiring-pack-salary-letter.test.ts`. Since
// 2026-09-20 it states the BASE salary (the English letter still states the basic), carries no
// company seal, and writes how many copies it was drawn up in from the number chosen at print time.
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
 * THE ARABIC LETTER'S LAYOUT — the certificate's one-column shape (company block, identity grid,
 * a signature table), with NO COMPANY SEAL: the owner, 2026-09-20, "remove the stamp". It was the
 * FIRST paper to lose the stamp; on 2026-09-29 he removed it from every hiring paper, so the
 * per-template `unsealed` flag this letter once carried is gone with nothing left for it to switch.
 */
function testTheLetterWearsTheCertificatesLayoutWithoutASeal() {
  const pack = buildManualHiringPack(SAMPLE, COMPANY_DETAILS_DEFAULT);
  const html = renderHtml(pack);
  const page = pageOf(html);

  assert.ok(page.includes('class="doc-ident"'), "the employee's details sit in a ruled grid");
  assert.ok(page.includes("copy--salaryLetter"), "the letter carries its own kind, not the certificate's");
  assert.equal((html.match(/class="phx-seal"/g) ?? []).length, 0, "no company seal anywhere on the letter");
  const cells = signatureCells(page);
  assert.equal(cells.length, 2, "name and title, and the signature — no stamp box");
  assert.ok(!page.includes("خاتم الشركة"), "the Company stamp label is gone with the stamp");
  assert.ok(!cells.some((cell) => cell.includes("phx-seal")), "and nothing is stamped over the signature line");
  assert.ok(!page.includes("border-radius"), "every corner square, by absence");
}

/**
 * NO TEMPLATE CAN TURN A SEAL BACK ON.
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

  assert.equal(calculateBasicSalary({ baseSalary: 18000 }), 12600);
  assert.ok(page.includes("18,000"), "the letter prints the BASE salary — the 18,000 on the record");
  assert.ok(!page.includes("12,600"), "and never the basic derived from it");
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
  const stated = renderHrPaperHtml(pack, 1, HR_PAPER_SALARY_LETTER_AR_V1, null, [], 4);
  assert.ok(pageOf(stated).includes("من أربع نسخ"), "a stated count overrides the one copy drawn");
}

/**
 * ONE FULL PAGE — the owner, 2026-09-20: "instead of condensing the page with the lower half empty,
 * re-space it and fit it in one page". Measured against the PRINTED page in headless Chrome when this
 * was written (232.8mm of content in a 246mm sheet); what is pinned here is the mechanism.
 */
function testTheLetterIsStretchedToFillItsPage() {
  const html = renderHtml(buildManualHiringPack(SAMPLE, COMPANY_DETAILS_DEFAULT));
  const css = /<style>([\s\S]*?)<\/style>/.exec(html)?.[1] ?? "";
  assert.match(css, /\.copy--salaryLetter \.doc-sheet \{ height: 246mm; \}/, "the sheet is stretched to the printable page");
  const height = Number(/\.copy--salaryLetter \.doc-sheet \{ height: (\d+)mm/.exec(css)?.[1]);
  // 297mm less the two @page margins (10.7 + 12.7) and the copy's own padding (10.7 + 12.7).
  assert.ok(height <= 250, `${height}mm must stay inside the 250.2mm printable height, or a second empty page prints`);
  assert.ok(height >= 240, "and must actually fill it — the lower half was empty before");
  assert.match(css, /\.copy--salaryLetter \.doc-body \{ font-size: 10pt;/, "set larger than the 9pt dense papers");
  assert.ok(!/copy--salaryLetter[^{]*\{[^}]*background/.test(css), "spacing only — no filled area, per the ink rule");
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
  testTheLetterWearsTheCertificatesLayoutWithoutASeal();
  testNoTemplatePropertyCanBringTheSealBack();
  testTheLetterStatesTheBaseSalary();
  testNoBaseSalaryIsABlankNeverZero();
  testALeaverGetsThePastTense();
  testTheCopiesSentenceFollowsTheCount();
  testTheLetterIsStretchedToFillItsPage();
  testItIsWiredIn();
  testATypedInLetterAsksForTheBaseSalary();
}
