// Recruitment / ATS — the Egypt-specific vocabulary the rule engine matches against.
//
// Kept apart from the rules that use it for one reason: this is DATA that changes when the world
// changes (a new private university opens, a district is renamed), while the rules around it are
// logic that changes when we find a bug. Mixing the two makes both harder to review.
//
// Everything here is matched case-insensitively against normalized text, and every English entry is
// paired with its Arabic form where a CV realistically writes it in Arabic — 7% of the careers
// inbox is Arabic-script, and those CVs are exactly the ones an English-only dictionary silently
// scores as "nothing found".

// ---------------------------------------------------------------------------
// Geography
// ---------------------------------------------------------------------------

/**
 * The 27 governorates, each with the spellings and Arabic forms a CV actually uses.
 *
 * The first entry of `aliases` is never the answer — `canonical` is. This is the owner's standing
 * "human-readable names, never raw codes" rule applied to geography: whatever the CV typed, the
 * candidate record gets one consistent governorate name.
 */
export const EGYPT_GOVERNORATES: ReadonlyArray<{ readonly canonical: string; readonly aliases: readonly string[] }> = [
  { aliases: ["cairo", "القاهرة", "el cairo", "kairo"], canonical: "Cairo" },
  { aliases: ["giza", "el giza", "al giza", "الجيزة", "الجيزه"], canonical: "Giza" },
  { aliases: ["alexandria", "alex", "الاسكندرية", "الإسكندرية"], canonical: "Alexandria" },
  { aliases: ["qalyubia", "qalubia", "qaliobia", "kalyoubia", "القليوبية"], canonical: "Qalyubia" },
  { aliases: ["sharqia", "sharqiya", "al sharqia", "el sharkia", "sharkia", "الشرقية"], canonical: "Sharqia" },
  { aliases: ["dakahlia", "el dakahlia", "daqahlia", "الدقهلية"], canonical: "Dakahlia" },
  { aliases: ["gharbia", "el gharbia", "الغربية"], canonical: "Gharbia" },
  { aliases: ["monufia", "menoufia", "menofia", "المنوفية"], canonical: "Monufia" },
  { aliases: ["beheira", "el beheira", "behera", "behira", "al buhayrah", "albuhayra", "البحيرة"], canonical: "Beheira" },
  { aliases: ["kafr el sheikh", "kafr elsheikh", "kafrelsheikh", "كفر الشيخ"], canonical: "Kafr El Sheikh" },
  { aliases: ["damietta", "dumyat", "دمياط"], canonical: "Damietta" },
  { aliases: ["port said", "portsaid", "بورسعيد", "بور سعيد"], canonical: "Port Said" },
  { aliases: ["ismailia", "ismailiya", "الإسماعيلية", "الاسماعيلية"], canonical: "Ismailia" },
  { aliases: ["suez", "السويس"], canonical: "Suez" },
  { aliases: ["fayoum", "faiyum", "el fayoum", "الفيوم"], canonical: "Fayoum" },
  { aliases: ["beni suef", "bani suef", "beni sweif", "بني سويف"], canonical: "Beni Suef" },
  { aliases: ["minya", "el minya", "menia", "المنيا"], canonical: "Minya" },
  { aliases: ["assiut", "asyut", "assuit", "أسيوط", "اسيوط"], canonical: "Assiut" },
  { aliases: ["sohag", "suhag", "سوهاج"], canonical: "Sohag" },
  { aliases: ["qena", "kena", "قنا"], canonical: "Qena" },
  { aliases: ["luxor", "الأقصر", "الاقصر"], canonical: "Luxor" },
  { aliases: ["aswan", "أسوان", "اسوان"], canonical: "Aswan" },
  { aliases: ["red sea", "hurghada", "البحر الأحمر", "الغردقة"], canonical: "Red Sea" },
  { aliases: ["matrouh", "marsa matrouh", "مطروح"], canonical: "Matrouh" },
  { aliases: ["new valley", "kharga", "الوادي الجديد"], canonical: "New Valley" },
  { aliases: ["north sinai", "arish", "شمال سيناء"], canonical: "North Sinai" },
  { aliases: ["south sinai", "sharm el sheikh", "جنوب سيناء"], canonical: "South Sinai" },
];

/**
 * District / new-city → governorate.
 *
 * This is the half that actually earns its keep. Egyptians overwhelmingly write the DISTRICT, not
 * the governorate — "Nasr City", "Maadi", "6th of October", "10th of Ramadan" — so a governorate
 * dictionary alone answers "unknown" on most CVs that plainly state where the person lives.
 *
 * The three that are routinely got wrong, and are pinned here deliberately:
 *   • 6th of October and Sheikh Zayed are GIZA, not Cairo.
 *   • 10th of Ramadan is SHARQIA, not Cairo.
 *   • Obour, Khanka, Shubra El Kheima and Banha are QALYUBIA, not Cairo.
 */
export const EGYPT_DISTRICTS: ReadonlyArray<{ readonly governorate: string; readonly aliases: readonly string[] }> = [
  {
    aliases: [
      "nasr city", "madinat nasr", "مدينة نصر", "heliopolis", "masr el gedida", "مصر الجديدة",
      "maadi", "المعادي", "zamalek", "الزمالك", "shubra", "شبرا", "ain shams", "عين شمس",
      "el marg", "المرج", "matareya", "المطرية", "helwan", "حلوان", "new cairo", "القاهرة الجديدة",
      "fifth settlement", "5th settlement", "التجمع الخامس", "el tagamoa", "rehab", "الرحاب",
      "madinaty", "مدينتي", "downtown cairo", "abbassia", "العباسية", "sayeda zeinab", "السيدة زينب",
      "el salam city", "مدينة السلام", "badr city", "مدينة بدر", "el nozha", "النزهة",
    ],
    governorate: "Cairo",
  },
  {
    aliases: [
      "6th of october", "6 october", "sixth of october", "6th october", "السادس من أكتوبر", "6 اكتوبر",
      "sheikh zayed", "الشيخ زايد", "dokki", "الدقي", "mohandessin", "المهندسين", "agouza", "العجوزة",
      "haram", "الهرم", "faisal", "فيصل", "imbaba", "امبابة", "إمبابة", "bulaq dakrour", "بولاق الدكرور",
      "el warraq", "الوراق", "kerdasa", "كرداسة", "badrashin", "البدرشين", "october city",
    ],
    governorate: "Giza",
  },
  {
    aliases: [
      "10th of ramadan", "tenth of ramadan", "10 ramadan", "العاشر من رمضان", "zagazig", "الزقازيق",
      "belbeis", "بلبيس", "abu hammad", "أبو حماد", "minya el qamh", "منيا القمح", "faqous", "فاقوس",
    ],
    governorate: "Sharqia",
  },
  {
    aliases: [
      "obour", "el obour", "العبور", "khanka", "el khanka", "الخانكة", "shubra el kheima",
      "shubra elkheima", "شبرا الخيمة", "banha", "benha", "بنها", "qalyub", "قليوب",
      "qaha", "قها", "kafr shukr", "كفر شكر",
    ],
    governorate: "Qalyubia",
  },
  {
    aliases: ["mansoura", "المنصورة", "mit ghamr", "ميت غمر", "talkha", "طلخا", "belqas", "بلقاس"],
    governorate: "Dakahlia",
  },
  {
    aliases: ["tanta", "طنطا", "mahalla", "el mahalla", "المحلة", "kafr el zayat", "كفر الزيات", "zefta", "زفتى"],
    governorate: "Gharbia",
  },
  {
    aliases: ["shebin el kom", "shibin el kom", "شبين الكوم", "quesna", "قويسنا", "ashmoun", "أشمون", "sadat city", "مدينة السادات"],
    governorate: "Monufia",
  },
  {
    aliases: ["damanhour", "damanhur", "دمنهور", "kafr el dawar", "كفر الدوار", "rashid", "رشيد", "edku", "إدكو"],
    governorate: "Beheira",
  },
  { aliases: ["borg el arab", "برج العرب", "agami", "العجمي", "montaza", "المنتزه", "smouha", "سموحة"], governorate: "Alexandria" },
  { aliases: ["new damietta", "دمياط الجديدة"], governorate: "Damietta" },
  { aliases: ["abu simbel", "أبو سمبل"], governorate: "Aswan" },
  { aliases: ["safaga", "سفاجا", "marsa alam", "مرسى علم", "el gouna", "الجونة"], governorate: "Red Sea" },
  { aliases: ["dahab", "دهب", "nuweiba", "نويبع", "taba", "طابا"], governorate: "South Sinai" },
];

// ---------------------------------------------------------------------------
// Education
// ---------------------------------------------------------------------------

/** Egyptian universities, public and private, as a CV spells them. */
export const EGYPT_UNIVERSITIES: readonly string[] = [
  "cairo university", "ain shams university", "alexandria university", "helwan university",
  "mansoura university", "zagazig university", "tanta university", "assiut university",
  "menoufia university", "monufia university", "benha university", "banha university",
  "suez canal university", "south valley university", "beni suef university", "fayoum university",
  "minya university", "sohag university", "kafrelsheikh university", "kafr el sheikh university",
  "damanhour university", "damietta university", "port said university", "suez university",
  "aswan university", "luxor university", "al azhar university", "azhar university",
  "the american university in cairo", "american university in cairo", "auc",
  "german university in cairo", "guc", "british university in egypt", "bue",
  "future university in egypt", "misr university for science and technology", "must",
  "misr international university", "miu", "modern sciences and arts university", "msa university",
  "october 6 university", "6th of october university", "pharos university", "sinai university",
  "nahda university", "delta university", "horus university", "badr university",
  "egyptian russian university", "canadian international college", "cic",
  "arab academy for science and technology", "aast", "nile university",
  "new giza university", "galala university", "alamein international university",
  "جامعة القاهرة", "جامعة عين شمس", "جامعة الإسكندرية", "جامعة حلوان", "جامعة المنصورة",
  "جامعة الزقازيق", "جامعة طنطا", "جامعة أسيوط", "جامعة المنوفية", "جامعة بنها", "جامعة الأزهر",
];

/**
 * Faculty names that unambiguously name a FACULTY, matched inside the education section only.
 *
 * Every entry says "faculty of" / "كلية" itself, so a hit can only mean the CV is naming its
 * faculty — see FACULTY_KEYWORDS_WEAK below for the bare-word alternative and why it is kept apart.
 */
export const FACULTY_KEYWORDS: readonly string[] = [
  "faculty of commerce", "faculty of law", "faculty of arts", "faculty of science",
  "faculty of engineering", "faculty of pharmacy", "faculty of medicine", "faculty of agriculture",
  "faculty of veterinary medicine", "faculty of education", "faculty of computers",
  "faculty of computer science", "faculty of business", "faculty of economics",
  "faculty of mass communication", "faculty of tourism", "faculty of nursing",
  "faculty of physical education", "faculty of applied arts", "faculty of fine arts",
  "faculty of social work", "faculty of archaeology", "faculty of dentistry",
  "كلية التجارة", "كلية الحقوق", "كلية الآداب", "كلية العلوم", "كلية الهندسة", "كلية الصيدلة",
  "كلية الطب", "كلية الزراعة", "كلية التربية", "كلية الحاسبات",
];

/**
 * The SAME faculties as FACULTY_KEYWORDS, indexed by the word a DEGREE TITLE uses rather than the
 * word a section HEADING uses — "Bachelor of Arts" and "Department: Archaeology" name a faculty
 * exactly as validly as a CV line that literally says "Faculty of Arts", but neither is a substring
 * of "faculty of arts" and so neither is reachable by FACULTY_KEYWORDS at all. A degree line that
 * names one of these was, until this dictionary existed, read for its LEVEL only ("Bachelor") with
 * the faculty silently dropped — see findFaculty's degree-qualifier and department-label passes.
 *
 * Deliberately the same closed set of disciplines FACULTY_KEYWORDS recognises, restated rather than
 * derived from it: a degree title's grammar ("of Arts") and a heading's grammar ("of Arts" too, but
 * inside "Faculty of Arts") happen to share a word here, but "Faculty of Veterinary Medicine" vs.
 * plain "Veterinary Medicine" and the Arabic pairs do not reduce to one string operation. Extending
 * one list is expected to mean extending both.
 *
 * Matched by LENGTH, longest alias first (see matchDegreeQualifier in education.ts) so "Computer
 * Science" or "Veterinary Medicine" is read whole before the generic "Science" hiding inside it —
 * the same reason FACULTY_KEYWORDS itself is sorted longest-first at its own call site.
 */
export const DEGREE_QUALIFIER_KEYWORDS: ReadonlyArray<{ readonly canonical: string; readonly aliases: readonly string[] }> = [
  { aliases: ["veterinary medicine", "veterinary"], canonical: "Faculty of Veterinary Medicine" },
  { aliases: ["computer science"], canonical: "Faculty of Computer Science" },
  { aliases: ["mass communication"], canonical: "Faculty of Mass Communication" },
  { aliases: ["physical education"], canonical: "Faculty of Physical Education" },
  { aliases: ["applied arts"], canonical: "Faculty of Applied Arts" },
  { aliases: ["fine arts"], canonical: "Faculty of Fine Arts" },
  { aliases: ["social work"], canonical: "Faculty of Social Work" },
  { aliases: ["business administration"], canonical: "Faculty of Business" },
  { aliases: ["dental medicine", "dentistry"], canonical: "Faculty of Dentistry" },
  { aliases: ["archaeology"], canonical: "Faculty of Archaeology" },
  { aliases: ["medicine"], canonical: "Faculty of Medicine" },
  { aliases: ["pharmacy"], canonical: "Faculty of Pharmacy" },
  { aliases: ["engineering"], canonical: "Faculty of Engineering" },
  { aliases: ["agriculture"], canonical: "Faculty of Agriculture" },
  { aliases: ["education"], canonical: "Faculty of Education" },
  { aliases: ["economics"], canonical: "Faculty of Economics" },
  { aliases: ["tourism"], canonical: "Faculty of Tourism" },
  { aliases: ["nursing"], canonical: "Faculty of Nursing" },
  { aliases: ["computers", "computing"], canonical: "Faculty of Computers" },
  { aliases: ["science"], canonical: "Faculty of Science" },
  { aliases: ["commerce"], canonical: "Faculty of Commerce" },
  { aliases: ["law"], canonical: "Faculty of Law" },
  { aliases: ["arts"], canonical: "Faculty of Arts" },
];

/**
 * Bare single/short words that MIGHT name a faculty ("Pharmacy", "Commerce", "Law"), but are
 * ordinary English words that turn up in an education section for reasons that have nothing to do
 * with the candidate's own faculty — a training rotation, a previous employer's name, a course
 * title. Matched the same way as FACULTY_KEYWORDS but kept in a SEPARATE, weaker-confidence list on
 * purpose.
 *
 * Real production example (2026-09): a candidate whose CV plainly stated "Faculty of Agriculture"
 * came back with faculty = "Pharmacy" — the word "pharmacy" appeared somewhere else in her education
 * section, matched this list, and (wrongly) outranked nothing, because at the time this list was not
 * separate and every hit here was trusted exactly as much as "Faculty of Agriculture" would have
 * been. See findFaculty in education.ts for how this list is now used.
 */
export const FACULTY_KEYWORDS_WEAK: readonly string[] = [
  "business administration", "commerce", "law", "pharmacy", "engineering", "veterinary",
];

/** Degree levels, most specific first so "Bachelor of Commerce" is not read as a bare "Bachelor". */
export const DEGREE_KEYWORDS: ReadonlyArray<{ readonly canonical: string; readonly aliases: readonly string[] }> = [
  { aliases: ["phd", "ph.d", "doctorate", "doctor of philosophy", "دكتوراه"], canonical: "PhD" },
  { aliases: ["master's degree", "masters degree", "master of", "msc", "m.sc", "mba", "master", "ماجستير"], canonical: "Master" },
  { aliases: ["postgraduate diploma", "post graduate diploma", "professional diploma", "diploma", "دبلوم"], canonical: "Diploma" },
  {
    aliases: ["bachelor's degree", "bachelors degree", "bachelor of", "bsc", "b.sc", "bachelor", "licence", "ليسانس", "بكالوريوس"],
    canonical: "Bachelor",
  },
];

/** Graduation grades as Egyptian CVs write them. */
export const GRADE_KEYWORDS: ReadonlyArray<{ readonly canonical: string; readonly aliases: readonly string[] }> = [
  { aliases: ["excellent with honou?r", "excellent with honors", "امتياز مع مرتبة الشرف"], canonical: "Excellent with Honours" },
  { aliases: ["very good", "جيد جدا", "جيد جداً"], canonical: "Very Good" },
  { aliases: ["excellent", "امتياز"], canonical: "Excellent" },
  { aliases: ["good", "جيد"], canonical: "Good" },
  { aliases: ["pass", "acceptable", "مقبول"], canonical: "Pass" },
];

// ---------------------------------------------------------------------------
// Personal facts
// ---------------------------------------------------------------------------

export const MARITAL_STATUS_KEYWORDS: ReadonlyArray<{ readonly canonical: string; readonly aliases: readonly string[] }> = [
  { aliases: ["single", "unmarried", "أعزب", "اعزب", "عزباء"], canonical: "Single" },
  { aliases: ["married", "متزوج", "متزوجة"], canonical: "Married" },
  { aliases: ["divorced", "مطلق", "مطلقة"], canonical: "Divorced" },
  { aliases: ["widowed", "أرمل", "ارمل", "أرملة"], canonical: "Widowed" },
];

/**
 * Military status — men only, and a hard filter in Egyptian hiring.
 *
 * "Exempted" and "Postponed" mean very different things to a hiring manager (one is settled
 * forever, the other expires), so they are never collapsed together.
 */
export const MILITARY_STATUS_KEYWORDS: ReadonlyArray<{ readonly canonical: string; readonly aliases: readonly string[] }> = [
  { aliases: ["permanent exemption", "final exemption", "exempted", "exemption", "exempt", "معفى", "إعفاء نهائي", "اعفاء"], canonical: "Exempted" },
  // "Complete" (not "completed") is how several CVs in the corpus write it — matched literally
  // rather than by stemming, so the dictionary stays reviewable.
  { aliases: ["completed", "complete", "performed", "finished", "served", "done", "أدى الخدمة", "تم أداء الخدمة", "انهى الخدمة"], canonical: "Completed" },
  { aliases: ["postponed", "deferred", "temporary postponement", "مؤجل", "تأجيل"], canonical: "Postponed" },
  { aliases: ["not applicable", "n/a - female", "لا ينطبق"], canonical: "Not applicable" },
];

export const NATIONALITY_KEYWORDS: ReadonlyArray<{ readonly canonical: string; readonly aliases: readonly string[] }> = [
  { aliases: ["egyptian", "egypt", "مصري", "مصرية", "مصر"], canonical: "Egyptian" },
  { aliases: ["saudi", "السعودية", "سعودي"], canonical: "Saudi" },
  { aliases: ["jordanian", "أردني"], canonical: "Jordanian" },
  { aliases: ["syrian", "سوري"], canonical: "Syrian" },
  { aliases: ["sudanese", "سوداني"], canonical: "Sudanese" },
  { aliases: ["palestinian", "فلسطيني"], canonical: "Palestinian" },
];

/** Languages, with the proficiency words that sit beside them. */
export const LANGUAGE_KEYWORDS: ReadonlyArray<{ readonly canonical: string; readonly aliases: readonly string[] }> = [
  { aliases: ["arabic", "العربية", "عربي"], canonical: "Arabic" },
  { aliases: ["english", "الإنجليزية", "انجليزي", "الانجليزية"], canonical: "English" },
  { aliases: ["french", "الفرنسية", "فرنسي"], canonical: "French" },
  { aliases: ["german", "الألمانية", "الماني"], canonical: "German" },
  { aliases: ["italian", "الإيطالية"], canonical: "Italian" },
  { aliases: ["spanish", "الإسبانية"], canonical: "Spanish" },
  { aliases: ["chinese", "mandarin", "الصينية"], canonical: "Chinese" },
  { aliases: ["russian", "الروسية"], canonical: "Russian" },
  { aliases: ["turkish", "التركية"], canonical: "Turkish" },
];

export const LANGUAGE_PROFICIENCY: ReadonlyArray<{ readonly canonical: string; readonly aliases: readonly string[] }> = [
  { aliases: ["native", "mother tongue", "mother language", "اللغة الأم", "لغة الأم"], canonical: "Native" },
  { aliases: ["fluent", "proficient", "full professional", "طلاقة", "بطلاقة"], canonical: "Fluent" },
  { aliases: ["very good", "upper intermediate", "advanced", "جيد جدا"], canonical: "Very Good" },
  { aliases: ["intermediate", "conversational", "متوسط"], canonical: "Intermediate" },
  { aliases: ["good", "working knowledge", "جيد"], canonical: "Good" },
  { aliases: ["basic", "beginner", "elementary", "fair", "مبتدئ", "أساسي"], canonical: "Basic" },
];

// ---------------------------------------------------------------------------
// Work
// ---------------------------------------------------------------------------

/**
 * Words that mark a line as a JOB TITLE rather than a duty or an employer.
 *
 * Used as a scorer, never as a gate: a title line usually contains one of these, but a CV is free
 * to invent a title we have never seen, and the date-range structure is what actually anchors a
 * work entry.
 */
export const JOB_TITLE_KEYWORDS: readonly string[] = [
  "specialist", "manager", "supervisor", "coordinator", "officer", "assistant", "administrator",
  "executive", "director", "head of", "lead", "senior", "junior", "consultant", "analyst",
  "generalist", "representative", "rep", "agent", "engineer", "accountant", "auditor",
  "recruiter", "trainer", "instructor", "intern", "trainee", "clerk", "secretary", "advisor",
  "partner", "associate", "team leader", "chief", "president", "founder", "owner",
  "أخصائي", "اخصائي", "مدير", "مشرف", "منسق", "مسؤول", "مساعد", "محاسب", "مندوب", "رئيس",
];

/** Titles that specifically mean "this person has carried a medical/pharma sales bag". */
export const MEDICAL_REP_TITLE_KEYWORDS: readonly string[] = [
  "medical representative", "medical rep", "medical sales representative", "pharmaceutical representative",
  "pharma rep", "medical delegate", "product specialist", "medical sales", "district manager",
  "مندوب دعاية", "مندوب طبي", "مندوب دعائي",
];

/**
 * Employers that mark pharmaceutical-industry experience.
 *
 * Deliberately not exhaustive — it cannot be. It exists to RAISE confidence when it hits, never to
 * conclude "no pharma experience" when it misses; that judgement stays with a human (or, later,
 * with the AI enhancement pass).
 */
export const PHARMA_EMPLOYER_KEYWORDS: readonly string[] = [
  "pharma", "pharmaceutical", "pharmaceuticals", "drug", "medicine", "medical", "healthcare",
  "sato", "eva pharma", "eipico", "amoun", "hikma", "novartis", "pfizer", "sanofi", "gsk",
  "glaxosmithkline", "astrazeneca", "roche", "bayer", "abbott", "servier", "menarini",
  "sandoz", "mash premiere", "marcyrl", "chemipharm", "global napi", "sedico", "adwia",
  "multipharma", "pharco", "borg pharmaceutical", "delta pharma", "andalous", "aventis",
  "صيدلة", "أدوية", "دوائية",
];

/**
 * Words marking a work-history entry as an INTERNSHIP, student rotation, or training placement —
 * time that does not count toward years of professional experience.
 *
 * Deliberately phrase-level for "training" rather than the bare word: a real job title like
 * "Training Manager" or "Training Coordinator" must not be caught by this list, only a CV's own
 * description of having BEEN trained (a vacation/summer/clinical/practical placement).
 */
export const INTERNSHIP_KEYWORDS: readonly string[] = [
  "internship", "intern", "trainee", "traineeship", "extern", "externship",
  "vacation training", "summer training", "clinical training", "practical training",
  "on-the-job training", "apprentice", "apprenticeship",
  "تدريب صيفي", "تدريب عملي", "متدرب",
];

/** Words whose presence makes a line a RESPONSIBILITY bullet rather than a heading or a title. */
export const RESPONSIBILITY_VERBS: readonly string[] = [
  "manage", "managed", "managing", "responsible", "handle", "handled", "handling",
  "oversee", "oversaw", "coordinate", "coordinated", "prepare", "prepared", "conduct", "conducted",
  "develop", "developed", "implement", "implemented", "maintain", "maintained", "support",
  "supported", "assist", "assisted", "ensure", "ensured", "review", "reviewed", "process",
  "processed", "lead", "led", "organize", "organized", "monitor", "monitored", "track", "tracked",
  "administer", "administered", "liaise", "report", "reporting", "participate", "collaborate",
];
