/**
 * The Sato Pharma fixed-term employment contract — VERSION 4. THE CURRENT TEXT.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * DO NOT EDIT THE ARABIC IN THIS FILE.
 *
 * Supplied by the owner on 2026-09-04 as "الطرف الأول.docx", to replace version 3. This file was
 * DERIVED from that document rather than transcribed, and that was not convenience: Arabic pasted
 * out of a PDF comes back in visual order with the shaping baked in, so a hand-copied clause can look
 * right and be wrong. Every changed string was read from the .docx in LOGICAL order (from
 * `word/document.xml`, header and footer parts); every UNCHANGED string was carried over from
 * `contract-text-v3.ts` byte for byte rather than re-extracted, because copying text that is already
 * correct cannot introduce a difference whereas re-reading it can. The only edits are the
 * `{{TOKEN}}` markers below, each one substituted for a blank the paper version leaves for a pen.
 * Nothing was reworded, reordered or abridged.
 *
 * It is an operative instrument under Egyptian Labour Law 14/2025 and its executive regulation,
 * citing مادة (167), ministerial decree 187/2025, the data-protection law (151/2020) and the
 * e-signature law (15/2004). Its own مادة (13)(10) states that FOUR copies are signed — which is why
 * `systemContractDefaults.contractCopies` is 4 and not a preference.
 *
 * WHAT CHANGED FROM VERSION 3, AND WHAT DID NOT. THE THIRTEEN ARTICLES ARE UNTOUCHED — every clause
 * body, every article title and every article number is byte-identical to version 3, as are the
 * title, the subtitle, the preamble, the employee's identity grid and the running footer. What this
 * revision changes is the signing apparatus at the two ends of the document, in four places:
 *
 *   1. THE COMPANY RECITAL BREAKS IN THREE, not two. Not one registry fact changed; the owner moved
 *      the line break so the unified register and the tax card start a line of their own. It is
 *      reproduced as three strings because this layout prints one string per line.
 *   2. THE CLOSING NAMES THE DAY. Version 3 dated the instrument "تحريرًا في ( date )"; this one reads
 *      "تحريرًا في يوم ( day ) الموافق ( date )". That reintroduces `DAY_NAME` — a token version 1
 *      used, versions 2 and 3 did not, and `buildContractValues` has populated the whole time.
 *   3. THE SIGNATURE GRID LOSES ITS الصفة COLUMN. Version 3 gave the company a fourth signing field
 *      for the signatory's capacity, which left the grid ragged: four labelled fields for the company
 *      against three for the employee. Here both parties sign under the same three columns
 *      (الاسم · التوقيع والختم · التاريخ), and the capacity moves out of the grid into
 *      `signatoryNoteLinesAr`, printed beneath the company's row exactly where the source puts it.
 *   4. THE EMPLOYEE SIGNS SEPARATELY FOR HIS COPY. New here: `receiptAcknowledgmentAr`, a final ruled
 *      line under the signature table. It is NOT a duplicate of the closing paragraph's
 *      "وتسلّم نسخة منه وقت التوقيع" — that is a recital he makes inside the body of the contract,
 *      this is a second signature he gives against it. So it carries a pen rule and is never filled.
 *
 * No blank was dropped, so this version references a strict SUPERSET of version 3's tokens: the same
 * set, plus `DAY_NAME`.
 *
 * Changes to this text are the owner's lawyer's decision, never an engineering one. When it is itself
 * replaced, it does not get edited and it does not get deleted: a version 5 is added and this one
 * moves to `archived` in `template-registry.ts`, still whole and still printable, because people will
 * have signed it.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 */

import type { ContractTemplate } from "./contract-template";

const CONTRACT_TITLE_AR = "عقد عمل محدد المدة";
const CONTRACT_SUBTITLE_AR = "محرر طبقًا لقانون العمل المصري رقم 14 لسنة 2025 والقرارات المنفذة له";

/**
 * The parties: the company's block is fixed registry data (tokenised so it stays in step with
 * `system-settings`); the employee's is five rows of blanks Phoenix types from the employee record.
 *
 * THREE LINES, WHERE VERSION 3 HAD TWO, AND NOT ONE FACT MOVED BETWEEN THEM. In the source this is a
 * single justified paragraph carrying two explicit `<w:br/>` breaks, and the owner moved the first
 * break: version 3 ran the register, the register office, the unified register and the tax card
 * together on one line, and this one ends the line after the register office so the unified register
 * and the tax card begin their own. The `document` layout prints one zero-margin paragraph per
 * string, so a string here IS a line on his page — which is the whole reason a break lives in this
 * file at all rather than being left to wrapping.
 *
 * THE TRAILING " ·" ON THE SECOND LINE IS HIS, AND IT IS KEPT. In the source it is a mid-recital
 * separator that a line break happens to fall after, not a stray mark: the three lines read as one
 * flowing block because the paragraphs are zero-margin and consecutive. Deleting it would be an edit
 * to the paper, which is exactly what this file exists not to do.
 */
const FIRST_PARTY_HEADING_AR = "الطرف الأول — الشركة";
const FIRST_PARTY_LINES_AR = [
  "{{COMPANY_NAME}} — {{COMPANY_LEGAL_FORM}} · السجل التجاري رقم {{COMMERCIAL_REGISTER}} ({{COMMERCIAL_REGISTER_OFFICE}}).",
  "الرقم الموحد {{UNIFIED_REGISTER}} · البطاقة الضريبية رقم {{TAX_CARD}} ·",
  "المركز العام: {{COMPANY_HEAD_OFFICE_FULL}} · ولها فرع مقيّد بالسجل التجاري ب{{COMPANY_BRANCH_REGISTRY}} · ويمثلها في التوقيع السيد {{CONTRACT_SIGNATORY}}، {{CONTRACT_SIGNATORY_TITLE}}، المخوّل بالتوقيع عنها.",
] as const;

const SECOND_PARTY_HEADING_AR = "الطرف الثاني — العامل";
const SECOND_PARTY_LINES_AR = [
  "الاسم رباعيًا: ( {{EMPLOYEE_NAME}} )   الجنسية: ( {{NATIONALITY}} )",
  "المؤهل: ( {{QUALIFICATION}} )   الرقم القومي: ( {{NATIONAL_ID}} )",
  "تاريخ ومحل الميلاد: ( {{BIRTH_DATE}} — {{BIRTH_PLACE}} )   الرقم التأميني: ( {{INSURANCE_NUMBER}} )",
  "العنوان الدائم: ( {{ADDRESS}} )",
  "الهاتف: ( {{PHONE}} )      البريد الإلكتروني: ( {{EMAIL}} )",
] as const;

const CONTRACT_PREAMBLE_HEADING_AR = "تمهيد";

const CONTRACT_PREAMBLE_AR =
  "حيث أن الطرف الأول {{COMPANY_NAME}}، ومركزها الرئيسي بمدينة {{COMPANY_CITY}} المبيّن بصدر هذا العقد، وتمتد أنشطتها إلى مختلف أنحاء جمهورية مصر العربية من خلال عامليها الميدانيين التابعين لهذا المركز والعاملين داخل نطاقات جغرافية (Territories) يحددها الطرف الأول، ولها أن تستحدث فروعًا أو مواقع عمل أخرى. وحيث يرغب الطرف الأول في الاستعانة بخبرة الطرف الثاني الذي يقر بصحة بياناته وباطلاعه على طبيعة العمل ومقتضياته؛ فقد اتفق الطرفان على تحرير هذا العقد بالشروط التالية مع خضوعه لأحكام قانون العمل رقم 14 لسنة 2025 ولائحته التنفيذية والقرارات الوزارية الصادرة تنفيذًا له:";

/**
 * The thirteen articles, in order, verbatim.
 *
 * Version 3 TITLES every article, and only articles 2, 3 and 4 carry tokens — those are the three
 * the paper form leaves blank (the job and department; the term and start date; the salary in figures
 * and in words). Everything else is standing legal text.
 */
const CONTRACT_ARTICLES_AR: ReadonlyArray<{ number: string; titleAr: string; body: string }> = [
  {
    number: "مادة (1)",
    titleAr: "التمهيد واللوائح والملاحق",
    body: "يُعد التمهيد السابق، والوصف الوظيفي، ولائحة نظام العمل ولائحة الجزاءات المعتمدتين من الجهة الإدارية المختصة، ومحاضر استلام العهد — وقد أقر الطرف الثاني باطلاعه عليها وقبوله الالتزام بها دون تحفظ — جزءًا لا يتجزأ من هذا العقد، وتُعد مخالفتها إخلالًا بالتزام تعاقدي يستوجب المساءلة وفق جسامة المخالفة وأحكام لائحة الجزاءات والقانون. وللطرف الأول تعديلها وفقًا للقانون، ويلتزم الطرف الثاني بما يُخطر به منها. ويلتزم الطرف الثاني كذلك بخطط الحوافز والسياسات التشغيلية المعتمدة والمبلّغة إليه والسارية على الفترة محل التطبيق، ويجوز تعديلها مستقبلًا وفق مقتضيات العمل والقانون دون المساس بحق استُحق فعليًا عن فترة سابقة.",
  },
  {
    number: "مادة (2)",
    titleAr: "الوظيفة والتبعية الإدارية",
    body: "يقبل الطرف الأول تعيين الطرف الثاني في وظيفة ( {{JOB_TITLE}} ) بإدارة/قطاع ( {{DEPARTMENT}} )، ويتبع رئيسه المباشر وفق الهيكل التنظيمي المعتمد. وإذا كانت الوظيفة ضمن قوة البيع الميدانية، كانت التبعية متدرجة من المندوب الطبي إلى مدير المنطقة فمدير الإقليم فمدير عام المبيعات، ويلتزم بتنفيذ خطة الزيارات وتغطية العملاء المستهدفين على الخط والنطاق المسندين إليه. وإذا شغل درجة إشرافية التزم بقيادة فريقه ومراجعة واعتماد بياناتهم وطلباتهم ومصروفاتهم وإجازاتهم، ويكون مسؤولًا عن صحة ما يعتمده.",
  },
  {
    number: "مادة (3)",
    titleAr: "المدة وفترة الاختبار ومسوغات التعيين",
    body: "مدة هذا العقد ( {{DURATION}} ) تسري من ( {{START_DATE}} )، وتُحتسب الثلاثة أشهر الأولى تحت الاختبار، ولم يسبق وضع الطرف الثاني تحت الاختبار لدى الطرف الأول. وينتهي العقد بانقضاء مدته دون حاجة إلى تنبيه، ولا يُعد استمراره في أداء أي مهام بعدها تجديدًا بشروطه ذاتها ما لم يصدر تجديد كتابي موقّع، دون إخلال بالأحكام الآمرة. ولا يكون التعيين نهائيًا إلا باستيفاء مسوغاته واجتياز الكشف الطبي الابتدائي؛ فإذا ثبت تقديمه مستندات مزورة أو بيانات غير صحيحة عمدًا أثّرت في قرار التعيين، كان للطرف الأول اتخاذ الإجراءات التأديبية والقانونية المقررة.",
  },
  {
    number: "مادة (4)",
    titleAr: "الأجر والعلاوة الدورية والحوافز",
    body: "يستحق الطرف الثاني أجرًا شهريًا إجماليًا مقداره ( {{SALARY_FIGURES}} ) جنيه (( {{SALARY_WORDS}} ) فقط لا غير) يُصرف في نهاية كل شهر ميلادي بالتحويل البنكي، ويُحدد الأجر التأميني وفقًا لأحكام قانون التأمينات الاجتماعية. ولا يُخل وصف الأجر بأنه إجمالي بأي حق آمر مقرر قانونًا، ومنه العلاوة الدورية السنوية بما لا يقل عن (3%) من الأجر التأميني. ولا تُعد البدلات المصروفة مقابل نفقات عمل فعلية — كالانتقال والإقامة والهاتف — جزءًا من الأجر ما لم يقضِ القانون بغيره، وتزول البدلات المرتبطة بموقع أو بمهمة بزوال سببها دون أن يُعد ذلك تخفيضًا للأجر. أما الحوافز والعمولات فتخضع لخطة الاستحقاق المعتمدة ولا تُعد مستحقة إلا بتحقق شروطها واعتماد النتائج بعد الإقفال الشهري الذي تكون أرقامه المرجع الوحيد، ولا تُعد حقًا مكتسبًا ولا جزءًا من الأجر الثابت ولا يُنشئ صرفها في فترة حقًا في فترات لاحقة؛ فإذا تبيّن بعد الصرف أن المبيعات المحتسبة أُلغيت أو رُدّت أو عُدّلت أو أن بيانات الاحتساب غير صحيحة، أعاد الطرف الأول الاحتساب وخصم الفرق من المستحقات التالية في حدود القانون.",
  },
  {
    number: "مادة (5)",
    titleAr: "مقر العمل والنطاق الجغرافي والنقل",
    body: "مقر عمل الطرف الثاني هو المركز الرئيسي للطرف الأول بمدينة {{COMPANY_CITY}} المبيّن بصدر هذا العقد. فإذا كانت وظيفته ميدانية، أدّى مهامه داخل النطاق الجغرافي المسند إليه مع بقائه تابعًا إداريًا للمركز الرئيسي، ولا يُعد ذلك تغييرًا لمقر العمل المتفق عليه. ويحق للطرف الأول نقل الطرف الثاني إلى أي من مواقع عمله الحالية أو المستقبلية داخل جمهورية مصر العربية، أو تعديل النطاق المسند إليه أو إعادة توزيع العملاء، أو تكليفه بمهام أو زيارات أو دورات في أي محافظة، طالما كان ذلك في مصلحة العمل ووفق متطلباته ومقتضياته التشغيلية. ولا يترتب على النقل تخفيض أجره أو درجته الوظيفية أو المساس بحقوقه المكتسبة، ولا تكليفه بعمل يختلف جوهريًا عن المتفق عليه، ويتحمل الطرف الأول مصاريف الانتقال والإقامة وفقًا لسياساته المعتمدة.",
  },
  {
    number: "مادة (6)",
    titleAr: "ساعات العمل والإجازات والعمل الإضافي",
    body: "تكون ساعات العمل وأيام الراحة والإجازات وفقًا لأحكام قانون العمل رقم 14 لسنة 2025 وللائحة العمل الداخلية، فلا تزيد ساعات العمل الفعلية على ثماني ساعات يوميًا أو ثمان وأربعين ساعة أسبوعيًا، وتكون الإجازة السنوية خمسة عشر يومًا في السنة الأولى وواحدًا وعشرين يومًا من السنة الثانية وثلاثين يومًا بعد عشر سنوات خدمة أو بلوغ الخمسين. وتحدد الشركة مواعيدها وفق مقتضيات العمل، وإذا امتنع الطرف الثاني كتابةً عن القيام بها سقط حقه في المقابل النقدي عنها، ولا يُتمتع بأي إجازة إلا بموافقة كتابية مسبقة على النظام المعتمد. ولا يُكلَّف بعمل إضافي إلا بتكليف كتابي مسبق من رئيسه المباشر مسجّل على ذلك النظام ويلتزم بعدم أدائه من تلقاء نفسه، دون إخلال بحقه في أجر ما يؤديه فعلًا بتكليف. ولا يُعد وقت التنقل داخل نطاقه عملًا إضافيًا، وإنما هو من مقتضيات طبيعة وظيفته الميدانية.",
  },
  {
    number: "مادة (7)",
    titleAr: "الواجبات والسرية والملكية الفكرية وعدم المنافسة",
    body: "يلتزم الطرف الثاني بأداء واجبات وظيفته بالدقة والأمانة وتنفيذ تعليمات رؤسائه في حدود القانون والمحافظة على ممتلكات الشركة ولوائحها، وبالمحافظة على أسرار العمل خلال سريان العقد وبعد انتهائه وعدم إفشائها أو استغلالها أو الاحتفاظ بنسخة منها دون موافقة كتابية، ومنها بيانات العملاء والأطباء والصيدليات والموزّعين والأسعار والخصومات والخطط والمستهدفات وبيانات نظام (CRM)، وبعدم إفشاء بيانات أجور غيره من العاملين أو أي بيانات أجور يطّلع عليها بحكم عمله. ويمتنع عن طلب أو قبول هدايا أو عمولات بسبب عمله وعن الاقتراض من عملاء الشركة. وتؤول إلى الطرف الأول كافة الحقوق المالية على ما يُنشئه من تقارير أو مصنفات أو مواد دعائية أو قواعد بيانات لأغراض العمل أو باستخدام موارده، دون مقابل إضافي ومع بقاء الحقوق الأدبية للمؤلف. ويُحظر عليه، دون تفويض كتابي مسبق، الإدلاء بأي تصريح أو نشر أي محتوى بأي وسيلة — بما فيها وسائل التواصل الاجتماعي — يتعلق بالطرف الأول أو منتجاته أو عملائه أو عامليه، أو استخدام اسمه أو علاماته، وبعدم الإساءة إلى سمعته أثناء العقد وبعده، دون إخلال بحقه في الإبلاغ إلى الجهات المختصة. ويُحظر عليه كذلك، دون موافقة كتابية، العمل لدى جهة منافسة أو ممارسة نشاط يؤثر على تفرّغه؛ ونظرًا لاطلاعه على أسرار العمل وعلى العملاء يلتزم لمدة اثني عشر شهرًا من انتهاء علاقة العمل — في حدود النطاق الذي كان مسندًا إليه خلال آخر اثني عشر شهرًا من خدمته وفي حدود المنتجات التي كان مسؤولًا عن الترويج لها دون غيرها — بألا يستقطب أيًّا من العملاء الذين تعامل معهم فعليًا لحساب جهة منافسة ولا أيًّا من عاملي الطرف الأول. وقد رُوعي قصر هذا الشرط زمانًا ومكانًا ونوعًا بالقدر اللازم لحماية مصالح الطرف الأول المشروعة، ولا يمتد إلى منعه من العمل في المهنة ذاتها، ولا يسري إذا كان الإنهاء صادرًا من الطرف الأول دون خطأ منه.",
  },
  {
    number: "مادة (8)",
    titleAr: "الانتظام والغياب والتحقيق والجزاءات",
    body: "يلتزم الطرف الثاني بالانتظام وبإثبات حضوره وانصرافه وزياراته بالوسيلة المعتمدة، ويُعد الالتزام بخطة الزيارات ومعدلات التغطية والتكرار وبمواعيد التقارير من تعليمات العمل الملزمة، ويشكل الإخلال بها مخالفة تأديبية مستقلة عن نتائج المبيعات. وفي حالة الانقطاع بغير إذن أو عذر مقبول يُعد مستقيلًا إذا تغيب أكثر من عشرين يومًا غير متصلة خلال السنة أو أكثر من عشرة أيام متصلة، بعد إنذاره بكتاب موصى عليه بعلم الوصول على عنوانه المبيّن بصدر هذا العقد بعد اليوم العاشر في الحالة الأولى وبعد اليوم الخامس في الثانية. ولا يُوقَّع جزاء إلا بعد إخطاره كتابةً بما هو منسوب إليه وسماع دفاعه وإثبات ذلك في محضر يُودع ملفه، وللطرف الأول وقفه احتياطيًا بالضمانات المقررة قانونًا مع صرف أجره كاملًا. وتُوقَّع الجزاءات المقررة بلائحة الجزاءات وفق مبدأ التناسب بما لا يجاوز خصم أجر خمسة أيام في الشهر الواحد، ويجوز التشديد عند تكرار مخالفة من ذات النوع خلال سنة، ولا يجوز توقيع جزاء بعد مضي ثلاثين يومًا على انتهاء التحقيق. ويظل الفصل من اختصاص المحكمة العمالية المختصة وحدها.",
  },
  {
    number: "مادة (9)",
    titleAr: "الأداء ونزاهة البيانات والامتثال الدوائي",
    body: "تحدد الشركة مؤشرات الأداء والأهداف البيعية والتشغيلية، ويجوز تعديلها وفقًا لظروف السوق والخطط والنطاق والمنتجات دون أن يُعد ذلك تعديلًا للأجر، ويقر الطرف الثاني بأن تحقيق المستهدفات التزام جوهري. فإذا انخفض أداؤه عن المستوى المطلوب، وضعته الشركة على خطة مكتوبة لتحسين الأداء بمؤشرات قابلة للقياس ومهلة محددة ومتابعة موثقة؛ فإذا استمر الانخفاض بعد انقضائها عُدّ ذلك سببًا مشروعًا لعدم التجديد أو للإنهاء وفقًا للقانون. ويلتزم بإدخال جميع البيانات والتقارير والزيارات والمواقع والمصروفات على أنظمة الطرف الأول صحيحة وكاملة وفي مواعيدها؛ ويُعد إنشاء زيارات أو عملاء أو معاملات وهمية أو مضللة، أو استخدام حساب الغير، مخالفة جسيمة تستوجب المساءلة التأديبية والقانونية واسترداد ما صُرف بناءً عليها. كما يلتزم بالقوانين المنظِّمة للنشاط الدوائي وبسياسات مكافحة الرشوة وتعارض المصالح وقواعد صرف العينات والمواد الدعائية، وبالإبلاغ الفوري لإدارة التيقظ الدوائي عن أي شكوى جودة أو أثر جانبي يصل إلى علمه.",
  },
  {
    number: "مادة (10)",
    titleAr: "العهد والأصول والتدريب",
    body: "يكون الطرف الثاني مسؤولًا عن جميع الأموال والعهد والأجهزة والعينات والمستندات المسلَّمة إليه بسبب عمله، ويلتزم باستخدامها لأغراض العمل فقط وردّها فور الطلب أو انتهاء علاقة العمل بموجب محضر تسليم موقّع (إخلاء طرف)، مع حق الطرف الأول في خصم قيمة ما لم يُردّ منها من مستحقاته في الحدود المقررة قانونًا. ولا يُغني توقيع هذا العقد عن توقيعه على محاضر استلام مستقلة لكل ما يُسلَّم إليه، مبيّنًا بها الصنف والكمية والأرقام المسلسلة والتاريخ، وتُعد تلك المحاضر هي الدليل على واقعة الاستلام. ويُحظر بيع أو مبادلة أو التصرف في العينات الدوائية بأي صورة ويُعد ذلك خطأً جسيمًا. وإذا خُصصت له وسيلة انتقال عُدّت عهدة في ذمته ويُسأل عن المخالفات والغرامات الناشئة عن خطئه أو استعماله الشخصي غير المصرّح به. وإذا تحمّل الطرف الأول تكلفة تدريب استثنائي مرتفع التكلفة خارج التدريب المعتاد اللازم للوظيفة، التزم بمدة خدمة لاحقة يحددها إقرار تدريب موقّع منه، فإذا انتهت خدمته قبلها بخطئه أو باستقالته رد جزءًا من التكلفة الفعلية الموثّقة بنسبة المدة المتبقية. ويوافق كتابةً على خصم ما يثبت في ذمته من ذلك من مستحقاته في حدود القانون، مع حق الطرف الأول في اقتضاء الباقي بالطرق القانونية.",
  },
  {
    number: "مادة (11)",
    titleAr: "حماية البيانات والإثبات الإلكتروني",
    body: "يعالج الطرف الأول بيانات الطرف الثاني الشخصية والوظيفية اللازمة لتنفيذ هذا العقد والوفاء بالالتزامات القانونية والتأمينية، وذلك وفقًا للقانون رقم 151 لسنة 2020. ويقر الطرف الثاني بأن أجهزة الطرف الأول وحساباته وبريده وأنظمته — ومنها (CRM) وتطبيقات إثبات الزيارات — أدوات عمل مملوكة له وخاضعة للمراجعة، وبأن تسجيل بيانات الموقع الجغرافي (GPS) وتوقيت الزيارات يتم لأغراض إثبات أداء العمل وحساب المصروفات والحوافز والامتثال فقط، مع التزام الطرف الأول بتأمين البيانات وعدم إفشائها لغير المصرّح لهم؛ وفيما يجاوز ذلك من معالجة غير لازمة لتنفيذ العقد أو للوفاء بالتزام قانوني تُطلب موافقة كتابية مستقلة. ويجوز الاستناد إلى السجلات الإلكترونية الصادرة عن أنظمة الطرف الأول كقرائن وسجلات إثبات فيما بين الطرفين ما لم يثبت خلافها، وفقًا لقانون التوقيع الإلكتروني رقم 15 لسنة 2004، ويُسأل الطرف الثاني عن الاستخدام الصادر عن حسابه ما لم يبلّغ فورًا بفقد بيانات دخوله.",
  },
  {
    number: "مادة (12)",
    titleAr: "الاستقالة والإنهاء",
    body: "للطرف الثاني أن يستقيل بطلب كتابي، ولا يُعتد بالاستقالة إلا إذا قُدِّمت واعتُمدت أمام مكتب علاقات العمل المختص وفقًا للمادة (167) من قانون العمل رقم 14 لسنة 2025 وقرار وزير العمل رقم 187 لسنة 2025، ويحتفظ بحقه في الرجوع فيها خلال المدة المقررة ويستمر في عمله حتى يُبلَّغ بقرار قبولها. ولا يجوز لأي من الطرفين إنهاء هذا العقد قبل انتهاء مدته إلا لسبب مشروع. ويلتزم الطرف الثاني في جميع الأحوال بتسليم مهامه وعهدته وملفاته وبيانات عملائه لمن يحدده الطرف الأول بموجب محضر موقّع، وبعدم نسخ أو نقل أو إتلاف أي بيانات. وللطرف الأول، خلال مهلة الإخطار أو مدة التحقيق، إعفاؤه من مباشرة أعماله مع استمرار صرف أجره كاملًا واحتساب المدة ضمن خدمته، دون أن يُعد ذلك إنهاءً للعقد.",
  },
  {
    number: "مادة (13)",
    titleAr: "الإخطارات والاختصاص وأحكام عامة",
    body: "(1) تكون الإخطارات كتابية على العنوان أو البريد الإلكتروني المبيّنين بصدر هذا العقد، ويلتزم الطرف الثاني بإخطار إدارة شئون العاملين كتابةً بأي تغيير فيهما وإلا ظلت الإخطارات الموجّهة إليه على بياناته الثابتة به صحيحة ونافذة، ما لم يوجب القانون وسيلة أو شكلًا خاصًا لإخطار معيّن. (2) تختص المحكمة العمالية التي يقع محل العمل في دائرتها بالفصل في أي نزاع، مع مراعاة إجراءات التسوية التي يقررها القانون. (3) إذا بطل أي شرط ظلّ باقي الشروط نافذًا وحل محله حكم القانون. (4) لا يُعد سكوت الطرف الأول أو تأخره في استعمال أي حق تنازلًا عنه. (5) لا يكون أي تعديل صحيحًا إلا كتابةً وبتوقيع الطرفين. (6) تظل الالتزامات المقررة بالمواد (7) و(10) و(11)، وحق الطرف الأول في إعادة الاحتساب واسترداد ما صُرف بغير وجه حق وفقًا للمادتين (4) و(9)، قائمة بعد انتهاء العقد لأي سبب. (7) لا يجوز للطرف الثاني التنازل عن هذا العقد ولا إنابة الغير في أداء عمله. (8) لا يجوز تفسير أي حكم على نحو يُنقص من الحقوق الآمرة المقررة قانونًا، وكل شرط يخالف ذلك يقع باطلًا وحده. (9) يخضع هذا العقد لأحكام قانون العمل رقم 14 لسنة 2025 ولائحته التنفيذية والقرارات الصادرة تنفيذًا له دون غيرها، وما ورد به من إشارة إلى أي تشريع آخر إنما ينصرف إلى الموضوع المحدد الذي وردت بشأنه فقط. (10) حُرر هذا العقد بالعربية من أربع نسخ، تسلّم الطرف الثاني نسخة منها وتُودع نسخة لدى مكتب العمل ونسخة لدى هيئة التأمينات الاجتماعية. (11) يوقّع الطرفان أسفل كل صفحة من صفحات هذا العقد ومرفقاته، وتُعد صفحاته وحدة واحدة لا تتجزأ، ولا يُعتد بأي صفحة غير موقّعة أو مستبدلة.",
  },
];

/**
 * The closing block: the employee's acknowledgment sentence and the date-and-city line, exactly as
 * the source prints them together at the foot of the text, above the signatures. Version 2 carried
 * the acknowledgment inside its مادة (19); versions 3 and 4 state it here instead, so it lives in the
 * closing rather than in an article.
 *
 * THE DAY IS NAMED AGAIN, AND THAT IS THE ONE CHANGE. Version 3 dated the instrument
 * "تحريرًا في ( date )"; the source now reads "تحريرًا في يوم ...... الموافق ( ...... )", so the day
 * of the week is a blank in its own right and `DAY_NAME` comes back after two versions without it.
 * It is a real field and not decoration: Egyptian instruments are conventionally dated by weekday and
 * date together, and `arabicDayName` derives it from the same contract date the next blank prints —
 * so the two can never disagree, which is exactly what typing them by hand would risk.
 *
 * The day is left UNBRACKETED and the date and the city bracketed, because that is how the paper
 * punctuates them. THE CITY STAYS TOKENISED even though the source types القاهرة literally, for the
 * same reason it is tokenised in the preamble and in مادة (5): Phoenix knows the value, and one
 * source for it is what keeps the three mentions from drifting apart.
 */
const CONTRACT_CLOSING_AR =
  "ويقر الطرف الثاني بأنه قرأ هذا العقد كاملًا بلغته العربية وفهم بنوده ووقّعه بكامل إرادته الحرة، وتسلّم نسخة منه وقت التوقيع، وأنه اطّلع على لائحة العمل الداخلية ولائحة الجزاءات والوصف الوظيفي والسياسات المعتمدة وقبل الالتزام بها. تحريرًا في يوم {{DAY_NAME}} الموافق ( {{CONTRACT_DATE}} ) بمدينة ( {{COMPANY_CITY}} ).";

/**
 * The two signature columns, from the source's signature table.
 *
 * BOTH PARTIES NOW SIGN UNDER THE SAME THREE HEADINGS — الاسم · التوقيع والختم · التاريخ — and that
 * is the change from version 3, which gave the company a fourth field for the signatory's capacity.
 * The grid is built by taking the union of the labels across both columns, so a field only one party
 * carries becomes a column the other has to leave empty: version 3's الصفة therefore printed an empty
 * cell against the employee's row, asking a question of him that was never his to answer. The source
 * resolves it by moving the capacity out of the grid entirely — see `SIGNATORY_NOTE_LINES_AR`.
 *
 * Phoenix types the NAMES, because it knows them and a typed name is not a signature. It never types
 * on a line whose label is التوقيع والختم or التاريخ — those keep the paper form's own dotted rule,
 * because a printed signature is not one and a contract must bear the date it was actually signed.
 */
const CONTRACT_SIGNATURE_COLUMNS_AR = [
  {
    headingAr: "الطرف الأول — الشركة",
    fieldsAr: [
      "الاسم / {{CONTRACT_SIGNATORY}}",
      "التوقيع والختم / ..................................",
      "التاريخ / ..................................",
    ],
  },
  {
    headingAr: "الطرف الثاني — العامل",
    fieldsAr: [
      "الاسم / {{EMPLOYEE_NAME}}",
      "التوقيع والختم / ..................................",
      "التاريخ / ..................................",
    ],
  },
] as const;

/**
 * Who signs for the company, printed beneath its row in the signature grid's label column.
 *
 * WHY THIS IS NOT A SIGNATURE FIELD. In the source these two lines sit in the label column of the
 * table, under الطرف الأول — الشركة and above الطرف الثاني — العامل: they are an annotation naming the
 * human behind the company's row, not a fourth thing anybody signs. Version 3 modelled the capacity
 * as a signing field and the grid grew a column for it; stating it here instead keeps the grid square
 * and puts the text back where the paper has it.
 *
 * Both values are tokenised even though the source leaves a blank after each — `الدكتور/` with
 * nothing following it, and `الصفة :.` — because Phoenix knows both from `system-settings` and a
 * contract that prints its own signatory's name is not doing anything a pen needs to do. The name
 * token already carries the honorific, which is why the line does not repeat it.
 */
const SIGNATORY_NOTE_LINES_AR = [
  "يوقّع عن الطرف الأول: {{CONTRACT_SIGNATORY}}",
  "الصفة: {{CONTRACT_SIGNATORY_TITLE}}",
] as const;

/**
 * The employee's receipt of his own copy — the last line on the page, under the signature table.
 *
 * NEW IN VERSION 4, AND NOT A DUPLICATE OF THE CLOSING. The closing paragraph already has him recite
 * "وتسلّم نسخة منه وقت التوقيع" — but that is a statement inside the body of the contract, carried by
 * the same signature as everything else in it. This is a SECOND signature, given specifically against
 * receipt of the copy, which is what مادة (13)(10) requires him to be handed. Keeping them both is
 * the source's own arrangement and the useful one: the first says he was given a copy, the second is
 * his evidence that he was.
 *
 * NEVER TOKENISED. The rule after it is a pen rule — the whole point of the line is a wet signature,
 * so there is nothing here for Phoenix to fill. The run is U+0640 tatweel, not underscores, which
 * render at a different weight beside Arabic.
 */
const RECEIPT_ACKNOWLEDGMENT_AR =
  "إقرار الطرف الثاني باستلام نسخة من العقد: توقيع الطرف الثاني: ــــــــــــــــــــــــــــــــ";

/**
 * The running footer, from the source's footer part — the per-page signature line, verbatim.
 *
 * WHAT THE SOURCE FOOTER HOLDS AND WHAT SURVIVES. Two things: this signature line, and "صفحة N من M".
 * The signature line is reproduced because مادة (13)(11) has the parties initial every page, so it is
 * operative furniture rather than decoration, and a `<tfoot>` genuinely repeats it on every printed
 * page. THE PAGE NUMBER CANNOT BE REPRODUCED AT ALL: a printed page number needs `@page` margin
 * boxes, which Chrome does not implement, and there is no other mechanism — a browser cannot know
 * how many pages it is about to make. Do not add a hand-counted "من 3": the page count moves with the
 * length of a name.
 *
 * The two rules are runs of fourteen U+0640 tatweel, matching the source. They are pen rules, not
 * underscores — an underscore run renders as a different weight beside Arabic.
 */
const CONTRACT_FOOTER_AR = "توقيع الطرف الأول: ــــــــــــــ   توقيع الطرف الثاني: ــــــــــــــ";

export const CONTRACT_TEMPLATE_V4: ContractTemplate = {
  id: "contract-v4",
  version: 4,
  layout: "document",
  titleAr: CONTRACT_TITLE_AR,
  subtitleAr: CONTRACT_SUBTITLE_AR,
  openingAr: null,
  firstPartyHeadingAr: FIRST_PARTY_HEADING_AR,
  firstPartyLinesAr: FIRST_PARTY_LINES_AR,
  secondPartyHeadingAr: SECOND_PARTY_HEADING_AR,
  secondPartyLinesAr: SECOND_PARTY_LINES_AR,
  preambleHeadingAr: CONTRACT_PREAMBLE_HEADING_AR,
  preambleAr: CONTRACT_PREAMBLE_AR,
  articles: CONTRACT_ARTICLES_AR,
  closingAr: CONTRACT_CLOSING_AR,
  signatureColumns: CONTRACT_SIGNATURE_COLUMNS_AR.map((column) => ({
    headingAr: column.headingAr,
    fieldsAr: column.fieldsAr,
  })),
  signatoryNoteLinesAr: SIGNATORY_NOTE_LINES_AR,
  receiptAcknowledgmentAr: RECEIPT_ACKNOWLEDGMENT_AR,
  footerAr: CONTRACT_FOOTER_AR,
};
