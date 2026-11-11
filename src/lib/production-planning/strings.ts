/**
 * Production Planner — every word on the screen and in the workbook, in one place.
 *
 * The owner asked for this module in Egyptian Arabic ("طبعا اللغه دي عربي عربي عربيك ايجيبشن
 * عربيك") with an Excel export carrying the live formulas. The workbook and the workspace import
 * THIS file, so a heading cannot say one thing on screen and another in the sheet.
 *
 * ── Genderless by construction, and why it is not optional here ──────────────────────────────────
 *
 * Both primary users are women: Dr. Sahar Khalil, the Toll Manufacturing Manager, and Reham Elwiy, the Regulatory
 * Affairs Supervisor. Arabic marks gender on verbs in the imperative and on the second-person
 * pronoun, so the ordinary way to write a UI — "اختر", "احسب", "بياناتك" — addresses a man. The whole
 * app was swept neutral in English on 2026-10-05 for exactly this reason; this file is that ruling
 * applied to a new Arabic surface rather than retrofitted onto it.
 *
 * Four devices, used throughout, which `tests/production-planning-strings.test.ts` enforces:
 *
 *   1. A verbal noun for every action, never an imperative. `حساب الاحتياج`, not `اِحسب`.
 *      `تسجيل تشغيلة`, not `سجّل تشغيلة`. `حفظ`, not `احفظ`.
 *   2. No second person at all, and no `ـك` possessive. `الإعدادات`, not `إعداداتك`.
 *   3. Noun phrases for headings, so nothing has to agree with anybody.
 *   4. Impersonal passive for outcomes. `تم الحفظ` / `تعذّر الحفظ`, never `حفظت` or `لم تحفظ`.
 *
 * The actor is named as a PERSON where one has to appear — `آخر تعديل — سحر خليل` — which carries no
 * grammatical gender at all and is also more useful than a pronoun.
 *
 * ── Latin digits, deliberately ───────────────────────────────────────────────────────────────────
 *
 * The owner chose Latin numerals. `Intl.NumberFormat("ar-EG")` emits Arabic-Indic digits (٠١٢٣) and
 * `ج.م.`, so the locale here is `en-EG` and the test asserts the literal `"ar-EG"` never appears in
 * this module.
 *
 * ── The imports, and why only one of them runs ───────────────────────────────────────────────────
 *
 * This file is otherwise a LEAF, which is what lets the cron, the workbook builder and a
 * `"use client"` component all read it without pulling anything behind it. `import type` emits no
 * code at all, so taking the two unions from the kernel keeps that property while making a drifted
 * basis or measure unit a compile error rather than a label that silently stops matching. The one
 * runtime import is `ceilDiv`, from a kernel that imports nothing itself: a sentence that rounded
 * boxes its own way is how it came to disagree with the engine beside it.
 */
import type { ExpirySeverity } from "./expiry";
import { ceilDiv, type CompositionBasis, type MeasureUnit } from "./rules";

/** The locale every number in this module is formatted with. NEVER `ar-EG` — see the note above. */
export const PRODUCTION_PLANNING_NUMBER_LOCALE = "en-EG";

/**
 * The face stack for Arabic text on screen. Mirrors `ARABIC_FONT_STACK` in
 * src/lib/hiring-pack/render-shared.ts, which is the authority — the tail entries are the only
 * shaping faces the server container has, so neither list is tidied without the other.
 */
export const PRODUCTION_PLANNING_FONT_STACK =
  '"Tahoma", "Segoe UI", "Traditional Arabic", "Simplified Arabic", "Arial Unicode MS", ' +
  '"Noto Sans Arabic", "Noto Naskh Arabic", Arial, sans-serif';

/**
 * The ONE face the workbook writes, as a single family name rather than a stack.
 *
 * Excel takes one family per cell and has no fallback list, so the browser stack above cannot be
 * handed to it. Tahoma is the head of that stack for the same reason it is chosen here: it ships
 * with Windows and with Office on macOS, shapes Arabic correctly, and its Arabic metrics are the
 * most predictable at the small sizes a table uses. NEVER "Calibri" or `HOUSE_TYPE.body` ("Aptos")
 * on this sheet — both are Latin-only, and a reader with no fallback gets boxes.
 */
export const PRODUCTION_PLANNING_WORKBOOK_FONT = "Tahoma";

/**
 * The packaging material (code `CARTON`) is stored as `Box` / `علبة`, and the same documents also say
 * "boxes" for the product count — so wherever a DOCUMENT names the packaging row (the Excel export,
 * the reorder email) it is spelled out with these. The screen and the stored name stay `Box`.
 */
export const PACKAGING_BOX_CODE = "CARTON";
export const PACKAGING_BOX_NAME_AR = "علبة التغليف";
export const PACKAGING_BOX_NAME_EN = "Packaging box";

/** The packaging row's name in a document, in the document's language. */
export function packagingBoxName(lang: "ar" | "en"): string {
  return lang === "ar" ? PACKAGING_BOX_NAME_AR : PACKAGING_BOX_NAME_EN;
}

/**
 * The material label a row of the reorder email carries — ENGLISH, whichever way the screen toggle
 * is set (the owner, 2026-10-09: "never never never use arabic in it again"), with the packaging row
 * spelled out. A function of its own (not inline in the sweep) because the sweep imports the email
 * service and a test cannot load it.
 */
export function reorderEmailMaterialLabel(code: string, storedNameEn: string): string {
  return code === PACKAGING_BOX_CODE ? packagingBoxName("en") : storedNameEn;
}

export type ProductionPlanningTabKey = "planner" | "stock" | "cost" | "run" | "settings";

/**
 * Which language the module is showing, chosen by the owner with a TOGGLE (his instruction,
 * 2026-10-06). Arabic stays the DEFAULT, because that is the language he specified the module in
 * and the one its two daily users read; the toggle is a per-reader choice over it, not a
 * replacement for it.
 */
export type ProductionPlanningLanguage = "ar" | "en";

/** Arabic is the default. A stored value that is neither reads as Arabic rather than as nothing. */
export const PRODUCTION_PLANNING_DEFAULT_LANGUAGE: ProductionPlanningLanguage = "ar";

export function coerceProductionPlanningLanguage(value: unknown): ProductionPlanningLanguage {
  return value === "en" ? "en" : "ar";
}

export const PRODUCTION_PLANNING_TABS: readonly { key: ProductionPlanningTabKey; label: string }[] = [
  { key: "planner", label: "المُخطِّط" },
  { key: "stock", label: "المخزون" },
  { key: "cost", label: "التكلفة" },
  { key: "run", label: "تسجيل تشغيلة" },
  { key: "settings", label: "الإعدادات" },
] as const;

export const PP = {
  // ── The module itself ──────────────────────────────────────────────────────────────────────────
  moduleKicker: "إنتاج لدى الغير",
  moduleTitle: "تخطيط الإنتاج والمواد الخام",
  // The language switch names the Arabic option in the language being READ: Arabic script on the
  // Arabic screen, the word "Arabic" on the English one, so English carries no Arabic character.
  languageArabic: "العربية",
  moduleSubtitle: "حساب احتياج المواد الخام لكل تشغيلة، وما هو متوفر، وما يلزم شراؤه وتسليمه",
  readOnlyNotice: "الصلاحية الحالية للقراءة فقط — لا يمكن حفظ أي تعديل",

  // ── The planner tab ───────────────────────────────────────────────────────────────────────────
  plannerTitle: "حساب الاحتياج",
  productLabel: "المنتج",
  requestModeLabel: "طريقة الطلب",
  requestModeTotalBoxes: "إجمالي العلب (العينات من داخله)",
  requestModeGoodUnits: "العلب القابلة للبيع فقط (العينات إضافة عليها)",
  requestModeRuns: "عدد التشغيلات",
  requestedQtyLabel: "الكمية المطلوبة",
  sampleUnitsLabel: "عدد العينات المجانية",
  // The sizes are NOT written in here any more: they were Ivyronc's 40 ml sample and 100 ml bottle,
  // and a second product makes a hard-coded measurement a wrong sentence rather than a helpful one.
  // `sampleUnitsHint(measure)` on the bundle fills them from the product's own geometry.
  sampleUnitsHint: "العينة من نفس حجم التشغيلة — تقلل عدد الوحدات القابلة للبيع وتستهلك عبوة كاملة",
  overageLabel: "نسبة الفاقد",
  overageHintDefault: "النسبة الافتراضية من الإعدادات",
  overageHintMeasured: "نسبة مقيسة من التشغيلات المسجلة",
  overageHintMaterial: "نسبة محددة لهذه المادة",
  calculate: "حساب الاحتياج",
  saveDraft: "حفظ كمسودة",
  commitPlan: "اعتماد الخطة",

  // The four tiles, and the sentence under them. The rounding leads, because it is the one thing
  // he will not take on trust: a planner asked for 150,000 that silently answers for 151,284 is
  // wrong in the only way that matters while every number below it is right.
  tileRuns: "عدد التشغيلات",
  tileRunVolume: "حجم التشغيلة",
  // The same tile for a product weighed rather than poured. "حجم" is volume, which is the wrong
  // noun for 100 kg of powder — `runSizeLabel(measureUnit)` picks between the two.
  tileRunWeight: "وزن التشغيلة",
  tileYield: "الناتج الفعلي",
  tileSurplus: "الزيادة عن المطلوب",
  tileShortfall: "النقص عن المطلوب",
  unitRun: "تشغيلة",
  unitRuns: "تشغيلة",
  unitLitre: "لتر",
  unitMl: "مل",
  // The same pair for a product measured by WEIGHT. A powder in 5 g sachets was reading "5 مل" on
  // his screen, because the geometry columns are named `…_ml` and the labels followed the names
  // instead of the product. `measureUnitLabels` picks the pair; the arithmetic never changed.
  unitKilogram: "كجم",
  unitGram: "جم",
  // And the same pair again for a product measured in MILLIGRAMS. A film-coated tablet weighs 155
  // mg, so milligram is the only unit in which Royanoxicam's dose is a whole number — the geometry
  // columns are integers. The LARGE word stays the kilogram: a 31,000,000 mg batch is 31 kg, which
  // is the figure the owner states it in.
  unitMilligram: "مجم",
  unitBox: "علبة",
  unitBottle: "زجاجة",
  unitSachet: "كيس",
  unitTablet: "قرص",
  unitCapsule: "كبسولة",
  unitSample: "عينة",
  roundedUpNote: "التشغيلات بأعداد صحيحة، فتم التقريب لأعلى",
  exactRunsNote: "الاحتياج الدقيق",
  oneRunFewerNote: "تشغيلة واحدة أقل",
  leftoverNote: "كمية لا تكفي عبوة ولا عينة",

  // ── The result table — four columns, 31/23/23/23 ──────────────────────────────────────────────
  colMaterial: "المادة",
  colNeeded: "المطلوب",
  colAvailable: "المتاح",
  colAction: "الإجراء",
  atFactory: "المصنع",
  atOwnStore: "مخزن ساتو",
  totalHeld: "الإجمالي",
  beforeOverage: "قبل الفاقد",
  toBuy: "للشراء",
  toDeliver: "للتسليم",
  willSend: "سيتم تسليم",
  balanceAfter: "المتبقي بعد التشغيل",
  shortAfter: "ناقص بعد التشغيل",
  coverRuns: "يكفي",
  noActionNeeded: "لا يلزم أي إجراء",

  // The owner chips. A material nobody has settled contributes nothing to a buy list, and the chip
  // is how the screen says so instead of printing a reassuring zero.
  chipSato: "ساتو",
  chipFactory: "المصنع",
  chipUnsettled: "تُسوّى مع المصنع",
  chipNoComposition: "التركيبة غير مُدخلة",
  chipImported: "مستورد",
  excludedFactory: "المصنع يوردها — غير محسوبة في الشراء",
  excludedUnsettled: "لم يُتفق على من يوردها — غير محسوبة في الشراء",
  excludedNoComposition: "لا توجد تركيبة مُدخلة لهذه المادة",
  // Royanoxicam's foil: Sato's, with the grams per box still to come (owner, 2026-10-29).
  excludedSatoNoAmount: "ساتو يوردها — الكمية لكل علبة لم تُدخل بعد",
  heldFactoryBrings: "يوردها المصنع — لا رصيد لساتو منها",
  // The Stock and Cost tabs list only what Sato buys; this line says how many the factory brings.
  factoryHiddenNote: "مواد يوردها المصنع ولا تظهر هنا:",

  // ── The stock tab ─────────────────────────────────────────────────────────────────────────────
  stockTitle: "المخزون",
  stockSubtitle: "كل تقرير مخزون يُضاف ولا يُستبدل — الرصيد الحالي هو أحدث تقرير",
  stockLocation: "الموقع",
  stockQty: "الكمية",
  stockAsOf: "تاريخ الرصيد",
  stockSource: "المصدر",
  stockSourceFactoryReport: "تقرير المصنع",
  stockSourceOwnCount: "جرد ساتو",
  stockSourceDelivery: "تسليم",
  stockSourceAdjustment: "تسوية",
  stockDeliveredQty: "الكمية المُسلّمة",
  stockDeliveryAdds: "تُضاف على الرصيد الحالي",
  stockBalanceAfter: "الرصيد بعد التسجيل",
  stockNote: "ملاحظة",
  stockAdd: "إضافة تقرير مخزون",
  stockHistory: "سجل التقارير",
  stockNoneYet: "لا توجد تقارير مخزون لهذه المادة",
  // ── The expiry date, on the stock tab ──
  // The owner, three times over: "خانة الاكسبايري ديت مهمة جدا جدا جدا يا عمر".
  stockExpiry: "تاريخ الانتهاء",
  stockExpiryHint: "يُترك فارغًا لمواد التغليف — الفيلم والكراتين والاستيكر لا تنتهي",
  stockNoExpiry: "لا ينتهي",
  stockLotNote: "كل تاريخ انتهاء رصيد منفصل، والمتاح هو مجموعها",
  // ── The stock table — the factory and Sato's warehouse in their OWN columns (2026-11-11) ──
  stockColFactory: "المتاح في المصنع",
  stockColSato: "المتاح في مخزن ساتو",
  stockSoonestExpiry: "أقرب انتهاء",
  stockNothingHere: "لا يوجد رصيد مسجل هنا",
  stockLotsCount: "عدد الأرصدة",
  stockExpired: "منتهي (معدوم)",
  expiredTitle: "المخزون المنتهي (المعدوم)",
  expiredSubtitle: "عند حلول تاريخ الانتهاء تخرج الكمية تلقائيًا من المخزون ومن الاحتياج، وتبقى مسجلة هنا للحسابات",
  stockChangeExpiry: "تعديل تاريخ انتهاء رصيد",
  stockChangeExpirySubtitle: "تنتقل الكمية كما هي إلى التاريخ الجديد، ولو يوجد رصيد بنفس التاريخ تُضاف عليه",
  stockLot: "الرصيد",
  stockNewExpiry: "تاريخ الانتهاء الجديد",
  stockNewExpiryHint: "يُترك فارغًا لو المادة لا تنتهي",
  stockMove: "نقل مخزون إلى مخزن آخر",
  stockMoveSubtitle: "تُخصم الكمية من الرصيد وتُضاف إلى نفس الرصيد في المخزن الآخر، بنفس تاريخ الانتهاء",
  stockMoveTo: "إلى مخزن",
  stockMoveQty: "الكمية المنقولة",
  stockMoveQtyHint: "الفراغ يعني نقل الرصيد كله",
  stockMoveDate: "تاريخ النقل",
  stockMoveDateHint: "الفراغ يعني اليوم",
  stockFixMaterial: "تصحيح مادة سُجِّل عليها مخزون بالخطأ",
  stockFixMaterialSubtitle: "تنتقل الكمية إلى المادة الصحيحة في نفس المخزن وبنفس تاريخ الانتهاء، ويبقى السجل القديم في التاريخ",
  stockFixTo: "المادة الصحيحة",
  stockMaterialUsedBy: "مستخدمة في",
  stockMaterialUsedByNone: "غير مرتبطة بمنتج",

  // ── The cost tab ──────────────────────────────────────────────────────────────────────────────
  costTitle: "التكلفة",
  costSubtitle: "السعر يُسجَّل بعملة واحدة كما هو مُدخل، والعملة الأخرى تُحسب بسعر الصرف الساري",
  priceLabel: "السعر",
  priceCurrency: "العملة",
  currencyUsd: "دولار",
  currencyEgp: "جنيه",
  pricePerUnit: "لكل",
  priceEffectiveFrom: "ساري من",
  priceAdd: "إضافة سعر",
  priceNoneYet: "لا يوجد سعر مُدخل لهذه المادة",
  fxRate: "سعر الصرف",
  fxRateDate: "تاريخ السعر",
  fxSourceManual: "مُدخل يدويًا",
  fxSourceFetched: "مسحوب تلقائيًا",
  fxSourceFallback: "السعر الاحتياطي من الإعدادات",
  fxSourceNone: "لا يوجد سعر صرف — العملة الأخرى غير محسوبة",
  fxManualOverride: "تعديل سعر الصرف يدويًا",
  costTotal: "إجمالي التكلفة",
  costUnpriced: "مواد بدون سعر",
  costIncomplete: "مواد تعذّر حساب عملتها الأخرى",
  costNotWholeNotice: "الإجمالي لا يشمل المواد التي بدون سعر",
  // ── When the total is partial, or means nothing at all ────────────────────────────────────────
  // Verbal nouns and impersonal outcomes, no imperative: both primary users are women and Arabic
  // marks gender on the imperative, and `production-planning-strings.test.ts` scans for that.
  costNoPrices: "لم تُدخل أسعار",
  costPartialTotal: "الإجمالي جزئي — محسوب على المواد المسعّرة فقط",
  costPricedOnBuyList: "المسعّر من قائمة الشراء",

  // ── The run tab ───────────────────────────────────────────────────────────────────────────────
  runTitle: "تسجيل تشغيلة",
  runSubtitle: "تسجيل ما استهلكته التشغيلة فعليًا هو ما يحوّل نسبة الفاقد من تقدير إلى قياس",
  runLabel: "اسم التشغيلة",
  runCount: "عدد التشغيلات في هذا التقرير",
  runProducedOn: "تاريخ الإنتاج",
  runActualGoodUnits: "العلب الناتجة فعليًا",
  runActualSamples: "العينات الناتجة فعليًا",
  runOpening: "رصيد أول",
  runDelivered: "المُسلَّم",
  runClosing: "رصيد آخر",
  runConsumed: "المستهلك",
  runTheoretical: "المتوقع",
  runGap: "الفرق",
  runExclude: "استثناء من القياس",
  runExcludeReason: "سبب الاستثناء",
  runExcludeHint: "السطر يبقى مسجلًا كما ورد من المصنع، ولا يدخل في حساب نسبة الفاقد",
  runSave: "حفظ التشغيلة",
  runNoneYet: "لا توجد تشغيلات مسجلة بعد",
  runHistory: "سجل التشغيلات",
  learnedOverage: "نسبة الفاقد المقيسة",
  learnedNotEnoughRuns: "تشغيلة واحدة لا تكفي للقياس — النسبة الافتراضية ما زالت سارية",
  learnedNoTheoretical: "لا يوجد رقم متوقع للمقارنة",

  // ── The settings tab ──────────────────────────────────────────────────────────────────────────
  settingsTitle: "الإعدادات",
  settingsDefaultOverage: "نسبة الفاقد الافتراضية",
  settingsReorderCover: "حد التنبيه (عدد التشغيلات)",
  settingsReorderCoverHint: "يُرسل تنبيه إعادة الطلب عندما يكفي المتوفر أقل من هذا العدد من التشغيلات",
  settingsAlarmEnabled: "تشغيل تنبيه إعادة الطلب",
  settingsAlarmDryRun: "وضع التجربة — تسجيل بدون إرسال",
  settingsAlarmOffNotice: "التنبيه غير مُفعَّل — لا يُرسل أي بريد",
  settingsAlarmDryRunNotice: "وضع التجربة مُفعَّل — يُسجَّل ما كان سيُرسل بدون إرسال فعلي",
  settingsExpiryWarnDays: "التنبيه قبل الانتهاء (يوم)",
  settingsExpiryWarnDaysHint: "تظهر المواد التي تنتهي خلال هذه المدة — الافتراضي ثلاثة شهور",
  settingsExpiryAlarmEnabled: "تشغيل بريد تنبيه الانتهاء",
  settingsExpiryAlarmDryRun: "وضع التجربة لبريد الانتهاء",
  settingsExpiryOffNotice: "بريد الانتهاء غير مُفعَّل — التحذير يظهر على الشاشة ولا يُرسل بريد",
  settingsExpiryDryRunNotice: "وضع التجربة مُفعَّل — يُسجَّل ما كان سيُرسل بدون إرسال فعلي",
  settingsFxEnabled: "تشغيل السحب اليومي لسعر الصرف",
  settingsFxDryRun: "وضع التجربة لسعر الصرف",
  settingsFxFallback: "سعر الصرف الاحتياطي",
  settingsMaterials: "المواد",
  settingsComposition: "التركيبة",
  settingsRetire: "إيقاف المادة",
  settingsRetireHint:
    "الإيقاف يُغلق سطر التركيبة ويُخفي المادة من كل التبويبات، ويُبقي المخزون كما هو — والإرجاع ممكن",
  settingsRetireAlsoUsedBy: "مستخدمة أيضاً في",
  settingsRetired: "مواد موقوفة",
  settingsRetiredNone: "لا توجد مواد موقوفة",
  settingsRestore: "إرجاع المادة",
  settingsRestoreHint: "الإرجاع يُعيد المادة وروابط المنتجات، ولا يُعيد سطر التركيبة — تعود المادة بدون تركيبة",
  // ── The composition editor ──────────────────────────────────────────────────────────────────────
  // Verbal nouns and impersonal outcomes, no imperative and no second person: both primary users
  // are women and Arabic marks gender on both, so `production-planning-strings.test.ts` scans every
  // one of these against its deny-list.
  settingsCompositionHint:
    "التركيبة مؤرشفة: أي تعديل يُغلق السطر الساري في تاريخه ويفتح سطراً جديداً، فتبقى الخطة السابقة قابلة لإعادة الإنتاج بتركيبتها",
  compositionColMaterial: "المادة",
  compositionColQty: "الكمية",
  compositionColBasis: "الأساس",
  compositionColSupplier: "التوريد",
  compositionEdit: "تعديل السطر",
  compositionEnter: "إدخال السطر",
  compositionCancel: "إلغاء",
  compositionEditorFor: "سطر التركيبة لمادة",
  compositionQty: "الكمية",
  compositionQtyTypedIn: "تُكتب بوحدة",
  compositionQtyStoredAs: "وتُخزَّن بوحدة",
  compositionQtyStoredPreview: "ستُخزَّن كـ",
  compositionQtyRequired: "الكمية مطلوبة وأكبر من صفر",
  compositionBasis: "الأساس",
  compositionSupplier: "جهة التوريد",
  compositionOverage: "نسبة الهالك %",
  compositionOverageHint: "الفراغ يعني اتباع النسبة العامة للوحدة",
  compositionEffectiveFrom: "ساري من",
  compositionEffectiveFromHint: "السطر السابق يُغلق في هذا التاريخ، والفراغ يعني اليوم",
  compositionUnsettledWarning:
    "التوريد غير المحسوم يُظهر الاحتياج ولا يضيف إلى قائمة الشراء، ويمنع اعتماد أي خطة حتى يُحسم",
  compositionNoRemoval: "تصفير السطر مرفوض — إيقاف المادة هو طريق إخراجها",
  compositionPerThousand: "الاستهلاك لكل 1000 علبة",
  compositionPerThousandHint: "بنفس وحدة الكمية، كما يذكرها المصنع؛ التحويل يملأ خانة الكمية حسب الأساس وعدد الشرائط أو الوحدات في العلبة",
  compositionPerThousandApply: "تحويل",
  compositionPerThousandCannot: "لا يمكن التحويل: الرقم غير صحيح، أو المنتج لا يحدد عدد الشرائط أو الوحدات في العلبة",
  settingsPackaging: "تعبئة العلبة",
  settingsPackagingHint: "عدد الوحدات (الكبسولات أو الأكياس) وعدد الشرائط في علبة واحدة؛ عليهما يُحسب كل سطر لكل علبة أو لكل شريط",
  settingsUnitsPerBox: "الوحدات في العلبة",
  settingsStripsPerBox: "الشرائط في العلبة",
  settingsStripsPerBoxHint: "الفراغ يعني أن المنتج لا يُعبأ في شرائط",
  settingsBatchWeightShown: "وزن التشغيلة كما يذكره المصنع",
  settingsUnitWeightShown: "وزن الوحدة الواحدة كما في الورقة",
  settingsShownWeightHint: "للعرض فقط، ولا يغيّر أي كمية. الفراغ يعرض الوزن المحسوب",
  listSeparator: "، ",
  gapsTitle: "بيانات ناقصة قبل التخطيط",
  gapsNoAmount: "الكمية غير مُدخلة",
  gapsNoStock: "لا يوجد مخزون مسجل",
  gapsHint: "هذه المواد يشتريها ساتو؛ بدون كمية تخرج من قائمة الشراء، وبدون مخزون تُشترى كاملة. الكمية تُدخل من الإعدادات والمخزون من تبويب المخزون.",
  settingsGeometry: "حجم التشغيلة والعبوات",
  settingsAccess: "الصلاحيات",
  settingsAccessHint: "الأشخاص الذين سمّاهم المالك مُثبتون في الكود — هنا تُضاف صلاحية إضافية بالاسم",
  settingsLeadTime: "مدة التوريد (يوم)",
  settingsMinOrder: "أقل كمية للشراء",
  settingsPurchaseIncrement: "مضاعفات الشراء",
  settingsLastUpdatedBy: "آخر تعديل",
  alarmSwitchOn: "تفعيل التنبيه",
  alarmSwitchOff: "إيقاف التنبيه",
  dryRunSwitchOn: "تفعيل وضع التجربة",
  dryRunSwitchOff: "إيقاف وضع التجربة",
  accessHrId: "رقم الموظف",
  accessLevel: "مستوى الصلاحية",
  accessLevelRead: "قراءة فقط",
  accessLevelFull: "تحكم كامل",
  accessRemove: "إلغاء الصلاحية",
  accessNoneYet: "لا توجد صلاحيات إضافية مسجلة",
  accessNamedInCode: "مُثبَّت في الكود",

  // ── Outcomes, impersonal passive throughout ───────────────────────────────────────────────────
  saved: "تم الحفظ",
  saveFailed: "تعذّر الحفظ",
  loadFailed: "تعذّر تحميل البيانات",
  notLoaded: "البيانات غير محمَّلة",
  yes: "نعم",
  no: "لا",
  stateOn: "مُفعَّل",
  stateOff: "غير مُفعَّل",
  save: "حفظ",
  cancel: "إلغاء",
  close: "إغلاق",
  exportWorkbook: "تصدير إلى إكسل",
  exportFailed: "تعذّر التصدير",
  exportHint: "الملف يحتوي على المعادلات نفسها — تعديل أي خانة صفراء يُعيد الحساب داخل إكسل",
  loading: "جارٍ التحميل",
  nothingToShow: "لا توجد بيانات لعرضها",

  // ── The Excel export ──────────────────────────────────────────────────────────────────────────
  // The owner asked for the formulas themselves, not the answers ("فيها برضو الفورمولاز"), so every
  // yellow cell is typed and every other cell is a live formula over them. These are the sheet's own
  // words; the screen's labels above are reused wherever they say the same thing.
  sheetName: "الخطة",
  sheetInputsTitle: "المُدخلات — الخانات الصفراء",
  sheetOutputsTitle: "النتيجة المحسوبة",
  sheetMaterialsTitle: "المواد الخام",
  sheetCostTitle: "تكلفة الشراء",
  sheetRequestedBoxes: "إجمالي العلب المطلوب",
  // The unit is NOT written into these labels — the workbook appends the product's own unit, so the
  // powder's sheet reads "(جم)" where the syrup's reads "(مل)". A hard-coded (مل) here is the same
  // defect the screen had: a label following the column name instead of the product.
  sheetRunVolume: "حجم التشغيلة",
  sheetGoodUnitSize: "حجم الوحدة القابلة للبيع",
  sheetSampleUnitSize: "حجم العينة",
  sheetDose: "الجرعة",
  sheetUnitsPerBox: "عدد الوحدات في العلبة",
  sheetGoodUnitsRequested: "الوحدات القابلة للبيع المطلوبة",
  sheetNeededVolume: "حجم الاحتياج",
  sheetTotalVolume: "الحجم الكلي",
  sheetTotalDoses: "إجمالي الجرعات",
  sheetPackagingSets: "إجمالي العبوات الكاملة",
  sheetTotalBoxes: "إجمالي العلب (الكراتين)",
  sheetSaleableBoxes: "علب البيع بدون العينات",
  sheetStripsPerBox: "عدد الشرائط في العلبة",
  sheetTotalStrips: "إجمالي الشرائط",
  sheetColBasisLabel: "أساس الحساب",
  sheetColQtyPerBasis: "الكمية لكل أساس",
  sheetColBasisCount: "عدد الأساس",
  sheetColSupplier: "من يورد",
  sheetColPrice: "السعر للوحدة",
  sheetColCostUsd: "التكلفة بالدولار",
  sheetColCostEgp: "التكلفة بالجنيه",
  sheetUnpricedNote: "الإجمالي لا يشمل المواد التي بدون سعر مُدخل",
  sheetGeneratedOn: "تاريخ التصدير",
  sheetGeneratedBy: "جهة التصدير",

  // ── The reorder email ─────────────────────────────────────────────────────────────────────────
  alarmEmailSubject: "تنبيه إعادة طلب مواد خام",
  alarmSeverityOutOfStock: "لا يوجد رصيد",
  alarmSeverityBelow: "أقل من حد التنبيه",
  alarmSeverityApproaching: "يقترب من حد التنبيه",
  alarmLeadTimeNote: "مدة التوريد",
  alarmNoneToday: "لا توجد مواد تحت حد التنبيه",
  alarmEmailStatus:
    "الأرقام محسوبة على تشغيلة واحدة بدون عينات، وهو الأساس الذي يُقاس عليه الغطاء.",
  alarmEmailCover: "الغطاء",
  alarmEmailHeld: "المتوفر",
  unitDay: "يوم",

  // ── The expiry warning — on screen always, by email only when he arms it ───────────────────────
  expiryTitle: "مواد تقترب من تاريخ الانتهاء",
  expiryNoneFound: "لا توجد مادة تنتهي خلال مدة التنبيه",
  expirySeverityExpired: "منتهي",
  expirySeverityCritical: "ينتهي قريبًا جدًا",
  expirySeverityWarning: "داخل مدة التنبيه",
  expiryEmailSubject: "تنبيه تاريخ انتهاء مواد خام",
  expiryEmailStatus: "الأرقام أرصدة كما وردت، كل تاريخ انتهاء على حدة — لم تُجمع.",
  expiryToday: "ينتهي اليوم",
  expiryLastEvaluated: "آخر فحص",
  expiryLastSent: "آخر إرسال",
} as const;

export type ProductionPlanningStringKey = keyof typeof PP;

/**
 * The same catalogue in English, because the owner chose the language with a TOGGLE (2026-10-06).
 *
 * A `Record<ProductionPlanningStringKey, string>` and not another object literal: the key type is
 * `keyof typeof PP`, so a key added to the Arabic catalogue and forgotten here is a COMPILE error
 * rather than a screen with one Arabic word on it. `tests/production-planning-strings.test.ts`
 * asserts the parity in both directions and that no Arabic letter appears in this half.
 *
 * Neutral by construction, same as the Arabic: no second person, no "his" or "her", nouns for
 * headings and impersonal outcomes ("Saved", "Could not save"), which is the app-wide ruling of
 * 2026-10-05 and not a choice re-made here. Numbers stay Latin in both languages.
 *
 * BOTH ALARM EMAILS READ THIS HALF AND NEVER THE ARABIC ONE (owner, 2026-10-09). The toggle is a
 * screen preference and an email has four other readers, so the sweeps read `PP_EN` plus the
 * English-only `PRODUCTION_PLANNING_EMAIL_EN` catalogue — never `PP`.
 */
export const PP_EN: Record<ProductionPlanningStringKey, string> = {
  // ── The module itself ──────────────────────────────────────────────────────────────────────────
  moduleKicker: "Toll manufacturing",
  moduleTitle: "Production and raw-material planning",
  languageArabic: "Arabic",
  moduleSubtitle:
    "What each run needs in raw materials, what is already held, and what to buy and deliver",
  readOnlyNotice: "This access is read-only — no change can be saved",

  // ── The planner tab ───────────────────────────────────────────────────────────────────────────
  plannerTitle: "Requirement",
  productLabel: "Product",
  requestModeLabel: "Request mode",
  requestModeTotalBoxes: "Total boxes (samples come out of it)",
  requestModeGoodUnits: "Saleable boxes only (samples on top)",
  requestModeRuns: "Number of runs",
  requestedQtyLabel: "Quantity requested",
  sampleUnitsLabel: "Free samples",
  sampleUnitsHint:
    "A sample comes out of the same run volume — it reduces the saleable unit count and still uses a full packaging set",
  overageLabel: "Overage",
  overageHintDefault: "The default from Settings",
  overageHintMeasured: "Measured from the recorded runs",
  overageHintMaterial: "Set for this material",
  calculate: "Calculate the requirement",
  saveDraft: "Save as a draft",
  commitPlan: "Commit the plan",

  tileRuns: "Runs",
  tileRunVolume: "Run volume",
  tileRunWeight: "Batch size",
  tileYield: "Actual yield",
  tileSurplus: "Surplus over the request",
  tileShortfall: "Shortfall against the request",
  unitRun: "run",
  unitRuns: "runs",
  unitLitre: "L",
  unitMl: "ml",
  unitKilogram: "kg",
  unitGram: "g",
  unitMilligram: "mg",
  unitBox: "box",
  unitBottle: "bottle",
  unitSachet: "sachet",
  unitTablet: "tablet",
  unitCapsule: "capsule",
  unitSample: "sample",
  roundedUpNote: "Runs are whole, so this is rounded up",
  exactRunsNote: "Exact requirement",
  oneRunFewerNote: "One run fewer",
  leftoverNote: "A remainder too small for a box or a sample",

  // ── The result table — four columns, 31/23/23/23 ──────────────────────────────────────────────
  colMaterial: "Material",
  colNeeded: "Needed",
  colAvailable: "Available",
  colAction: "Action",
  atFactory: "At the factory",
  atOwnStore: "Sato store",
  totalHeld: "Total",
  beforeOverage: "Before overage",
  toBuy: "To buy",
  toDeliver: "To deliver",
  willSend: "Will deliver",
  balanceAfter: "Left after the run",
  shortAfter: "Short after the run",
  coverRuns: "Covers",
  noActionNeeded: "No action needed",

  chipSato: "Sato",
  chipFactory: "The factory",
  chipUnsettled: "To settle with the factory",
  chipNoComposition: "No composition entered",
  chipImported: "Imported",
  excludedFactory: "The factory supplies it — not counted in the buy list",
  excludedUnsettled: "Who supplies it is not settled — not counted in the buy list",
  excludedNoComposition: "No composition is entered for this material",
  excludedSatoNoAmount: "Sato supplies it — amount per box not entered yet",
  heldFactoryBrings: "The factory brings it — Sato holds none",
  factoryHiddenNote: "Materials the factory brings, not listed here:",

  // ── The stock tab ─────────────────────────────────────────────────────────────────────────────
  stockTitle: "Stock",
  stockSubtitle:
    "Every stock report is added, never replaced — the current balance is the most recent report",
  stockLocation: "Location",
  stockQty: "Quantity",
  stockAsOf: "Balance date",
  stockSource: "Source",
  stockSourceFactoryReport: "Factory report",
  stockSourceOwnCount: "Sato count",
  stockSourceDelivery: "Delivery",
  stockSourceAdjustment: "Adjustment",
  stockDeliveredQty: "Amount delivered",
  stockDeliveryAdds: "Added to the current balance",
  stockBalanceAfter: "Balance after this report",
  stockNote: "Note",
  stockAdd: "Add a stock report",
  stockHistory: "Report history",
  stockNoneYet: "No stock report for this material yet",
  stockExpiry: "Expiry date",
  stockExpiryHint: "Left blank for packaging — film, cartons and stickers do not expire",
  stockNoExpiry: "No expiry",
  stockLotNote: "Each expiry date is its own balance, and the held figure is their total",
  stockColFactory: "Available at the factory",
  stockColSato: "Available at Sato warehouse",
  stockSoonestExpiry: "Soonest expiry",
  stockNothingHere: "Nothing recorded here",
  stockLotsCount: "Lots",
  stockExpired: "Expired (written off)",
  expiredTitle: "Expired stock (written off)",
  expiredSubtitle: "When the expiry date comes the quantity leaves stock and the buy list by itself, and stays recorded here for the accounts",
  stockChangeExpiry: "Change a lot's expiry date",
  stockChangeExpirySubtitle: "The quantity moves as it stands to the new date, and joins any lot already on that date",
  stockLot: "Lot",
  stockNewExpiry: "New expiry date",
  stockNewExpiryHint: "Left blank if the material does not expire",
  stockMove: "Move stock to another store",
  stockMoveSubtitle: "The quantity leaves this lot and joins the same lot in the other store, with the same expiry date",
  stockMoveTo: "To store",
  stockMoveQty: "Quantity to move",
  stockMoveQtyHint: "Left blank to move the whole lot",
  stockMoveDate: "Date of the move",
  stockMoveDateHint: "Left blank for today",
  stockFixMaterial: "Fix stock entered on the wrong material",
  stockFixMaterialSubtitle: "The quantity moves to the right material in the same store, with the same expiry date, and the old entry stays in the history",
  stockFixTo: "Right material",
  stockMaterialUsedBy: "Used in",
  stockMaterialUsedByNone: "not linked to a product",

  // ── The cost tab ──────────────────────────────────────────────────────────────────────────────
  costTitle: "Cost",
  costSubtitle:
    "A price is stored in one currency exactly as typed, and the other currency is derived at the rate in force",
  priceLabel: "Price",
  priceCurrency: "Currency",
  currencyUsd: "US dollar",
  currencyEgp: "Egyptian pound",
  pricePerUnit: "per",
  priceEffectiveFrom: "Effective from",
  priceAdd: "Add a price",
  priceNoneYet: "No price entered for this material",
  fxRate: "Exchange rate",
  fxRateDate: "Rate date",
  fxSourceManual: "Entered by hand",
  fxSourceFetched: "Read automatically",
  fxSourceFallback: "The fallback rate from Settings",
  fxSourceNone: "No exchange rate — the other currency is not derived",
  fxManualOverride: "Set the exchange rate by hand",
  costTotal: "Total cost",
  costUnpriced: "Materials with no price",
  costIncomplete: "Materials whose other currency could not be derived",
  costNotWholeNotice: "The total leaves out every material with no price",
  costNoPrices: "No prices entered",
  costPartialTotal: "This total is partial — only the priced materials are counted",
  costPricedOnBuyList: "Priced, of the buy list",

  // ── The run tab ───────────────────────────────────────────────────────────────────────────────
  runTitle: "Record a run",
  runSubtitle:
    "Recording what a run actually consumed is what turns the overage from an estimate into a measurement",
  runLabel: "Run name",
  runCount: "Runs in this report",
  runProducedOn: "Production date",
  runActualGoodUnits: "Boxes actually produced",
  runActualSamples: "Samples actually produced",
  runOpening: "Opening balance",
  runDelivered: "Delivered",
  runClosing: "Closing balance",
  runConsumed: "Consumed",
  runTheoretical: "Expected",
  runGap: "Difference",
  runExclude: "Exclude from the measurement",
  runExcludeReason: "Reason for excluding it",
  runExcludeHint:
    "The row stays recorded exactly as the factory reported it, and is left out of the overage calculation",
  runSave: "Save the run",
  runNoneYet: "No run recorded yet",
  runHistory: "Run history",
  learnedOverage: "Measured overage",
  learnedNotEnoughRuns: "One run is not enough to measure — the default is still in force",
  learnedNoTheoretical: "There is no expected figure to compare against",

  // ── The settings tab ──────────────────────────────────────────────────────────────────────────
  settingsTitle: "Settings",
  settingsDefaultOverage: "Default overage",
  settingsReorderCover: "Alarm threshold (runs)",
  settingsReorderCoverHint:
    "A reorder alarm is sent when what is held covers fewer runs than this",
  settingsAlarmEnabled: "Reorder alarm on",
  settingsAlarmDryRun: "Dry run — recorded, not sent",
  settingsAlarmOffNotice: "The alarm is off — no email is sent",
  settingsAlarmDryRunNotice:
    "Dry run is on — what would have been sent is recorded and nothing is sent",
  settingsExpiryWarnDays: "Warn this many days before expiry",
  settingsExpiryWarnDaysHint: "Anything expiring inside this window is shown — the owner chose three months",
  settingsExpiryAlarmEnabled: "Expiry warning email on",
  settingsExpiryAlarmDryRun: "Dry run for the expiry email",
  settingsExpiryOffNotice: "The expiry email is off — the warning shows on screen and nothing is sent",
  settingsExpiryDryRunNotice: "Dry run is on — what would have been sent is recorded and nothing is sent",
  settingsFxEnabled: "Daily exchange-rate read on",
  settingsFxDryRun: "Dry run for the exchange rate",
  settingsFxFallback: "Fallback exchange rate",
  settingsMaterials: "Materials",
  settingsComposition: "Composition",
  settingsRetire: "Retire the material",
  settingsRetireHint:
    "Retiring closes the formula line and hides the material from every tab, keeps the stock exactly as it is, and can be undone",
  settingsRetireAlsoUsedBy: "Also used by",
  settingsRetired: "Retired materials",
  settingsRetiredNone: "No retired materials",
  settingsRestore: "Restore the material",
  // 🔴 It says the material comes back WITHOUT a composition, and deliberately does not say "enter it
  // again" — no screen control enters a formula line. `saveMaterialAndComposition` and its route exist
  // and are correct, but nothing in the UI reaches them: before this change the Settings tab posted to
  // /stock, /fx, /prices, /runs, /settings and /access-grants, and to /materials never. A hint that
  // promised a place to type the line would be the screen claiming something only a migration can do.
  settingsRestoreHint:
    "Restoring brings the material and its product links back; the formula line is not restored, so the material comes back with no composition",
  settingsCompositionHint:
    "The formula is versioned: a change closes the line in force on its own date and opens a new one, so a plan committed earlier still reproduces under the formula it was committed with",
  compositionColMaterial: "Material",
  compositionColQty: "Quantity",
  compositionColBasis: "Basis",
  compositionColSupplier: "Supplied by",
  compositionEdit: "Edit the line",
  compositionEnter: "Enter the line",
  compositionCancel: "Cancel",
  compositionEditorFor: "Formula line for",
  compositionQty: "Quantity",
  compositionQtyTypedIn: "Typed in",
  compositionQtyStoredAs: "stored in",
  compositionQtyStoredPreview: "Will be stored as",
  compositionQtyRequired: "A quantity above zero is required",
  compositionBasis: "Basis",
  compositionSupplier: "Supplied by",
  compositionOverage: "Overage %",
  compositionOverageHint: "Blank follows the module's own default",
  compositionEffectiveFrom: "In force from",
  compositionEffectiveFromHint: "The previous line closes on this date; blank means today",
  compositionUnsettledWarning:
    "An unsettled supplier shows the requirement, adds nothing to the buy list, and blocks a committed plan until it is settled",
  compositionNoRemoval: "A line cannot be zeroed — retiring the material is how it comes off",
  compositionPerThousand: "Usage per 1,000 boxes",
  compositionPerThousandHint: "In the same unit as the quantity, the way the factory gives it; Convert fills the quantity from the basis and the strips or units in a box",
  compositionPerThousandApply: "Convert",
  compositionPerThousandCannot: "Cannot convert: the figure is not a number, or the product does not say how many strips or units its box holds",
  settingsPackaging: "Box packaging",
  settingsPackagingHint: "How many units (capsules or sachets) and how many strips one box holds; every per-box and per-strip line is counted from these",
  settingsUnitsPerBox: "Units per box",
  settingsStripsPerBox: "Strips per box",
  settingsStripsPerBoxHint: "Left blank when the product is not packed in strips",
  settingsBatchWeightShown: "Batch weight as the factory states it",
  settingsUnitWeightShown: "One unit's weight as the paper states it",
  settingsShownWeightHint: "Shown only, changes no quantity. Left blank shows the computed weight",
  listSeparator: ", ",
  gapsTitle: "Missing before planning",
  gapsNoAmount: "No amount entered",
  gapsNoStock: "No stock recorded",
  gapsHint: "Sato buys these materials. With no amount a material leaves the buy list, and with no stock it is bought in full. Amounts are entered in Settings and stock on the Stock tab.",
  settingsGeometry: "Run volume and packaging",
  settingsAccess: "Access",
  settingsAccessHint:
    "The people the owner named are fixed in the code — extra access is added here by name",
  settingsLeadTime: "Lead time (days)",
  settingsMinOrder: "Minimum order quantity",
  settingsPurchaseIncrement: "Purchase increment",
  settingsLastUpdatedBy: "Last change",
  alarmSwitchOn: "Switch the alarm on",
  alarmSwitchOff: "Switch the alarm off",
  dryRunSwitchOn: "Switch dry run on",
  dryRunSwitchOff: "Switch dry run off",
  accessHrId: "Employee id",
  accessLevel: "Access level",
  accessLevelRead: "Read only",
  accessLevelFull: "Full control",
  accessRemove: "Remove the access",
  accessNoneYet: "No extra access recorded",
  accessNamedInCode: "Fixed in the code",

  // ── Outcomes, impersonal throughout ───────────────────────────────────────────────────────────
  saved: "Saved",
  saveFailed: "Could not save",
  loadFailed: "Could not load the data",
  notLoaded: "The data is not loaded",
  yes: "Yes",
  no: "No",
  stateOn: "On",
  stateOff: "Off",
  save: "Save",
  cancel: "Cancel",
  close: "Close",
  exportWorkbook: "Export to Excel",
  exportFailed: "Could not export",
  exportHint:
    "The file carries the formulas themselves — changing any yellow cell recalculates it inside Excel",
  loading: "Loading",
  nothingToShow: "Nothing to show",

  // ── The Excel export ──────────────────────────────────────────────────────────────────────────
  sheetName: "Plan",
  sheetInputsTitle: "Inputs — the yellow cells",
  sheetOutputsTitle: "Calculated result",
  sheetMaterialsTitle: "Raw materials",
  sheetCostTitle: "Purchase cost",
  sheetRequestedBoxes: "Total boxes requested",
  sheetRunVolume: "Run volume",
  sheetGoodUnitSize: "Saleable unit size",
  sheetSampleUnitSize: "Sample size",
  sheetDose: "Dose",
  sheetUnitsPerBox: "Units per box",
  sheetGoodUnitsRequested: "Saleable units requested",
  sheetNeededVolume: "Required volume",
  sheetTotalVolume: "Total volume",
  sheetTotalDoses: "Total doses",
  sheetPackagingSets: "Total full packaging sets",
  sheetTotalBoxes: "Total boxes (cartons)",
  sheetSaleableBoxes: "Saleable boxes, without the samples",
  sheetStripsPerBox: "Strips per box",
  sheetTotalStrips: "Total strips",
  sheetColBasisLabel: "Basis",
  sheetColQtyPerBasis: "Quantity per basis",
  sheetColBasisCount: "Basis count",
  sheetColSupplier: "Supplied by",
  sheetColPrice: "Unit price",
  sheetColCostUsd: "Cost in dollars",
  sheetColCostEgp: "Cost in pounds",
  sheetUnpricedNote: "The total leaves out every material with no price entered",
  sheetGeneratedOn: "Exported on",
  sheetGeneratedBy: "Exported by",

  // ── The reorder email ─────────────────────────────────────────────────────────────────────────
  // What the EMAIL itself sends (owner, 2026-10-09), and what the screen's severity chips read in
  // English. The Arabic half of these keys now serves the Arabic screen alone.
  alarmEmailSubject: "Raw-material reorder alarm",
  alarmSeverityOutOfStock: "No balance",
  alarmSeverityBelow: "Below the threshold",
  alarmSeverityApproaching: "Approaching the threshold",
  alarmLeadTimeNote: "Lead time",
  alarmNoneToday: "No material is below the threshold",
  alarmEmailStatus:
    "The figures are for one run with no samples, which is the basis cover is measured on.",
  alarmEmailCover: "Cover",
  alarmEmailHeld: "Held",
  unitDay: "day",

  expiryTitle: "Materials nearing their expiry date",
  expiryNoneFound: "Nothing expires inside the warning window",
  expirySeverityExpired: "Expired",
  expirySeverityCritical: "Expires very soon",
  expirySeverityWarning: "Inside the warning window",
  expiryEmailSubject: "Raw material expiry warning",
  expiryEmailStatus: "The figures are balances as reported, one expiry date at a time — not totalled.",
  expiryToday: "Expires today",
  expiryLastEvaluated: "Last checked",
  expiryLastSent: "Last sent",
};

/**
 * ── THE TWO ALARM EMAILS ARE ENGLISH, ALWAYS ────────────────────────────────────────────────────
 *
 * The owner, 2026-10-09, reading the Arabic reorder alarm in his own inbox: *"stop fucking using
 * arabic in the production planner never never never use arabic in it again all english everything
 * and also add quantities make it a premium polished zebra tabled clear email"*. Until that morning
 * both alarms were Arabic whichever way the screen toggle was set; they are now English end to end
 * — subject, greeting, summary, every column heading, every status word and the closing line — and
 * the screen's Arabic/English toggle does not reach them. A reader preference on one browser was
 * never what should decide the language of four other people's email.
 *
 * English-only and NOT part of the `PP` / `PP_EN` pair on purpose: a parallel Arabic catalogue for
 * these strings is the thing that must not exist, because a later call site could reach for it.
 *
 * The columns below are the second half of the same instruction — the quantities each get a column
 * of their own instead of being crushed into one sentence per row. Headings are written in the case
 * they are to appear in: `text-transform` is not on the email sanitizer's allowed-style list.
 */
export const PRODUCTION_PLANNING_EMAIL_EN = {
  colCover: "COVER",
  colExpiryDate: "EXPIRY DATE",
  colHeld: "HELD NOW",
  colLocation: "HELD AT",
  colMaterial: "MATERIAL",
  colPerRun: "NEEDED PER RUN",
  colQtyHeld: "QUANTITY HELD",
  colTimeLeft: "TIME LEFT",
  /** What a cell shows when the figure genuinely is not known — never a bare zero. */
  notKnown: "Lead time not set",
} as const;

/** One cell of an alarm email's grid. Structurally the layout's `PhoenixEmailGridCell`, declared
 * here so this catalogue stays importable by a test runner that cannot load a `.tsx` file. */
export type ProductionPlanningEmailCell = {
  readonly text: string;
  /** A quiet second line under the figure — the same quantity in boxes. */
  readonly sub?: string;
  readonly note?: string;
  readonly tone?: "neutral" | "danger" | "warning" | "ok";
};

/**
 * A box count as the email says it (owner, 2026-10-09: "put quantities in kg and number of boxes").
 *
 * A kilogram means nothing to the person deciding whether to buy — boxes are what he counts in, so
 * every quantity carries what it comes to in boxes underneath it. `count` arrives already formatted
 * with Latin digits and its thousands separators.
 */
export function boxesLabel(count: string): string {
  return `${count} ${count.trim() === "1" ? "box" : "boxes"}`;
}

/** Structurally the layout's `PhoenixEmailGridColumn`. */
export type ProductionPlanningEmailColumn = {
  readonly label: string;
  readonly align?: "left" | "right";
};

/**
 * FOUR columns, not five: the lead time rides under the cover figure rather than taking a column
 * of its own. Measured in the Browser pane at 375 px on 2026-10-09, five columns overflowed the
 * email shell by 57 px — and the repo's own rule for that is to MERGE a column, never to shrink
 * the type (AGENTS.md §4, the fits-the-screen rule).
 */
export const REORDER_EMAIL_COLUMNS: readonly ProductionPlanningEmailColumn[] = [
  { label: PRODUCTION_PLANNING_EMAIL_EN.colMaterial },
  { align: "right", label: PRODUCTION_PLANNING_EMAIL_EN.colHeld },
  { align: "right", label: PRODUCTION_PLANNING_EMAIL_EN.colPerRun },
  { align: "right", label: PRODUCTION_PLANNING_EMAIL_EN.colCover },
];

export const EXPIRY_EMAIL_COLUMNS: readonly ProductionPlanningEmailColumn[] = [
  { label: PRODUCTION_PLANNING_EMAIL_EN.colMaterial },
  { label: PRODUCTION_PLANNING_EMAIL_EN.colExpiryDate },
  { align: "right", label: PRODUCTION_PLANNING_EMAIL_EN.colTimeLeft },
  { align: "right", label: PRODUCTION_PLANNING_EMAIL_EN.colQtyHeld },
  { label: PRODUCTION_PLANNING_EMAIL_EN.colLocation },
];

/** How loudly a row is coloured. Out of stock is the only one that cannot wait for the next run. */
export const ALARM_SEVERITY_TONES = {
  approaching: "neutral",
  below_threshold: "warning",
  out_of_stock: "danger",
} as const satisfies Record<"out_of_stock" | "below_threshold" | "approaching", ProductionPlanningEmailCell["tone"]>;

export const EXPIRY_SEVERITY_TONES = {
  critical: "warning",
  expired: "danger",
  warning: "neutral",
} as const satisfies Record<ExpirySeverity, ProductionPlanningEmailCell["tone"]>;

/**
 * The reorder email's opening sentence.
 *
 * Here rather than in the sweep for the same reason the planner sentence is: the catalogue is the
 * one place the wording lives, so the email cannot drift from the screen showing the same verdict.
 * Every number arrives already formatted with Latin digits, so `count` is a string.
 */
export function buildAlarmEmailSummary(parts: { readonly productName: string; readonly count: string }): string {
  const one = parts.count.trim() === "1";
  return `In the ${parts.productName} plan, ${parts.count} of the materials Sato supplies ${one ? "has" : "have"} reached the reorder point. The quantities below are what is held now against what one full run needs.`;
}

/**
 * One reorder row, in the column order of `REORDER_EMAIL_COLUMNS`.
 *
 * Each quantity carries TWO figures: the amount in the unit he buys in (kilograms for a powder,
 * pieces for packaging) and, underneath, what that amount comes to in BOXES — his own unit of
 * account (owner, 2026-10-09). The box line is dropped when it would simply repeat the figure
 * above it, which is what happens to a packaging material that goes one to a box.
 */
export function buildReorderEmailRow(parts: {
  readonly materialName: string;
  readonly severityLabel: string;
  readonly tone: ProductionPlanningEmailCell["tone"];
  readonly heldText: string;
  readonly heldBoxes?: string | null;
  readonly perRunText: string;
  readonly perRunBoxes?: string | null;
  readonly unitLabel: string;
  readonly coverRuns: string;
  readonly leadTimeDays: string | null;
}): readonly ProductionPlanningEmailCell[] {
  const unit = parts.unitLabel.trim();
  const withUnit = (value: string) => (unit === "" ? value : `${value} ${unit}`);
  const boxes = (count: string | null | undefined, quantity: string) =>
    count === null || count === undefined || count.trim() === "" || count.trim() === quantity.trim()
      ? undefined
      : boxesLabel(count);
  return [
    { note: parts.severityLabel, text: parts.materialName, tone: parts.tone },
    { sub: boxes(parts.heldBoxes, parts.heldText), text: withUnit(parts.heldText) },
    { sub: boxes(parts.perRunBoxes, parts.perRunText), text: withUnit(parts.perRunText) },
    {
      sub:
        parts.leadTimeDays === null
          ? PRODUCTION_PLANNING_EMAIL_EN.notKnown
          : `${parts.leadTimeDays} ${parts.leadTimeDays.trim() === "1" ? "day" : "days"} lead time`,
      text: `${parts.coverRuns} ${parts.coverRuns.trim() === "1" ? "run" : "runs"}`,
    },
  ];
}

/** The three labels for who brings a material, keyed by the supplier the composition carries. */
export const SUPPLIER_LABELS = {
  sato: PP.chipSato,
  factory: PP.chipFactory,
  shared_unsettled: PP.chipUnsettled,
} as const;

/**
 * What a product is MEASURED in, and the two sizes a label may need to state.
 *
 * Every number arrives ALREADY FORMATTED with Latin digits — these builders never call
 * `toLocaleString`, because under an Arabic locale it emits ٠١٢٣ and the owner's Latin-digit ruling
 * is the one thing a label must not break.
 */
export type ProductMeasure = {
  /** One dose — a 5 ml spoonful, or a 5 g sachet. */
  readonly dose: string;
  /** One saleable unit — a 100 ml bottle, or a 5 g sachet. */
  readonly goodUnit: string;
  /** One free sample. */
  readonly sampleUnit: string;
  readonly measureUnit: MeasureUnit;
  /** How many saleable units a sample box holds, on a product whose sample is its own box. */
  readonly unitsInOwnSampleBox?: string;
};

/**
 * The small and large unit words for a product.
 *
 * 🔴 THE GEOMETRY COLUMNS ARE NAMED `…_ml` AND THE LABELS MUST NOT FOLLOW THEM. The arithmetic is
 * unit-free — a run is `runVolume / dose` whatever the unit — but every label was written when the
 * only product was a syrup, so a powder in 5 g sachets rendered "5 مل". This pair is what the labels
 * follow instead, and `measure_unit` on the product row is what picks it.
 *
 * 🔴 EVERY BRANCH HERE IS A `Record<MeasureUnit, …>`, NEVER A TERNARY, SINCE THE THIRD UNIT LANDED.
 * A `unit === "g" ? … : …` sends an unlisted unit down the SYRUP branch silently, which is exactly
 * how Royanoxicam's 155 mg tablet would have rendered "155 مل" — the same defect this pair was
 * created to fix for the powder. A record is exhaustive at compile time: a fourth unit fails the
 * type gate instead of quietly labelling itself in millilitres.
 */
export function measureUnitLabelsAr(unit: MeasureUnit): { small: string; large: string } {
  const labels: Record<MeasureUnit, { small: string; large: string }> = {
    g: { large: PP.unitKilogram, small: PP.unitGram },
    // A milligram geometry is still READ in kilograms: 31,000,000 mg is the owner's own "31 kg".
    mg: { large: PP.unitKilogram, small: PP.unitMilligram },
    mg_capsule: { large: PP.unitKilogram, small: PP.unitMilligram },
    ml: { large: PP.unitLitre, small: PP.unitMl },
  };
  return labels[unit];
}

export function measureUnitLabelsEn(unit: MeasureUnit): { small: string; large: string } {
  const labels: Record<MeasureUnit, { small: string; large: string }> = {
    g: { large: PP_EN.unitKilogram, small: PP_EN.unitGram },
    mg: { large: PP_EN.unitKilogram, small: PP_EN.unitMilligram },
    mg_capsule: { large: PP_EN.unitKilogram, small: PP_EN.unitMilligram },
    ml: { large: PP_EN.unitLitre, small: PP_EN.unitMl },
  };
  return labels[unit];
}

/**
 * The word for ONE SALEABLE UNIT — a sachet for the powder, a box for the syrup.
 *
 * 🔴 A SALEABLE UNIT AND A BOX ARE THE SAME THING ONLY ON IVYRONC, where a box holds one bottle.
 * Guamusin's box holds twelve sachets, so every label that said "علبة" for the thing the engine
 * counts in `goodUnits` was calling a sachet a box: the owner read a tile saying "10,000 علبة"
 * under a sentence saying "120,000 كيس" and could not tell which number the screen meant
 * (2026-10-08 — *"their is a mismatch in guamusin between the sachet and the 1 box have 12
 * sachets"*).
 */
export function saleableUnitWordAr(unit: MeasureUnit): string {
  const words: Record<MeasureUnit, string> = {
    g: PP.unitSachet,
    mg: PP.unitTablet,
    mg_capsule: PP.unitCapsule,
    ml: PP.unitBox,
  };
  return words[unit];
}

export function saleableUnitWordEn(unit: MeasureUnit): string {
  const words: Record<MeasureUnit, string> = {
    g: PP_EN.unitSachet,
    mg: PP_EN.unitTablet,
    mg_capsule: PP_EN.unitCapsule,
    ml: PP_EN.unitBox,
  };
  return words[unit];
}

/**
 * The English plural of a unit word.
 *
 * 🔴 NOT `word + "s"`. The catalogue stores `box` and `sachet` in the singular, so a bare `+ "s"`
 * renders **"boxs"** — and that is not a cosmetic slip, it rewrites the pinned Ivyronc sentence
 * ("96,000 boxes of 100 ml") that `tests/production-planning-strings.test.ts` asserts verbatim.
 * Arabic needs none of this: `علبة` and `كيس` follow a counted noun unchanged.
 */
export function pluralEn(word: string): string {
  return /(?:s|x|z|ch|sh)$/.test(word) ? `${word}es` : `${word}s`;
}

/**
 * A saleable-unit count with the box count it comes to in brackets — `120,000 كيس (10,000 علبة)`.
 *
 * The owner's instruction, 2026-10-08: *"in alll ur calulation show sachets number and between
 * brackets number of boxes for those sachets"*.
 *
 * 🔴 THE BRACKET IS OMITTED WHEN A BOX HOLDS ONE UNIT, which is every Ivyronc figure. Printing it
 * unconditionally reads `106,000 علبة (106,000 علبة)` — the same number twice, which is worse than
 * the ambiguity this exists to remove. `unitsPerBox` is the test and never the measure unit: a
 * powder sold in a one-sachet box would need no bracket either, and a syrup packed two bottles to
 * a box would need one.
 *
 * Both figures arrive ALREADY FORMATTED, because only the caller knows whether it holds a wire
 * string or a bigint, and `formatNumberLatin` is not idempotent over a string that already carries
 * separators.
 */
export function unitsWithBoxesAr(parts: {
  readonly units: string;
  readonly boxes: string;
  readonly unitsPerBox: string;
  readonly measureUnit: MeasureUnit;
}): string {
  const unitWord = saleableUnitWordAr(parts.measureUnit);
  if (parts.unitsPerBox === "1") return `${parts.units} ${unitWord}`;
  return `${parts.units} ${unitWord} (${parts.boxes} ${PP.unitBox})`;
}

export function unitsWithBoxesEn(parts: {
  readonly units: string;
  readonly boxes: string;
  readonly unitsPerBox: string;
  readonly measureUnit: MeasureUnit;
}): string {
  const unitWord = pluralEn(saleableUnitWordEn(parts.measureUnit));
  if (parts.unitsPerBox === "1") return `${parts.units} ${unitWord}`;
  return `${parts.units} ${unitWord} (${parts.boxes} ${pluralEn(PP_EN.unitBox)})`;
}

/**
 * "How many did the factory actually produce" — in the product's own saleable unit.
 *
 * 🔴 A SUFFIX WILL NOT DO HERE. Appending the unit to the flat string gives "العلب الناتجة فعليًا
 * (كيس)" — *boxes* produced, measured in *sachets* — and in English "Boxes actually produced
 * (sachet)", which contradicts itself in four words. `prodplan_runs.actual_good_units` has always
 * been a SALEABLE-UNIT column; it was only ever the noun that was wrong, so the noun is what moves.
 */
export function runActualLabelAr(unit: MeasureUnit): string {
  const labels: Record<MeasureUnit, string> = {
    g: "الأكياس الناتجة فعليًا",
    mg: "الأقراص الناتجة فعليًا",
    mg_capsule: "الكبسولات الناتجة فعليًا",
    ml: PP.runActualGoodUnits,
  };
  return labels[unit];
}

export function runActualLabelEn(unit: MeasureUnit): string {
  const labels: Record<MeasureUnit, string> = {
    g: "Sachets actually produced",
    mg: "Tablets actually produced",
    mg_capsule: "Capsules actually produced",
    ml: PP_EN.runActualGoodUnits,
  };
  return labels[unit];
}

/**
 * The run-size label — a VOLUME for the syrup, a WEIGHT for the powder.
 *
 * 🔴 "حجم التشغيلة" MEANS "RUN VOLUME", WHICH IS INCOHERENT FOR A POWDER WEIGHED IN KILOGRAMS. The
 * owner said it plainly on 2026-10-08 — *"1 run is 100kg not liter"*, then *"batch ( run size )
 * 100kg"*. The figure was already right and already labelled كجم; it was the NOUN that still
 * described a liquid, on the tile and on the exported sheet alike.
 */
export function runSizeLabelAr(unit: MeasureUnit): string {
  // A tablet batch is weighed too — the owner states Royanoxicam's as "batch size is 31 kg" — so
  // milligrams take the WEIGHT noun beside the powder, and only the syrup keeps "حجم".
  const labels: Record<MeasureUnit, string> = {
    g: PP.tileRunWeight,
    mg: PP.tileRunWeight,
    mg_capsule: PP.tileRunWeight,
    ml: PP.tileRunVolume,
  };
  return labels[unit];
}

export function runSizeLabelEn(unit: MeasureUnit): string {
  const labels: Record<MeasureUnit, string> = {
    g: PP_EN.tileRunWeight,
    mg: PP_EN.tileRunWeight,
    mg_capsule: PP_EN.tileRunWeight,
    ml: PP_EN.tileRunVolume,
  };
  return labels[unit];
}

/**
 * The request-mode labels, with the box's own contents spelled out.
 *
 * 🔴 THIS IS THE ONE THAT COULD COST A REAL ORDER, AND THE FIX IS NOT TO RENAME THE UNIT. The two
 * quantity modes mean BOXES to the engine (`resolveRunGeometry`, `mode: "total_boxes"`), so a label
 * reading "إجمالي الأكياس" would make the words and the arithmetic disagree — the input would say
 * sachets and the engine would still divide by twelve. Measured on Guamusin: typing his own sachet
 * figure of 120,000 into a box field orders **72 runs, not 6** — 1,440,000 sachets, 7.2 tonnes of
 * powder.
 *
 * So the unit stays what the engine reads, and the label says what a box HOLDS. Ivyronc, at one
 * bottle a box, gets the flat string back unchanged — there is nothing to disambiguate there.
 */
export function requestModeLabelsAr(parts: {
  readonly unitsPerBox: string;
  readonly measureUnit: MeasureUnit;
}): { total: string; goodUnits: string; runs: string } {
  if (parts.unitsPerBox === "1") {
    return { goodUnits: PP.requestModeGoodUnits, runs: PP.requestModeRuns, total: PP.requestModeTotalBoxes };
  }
  const per = `${parts.unitsPerBox} ${saleableUnitWordAr(parts.measureUnit)} في العلبة`;
  return {
    goodUnits: `${PP.requestModeGoodUnits} — ${per}`,
    runs: PP.requestModeRuns,
    total: `${PP.requestModeTotalBoxes} — ${per}`,
  };
}

export function requestModeLabelsEn(parts: {
  readonly unitsPerBox: string;
  readonly measureUnit: MeasureUnit;
}): { total: string; goodUnits: string; runs: string } {
  if (parts.unitsPerBox === "1") {
    return {
      goodUnits: PP_EN.requestModeGoodUnits,
      runs: PP_EN.requestModeRuns,
      total: PP_EN.requestModeTotalBoxes,
    };
  }
  const per = `${parts.unitsPerBox} ${pluralEn(saleableUnitWordEn(parts.measureUnit))} per box`;
  return {
    goodUnits: `${PP_EN.requestModeGoodUnits} — ${per}`,
    runs: PP_EN.requestModeRuns,
    total: `${PP_EN.requestModeTotalBoxes} — ${per}`,
  };
}

/**
 * The word after the count of units in a sample's own box: Arabic counts three to ten with the plural,
 * so `5 كبسولات`, and every other figure with the singular, so `12 كبسولة`.
 *
 * 🔴 IT IS LOCAL TO THIS ONE PHRASE. `PP.unitCapsule` stays singular because the sentence and the
 * request labels need it (`29,500 كبسولة`, `30 كبسولة في العلبة`), and the other three units keep
 * their word because no other product has a sample box of its own to read here.
 */
function ownSampleBoxUnitWordAr(count: string, unit: MeasureUnit): string {
  const threeToTen: Record<MeasureUnit, string> = {
    g: PP.unitSachet,
    mg: PP.unitTablet,
    mg_capsule: "كبسولات",
    ml: PP.unitBox,
  };
  const figure = Number(count.replaceAll(",", ""));
  return figure >= 3 && figure <= 10 ? threeToTen[unit] : saleableUnitWordAr(unit);
}

/**
 * The sample-size hint, with the product's own two sizes written into it.
 *
 * It used to be a flat string naming 40 ml and 100 ml, which were Ivyronc's. A hint that states a
 * measurement is more useful than one that does not — so the sizes stay, and they come from the
 * product instead of from the sentence.
 */
export function buildSampleUnitsHintAr(measure: ProductMeasure): string {
  const u = measureUnitLabelsAr(measure.measureUnit);
  if (measure.unitsInOwnSampleBox) {
    return (
      `العينة علبة مستقلة فيها ${measure.unitsInOwnSampleBox} ` +
      `${ownSampleBoxUnitWordAr(measure.unitsInOwnSampleBox, measure.measureUnit)} ` +
      `من نفس حجم التشغيلة — تقلل عدد العلب القابلة للبيع`
    );
  }
  return (
    `العينة ${measure.sampleUnit} ${u.small} من نفس حجم التشغيلة — ` +
    `تقلل عدد الوحدات ${measure.goodUnit} ${u.small} وتستهلك عبوة كاملة`
  );
}

export function buildSampleUnitsHintEn(measure: ProductMeasure): string {
  const u = measureUnitLabelsEn(measure.measureUnit);
  if (measure.unitsInOwnSampleBox) {
    return (
      `A sample is its own box of ${measure.unitsInOwnSampleBox} ` +
      `${pluralEn(saleableUnitWordEn(measure.measureUnit))} out of the same batch — ` +
      `it reduces the saleable box count`
    );
  }
  return (
    `A ${measure.sampleUnit} ${u.small} sample comes out of the same run volume — ` +
    `it reduces the ${measure.goodUnit} ${u.small} unit count and still uses a full packaging set`
  );
}

/**
 * How long one lot has left, as a phrase.
 *
 * Three branches and not a signed number: "باقي 24 يوم", "ينتهي اليوم" and "منتهي منذ 12 يوم" are
 * three different facts, and a bare `-12` on a screen is the one rendering of this that a tired
 * reader at 4am misreads as twelve days of cover.
 */
export function buildExpiryDaysNoteAr(daysLeft: string, expired: boolean, today: boolean): string {
  if (today) return PP.expiryToday;
  return expired ? `منتهي منذ ${daysLeft} ${PP.unitDay}` : `باقي ${daysLeft} ${PP.unitDay}`;
}

export function buildExpiryDaysNoteEn(daysLeft: string, expired: boolean, today: boolean): string {
  if (today) return PP_EN.expiryToday;
  return expired ? `expired ${daysLeft} days ago` : `${daysLeft} days left`;
}

/** The three expiry severity labels, keyed the way `evaluateExpiry` returns them. */
export const EXPIRY_SEVERITY_LABELS = {
  expired: PP.expirySeverityExpired,
  critical: PP.expirySeverityCritical,
  warning: PP.expirySeverityWarning,
} as const;

// `Record<ExpirySeverity, string>` and not `typeof EXPIRY_SEVERITY_LABELS`: the Arabic record is
// `as const`, so its type is the three Arabic literals and an English label cannot satisfy it. The
// KEYS are what must match, and the mapped type is what pins those — the same shape as its siblings.
export const EXPIRY_SEVERITY_LABELS_EN: Record<ExpirySeverity, string> = {
  expired: PP_EN.expirySeverityExpired,
  critical: PP_EN.expirySeverityCritical,
  warning: PP_EN.expirySeverityWarning,
};

/**
 * The expiry email's opening sentence — ENGLISH, like the reorder alarm beside it and for the same
 * instruction (2026-10-09). The screen toggle does not reach either email.
 */
export function buildExpiryEmailSummary(parts: { readonly productName: string; readonly count: string }): string {
  const one = parts.count.trim() === "1";
  return `In ${parts.productName}, ${parts.count} stock ${one ? "balance is" : "balances are"} already expired or inside the warning window. Each line is one lot, with the quantity held where it is held.`;
}

/** One expiry row, in the column order of `EXPIRY_EMAIL_COLUMNS`. */
export function buildExpiryEmailRow(parts: {
  readonly materialName: string;
  readonly severityLabel: string;
  readonly tone: ProductionPlanningEmailCell["tone"];
  readonly expiryDate: string;
  readonly daysNote: string;
  readonly heldText: string;
  readonly unitLabel: string;
  readonly locationName: string;
}): readonly ProductionPlanningEmailCell[] {
  const unit = parts.unitLabel.trim();
  return [
    { note: parts.severityLabel, text: parts.materialName, tone: parts.tone },
    { text: parts.expiryDate },
    { text: parts.daysNote },
    { text: unit === "" ? parts.heldText : `${parts.heldText} ${unit}` },
    { text: parts.locationName },
  ];
}

/**
 * The generic half of each basis label — no measurement, so it is the same for every product.
 *
 * `per_dose` used to read "لكل جرعة 5 مل". The 5 and the مل were Ivyronc's, so the label is built
 * per product by `basisLabelsAr` below; this record is what that builder starts from, and what the
 * Arabic-digit sweep in tests/production-planning-strings.test.ts reads.
 */
export const BASIS_LABELS = {
  per_dose: "لكل جرعة",
  per_packaging_set: "لكل عبوة كاملة",
  // "وحدة" and not "علبة": the saleable unit is a 100 ml bottle for Ivyronc and a 5 g sachet for
  // Guamusin, and calling a sachet a box is the same class of error as calling a gram a millilitre.
  per_good_unit: "لكل وحدة قابلة للبيع",
  per_sample_unit: "لكل عينة",
  /** The carton he counts in — 12 sachets for Guamusin, consumed once per box and not once per sachet. */
  per_box: "لكل علبة (كرتونة)",
  /** One blister strip, as Saginkgo's foil is counted: 3 a box and 1 a sample. */
  per_strip: "لكل شريط",
} as const;

/** The same labels with the product's own dose written into the per-dose one. */
export function basisLabelsAr(measure: ProductMeasure): Record<CompositionBasis, string> {
  return {
    ...BASIS_LABELS,
    per_dose: `${BASIS_LABELS.per_dose} ${measure.dose} ${measureUnitLabelsAr(measure.measureUnit).small}`,
  };
}

export const ALARM_SEVERITY_LABELS = {
  out_of_stock: PP.alarmSeverityOutOfStock,
  below_threshold: PP.alarmSeverityBelow,
  approaching: PP.alarmSeverityApproaching,
} as const;

/**
 * The title a committed plan is STORED under, and the one reader-visible string in this module
 * that does not follow the language toggle (owner, 2026-10-06, asked directly: "pin the stored
 * plan title as Arabic").
 *
 * The reason is that a stored title is not a screen — it is a row, and both readers meet the same
 * rows later in the same Plans list, so a title following whoever saved it would mix Arabic and
 * English entries there with nothing to explain the pattern.
 *
 * It lives here, beside the bundles, for one reason: it is the only way the ruling can be pinned by
 * the VALUE it produces. `savePlan` builds the row with Supabase in hand, so a test cannot call it;
 * reading the service's source text instead pins the expression and not the string, and an
 * expression can be rewritten into something that still matches while producing English. A pure
 * function here is callable from the test, so the assertion is on `"… — 3 تشغيلة"` itself.
 *
 * `runs` arrives ALREADY FORMATTED and is passed through verbatim. `savePlan` reads it off a
 * result whose `runs` is a `string` (`service.ts`: `formatNumberLatin(run.runs)`), so this takes a
 * string and must NOT re-format it — a second formatting step here is the one way the module's
 * Latin-digit rule gets broken, because `toLocaleString` under an Arabic locale emits ٠١٢٣. This
 * was typed `number` when first written on 2026-10-06, which the template literal it replaced had
 * accepted silently: the inline `${result.runs}` interpolated exactly this string.
 */
export function storedPlanTitle(productNameAr: string, runs: string): string {
  return `${productNameAr} — ${runs} ${PP.unitRuns}`;
}

/**
 * The saleable box count in the sentence's bracket. ROUNDED UP: a part-box is still a box (owner,
 * 2026-10-24), so Saginkgo's 29,500 capsules are 984 boxes of thirty, the count the engine adds its
 * sample boxes to, and never 983. Both languages come through here so they cannot differ.
 */
function saleableBoxesLabel(goodUnits: string, unitsPerBox: string): string {
  return formatNumberLatin(ceilDiv(BigInt(goodUnits.replaceAll(",", "")), BigInt(unitsPerBox)));
}

/**
 * The sentence under the four tiles.
 *
 * Built here rather than in the component so the workbook's own header row says exactly the same
 * thing, and so the test can read it without rendering anything. Every number is passed in already
 * formatted with Latin digits; the caller wraps each one in its own `dir="ltr"` element.
 */
export function buildPlannerSentence(parts: {
  readonly runs: string;
  readonly runVolumeLitres: string;
  readonly totalVolumeLitres: string;
  readonly goodUnits: string;
  readonly goodUnitMl: string;
  readonly sampleUnits: string;
  readonly sampleUnitMl: string;
  readonly surplusBoxes: string | null;
  readonly shortfallBoxes: string | null;
  /**
   * What the figures are counted in. OPTIONAL and defaulting to `ml`, so the pinned Ivyronc sentence
   * in tests/production-planning-strings.test.ts keeps reading exactly as it did — the syrup wording
   * is not a special case here, it is still the default.
   */
  readonly measureUnit?: MeasureUnit;
  /**
   * How many saleable units go in one box, and the box count they come to.
   *
   * BOTH optional and both defaulting to the no-bracket case, for the same reason `measureUnit` is:
   * Ivyronc packs one bottle to a box, so its pinned sentence must keep reading exactly as it did.
   * The bracket appears only when a box genuinely holds more than one unit.
   */
  readonly unitsPerBox?: string;
  readonly totalBoxes?: string;
}): string {
  const u = measureUnitLabelsAr(parts.measureUnit ?? "ml");
  const measure = parts.measureUnit ?? "ml";
  // A powder's saleable unit is a sachet, a syrup's is a box — the word follows the measure, because
  // "20,000 علبة 5 جم" would be calling a sachet a box.
  const unitWord = saleableUnitWordAr(measure);
  const head =
    `${parts.runs} ${PP.unitRuns} × ${parts.runVolumeLitres} ${u.large} = ` +
    `${parts.totalVolumeLitres} ${u.large}`;
  // The owner's bracket. `goodUnits` is the SALEABLE count and `totalBoxes` already includes the
  // samples' own boxes, so the bracket is built from the saleable count alone — printing the whole
  // box figure beside the saleable one would read as its equivalent and be larger than it.
  const perBox = parts.unitsPerBox ?? "1";
  const saleableBoxes =
    perBox === "1" || !parts.totalBoxes ? null : saleableBoxesLabel(parts.goodUnits, perBox);
  const saleable = saleableBoxes
    ? `${parts.goodUnits} ${unitWord} (${saleableBoxes} ${PP.unitBox})`
    : `${parts.goodUnits} ${unitWord}`;
  const yieldText =
    parts.sampleUnits === "0"
      ? `${saleable} ${parts.goodUnitMl} ${u.small}`
      : `${saleable} ${parts.goodUnitMl} ${u.small} و ${parts.sampleUnits} ` +
        `${PP.unitSample} ${parts.sampleUnitMl} ${u.small}`;
  const tail =
    parts.surplusBoxes && parts.surplusBoxes !== "0"
      ? `، بزيادة ${parts.surplusBoxes} ${PP.unitBox} عن المطلوب`
      : parts.shortfallBoxes && parts.shortfallBoxes !== "0"
        ? `، بنقص ${parts.shortfallBoxes} ${PP.unitBox} عن المطلوب`
        : "";
  return `${head} — ${yieldText}${tail}`;
}

/**
 * A number with Latin digits and thousands separators.
 *
 * `en-EG` and not `ar-EG`: the Arabic-Egypt locale emits ٠١٢٣ and `ج.م.`, and the owner chose Latin
 * digits. A currency is never formatted here — `formatMoney` in costing.ts produces the digits and
 * the currency is a separate label, because `style: "currency"` inserts a space whose character
 * depends on the reader's ICU build, which is a measured hydration failure in this app.
 */
export function formatNumberLatin(value: string | number | bigint): string {
  const text = typeof value === "string" ? value : value.toString();
  const negative = text.startsWith("-");
  const magnitude = negative ? text.slice(1) : text;
  const dot = magnitude.indexOf(".");
  const whole = dot < 0 ? magnitude : magnitude.slice(0, dot);
  const fraction = dot < 0 ? "" : magnitude.slice(dot + 1);
  if (!/^\d+$/.test(whole)) return text;
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const out = fraction ? `${grouped}.${fraction}` : grouped;
  return negative ? `-${out}` : out;
}

/**
 * A stored unit code rendered as the Arabic word for it.
 *
 * `prodplan_materials.display_unit` holds `kg` and `piece`, which is right for a database column
 * and wrong on the screen: measured in the browser on 2026-10-06, the live planner read
 * `109,180 piece` and `72.1 kg` an inch below a tile saying `106,000 علبة`, so every quantity in
 * the result table was labelled in English on a page that is Arabic everywhere else.
 *
 * A MAP and not a rename, deliberately. The stored code is what the engine, the composite
 * `unit_kind` foreign key and the price-per-unit arithmetic all key on, so it stays exactly as it
 * is; only the label a reader sees is translated. An unmapped code falls through to itself rather
 * than to an empty string: a unit a Settings edit introduces next year shows up untranslated, which
 * is a legible gap, where a blank would silently drop the unit off a buy quantity.
 */
const UNIT_LABELS_AR: Record<string, string> = {
  g: "جم",
  kg: "كجم",
  l: "لتر",
  litre: "لتر",
  ml: "مل",
  piece: "قطعة",
  ton: "طن",
};

export function unitLabelAr(unit: string | null | undefined): string {
  if (!unit) return "";
  return UNIT_LABELS_AR[unit.trim().toLowerCase()] ?? unit;
}

// ── The toggle: one bundle per language, and the ONLY thing the screen reads ─────────────────────

/**
 * The English half of the three label maps and the two sentences.
 *
 * Kept beside their Arabic originals rather than inside the bundle factory so each pair can be read
 * as a pair — a label that drifts in one language and not the other is the whole failure mode of a
 * second catalogue.
 */
export const PRODUCTION_PLANNING_TABS_EN: readonly { key: ProductionPlanningTabKey; label: string }[] = [
  { key: "planner", label: "Planner" },
  { key: "stock", label: "Stock" },
  { key: "cost", label: "Cost" },
  { key: "run", label: "Record a run" },
  { key: "settings", label: "Settings" },
] as const;

export const BASIS_LABELS_EN = {
  per_dose: "per dose",
  per_packaging_set: "per full packaging set",
  // "unit" and not "box": a saleable unit is a 100 ml bottle for Ivyronc and a 5 g sachet for
  // Guamusin, and `per_box` below is the carton that holds twelve of them.
  per_good_unit: "per saleable unit",
  per_sample_unit: "per sample",
  per_box: "per box (carton)",
  per_strip: "per strip",
} as const;

/** The same labels with the product's own dose written into the per-dose one. */
export function basisLabelsEn(measure: ProductMeasure): Record<CompositionBasis, string> {
  return {
    ...BASIS_LABELS_EN,
    per_dose: `per ${measure.dose} ${measureUnitLabelsEn(measure.measureUnit).small} dose`,
  };
}

/**
 * The stored unit codes are already English (`kg`, `piece`), so this maps them to the words a
 * reader expects rather than translating them — `piece` reads as a column name, `pieces` as a
 * quantity. An unmapped code falls through to itself, same as the Arabic map, so a unit a Settings
 * edit introduces next year shows up untranslated instead of silently vanishing off a quantity.
 */
const UNIT_LABELS_EN: Record<string, string> = {
  g: "g",
  kg: "kg",
  l: "L",
  litre: "L",
  ml: "ml",
  piece: "pieces",
  ton: "t",
};

export function unitLabelEn(unit: string | null | undefined): string {
  if (!unit) return "";
  return UNIT_LABELS_EN[unit.trim().toLowerCase()] ?? unit;
}

/** The sentence under the four tiles, in English. Same inputs, same order, same three branches. */
export function buildPlannerSentenceEn(parts: {
  readonly runs: string;
  readonly runVolumeLitres: string;
  readonly totalVolumeLitres: string;
  readonly goodUnits: string;
  readonly goodUnitMl: string;
  readonly sampleUnits: string;
  readonly sampleUnitMl: string;
  readonly surplusBoxes: string | null;
  readonly shortfallBoxes: string | null;
  /** Optional and defaulting to `ml`, so the pinned Ivyronc sentence is unchanged. */
  readonly measureUnit?: MeasureUnit;
  /** Both optional and both defaulting to the no-bracket case — see the Arabic builder. */
  readonly unitsPerBox?: string;
  readonly totalBoxes?: string;
}): string {
  const u = measureUnitLabelsEn(parts.measureUnit ?? "ml");
  const unitWord = pluralEn(saleableUnitWordEn(parts.measureUnit ?? "ml"));
  const head =
    `${parts.runs} ${parts.runs === "1" ? PP_EN.unitRun : PP_EN.unitRuns} × ${parts.runVolumeLitres} ` +
    `${u.large} = ${parts.totalVolumeLitres} ${u.large}`;
  const perBox = parts.unitsPerBox ?? "1";
  const saleableBoxes =
    perBox === "1" || !parts.totalBoxes ? null : saleableBoxesLabel(parts.goodUnits, perBox);
  const saleable = saleableBoxes
    ? `${parts.goodUnits} ${unitWord} (${saleableBoxes} ${pluralEn(PP_EN.unitBox)})`
    : `${parts.goodUnits} ${unitWord}`;
  const yieldText =
    parts.sampleUnits === "0"
      ? `${saleable} of ${parts.goodUnitMl} ${u.small}`
      : `${saleable} of ${parts.goodUnitMl} ${u.small} and ${parts.sampleUnits} ` +
        `samples of ${parts.sampleUnitMl} ${u.small}`;
  const tail =
    parts.surplusBoxes && parts.surplusBoxes !== "0"
      ? `, ${parts.surplusBoxes} boxes over the request`
      : parts.shortfallBoxes && parts.shortfallBoxes !== "0"
        ? `, ${parts.shortfallBoxes} boxes short of the request`
        : "";
  return `${head} — ${yieldText}${tail}`;
}

export const SUPPLIER_LABELS_EN = {
  sato: PP_EN.chipSato,
  factory: PP_EN.chipFactory,
  shared_unsettled: PP_EN.chipUnsettled,
} as const;

export const ALARM_SEVERITY_LABELS_EN = {
  out_of_stock: PP_EN.alarmSeverityOutOfStock,
  below_threshold: PP_EN.alarmSeverityBelow,
  approaching: PP_EN.alarmSeverityApproaching,
} as const;

/**
 * The validation messages the SERVER throws, in both languages.
 *
 * They are in here and not written at each throw site because the owner chose the module's
 * language with a toggle (2026-10-06), and a message is the one piece of the module a reader only
 * ever sees when something has already gone wrong — an Arabic sentence landing on an English
 * screen at exactly that moment reads as a broken page rather than as a language. The request
 * carries its `lang`, so `errorsFor(body)` in `service.ts` resolves them per request.
 *
 * Each one names what is wrong with the INPUT and nothing about the database behind it: a column
 * name or a constraint reaching a screen is a different defect, which `clientSafeErrorMessage`
 * covers for everything that is not one of these.
 */
export type ProductionPlanningErrorKey =
  | "unknownBasis"
  | "stripBasisNeedsStrips"
  | "runLabelRequired"
  | "priceMustBePositive"
  | "unknownCurrency"
  | "qtyMustBePositive"
  | "materialNotFound"
  | "materialRequired"
  // Retire and restore are ONE endpoint with a boolean, so a body that forgets the flag must be
  // refused rather than defaulted: either default silently does the opposite of what was meant.
  | "activeFlagRequired"
  | "materialAndLocationRequired"
  | "productNotFound"
  | "hrIdRequired"
  | "exclusionReasonRequired"
  | "fxRateMustBePositive"
  | "noProductToPlan"
  | "rowMaterialMissingId"
  | "rowMaterialNotFound"
  | "unknownAccessLevel"
  | "unknownStockSource"
  | "unknownSupplier"
  | "unknownUnitKind"
  | "expiryDateInvalid"
  | "expiryDateUnchanged"
  | "stockLotNotFound"
  | "moveDestinationRequired"
  | "moveQtyTooLarge"
  | "moveUnitKindMismatch"
  | "unitsPerBoxInvalid"
  | "stripsPerBoxInvalid"
  | "stripsInUse"
  | "shownWeightInvalid";

export const PRODUCTION_PLANNING_ERRORS: Record<ProductionPlanningErrorKey, string> = {
  unknownBasis: "أساس الحساب غير معروف.",
  stripBasisNeedsStrips: "هذا المنتج لا يحدد عدد الشرائط في العلبة، فلا يمكن الحساب لكل شريط.",
  runLabelRequired: "اسم التشغيلة مطلوب.",
  priceMustBePositive: "السعر يجب أن يكون أكبر من صفر.",
  unknownCurrency: "العملة غير معروفة.",
  qtyMustBePositive: "الكمية يجب أن تكون أكبر من صفر.",
  materialNotFound: "المادة غير موجودة.",
  materialRequired: "المادة مطلوبة.",
  activeFlagRequired: "يجب تحديد إيقاف المادة أو إرجاعها.",
  materialAndLocationRequired: "المادة والموقع مطلوبان.",
  productNotFound: "المنتج غير موجود.",
  hrIdRequired: "رقم الموظف مطلوب.",
  exclusionReasonRequired: "سبب الاستثناء مطلوب.",
  fxRateMustBePositive: "سعر الصرف يجب أن يكون أكبر من صفر.",
  noProductToPlan: "لا يوجد منتج لحساب احتياجه.",
  rowMaterialMissingId: "مادة بدون معرِّف في أحد السطور.",
  rowMaterialNotFound: "مادة غير موجودة في أحد السطور.",
  unknownAccessLevel: "مستوى الصلاحية غير معروف.",
  unknownStockSource: "مصدر تقرير المخزون غير معروف.",
  unknownSupplier: "مورد المادة غير معروف.",
  unknownUnitKind: "نوع الوحدة غير معروف.",
  expiryDateInvalid: "تاريخ الانتهاء يجب أن يكون بالشكل سنة-شهر-يوم (مثال 2027-04-27).",
  expiryDateUnchanged: "التاريخ الجديد هو نفس تاريخ الرصيد الحالي.",
  stockLotNotFound: "لا توجد كمية في هذا الرصيد لنقلها.",
  moveDestinationRequired: "يلزم تحديد جهة واحدة للنقل: مخزن آخر أو مادة أخرى.",
  moveQtyTooLarge: "الكمية المطلوب نقلها أكبر من الموجود في هذا الرصيد.",
  moveUnitKindMismatch: "لا يمكن النقل بين مادتين بوحدتين مختلفتين (وزن وعدد مثلًا).",
  unitsPerBoxInvalid: "عدد الوحدات في العلبة يجب أن يكون عددًا صحيحًا بين 1 و1000.",
  stripsPerBoxInvalid: "عدد الشرائط في العلبة يجب أن يكون عددًا صحيحًا بين 1 و1000، أو يُترك فارغًا.",
  stripsInUse: "لا يمكن حذف عدد الشرائط ما دامت هناك مادة محسوبة لكل شريط في هذا المنتج.",
  shownWeightInvalid: "الوزن المعروض يجب أن يكون رقمًا أكبر من صفر، بأربعة أرقام عشرية على الأكثر، أو يُترك فارغًا.",
};

export const PRODUCTION_PLANNING_ERRORS_EN: Record<ProductionPlanningErrorKey, string> = {
  unknownBasis: "Unknown calculation basis.",
  stripBasisNeedsStrips: "This product does not say how many strips its box holds, so a per-strip line cannot be counted.",
  runLabelRequired: "A run name is required.",
  priceMustBePositive: "A price must be greater than zero.",
  unknownCurrency: "Unknown currency.",
  qtyMustBePositive: "A quantity must be greater than zero.",
  materialNotFound: "No such material.",
  materialRequired: "A material is required.",
  activeFlagRequired: "Say whether the material is being retired or restored.",
  materialAndLocationRequired: "A material and a location are both required.",
  productNotFound: "No such product.",
  hrIdRequired: "An employee id is required.",
  exclusionReasonRequired: "A reason for excluding the run is required.",
  fxRateMustBePositive: "An exchange rate must be greater than zero.",
  noProductToPlan: "There is no product to plan for.",
  rowMaterialMissingId: "One of the rows has a material with no id.",
  rowMaterialNotFound: "One of the rows names a material that does not exist.",
  unknownAccessLevel: "Unknown access level.",
  unknownStockSource: "Unknown stock report source.",
  unknownSupplier: "Unknown material supplier.",
  unknownUnitKind: "Unknown unit kind.",
  expiryDateInvalid: "An expiry date must be written year-month-day (for example 2027-04-27).",
  expiryDateUnchanged: "The new date is the date this lot already has.",
  stockLotNotFound: "This lot holds no quantity to move.",
  moveDestinationRequired: "Choose one place to move it to: another store or another material.",
  moveQtyTooLarge: "That is more than this lot holds.",
  moveUnitKindMismatch: "Stock cannot move between two materials counted in different units (weight and count, for example).",
  unitsPerBoxInvalid: "Units per box must be a whole number from 1 to 1000.",
  stripsPerBoxInvalid: "Strips per box must be a whole number from 1 to 1000, or left blank.",
  stripsInUse: "Strips per box cannot be cleared while a material in this product is counted per strip.",
  shownWeightInvalid: "A shown weight must be a number above zero with at most four decimals, or left blank.",
};

/**
 * The two refusals that NAME A MATERIAL, so they cannot live in the flat `errors` map.
 *
 * They are kept here with every other string for the reason the whole catalogue exists: both were
 * written as Arabic template literals inside `service.ts`, where the double-quote guard in
 * `tests/production-planning-strings.test.ts` could not see them, so an English reader hit a wall of
 * Arabic on the two refusals that matter most — the only two that tell somebody what to go and fix.
 * Found by the access sweep on 2026-10-06; the guard now reads backticks too.
 *
 * The list separator belongs to the language and not to the caller: Arabic joins on `، `, English on
 * `, `. That is exactly the kind of detail a call site gets wrong once and nobody ever notices.
 */
export const PRODUCTION_PLANNING_REFUSALS = {
  closingOverOpening: (materialName: string) =>
    `${materialName}: رصيد آخر المدة أكبر من رصيد أول المدة زائد المُسلَّم.`,
  unsettledSuppliers: (materialNames: readonly string[]) =>
    `لا يمكن اعتماد الخطة قبل تحديد من يورد: ${materialNames.join("، ")}`,
  deliveryBehindANewerReport: (newestDate: string) =>
    `يوجد تقرير مخزون أحدث (${newestDate}) من تاريخ هذا التسليم، فلا تُضاف الكمية تلقائيًا — تُسجّل كتسوية بالرصيد النهائي.`,
} as const;

export const PRODUCTION_PLANNING_REFUSALS_EN: typeof PRODUCTION_PLANNING_REFUSALS = {
  closingOverOpening: (materialName: string) =>
    `${materialName}: the closing balance is larger than the opening balance plus what was delivered.`,
  unsettledSuppliers: (materialNames: readonly string[]) =>
    `The plan cannot be committed until somebody says who supplies: ${materialNames.join(", ")}`,
  deliveryBehindANewerReport: (newestDate: string) =>
    `A newer stock report (${newestDate}) already stands after this delivery’s date, so the amount is not added automatically — record it as an adjustment carrying the final balance.`,
};

export type ProductionPlanningNamed = { readonly nameAr: string; readonly nameEn: string };

/** Arabic reads `nameAr`. */
export function nameArabic(item: ProductionPlanningNamed): string {
  return item.nameAr;
}

/**
 * English reads `nameEn`. A blank English name falls back to the Arabic one rather than to an empty
 * cell: a row naming nothing is worse than a row in the other language, and the strings test sweeps
 * the live master so the fallback is never the normal path.
 */
export function nameEnglish(item: ProductionPlanningNamed): string {
  return item.nameEn.trim() !== "" ? item.nameEn : item.nameAr;
}

export type ProductionPlanningStrings = {
  readonly lang: ProductionPlanningLanguage;
  /** What the workspace root sets. The whole module flips direction, not just its text. */
  readonly dir: "rtl" | "ltr";
  /**
   * The Arabic face stack, or `undefined` in English so the page's own type is used. A Latin page
   * forced onto an Arabic-first stack reads as a different app from every other English screen.
   */
  readonly fontStack: string | undefined;
  readonly t: Record<ProductionPlanningStringKey, string>;
  readonly errors: Record<ProductionPlanningErrorKey, string>;
  /** The refusals that name a material, and so own their own list separator. */
  readonly refusals: typeof PRODUCTION_PLANNING_REFUSALS;
  readonly tabs: readonly { key: ProductionPlanningTabKey; label: string }[];
  readonly supplierLabels: Record<"sato" | "factory" | "shared_unsettled", string>;
  /**
   * A FUNCTION of the product's own geometry, not a flat record.
   *
   * `per_dose` reads "لكل جرعة 5 مل" for the syrup and "لكل جرعة 5 جم" for the powder, and neither
   * sentence can be written without knowing which product is on screen. Call it once per render and
   * index the result exactly as before.
   */
  readonly basisLabels: (measure: ProductMeasure) => Record<CompositionBasis, string>;
  readonly severityLabels: Record<"out_of_stock" | "below_threshold" | "approaching", string>;
  readonly expirySeverityLabels: Record<ExpirySeverity, string>;
  /** The two unit words for a product — ml/L for a syrup, g/kg for a powder. */
  readonly measureUnitLabels: (unit: MeasureUnit) => { small: string; large: string };
  /** The sample-size hint with the product's own two sizes in it. */
  readonly sampleUnitsHint: (measure: ProductMeasure) => string;
  /** How long one lot has left: three branches, never a signed number. */
  readonly expiryDaysNote: (daysLeft: string, expired: boolean, today: boolean) => string;
  readonly unitLabel: (unit: string | null | undefined) => string;
  /**
   * A product's, material's or location's name in the reader's language. Every one of them stores
   * both names, so nothing is translated here: the Arabic bundle reads the Arabic name, the English
   * bundle the English one.
   */
  readonly name: (item: ProductionPlanningNamed) => string;
  readonly plannerSentence: typeof buildPlannerSentence;
  /** The word for one saleable unit — a sachet for the powder, a box for the syrup. */
  readonly saleableUnitWord: (unit: MeasureUnit) => string;
  /**
   * A saleable-unit count with its box count in brackets, the owner's 2026-10-08 instruction.
   * Silently drops the bracket when a box holds one unit, so Ivyronc reads exactly as before.
   */
  readonly unitsWithBoxes: typeof unitsWithBoxesAr;
  /** "حجم التشغيلة" for a volume, "وزن التشغيلة" for a weight. */
  readonly runSizeLabel: (unit: MeasureUnit) => string;
  /** "How many did the factory produce" in the product's own saleable unit. */
  readonly runActualLabel: (unit: MeasureUnit) => string;
  /** The request-mode labels in the product's own saleable unit. */
  readonly requestModeLabels: typeof requestModeLabelsAr;
};

const AR_BUNDLE: ProductionPlanningStrings = {
  basisLabels: basisLabelsAr,
  dir: "rtl",
  errors: PRODUCTION_PLANNING_ERRORS,
  expiryDaysNote: buildExpiryDaysNoteAr,
  expirySeverityLabels: EXPIRY_SEVERITY_LABELS,
  fontStack: PRODUCTION_PLANNING_FONT_STACK,
  lang: "ar",
  measureUnitLabels: measureUnitLabelsAr,
  name: nameArabic,
  plannerSentence: buildPlannerSentence,
  refusals: PRODUCTION_PLANNING_REFUSALS,
  requestModeLabels: requestModeLabelsAr,
  runActualLabel: runActualLabelAr,
  runSizeLabel: runSizeLabelAr,
  saleableUnitWord: saleableUnitWordAr,
  sampleUnitsHint: buildSampleUnitsHintAr,
  severityLabels: ALARM_SEVERITY_LABELS,
  supplierLabels: SUPPLIER_LABELS,
  t: PP,
  tabs: PRODUCTION_PLANNING_TABS,
  unitLabel: unitLabelAr,
  unitsWithBoxes: unitsWithBoxesAr,
};

const EN_BUNDLE: ProductionPlanningStrings = {
  basisLabels: basisLabelsEn,
  dir: "ltr",
  errors: PRODUCTION_PLANNING_ERRORS_EN,
  expiryDaysNote: buildExpiryDaysNoteEn,
  expirySeverityLabels: EXPIRY_SEVERITY_LABELS_EN,
  fontStack: undefined,
  lang: "en",
  measureUnitLabels: measureUnitLabelsEn,
  name: nameEnglish,
  plannerSentence: buildPlannerSentenceEn,
  refusals: PRODUCTION_PLANNING_REFUSALS_EN,
  requestModeLabels: requestModeLabelsEn,
  runActualLabel: runActualLabelEn,
  runSizeLabel: runSizeLabelEn,
  saleableUnitWord: saleableUnitWordEn,
  sampleUnitsHint: buildSampleUnitsHintEn,
  severityLabels: ALARM_SEVERITY_LABELS_EN,
  supplierLabels: SUPPLIER_LABELS_EN,
  t: PP_EN,
  tabs: PRODUCTION_PLANNING_TABS_EN,
  unitLabel: unitLabelEn,
  unitsWithBoxes: unitsWithBoxesEn,
};

/**
 * Everything the screen and the workbook read, for one language.
 *
 * ONE accessor and not two imports per call site: the whole point of the toggle is that nothing can
 * render half the module in the other language, and the way that happens is a component reaching
 * for `PP` directly because it only needed one word. Both bundles are module-level constants, so
 * this allocates nothing per render and is safe to call inside one.
 */
export function productionPlanningStrings(lang: ProductionPlanningLanguage): ProductionPlanningStrings {
  return lang === "en" ? EN_BUNDLE : AR_BUNDLE;
}
