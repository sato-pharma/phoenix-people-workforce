/**
 * The custody receipt's Arabic text — both numbered forms.
 *
 * EXTRACTED FROM THE OWNER'S OWN WORD TEMPLATES, never retyped. Arabic pulled out of a PDF comes
 * back in VISUAL order with the letters already shaped, so it reverses when re-rendered; this was
 * read from `word/document.xml`, which stores logical order. Retyping it by hand would be worse
 * still — this is a signed instrument, and a single altered letter in an undertaking about wage
 * deduction is a change to what somebody agreed to.
 *
 * The clauses, both signature blocks and the whole return protocol live here ONCE and are shared by
 * both forms, because they are identical in the source. Only the form number, the item heading, the
 * item rows and the technical block differ — see `custody-template.ts`.
 */
import type {
  CustodyClauseGroup,
  CustodyField,
  CustodyReturnField,
  CustodySignatureColumn,
  CustodyTemplate,
} from "./custody-template";

const CUSTODY_TITLE_AR = "إقرار استلام عهدة";

const CUSTODY_SUBTITLE_AR = "نموذج معتمد — يُحرَّر من نسختين، ويُعد مكمّلًا لعقد العمل ولا يُغني عنه";

/** The header strip, in printed order: form number, declaration number, issue date, department. */
const CUSTODY_HEADER_LABELS_AR: readonly string[] = [
  "نموذج رقم",
  "رقم الإقرار",
  "تاريخ التحرير",
  "الإدارة",
];

const CUSTODY_DEPARTMENT_AR = "الإدارة المالية";

const CUSTODY_HOLDER_HEADING_AR = "أولًا: بيانات مستلم العهدة";

/**
 * The person receiving the device. Seven of these nine boxes Phoenix can answer; the last two —
 * the date and place of handover — are written at the desk, with the device present.
 */
const CUSTODY_HOLDER_FIELDS: readonly CustodyField[] = [
  { labelAr: "الاسم رباعيًا", token: "EMPLOYEE_NAME", wide: false, ltr: false },
  { labelAr: "الرقم القومي (14 رقمًا)", token: "NATIONAL_ID", wide: false, ltr: true },
  { labelAr: "الوظيفة", token: "JOB_TITLE", wide: false, ltr: false },
  { labelAr: "الإدارة / القطاع", token: "DEPARTMENT", wide: false, ltr: false },
  { labelAr: "الكود الوظيفي", token: "HR_ID", wide: false, ltr: true },
  { labelAr: "رقم الهاتف", token: "PHONE", wide: false, ltr: true },
  { labelAr: "محل الإقامة", token: "ADDRESS", wide: true, ltr: false },
  { labelAr: "تاريخ التسليم", token: null, wide: false, ltr: false },
  { labelAr: "مكان التسليم", token: null, wide: false, ltr: false },
];

const CUSTODY_ITEM_COLUMNS_AR: readonly string[] = [
  "م",
  "الصنف",
  "النوع / الموديل",
  "الرقم المسلسل",
  "العدد",
  "الحالة عند التسليم",
  "ملاحظات — خدش أو تلف إن وُجد",
  "القيمة التقديرية (ج.م)",
];

const CUSTODY_ITEM_NOTE_AR = "تُدوَّن حالة كل صنف وأي خدش أو تلف قائم وقت التسليم قرين الصنف ذاته بالجدول أعلاه. ويُشطب سطر أي صنف لم يُسلَّم فعليًا ولا تُحتسب قيمته ضمن الإجمالي.";

const CUSTODY_CLAUSES_HEADING_AR = "رابعًا: إقرار وتعهد مستلم العهدة";

/** Fifteen undertakings in four titled groups — identical on both forms. */
const CUSTODY_CLAUSE_GROUPS: readonly CustodyClauseGroup[] = [
  {
    headingAr: "أولًا — واقعة التسليم وطبيعة العهدة",
    clauses: [
      { number: "(1)", body: "أقر بأنني تسلمت من شركة ساتو فارما العهدة المبينة ببند «بيان العهدة المسلَّمة» عاليه تسليمًا فعليًا، وأنني عاينتها معاينة تامة نافية للجهالة، وقبلتها بحالتها المدونة بهذا الإقرار." },
      { number: "(2)", body: "العهدة مملوكة للشركة وحدها ملكية تامة، ولا يترتب على تسليمها إليّ أي حق عليها، ولا تنتقل ملكيتها إليّ بأي سبب من الأسباب، وتظل يدي عليها يدًا عارضة بوصفي حائزًا لحساب الشركة لا لحساب نفسي." },
      { number: "(3)", body: "سُلِّمت إليّ العهدة لاستعمالها في أعمال الشركة، ولا يجوز لي التصرف فيها بالبيع أو المبادلة أو الرهن أو التأجير، ولا نقل حيازتها إلى الغير أو تمكينه من استعمالها." },
    ],
  },
  {
    headingAr: "ثانيًا — الالتزام بالمحافظة والاستعمال",
    clauses: [
      { number: "(4)", body: "ألتزم بالمحافظة على العهدة محافظة الرجل المعتاد على ماله، وباستعمالها فيما أُعدت له وفقًا لتعليمات الشركة وسياساتها المعمول بها، ولا يجوز لي فتح الجهاز أو إصلاحه أو تعديله لدى الغير، ويكون الإصلاح عن طريق الشركة أو من تندبه لذلك." },
      { number: "(5)", body: "ألتزم بإخطار الشركة كتابةً خلال أربع وعشرين ساعة من علمي بأي فقد أو سرقة أو تلف أو عطل يلحق العهدة، وبتحرير محضر بقسم الشرطة المختص فور واقعة الفقد أو السرقة وتسليم صورة رسمية منه إلى الشركة." },
      { number: "(6)", body: "ألتزم بالمحافظة على سرية ما يوجد على العهدة من بيانات ومعلومات تخص الشركة أو عملاءها أو العاملين بها، وبعدم نسخها أو نقلها أو الاحتفاظ بها على أي وسيط خارجي أو حساب شخصي، وبعدم تثبيت أي برامج غير مرخصة عليها. وأقر بأن للشركة الحق في فحصها ومراجعة ما عليها من بيانات تتعلق بالعمل، وفي محو بياناتها أو استعادتها عند الحاجة، وأتحمل وحدي مسؤولية ما أضعه عليها من بيانات ذات طابع شخصي." },
    ],
  },
  {
    headingAr: "ثالثًا — رد العهدة والمسؤولية المالية",
    clauses: [
      { number: "(7)", body: "ألتزم برد العهدة إلى الشركة بحالة سليمة — فيما عدا ما يلحقها من استهلاك طبيعي نتيجة الاستعمال العادي — وذلك فور انتهاء الغرض من استعمالها، أو عند طلب الشركة، أو عند انتهاء علاقة العمل أو انقضائها لأي سبب، وفي جميع الأحوال قبل استلام مستحقاتي النهائية." },
      { number: "(8)", body: "لا يثبت الرد إلا بتوقيع الشركة على «محضر رد العهدة» الوارد بآخر هذا النموذج، ولا يُحتج بأي رد لم يُثبت به." },
      { number: "(9)", body: "القيمة المدونة قرين كل صنف قيمة تقديرية متفق عليها لأغراض تسوية العهدة، وقد اطلعت عليها وقبلتها عند التوقيع." },
      { number: "(10)", body: "في حالة عدم رد العهدة، أو ردها ناقصة أو تالفة بفعلي أو نتيجة إهمالي أو مخالفتي لأحكام هذا الإقرار، ألتزم بأداء قيمة ما لم يُرد أو تكلفة إصلاح ما تلف، بما لا يجاوز القيمة التقديرية المدونة قرين الصنف. وأوافق على استيفاء ذلك بالخصم من أجري في حدود النسبة التي يجيزها قانون العمل ولا يجوز تجاوزها، أو من مستحقاتي النهائية عند انتهاء الخدمة، ويظل ما يتبقى — إن وُجد — دينًا في ذمتي تستوفيه الشركة بالطرق القانونية." },
      { number: "(11)", body: "لا أُسأل عن هلاك العهدة أو تلفها إذا كان راجعًا إلى قوة قاهرة أو حادث فجائي أو فعل الغير، متى أثبتُّ ذلك وأخطرت الشركة على النحو المبين بالبند (5)." },
      { number: "(12)", body: "وللشركة — عند امتناعي عن الرد رغم تكليفي به بكتاب مسجل بعلم الوصول أو بأي وسيلة إثبات أخرى — أن تتخذ ما تراه من إجراءات قانونية للمطالبة بالعهدة أو بقيمتها." },
    ],
  },
  {
    headingAr: "رابعًا — أحكام عامة",
    clauses: [
      { number: "(13)", body: "هذا الإقرار مكمل لعقد العمل المبرم بيني وبين الشركة ولا يُغني عنه، كما لا يُغني توقيع عقد العمل عن توقيعي على هذا الإقرار." },
      { number: "(14)", body: "يُحرَّر عن كل تسليم نموذج مستقل، ولا يُعتد بأي تسليم لم يُحرَّر عنه نموذج موقَّع من الطرفين." },
      { number: "(15)", body: "حُرِّر هذا الإقرار من نسختين، تسلمت نسخة منهما وحُفظت الأخرى بملف خدمتي لدى الشركة، ويخضع في تفسيره وتنفيذه لأحكام قانون العمل رقم 14 لسنة 2025 ولائحته التنفيذية." },
    ],
  },
];

const CUSTODY_CLOSING_AR = "وهذا إقرار مني بذلك،،،";

const CUSTODY_SIGNATURES_HEADING_AR = "خامسًا: التوقيعات";

/** Three signatures: the holder, IT who hands it over, and Finance who books it. */
const CUSTODY_SIGNATURE_COLUMNS: readonly CustodySignatureColumn[] = [
  { headingAr: "مستلم العهدة — الطرف الثاني", attestationAr: "أقر بصحة بياناتي وبتسلمي العهدة" },
  { headingAr: "مُسلِّم العهدة — إدارة تقنية المعلومات", attestationAr: "أقر بتسليم الأصناف المبينة" },
  { headingAr: "اعتماد الإدارة المالية", attestationAr: "قُيِّدت العهدة بدفاتر الشركة" },
];

const CUSTODY_RETURN_HEADING_AR = "محضر رد العهدة";

const CUSTODY_RETURN_INTRO_AR = "يُستوفى هذا المحضر عند رد العهدة إلى الشركة، ويُعد وحده الدليل على واقعة الرد وعلى إخلاء طرف مستلم العهدة عمّا ورد به. ولا يجوز صرف المستحقات النهائية قبل استيفائه والتوقيع عليه.";

/**
 * The return protocol — printed on every receipt and completed when the device comes back.
 *
 * It is part of the SAME sheet on purpose, and the document says why: البند (8) makes this protocol
 * the only proof a device was returned, and its own preamble forbids paying final dues before it is
 * signed. A return form that lived somewhere else would be the one piece of paper nobody can find
 * on the day somebody leaves.
 */
const CUSTODY_RETURN_FIELDS: readonly CustodyReturnField[] = [
  { labelAr: "تاريخ الرد", fixedAr: null, wide: false },
  { labelAr: "سبب الرد", fixedAr: null, wide: false },
  { labelAr: "اسم مستلم العهدة", fixedAr: null, wide: true },
  { labelAr: "بيان إخلاء الطرف", fixedAr: "رُدَّت الأصناف المبينة بجدول «بيان العهدة المسلَّمة» أعلاه كاملة وبحالة مقبولة، مع مراعاة الاستهلاك الطبيعي:    نعم ☐        لا ☐", wide: true },
  { labelAr: "الناقص أو التالف", fixedAr: null, wide: true },
  { labelAr: "إجمالي ما يُحتسب (ج.م)", fixedAr: null, wide: false },
  { labelAr: "طريقة التسوية", fixedAr: null, wide: false },
];

const CUSTODY_RETURN_SIGNATURE_COLUMNS: readonly CustodySignatureColumn[] = [
  { headingAr: "مستلم العهدة — الراد", attestationAr: "أقر بصحة ما ورد بهذا المحضر" },
  { headingAr: "مستلم الرد — إدارة تقنية المعلومات", attestationAr: "أقر باستلام الأصناف المبينة" },
  { headingAr: "اعتماد الإدارة المالية", attestationAr: "قُيِّد الرد وسُوِّيت العهدة" },
];

/** نموذج رقم 1 — a laptop and its accessories, with the Windows "About" block. */
export const CUSTODY_LAPTOP_V1: CustodyTemplate = {
  id: "custody-laptop-v1",
  version: 1,
  variant: "laptop",
  formNumberAr: "1",
  titleAr: CUSTODY_TITLE_AR,
  subtitleAr: CUSTODY_SUBTITLE_AR,
  headerLabelsAr: CUSTODY_HEADER_LABELS_AR,
  departmentAr: CUSTODY_DEPARTMENT_AR,
  holderHeadingAr: CUSTODY_HOLDER_HEADING_AR,
  holderFields: CUSTODY_HOLDER_FIELDS,
  itemsHeadingAr: "ثانيًا: بيان العهدة المسلَّمة — حاسب محمول وملحقاته",
  itemColumnsAr: CUSTODY_ITEM_COLUMNS_AR,
  itemRows: [
    { number: "1", itemAr: "حاسب محمول (Laptop)" },
    { number: "2", itemAr: "شاحن" },
    { number: "3", itemAr: "حقيبة الحاسب" },
    { number: "4", itemAr: "علبة الجهاز" },
  ],
  itemTotalLabelAr: "إجمالي القيمة التقديرية للعهدة المسلَّمة (بالجنيه المصري) — لا تُحتسب قيمة صنف لم يُسلَّم فعليًا",
  itemNoteAr: CUSTODY_ITEM_NOTE_AR,
  technicalHeadingAr: "ثالثًا: البيانات الفنية للجهاز",
  technicalFields: [
    { labelAr: "Manufacturer", token: null, wide: false, ltr: true },
    { labelAr: "Serial Number", token: null, wide: false, ltr: true },
    { labelAr: "Device name", token: null, wide: false, ltr: true },
    { labelAr: "Processor", token: null, wide: false, ltr: true },
    { labelAr: "Installed RAM", token: null, wide: false, ltr: true },
    { labelAr: "System type", token: null, wide: false, ltr: true },
    { labelAr: "Device ID", token: null, wide: true, ltr: true },
    { labelAr: "Product ID", token: null, wide: true, ltr: true },
  ],
  clausesHeadingAr: CUSTODY_CLAUSES_HEADING_AR,
  clauseGroups: CUSTODY_CLAUSE_GROUPS,
  closingAr: CUSTODY_CLOSING_AR,
  signaturesHeadingAr: CUSTODY_SIGNATURES_HEADING_AR,
  signatureColumns: CUSTODY_SIGNATURE_COLUMNS,
  returnHeadingAr: CUSTODY_RETURN_HEADING_AR,
  returnIntroAr: CUSTODY_RETURN_INTRO_AR,
  returnFields: CUSTODY_RETURN_FIELDS,
  returnSignatureColumns: CUSTODY_RETURN_SIGNATURE_COLUMNS,
};

/** نموذج رقم 2 — a phone or tablet, with IMEI, SIM and line number instead. */
export const CUSTODY_MOBILE_V1: CustodyTemplate = {
  id: "custody-mobile-v1",
  version: 1,
  variant: "mobileTablet",
  formNumberAr: "2",
  titleAr: CUSTODY_TITLE_AR,
  subtitleAr: CUSTODY_SUBTITLE_AR,
  headerLabelsAr: CUSTODY_HEADER_LABELS_AR,
  departmentAr: CUSTODY_DEPARTMENT_AR,
  holderHeadingAr: CUSTODY_HOLDER_HEADING_AR,
  holderFields: CUSTODY_HOLDER_FIELDS,
  itemsHeadingAr: "ثانيًا: بيان العهدة المسلَّمة — هاتف محمول أو جهاز لوحي وملحقاته",
  itemColumnsAr: CUSTODY_ITEM_COLUMNS_AR,
  itemRows: [
    { number: "1", itemAr: "هاتف / جهاز لوحي" },
    { number: "2", itemAr: "جراب" },
    { number: "3", itemAr: "شاحن" },
    { number: "4", itemAr: "وصلة شاحن" },
    { number: "5", itemAr: "شاشة حماية" },
    { number: "6", itemAr: "علبة الجهاز" },
    { number: "7", itemAr: "شريحة اتصال" },
  ],
  itemTotalLabelAr: "إجمالي القيمة التقديرية للعهدة المسلَّمة (بالجنيه المصري) — لا تُحتسب قيمة صنف لم يُسلَّم فعليًا",
  itemNoteAr: CUSTODY_ITEM_NOTE_AR,
  technicalHeadingAr: "ثالثًا: البيانات الفنية للجهاز",
  technicalFields: [
    { labelAr: "نوع الجهاز", token: null, wide: false, ltr: true },
    { labelAr: "IMEI", token: null, wide: false, ltr: true },
    { labelAr: "رقم الشريحة", token: null, wide: false, ltr: true },
    { labelAr: "رقم الخط", token: null, wide: false, ltr: true },
  ],
  clausesHeadingAr: CUSTODY_CLAUSES_HEADING_AR,
  clauseGroups: CUSTODY_CLAUSE_GROUPS,
  closingAr: CUSTODY_CLOSING_AR,
  signaturesHeadingAr: CUSTODY_SIGNATURES_HEADING_AR,
  signatureColumns: CUSTODY_SIGNATURE_COLUMNS,
  returnHeadingAr: CUSTODY_RETURN_HEADING_AR,
  returnIntroAr: CUSTODY_RETURN_INTRO_AR,
  returnFields: CUSTODY_RETURN_FIELDS,
  returnSignatureColumns: CUSTODY_RETURN_SIGNATURE_COLUMNS,
};

/** Both forms, in printed form-number order. */
export const CUSTODY_TEMPLATES: readonly CustodyTemplate[] = [
  CUSTODY_LAPTOP_V1,
  CUSTODY_MOBILE_V1,
];

/** Look a form up by its registry id. Null when the id is not a custody form. */
export function custodyTemplateById(id: string | null | undefined): CustodyTemplate | null {
  if (!id) return null;
  return CUSTODY_TEMPLATES.find((template) => template.id === id) ?? null;
}
