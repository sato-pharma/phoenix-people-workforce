/**
 * Every word on the joining form, in English and Arabic (owner, 2026-10-08: "make him able to change
 * language between English and Arabic").
 *
 * THE ARABIC NEVER ASSUMES THE CANDIDATE'S GENDER. Arabic commands are gendered — "اكتب" asks a man,
 * "اكتبي" a woman — and the form does not know which until the national ID is typed. So every
 * instruction is "يُرجى" with a verbal noun ("يُرجى كتابة …"), and the possessive suffix is written
 * without vowel marks, where "ك" reads for either.
 *
 * WHAT IS NEVER TRANSLATED: the values. Job titles, departments, lines, areas, names and the Sato
 * email are shown as the Employee Master holds them, and every <option value> stays the English (or,
 * for the governorate, the Arabic) value the record stores — only the label a person reads changes.
 *
 * THE MESSAGES THE CHECK AND THE SERVER SEND ARE ENGLISH, translated here by their exact text
 * (`translateMessage`). `tests/offer-joining-form.test.ts` reads every one of them out of the source
 * and refuses a message with no Arabic, so a new or reworded message cannot ship English-only.
 */

export type JoiningLang = "en" | "ar";

export const JOINING_LANG_STORAGE_KEY = "sato-joining-form-lang";

const en = {
  accept: {
    button: "Submit and accept the offer",
    busy: "Submitting your acceptance",
    caption: "Sato Pharma's offer to you",
    confirm: "By pressing Submit you accept this offer of employment and confirm that the details above are correct.",
    done: "Everything is filled in. To decline instead, reply to the offer email.",
    remaining: (count: number) => `${count} of your details still to complete. To decline instead, reply to the offer email.`,
    title: "Accept your offer",
  },
  band: {
    closed: "Closed",
    eyebrow: "Offer of employment",
    humanResources: "Human Resources",
    joiningForm: "Joining form",
    received: "Received",
    subtitle: "Check your position and package, complete your personal details, and press Submit to accept the offer.",
    welcome: (name: string) => `Welcome to Sato Pharma, ${name}`,
  },
  card: {
    contract: "Contract",
    hrId: "HR ID",
    netMonthly: "Net monthly",
    position: "Position",
    record: "Your record",
    startDate: "Start date",
    yourOffer: "Your offer",
  },
  details: {
    address: "Residence address",
    addressPlaceholder: "Building, street, landmark",
    area: "Residence area",
    areaChoose: "Choose your area",
    areaNotListed: "My area is not listed",
    areaOther: "Your area",
    areaPlaceholder: "District or neighbourhood",
    birthDate: "Date of birth",
    choose: "Choose",
    city: "Residence city",
    cityChoose: "Choose your city",
    education: "Faculty",
    educationChoose: "Choose your faculty",
    educationOther: "Your faculty or degree",
    fromId: "From your ID",
    fullName: "Full name",
    fullNameHint: "In English, as written on your national ID card.",
    fullNameAr: "Full name in Arabic",
    fullNameArHint: "In Arabic letters, exactly as written on your national ID card — your name, your father's and your grandfather's at least.",
    gender: "Gender",
    groups: { contact: "Contact", education: "Education", identity: "Identity", photo: "Photo", photos: "National ID photos", residence: "Residence" },
    mobile: "Mobile number",
    nationalId: "National ID number",
    nationalIdHint: "14 digits. Your date of birth and gender are filled in from it.",
    nationalIdPlaceholder: "14 digits",
    note: "For your employee record — only you can fill these in.",
    personalEmail: "Private email",
    recognised: (date: string, gender: string) => `Recognised — born ${date}, ${gender}.`,
    title: "Your details",
  },
  done: {
    eyebrow: "Offer accepted",
    heading: "Thank you — you have accepted the offer.",
    next: "What happens next",
    nextContact: (date: string) => `Our HR team will contact you before your first day on ${date}.`,
    nextEdit: "If anything in your details needs changing, reply to the offer email.",
    nextEmail: (email: string) => `Your Sato email, ${email}, is being set up for your first day.`,
    nextEmailPending: (reason: string | null) => `HR will send you your Sato email${reason ? ` — ${reason}` : "."}`,
    recorded: "Acceptance recorded",
    subtitle: "Your acceptance is recorded and your employee record is ready. Here is everything you need before your first day.",
    yourHrId: "Your HR ID",
    yourRecord: "Your employee record",
    yourSatoEmail: "Your Sato email",
  },
  failure: {
    attention: "A few details still need your attention — they are marked in red above.",
    network: "We could not reach the server. Please check your connection and try again.",
    server: "Please check the highlighted fields and try again.",
  },
  footer: {
    columns: [
      { body: "This offer was prepared for you by Sato Pharma's Human Resources team.", title: "Human Resources" },
      { body: "If you have any question about your offer, reply to the offer email and our team will answer.", title: "Questions" },
      { body: "This page is private to you. The link carries your offer, so please keep it to yourself.", title: "Privacy" },
    ],
    rights: (year: number) => `© ${year} Sato Pharma · Human Resources`,
  },
  intro: {
    accept: "Pressing Submit is your acceptance of the offer.",
    lead: "Please check your position and package, then complete your personal details.",
    tail: "If you wish to decline, simply reply to the offer email.",
  },
  language: { label: "العربية", switchTo: "Switch to Arabic" },
  notice: { whatToDo: "What to do" },
  package: {
    base: "Base salary",
    basic: "Basic salary",
    component: "Component",
    extraCostOfLiving: "Extra cost of living",
    fuel: "Fuel allowance",
    gross: "Gross salary",
    monthly: "Monthly",
    net: "Net salary",
    netNote: "Paid to you each month",
    note: "Monthly, in Egyptian pounds.",
    title: "Your package",
  },
  facePhoto: {
    hint: "A clear, recent photo of your face on a plain background. It becomes your picture in Phoenix.",
    label: "Photo",
    optional: "Optional",
  },
  pending: "To be confirmed by HR",
  photos: {
    back: "Back of the card",
    blocked: "If your phone says it cannot select media, allow Chrome to use Photos in the phone's Settings, under Apps, then Chrome, then Permissions. Or use one of these instead.",
    camera: "Take a photo with the camera",
    choose: "Take or choose a photo",
    files: "Choose from files",
    front: "Front of the card",
    hint: "A clear photo of each side, with all four corners and every word showing.",
    preparing: "Preparing the photo",
    replace: "Replace",
    trouble: "Trouble choosing a photo?",
  },
  position: {
    accounts: "Your accounts",
    area: "Area",
    confirmedOnSubmit: "Confirmed when you submit",
    contractType: "Contract type",
    createdOnSubmit: "Created when you submit",
    department: "Department",
    hireDate: "Hiring date",
    hrId: "HR ID",
    jobPosition: "Job position",
    line: "Line",
    manager: "Manager",
    managerHrId: (hrId: string) => `HR ID ${hrId}`,
    note: "Set by your offer and your seat in the organisation.",
    region: "Region",
    role: "Role",
    satoEmail: "Sato email",
    satoEmailPending: (reason: string | null) => `HR will send it to you${reason ? ` — ${reason}` : ""}`,
    title: "Your position",
    whereYouWork: "Where you work",
  },
  rail: {
    acceptance: "Submit is your acceptance",
    afterDetails: "After your details",
    complete: (done: number, total: number) => `${done} of ${total} complete`,
    count: (done: number, total: number) => `${done} of ${total}`,
    heading: "Your joining form",
    note: "Pressing Submit is your acceptance of the offer. To decline, reply to the offer email.",
    ready: "Ready to submit",
    setByOffer: "Set by your offer",
    yourDetails: "Your details",
  },
  step: (index: string) => `Step ${index}`,
};

export type JoiningCopy = typeof en;

const ar: JoiningCopy = {
  accept: {
    button: "إرسال وقبول العرض",
    busy: "جارٍ إرسال القبول",
    caption: "عرض ساتو فارما لك",
    confirm: "بالضغط على «إرسال» يتم قبول عرض العمل هذا وتأكيد صحة البيانات المذكورة أعلاه.",
    done: "اكتملت كل البيانات. وللاعتذار عن العرض يُرجى الرد على بريد العرض.",
    remaining: (count: number) => `متبقٍّ ${count} من البيانات لاستكمالها. وللاعتذار عن العرض يُرجى الرد على بريد العرض.`,
    title: "قبول العرض",
  },
  band: {
    closed: "مغلق",
    eyebrow: "عرض عمل",
    humanResources: "الموارد البشرية",
    joiningForm: "نموذج الالتحاق",
    received: "تم الاستلام",
    subtitle: "يُرجى مراجعة الوظيفة والراتب، واستكمال البيانات الشخصية، ثم الضغط على «إرسال» لقبول العرض.",
    welcome: (name: string) => `مرحباً بك في ساتو فارما، ${name}`,
  },
  card: {
    contract: "نوع العقد",
    hrId: "الرقم الوظيفي",
    netMonthly: "صافي الراتب الشهري",
    position: "الوظيفة",
    record: "ملفك الوظيفي",
    startDate: "تاريخ بدء العمل",
    yourOffer: "عرضك",
  },
  details: {
    address: "عنوان السكن",
    addressPlaceholder: "رقم العقار، الشارع، علامة مميزة",
    area: "منطقة السكن",
    areaChoose: "اختيار المنطقة",
    areaNotListed: "منطقتي غير موجودة في القائمة",
    areaOther: "المنطقة",
    areaPlaceholder: "الحي أو المنطقة",
    birthDate: "تاريخ الميلاد",
    choose: "يُرجى الاختيار",
    city: "محافظة السكن",
    cityChoose: "اختيار المحافظة",
    education: "الكلية",
    educationChoose: "اختيار الكلية",
    educationOther: "الكلية أو المؤهل",
    fromId: "من بطاقتك",
    fullName: "الاسم الكامل",
    fullNameHint: "بالإنجليزية، كما هو مكتوب في بطاقة الرقم القومي.",
    fullNameAr: "الاسم الكامل بالعربية",
    fullNameArHint: "بالحروف العربية، كما هو مكتوب في بطاقة الرقم القومي تماماً — الاسم واسم الأب والجد على الأقل.",
    gender: "النوع",
    groups: { contact: "التواصل", education: "المؤهل الدراسي", identity: "الهوية", photo: "الصورة", photos: "صور بطاقة الرقم القومي", residence: "محل الإقامة" },
    mobile: "رقم الموبايل",
    nationalId: "الرقم القومي",
    nationalIdHint: "14 رقماً، ويُستخرج منه تاريخ الميلاد والنوع تلقائياً.",
    nationalIdPlaceholder: "14 رقماً",
    note: "لملفك الوظيفي — لا يملؤها أحد غيرك.",
    personalEmail: "البريد الإلكتروني الشخصي",
    recognised: (date: string, gender: string) => `تم التعرّف عليه — تاريخ الميلاد ${date}، ${gender}.`,
    title: "البيانات الشخصية",
  },
  done: {
    eyebrow: "تم قبول العرض",
    heading: "شكراً لك — تم قبول العرض.",
    next: "الخطوات التالية",
    nextContact: (date: string) => `سيتواصل معك فريق الموارد البشرية قبل يوم عملك الأول في ${date}.`,
    nextEdit: "إذا احتاج أي من بياناتك إلى تعديل، يُرجى الرد على بريد العرض.",
    nextEmail: (email: string) => `يجري إعداد بريدك في ساتو، ${email}، ليكون جاهزاً في يوم عملك الأول.`,
    nextEmailPending: (reason: string | null) => `سترسل إليك الموارد البشرية بريدك في ساتو${reason ? ` — ${reason}` : "."}`,
    recorded: "تم تسجيل القبول",
    subtitle: "تم تسجيل قبولك وأصبح ملفك الوظيفي جاهزاً، وفيما يلي كل ما يلزم قبل يوم العمل الأول.",
    yourHrId: "رقمك الوظيفي",
    yourRecord: "ملفك الوظيفي",
    yourSatoEmail: "بريدك في ساتو",
  },
  failure: {
    attention: "بعض البيانات تحتاج إلى مراجعة — وهي مميزة باللون الأحمر أعلاه.",
    network: "تعذّر الاتصال بالخادم. يُرجى التحقق من الاتصال بالإنترنت والمحاولة مرة أخرى.",
    server: "يُرجى مراجعة الحقول المميزة والمحاولة مرة أخرى.",
  },
  footer: {
    columns: [
      { body: "أعدّ فريق الموارد البشرية في ساتو فارما هذا العرض لك.", title: "الموارد البشرية" },
      { body: "لأي استفسار عن العرض، يُرجى الرد على بريد العرض الإلكتروني وسيجيب فريقنا.", title: "استفسارات" },
      { body: "هذه الصفحة خاصة بك. الرابط يحمل بيانات عرضك، لذا يُرجى عدم مشاركته.", title: "الخصوصية" },
    ],
    rights: (year: number) => `© ${year} ساتو فارما · الموارد البشرية`,
  },
  intro: {
    accept: "الضغط على «إرسال» يعني قبول العرض.",
    lead: "يُرجى مراجعة الوظيفة والراتب، ثم استكمال البيانات الشخصية.",
    tail: "وللاعتذار عن العرض يكفي الرد على بريد العرض الإلكتروني.",
  },
  language: { label: "English", switchTo: "التبديل إلى الإنجليزية" },
  notice: { whatToDo: "الخطوة التالية" },
  package: {
    base: "راتب الأساس",
    basic: "الأجر الأساسي",
    component: "البند",
    extraCostOfLiving: "بدل غلاء المعيشة",
    fuel: "بدل الوقود",
    gross: "إجمالي الراتب",
    monthly: "شهرياً",
    net: "صافي الراتب",
    netNote: "يُصرف لك كل شهر",
    note: "شهرياً، بالجنيه المصري.",
    title: "الراتب والمزايا",
  },
  facePhoto: {
    hint: "صورة حديثة وواضحة للوجه على خلفية سادة، وستكون صورة الملف على Phoenix.",
    label: "الصورة",
    optional: "اختياري",
  },
  pending: "تؤكده الموارد البشرية",
  photos: {
    back: "ظهر البطاقة",
    blocked: "إذا ظهرت رسالة بتعذّر اختيار الوسائط، يُرجى السماح لمتصفح Chrome باستخدام الصور من إعدادات الهاتف، ثم التطبيقات، ثم Chrome، ثم الأذونات. أو استخدام إحدى الطريقتين التاليتين.",
    camera: "التقاط صورة بالكاميرا",
    choose: "التقاط صورة أو اختيارها",
    files: "اختيار من الملفات",
    front: "وجه البطاقة",
    hint: "صورة واضحة لكل وجه، تظهر فيها الأركان الأربعة وكل الكتابة.",
    preparing: "جارٍ تجهيز الصورة",
    replace: "تغيير",
    trouble: "هل تعذّر اختيار الصورة؟",
  },
  position: {
    accounts: "حساباتك",
    area: "المنطقة",
    confirmedOnSubmit: "يُعتمد عند الإرسال",
    contractType: "نوع العقد",
    createdOnSubmit: "يُنشأ عند الإرسال",
    department: "الإدارة",
    hireDate: "تاريخ التعيين",
    hrId: "الرقم الوظيفي",
    jobPosition: "الوظيفة",
    line: "الخط",
    manager: "المدير المباشر",
    managerHrId: (hrId: string) => `الرقم الوظيفي ${hrId}`,
    note: "محددة وفق العرض وموقعك في الهيكل التنظيمي.",
    region: "الإقليم",
    role: "الدور الوظيفي",
    satoEmail: "بريد ساتو الإلكتروني",
    satoEmailPending: (reason: string | null) => `سترسله الموارد البشرية إليك${reason ? ` — ${reason}` : ""}`,
    title: "الوظيفة",
    whereYouWork: "مكان العمل",
  },
  rail: {
    acceptance: "الإرسال يعني قبول العرض",
    afterDetails: "بعد استكمال البيانات",
    complete: (done: number, total: number) => `مكتمل ${done} من ${total}`,
    count: (done: number, total: number) => `${done} من ${total}`,
    heading: "نموذج الالتحاق",
    note: "الضغط على «إرسال» يعني قبول العرض. وللاعتذار عن العرض يُرجى الرد على بريد العرض.",
    ready: "جاهز للإرسال",
    setByOffer: "محدد في العرض",
    yourDetails: "بياناتك",
  },
  step: (index: string) => `الخطوة ${index}`,
};

export const JOINING_COPY: Record<JoiningLang, JoiningCopy> = { ar, en };

/** Option labels in Arabic. The stored value never changes — only what a person reads. */
export const AR_EDUCATION: Record<string, string> = {
  Arts: "آداب",
  "Business Administration": "إدارة أعمال",
  Commerce: "تجارة",
  Dentistry: "طب أسنان",
  Engineering: "هندسة",
  Law: "حقوق",
  Medicine: "طب بشري",
  Other: "أخرى",
  Pharmacy: "صيدلة",
  Science: "علوم",
  "Veterinary Medicine": "طب بيطري",
};

export const AR_GENDER: Record<string, string> = { female: "أنثى", male: "ذكر" };

/**
 * The Arabic of every message the form's check, the submit and the page itself send in English,
 * keyed by the exact English. Pinned against the source by `tests/offer-joining-form.test.ts`.
 */
export const AR_MESSAGES: Record<string, string> = {
  // The form's own check — src/lib/offers/joining-form.ts
  "Please write your full name, at least your first and second name.": "يُرجى كتابة الاسم الكامل، على الأقل الاسم الأول والثاني.",
  "Please write your full name in Arabic letters, exactly as it is on your national ID card.": "يُرجى كتابة الاسم الكامل بالحروف العربية، كما هو مكتوب في بطاقة الرقم القومي تماماً.",
  "Please write your full Arabic name as on your card — at least your name, your father's and your grandfather's.": "يُرجى كتابة الاسم العربي الكامل كما في البطاقة — الاسم واسم الأب والجد على الأقل.",
  "Please write an Egyptian mobile number, 11 digits starting with 01.": "يُرجى كتابة رقم موبايل مصري من 11 رقماً يبدأ بـ 01.",
  "Please write a valid email address.": "يُرجى كتابة بريد إلكتروني صحيح.",
  "Please write your own private email, not a Sato Pharma address.": "يُرجى كتابة البريد الشخصي، وليس بريداً على نطاق ساتو فارما.",
  "Please write your 14-digit national ID number exactly as it is on your card.": "يُرجى كتابة الرقم القومي المكوّن من 14 رقماً كما هو في البطاقة.",
  "Please choose your gender.": "يُرجى اختيار النوع.",
  "This does not match your national ID number. Please check both.": "لا يتطابق هذا مع الرقم القومي. يُرجى مراجعة الاثنين.",
  "Please choose your date of birth.": "يُرجى اختيار تاريخ الميلاد.",
  "Please check your date of birth.": "يُرجى مراجعة تاريخ الميلاد.",
  "Please choose your education.": "يُرجى اختيار المؤهل الدراسي.",
  "Please write your faculty or degree.": "يُرجى كتابة الكلية أو المؤهل.",
  "Please choose the area you live in.": "يُرجى اختيار منطقة السكن.",
  "Please write the area you live in.": "يُرجى كتابة منطقة السكن.",
  "Please choose the city (governorate) you live in.": "يُرجى اختيار محافظة السكن.",
  "Please write your home address.": "يُرجى كتابة عنوان السكن.",
  "Please add a photo of the front of your national ID card.": "يُرجى إضافة صورة لوجه بطاقة الرقم القومي.",
  "Please add a photo of the back of your national ID card.": "يُرجى إضافة صورة لظهر بطاقة الرقم القومي.",
  "Please choose a photo — a JPG, PNG or WEBP image.": "يُرجى اختيار صورة بصيغة JPG أو PNG أو WEBP.",
  "This photo is too large. Please take it again, or choose a smaller one.": "حجم الصورة كبير. يُرجى التقاطها مرة أخرى أو اختيار صورة أصغر.",
  "This photo could not be opened on this phone. Please take the photo again with the camera.":
    "تعذّر فتح هذه الصورة على هذا الهاتف. يُرجى التقاط الصورة مرة أخرى بالكاميرا.",
  // The page's states — JOINING_FORM_STATE_MESSAGE, and the invalid link in app/join/[token]/page.tsx
  "This offer was declined": "تم الاعتذار عن هذا العرض",
  "This offer was recorded as declined. If that is not right, please reply to the offer email and our HR team will help.":
    "سُجّل هذا العرض على أنه مرفوض. إذا لم يكن ذلك صحيحاً، يُرجى الرد على بريد العرض وسيساعدك فريق الموارد البشرية.",
  "This offer is not open yet": "هذا العرض غير متاح بعد",
  "Your offer is being updated": "جارٍ تحديث عرضك",
  "Our HR team is updating your offer. You will receive the updated offer by email shortly; please use the button in that email.":
    "يقوم فريق الموارد البشرية بتحديث عرضك. سيصلك العرض المحدَّث عبر البريد الإلكتروني قريباً؛ يُرجى استخدام الزر الموجود في ذلك البريد.",
  "This offer has not been issued yet. Please use the link in the offer email you receive.":
    "لم يصدر هذا العرض بعد. يُرجى استخدام الرابط الموجود في بريد العرض عند وصوله.",
  "Your position is being confirmed": "جارٍ تأكيد الوظيفة",
  "Our HR team needs to confirm your position before you can complete this form. They will contact you shortly — you can also reply to the offer email.":
    "يحتاج فريق الموارد البشرية إلى تأكيد الوظيفة قبل استكمال هذا النموذج، وسيتواصل معك قريباً — ويمكنك أيضاً الرد على بريد العرض.",
  "Your start date is being confirmed": "جارٍ تأكيد تاريخ بدء العمل",
  "Our HR team needs to confirm your start date before you can complete this form. They will contact you shortly — you can also reply to the offer email.":
    "يحتاج فريق الموارد البشرية إلى تأكيد تاريخ بدء العمل قبل استكمال هذا النموذج، وسيتواصل معك قريباً — ويمكنك أيضاً الرد على بريد العرض.",
  "You have already completed this form": "تم استكمال هذا النموذج من قبل",
  "Your joining form has been received and your employee record is ready. Our HR team will be in touch before your first day.":
    "تم استلام نموذج الالتحاق وأصبح ملفك الوظيفي جاهزاً. سيتواصل معك فريق الموارد البشرية قبل يوم عملك الأول.",
  "This offer has been withdrawn": "تم سحب هذا العرض",
  "This offer is no longer open. If you have questions, please reply to the offer email.":
    "هذا العرض لم يعد متاحاً. لأي استفسار، يُرجى الرد على بريد العرض.",
  "This link is not valid": "هذا الرابط غير صالح",
  "The link may be incomplete or out of date. Please open it again from the offer email, or reply to that email and our HR team will help you.":
    "قد يكون الرابط ناقصاً أو منتهي الصلاحية. يُرجى فتحه مرة أخرى من بريد العرض، أو الرد على ذلك البريد وسيساعدك فريق الموارد البشرية.",
  // The submit — src/lib/offers/joining-form-service.ts and its route
  "This link is not valid any more. Please reply to the offer email.": "هذا الرابط لم يعد صالحاً. يُرجى الرد على بريد العرض.",
  "We could not complete your joining form right now. Please try again in a few minutes.":
    "تعذّر استكمال نموذج الالتحاق الآن. يُرجى المحاولة مرة أخرى بعد بضع دقائق.",
  "You are already registered with us. Our HR team has been told and will contact you shortly. You can also reply to the offer email.":
    "بياناتك مسجَّلة لدينا بالفعل. تم إبلاغ فريق الموارد البشرية وسيتواصل معك قريباً، ويمكنك أيضاً الرد على بريد العرض.",
  "This form is already being submitted, or was submitted a moment ago. Please refresh the page.":
    "يجري إرسال هذا النموذج بالفعل، أو تم إرساله منذ لحظات. يُرجى تحديث الصفحة.",
  "We could not complete your joining form right now. Our HR team has been told and will contact you shortly. You can also reply to the offer email.":
    "تعذّر استكمال نموذج الالتحاق الآن. تم إبلاغ فريق الموارد البشرية وسيتواصل معك قريباً، ويمكنك أيضاً الرد على بريد العرض.",
  "Too many attempts. Please wait a few minutes and try again.": "محاولات كثيرة. يُرجى الانتظار بضع دقائق ثم المحاولة مرة أخرى.",
  "Your photos are too large to send. Please take them again, or choose smaller ones.":
    "حجم الصور أكبر من المسموح. يُرجى التقاطها مرة أخرى أو اختيار صور أصغر.",
  "The form could not be read. Please try again.": "تعذّرت قراءة النموذج. يُرجى المحاولة مرة أخرى.",
  "Please check the highlighted fields and try again.": "يُرجى مراجعة الحقول المميزة والمحاولة مرة أخرى.",
  "We could not complete your joining form right now. Please try again shortly, or reply to the offer email.":
    "تعذّر استكمال نموذج الالتحاق الآن. يُرجى المحاولة بعد قليل، أو الرد على بريد العرض.",
};

/** A message in the reader's language — the Arabic when there is one, else the English as sent. */
export function translateMessage(lang: JoiningLang, message: string): string {
  if (lang !== "ar") return message;
  return AR_MESSAGES[message.trim()] ?? message;
}
