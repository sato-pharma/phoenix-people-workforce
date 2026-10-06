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
 */

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

export type ProductionPlanningTabKey = "planner" | "stock" | "cost" | "run" | "settings";

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
  sampleUnitsHint: "العينة ٤٠ مل من نفس حجم التشغيلة — تقلل عدد العلب ١٠٠ مل وتستهلك عبوة كاملة",
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
  unitBox: "علبة",
  unitBottle: "زجاجة",
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
  stockNote: "ملاحظة",
  stockAdd: "إضافة تقرير مخزون",
  stockHistory: "سجل التقارير",
  stockNoneYet: "لا توجد تقارير مخزون لهذه المادة",

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
  sheetRunVolumeMl: "حجم التشغيلة (مل)",
  sheetGoodUnitMl: "حجم العلبة القابلة للبيع (مل)",
  sheetSampleUnitMl: "حجم العينة (مل)",
  sheetDoseMl: "الجرعة (مل)",
  sheetUnitsPerBox: "عدد الوحدات في العلبة",
  sheetGoodUnitsRequested: "العلب القابلة للبيع المطلوبة",
  sheetNeededVolumeMl: "حجم الاحتياج (مل)",
  sheetTotalVolumeLitres: "الحجم الكلي (لتر)",
  sheetTotalDoses: "إجمالي الجرعات",
  sheetTotalBoxes: "إجمالي العلب (العبوات الكاملة)",
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
} as const;

export type ProductionPlanningStringKey = keyof typeof PP;

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
  const held = `${PP.alarmEmailHeld} ${parts.heldText} ${parts.displayUnit}`;
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

export const BASIS_LABELS = {
  per_dose: "لكل جرعة ٥ مل",
  per_packaging_set: "لكل عبوة كاملة",
  per_good_unit: "لكل علبة قابلة للبيع",
  per_sample_unit: "لكل عينة",
} as const;

export const ALARM_SEVERITY_LABELS = {
  out_of_stock: PP.alarmSeverityOutOfStock,
  below_threshold: PP.alarmSeverityBelow,
  approaching: PP.alarmSeverityApproaching,
} as const;

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
}): string {
  const head =
    `${parts.runs} ${PP.unitRuns} × ${parts.runVolumeLitres} ${PP.unitLitre} = ` +
    `${parts.totalVolumeLitres} ${PP.unitLitre}`;
  const yieldText =
    parts.sampleUnits === "0"
      ? `${parts.goodUnits} ${PP.unitBox} ${parts.goodUnitMl} ${PP.unitMl}`
      : `${parts.goodUnits} ${PP.unitBox} ${parts.goodUnitMl} ${PP.unitMl} و ${parts.sampleUnits} ` +
        `${PP.unitSample} ${parts.sampleUnitMl} ${PP.unitMl}`;
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
