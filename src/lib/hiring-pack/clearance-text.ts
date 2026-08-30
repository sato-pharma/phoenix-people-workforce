import type {
  ClearanceField,
  ClearanceSignatureColumn,
  ClearanceTemplate,
} from "@/lib/hiring-pack/clearance-template";

/**
 * The two clearance papers, transcribed from the owner's own Word originals.
 *
 * READ FROM `word/document.xml`, NEVER FROM THE PDF. Text extracted from a PDF comes back in
 * VISUAL order, which for Arabic means already reversed and with the bidirectional runs resolved —
 * retyping from it produces text that looks plausible and is mangled. The Word body is logical
 * order, which is what has to be stored.
 *
 * The numbers in the originals are wrapped in U+202A/U+202C embedding controls. Those are stripped
 * here and replaced with the HTML equivalent at render time (`dir="ltr"` on the value), because a
 * stray invisible control character inside a string is invisible in a diff and survives a copy.
 */

const SIGNATURE_HR: ClearanceSignatureColumn = { headingAr: "مدير الموارد البشرية" };
const SIGNATURE_EMPLOYEE: ClearanceSignatureColumn = { headingAr: "الموظف" };

function field(
  labelAr: string,
  token: ClearanceField["token"],
  options: { fixedAr?: string; wide?: boolean; ltr?: boolean } = {},
): ClearanceField {
  return {
    labelAr,
    token,
    fixedAr: options.fixedAr ?? null,
    wide: options.wide ?? false,
    ltr: options.ltr ?? false,
  };
}

/**
 * إخلاء طرف موظف — the company certifies the employee is clear, and he takes it with him.
 *
 * THE DEPARTMENTS ARE THE OWNER'S OWN LIST, printed as he wrote it — plus one desk he asked for on
 * 2026-08-30. His paper carried six; Phoenix's Clearance module tracks SEVEN against a departure,
 * and the one the module had and the paper did not was `fleet` — company car, keys, fuel card, toll
 * tag, traffic fines. That gap is why this is a correction and not tidying: a leaver still holding
 * a company car could be signed clear by every desk the paper listed, and walk out with a
 * certificate stating nothing was outstanding against him. It sits at 3, where the module orders it
 * (`hr_clearance_stations.sort_order` 30, straight after IT), so the paper and the screen are read
 * in the same order by the same people.
 *
 * THE CERTIFICATION NO LONGER COUNTS THEM. It read «توقيعات الإدارات الست» — the six departments'
 * signatures — which the seventh row falsified the moment it landed. That shape is worth naming:
 * the table grew, the sentence did not, and a paper that contradicts itself still looks finished,
 * because nobody reads a closing clause back against the rows above it. It now says «جميع
 * الإدارات» — all of them — which cannot go stale however many desks exist. Pinned by
 * `testTheCertificationNeverCountsTheDepartments`, which refuses any Arabic count-word in that
 * sentence rather than asserting the number seven: asserting seven only works until the eighth desk.
 */
export const CLEARANCE_EMPLOYEE_V1: ClearanceTemplate = {
  id: "clearance-employee-v1",
  version: 1,
  variant: "employeeKeeps",
  titleAr: "إخلاء طرف موظف",
  subtitleAr: "تشهد به الشركة بعد توقيع الإدارات — ويُسلَّم للموظف",
  keeperAr: "نسخة الموظف — تُسلَّم له بعد اعتمادها، وتحتفظ الشركة بصورة منها",
  blocks: [
    {
      kind: "fields",
      headingAr: "أولًا: بيانات الموظف",
      fields: [
        field("الاسم رباعيًا", "EMPLOYEE_NAME"),
        field("الرقم القومي", "NATIONAL_ID", { ltr: true }),
        field("الوظيفة", "JOB_TITLE"),
        field("الإدارة / القطاع", "DEPARTMENT"),
        field("تاريخ التعيين", "HIRE_DATE", { ltr: true }),
        field("آخر يوم عمل", "LAST_WORKING_DATE", { ltr: true }),
        field("سبب انتهاء الخدمة", null, {
          fixedAr:
            "استقالة ☐    انتهاء مدة العقد ☐    إنهاء من الشركة ☐    أخرى ☐ ....................................",
          wide: true,
        }),
      ],
    },
    {
      kind: "stations",
      headingAr: "ثانيًا: توقيع الإدارات",
      columnsAr: ["م", "الإدارة", "يُراجَع", "لا مستحقات", "المستحق (ج.م)", "التوقيع والتاريخ"],
      rows: [
        { number: "1", departmentAr: "المدير المباشر", scopeAr: "تسليم الأعمال والملفات والعملاء" },
        {
          number: "2",
          departmentAr: "تقنية المعلومات",
          scopeAr: "الحاسب والموبايل والخط وحسابات النظام",
        },
        {
          number: "3",
          departmentAr: "الحركة والنقل",
          scopeAr: "السيارة والمفاتيح وكارت الوقود وبطاقة الطرق والمخالفات",
        },
        {
          number: "4",
          departmentAr: "المخازن والعينات",
          scopeAr: "العينات والمطبوعات والهدايا الدعائية",
        },
        { number: "5", departmentAr: "الإدارة المالية", scopeAr: "السلف والقروض والجزاءات" },
        { number: "6", departmentAr: "الشؤون الإدارية", scopeAr: "الكارنيه والمفاتيح وبطاقة الدخول" },
        {
          number: "7",
          departmentAr: "الموارد البشرية",
          scopeAr: "مسوغات التعيين واستمارة 6 التأمينية",
        },
      ],
    },
    {
      kind: "prose",
      headingAr: "ثالثًا: شهادة إخلاء الطرف",
      paragraphs: [
        "تشهد شركة ساتو فارما بأن المذكور بياناته أعلاه قد أُخلي طرفه من الشركة، وأنه لم يعد للشركة قِبَله عهدة أو مستحق فيما عدا ما دُوِّن بخانة «المستحق» بالجدول أعلاه.",
        "ولا يُعتد بهذه الشهادة ما لم تُستوفَ توقيعات جميع الإدارات أعلاه ويُختم النموذج بخاتم الشركة. ولا تُصرف المستحقات النهائية قبل استيفائه.",
      ],
    },
  ],
  closingAr: null,
  signatureColumns: [SIGNATURE_EMPLOYEE, SIGNATURE_HR, { headingAr: "الاعتماد وخاتم الشركة" }],
};

/**
 * إخلاء طرف شركة — the employee releases the company, and the company files it.
 *
 * THE AMOUNT IS DELIBERATELY BLANK. Clause (2) is a full and final release: signing it says the
 * printed figure settles everything owed for the whole period of employment. Phoenix does not
 * compute a final settlement — the clearance module's own job description names "may not approve
 * final settlement" as a boundary — so any figure it printed here would be a number with no
 * authority, on a paper whose entire legal effect is that the employee agrees to the number.
 */
export const CLEARANCE_COMPANY_V1: ClearanceTemplate = {
  id: "clearance-company-v1",
  version: 1,
  variant: "companyKeeps",
  titleAr: "إخلاء طرف شركة",
  subtitleAr: "يُقر به الموظف بعد استلام مستحقاته — وتحتفظ به الشركة",
  keeperAr: "نسخة الشركة — تُحفظ بملف الموظف، ويُسلَّم الموظف صورة منها",
  blocks: [
    {
      kind: "fields",
      headingAr: "أولًا: بيانات الموظف",
      fields: [
        field("الاسم رباعيًا", "EMPLOYEE_NAME"),
        field("الرقم القومي", "NATIONAL_ID", { ltr: true }),
        field("الوظيفة", "JOB_TITLE"),
        field("آخر يوم عمل", "LAST_WORKING_DATE", { ltr: true }),
        field("محل الإقامة", "ADDRESS", { wide: true }),
      ],
    },
    {
      kind: "fields",
      headingAr: "ثانيًا: المبلغ المستلم",
      fields: [
        field("المبلغ بالأرقام", null, { fixedAr: "...................... جنيهًا مصريًا" }),
        field("تاريخ الاستلام", null),
        field("المبلغ كتابةً", null, { wide: true }),
        field("طريقة السداد", null, {
          fixedAr: "نقدًا ☐    شيك ☐    تحويل بنكي ☐    رقم الشيك / التحويل: ....................",
          wide: true,
        }),
        field("المستندات المستلمة", null, {
          fixedAr: "مسوغات التعيين ☐    شهادة الخبرة ☐    استمارة 6 التأمينية ☐",
          wide: true,
        }),
      ],
    },
    {
      kind: "clauses",
      headingAr: "ثالثًا: الإقرار",
      clauses: [
        {
          number: "(1)",
          body: "أقر بأن عملي بشركة ساتو فارما قد انتهى في التاريخ المبين قرين «آخر يوم عمل» أعلاه، وأنني وقعت هذا الإقرار بعد ذلك التاريخ.",
        },
        {
          number: "(2)",
          body: "وأقر بأنني استلمت من الشركة المبلغ المبين أعلاه وفاءً كاملًا عن مستحقاتي حتى آخر يوم عمل — من أجر ورصيد إجازات وأي مبالغ أخرى — وأنه لم يبقَ لي قِبَلها مستحق عن تلك المدة.",
        },
        {
          number: "(3)",
          body: "وأقر بأنني استلمت مسوغات تعييني وأوراقي الأصلية، وأنني رددت كل ما كان بعهدتي من أجهزة ومستندات، وألتزم بالمحافظة على أسرار الشركة وبيانات عملائها بعد انتهاء العمل.",
        },
        {
          number: "(4)",
          body: "وقعت هذا الإقرار بمحض إرادتي بعد قراءته، وتسلمت نسخة منه، ويخضع لأحكام قانون العمل رقم 14 لسنة 2025 ولائحته التنفيذية.",
        },
      ],
    },
  ],
  closingAr: "وهذا إقرار مني بذلك،،،",
  signatureColumns: [
    SIGNATURE_EMPLOYEE,
    { headingAr: "عن الشركة — الموارد البشرية" },
    { headingAr: "الشاهد" },
  ],
};

export const CLEARANCE_TEMPLATES: readonly ClearanceTemplate[] = [
  CLEARANCE_EMPLOYEE_V1,
  CLEARANCE_COMPANY_V1,
];

/** One template by id, or null. Null means "an id nobody recognises", never "deleted". */
export function clearanceTemplateById(id: string | null | undefined): ClearanceTemplate | null {
  if (!id) return null;
  return CLEARANCE_TEMPLATES.find((template) => template.id === id) ?? null;
}
