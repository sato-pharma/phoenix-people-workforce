/**
 * Production Planner — every word on the screen and in the workbook, in one place.
 *
 * The owner asked for this module in Egyptian Arabic ("طبعا اللغه دي عربي عربي عربيك ايجيبشن
 * عربيك") with an Excel export carrying the live formulas. The workbook and the workspace import
 * THIS file, so a heading cannot say one thing on screen and another in the sheet.
 *
 * ── Genderless by construction, and why it is not optional here ──────────────────────────────────
 *
 * Both primary users are women: Dr. Sahar Khalil, the R&D Manager, and Reham Elwiy, the Regulatory
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
 * ── The one import, and why it is type-only ──────────────────────────────────────────────────────
 *
 * This file is otherwise a LEAF: it imports nothing at runtime, which is what lets the cron, the
 * workbook builder and a `"use client"` component all read it without pulling anything behind it.
 * `import type` emits no code at all, so taking the two unions from the kernel keeps that property
 * while making a drifted basis or measure unit a compile error rather than a label that silently
 * stops matching.
 */
import type { ExpirySeverity } from "./expiry";
import type { CompositionBasis, MeasureUnit } from "./rules";

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
 * The material label a row of the reorder email carries. The email is Arabic whichever way the toggle
 * is set, so this is the Arabic name — with the packaging row spelled out. A function of its own
 * (not inline in the sweep) because the sweep imports the email service and a test cannot load it.
 */
export function reorderEmailMaterialLabel(code: string, storedNameAr: string): string {
  return code === PACKAGING_BOX_CODE ? packagingBoxName("ar") : storedNameAr;
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
  unitBox: "علبة",
  unitBottle: "زجاجة",
  unitSachet: "كيس",
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
 * The REORDER EMAIL stays Arabic whichever way the toggle is set. It is not a screen: four named
 * people were given an Arabic notification, and nothing has been said about changing what lands in
 * their inbox — so `buildAlarmEmailSummary` and the sweep keep reading `PP` directly.
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
  tileYield: "Actual yield",
  tileSurplus: "Surplus over the request",
  tileShortfall: "Shortfall against the request",
  unitRun: "run",
  unitRuns: "runs",
  unitLitre: "L",
  unitMl: "ml",
  unitKilogram: "kg",
  unitGram: "g",
  unitBox: "box",
  unitBottle: "bottle",
  unitSachet: "sachet",
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
  // Present for key parity and for the screen's own severity chips. The EMAIL itself stays Arabic.
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
 * The reorder email's opening sentence, and one line per material.
 *
 * Here rather than in the sweep for the same reason the planner sentence is: the catalogue is the
 * one place the Arabic lives, so the email cannot drift from the screen that shows the same verdict.
 * Every number arrives already formatted with Latin digits.
 */
export function buildAlarmEmailSummary(parts: { readonly productNameAr: string; readonly count: string }): string {
  return `في خطة ${parts.productNameAr}، وصلت ${parts.count} من المواد التي توردها ساتو إلى حد إعادة الطلب.`;
}

export function buildAlarmRowValue(parts: {
  readonly severityLabel: string;
  readonly coverRuns: string;
  readonly heldText: string;
  readonly displayUnit: string;
  readonly leadTimeDays: string | null;
}): string {
  const head = `${parts.severityLabel} — ${PP.alarmEmailCover} ${parts.coverRuns} ${PP.unitRun}`;
  const held = `${PP.alarmEmailHeld} ${parts.heldText} ${unitLabelAr(parts.displayUnit)}`;
  const lead =
    parts.leadTimeDays === null ? null : `${PP.alarmLeadTimeNote} ${parts.leadTimeDays} ${PP.unitDay}`;
  return [head, held, lead].filter((part) => part !== null).join(" · ");
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
};

/**
 * The small and large unit words for a product.
 *
 * 🔴 THE GEOMETRY COLUMNS ARE NAMED `…_ml` AND THE LABELS MUST NOT FOLLOW THEM. The arithmetic is
 * unit-free — a run is `runVolume / dose` whatever the unit — but every label was written when the
 * only product was a syrup, so a powder in 5 g sachets rendered "5 مل". This pair is what the labels
 * follow instead, and `measure_unit` on the product row is what picks it.
 */
export function measureUnitLabelsAr(unit: MeasureUnit): { small: string; large: string } {
  return unit === "g" ? { large: PP.unitKilogram, small: PP.unitGram } : { large: PP.unitLitre, small: PP.unitMl };
}

export function measureUnitLabelsEn(unit: MeasureUnit): { small: string; large: string } {
  return unit === "g"
    ? { large: PP_EN.unitKilogram, small: PP_EN.unitGram }
    : { large: PP_EN.unitLitre, small: PP_EN.unitMl };
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
  return (
    `العينة ${measure.sampleUnit} ${u.small} من نفس حجم التشغيلة — ` +
    `تقلل عدد الوحدات ${measure.goodUnit} ${u.small} وتستهلك عبوة كاملة`
  );
}

export function buildSampleUnitsHintEn(measure: ProductMeasure): string {
  const u = measureUnitLabelsEn(measure.measureUnit);
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
 * The expiry email's own two sentences, in Arabic — the email stays Arabic whatever the screen is on,
 * exactly like the reorder one, because its readers are the five people the owner named.
 */
export function buildExpiryEmailSummary(parts: { readonly productNameAr: string; readonly count: string }): string {
  return `في ${parts.productNameAr}، ${parts.count} من أرصدة المواد داخل مدة التنبيه أو منتهية بالفعل.`;
}

export function buildExpiryRowValue(parts: {
  readonly severityLabel: string;
  readonly expiryDate: string;
  readonly daysNote: string;
  readonly heldText: string;
  readonly displayUnit: string;
  readonly locationName: string;
}): string {
  return [
    `${parts.severityLabel} — ${PP.stockExpiry} ${parts.expiryDate}`,
    parts.daysNote,
    `${PP.alarmEmailHeld} ${parts.heldText} ${unitLabelAr(parts.displayUnit)}`,
    `${PP.stockLocation} ${parts.locationName}`,
  ].join(" · ");
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
}): string {
  const u = measureUnitLabelsAr(parts.measureUnit ?? "ml");
  // A powder's saleable unit is a sachet, a syrup's is a box — the word follows the measure, because
  // "20,000 علبة 5 جم" would be calling a sachet a box.
  const unitWord = (parts.measureUnit ?? "ml") === "g" ? PP.unitSachet : PP.unitBox;
  const head =
    `${parts.runs} ${PP.unitRuns} × ${parts.runVolumeLitres} ${u.large} = ` +
    `${parts.totalVolumeLitres} ${u.large}`;
  const yieldText =
    parts.sampleUnits === "0"
      ? `${parts.goodUnits} ${unitWord} ${parts.goodUnitMl} ${u.small}`
      : `${parts.goodUnits} ${unitWord} ${parts.goodUnitMl} ${u.small} و ${parts.sampleUnits} ` +
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
}): string {
  const u = measureUnitLabelsEn(parts.measureUnit ?? "ml");
  const unitWord = (parts.measureUnit ?? "ml") === "g" ? "sachets" : "boxes";
  const head =
    `${parts.runs} ${parts.runs === "1" ? PP_EN.unitRun : PP_EN.unitRuns} × ${parts.runVolumeLitres} ` +
    `${u.large} = ${parts.totalVolumeLitres} ${u.large}`;
  const yieldText =
    parts.sampleUnits === "0"
      ? `${parts.goodUnits} ${unitWord} of ${parts.goodUnitMl} ${u.small}`
      : `${parts.goodUnits} ${unitWord} of ${parts.goodUnitMl} ${u.small} and ${parts.sampleUnits} ` +
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
  | "runLabelRequired"
  | "priceMustBePositive"
  | "unknownCurrency"
  | "qtyMustBePositive"
  | "materialNotFound"
  | "materialRequired"
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
  | "expiryDateInvalid";

export const PRODUCTION_PLANNING_ERRORS: Record<ProductionPlanningErrorKey, string> = {
  unknownBasis: "أساس الحساب غير معروف.",
  runLabelRequired: "اسم التشغيلة مطلوب.",
  priceMustBePositive: "السعر يجب أن يكون أكبر من صفر.",
  unknownCurrency: "العملة غير معروفة.",
  qtyMustBePositive: "الكمية يجب أن تكون أكبر من صفر.",
  materialNotFound: "المادة غير موجودة.",
  materialRequired: "المادة مطلوبة.",
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
};

export const PRODUCTION_PLANNING_ERRORS_EN: Record<ProductionPlanningErrorKey, string> = {
  unknownBasis: "Unknown calculation basis.",
  runLabelRequired: "A run name is required.",
  priceMustBePositive: "A price must be greater than zero.",
  unknownCurrency: "Unknown currency.",
  qtyMustBePositive: "A quantity must be greater than zero.",
  materialNotFound: "No such material.",
  materialRequired: "A material is required.",
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
  sampleUnitsHint: buildSampleUnitsHintAr,
  severityLabels: ALARM_SEVERITY_LABELS,
  supplierLabels: SUPPLIER_LABELS,
  t: PP,
  tabs: PRODUCTION_PLANNING_TABS,
  unitLabel: unitLabelAr,
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
  sampleUnitsHint: buildSampleUnitsHintEn,
  severityLabels: ALARM_SEVERITY_LABELS_EN,
  supplierLabels: SUPPLIER_LABELS_EN,
  t: PP_EN,
  tabs: PRODUCTION_PLANNING_TABS_EN,
  unitLabel: unitLabelEn,
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
