/**
 * The two renewal papers, in every version of them.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * WHERE THIS TEXT CAME FROM, AND WHAT WAS CHANGED. The owner supplied both papers as one PDF on
 * 2026-08-19 («ملحق تجديد سنوي - ساتو فارما.pdf») and asked, on 2026-09-05, whether it was
 * compatible with Labour Law 14/2025 and with our own contract before it went into the house
 * template. The legal substance answered yes on every point that matters and is reproduced here as
 * he drafted it. THE CROSS-REFERENCES DID NOT, and that is the whole reason this file exists rather
 * than a scan of his PDF.
 *
 * His draft cites articles (4), (9), (13), (15), (16) and (18)(4) OF THE CONTRACT. Every one of
 * those is correct against `contract-text-v2.ts` — the nineteen-article version that was current on
 * the day he drafted it — and every one is wrong against `contract-text-v4.ts`, the thirteen-article
 * redraft that is current now and that people are signing today. The failure is silent and it is
 * nasty: مادة (15) exists in v4, it is «الاستقالة والإنهاء» rather than the custody-and-clearance
 * article the notice means to invoke, and مادة (18) does not exist at all. A notice pointing an
 * employee at the wrong article of his own contract is the kind of defect that is discovered by the
 * other side, in front of a labour office.
 *
 * So each reference was re-resolved BY SUBJECT against v4 and restated:
 *
 *   subject                                     v2 (his draft)      v4 (here)
 *   ─────────────────────────────────────────   ─────────────────   ──────────────────
 *   preamble, regulations and annexes bind      مادة (1)            مادة (1)
 *   no amendment except in writing, signed      مادة (18) بند (4)   مادة (13) بند (5)
 *   the term, and no implied renewal            مادة (4)            مادة (3)
 *   custody, assets and clearance               مادة (13)           مادة (10)
 *   handover on termination                     مادة (15)           مادة (12)
 *   registered letter to the stated address     مادة (9)            مادة (8)
 *   notices to the address or email on file     مادة (16)           مادة (13) بند (1)
 *
 * THE CROSS-REFERENCES ARE PINNED BY A TEST, not by this comment. `tests/hr-forms-renewal.test.ts`
 * asserts that every «مادة (N) من العقد» either paper cites is an article the CURRENT contract
 * actually has, and that the subject of that article matches. When the contract is redrafted again
 * — and it has been four times in three weeks — that test goes red instead of these papers quietly
 * pointing at the wrong clauses for a year.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * THE THREE THINGS ADDED TO HIS DRAFT, all of them statutory anchors rather than new obligations:
 *
 *   · مادة (2) now names ARTICLE 88, which is the reason this paper exists at all. Article 88 makes
 *     a fixed-term contract indefinite from inception if the parties carry on performing it after
 *     the term expires WITHOUT a written agreement. Signing the annex before expiry is what keeps
 *     the contract fixed-term, so the annex says so on its own face.
 *   · مادة (5) now names ARTICLE 90 behind "no new probation" — a worker may not be put under
 *     probation more than once with the same employer, so the clause is the law rather than a
 *     concession the company could be argued out of.
 *   · مادة (4) now names ARTICLE 12's periodic increment — not less than 3% of the insurance wage —
 *     because a renewal is exactly the moment somebody would forget it.
 *
 * There is NO cumulative cap on renewals to guard against. Several published summaries of this law
 * still say a fixed-term contract becomes indefinite after four or five years and cite articles
 * 111–113 or 155; those numbers belong to the DRAFT bill, and the promulgated law's own numbering
 * runs 87 (renewal for similar periods), 88 (conversion), 89 (written, Arabic, four copies), 90
 * (probation). The five-year conversion was dropped during social dialogue. Annual renewal is
 * therefore safe indefinitely PROVIDED each one is written and signed before the previous term ends
 * — which is the single operational thing these papers exist to guarantee.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 */

import type { RenewalTemplate } from "@/lib/hiring-pack/renewal-template";

const SUBTITLE_AR = "محرر طبقًا لأحكام قانون العمل المصري رقم 14 لسنة 2025 والقرارات المنفذة له";

/**
 * The company recital, shared by both papers.
 *
 * WORD FOR WORD THE CONTRACT'S OWN FACTS, in the contract's own order. The owner's draft named the
 * company in a shorter form — an address missing its building number, and the signatory as «المدير
 * المسئول» with the last two words of his name dropped — so the annex and the contract it amends
 * described the same company two different ways and named the same man two different men. On a pair
 * of instruments read together that is not a cosmetic difference; it is the first thing an opposing
 * lawyer points at.
 */
const FIRST_PARTY_LINES_AR: readonly string[] = [
  "{{COMPANY_NAME}} — {{COMPANY_LEGAL_FORM}} · السجل التجاري رقم {{COMMERCIAL_REGISTER}} ({{COMMERCIAL_REGISTER_OFFICE}}).",
  "الرقم الموحد {{UNIFIED_REGISTER}} · البطاقة الضريبية رقم {{TAX_CARD}}.",
  "المركز العام: {{COMPANY_HEAD_OFFICE_FULL}}.",
  "ويمثلها في التوقيع السيد {{CONTRACT_SIGNATORY}}، {{CONTRACT_SIGNATORY_TITLE}}، ويشار إليه فيما بعد بـ«الطرف الأول».",
];

/** The signatory annotation under the company's signature column — the contract's v4 apparatus. */
const SIGNATORY_NOTE_LINES_AR: readonly string[] = [
  "يوقّع عن الطرف الأول: {{CONTRACT_SIGNATORY}}",
  "الصفة: {{CONTRACT_SIGNATORY_TITLE}}",
];

/**
 * The annual renewal annex — ملحق تجديد سنوي.
 *
 * FOUR COPIES, because مادة (89) of the law requires the contract itself to be drawn in four and
 * this instrument becomes part of it: one for the employee, one for the service file, one deposited
 * with the labour office and one with the social insurance authority. The owner's draft says the
 * same in its own مادة (8), so this is his count, the law's count and the contract's count agreeing.
 */
export const RENEWAL_ANNEX_V1: RenewalTemplate = {
  id: "contract-renewal-v1",
  variant: "renewal",
  version: 1,
  titleAr: "ملحق تجديد سنوي لعقد عمل محدد المدة",
  subtitleAr: SUBTITLE_AR,
  purposeAr:
    "يُحرَّر من أربع نسخ — نسخة للطرف الثاني، ونسخة بملف الخدمة، ونسخة لمكتب العمل المختص، ونسخة لهيئة التأمينات الاجتماعية.",
  bindingLineAr:
    "ملحق رقم ({{ANNEX_NUMBER}}) — مكمل لعقد العمل المؤرخ {{CONTRACT_DATE}}، ولا يُقرأ ولا يُفسَّر إلا معه.",

  firstPartyHeadingAr: "الطرف الأول — الشركة",
  firstPartyLinesAr: FIRST_PARTY_LINES_AR,

  secondPartyHeadingAr: "الطرف الثاني — العامل",
  secondPartyFields: [
    { labelAr: "الاسم رباعيًا", token: "EMPLOYEE_NAME", wide: true },
    { labelAr: "كود الموظف", token: "HR_ID", ltr: true },
    { labelAr: "الرقم القومي", token: "NATIONAL_ID", ltr: true },
    { labelAr: "الوظيفة الحالية", token: "JOB_TITLE" },
    { labelAr: "الإدارة / القطاع", token: "DEPARTMENT" },
  ],

  preambleHeadingAr: "تمهيد",
  preambleAr:
    "إنه في يوم {{ANNEX_DAY_NAME}} الموافق {{ANNEX_DATE}}، وبمدينة {{COMPANY_CITY}}، وحيث سبق أن تعاقد الطرفان بموجب عقد عمل محدد المدة مؤرخ {{CONTRACT_DATE}} تبدأ مدته في {{CONTRACT_START_DATE}} وتنتهي في {{CONTRACT_END_DATE}} («العقد الأصلي»)؛ وحيث رغب الطرفان في تجديد العقد الأصلي لمدة جديدة قبل انقضاء مدته الحالية، ولمّا كانت طبيعة العمل ما زالت تقتضي تحديد المدة للسبب الموضوعي الآتي: {{OBJECTIVE_REASON}} — وذلك إعمالًا للمادة (87) من قانون العمل رقم 14 لسنة 2025 التي تجيز للطرفين باتفاقهما تجديد العقد لمدد مماثلة؛ فقد اتفق الطرفان، وكل منهما بكامل أهليته المعتبرة قانونًا، على ما يلي:",

  articles: [
    {
      number: "مادة (1)",
      titleAr: "التمهيد",
      body: "يُعد التمهيد السابق جزءًا لا يتجزأ من هذا الملحق ومتممًا لأحكامه.",
    },
    {
      number: "مادة (2)",
      titleAr: "مدة التجديد",
      body: "يُجدَّد العقد الأصلي لمدة {{RENEWAL_DURATION}} تبدأ من {{RENEWAL_START_DATE}} وتنتهي في {{RENEWAL_END_DATE}}. ويقر الطرفان بأن هذا الملحق قد وُقّع قبل تاريخ انتهاء المدة السابقة، وأنه لم تنقطع علاقة العمل بينهما؛ فيظل العقد محدد المدة بطبيعته، ولا يسري في شأنه حكم المادة (88) من قانون العمل رقم 14 لسنة 2025 الذي يعتبر العقد غير محدد المدة منذ إبرامه إذا استمر تنفيذه بعد انتهاء مدته دون اتفاق مكتوب بين الطرفين.",
    },
    {
      number: "مادة (3)",
      titleAr: "سريان شروط العقد الأصلي",
      body: "تظل كافة شروط وأحكام العقد الأصلي وملاحقه ولائحة العمل الداخلية ولائحة الجزاءات والسياسات المعتمدة سارية ونافذة دون تغيير، فيما لم يرد بشأنه نص خاص في هذا الملحق، ويُعد هذا الملحق جزءًا لا يتجزأ من العقد الأصلي، وذلك إعمالًا للمادة (1) والمادة (13) بند (5) منه.",
    },
    {
      number: "مادة (4)",
      titleAr: "بيانات الوظيفة والأجر",
      body: "تكون بيانات الوظيفة والأجر خلال المدة الجديدة على النحو المبين بالجدول التالي، وما لم يرد بيان مخالف فيه تستمر البيانات الثابتة بالعقد الأصلي دون تغيير. ولا يترتب على هذا التجديد أي انتقاص من الأجر أو المزايا أو الحقوق المقررة للطرف الثاني، ويظل حقه قائمًا في العلاوة الدورية السنوية بما لا يقل عن (3%) من الأجر التأميني المقررة بالمادة (12) من قانون العمل رقم 14 لسنة 2025.",
    },
    {
      number: "مادة (5)",
      titleAr: "الأقدمية واستمرار مدة الخدمة",
      body: "تُحتسب أقدمية الطرف الثاني ومدة خدمته المتصلة من تاريخ تعيينه الأصلي الثابت بالعقد الأصلي في {{ORIGINAL_HIRE_DATE}}، ولا يترتب على هذا التجديد قطع مدة الخدمة ولا بدء فترة اختبار جديدة، إعمالًا للمادة (90) من قانون العمل رقم 14 لسنة 2025 التي لا تجيز وضع العامل تحت الاختبار أكثر من مرة لدى صاحب عمل واحد. وتُحسب مستحقات نهاية الخدمة والإجازات وسائر الحقوق المرتبطة بمدة الخدمة على أساس هذه المدة المتصلة.",
    },
    {
      number: "مادة (6)",
      titleAr: "عدم التنازل عن الحقوق",
      body: "لا يُعد توقيع الطرف الثاني على هذا الملحق تنازلًا عن أي حق نشأ له خلال المدة السابقة، وتظل حقوقه المكتسبة وأرصدة إجازاته ومستحقاته قائمة.",
    },
    {
      number: "مادة (7)",
      titleAr: "انتهاء المدة الجديدة",
      body: "ينتهي العقد بانقضاء المدة الجديدة المبينة بالمادة (2) من هذا الملحق دون حاجة إلى تنبيه أو إخطار، إعمالًا للمادة (3) من العقد الأصلي، ولا يُعد استمرار الطرف الثاني في أداء أي مهام بعد انقضائها تجديدًا جديدًا ما لم يصدر ملحق تجديد كتابي موقّع من الطرف الأول، وذلك دون إخلال بالأحكام الآمرة المقررة بقانون العمل رقم 14 لسنة 2025 في شأن استمرار علاقة العمل.",
    },
    {
      number: "مادة (8)",
      titleAr: "تحرير الملحق والإقرارات",
      body: "حُرر هذا الملحق باللغة العربية من أربع نسخ وقّع عليها الطرفان، تسلّم الطرف الثاني نسخة منها، وتُودع نسخة لدى مكتب العمل المختص ونسخة لدى هيئة التأمينات الاجتماعية. ويقر الطرف الثاني بأنه قرأ هذا الملحق كاملًا بلغته العربية وفهم أحكامه، ووقّعه بكامل إرادته الحرة، وتسلّم نسخة منه وقت التوقيع.",
    },
  ],

  bodyParagraphsAr: [],

  termsHeadingAr: "بيانات الوظيفة والأجر خلال المدة الجديدة",
  termsFields: [
    { labelAr: "الوظيفة", token: "JOB_TITLE" },
    { labelAr: "الإدارة / القطاع", token: "DEPARTMENT" },
    { labelAr: "النطاق الجغرافي (Territory) المسند", token: "TERRITORY", wide: true },
    { labelAr: "الأجر الشهري الإجمالي (جنيه)", token: "SALARY_FIGURES", ltr: true },
    { labelAr: "الأجر التأميني الخاضع للاشتراك (جنيه)", token: "INSURANCE_WAGE", ltr: true },
    { labelAr: "الأجر الشهري بالحروف", token: "SALARY_WORDS", wide: true },
  ],

  signaturesHeadingAr: "التوقيعات",
  signatureColumns: [
    { headingAr: "الطرف الأول — الشركة", fieldsAr: ["الاسم:", "التوقيع والختم:", "التاريخ:"] },
    { headingAr: "الطرف الثاني — العامل", fieldsAr: ["الاسم:", "التوقيع:", "التاريخ:"] },
  ],
  signatoryNoteLinesAr: SIGNATORY_NOTE_LINES_AR,
  receiptAcknowledgmentAr: "إقرار الطرف الثاني باستلام نسخة من هذا الملحق — التوقيع:",

  witnessNoteAr: null,
  witnessFields: [],

  footerAr: "ملحق تجديد سنوي — مكمل لعقد العمل محدد المدة · قانون العمل رقم 14 لسنة 2025",
};

/**
 * The non-renewal notice — إخطار بعدم تجديد.
 *
 * TWO COPIES, NOT FOUR, and the difference from the annex is the point. The annex is an agreement
 * that amends a contract, so it goes where the contract went — including the labour office and the
 * insurance authority. This is a unilateral notice: the company hands one over and keeps one with
 * the employee's acknowledgment on it. Nothing is deposited anywhere, because nothing has been
 * agreed; the contract is simply being allowed to run out on the date it always said it would.
 *
 * IT IS NOT A DISMISSAL AND IT SAYS SO IN ITS OWN THIRD PARAGRAPH. That sentence is the most
 * load-bearing one on the page: under this contract مادة (3) the term expires «دون حاجة إلى تنبيه»,
 * so this paper is a courtesy that documents intent, not a notice period being served. Losing that
 * distinction would turn an expiry into a termination, which is a different thing in law and a much
 * more expensive one.
 */
export const NON_RENEWAL_NOTICE_V1: RenewalTemplate = {
  id: "contract-non-renewal-v1",
  variant: "nonRenewal",
  version: 1,
  titleAr: "إخطار بعدم تجديد عقد عمل محدد المدة",
  subtitleAr: SUBTITLE_AR,
  purposeAr:
    "يُحرَّر من نسختين — نسخة تُسلَّم للعامل، ونسخة تُحفظ بملف الخدمة موقّعة منه بالاستلام. ويُسلَّم قبل تاريخ انتهاء المدة.",
  bindingLineAr: null,

  firstPartyHeadingAr: "الصادر عن — الشركة",
  firstPartyLinesAr: FIRST_PARTY_LINES_AR,

  secondPartyHeadingAr: "الموجَّه إلى — العامل",
  secondPartyFields: [
    { labelAr: "الاسم رباعيًا", token: "EMPLOYEE_NAME", wide: true },
    { labelAr: "كود الموظف", token: "HR_ID", ltr: true },
    { labelAr: "الرقم القومي", token: "NATIONAL_ID", ltr: true },
    { labelAr: "الوظيفة", token: "JOB_TITLE" },
    { labelAr: "تاريخ الإخطار", token: "NOTICE_DATE", ltr: true },
  ],

  preambleHeadingAr: null,
  preambleAr: null,
  articles: [],

  bodyParagraphsAr: [
    "تحية طيبة وبعد،",
    "بالإشارة إلى عقد العمل محدد المدة المبرم بينكم وبين {{COMPANY_NAME}} والمؤرخ {{CONTRACT_DATE}}، والذي تبدأ مدته في {{CONTRACT_START_DATE}} وتنتهي في {{CONTRACT_END_DATE}}، نخطركم بأن الشركة لا ترغب في تجديد العقد لمدة جديدة، وأن العقد ينتهي بانقضاء مدته المذكورة إعمالًا للمادة (3) منه، ويكون يوم {{LAST_WORKING_DATE}} هو آخر يوم عمل لكم.",
    "ولا يُعد هذا الإخطار فصلًا من الخدمة ولا إنهاءً للعقد قبل أوانه، وإنما هو إعمال لانتهاء المدة المتفق عليها بين الطرفين، وذلك دون إخلال بالأحكام الآمرة المقررة بقانون العمل رقم 14 لسنة 2025 وبكافة حقوقكم المقررة قانونًا عن مدة خدمتكم.",
    "ويُرجى استكمال تسليم العهدة والأصول والملفات وبيانات العملاء وإتمام إجراءات إخلاء الطرف وفقًا للمادتين (10) و(12) من العقد قبل التاريخ المذكور، وتُسوّى مستحقاتكم المالية النهائية بعد إتمام التسليم، وتُصرف كافة الحقوق المقررة قانونًا.",
  ],

  termsHeadingAr: null,
  termsFields: [],

  signaturesHeadingAr: "التوقيعات",
  signatureColumns: [
    { headingAr: "عن الطرف الأول — الشركة", fieldsAr: ["الاسم والصفة:", "التوقيع والختم:", "التاريخ:"] },
    { headingAr: "أقر باستلام هذا الإخطار — العامل", fieldsAr: ["الاسم:", "التوقيع:", "التاريخ:"] },
  ],
  signatoryNoteLinesAr: SIGNATORY_NOTE_LINES_AR,
  receiptAcknowledgmentAr: "أقر باستلام نسخة من هذا الإخطار في تاريخه — توقيع العامل:",

  witnessNoteAr:
    "وفي حالة امتناع العامل عن التوقيع بالاستلام بعد إخطاره، يُثبت ذلك في محضر يوقعه شاهدان، ويُرسل الإخطار على عنوانه أو بريده الإلكتروني الثابتين بصدر العقد بخطاب موصى عليه بعلم الوصول أو بأي وسيلة تُثبت العلم، وذلك إعمالًا للمادة (8) والمادة (13) بند (1) من العقد.",
  witnessFields: [
    { labelAr: "شاهد أول — الاسم", token: null },
    { labelAr: "التوقيع", token: null },
    { labelAr: "شاهد ثانٍ — الاسم", token: null },
    { labelAr: "التوقيع", token: null },
  ],

  footerAr: "إخطار بعدم تجديد عقد عمل محدد المدة · قانون العمل رقم 14 لسنة 2025",
};

/**
 * Every version of both papers, oldest first.
 *
 * NOTHING IS EVER REMOVED FROM THIS LIST, for the reason `contract-text.ts` sets out at length: an
 * archived version is still imported, still typechecked and still rendered by the same renderer as
 * the current one, which is what stops it rotting. The day somebody reprints an annex signed against
 * version 1, that path has been exercised on every build since.
 */
export const RENEWAL_TEMPLATES: readonly RenewalTemplate[] = [
  RENEWAL_ANNEX_V1,
  NON_RENEWAL_NOTICE_V1,
];

/** One version by id, or null when the id is not one of ours. */
export function renewalTemplateById(id: string | null | undefined): RenewalTemplate | null {
  if (!id) return null;
  return RENEWAL_TEMPLATES.find((template) => template.id === id) ?? null;
}
