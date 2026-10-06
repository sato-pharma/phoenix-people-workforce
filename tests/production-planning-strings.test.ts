import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  ALARM_SEVERITY_LABELS,
  BASIS_LABELS,
  buildPlannerSentence,
  formatNumberLatin,
  PP,
  PRODUCTION_PLANNING_NUMBER_LOCALE,
  PRODUCTION_PLANNING_TABS,
  SUPPLIER_LABELS,
} from "../src/lib/production-planning/strings.ts";
import { stripComments } from "./support/comment-strip.ts";

/**
 * Production Planner — the Arabic stays genderless, and the digits stay Latin.
 *
 * Both primary users are women: Dr. Sahar Khalil, the R&D Manager, and Reham Elwiy, the Regulatory
 * Affairs Supervisor. Arabic marks gender on the imperative and on the second person, so the
 * ordinary way to write a UI — "اختر", "احسب", "بياناتك" — addresses a man. The whole app was swept
 * neutral in English on 2026-10-05 for exactly that reason; this is that ruling applied to a new
 * Arabic surface at birth rather than retrofitted onto it after somebody notices.
 *
 * So this file is a deny-list, not a style note. It scans every string the module can render.
 */

const STRINGS_FILE = "src/lib/production-planning/strings.ts";

/**
 * Arabic forms that address a person, each one a word this module must never use.
 *
 * Curated rather than pattern-matched, and the reason is in the near misses: the NOUN `سجل` (a log)
 * is fine and only the imperative `سجّل` is not, so the shadda is load-bearing; `لك` would match
 * inside `لكل`; `قم` would match inside `رقم`. A heuristic that got those wrong would be turned off
 * within a week, and a deny-list that is off is worse than none.
 */
const GENDERED_FORMS: readonly { form: string; why: string }[] = [
  { form: "اختر", why: "imperative — use the verbal noun" },
  { form: "اختار", why: "imperative" },
  { form: "احسب", why: "imperative — use حساب" },
  { form: "اِحسب", why: "imperative — use حساب" },
  { form: "سجّل", why: "imperative — use تسجيل (the NOUN سجل is fine)" },
  { form: "احفظ", why: "imperative — use حفظ" },
  { form: "اضغط", why: "imperative" },
  { form: "انقر", why: "imperative" },
  { form: "أدخل", why: "imperative — use إدخال" },
  { form: "اكتب", why: "imperative" },
  { form: "راجع", why: "imperative — use مراجعة" },
  { form: "تأكد", why: "imperative" },
  { form: "افتح", why: "imperative" },
  { form: "أضف", why: "imperative — use إضافة" },
  { form: "عدّل", why: "imperative — use تعديل" },
  { form: "حدّد", why: "imperative — use تحديد" },
  { form: "قم ب", why: "second-person construction" },
  { form: "أنت", why: "second person" },
  { form: "انتي", why: "second person, feminine" },
  { form: "بياناتك", why: "second-person possessive" },
  { form: "إعداداتك", why: "second-person possessive" },
  { form: "حسابك", why: "second-person possessive" },
  { form: "طلبك", why: "second-person possessive" },
  { form: "مخزونك", why: "second-person possessive" },
  { form: "استهلاكك", why: "second-person possessive" },
  { form: "عندك", why: "second person" },
  { form: "لديك", why: "second person" },
  { form: "عليك", why: "second person" },
  { form: "إليك", why: "second person" },
  { form: "تقدر", why: "second person" },
  { form: "هتقدر", why: "second person" },
  { form: "ستجد", why: "second person" },
  { form: "هتلاقي", why: "second person" },
  { form: "اخترت", why: "second person, past" },
];

/** Every renderable string in the module, with the key it came from. */
function everyString(): { key: string; value: string }[] {
  const out: { key: string; value: string }[] = [];
  for (const [key, value] of Object.entries(PP)) out.push({ key: `PP.${key}`, value });
  for (const tab of PRODUCTION_PLANNING_TABS) out.push({ key: `tab.${tab.key}`, value: tab.label });
  for (const [key, value] of Object.entries(SUPPLIER_LABELS)) out.push({ key: `supplier.${key}`, value });
  for (const [key, value] of Object.entries(BASIS_LABELS)) out.push({ key: `basis.${key}`, value });
  for (const [key, value] of Object.entries(ALARM_SEVERITY_LABELS)) out.push({ key: `severity.${key}`, value });
  return out;
}

export function runProductionPlanningStringsTests() {
  const all = everyString();
  assert.ok(all.length > 100, `the catalogue should cover the whole module, found ${all.length} strings`);

  // ── Genderless by construction ────────────────────────────────────────────────────────────────
  for (const { key, value } of all) {
    for (const { form, why } of GENDERED_FORMS) {
      assert.ok(
        !value.includes(form),
        `${key} contains "${form}" (${why}). Both primary users of this module are women: ${JSON.stringify(value)}`,
      );
    }
  }

  // The near misses, asserted so a future "tidy-up" of the deny-list cannot quietly break them.
  assert.ok(PP.stockHistory.includes("سجل"), "the NOUN سجل (a log) is correct Arabic and must stay allowed");
  assert.ok(PP.pricePerUnit.includes("لكل"), "لكل must not be caught by a rule aimed at the pronoun لك");
  assert.ok(PP.runTitle.startsWith("تسجيل"), "an action is a verbal noun: تسجيل تشغيلة, never سجّل تشغيلة");
  assert.ok(PP.calculate.startsWith("حساب"), "حساب الاحتياج, never اِحسب");
  assert.equal(PP.saved, "تم الحفظ", "an outcome is impersonal passive");
  assert.equal(PP.saveFailed, "تعذّر الحفظ", "and so is a failure");
  assert.ok(
    PP.settingsLastUpdatedBy.includes("آخر تعديل"),
    "the actor is named as a PERSON beside this label, which carries no grammatical gender at all",
  );

  // ── Nothing is truncated with an ellipsis ─────────────────────────────────────────────────────
  for (const { key, value } of all) {
    for (const bad of ["…", "..."]) {
      assert.ok(!value.includes(bad), `${key} must not truncate with an ellipsis: ${JSON.stringify(value)}`);
    }
  }

  // ── Latin digits, which means never the ar-EG locale ──────────────────────────────────────────
  assert.equal(PRODUCTION_PLANNING_NUMBER_LOCALE, "en-EG");
  // `stripComments`, never a line-by-line judgement of what is a comment: this catalogue's own
  // header names `ar-EG` while explaining why it is refused, and a filter reading how a LINE
  // STARTS cannot tell an already-open comment from code. `tests/comment-strip-ratchet.test.ts`
  // pins that for every test in this repo, and this assertion was one of its offenders.
  const code = stripComments(readFileSync(STRINGS_FILE, "utf8"));
  assert.ok(
    !code.includes('"ar-EG"'),
    'the ar-EG locale emits Arabic-Indic digits (٠١٢٣) and ج.م., and the owner chose Latin digits — so it may appear only in a comment',
  );
  // Arabic-Indic digits must not be hard-coded into a label either, and there is NO exception to
  // that. There used to be two — the sample-size hint and the per-dose basis, carved out on the
  // reasoning that a measurement spelled inside a sentence reads as prose rather than as data. The
  // browser disagreed: on 2026-10-06 the live planner showed `العينة ٤٠ مل` and `لكل جرعة ٥ مل` an inch from
  // `106,000` and `1,250`, so one screen carried both numeral systems at once, which is the whole
  // thing the owner's Latin-digit ruling exists to stop. A reader cannot tell which digits are
  // "prose" and does not care. The carve-out is gone; every string is swept.
  for (const { key, value } of all) {
    assert.ok(
      !/[٠-٩۰-۹]/.test(value),
      `${key} must not hard-code Arabic-Indic digits: the owner chose Latin digits — ${JSON.stringify(value)}`,
    );
  }
  assert.ok(
    PP.sampleUnitsHint.includes("40") && PP.sampleUnitsHint.includes("100"),
    "the sample hint states its sizes in Latin digits, beside the Latin figures the engine prints",
  );
  assert.ok(BASIS_LABELS.per_dose.includes("5"), "and so does the per-dose basis label");

  // ── The number formatter ──────────────────────────────────────────────────────────────────────
  assert.equal(formatNumberLatin("109180"), "109,180");
  assert.equal(formatNumberLatin("4120"), "4,120");
  assert.equal(formatNumberLatin("106000"), "106,000");
  assert.equal(formatNumberLatin("72.1"), "72.1");
  assert.equal(formatNumberLatin("15.52725"), "15.52725", "six decimals survive: the sheet and the screen must agree");
  assert.equal(formatNumberLatin("-28.1125"), "-28.1125", "a short run keeps its minus sign");
  assert.equal(formatNumberLatin("1250000"), "1,250,000");
  assert.equal(formatNumberLatin(BigInt(0)), "0");
  assert.equal(formatNumberLatin("8"), "8");
  assert.ok(!/[٠-٩]/.test(formatNumberLatin("109180")), "and the digits are Latin, not ٠١٢٣");

  // ── The sentence under the four tiles ─────────────────────────────────────────────────────────
  const sentence = buildPlannerSentence({
    runs: "8",
    runVolumeLitres: "1,250",
    totalVolumeLitres: "10,000",
    goodUnits: "96,000",
    goodUnitMl: "100",
    sampleUnits: "10,000",
    sampleUnitMl: "40",
    surplusBoxes: "6,000",
    shortfallBoxes: null,
  });
  assert.ok(sentence.includes("8"), "the run count is in the sentence");
  assert.ok(sentence.includes("96,000"), "and the real yield");
  assert.ok(sentence.includes("10,000"), "and the samples");
  assert.ok(
    sentence.includes("بزيادة 6,000"),
    `the surplus over the ask is SAID, not hidden — a planner asked for 100,000 that silently answers for 106,000 is the worst way to be wrong here: ${sentence}`,
  );
  for (const { form } of GENDERED_FORMS) {
    assert.ok(!sentence.includes(form), `the generated sentence must stay genderless too: ${sentence}`);
  }

  const noSamples = buildPlannerSentence({
    runs: "9",
    runVolumeLitres: "1,250",
    totalVolumeLitres: "11,250",
    goodUnits: "112,500",
    goodUnitMl: "100",
    sampleUnits: "0",
    sampleUnitMl: "40",
    surplusBoxes: "0",
    shortfallBoxes: null,
  });
  assert.ok(!noSamples.includes("عينة"), "with no samples the sentence does not mention them");
  assert.ok(!noSamples.includes("بزيادة"), "and an exact ask reports no surplus");

  const short = buildPlannerSentence({
    runs: "7",
    runVolumeLitres: "1,250",
    totalVolumeLitres: "8,750",
    goodUnits: "83,500",
    goodUnitMl: "100",
    sampleUnits: "10,000",
    sampleUnitMl: "40",
    surplusBoxes: null,
    shortfallBoxes: "6,500",
  });
  assert.ok(short.includes("بنقص 6,500"), "and one run fewer says what it leaves short");

  // ── The tabs ──────────────────────────────────────────────────────────────────────────────────
  assert.deepEqual(
    PRODUCTION_PLANNING_TABS.map((tab) => tab.key),
    ["planner", "stock", "cost", "run", "settings"],
  );
  assert.deepEqual(
    PRODUCTION_PLANNING_TABS.map((tab) => tab.label),
    ["المُخطِّط", "المخزون", "التكلفة", "تسجيل تشغيلة", "الإعدادات"],
  );
  for (const tab of PRODUCTION_PLANNING_TABS) {
    assert.ok(tab.label.trim().length > 0 && tab.label.length <= 20, `${tab.key} needs a short noun-phrase label`);
  }

  // ── The owner's three rules are visible IN THE WORDS, not only in the engine ──────────────────
  assert.ok(
    PP.sampleUnitsHint.includes("تقلل عدد العلب"),
    "the hint beside the sample field must say that samples REDUCE the bottle count — the correction he had to make on 2026-10-05",
  );
  assert.ok(
    PP.sampleUnitsHint.includes("عبوة كاملة"),
    "and that a sample still consumes a FULL packaging set",
  );
  assert.ok(PP.roundedUpNote.includes("التقريب لأعلى"), "and that whole runs round UP");
  assert.equal(
    PP.excludedUnsettled,
    "لم يُتفق على من يوردها — غير محسوبة في الشراء",
    "an unsettled material says it is not in the buy list, rather than printing a reassuring zero",
  );
  assert.ok(
    PP.fxSourceNone.includes("غير محسوبة"),
    "and a missing exchange rate says the other currency is NOT CALCULATED, never shows zero",
  );
  assert.ok(
    PP.settingsAlarmOffNotice.includes("لا يُرسل أي بريد"),
    "the settings tab says plainly that the email is off, because 'nothing sent' and 'switched off' are different answers",
  );
  assert.ok(
    PP.exportHint.includes("المعادلات"),
    "the export says it carries the formulas — the thing the owner actually asked for",
  );
}
