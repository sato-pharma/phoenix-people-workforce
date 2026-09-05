/**
 * SATO'S SIX OWN HR PAPERS, as the owner supplied them on 2026-09-05 and as they now print.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * WHAT CAME IN, AND WHAT CHANGED. Six Word files, four `.docx` and two `.doc`. His legal substance
 * is reproduced throughout. Four things were corrected, and two of them are the reason this comment
 * is long — both would print a paper that reads perfectly and is wrong.
 *
 * 1. 🔴 THE ABSENCE THRESHOLD. Both warnings acted at TEN consecutive days. Article 166 of Labour
 *    Law 14/2025 deems a worker resigned after MORE THAN twenty non-consecutive days in a year, or
 *    MORE THAN ten consecutive — so on day ten the effect has not arisen yet and a notice issued
 *    then is premature. Our own contract's مادة (8) says the same, in the same words: «أكثر من عشرة
 *    أيام متصلة». The papers now act from the ELEVENTH day, and say eleven where they used to say
 *    ten. The first warning still issues after five days, which is what the contract provides.
 *
 * 2. 🔴 THE SECOND WARNING WAS TITLED «إخطار بقبول إستقالة» — notice of ACCEPTING a resignation.
 *    Under Article 166 there is no resignation to accept: the worker never wrote one, and the
 *    employer DECLARES him deemed resigned. A real resignation is Article 167, and it is a different
 *    instrument with different requirements — written, signed by the worker, and approved by the
 *    labour office, with service ending only on the decision accepting it (which is exactly what
 *    مادة (12) of our contract says). A paper claiming to accept a resignation nobody submitted
 *    invites precisely the argument that no valid resignation exists. It is now
 *    «إخطار باعتبار العامل مستقيلاً حكمًا» and cites 166 for what it is.
 *
 * 3. The company was a blank on both warnings — «بشركة ........................ الكائن مقرها في
 *    ....................» — on papers this company issues about its own employees. It is filled
 *    from settings now, like every other house document.
 *
 * 4. The appointment-documents checklist numbered its rows 1..10, 12, 13 — no eleven. Renumbered
 *    1..12. Nothing was added or removed; the gap was a typo, and a serial that skips a number on a
 *    form somebody signs invites the question of what used to be on line 11.
 *
 * Smaller: the first warning addressed «السيدة/» and the second «السيد /», so one of the two was
 * always wrong; both now read «السيد / السيدة». A doubled preposition («ننذركم ببتغيبكم») is fixed.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * WHY THE SERVICE-FILE SHEET IS NOT TREATED AS A GOVERNMENT FORM. `صحيفة الحالة الاجتماعية` looks
 * like one and is not. Article 92 requires the EMPLOYER to keep a file for each worker with certain
 * contents; it does not issue artwork for it, unlike Form 1 and Form 6, which the insurance office
 * hands out and will refuse if they are restyled. So the house identity applies here, and this sheet
 * must NOT be added to the exempt list in `render-form1.ts` / `render-form6.ts`. If a labour
 * inspector ever objects to the layout, that is the line to revisit — the content is unchanged.
 */

import type { HrPaperTemplate } from "@/lib/hiring-pack/hr-paper-template";

const LAW_SUBTITLE = "طبقًا لأحكام قانون العمل المصري رقم 14 لسنة 2025 والقرارات المنفذة له";

/**
 * The company recital, identical on every paper that carries one.
 *
 * The contract's own facts in the contract's own order — the same constant the renewal annex uses,
 * and for the same reason: two papers in one file describing the same company two different ways is
 * the first thing an opposing lawyer points at.
 */
const FIRST_PARTY_LINES_AR: readonly string[] = [
  "{{COMPANY_NAME}} — {{COMPANY_LEGAL_FORM}} · السجل التجاري رقم {{COMMERCIAL_REGISTER}} ({{COMMERCIAL_REGISTER_OFFICE}}).",
  "الرقم الموحد {{UNIFIED_REGISTER}} · البطاقة الضريبية رقم {{TAX_CARD}}.",
  "المركز العام: {{COMPANY_HEAD_OFFICE_FULL}}.",
];

const SIGNATORY_NOTE_LINES_AR: readonly string[] = [
  "يوقّع عن الطرف الأول: {{CONTRACT_SIGNATORY}}",
  "الصفة: {{CONTRACT_SIGNATORY_TITLE}}",
];

/**
 * 1 — إقرار وتعهد بعدم إفشاء المعلومات والأسرار التجارية.
 *
 * Signed on joining and kept for the life of the file. It SUPPLEMENTS مادة (7) of the contract —
 * «الواجبات والسرية والملكية الفكرية وعدم المنافسة» — and now says so: the owner's draft called
 * itself «جزءاً مكملاً ومتممًا لعقد العمل» without naming the article it supplements, which left the
 * relationship between the two documents to be argued rather than read.
 */
export const HR_PAPER_NDA_V1: HrPaperTemplate = {
  id: "nda-v1",
  kind: "undertaking",
  version: 1,
  titleAr: "إقرار وتعهد بعدم إفشاء المعلومات والأسرار التجارية والحفاظ على حقوق الملكية الفكرية",
  subtitleAr: LAW_SUBTITLE,
  purposeAr: "يُحرَّر من نسختين — نسخة بملف الخدمة، ونسخة يتسلمها الطرف الثاني وقت التوقيع.",
  bindingLineAr:
    "مكمل لعقد العمل المؤرخ {{CONTRACT_DATE}} ومتمم للمادة (7) منه، ولا يُقرأ ولا يُفسَّر إلا معه.",

  firstPartyHeadingAr: "الطرف الأول — الشركة",
  firstPartyLinesAr: FIRST_PARTY_LINES_AR,

  secondPartyHeadingAr: "الطرف الثاني — المُقِر",
  secondPartyFields: [
    { labelAr: "الاسم رباعيًا", token: "EMPLOYEE_NAME", wide: true },
    { labelAr: "الرقم القومي", token: "NATIONAL_ID", ltr: true },
    { labelAr: "كود الموظف", token: "HR_ID", ltr: true },
    { labelAr: "الوظيفة", token: "JOB_TITLE" },
    { labelAr: "الإدارة / القطاع", token: "DEPARTMENT" },
    { labelAr: "تاريخ استلام العمل", token: "HIRE_DATE", ltr: true },
  ],
  sections: [],

  bodyParagraphsAr: [
    "من المعلوم لديّ ومن المتفق عليه أن {{COMPANY_NAME}} شركة تعمل في مجال الأدوية، وأنني خلال فترة عملي لديها أصبحت مُدرِكًا للأساليب والممارسات والإجراءات التي تدير بها الشركة أعمالها، وهي معلومات مملوكة للشركة وحدها ملكية فكرية، تخضع لحقوق حماية الملكية الفكرية وتُعد أسرارًا تجارية.",
    "وأقر وأتعهد والتزم، في أي وقت سواء خلال عملي أو بعد انتهائه، بعدم إفشاء أو تقديم أو إتاحة أي من المعلومات المملوكة للشركة أو المستخدمة لديها — بشكل مباشر أو غير مباشر — إلى أي شخص أو شركة أو مؤسسة أو أي جهة أخرى، وبالاحتفاظ بتلك المعلومات بسرية تامة حفاظًا على الملكية الفكرية للشركة.",
    "ويشمل ذلك على وجه الخصوص بيانات العملاء والأطباء والصيدليات والموزعين، والأسعار والخصومات، والخطط والمستهدفات، وبيانات نظام إدارة علاقات العملاء (CRM)، وأي بيانات أجور أطّلع عليها بحكم عملي — وذلك إعمالًا للمادة (7) من عقد العمل، دون أن يُعد هذا التعداد حصريًا.",
    "وأقر بأن مخالفتي لأي من أحكام هذا الإقرار تؤدي إلى إلحاق ضرر متواصل وغير قابل للإصلاح بالشركة، ويكون لها — بالإضافة إلى كافة حقوقها الأخرى، ومنها حق المطالبة بالتعويض — الحق في استصدار أمر قضائي بوقفي عن القيام بالمخالفة أو الاستمرار فيها.",
    "وأوافق على أن يكون هذا الإقرار جزءًا مكملًا ومتممًا لعقد العمل المحرر بيني وبين الشركة، وألتزم بتحمل كل مسؤولية قانونية وخسارة وضرر وتكاليف ومصاريف تنشأ عن الإخلال بأي من بنوده.",
  ],
  operativeHeadingAr: null,
  operativeParagraphsAr: [],
  checklist: null,
  openTable: null,
  declarationAr:
    "وهذا إقرار وتعهد مني بذلك، حرر بمدينة {{COMPANY_CITY}} في يوم {{ISSUE_DAY_NAME}} الموافق {{ISSUE_DATE}}.",

  signaturesHeadingAr: "التوقيعات",
  signatureColumns: [
    { headingAr: "الطرف الأول — الشركة", fieldsAr: ["الاسم:", "التوقيع والختم:", "التاريخ:"] },
    { headingAr: "الطرف الثاني — المُقِر", fieldsAr: ["الاسم:", "التوقيع:", "التاريخ:"] },
  ],
  signatoryNoteLinesAr: SIGNATORY_NOTE_LINES_AR,
  receiptAcknowledgmentAr: "إقرار الطرف الثاني باستلام نسخة من هذا الإقرار — التوقيع:",
  serviceNoteAr: null,
  serviceFields: [],
  footerAr: "إقرار وتعهد بعدم إفشاء الأسرار التجارية · مكمل للمادة (7) من عقد العمل",
};

/**
 * 2 — إيصال استلام مسوغات التعيين.
 *
 * The HIRING half of a matched pair. The company takes the originals in and records what it has;
 * `HR_PAPER_DOCUMENTS_RETURN_V1` is what the employee signs when he gets them back. The two were
 * supplied as separate files with almost the same name, and reading them as alternatives — the way
 * the two labour exit forms are — would file the wrong one at the wrong end of a career.
 *
 * EVERY VERDICT BOX PRINTS EMPTY. Phoenix holds no register of which certificates were handed over,
 * and a ticked box on a form somebody signs asserts that a document was seen. It is completed at the
 * desk with the papers on the table.
 */
export const HR_PAPER_DOCUMENTS_RECEIPT_V1: HrPaperTemplate = {
  id: "appointment-docs-receipt-v1",
  kind: "checklist",
  version: 1,
  titleAr: "إيصال استلام مسوغات التعيين",
  subtitleAr: "يُستوفى عند التعيين وتُحفظ نسخته بملف الخدمة",
  purposeAr: "يُحرَّر من نسختين — نسخة بملف الخدمة، ونسخة يتسلمها العامل.",
  bindingLineAr: null,

  firstPartyHeadingAr: null,
  firstPartyLinesAr: [],

  secondPartyHeadingAr: "بيانات العامل",
  secondPartyFields: [
    { labelAr: "الاسم رباعيًا", token: "EMPLOYEE_NAME", wide: true },
    { labelAr: "كود الموظف", token: "HR_ID", ltr: true },
    { labelAr: "الرقم القومي", token: "NATIONAL_ID", ltr: true },
    { labelAr: "الوظيفة", token: "JOB_TITLE" },
    { labelAr: "الإدارة / القطاع", token: "DEPARTMENT" },
    { labelAr: "تاريخ استلام العمل", token: "HIRE_DATE", ltr: true },
  ],
  sections: [],

  bodyParagraphsAr: [],
  operativeHeadingAr: null,
  operativeParagraphsAr: [],

  checklist: {
    headingAr: "مسوغات التعيين",
    itemHeadingAr: "المستند",
    columnsAr: ["متوفر", "غير متوفر", "لا ينطبق"],
    rows: [
      // RENUMBERED 1..12. The source ran 1..10, 12, 13 with no eleven — see the file header. The
      // twelve items themselves are his, unchanged and in his order.
      { number: "1", labelAr: "أصل المؤهل الدراسي" },
      { number: "2", labelAr: "أصل شهادة الميلاد" },
      { number: "3", labelAr: "أصل الموقف من التجنيد" },
      { number: "4", labelAr: "صورة بطاقة الرقم القومي" },
      { number: "5", labelAr: "طابع تأميني" },
      { number: "6", labelAr: "صحيفة الحالة الجنائية" },
      { number: "7", labelAr: "صور شخصية حديثة 4×6 بخلفية بيضاء" },
      { number: "8", labelAr: "كعب العمل" },
      { number: "9", labelAr: "نموذج 111 كشف طبي" },
      { number: "10", labelAr: "صورة رخصة القيادة (إن وجدت)" },
      { number: "11", labelAr: "صورة كارنيه النقابة (إن وجد)" },
      { number: "12", labelAr: "الشهادة الصحية" },
    ],
    footNoteAr:
      "يُرجى استكمال مسوغات التعيين غير المتوفرة في موعد أقصاه {{COMPLETION_DEADLINE}}. ولا يكون التعيين نهائيًا إلا باستيفاء مسوغاته واجتياز الكشف الطبي الابتدائي، إعمالًا للمادة (3) من عقد العمل.",
  },
  openTable: null,
  declarationAr: null,

  signaturesHeadingAr: "التوقيعات",
  signatureColumns: [
    { headingAr: "توقيع العامل", fieldsAr: ["الاسم:", "التوقيع:", "التاريخ:"] },
    { headingAr: "توقيع الموارد البشرية", fieldsAr: ["الاسم:", "التوقيع:", "التاريخ:"] },
  ],
  signatoryNoteLinesAr: [],
  receiptAcknowledgmentAr: null,
  serviceNoteAr: null,
  serviceFields: [],
  footerAr: "إيصال استلام مسوغات التعيين · يُحفظ بملف الخدمة",
};

/**
 * 3 — إقرار استلام مسوغات التعيين (عند انتهاء الخدمة).
 *
 * The EXIT half. The employee acknowledges his original certificates were returned and waives any
 * later claim to them. Short by design: it is a receipt, not an agreement.
 *
 * IT NAMES THE LAST WORKING DAY, which the owner's draft did not. A waiver with no date attached to
 * it says nothing about WHEN the papers came back, and the whole value of the document is that it
 * fixes that moment.
 */
export const HR_PAPER_DOCUMENTS_RETURN_V1: HrPaperTemplate = {
  id: "appointment-docs-return-v1",
  kind: "undertaking",
  version: 1,
  titleAr: "إقرار استلام مسوغات التعيين",
  subtitleAr: "يُستوفى عند انتهاء الخدمة وتُحفظ نسخته بملف الخدمة",
  purposeAr: "يُحرَّر من نسختين — نسخة بملف الخدمة موقّعة من العامل، ونسخة يتسلمها العامل.",
  bindingLineAr: null,

  firstPartyHeadingAr: "الصادر لـ — الشركة",
  firstPartyLinesAr: FIRST_PARTY_LINES_AR,

  secondPartyHeadingAr: "بيانات العامل",
  secondPartyFields: [
    { labelAr: "الاسم رباعيًا", token: "EMPLOYEE_NAME", wide: true },
    { labelAr: "كود الموظف", token: "HR_ID", ltr: true },
    { labelAr: "الرقم القومي", token: "NATIONAL_ID", ltr: true },
    { labelAr: "آخر يوم عمل", token: "LAST_WORKING_DATE", ltr: true },
  ],
  sections: [],

  bodyParagraphsAr: [
    "أقر أنا الموقع أدناه بأنني استلمت من {{COMPANY_NAME}} جميع أوراقي ومسوغات تعييني الأصلية المودعة بملف خدمتي، وأنه لم يتبقَّ لديها أي مستند يخصني.",
    "وليس لي الحق في الرجوع على الشركة بأي مطالبة بشأن هذه الأوراق، ولا يُعد هذا الإقرار تنازلًا عن أي حق مالي أو تأميني مقرر لي قانونًا عن مدة خدمتي.",
  ],
  operativeHeadingAr: null,
  operativeParagraphsAr: [],
  checklist: null,
  openTable: null,
  declarationAr:
    "وهذا إقرار مني بذلك، حرر في يوم {{ISSUE_DAY_NAME}} الموافق {{ISSUE_DATE}}.",

  signaturesHeadingAr: "التوقيعات",
  signatureColumns: [
    { headingAr: "العامل — المُقِر", fieldsAr: ["الاسم:", "التوقيع:", "التاريخ:"] },
    { headingAr: "عن الموارد البشرية", fieldsAr: ["الاسم:", "التوقيع:", "التاريخ:"] },
  ],
  signatoryNoteLinesAr: [],
  receiptAcknowledgmentAr: null,
  serviceNoteAr: null,
  serviceFields: [],
  footerAr: "إقرار استلام مسوغات التعيين · عند انتهاء الخدمة",
};

/**
 * 4 — إنذار أول بالتغيب عن العمل.
 *
 * Issued after FIVE consecutive days, which is what مادة (8) of the contract provides: the warning
 * goes out «بعد اليوم الخامس» on a continuous absence. It warns; it does not end anything.
 */
export const HR_PAPER_ABSENCE_WARNING_V1: HrPaperTemplate = {
  id: "absence-warning-first-v1",
  kind: "letter",
  version: 1,
  titleAr: "إنذار أول بالتغيب عن العمل",
  subtitleAr: LAW_SUBTITLE,
  purposeAr:
    "يُحرَّر من نسختين — نسخة تُسلَّم للعامل بتوقيعه بالاستلام، ونسخة تُحفظ بملف الخدمة.",
  bindingLineAr: null,

  firstPartyHeadingAr: "الصادر عن — الشركة",
  firstPartyLinesAr: FIRST_PARTY_LINES_AR,

  secondPartyHeadingAr: "الموجَّه إلى — السيد / السيدة",
  secondPartyFields: [
    { labelAr: "الاسم رباعيًا", token: "EMPLOYEE_NAME", wide: true },
    { labelAr: "كود الموظف", token: "HR_ID", ltr: true },
    { labelAr: "الوظيفة", token: "JOB_TITLE" },
    { labelAr: "محل الإقامة", token: "ADDRESS", wide: true },
    { labelAr: "تاريخ الإنذار", token: "ISSUE_DATE", ltr: true },
  ],
  sections: [],

  bodyParagraphsAr: [
    "تحية طيبة وبعد،",
    "نظرًا لتغيبكم عن الحضور إلى مقر عملكم بـ{{COMPANY_NAME}}، الكائن في {{COMPANY_HEAD_OFFICE_FULL}}، عن الفترة من {{ABSENCE_FROM}} وحتى {{ABSENCE_TO}}، لمدة خمسة أيام عمل متصلة، وذلك دون إبداء مسوغ قانوني أو عذر مقبول.",
  ],
  operativeHeadingAr: "لــــــــــذلـــــــــك",
  operativeParagraphsAr: [
    "فإننا نُنذركم بضرورة العودة إلى العمل فورًا وتقديم ما يثبت عذركم عن مدة التغيب، وننبهكم إلى أن استمرار الانقطاع دون عذر مقبول لمدة تجاوز عشرة أيام متصلة يترتب عليه اعتباركم مستقيلًا حكمًا، وذلك إعمالًا للمادة (166) من قانون العمل رقم 14 لسنة 2025 وللمادة (8) من عقد العمل المبرم بيننا.",
    "ولكم أن تُثبتوا عدم انقطاعكم بكافة طرق الإثبات، ويُحفظ لكم كل حق مقرر قانونًا عن مدة خدمتكم.",
  ],
  checklist: null,
  openTable: null,
  declarationAr: null,

  signaturesHeadingAr: "التوقيعات",
  signatureColumns: [
    { headingAr: "إدارة الموارد البشرية", fieldsAr: ["الاسم والصفة:", "التوقيع والختم:", "التاريخ:"] },
    { headingAr: "أقر باستلام هذا الإنذار — العامل", fieldsAr: ["الاسم:", "التوقيع:", "التاريخ:"] },
  ],
  signatoryNoteLinesAr: [],
  receiptAcknowledgmentAr: null,
  serviceNoteAr:
    "وفي حالة امتناع العامل عن التوقيع بالاستلام بعد إخطاره، يُثبت ذلك في محضر يوقعه شاهدان، ويُرسل الإنذار على عنوانه أو بريده الإلكتروني الثابتين بصدر العقد بخطاب موصى عليه بعلم الوصول أو بأي وسيلة تُثبت العلم، وذلك إعمالًا للمادة (8) والمادة (13) بند (1) من العقد.",
  serviceFields: [
    { labelAr: "شاهد أول — الاسم", token: null },
    { labelAr: "التوقيع", token: null },
    { labelAr: "شاهد ثانٍ — الاسم", token: null },
    { labelAr: "التوقيع", token: null },
  ],
  footerAr: "إنذار أول بالتغيب عن العمل · المادة (166) من قانون العمل رقم 14 لسنة 2025",
};

/**
 * 5 — إخطار باعتبار العامل مستقيلاً حكمًا.
 *
 * 🔴 RENAMED FROM «إخطار بقبول إستقالة», and the rename is the substance. See the file header:
 * Article 166 produces a DEEMED resignation the employer declares; Article 167 is a real resignation
 * the worker writes and the labour office approves. Claiming to accept a resignation nobody
 * submitted is the argument that gets the whole thing set aside.
 *
 * 🔴 AND IT ACTS FROM THE ELEVENTH DAY, not the tenth. Article 166 says «أكثر من عشرة أيام متصلة»
 * and so does مادة (8) of our contract; at exactly ten the effect has not arisen.
 */
export const HR_PAPER_DEEMED_RESIGNATION_V1: HrPaperTemplate = {
  id: "absence-deemed-resignation-v1",
  kind: "letter",
  version: 1,
  titleAr: "إخطار باعتبار العامل مستقيلًا حكمًا",
  subtitleAr: LAW_SUBTITLE,
  purposeAr:
    "يُحرَّر من نسختين — نسخة تُسلَّم للعامل بتوقيعه بالاستلام، ونسخة تُحفظ بملف الخدمة.",
  bindingLineAr: null,

  firstPartyHeadingAr: "الصادر عن — الشركة",
  firstPartyLinesAr: FIRST_PARTY_LINES_AR,

  secondPartyHeadingAr: "الموجَّه إلى — السيد / السيدة",
  secondPartyFields: [
    { labelAr: "الاسم رباعيًا", token: "EMPLOYEE_NAME", wide: true },
    { labelAr: "كود الموظف", token: "HR_ID", ltr: true },
    { labelAr: "الوظيفة", token: "JOB_TITLE" },
    { labelAr: "محل الإقامة", token: "ADDRESS", wide: true },
    { labelAr: "تاريخ الإخطار", token: "ISSUE_DATE", ltr: true },
  ],
  sections: [],

  bodyParagraphsAr: [
    "تحية طيبة وبعد،",
    "نظرًا لتغيبكم عن الحضور إلى مقر عملكم بـ{{COMPANY_NAME}}، الكائن في {{COMPANY_HEAD_OFFICE_FULL}}، عن الفترة من {{ABSENCE_FROM}} وحتى {{ABSENCE_TO}}، لمدة تجاوزت عشرة أيام متصلة دون مبرر مشروع أو عذر مقبول.",
    "وقد سبق إنذاركم بالإنذار الأول عن الفترة من {{FIRST_WARNING_FROM}} إلى {{FIRST_WARNING_TO}}، ولم تعودوا إلى العمل ولم تقدموا ثمة عذر.",
  ],
  operativeHeadingAr: "لــــــــــذلـــــــــك",
  operativeParagraphsAr: [
    "نخطركم باعتباركم مستقيلًا حكمًا من العمل اعتبارًا من {{LAST_WORKING_DATE}}، لانقطاعكم أكثر من عشرة أيام متصلة دون مبرر مشروع، وذلك إعمالًا للمادة (166) من قانون العمل رقم 14 لسنة 2025 وللمادة (8) من عقد العمل المبرم بيننا.",
    "ولا يُعد هذا الإخطار فصلًا تأديبيًا، ولكم أن تُثبتوا عدم انقطاعكم بكافة طرق الإثبات. وتُصرف كافة حقوقكم المقررة قانونًا عن مدة خدمتكم بعد إتمام إجراءات تسليم العهدة وإخلاء الطرف وفقًا للمادتين (10) و(12) من العقد.",
  ],
  checklist: null,
  openTable: null,
  declarationAr: null,

  signaturesHeadingAr: "التوقيعات",
  signatureColumns: [
    { headingAr: "إدارة الموارد البشرية", fieldsAr: ["الاسم والصفة:", "التوقيع والختم:", "التاريخ:"] },
    { headingAr: "أقر باستلام هذا الإخطار — العامل", fieldsAr: ["الاسم:", "التوقيع:", "التاريخ:"] },
  ],
  signatoryNoteLinesAr: [],
  receiptAcknowledgmentAr: null,
  serviceNoteAr:
    "وفي حالة امتناع العامل عن التوقيع بالاستلام بعد إخطاره، يُثبت ذلك في محضر يوقعه شاهدان، ويُرسل الإخطار على عنوانه أو بريده الإلكتروني الثابتين بصدر العقد بخطاب موصى عليه بعلم الوصول أو بأي وسيلة تُثبت العلم، وذلك إعمالًا للمادة (8) والمادة (13) بند (1) من العقد.",
  serviceFields: [
    { labelAr: "شاهد أول — الاسم", token: null },
    { labelAr: "التوقيع", token: null },
    { labelAr: "شاهد ثانٍ — الاسم", token: null },
    { labelAr: "التوقيع", token: null },
  ],
  footerAr: "إخطار باعتبار العامل مستقيلًا حكمًا · المادة (166) من قانون العمل رقم 14 لسنة 2025",
};

/**
 * 6 — صحيفة الحالة الاجتماعية.
 *
 * The service-file sheet Article 92 requires the employer to keep. Every field the owner's version
 * carries is here, in his order; what Phoenix already knows is filled and the rest rules.
 *
 * THE DEPENDANTS TABLE PRINTS EMPTY, six rows. Phoenix holds no dependants register — the closest
 * thing is the insurance file, which is a different set of people for a different purpose — so the
 * table is completed by the employee, who is also the one signing that it is true.
 */
export const HR_PAPER_SOCIAL_STATUS_V1: HrPaperTemplate = {
  id: "social-status-sheet-v1",
  kind: "dataSheet",
  version: 1,
  titleAr: "صحيفة الحالة الاجتماعية",
  subtitleAr: "تُحفظ بملف خدمة العامل — المادة (92) من قانون العمل رقم 14 لسنة 2025",
  purposeAr: "نسخة واحدة تُحفظ بملف الخدمة.",
  bindingLineAr: null,

  firstPartyHeadingAr: null,
  firstPartyLinesAr: [],

  secondPartyHeadingAr: "بيانات المنشأة",
  secondPartyFields: [
    { labelAr: "اسم المنشأة", token: "COMPANY_NAME", wide: true },
    { labelAr: "رقم تأمين المنشأة", token: "COMPANY_INSURANCE_NUMBER", ltr: true },
    { labelAr: "مكتب التأمينات التابع له", token: "COMPANY_INSURANCE_OFFICE" },
  ],

  sections: [
    {
      headingAr: "بيانات العامل",
      fields: [
        { labelAr: "اسم العامل رباعيًا", token: "EMPLOYEE_NAME", wide: true },
        { labelAr: "القسم / الإدارة", token: "DEPARTMENT" },
        { labelAr: "الوظيفة", token: "JOB_TITLE" },
        { labelAr: "تاريخ الالتحاق بالعمل", token: "HIRE_DATE", ltr: true },
        { labelAr: "رقم صفحاته بالسجل", token: null, ltr: true },
        { labelAr: "رقم تأمين العامل الحالي", token: "INSURANCE_NUMBER", ltr: true },
        { labelAr: "الرقم التأميني السابق", token: null, ltr: true },
        { labelAr: "النوع (ذكر / أنثى)", token: "GENDER" },
        { labelAr: "الجنسية", token: "NATIONALITY" },
        { labelAr: "الديانة", token: "RELIGION" },
        { labelAr: "الرقم القومي", token: "NATIONAL_ID", ltr: true },
        { labelAr: "المؤهل", token: "QUALIFICATION" },
        { labelAr: "محل الميلاد", token: "BIRTH_PLACE" },
        { labelAr: "تاريخ الميلاد", token: "BIRTH_DATE", ltr: true },
        { labelAr: "الموقف من التجنيد", token: "MILITARY_STATUS" },
        { labelAr: "الحالة الاجتماعية (أعزب / متزوج / مطلق / أرمل)", token: "MARITAL_STATUS" },
        { labelAr: "محل الإقامة", token: "ADDRESS", wide: true },
        { labelAr: "رقم بطاقة الإقامة وتاريخها إذا كان العامل أجنبيًا", token: null, wide: true },
      ],
    },
  ],

  bodyParagraphsAr: [],
  operativeHeadingAr: null,
  operativeParagraphsAr: [],
  checklist: null,
  openTable: {
    headingAr: "بيان من يعولهم العامل",
    columnsAr: ["مسلسل", "الاسم", "تاريخ الميلاد", "صلة القرابة", "ملاحظات"],
    rows: 6,
  },
  declarationAr:
    "البيانات المذكورة عاليه صحيحة وتحت مسؤوليتي، وأتعهد بإخطار صاحب العمل بكل تغيير يطرأ عليها خلال ثلاثة أيام من تاريخ التغيير.",

  signaturesHeadingAr: null,
  signatureColumns: [
    { headingAr: "توقيع العامل", fieldsAr: ["الاسم:", "التوقيع:", "التاريخ:"] },
    { headingAr: "عن الموارد البشرية", fieldsAr: ["الاسم:", "التوقيع:", "التاريخ:"] },
  ],
  signatoryNoteLinesAr: [],
  receiptAcknowledgmentAr: null,
  serviceNoteAr: null,
  serviceFields: [],
  footerAr: "صحيفة الحالة الاجتماعية · تُحفظ بملف خدمة العامل",
};

/**
 * All six, in the order a career runs through them.
 *
 * NOTHING IS EVER REMOVED FROM THIS LIST once a version has been printed, for the reason the
 * contract archive sets out: these are papers people sign, and a superseded version has to stay
 * printable as the document that was actually signed.
 */
export const HR_PAPERS: readonly HrPaperTemplate[] = [
  HR_PAPER_NDA_V1,
  HR_PAPER_DOCUMENTS_RECEIPT_V1,
  HR_PAPER_SOCIAL_STATUS_V1,
  HR_PAPER_ABSENCE_WARNING_V1,
  HR_PAPER_DEEMED_RESIGNATION_V1,
  HR_PAPER_DOCUMENTS_RETURN_V1,
];

/** One paper by id, or null when the id is not one of ours. */
export function hrPaperById(id: string | null | undefined): HrPaperTemplate | null {
  if (!id) return null;
  return HR_PAPERS.find((paper) => paper.id === id) ?? null;
}
