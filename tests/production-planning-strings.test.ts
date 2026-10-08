import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";

import {
  ALARM_SEVERITY_LABELS,
  ALARM_SEVERITY_LABELS_EN,
  BASIS_LABELS,
  BASIS_LABELS_EN,
  buildAlarmEmailSummary,
  buildPlannerSentence,
  buildPlannerSentenceEn,
  coerceProductionPlanningLanguage,
  formatNumberLatin,
  PP,
  PP_EN,
  PRODUCTION_PLANNING_ERRORS,
  PRODUCTION_PLANNING_ERRORS_EN,
  PRODUCTION_PLANNING_DEFAULT_LANGUAGE,
  PRODUCTION_PLANNING_NUMBER_LOCALE,
  PRODUCTION_PLANNING_REFUSALS,
  PRODUCTION_PLANNING_REFUSALS_EN,
  PRODUCTION_PLANNING_TABS,
  PRODUCTION_PLANNING_TABS_EN,
  productionPlanningStrings,
  storedPlanTitle,
  SUPPLIER_LABELS,
  SUPPLIER_LABELS_EN,
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

  // ── The reorder EMAIL stays Arabic, whichever way the toggle is set ───────────────────────────
  //
  // Deliberate, and not an oversight the toggle forgot: four named people were given an Arabic
  // notification, nothing has been said about changing what lands in their inbox, and a screen
  // preference on one reader's browser must not decide the language of somebody else's email.
  const emailSummary = buildAlarmEmailSummary({ productNameAr: PP.moduleTitle, count: "3" });
  assert.ok(
    /[\u0600-\u06FF]/.test(emailSummary),
    `the reorder email is Arabic by decision — the toggle is a screen preference: ${emailSummary}`,
  );
}
