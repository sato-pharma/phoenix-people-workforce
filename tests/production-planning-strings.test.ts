import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";

import {
  ALARM_SEVERITY_LABELS,
  ALARM_SEVERITY_LABELS_EN,
  BASIS_LABELS,
  BASIS_LABELS_EN,
  basisLabelsAr,
  basisLabelsEn,
  buildAlarmEmailSummary,
  buildExpiryEmailRow,
  buildExpiryEmailSummary,
  buildPlannerSentence,
  buildPlannerSentenceEn,
  buildSampleUnitsHintAr,
  buildSampleUnitsHintEn,
  coerceProductionPlanningLanguage,
  formatNumberLatin,
  packagingBoxName,
  pluralEn,
  PP,
  PP_EN,
  PRODUCTION_PLANNING_ERRORS,
  PRODUCTION_PLANNING_ERRORS_EN,
  buildReorderEmailRow,
  EXPIRY_EMAIL_COLUMNS,
  PRODUCTION_PLANNING_DEFAULT_LANGUAGE,
  PRODUCTION_PLANNING_EMAIL_EN,
  PRODUCTION_PLANNING_NUMBER_LOCALE,
  PRODUCTION_PLANNING_REFUSALS,
  PRODUCTION_PLANNING_REFUSALS_EN,
  PRODUCTION_PLANNING_TABS,
  PRODUCTION_PLANNING_TABS_EN,
  REORDER_EMAIL_COLUMNS,
  type ProductMeasure,
  productionPlanningStrings,
  reorderEmailMaterialLabel,
  requestModeLabelsAr,
  requestModeLabelsEn,
  runActualLabelAr,
  runActualLabelEn,
  runSizeLabelAr,
  runSizeLabelEn,
  saleableUnitWordAr,
  saleableUnitWordEn,
  storedPlanTitle,
  SUPPLIER_LABELS,
  SUPPLIER_LABELS_EN,
  unitsWithBoxesAr,
  unitsWithBoxesEn,
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

/** Every renderable ENGLISH string, with the key it came from. */
function everyEnglishString(): { key: string; value: string }[] {
  const out: { key: string; value: string }[] = [];
  for (const [key, value] of Object.entries(PP_EN)) out.push({ key: `PP_EN.${key}`, value });
  for (const tab of PRODUCTION_PLANNING_TABS_EN) out.push({ key: `tabEn.${tab.key}`, value: tab.label });
  for (const [key, value] of Object.entries(SUPPLIER_LABELS_EN)) out.push({ key: `supplierEn.${key}`, value });
  for (const [key, value] of Object.entries(BASIS_LABELS_EN)) out.push({ key: `basisEn.${key}`, value });
  for (const [key, value] of Object.entries(ALARM_SEVERITY_LABELS_EN)) out.push({ key: `severityEn.${key}`, value });
  for (const [key, value] of Object.entries(PRODUCTION_PLANNING_ERRORS_EN)) out.push({ key: `errEn.${key}`, value });
  return out;
}

/** Every renderable string in the module, with the key it came from. */
function everyString(): { key: string; value: string }[] {
  const out: { key: string; value: string }[] = [];
  for (const [key, value] of Object.entries(PP)) out.push({ key: `PP.${key}`, value });
  for (const tab of PRODUCTION_PLANNING_TABS) out.push({ key: `tab.${tab.key}`, value: tab.label });
  for (const [key, value] of Object.entries(SUPPLIER_LABELS)) out.push({ key: `supplier.${key}`, value });
  for (const [key, value] of Object.entries(BASIS_LABELS)) out.push({ key: `basis.${key}`, value });
  for (const [key, value] of Object.entries(ALARM_SEVERITY_LABELS)) out.push({ key: `severity.${key}`, value });
  for (const [key, value] of Object.entries(PRODUCTION_PLANNING_ERRORS)) out.push({ key: `err.${key}`, value });
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
  // The sample hint and the per-dose basis still STATE their sizes, and still in Latin digits — but
  // the sizes now come from the product instead of sitting in the sentence as literals. They had to:
  // 40 ml, 100 ml and 5 ml are Ivyronc's, and Guamusin is a powder in 5 g sachets, so the old flat
  // strings printed "مل" on a screen measuring grams. Pinned for BOTH products, so neither the Latin
  // digits nor the unit can drift back.
  const ivyronc: ProductMeasure = { dose: "5", goodUnit: "100", measureUnit: "ml", sampleUnit: "40" };
  const guamusin: ProductMeasure = { dose: "5", goodUnit: "5", measureUnit: "g", sampleUnit: "5" };

  // ── A saleable unit is not a box, and the box count rides in brackets ───────────────────────────
  // Owner, 2026-10-08: *"in alll ur calulation show sachets number and between brackets number of
  // boxes for those sachets"*, after a tile reading `10,000 علبة` sat under a sentence reading
  // `120,000 كيس`.
  assert.equal(saleableUnitWordAr("g"), "كيس", "a powder's saleable unit is a sachet");
  assert.equal(saleableUnitWordAr("ml"), "علبة", "and the syrup's is a box, 1:1 with its bottle");
  assert.equal(saleableUnitWordEn("g"), "sachet");
  assert.equal(saleableUnitWordEn("ml"), "box");

  // 🔴 `box + "s"` IS "boxs", AND THAT REWRITES IVYRONC'S PINNED SENTENCE further down this file.
  assert.equal(pluralEn("box"), "boxes", "the one plural that a bare +s gets wrong");
  assert.equal(pluralEn("sachet"), "sachets");

  const boxed = { boxes: "10,000", measureUnit: "g", units: "120,000", unitsPerBox: "12" } as const;
  assert.equal(unitsWithBoxesAr(boxed), "120,000 كيس (10,000 علبة)", "his bracket, exactly as asked");
  assert.equal(unitsWithBoxesEn(boxed), "120,000 sachets (10,000 boxes)");

  // 🔴 AND IT IS DROPPED AT ONE UNIT A BOX, or Ivyronc reads "106,000 علبة (106,000 علبة)" — the same
  // number printed twice, which is worse than the ambiguity the bracket exists to remove. The test is
  // `unitsPerBox`, never the measure unit.
  const flat = { boxes: "106,000", measureUnit: "ml", units: "106,000", unitsPerBox: "1" } as const;
  assert.equal(unitsWithBoxesAr(flat), "106,000 علبة", "no bracket when a box holds one unit");
  assert.equal(unitsWithBoxesEn(flat), "106,000 boxes");
  assert.ok(
    !unitsWithBoxesAr(flat).includes("("),
    "nothing in brackets at all on Ivyronc — a redundant bracket is a regression, not a cosmetic",
  );
  // A powder in a one-sachet box takes no bracket either, and a syrup two to a box takes one: the
  // rule is about PACKING, not about which unit the product is measured in.
  assert.equal(
    unitsWithBoxesAr({ boxes: "500", measureUnit: "g", units: "500", unitsPerBox: "1" }),
    "500 كيس",
  );
  assert.equal(
    unitsWithBoxesAr({ boxes: "250", measureUnit: "ml", units: "500", unitsPerBox: "2" }),
    "500 علبة (250 علبة)",
  );

  // ── "حجم التشغيلة" is a VOLUME, and the powder is weighed ───────────────────────────────────────
  // Owner, 2026-10-08: *"1 run is 100kg not liter"*, then *"batch ( run size ) 100kg"*.
  assert.equal(runSizeLabelAr("ml"), "حجم التشغيلة", "the syrup keeps the volume noun");
  assert.equal(runSizeLabelAr("g"), "وزن التشغيلة", "and the powder is weighed, not poured");
  assert.equal(runSizeLabelEn("ml"), "Run volume");
  assert.equal(runSizeLabelEn("g"), "Batch size", "his own word for it");

  // ── The run tab's noun moves too, instead of carrying a suffix ──────────────────────────────────
  // 🔴 A SUFFIX CONTRADICTS ITSELF: "Boxes actually produced (sachet)" in four words.
  assert.equal(runActualLabelAr("g"), "الأكياس الناتجة فعليًا");
  assert.equal(runActualLabelAr("ml"), PP.runActualGoodUnits, "Ivyronc's label does not move");
  assert.equal(runActualLabelEn("g"), "Sachets actually produced");
  assert.equal(runActualLabelEn("ml"), PP_EN.runActualGoodUnits);
  for (const label of [runActualLabelAr("g"), runActualLabelEn("g")]) {
    assert.ok(!label.includes("("), "and it is a noun, never a bracketed unit hung off the old one");
  }

  // ── The request modes still mean BOXES, and say what a box holds ────────────────────────────────
  // 🔴 THE ONE CHANGE NOT MADE HERE, DELIBERATELY. `resolveRunGeometry`'s `total_boxes` reads the
  // typed figure as BOXES, so renaming the label to sachets would put his 120,000 through as 72 runs
  // instead of 6. The unit stays what the engine reads; the label says what is inside a box.
  const guaModes = requestModeLabelsAr({ measureUnit: "g", unitsPerBox: "12" });
  assert.ok(guaModes.total.startsWith(PP.requestModeTotalBoxes), "the box wording is untouched");
  assert.ok(guaModes.total.includes("12 كيس في العلبة"), "and the box's contents are spelled out");
  assert.ok(!guaModes.total.includes("إجمالي الأكياس"), "🔴 never renamed to a sachet count");
  const ivyModes = requestModeLabelsAr({ measureUnit: "ml", unitsPerBox: "1" });
  assert.equal(ivyModes.total, PP.requestModeTotalBoxes, "Ivyronc's modes are byte-identical");
  assert.equal(ivyModes.goodUnits, PP.requestModeGoodUnits);
  assert.equal(
    requestModeLabelsEn({ measureUnit: "ml", unitsPerBox: "1" }).total,
    PP_EN.requestModeTotalBoxes,
  );
  assert.ok(
    requestModeLabelsEn({ measureUnit: "g", unitsPerBox: "12" }).total.endsWith("12 sachets per box"),
  );

  // ── The sentence carries the bracket, and Ivyronc's is unmoved ──────────────────────────────────
  const sentenceParts = {
    goodUnitMl: "5",
    goodUnits: "120,000",
    measureUnit: "g",
    runs: "6",
    runVolumeLitres: "100",
    sampleUnitMl: "5",
    sampleUnits: "0",
    shortfallBoxes: null,
    surplusBoxes: null,
    totalBoxes: "10,000",
    totalVolumeLitres: "600",
    unitsPerBox: "12",
  } as const;
  assert.equal(
    buildPlannerSentence(sentenceParts),
    "6 تشغيلة × 100 كجم = 600 كجم — 120,000 كيس (10,000 علبة) 5 جم",
    "the whole Guamusin sentence, in kilograms and sachets",
  );
  assert.equal(
    buildPlannerSentenceEn(sentenceParts),
    "6 runs × 100 kg = 600 kg — 120,000 sachets (10,000 boxes) of 5 g",
  );
  // 🔴 THE BRACKET IS BUILT FROM THE SALEABLE COUNT, NOT FROM `totalBoxes`. `totalBoxes` includes the
  // samples' own boxes, so on an order WITH samples it is larger than the saleable figure — printing
  // it beside `goodUnits` would read as that figure's equivalent and quietly overstate it.
  const withSamples = buildPlannerSentence({
    ...sentenceParts,
    goodUnits: "108,000",
    sampleUnits: "12,000",
    totalBoxes: "10,000",
  });
  assert.ok(withSamples.includes("108,000 كيس (9,000 علبة)"), `9,000 and not 10,000 — ${withSamples}`);
  assert.ok(!withSamples.includes("108,000 كيس (10,000"), "never the sample-inclusive box count");

  // 🔴 A PART-BOX IS STILL A BOX IN THE BRACKET TOO (owner, 2026-10-24). Saginkgo's 1,000 boxes with
  // 100 samples yield 29,500 capsules, and the engine's total of 1,084 is 984 of them plus 100 sample
  // boxes. A floor here printed 983 on production on 3 Nov 2026, beside that total.
  const saginkgoParts = {
    goodUnitMl: "300",
    goodUnits: "29,500",
    measureUnit: "mg_capsule",
    runs: "1",
    runVolumeLitres: "9",
    sampleUnitMl: "1,500",
    sampleUnits: "100",
    shortfallBoxes: null,
    surplusBoxes: "84",
    totalBoxes: "1,084",
    totalVolumeLitres: "9",
    unitsPerBox: "30",
  } as const;
  assert.equal(
    buildPlannerSentence(saginkgoParts),
    "1 تشغيلة × 9 كجم = 9 كجم — 29,500 كبسولة (984 علبة) 300 مجم و 100 عينة 1,500 مجم، بزيادة 84 علبة عن المطلوب",
    "the Arabic bracket rounds a part-box up, and the capsule word stays singular after 29,500",
  );
  assert.equal(
    buildPlannerSentenceEn(saginkgoParts),
    "1 run × 9 kg = 9 kg — 29,500 capsules (984 boxes) of 300 mg and 100 samples of 1,500 mg, 84 boxes over the request",
    "the English bracket rounds it up as well",
  );

  // The hint's plural belongs to that one phrase: three to ten take it, and no other wording moves.
  const saginkgoMeasure: ProductMeasure = {
    dose: "300",
    goodUnit: "300",
    measureUnit: "mg_capsule",
    sampleUnit: "1,500",
    unitsInOwnSampleBox: "5",
  };
  assert.ok(buildSampleUnitsHintAr(saginkgoMeasure).includes("فيها 5 كبسولات "), "five capsules take the plural");
  assert.ok(
    buildSampleUnitsHintAr({ ...saginkgoMeasure, unitsInOwnSampleBox: "12" }).includes("فيها 12 كبسولة "),
    "and twelve take the singular, so the word follows the count",
  );
  assert.equal(saleableUnitWordAr("mg_capsule"), "كبسولة", "the shared capsule word stays singular");
  assert.ok(
    requestModeLabelsAr({ measureUnit: "mg_capsule", unitsPerBox: "30" }).total.includes("30 كبسولة في العلبة"),
    "and the request label keeps reading through it",
  );
  assert.equal(
    buildSampleUnitsHintAr(ivyronc),
    "العينة 40 مل من نفس حجم التشغيلة — تقلل عدد الوحدات 100 مل وتستهلك عبوة كاملة",
    "Ivyronc's hint does not move",
  );
  assert.equal(
    buildSampleUnitsHintAr(guamusin),
    "العينة 5 جم من نفس حجم التشغيلة — تقلل عدد الوحدات 5 جم وتستهلك عبوة كاملة",
    "nor does Guamusin's",
  );
  assert.equal(
    buildSampleUnitsHintAr({ dose: "155", goodUnit: "155", measureUnit: "mg", sampleUnit: "155" }),
    "العينة 155 مجم من نفس حجم التشغيلة — تقلل عدد الوحدات 155 مجم وتستهلك عبوة كاملة",
    "nor a tablet's",
  );

  const ivyHint = buildSampleUnitsHintAr(ivyronc);
  assert.ok(
    ivyHint.includes("40 مل") && ivyHint.includes("100 مل"),
    `the sample hint states its sizes in Latin digits, beside the Latin figures the engine prints — ${JSON.stringify(ivyHint)}`,
  );
  const ivyDose = basisLabelsAr(ivyronc).per_dose;
  assert.equal(ivyDose, "لكل جرعة 5 مل", "and so does the per-dose basis label");

  // The unit is matched WITH its figure — "5 جم", never a bare "مل" — because this file's own
  // deny-list header is a warning about exactly that: "لك" hides inside "لكل", and "مل" hides inside
  // "كاملة", which every one of these sentences ends with. A bare substring test here passes on the
  // Arabic and fails on the comment.
  const gramHint = buildSampleUnitsHintAr(guamusin);
  assert.ok(
    gramHint.includes("5 جم") && !gramHint.includes("5 مل"),
    `a product measured by weight states grams, never millilitres — ${JSON.stringify(gramHint)}`,
  );
  const gramDose = basisLabelsAr(guamusin).per_dose;
  assert.ok(
    gramDose.includes("5 جم") && !gramDose.includes("5 مل"),
    `and the per-dose label follows the product's own measure unit — ${gramDose}`,
  );

  // Both facts again on the English side, which has its own pair of builders.
  const ivyHintEn = buildSampleUnitsHintEn(ivyronc);
  assert.ok(
    ivyHintEn.includes("40 ml") && ivyHintEn.includes("100 ml"),
    `the English sample hint states the same two sizes — ${JSON.stringify(ivyHintEn)}`,
  );
  assert.equal(basisLabelsEn(ivyronc).per_dose, "per 5 ml dose");
  assert.equal(basisLabelsEn(guamusin).per_dose, "per 5 g dose");

  // The generic halves carry no measurement at all, which is what makes them product-agnostic — and
  // is why the Arabic-digit sweep above can read them without a carve-out.
  assert.equal(BASIS_LABELS.per_dose, "لكل جرعة");
  assert.ok(!/\d/.test(BASIS_LABELS.per_dose), "the generic per-dose label states no size of its own");
  assert.ok(!/\d/.test(PP.sampleUnitsHint), "nor does the generic sample hint");

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
  // His 2026-10-05 correction was about the MEANING — that samples come out of the run and so REDUCE
  // what can be sold — and that is pinned on the generic sentence. What the reduced thing is CALLED
  // follows the product: "العلب" was a bottle count, and Guamusin's saleable unit is a sachet, so the
  // noun is "الوحدات" and the size beside it is the product's own.
  assert.ok(
    PP.sampleUnitsHint.includes("تقلل عدد الوحدات"),
    "the hint beside the sample field must say that samples REDUCE the saleable-unit count — the correction he had to make on 2026-10-05",
  );
  assert.ok(
    PP.sampleUnitsHint.includes("عبوة كاملة"),
    "and that a sample still consumes a FULL packaging set",
  );
  for (const measure of [ivyronc, guamusin]) {
    assert.ok(
      buildSampleUnitsHintAr(measure).includes("تقلل عدد الوحدات"),
      "and the built sentence keeps it for every product, not only the one the string was written for",
    );
    assert.ok(buildSampleUnitsHintEn(measure).includes("reduces the"), "the English sentence says the same thing");
  }
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

  // ── The toggle: two languages, and the English half is a FULL catalogue ───────────────────────
  //
  // The owner chose the language with a toggle (2026-10-06, his own words: he wants the module in
  // English or Arabic and chooses by switching one). So English is not a courtesy translation of a
  // few headings — it is a second complete screen, and a key present in one catalogue and missing
  // from the other renders one Arabic word in the middle of an English page. The type already makes
  // that a compile error; this asserts it at run time too, because a `Record` can be satisfied with
  // an empty string.
  const english = everyEnglishString();
  const arabicKeys = Object.keys(PP).sort();
  const englishKeys = Object.keys(PP_EN).sort();
  assert.deepEqual(englishKeys, arabicKeys, "every Arabic key has an English string and the reverse");
  // The SERVER's validation messages are the same promise: a refusal is the one thing a reader only
  // ever sees when something has already gone wrong, and an Arabic sentence arriving on an English
  // screen at that moment reads as a broken page. Every message the service can throw is in both.
  assert.deepEqual(
    Object.keys(PRODUCTION_PLANNING_ERRORS_EN).sort(),
    Object.keys(PRODUCTION_PLANNING_ERRORS).sort(),
    "every server validation message exists in both languages",
  );
  assert.ok(
    Object.keys(PRODUCTION_PLANNING_ERRORS).length >= 18,
    `the service throws more messages than this catalogue holds — found ${Object.keys(PRODUCTION_PLANNING_ERRORS).length}`,
  );
  // And the count is not the guard — the SOURCE is. A new throw site written as a literal would
  // pass every assertion above while being the exact defect they exist to stop, so the service is
  // scanned for one: `errorsFor(body).<key>` is the only way a message reaches a reader from there.
  //
  // IT READS BACKTICKS AS WELL AS QUOTES, and that is not tidiness. The first version matched only
  // `"..."`, and the two refusals that NAME A MATERIAL were written as template literals — so they
  // sailed through every assertion above and shipped Arabic to an English reader on the exact two
  // refusals that tell somebody what to go and fix. Found by the access sweep, 2026-10-06. A
  // sentence that interpolates belongs in `refusals`, which is why that half of the bundle exists.
  const serviceCode = stripComments(readFileSync("src/lib/production-planning/service.ts", "utf8"));
  const literalThrows = [
    ...serviceCode.matchAll(/new ProductionPlanningInputError\(\s*"([^"]*)"/g),
    ...serviceCode.matchAll(/new ProductionPlanningInputError\(\s*`([^`]*)`/g),
  ]
    .map((match) => match[1] ?? "")
    .filter((message) => /[\u0600-\u06FF]/.test(message));
  assert.deepEqual(
    literalThrows,
    [],
    `every server message comes from the catalogue, so it exists in both languages — found ${literalThrows.length} written as an Arabic literal`,
  );
  // The stored plan TITLE is the one reader-visible string that stays Arabic whoever saves it
  // (owner, 2026-10-06, asked directly: "pin the stored plan title as Arabic"). It is a stored row
  // both readers meet later in the same Plans list, so following the saver would mix two languages
  // in one list. This pin is here so a later session cannot read it as a hole the guard above
  // missed and "fix" it onto the bundle — which is exactly how a settled ruling gets undone.
  //
  // 🔴 Pinned by the VALUE, not by the source text. Until 2026-10-06 this asserted that
  // `service.ts` still CONTAINED a particular template literal, which is a weaker thing than it
  // looks: a rewrite that reads the bundle can still satisfy a regex, prettier reflowing the line
  // breaks the pin while the behaviour is untouched, and the assertion never once evaluated the
  // string the database receives. `storedPlanTitle` exists so this can assert the string itself.
  assert.equal(
    storedPlanTitle("شراب أيفيرونك", "3"),
    "شراب أيفيرونك — 3 تشغيلة",
    "the stored plan title is <product> — <runs> تشغيلة, in Arabic, built without consulting any language",
  );
  // The ruling is "Arabic WHOEVER saves it", so the value must not vary with the toggle. The
  // function takes no language and cannot, which is the point — this asserts the English unit word
  // is absent rather than trusting the signature, because a later edit could thread one through.
  assert.ok(
    !storedPlanTitle("Ivyronc syrup", "3").includes(PP_EN.unitRuns),
    `the stored title must never carry the English unit word "${PP_EN.unitRuns}" — the Plans list is one language for both readers`,
  );
  assert.equal(
    storedPlanTitle("شراب أيفيرونك", "3"),
    storedPlanTitle("شراب أيفيرونك", "3"),
    "the stored title depends only on its arguments",
  );
  // The figure is passed through EXACTLY as savePlan formatted it. Its `runs` is already a
  // `formatNumberLatin` string, so re-formatting here would be a second spelling of the module's
  // Latin-digit rule — and that rule only ever breaks one way, a `toLocaleString` under an Arabic
  // locale emitting ٠١٢٣. A separator-carrying figure makes a silent re-format visible.
  assert.equal(
    storedPlanTitle("شراب أيفيرونك", "1,200"),
    "شراب أيفيرونك — 1,200 تشغيلة",
    "the runs figure is stored exactly as savePlan formatted it — this function must not re-format it",
  );
  // And the row really is built from that function. Without this, `savePlan` could go back to
  // interpolating the title inline and every value assertion above would still pass while the
  // database received something else. This is the one fingerprint worth keeping, and it is short
  // enough to survive a reflow of the line.
  assert.match(
    serviceCode,
    /storedPlanTitle\(result\.productNameAr, result\.runs\)/,
    "savePlan must store the title storedPlanTitle builds, not one it re-derives inline",
  );
  // 🔴 And it is UNCONDITIONAL. Until 2026-10-06 that line began with a fallback off the request
  // body, so the ruling — Arabic whoever saves it — held only because no caller happens to send
  // that field: anyone holding `production_planning:create` could store a title in any language,
  // and a screen that later added a title box would have broken the rule with every assertion
  // above still green. The owner dropped the override outright. This has to be a source check,
  // because `savePlan` needs Supabase in hand and cannot be called from a test; it is safe against
  // its own documentation because `serviceCode` is stripped of comments first, so this paragraph
  // is not part of what is matched.
  assert.ok(
    !/body\.title/.test(serviceCode),
    "savePlan must not read a title off the request body — the stored plan title is always the Arabic one, whoever saves it (owner, 2026-10-06)",
  );

  // 🔴 And the same hole, one layer up: no ROUTE in this module may take a title either.
  //
  // `savePlan` ignoring `body.title` closes the writer. It does not stop a future route from
  // accepting a title and finding some other way to put it on the row — and that is exactly the
  // shape the assertion above just retired: a rule that holds only because nothing happens to
  // exercise it. All eleven routes were clean when this was written (the single mention of
  // "title" in the whole folder is a comment in `workbook/route.ts` about an Arabic-titled FILE),
  // so this is a ratchet at zero, not a cleanup: it costs nothing today and refuses the first
  // route that reopens the hole.
  //
  // If a route one day genuinely needs a plan's title in a RESPONSE, it gets it from the service's
  // own shape, which builds it — it never names the field itself. What this refuses is a route
  // that learns the word `title` at all, because at the route layer the only way to learn it is
  // from the request.
  const routeDir = "app/api/production-planning";
  const routeFiles = readdirSync(routeDir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name === "route.ts")
    .map((entry) => `${entry.parentPath}/${entry.name}`.replaceAll("\\", "/"));
  // Guard the guard. A renamed folder would otherwise leave this passing over an empty list for
  // ever — the same vacuous-pass trap the nav-href sweep floors against.
  assert.ok(
    routeFiles.length >= 8,
    `the production-planning route sweep looks broken: found only ${routeFiles.length} route.ts files under ${routeDir}`,
  );
  const routesNamingTitle = routeFiles.filter((file) =>
    /\btitle\b/i.test(stripComments(readFileSync(file, "utf8"))),
  );
  assert.deepEqual(
    routesNamingTitle,
    [],
    `no production-planning route may accept a title field — the stored plan title is always the Arabic one, whoever saves it (owner, 2026-10-06), and a route that names \`title\` is reading one off the request:\n  ${routesNamingTitle.join("\n  ")}`,
  );

  // The refusals that name a material: present in both languages, different in both, and each owning
  // its own list separator — Arabic joins on the Arabic comma, English on a plain one.
  const twoMaterials = ["Ivy extract", "Sorbitol"] as const;
  assert.notEqual(
    PRODUCTION_PLANNING_REFUSALS.unsettledSuppliers(twoMaterials),
    PRODUCTION_PLANNING_REFUSALS_EN.unsettledSuppliers(twoMaterials),
    "the unsettled-supplier refusal must differ between the languages",
  );
  assert.ok(
    PRODUCTION_PLANNING_REFUSALS.unsettledSuppliers(twoMaterials).includes("\u060C "),
    "the Arabic refusal joins its material list on the Arabic comma",
  );
  for (const built of [
    PRODUCTION_PLANNING_REFUSALS_EN.unsettledSuppliers(["Sorbitol"]),
    PRODUCTION_PLANNING_REFUSALS_EN.closingOverOpening("Sorbitol"),
  ]) {
    assert.ok(!/[\u0600-\u06FF]/.test(built), `the English refusal carries no Arabic: ${built}`);
  }
  for (const lang of ["ar", "en"] as const) {
    assert.equal(
      typeof productionPlanningStrings(lang).refusals.closingOverOpening,
      "function",
      `the ${lang} bundle must carry the refusals, or a call site reaches for the other language`,
    );
  }

  assert.ok(arabicKeys.length > 150, `the catalogue should be the whole module, found ${arabicKeys.length} keys`);
  for (const { key, value } of english) {
    assert.ok(value.trim().length > 0, `${key} is empty — a blank label is a hole in the English screen`);
  }

  // No Arabic in the English half. This is the one that catches a key copied across and left
  // untranslated, which the key-parity check above cannot see.
  for (const { key, value } of english) {
    assert.ok(
      !/[\u0600-\u06FF]/.test(value),
      `${key} still carries Arabic text: ${JSON.stringify(value)}`,
    );
  }

  // And the two rules that hold whatever language is showing.
  for (const { key, value } of english) {
    for (const bad of ["…", "..."]) {
      assert.ok(!value.includes(bad), `${key} must not truncate with an ellipsis: ${JSON.stringify(value)}`);
    }
    assert.ok(!/[٠-٩۰-۹]/.test(value), `${key} must not carry Arabic-Indic digits: ${JSON.stringify(value)}`);
  }

  // ── The bundle a surface actually reads ───────────────────────────────────────────────────────
  assert.equal(PRODUCTION_PLANNING_DEFAULT_LANGUAGE, "ar", "Arabic is the language the owner specified the module in");
  const ar = productionPlanningStrings("ar");
  const en = productionPlanningStrings("en");
  assert.equal(ar.lang, "ar");
  assert.equal(ar.dir, "rtl");
  assert.equal(ar.t, PP, "the Arabic bundle serves the Arabic catalogue itself, never a copy that can drift");
  assert.equal(en.lang, "en");
  assert.equal(en.dir, "ltr", "English is a LEFT-TO-RIGHT layout, not Arabic with English words in it");
  assert.equal(en.t, PP_EN);
  assert.equal(
    en.fontStack,
    undefined,
    "an English page uses the app's own type — an Arabic-first face stack would make it read as a different app",
  );
  assert.ok(ar.fontStack && ar.fontStack.length > 0, "and the Arabic one names its own faces");
  assert.equal(ar.unitLabel("litre"), ar.t.unitLitre);
  assert.equal(en.unitLabel("litre"), en.t.unitLitre);
  assert.equal(ar.errors, PRODUCTION_PLANNING_ERRORS);
  assert.equal(en.errors, PRODUCTION_PLANNING_ERRORS_EN);

  // An unknown stored value falls back to Arabic rather than to a blank screen: the choice lives in
  // `localStorage`, which anything can write, and `?lang=` on the export route is a query string.
  assert.equal(coerceProductionPlanningLanguage("en"), "en");
  assert.equal(coerceProductionPlanningLanguage("ar"), "ar");
  for (const junk of [null, undefined, "", "EN", "fr", "ar-EG", 7, {}, []]) {
    assert.equal(
      coerceProductionPlanningLanguage(junk),
      "ar",
      `an unreadable language must fall back to Arabic, not render nothing: ${JSON.stringify(junk)}`,
    );
  }

  // ── The English tabs and the English sentence ────────────────────────────────────────────────
  assert.deepEqual(
    PRODUCTION_PLANNING_TABS_EN.map((tab) => tab.key),
    PRODUCTION_PLANNING_TABS.map((tab) => tab.key),
    "the same five tabs in the same order — the toggle changes the words, never the module",
  );
  for (const tab of PRODUCTION_PLANNING_TABS_EN) {
    assert.ok(tab.label.trim().length > 0 && tab.label.length <= 24, `${tab.key} needs a short English label`);
  }

  const sentenceEn = buildPlannerSentenceEn({
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
  assert.ok(!/[\u0600-\u06FF]/.test(sentenceEn), `the English sentence carries no Arabic: ${sentenceEn}`);
  assert.ok(sentenceEn.includes("8") && sentenceEn.includes("96,000") && sentenceEn.includes("10,000"));
  assert.ok(
    sentenceEn.includes("6,000"),
    `the surplus over the ask is SAID in English too, for the same reason: ${sentenceEn}`,
  );
  const shortEn = buildPlannerSentenceEn({
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
  assert.ok(shortEn.includes("6,500"), `and one run fewer says what it leaves short: ${shortEn}`);
  const noSamplesEn = buildPlannerSentenceEn({
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
  assert.ok(!noSamplesEn.includes("sample"), `with no samples the English sentence does not mention them: ${noSamplesEn}`);

  // ── Names follow the language too (owner, 2026-10-08) ─────────────────────────────────────────
  //
  // "If English, every single Arabic word" - the active and inactive constituents, the product and
  // the stores included. Every product, material and location stores BOTH names, so the screen picks
  // one rather than translating, and the workspace and the workbook may never read `nameAr`
  // directly: that single property access is how an English screen came to print Arabic material
  // names under English headings.
  const named = { nameAr: "مستخلص أوراق اللبلاب", nameEn: "Ivy leaf extract" };
  assert.equal(productionPlanningStrings("ar").name(named), named.nameAr, "Arabic reads the Arabic name");
  assert.equal(productionPlanningStrings("en").name(named), "Ivy leaf extract", "English reads the English name");
  assert.equal(
    productionPlanningStrings("en").name({ nameAr: "سوربيتول", nameEn: "  " }),
    "سوربيتول",
    "a blank English name falls back to the Arabic one rather than to an empty cell",
  );
  for (const file of [
    "src/components/production-planning/production-planning-workspace.tsx",
    "src/lib/production-planning/workbook.ts",
  ]) {
    assert.ok(
      !stripComments(readFileSync(file, "utf8")).includes(".nameAr"),
      `${file} reads .nameAr directly — use S.name(item) so the English view shows the English name`,
    );
  }

  // The language switch names the Arabic option in the language being read, and the workspace file
  // holds NO Arabic character in code at all: every word on screen comes from a catalogue, so an
  // Arabic literal in the component is a word the English view cannot translate.
  assert.equal(PP.languageArabic, "العربية", "the Arabic screen labels the option in Arabic script");
  assert.equal(PP_EN.languageArabic, "Arabic", "the English screen labels it with the word Arabic");
  const arabicLetter = new RegExp(`[${String.fromCharCode(0x600)}-${String.fromCharCode(0x6ff)}]`);
  assert.ok(
    !arabicLetter.test(
      stripComments(readFileSync("src/components/production-planning/production-planning-workspace.tsx", "utf8")),
    ),
    "the workspace component holds an Arabic literal - route it through the string catalogue",
  );

  // ── BOTH ALARM EMAILS ARE ENGLISH, WHICHEVER WAY THE TOGGLE IS SET ───────────────────────────
  //
  // The owner, 2026-10-09, reading the Arabic reorder alarm in his own inbox: "stop fucking using
  // arabic in the production planner never never never use arabic in it again all english
  // everything". Both alarms were Arabic by an earlier decision and THIS BLOCK IS ITS REVERSAL: the
  // toggle is a screen preference, an email has four other readers, and neither email may read the
  // Arabic catalogue again — not the summary, not a column heading, not one severity word.
  const emailSummary = buildAlarmEmailSummary({ productName: PP_EN.moduleTitle, count: "3" });
  const expirySummary = buildExpiryEmailSummary({ productName: "Ivyronc", count: "1" });
  const reorderRow = buildReorderEmailRow({
    coverRuns: "0.706",
    heldBoxes: "1,176",
    heldText: "14.12",
    leadTimeDays: "30",
    materialName: "Paracetamol milled",
    perRunBoxes: "1,666",
    perRunText: "20",
    severityLabel: ALARM_SEVERITY_LABELS_EN.below_threshold,
    tone: "warning",
    unitLabel: "kg",
  });
  const expiryRow = buildExpiryEmailRow({
    daysNote: "12 days left",
    expiryDate: "2027-04-30",
    heldText: "40",
    locationName: "Sato store",
    materialName: "Ivy extract",
    severityLabel: "Expires very soon",
    tone: "warning",
    unitLabel: "kg",
  });
  const emailStrings = [
    emailSummary,
    expirySummary,
    PP_EN.alarmEmailSubject,
    PP_EN.alarmEmailStatus,
    PP_EN.expiryEmailSubject,
    PP_EN.expiryEmailStatus,
    ...Object.values(PRODUCTION_PLANNING_EMAIL_EN),
    ...REORDER_EMAIL_COLUMNS.map((column) => column.label),
    ...EXPIRY_EMAIL_COLUMNS.map((column) => column.label),
    ...[...reorderRow, ...expiryRow].flatMap((cell) => [cell.text, cell.sub ?? "", cell.note ?? ""]),
  ];
  for (const value of emailStrings) {
    assert.ok(
      !/[\u0600-\u06FF]/.test(value),
      `the production planner emails are English end to end (owner, 2026-10-09): ${JSON.stringify(value)}`,
    );
  }

  // The other half of the same instruction ("also add quantities"): what is held and what one run
  // needs are columns of their own, in the same unit, so they can be read against each other.
  assert.equal(REORDER_EMAIL_COLUMNS.length, 4, "four columns — five overflowed a 375px screen, so lead time rides under cover");
  assert.equal(reorderRow[1]?.text, "14.12 kg", "the held quantity carries its unit");
  assert.equal(reorderRow[2]?.text, "20 kg", "the quantity one run needs is a column of its own");
  assert.equal(reorderRow[3]?.text, "0.706 runs", "cover names its own unit, since the heading no longer can");
  assert.equal(reorderRow[3]?.sub, "30 days lead time", "the lead time rides under the cover figure");

  // "put quantities in kg and number of boxes" (owner, 2026-10-09) — boxes are what he counts in.
  assert.equal(reorderRow[1]?.sub, "1,176 boxes", "what the held stock still makes, in boxes");
  assert.equal(reorderRow[2]?.sub, "1,666 boxes", "what one run makes, in boxes");
  assert.equal(
    buildReorderEmailRow({
      coverRuns: "1",
      heldBoxes: "90",
      heldText: "90",
      leadTimeDays: "1",
      materialName: "Packaging box",
      perRunBoxes: "1,666",
      perRunText: "1,666",
      severityLabel: ALARM_SEVERITY_LABELS_EN.below_threshold,
      tone: "warning",
      unitLabel: "pcs",
    })[2]?.sub,
    undefined,
    "a material that goes one to a box does not repeat its own figure underneath itself",
  );
  const noLeadTime = buildReorderEmailRow({
    coverRuns: "0",
    heldBoxes: "0",
    heldText: "0",
    leadTimeDays: null,
    materialName: "Sodium saccharin",
    perRunBoxes: "1,666",
    perRunText: "4.1",
    severityLabel: ALARM_SEVERITY_LABELS_EN.out_of_stock,
    tone: "danger",
    unitLabel: "kg",
  });
  assert.equal(
    noLeadTime[3]?.sub,
    PRODUCTION_PLANNING_EMAIL_EN.notKnown,
    "a material with no lead time says so in words, never an empty cell and never a zero",
  );
  assert.equal(noLeadTime[3]?.text, "0 runs", "no cover at all is still stated in runs");

  // The two sweeps must read the ENGLISH catalogue. A `PP.` beside them is how the Arabic comes back.
  for (const file of ["src/lib/production-planning/reorder-sweep.ts", "src/lib/production-planning/expiry-sweep.ts"]) {
    const source = stripComments(readFileSync(file, "utf8"));
    assert.ok(!/\bPP\./.test(source), `${file} reads the Arabic catalogue (PP.) \u2014 these two emails are English`);
    assert.ok(!/nameAr\b/.test(source), `${file} reads .nameAr \u2014 an email row must carry the English name`);
    assert.ok(
      !/[\u0600-\u06FF]/.test(source),
      `${file} holds an Arabic literal \u2014 nothing in these two files may be Arabic again`,
    );
  }

  // And the two stored TEMPLATES, which carry the greeting, the closing and the preview line: the
  // sweeps can be perfect English and the email still open in Arabic.
  const templateSource = readFileSync("src/lib/email-templates/service.ts", "utf8");
  for (const key of ["production_planning_reorder", "production_planning_expiry"]) {
    const start = templateSource.indexOf(`\n  ${key}: {\n    bodyHtml`);
    assert.notEqual(start, -1, `templateDefaults is missing ${key}`);
    const block = templateSource.slice(start, templateSource.indexOf("\n  },\n", start));
    assert.ok(!/[\u0600-\u06FF]/.test(block), `the ${key} template default is still Arabic: ${block}`);
    assert.ok(!/dir="rtl"/.test(block), `the ${key} template default still forces right-to-left`);
  }

  assert.ok(
    !/[\u0600-\u06FF]/.test(emailSummary),
    `the reorder email's own sentence must be English — the toggle is a screen preference: ${emailSummary}`,
  );

  // The owner, 2026-10-08: the packaging material is stored as `Box` / `علبة`, and the email also says
  // boxes for the product count — so the packaging ROW is spelled out in the email, as in the export.
  // Every other material keeps its stored name; the email takes the ENGLISH side of both.
  assert.equal(reorderEmailMaterialLabel("CARTON", "Box"), "Packaging box", "the packaging row is spelled out in the email");
  assert.equal(reorderEmailMaterialLabel("STICKER", "Sticker"), "Sticker", "any other material keeps its stored name");
  assert.equal(packagingBoxName("ar"), "علبة التغليف");
  assert.equal(packagingBoxName("en"), "Packaging box");
  assert.ok(!/[؀-ۿ]/.test(packagingBoxName("en")), "the English packaging name carries no Arabic");
  const sweepSource = stripComments(readFileSync("src/lib/production-planning/reorder-sweep.ts", "utf8"));
  assert.ok(
    sweepSource.includes("reorderEmailMaterialLabel("),
    "the reorder sweep must label its rows through reorderEmailMaterialLabel, or the packaging box goes back to the bare name",
  );
}
