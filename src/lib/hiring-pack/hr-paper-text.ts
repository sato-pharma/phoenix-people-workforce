/**
 * SATO'S OWN HR PAPERS — the six the owner supplied on 2026-09-05, and what has joined them since.
 *
 * THE CERTIFICATE OF EXPERIENCE (2026-09-06) is the first paper in this file the owner did not hand
 * over as a Word document; it was drawn from scratch on the house identity, and the notes above it
 * record every judgement that went into it rather than a diff against a draft.
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
 * 4 — إنذار أول بالانقطاع عن العمل. Version 2, the owner's correction of 2026-09-17.
 *
 * 🔴 THE FACT WARNED ABOUT IS NOT COMING TO THE OFFICE. Version 1 recited «تغيبكم عن الحضور إلى مقر
 * عملكم … الكائن في» the Cairo head office — and the case that exposed it was a medical rep, whose
 * work is in the field and never at that address. A warning resting on the wrong fact hands the
 * worker his answer ("I was never required at head office"). Article 166 speaks of absence from
 * WORK, not from a building, so the paper now recites a stop in carrying out the job, proven the way
 * مادة (8) of the contract makes attendance provable: nothing recorded through the approved means.
 * The head-office address stays where it belongs, in the company recital at the top.
 *
 * NEUTRAL ON PURPOSE — no «مندوب دعاية طبية», no «الميدانية». This one paper serves every employee,
 * and field wording on an office employee's warning is the same defect turned the other way round.
 * The job is named through {{JOB_TITLE}}.
 *
 * 🔴 THE RESIGNATION PARAGRAPH PRINTS FOR EVERYONE, not behind a tick-box. The paper filed against a
 * person has to be the paper he was handed, and a per-print option is one the filed copy can lose.
 * So it is worded to be true of any absent employee: the relationship stands, because no resignation
 * meeting Article 167 — written, signed, approved by the labour office — has been received, and
 * saying so aloud or in a message is not one. It shuts the "I had already resigned" defence without
 * asserting that this particular person said anything.
 *
 * AND THE REGISTERED LETTER IS NO LONGER ONE OPTION AMONG SEVERAL. Version 1's service note read
 * "registered letter OR any means that proves notice", which reads as permission to WhatsApp it.
 * Article 166 requires the registered letter; everything else is in addition.
 */
export const HR_PAPER_ABSENCE_WARNING_V2: HrPaperTemplate = {
  id: "absence-warning-first-v2",
  kind: "letter",
  version: 2,
  titleAr: "إنذار أول بالانقطاع عن العمل",
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
    "نظرًا لانقطاعكم عن مباشرة مهام عملكم بوظيفة {{JOB_TITLE}}، وعدم أدائكم الأعمال المكلفين بها، اعتبارًا من {{ABSENCE_FROM}} وحتى {{ABSENCE_TO}}، لمدة خمسة أيام عمل متصلة، دون أن يُثبَت خلالها أي حضور أو زيارات بالوسيلة المعتمدة وفقًا للمادة (8) من عقد العمل، ودون تقديم مسوغ قانوني أو عذر مقبول.",
    "ونحيطكم علمًا بأن علاقة العمل لا تزال قائمة بكافة ما يترتب عليها من التزامات، إذ لم تُقدَّم إلينا حتى تاريخه استقالة مكتوبة موقعة منكم أو من وكيلكم الخاص ومعتمدة من الجهة الإدارية المختصة وفقًا للمادة (167) من قانون العمل رقم 14 لسنة 2025، ولا يُغني عن ذلك إبداء الرغبة في ترك العمل شفاهةً أو برسالة.",
  ],
  operativeHeadingAr: "لــــــــــذلـــــــــك",
  operativeParagraphsAr: [
    "فإننا نُنذركم بضرورة العودة فورًا إلى مباشرة مهام عملكم والانتظام في أداء الأعمال المكلفين بها، أو تقديم ما يثبت وجود عذر مشروع عن مدة الانقطاع، وننبهكم إلى أن استمرار الانقطاع دون مبرر مشروع لمدة تجاوز عشرة أيام متصلة يترتب عليه اعتباركم مستقيلًا حكمًا، وذلك إعمالًا للمادة (166) من قانون العمل رقم 14 لسنة 2025 وللمادة (8) من عقد العمل المبرم بيننا، مع احتفاظ الشركة بكافة حقوقها القانونية.",
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
    "يُرسَل هذا الإنذار إلى العامل بخطاب موصى عليه بعلم الوصول على عنوانه الثابت بصدر العقد، وهو إجراء لازم إعمالًا للمادة (166) من قانون العمل لا يُغني عنه غيره، ويجوز إخطاره إضافيًا على بريده الإلكتروني الثابت بصدر العقد أو بأي وسيلة تُثبت العلم. وفي حالة تسليمه إليه وامتناعه عن التوقيع بالاستلام، يُثبت ذلك في محضر يوقعه شاهدان، وذلك إعمالًا للمادة (8) والمادة (13) بند (1) من العقد.",
  serviceFields: [
    { labelAr: "شاهد أول — الاسم", token: null },
    { labelAr: "التوقيع", token: null },
    { labelAr: "شاهد ثانٍ — الاسم", token: null },
    { labelAr: "التوقيع", token: null },
  ],
  footerAr: "إنذار أول بالانقطاع عن العمل · المادة (166) من قانون العمل رقم 14 لسنة 2025",
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
 * 5 — إخطار باعتبار العامل مستقيلاً حكمًا. Version 2, alongside the first warning's.
 *
 * The same correction, and it has to land on both papers together: version 1 recited the same
 * «الحضور إلى مقر عملكم … الكائن في» head-office absence, so fixing only the warning would put the
 * defect back on the paper that actually ends the service. It now recites the stop in work the
 * warning recites, and says the earlier warning went by REGISTERED LETTER — the condition Article
 * 166 sets before anyone can be deemed resigned, so a desk that skipped it meets the fact on the
 * page it is about to sign rather than in a hearing.
 */
export const HR_PAPER_DEEMED_RESIGNATION_V2: HrPaperTemplate = {
  id: "absence-deemed-resignation-v2",
  kind: "letter",
  version: 2,
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
    "نظرًا لانقطاعكم عن مباشرة مهام عملكم بوظيفة {{JOB_TITLE}}، وعدم أدائكم الأعمال المكلفين بها، اعتبارًا من {{ABSENCE_FROM}} وحتى {{ABSENCE_TO}}، لمدة تجاوزت عشرة أيام متصلة، دون أن يُثبَت خلالها أي حضور أو زيارات بالوسيلة المعتمدة وفقًا للمادة (8) من عقد العمل، ودون مبرر مشروع أو عذر مقبول.",
    "وقد سبق إنذاركم بخطاب موصى عليه بعلم الوصول عن الانقطاع في الفترة من {{FIRST_WARNING_FROM}} إلى {{FIRST_WARNING_TO}}، ولم تعودوا إلى مباشرة عملكم ولم تقدموا ثمة عذر.",
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
    "يُرسَل هذا الإخطار إلى العامل بخطاب موصى عليه بعلم الوصول على عنوانه الثابت بصدر العقد، ويجوز إخطاره إضافيًا على بريده الإلكتروني الثابت بصدر العقد أو بأي وسيلة تُثبت العلم. وفي حالة تسليمه إليه وامتناعه عن التوقيع بالاستلام، يُثبت ذلك في محضر يوقعه شاهدان، وذلك إعمالًا للمادة (8) والمادة (13) بند (1) من العقد.",
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
 * 7 — شهادة خبرة.
 *
 * The paper an employee asks for on his way out, and takes to his next employer, an embassy or a
 * bank. It is the only document in this module written for a reader OUTSIDE the company, and every
 * decision below follows from that.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * WHAT IT DOES NOT SAY, and each omission is deliberate rather than pending.
 *
 * 🔴 NO SALARY. A certificate of experience states service, not pay. A salary certificate — شهادة
 *    راتب — is a different paper for a different reader (a bank deciding a loan), and the two are
 *    asked for separately in Egypt precisely because a person applying for a job does not want his
 *    last salary in the hands of the employer negotiating his next one. Printing it here would
 *    disclose it to every reader of every certificate, permanently and with no way to take it back.
 *
 * 🔴 NO REASON FOR LEAVING. Whether somebody resigned, was terminated or reached the end of a term
 *    is between him and the company; a certificate that names it turns a routine document into an
 *    obstacle he cannot answer, and the company gains nothing by volunteering it to a stranger.
 *    The exit route is recorded on the resignation or mutual-termination form, which is where a
 *    reader entitled to know it looks.
 *
 * 🔴 NO STATEMENT OF CONDUCT OR PERFORMANCE. The Egyptian house style «وكان حسن السير والسلوك» is
 *    a testimonial, and this paper prints from a button for anybody in the system — including
 *    somebody dismissed for cause. A testimonial the company has not actually made, printed
 *    automatically, is worth less than none and is the kind of sentence that gets quoted back in a
 *    dispute. Somebody who has earned a recommendation gets one written and signed by a person.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * WHAT IT SAYS TWO WAYS. A certificate is issued to a leaver AND to somebody still at his desk who
 * needs one for a visa, and getting that wrong is the one error on this page that matters: a paper
 * asserting a serving employee's service ENDED is wrong in a way that costs him the job he is
 * applying for. So the period, the status sentence and the span are resolved from the employee's own
 * departure flag in `buildHrPaperValues` — never from whether a last-working date happens to be on
 * file, because an absent date means "nobody recorded it", not "he is still here".
 *
 * The subtitle carries NO article number. Every other paper in this file cites the article it acts
 * under because the owner's drafts did; nothing here rests on a specific article, and inventing a
 * citation to match the house pattern is how a wrong one reaches a document read by a lawyer.
 */
export const HR_PAPER_EXPERIENCE_CERTIFICATE_V1: HrPaperTemplate = {
  id: "experience-certificate-v1",
  kind: "certificate",
  version: 1,
  titleAr: "شهادة خبرة",
  subtitleAr: LAW_SUBTITLE,
  purposeAr:
    "تُحرَّر من نسختين — نسخة تُسلَّم لصاحب الشأن بناءً على طلبه، ونسخة تُحفظ بملف الخدمة.",
  bindingLineAr: null,

  firstPartyHeadingAr: "الصادرة عن — الشركة",
  firstPartyLinesAr: FIRST_PARTY_LINES_AR,

  secondPartyHeadingAr: "بيانات صاحب الشأن",
  secondPartyFields: [
    { labelAr: "الاسم رباعيًا", token: "EMPLOYEE_NAME", wide: true },
    { labelAr: "الرقم القومي", token: "NATIONAL_ID", ltr: true },
    { labelAr: "كود الموظف", token: "HR_ID", ltr: true },
    { labelAr: "الوظيفة", token: "JOB_TITLE" },
    { labelAr: "الإدارة / القطاع", token: "DEPARTMENT" },
    { labelAr: "تاريخ الالتحاق بالعمل", token: "HIRE_DATE", ltr: true },
    { labelAr: "تاريخ إصدار الشهادة", token: "ISSUE_DATE", ltr: true },
  ],
  sections: [],

  bodyParagraphsAr: [
    "إلى من يهمه الأمر،",
    "تشهد {{COMPANY_NAME}} بأن السيد / السيدة المبيّنة بياناته عاليه قد التحق بالعمل لديها اعتبارًا من {{HIRE_DATE}} وحتى {{SERVICE_END}}، وشغل خلال هذه المدة وظيفة {{JOB_TITLE}} بـ{{DEPARTMENT}}، وبلغت مدة خدمته {{SERVICE_DURATION}}.",
    "{{SERVICE_STATUS}}",
    "وقد أُعطيت له هذه الشهادة بناءً على طلبه للتقدم بها إلى من يهمه الأمر، دون أدنى مسؤولية على الشركة قِبَل الغير.",
  ],
  operativeHeadingAr: null,
  operativeParagraphsAr: [],
  checklist: null,
  openTable: null,
  declarationAr: null,

  signaturesHeadingAr: "التوقيع والاعتماد",
  // ONE COLUMN, AND NO EMPLOYEE SIGNATURE. He is the subject of this paper, not a party to it —
  // a signature line under his name would invite a reader to treat the certificate as something he
  // attested to rather than something the company certified about him.
  //
  // NO TOKEN IN THE HEADING. `signatureTable` escapes what it is given and does not substitute, so
  // a `{{COMPANY_NAME}}` here would print those braces onto the signature row. The masthead names
  // the company on every copy anyway.
  signatureColumns: [
    {
      headingAr: "عن الشركة — إدارة الموارد البشرية",
      fieldsAr: ["الاسم والصفة:", "التوقيع:", "خاتم الشركة:"],
    },
  ],
  signatoryNoteLinesAr: [],
  receiptAcknowledgmentAr: null,
  serviceNoteAr: null,
  serviceFields: [],
  footerAr: "شهادة خبرة · صادرة عن إدارة الموارد البشرية",
};

/*
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * THE ARABIC HR LETTER — 2026-09-20. The Arabic counterpart of `salary-letter-en.ts`, the way this
 * certificate is the Arabic counterpart of `experience-certificate-en.ts`. These are its WORDS; since
 * 2026-10-28 its dress is `salary-letter-ar.ts`, the certificate of experience's design, worn by the
 * English letter too (owner: "Make it the HR letter", both languages). An archived version prints
 * through `render-hr-paper.ts` in the layout it was signed in.
 *
 * NOT A `certificate`: see the note on `HrPaperKind.salaryLetter`. Sharing the certificate's `kind`
 * would pull in its print-banner warning about blank dates and pool its archived versions with a
 * paper that ends somebody's service, neither of which is true of a letter stating a salary.
 *
 * STATES THE BASE SALARY, AND ONLY THE BASE SALARY — the owner, 2026-09-20: "you will not put the
 * basic, you will put the base and you will call it ويتقاضى أجرًا شهريًا مقداره". It stated the BASIC
 * salary from its first day (2026-09-13, "salary we put basic not net"); this one now reads the figure
 * on the record as it is, never run through the payroll policy's basic formula, and since 2026-10-28
 * the English letter does too ("PUT THE BASE NOT THE BASIC SALARY"). A missing base salary prints as a dotted rule, never
 * as a zero.
 *
 * NO COMPANY SEAL — the first paper to lose it (owner, 2026-09-20: "remove the stamp"), and since
 * 2026-09-29 every other hiring paper has followed, so there is no longer a flag to set. A copies
 * sentence worked out from the number the desk chose at print time came the same day — «تحرر من
 * نسختين نسخة تسلم …», and "ask me how many copies … and based on what I tell you, you write here".
 * `{{COPIES_CLAUSE}}` is `copiesClauseAr` (copies-clause.ts).
 */
export const HR_PAPER_SALARY_LETTER_AR_V1: HrPaperTemplate = {
  id: "salary-letter-ar-v1",
  kind: "salaryLetter",
  version: 1,
  titleAr: "شهادة راتب",
  subtitleAr: LAW_SUBTITLE,
  purposeAr:
    "تُصدَر هذه الشهادة بناءً على طلب صاحب الشأن، للتقدم بها إلى من يهمه الأمر.",
  bindingLineAr: null,

  firstPartyHeadingAr: "الصادرة عن — الشركة",
  firstPartyLinesAr: FIRST_PARTY_LINES_AR,

  secondPartyHeadingAr: "بيانات صاحب الشأن",
  secondPartyFields: [
    { labelAr: "الاسم رباعيًا", token: "EMPLOYEE_NAME", wide: true },
    { labelAr: "الرقم القومي", token: "NATIONAL_ID", ltr: true },
    { labelAr: "كود الموظف", token: "HR_ID", ltr: true },
    { labelAr: "الوظيفة", token: "JOB_TITLE" },
    { labelAr: "الإدارة / القطاع", token: "DEPARTMENT" },
    { labelAr: "تاريخ الالتحاق بالعمل", token: "HIRE_DATE", ltr: true },
    { labelAr: "تاريخ الإصدار", token: "ISSUE_DATE", ltr: true },
  ],
  sections: [],

  bodyParagraphsAr: [
    "إلى من يهمه الأمر،",
    "تشهد {{COMPANY_NAME}} بأن السيد / السيدة المبيّنة بياناته عاليه قد التحق بالعمل لديها اعتبارًا من {{HIRE_DATE}} وحتى {{SERVICE_END}}، وشغل خلال هذه المدة وظيفة {{JOB_TITLE}} بـ{{DEPARTMENT}}.",
    "{{SERVICE_STATUS}}",
    "{{BASE_SALARY_LEAD}} ( {{BASE_SALARY}} ) جنيه (( {{BASE_SALARY_WORDS}} ) فقط لا غير).",
    "وقد أُعطيت له هذه الشهادة بناءً على طلبه للتقدم بها إلى من يهمه الأمر، دون أدنى مسؤولية على الشركة قِبَل الغير.",
    "{{COPIES_CLAUSE}}",
  ],
  operativeHeadingAr: null,
  operativeParagraphsAr: [],
  checklist: null,
  openTable: null,
  declarationAr: null,

  signaturesHeadingAr: "التوقيع والاعتماد",
  // ONE COLUMN, AND NO EMPLOYEE SIGNATURE — the certificate's own reasoning applies unchanged: he is
  // the subject of this letter, not a party to it.
  signatureColumns: [
    {
      headingAr: "عن الشركة — إدارة الموارد البشرية",
      fieldsAr: ["الاسم والصفة:", "التوقيع:"],
    },
  ],
  signatoryNoteLinesAr: [],
  receiptAcknowledgmentAr: null,
  serviceNoteAr: null,
  serviceFields: [],
  footerAr: "شهادة راتب · صادرة عن إدارة الموارد البشرية",
};

/*
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * THE LETTERS PACK — 2026-09-13.
 *
 * Nine of the owner's own papers, moved onto the house template: "Move them onto the Sato Pharma
 * template". THEIR WORDING IS HIS, kept as written — including the older phrasing and citations he
 * chose to keep — and nothing is added to what they say. What the template changes is only what a
 * template changes: the letterhead, the grids, the signature block, and filling from the record the
 * facts Phoenix already holds (a name, a post, a national ID, the company) where the Word file had a
 * dotted line.
 *
 * WHAT STAYS RULED, and why: the act and the article on a warning or a penalty, the new post on a
 * transfer, the office an authorisation is addressed to, the tasks on a handover. Phoenix holds no
 * register of any of them, and each is the fact on its paper that must not be wrong.
 *
 * THE FOOTER is the owner's own, 2026-09-13: «ساتو فارما | إدارة الموارد البشرية».
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 */

const PACK_FOOTER_AR = "ساتو فارما | إدارة الموارد البشرية";

/** The same signing block on every HR column of the pack — the seal lands on التوقيع والختم. */
const HR_SIGNING_FIELDS_AR: readonly string[] = ["الاسم والصفة:", "التوقيع والختم:", "التاريخ:"];
const PERSON_SIGNING_FIELDS_AR: readonly string[] = ["الاسم:", "التوقيع:", "التاريخ:"];

/** The person a decision is addressed to. */
const ADDRESSEE_FIELDS: HrPaperTemplate["secondPartyFields"] = [
  { labelAr: "الاسم", token: "EMPLOYEE_NAME", wide: true },
  { labelAr: "كود الموظف", token: "HR_ID", ltr: true },
  { labelAr: "الوظيفة", token: "JOB_TITLE" },
  { labelAr: "الإدارة", token: "DEPARTMENT" },
  { labelAr: "التاريخ", token: "ISSUE_DATE", ltr: true },
];

/** 8 — إنذار. */
export const HR_PAPER_DISCIPLINARY_WARNING_V1: HrPaperTemplate = {
  id: "disciplinary-warning-v1",
  kind: "letter",
  version: 1,
  titleAr: "إنذار",
  subtitleAr: "طبقًا للائحة الجزاءات التأديبية المعتمدة بالشركة",
  purposeAr: "يُحرَّر من نسختين — نسخة تُسلَّم للعامل بتوقيعه بالعلم، ونسخة تُحفظ بملف الخدمة.",
  bindingLineAr: null,

  firstPartyHeadingAr: null,
  firstPartyLinesAr: [],

  secondPartyHeadingAr: "موجه إلى",
  secondPartyFields: ADDRESSEE_FIELDS,
  sections: [],

  bodyParagraphsAr: [
    "بالإشارة إلى الموضوع أعلاه، ونتيجة لقيامكم بـ «………………………………………………………»، فهذا يعتبر إنذاراً بعدم التكرار، وفي حالة التكرار ستطبق العقوبة المقررة بلائحة الجزاءات التأديبية.",
    "وذلك طبقاً للمادة رقم (……) من لائحة الجزاءات التي تنص على «………………………………………………………».",
  ],
  operativeHeadingAr: null,
  operativeParagraphsAr: [],
  checklist: null,
  openTable: null,
  declarationAr: null,

  signaturesHeadingAr: "التوقيعات",
  signatureColumns: [
    { headingAr: "إدارة الموارد البشرية", fieldsAr: HR_SIGNING_FIELDS_AR },
    { headingAr: "التوقيع بالعلم — العامل", fieldsAr: PERSON_SIGNING_FIELDS_AR },
  ],
  signatoryNoteLinesAr: [],
  receiptAcknowledgmentAr: null,
  serviceNoteAr: null,
  serviceFields: [],
  footerAr: PACK_FOOTER_AR,
};

/** 9 — جزاء إداري. Signed by the direct manager, as the original was; HR's column takes the seal. */
export const HR_PAPER_DISCIPLINARY_PENALTY_V1: HrPaperTemplate = {
  id: "disciplinary-penalty-v1",
  kind: "letter",
  version: 1,
  titleAr: "جزاء إداري",
  subtitleAr: "طبقًا للائحة الجزاءات التأديبية المعتمدة بالشركة",
  purposeAr: "يُحرَّر من نسختين — نسخة تُسلَّم للعامل بتوقيعه بالعلم، ونسخة تُحفظ بملف الخدمة.",
  bindingLineAr: null,

  firstPartyHeadingAr: null,
  firstPartyLinesAr: [],

  secondPartyHeadingAr: "موجه إلى",
  secondPartyFields: ADDRESSEE_FIELDS,
  sections: [],

  bodyParagraphsAr: [
    "بالإشارة إلى الموضوع أعلاه، ونتيجة لقيامكم بـ «………………………………………………………»، ستطبق العقوبة المقررة بلائحة الجزاءات التأديبية.",
  ],
  operativeHeadingAr: null,
  operativeParagraphsAr: [
    "نوع الجزاء: ………………………………   عدد الأيام: (……)",
    "وذلك طبقاً للمادة رقم (……) من لائحة الجزاءات.",
  ],
  checklist: null,
  openTable: null,
  declarationAr: null,

  signaturesHeadingAr: "التوقيعات",
  signatureColumns: [
    { headingAr: "المدير المباشر", fieldsAr: PERSON_SIGNING_FIELDS_AR },
    { headingAr: "إدارة الموارد البشرية", fieldsAr: HR_SIGNING_FIELDS_AR },
    { headingAr: "التوقيع بالعلم — العامل", fieldsAr: PERSON_SIGNING_FIELDS_AR },
  ],
  signatoryNoteLinesAr: [],
  receiptAcknowledgmentAr: null,
  serviceNoteAr: null,
  serviceFields: [],
  footerAr: PACK_FOOTER_AR,
};

/** 10 — قرار نقل. The current post is filled; the new one is ruled. */
export const HR_PAPER_TRANSFER_DECISION_V1: HrPaperTemplate = {
  id: "transfer-decision-v1",
  kind: "letter",
  version: 1,
  titleAr: "قرار نقل",
  subtitleAr: "صادر عن إدارة الموارد البشرية",
  purposeAr: "يُحرَّر من نسختين — نسخة تُسلَّم للعامل، ونسخة تُحفظ بملف الخدمة.",
  bindingLineAr: null,

  firstPartyHeadingAr: null,
  firstPartyLinesAr: [],

  secondPartyHeadingAr: "البيانات العامة",
  secondPartyFields: [
    { labelAr: "الاسم", token: "EMPLOYEE_NAME", wide: true },
    { labelAr: "كود الموظف", token: "HR_ID", ltr: true },
    { labelAr: "تاريخ القرار", token: "ISSUE_DATE", ltr: true },
    { labelAr: "الوظيفة", token: "JOB_TITLE" },
    { labelAr: "الإدارة", token: "DEPARTMENT" },
    { labelAr: "المدير المباشر", token: null, wide: true },
  ],
  sections: [
    {
      headingAr: "بيانات النقل",
      fields: [
        { labelAr: "النقل إلى إدارة", token: null, wide: true },
        { labelAr: "الوظيفة", token: null },
        { labelAr: "المدير المباشر", token: null },
      ],
    },
  ],

  bodyParagraphsAr: [],
  operativeHeadingAr: "قرار النقل",
  operativeParagraphsAr: [
    "قررنا نحن {{COMPANY_NAME}} نقل سيادتكم للعمل في إدارة ……………………………… بدءاً من …… / …… / ………… وسيتم تسليمكم الوصف الوظيفي وأهداف الإدارة لمعرفتها جيداً والعمل على تحقيقها.",
    "نتمنى لكم التوفيق والنجاح الدائم ...",
  ],
  checklist: null,
  openTable: null,
  declarationAr: null,

  signaturesHeadingAr: "التوقيعات",
  signatureColumns: [
    { headingAr: "المدير المباشر", fieldsAr: PERSON_SIGNING_FIELDS_AR },
    { headingAr: "مدير الموارد البشرية", fieldsAr: HR_SIGNING_FIELDS_AR },
  ],
  signatoryNoteLinesAr: [],
  receiptAcknowledgmentAr: null,
  serviceNoteAr: null,
  serviceFields: [],
  footerAr: PACK_FOOTER_AR,
};

/**
 * 11 — مذكرة تعديل راتب.
 *
 * NO FIGURE PRINTS, neither the old salary nor the new. The memo instructs payroll to act; the
 * amount is decided in the payroll run, and a number typed onto a sheet is a second source for it.
 */
export const HR_PAPER_SALARY_ADJUSTMENT_V1: HrPaperTemplate = {
  id: "salary-adjustment-memo-v1",
  kind: "letter",
  version: 1,
  titleAr: "مذكرة تعديل راتب",
  subtitleAr: "من إدارة الموارد البشرية إلى إدارة الرواتب",
  purposeAr: "نسخة واحدة تُرسل إلى إدارة الرواتب، وتُحفظ صورتها بملف الخدمة.",
  bindingLineAr: null,

  firstPartyHeadingAr: null,
  firstPartyLinesAr: [],

  secondPartyHeadingAr: "بيانات المذكرة",
  secondPartyFields: [
    { labelAr: "القاهرة في", token: "ISSUE_DATE", ltr: true },
    { labelAr: "رقم القرار", token: null, ltr: true },
  ],
  sections: [],

  bodyParagraphsAr: [
    "بناءً على قرار رقم (……) وطبقاً للصلاحيات الممنوحة لمدير الموارد البشرية في لائحة تنظيم العمل وطبقاً لجدول الأجور المعتمد فيرجى تعديل رواتب المذكورين أدناه للأسباب المذكورة بدءاً من تاريخ …… / …… / …………",
  ],
  operativeHeadingAr: null,
  operativeParagraphsAr: [],
  checklist: null,
  openTable: {
    headingAr: "بيان المذكورين",
    columnsAr: ["م", "الاسم", "الإدارة", "سبب التعديل"],
    rows: 8,
    firstRowTokens: ["EMPLOYEE_NAME", "DEPARTMENT", null],
  },
  declarationAr: null,

  signaturesHeadingAr: "الاعتماد",
  signatureColumns: [{ headingAr: "مدير الموارد البشرية", fieldsAr: HR_SIGNING_FIELDS_AR }],
  signatoryNoteLinesAr: [],
  receiptAcknowledgmentAr: null,
  serviceNoteAr: null,
  serviceFields: [],
  footerAr: PACK_FOOTER_AR,
};

/** 12 — تفويض التأمين الاجتماعي. His list of what the delegate may do, kept exactly. */
export const HR_PAPER_SOCIAL_INSURANCE_AUTHORIZATION_V1: HrPaperTemplate = {
  id: "social-insurance-authorization-v1",
  kind: "letter",
  version: 1,
  titleAr: "تفويض — التأمينات الاجتماعية",
  subtitleAr: "خطاب تفويض إلى مكتب التأمينات الاجتماعية المختص",
  purposeAr: "يُحرَّر من نسختين — الأصل يُسلَّم لمكتب التأمينات، وصورة تُحفظ بملف الخدمة.",
  bindingLineAr: null,

  firstPartyHeadingAr: null,
  firstPartyLinesAr: [],

  secondPartyHeadingAr: null,
  secondPartyFields: [],
  sections: [],

  bodyParagraphsAr: [
    "التاريخ: {{ISSUE_DATE}}",
    "السيد / مدير مكتب تأمينات ……………………………",
    "بعد التحية ...",
    "فوضنا نحن {{COMPANY_NAME}} السيد / {{EMPLOYEE_NAME}} ، بطاقة رقم قومي / {{NATIONAL_ID}} والرقم التأميني / {{INSURANCE_NUMBER}} للتعامل في كل ما يخص التأمينات الاجتماعية (الاستعلام - س1 – س6 – س2 – التفتيش – متابعة صرف الإجازات – طباعة برينت منشأة – طباعة برينت للموظفين – تأمين السيارات)",
    "وشكراً لحسن تعاونكم المثمر.",
    "وتفضلوا بقبول فائق الاحترام",
  ],
  operativeHeadingAr: null,
  operativeParagraphsAr: [],
  checklist: null,
  openTable: null,
  declarationAr: null,

  signaturesHeadingAr: null,
  signatureColumns: [{ headingAr: "المدير المسئول — عن الشركة", fieldsAr: HR_SIGNING_FIELDS_AR }],
  signatoryNoteLinesAr: [],
  receiptAcknowledgmentAr: null,
  serviceNoteAr: null,
  serviceFields: [],
  footerAr: PACK_FOOTER_AR,
};

/** 13 — تفويض التأمين الصحي. */
export const HR_PAPER_HEALTH_INSURANCE_AUTHORIZATION_V1: HrPaperTemplate = {
  id: "health-insurance-authorization-v1",
  kind: "letter",
  version: 1,
  titleAr: "تفويض — التأمين الصحي",
  subtitleAr: "خطاب تفويض إلى الهيئة العامة للتأمين الصحي",
  purposeAr: "يُحرَّر من نسختين — الأصل يُسلَّم للهيئة، وصورة تُحفظ بملف الخدمة.",
  bindingLineAr: null,

  firstPartyHeadingAr: null,
  firstPartyLinesAr: [],

  secondPartyHeadingAr: null,
  secondPartyFields: [],
  sections: [],

  bodyParagraphsAr: [
    "التاريخ: {{ISSUE_DATE}}",
    "السادة / هيئة التأمين الصحي",
    "بعد التحية ...",
    "فوضنا نحن {{COMPANY_NAME}} السيد / {{EMPLOYEE_NAME}} ، بطاقة رقم قومي / {{NATIONAL_ID}} لاستخراج وتجديد البطاقات الصحية الخاصة بالشركة وجميع الإجراءات الخاصة بالتأمين الصحي",
    "وتفضلوا بقبول فائق الاحترام",
  ],
  operativeHeadingAr: null,
  operativeParagraphsAr: [],
  checklist: null,
  openTable: null,
  declarationAr: null,

  signaturesHeadingAr: null,
  signatureColumns: [{ headingAr: "مدير الموارد البشرية", fieldsAr: HR_SIGNING_FIELDS_AR }],
  signatoryNoteLinesAr: [],
  receiptAcknowledgmentAr: null,
  serviceNoteAr: null,
  serviceFields: [],
  footerAr: PACK_FOOTER_AR,
};

/** 14 — خطاب استخراج برينت تأميني. */
export const HR_PAPER_INSURANCE_PRINT_LETTER_V1: HrPaperTemplate = {
  id: "insurance-print-request-v1",
  kind: "letter",
  version: 1,
  titleAr: "خطاب استخراج برينت تأميني",
  subtitleAr: "إلى مكتب التأمينات الاجتماعية المختص",
  purposeAr: "يُحرَّر من نسختين — الأصل يُسلَّم لمكتب التأمينات، وصورة تُحفظ بملف الخدمة.",
  bindingLineAr: null,

  firstPartyHeadingAr: null,
  firstPartyLinesAr: [],

  secondPartyHeadingAr: null,
  secondPartyFields: [],
  sections: [],

  bodyParagraphsAr: [
    "القاهرة في: {{ISSUE_DATE}}",
    "السادة / مكتب تأمينات ……………………………",
    "بعد التحية ...",
    "نحيط سيادتكم علماً بأن السيد / {{EMPLOYEE_NAME}} - يعمل لدى {{COMPANY_NAME}} برقم تأميني {{INSURANCE_NUMBER}}",
    "برجاء استخراج برينت.",
    "ولكم جزيل الشكر ...",
  ],
  operativeHeadingAr: null,
  operativeParagraphsAr: [],
  checklist: null,
  openTable: null,
  declarationAr: null,

  signaturesHeadingAr: null,
  signatureColumns: [{ headingAr: "إدارة الموارد البشرية", fieldsAr: HR_SIGNING_FIELDS_AR }],
  signatoryNoteLinesAr: [],
  receiptAcknowledgmentAr: null,
  serviceNoteAr: null,
  serviceFields: [],
  footerAr: PACK_FOOTER_AR,
};

/**
 * 15 — محضر إداري داخلي بتسليم وتسلم المهام الوظيفية.
 *
 * THE ADDRESS IS LITERAL, as the owner confirmed it on 2026-09-13 — not the settings head office.
 * It is the address this record was written against, and he checked it.
 */
export const HR_PAPER_HANDOVER_RECORD_V1: HrPaperTemplate = {
  id: "handover-record-v1",
  kind: "undertaking",
  version: 1,
  titleAr: "محضر إداري داخلي بتسليم وتسلم المهام الوظيفية",
  subtitleAr: "يُحفظ بأرشيف الشركة ويُودع أصله بملف الموظف بإدارة الموارد البشرية",
  purposeAr: "هذا المحضر مكون من أصل واحد.",
  bindingLineAr: null,

  firstPartyHeadingAr: null,
  firstPartyLinesAr: [
    "إنه في يوم {{ISSUE_DAY_NAME}} الموافق {{ISSUE_DATE}} م",
    "شركة ساتو فارما بمقرها الإداري الكائن بمركزها الرئيسي : 8 ن مربع 1258 ز – شيراتون - القاهرة.",
  ],

  secondPartyHeadingAr: "الحضور",
  secondPartyFields: [
    { labelAr: "1 — السيد /", token: null },
    { labelAr: "بصفته", token: null },
    { labelAr: "2 — السيد /", token: null },
    { labelAr: "بصفته", token: null },
  ],
  sections: [
    {
      headingAr: "الموظف المسلِّم",
      fields: [
        { labelAr: "الاسم", token: "EMPLOYEE_NAME", wide: true },
        { labelAr: "كود الموظف", token: "HR_ID", ltr: true },
        { labelAr: "الرقم القومي", token: "NATIONAL_ID", ltr: true },
        { labelAr: "الوظيفة", token: "JOB_TITLE" },
        { labelAr: "الإدارة", token: "DEPARTMENT" },
      ],
    },
  ],

  bodyParagraphsAr: [
    "وحيث أنه بناءً على ما تقدم به السيد / {{EMPLOYEE_NAME}} ويشغل وظيفة {{JOB_TITLE}} بإدارة {{DEPARTMENT}} باستقالته من الشركة ؛ ولما كان معه من مهام وظيفته، وبعد قبول استقالته من منصبه فقد تقرر أن يتم تحرير محضر إداري داخلي بتسليم وتسلم المهام الوظيفية منه:",
  ],
  operativeHeadingAr: null,
  operativeParagraphsAr: [],
  checklist: null,
  openTable: {
    headingAr: "المهام الوظيفية المسلَّمة",
    columnsAr: ["م", "المهمة الوظيفية", "المستلم / بصفته", "توقيع المستلم"],
    rows: 5,
  },
  closingParagraphsAr: [
    "على أن يقوم المستلم لتلك المهام الوظيفية بالقيام بذلك العمل على الوجه الأكمل بما يحقق مصلحة الشركة وحسن سير العمل بها، وأنه تسلم تلك المهام بالحالة التامة النافية للجهالة، وقد قام بالتسلم الفعلي لتلك المهام الوظيفية.",
    "وبناءً عليه: وبانتهاء أعمال المحضر الإداري الداخلي على ما جاء فيه، فأقفل المحضر الإداري وانتهت أعماله وتحريره وحفظه بأرشيف الشركة. وكذا إيداع الأصل بملف الموظف بإدارة الموارد البشرية.",
  ],
  declarationAr:
    "أقر أنا / {{EMPLOYEE_NAME}} وأحمل بطاقة رقم قومي {{NATIONAL_ID}} بأنني قد قمت بتسليم كافة مهامي الوظيفية التي كانت بحوزتي ومكلف بها للسادة المذكور أسماؤهم أعلاه، ولا توجد أية متعلقات أو ملاحظات لم يتم تسليمها، أو أية مهام لم يتم الإبلاغ والتنويه عنها. وفي حالة ظهور خلاف ذلك أتحمل المسؤولية الإدارية والقانونية المترتبة على ذلك.",

  signaturesHeadingAr: "توقيع أعضاء الحضور على المحضر الإداري الداخلي",
  signatureColumns: [
    { headingAr: "عضو الحضور (1)", fieldsAr: PERSON_SIGNING_FIELDS_AR },
    { headingAr: "عضو الحضور (2)", fieldsAr: PERSON_SIGNING_FIELDS_AR },
    { headingAr: "الموظف المسلِّم — المُقِر", fieldsAr: PERSON_SIGNING_FIELDS_AR },
    { headingAr: "إدارة الموارد البشرية", fieldsAr: PERSON_SIGNING_FIELDS_AR },
  ],
  signatoryNoteLinesAr: ["ملحوظة: هذا المحضر مكون من أصل، ويحتوي على عدد (……) ورقة لكل محضر على حدة."],
  receiptAcknowledgmentAr: null,
  serviceNoteAr: null,
  serviceFields: [],
  footerAr: PACK_FOOTER_AR,
};

/**
 * 16 — مقابلة نهاية الخدمة (Employee Exit Interview).
 *
 * BILINGUAL, AS HE WROTE IT. Every English line is its own block pinned left-to-right — a bilingual
 * line turns wholly one way and prints half of itself backwards. Nothing is pre-marked: the ratings
 * are the employee's own. An HR column sits beside his so the filed copy shows who took it.
 */
export const HR_PAPER_EXIT_INTERVIEW_V1: HrPaperTemplate = {
  id: "exit-interview-v1",
  kind: "checklist",
  version: 1,
  titleAr: "مقابلة نهاية الخدمة",
  subtitleAr: "Employee Exit Interview",
  purposeAr: "نسخة واحدة تُحفظ بملف الخدمة.",
  bindingLineAr: null,

  firstPartyHeadingAr: null,
  firstPartyLinesAr: [],

  secondPartyHeadingAr: "البيانات العامة",
  secondPartyFields: [
    { labelAr: "الاسم", labelEn: "Name", token: "EMPLOYEE_NAME", wide: true },
    { labelAr: "الكود الوظيفي", labelEn: "Employee No.", token: "HR_ID", ltr: true },
    { labelAr: "التاريخ", labelEn: "Date", token: "ISSUE_DATE", ltr: true },
    { labelAr: "المسمى الوظيفي", labelEn: "Position", token: "JOB_TITLE" },
    { labelAr: "الإدارة", labelEn: "Department", token: "DEPARTMENT" },
    { labelAr: "تاريخ التعيين", labelEn: "Hiring Date", token: "HIRE_DATE", ltr: true },
    { labelAr: "تاريخ انتهاء الخدمة", labelEn: "End of Service Date", token: "LAST_WORKING_DATE", ltr: true },
    { labelAr: "اسم المدير المباشر", labelEn: "Direct Manager", token: null, wide: true },
    { labelAr: "أسباب انتهاء فترة الخدمة", labelEn: "End of Service Reasons", token: null, wide: true },
  ],
  sections: [],

  bodyParagraphsAr: [],
  operativeHeadingAr: "بيانات المقابلة",
  operativeParagraphsAr: [
    "تؤكد وتلتزم الشركة لجميع الموظفين الذين يقومون بتعبئة هذا النموذج بأنه لن يضار أحد مهما كانت المعلومات التي يتم ذكرها، وأن الشركة تنظر بتقدير عالي لأبنائها الذين انتهت خدماتهم بالشركة وقاموا بتعبئة هذا النموذج بموضوعية. المرجو تعبئة رمز التقييم أدناه بالإجابة التي تعتقد أنها مناسبة حيث أن : 1 (منخفض) و 5 (مرتفع).",
    "The company confirms and commits to all employees who will fill out this form that no one will be harmed, whatever information is mentioned, and that the company highly appreciates its former employees who have objectively filled out this form. Please fill in the rating code below with the answer you think is appropriate as: 1 is \"low\" and 5 is \"high\".",
  ],

  checklist: {
    headingAr: "التقييم",
    itemHeadingAr: "الموضوع",
    columnsAr: ["5", "4", "3", "2", "1"],
    rows: [
      { number: "1", labelAr: "ما هو تقييمك العام للشركة كمكان ومحل عمل ؟", labelEn: "What is your general assessment of the company as a place of work?" },
      { number: "2", labelAr: "ما هو تقييمك العام لسياسات وإجراءات الشركة ؟", labelEn: "What is your general assessment of the company's policies and procedures?" },
      { number: "3", labelAr: "ما هو تقييمك لمكان العمل وللمرافق ولظروف العمل الصحية؟", labelEn: "What is your assessment of the workplace, facilities and healthy working conditions?" },
      { number: "4", labelAr: "ما هو تقييمك للمزايا التي تمنحها الشركة لموظفيها مقارنة بالشركات المماثلة ؟", labelEn: "What is your assessment of the benefits that the company grants to its employees compared to similar companies?" },
      { number: "5", labelAr: "ما هو تقييمك لمستوى الرواتب بالشركة بشكل عام مقارنة بالشركات المماثلة ؟", labelEn: "What is your assessment of the level of salaries in the company in general compared to similar companies?" },
      { number: "6", labelAr: "ما هو تقييمك لمستوى اهتمام الشركة بموظفيها ؟", labelEn: "What is your assessment of the company's level of interest in its employees?" },
      { number: "7", labelAr: "ما هو تقييمك لرغبة الوحدة التنظيمية في التغيير والتصحيح والتعديل ؟", labelEn: "What is your assessment of the organizational unit's desire for change, correction and modification?" },
      { number: "8", labelAr: "ما هو مقدار التدريب الذي تم توفيره لك عند التوظيف؟", labelEn: "How much training was provided to you upon employment?" },
      { number: "9", labelAr: "ما هو المدى الذي كان من الممكن للتدريب أن يؤهلك للقيام بوظيفة أعلى وزيادة في الراتب ؟", labelEn: "To what extent could the training have qualified you for a higher job and an increase in salary?" },
      { number: "10", labelAr: "ما هو فهمك خلال فترة خدمتك بالشركة لواجبات ومسؤوليات وظيفتك ؟", labelEn: "What is your understanding, during your tenure in the company, of the duties and responsibilities of your job?" },
      { number: "11", labelAr: "ما هو فهمك خلال فترة خدمتك بالشركة للمعايير وأهداف الأداء المطلوب منك تحقيقها؟", labelEn: "What is your understanding, during your service in the company, of the performance standards and objectives that you are required to achieve?" },
      { number: "12", labelAr: "ما هو فهمك خلال فترة خدمتك بالشركة لما يجري بالشركة ككل ؟", labelEn: "What is your understanding during your service in the company of what is happening in the company in general?" },
      { number: "13", labelAr: "ما هو تقييمك للتقدير الذي كنت تتلقاه من الشركة عندما كنت تؤدي عملاً بشكل جيد ؟", labelEn: "What is your assessment of the appreciation you received from the company when you were doing a good job?" },
      { number: "14", labelAr: "ما هو تقييمك لرغبة الرئيس المباشر في الاستماع والإصغاء والرغبة في المساعدة ؟", labelEn: "What is your assessment of your direct manager’s willingness to listen and help?" },
      { number: "15", labelAr: "ما هو مدى تشجيع رئيسك المباشر لك في تقديم الاقتراحات والتحسينات في أساليب العمل؟", labelEn: "To what extent does your immediate superior encourage you in making suggestions and improvements in working methods?" },
      { number: "16", labelAr: "ما هو تقييمك لفرص الترقية وزيادة الراتب والتطور الوظيفي في الشركة ؟", labelEn: "What is your assessment of the opportunities for promotion, salary increase and career development in the company?" },
      { number: "17", labelAr: "ما هو تقييمك لمستوى التعاون بين الزملاء في الوحدة التنظيمية التي كنت تعمل بها ؟", labelEn: "What is your assessment of the level of cooperation between colleagues in the organizational unit in which you work?" },
    ],
    footNoteAr: "1 (منخفض) — 5 (مرتفع)",
  },
  openQuestions: {
    headingAr: "أسئلة مفتوحة",
    lines: 2,
    rows: [
      { number: "18", labelAr: "ما الذي أعجبك أكثر في العمل في الشركة؟", labelEn: "What did you like most about working at the company?" },
      { number: "19", labelAr: "ما الذي لم يعجبك في العمل في الشركة ؟", labelEn: "What did you dislike about working at the company?" },
      { number: "20", labelAr: "ما هي اقتراحاتك لتحسين العمل في الوحدة التنظيمية التي كنت تعمل فيها ؟", labelEn: "What are your suggestions for improving the work in the organizational unit in which you were working?" },
      { number: "21", labelAr: "ما هي اقتراحاتك لتحسين العمل في الشركة ككل ؟", labelEn: "What are your suggestions to improve the work in the company as a whole?" },
      { number: "22", labelAr: "برأيك ما هو السبب الحقيقي لانتهاء خدماتك بالشركة ؟", labelEn: "In your opinion, what is the real reason for the end of your services in the company?" },
      { number: "23", labelAr: "ما هي الاقتراحات والملاحظات التي تعتقد أن من شأنها العودة بالنفع على الشركة؟", labelEn: "What are the suggestions and observations that you think would benefit the company?" },
    ],
  },
  openTable: null,
  declarationAr: null,

  signaturesHeadingAr: "التوقيعات",
  signatureColumns: [
    { headingAr: "الموظف", fieldsAr: PERSON_SIGNING_FIELDS_AR },
    { headingAr: "إدارة الموارد البشرية", fieldsAr: PERSON_SIGNING_FIELDS_AR },
  ],
  signatoryNoteLinesAr: [],
  receiptAcknowledgmentAr: null,
  serviceNoteAr: null,
  serviceFields: [],
  footerAr: PACK_FOOTER_AR,
};

/**
 * All of them, in the order a career runs through them.
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
  HR_PAPER_ABSENCE_WARNING_V2,
  HR_PAPER_DEEMED_RESIGNATION_V1,
  HR_PAPER_DEEMED_RESIGNATION_V2,
  HR_PAPER_DISCIPLINARY_WARNING_V1,
  HR_PAPER_DISCIPLINARY_PENALTY_V1,
  HR_PAPER_TRANSFER_DECISION_V1,
  HR_PAPER_SALARY_ADJUSTMENT_V1,
  HR_PAPER_SOCIAL_INSURANCE_AUTHORIZATION_V1,
  HR_PAPER_HEALTH_INSURANCE_AUTHORIZATION_V1,
  HR_PAPER_INSURANCE_PRINT_LETTER_V1,
  HR_PAPER_DOCUMENTS_RETURN_V1,
  HR_PAPER_EXPERIENCE_CERTIFICATE_V1,
  HR_PAPER_SALARY_LETTER_AR_V1,
  HR_PAPER_HANDOVER_RECORD_V1,
  HR_PAPER_EXIT_INTERVIEW_V1,
];

/** One paper by id, or null when the id is not one of ours. */
export function hrPaperById(id: string | null | undefined): HrPaperTemplate | null {
  if (!id) return null;
  return HR_PAPERS.find((paper) => paper.id === id) ?? null;
}
