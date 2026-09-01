/**
 * The Sato Pharma worker-data form — استمارة بيانات العامل — VERSION 1. THE CURRENT TEXT.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * DO NOT EDIT THE ARABIC IN THIS FILE.
 *
 * Supplied by the owner on 2026-09-01 as "05 — استمارة بيانات العامل.docx". Like the contract, this
 * file was GENERATED from that document rather than transcribed: every string was read from the
 * .docx in LOGICAL order (from `word/document.xml`, header and footer parts), and the only change
 * made to it was the `{{TOKEN}}` markers, each one substituted for a field the paper form leaves
 * blank. Nothing was reworded, reordered or abridged.
 *
 * WHAT THIS FORM IS. A service-file intake sheet, filled on the day someone is hired and kept in
 * their personnel file — its own header says "تُحفظ بملف الخدمة · لا تُرفق بصور العقد". It is Sato's
 * own instrument, not a government form, and it collects the personal, contact, employment and
 * payroll facts the company needs on file under Labour Law 14/2025 and the data-protection law
 * 151/2020.
 *
 * WHY IT IS NOT SIGNATURE-TRACKED. It carries a signature (the worker's, and the HR receiver's) but
 * the app records no signed date against the person, for the same reason the custody receipts do not
 * — see `SIGNABLE_DOCUMENTS` in `types.ts`. It is a paper filed in a drawer, and recording nothing
 * is honest where recording a half-truth is not. That is also why adding it needed no migration.
 *
 * WHAT PHOENIX FILLS, AND WHAT IT LEAVES BLANK. A field with a `token` is one Phoenix already knows
 * from the employee record — the name, the national id, the job — and types onto the amber blank the
 * source uses; a missing value still prints the dotted rule. A field with `token: null` is one
 * Phoenix has no record of — marital status, military-service position, bank and IBAN, next of kin —
 * so it always prints a blank for a pen, which is exactly what the paper form is for.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 */

/**
 * Every token this form can carry. Independent of the contract's `ContractToken`: this is a
 * different document with its own fields (an employee number, a hire date and a governorate the
 * contract never asks for), filled from its own value bag in `render-worker-form.ts`.
 */
export type WorkerFormToken =
  // The company block
  | "COMPANY_NAME"
  | "COMPANY_LEGAL_FORM"
  | "COMMERCIAL_REGISTER"
  | "COMMERCIAL_REGISTER_OFFICE"
  | "UNIFIED_REGISTER"
  | "TAX_CARD"
  | "COMPANY_HEAD_OFFICE_FULL"
  // The person
  | "EMPLOYEE_NAME"
  | "NATIONAL_ID"
  | "NATIONALITY"
  | "BIRTH_DATE_PLACE"
  | "QUALIFICATION"
  // Contact and address
  | "ADDRESS"
  | "GOVERNORATE"
  | "MARKAZ"
  | "PHONE"
  | "EMAIL"
  // Employment and insurance
  | "EMPLOYEE_NUMBER"
  | "HIRE_DATE"
  | "JOB_TITLE"
  | "DEPARTMENT"
  | "INSURANCE_NUMBER";

/**
 * One labelled field. `token` names the value Phoenix fills it with; `null` means the form always
 * leaves it blank for a pen because Phoenix holds no record of it.
 */
export type WorkerFormField = {
  labelAr: string;
  token: WorkerFormToken | null;
};

/** One numbered section of the form — a heading band over a grid of fields. */
export type WorkerFormSection = {
  headingAr: string;
  fields: readonly WorkerFormField[];
};

/** One row of the signature table — a capacity, and the name Phoenix can fill for it (or null). */
export type WorkerFormSignatureRow = {
  roleAr: string;
  nameToken: WorkerFormToken | null;
};

/** One complete, printable version of the worker-data form. */
export type WorkerFormTemplate = {
  /** Stable identity, matching its `template-registry.ts` id. Never renamed or reused. */
  id: string;
  version: number;
  titleAr: string;
  subtitleAr: string;
  /** The instruction line under the masthead — "تُستوفى يوم التعيين …". */
  noteAr: string;
  /** The company registry block, tokenised so it stays in step with `system-settings`. */
  companyLinesAr: readonly string[];
  /** The data sections (أولًا … رابعًا). */
  sections: readonly WorkerFormSection[];
  /** The final section heading (خامسًا — إقرار العامل). */
  declarationHeadingAr: string;
  declarationAr: string;
  /** The signature table's column labels, after the capacity column. */
  signatureColumnsAr: readonly string[];
  signatureRows: readonly WorkerFormSignatureRow[];
  footerAr: string;
};

const COMPANY_LINES_AR = [
  "{{COMPANY_NAME}} — {{COMPANY_LEGAL_FORM}}",
  "السجل التجاري رقم {{COMMERCIAL_REGISTER}} ({{COMMERCIAL_REGISTER_OFFICE}}) · الرقم الموحد {{UNIFIED_REGISTER}} · البطاقة الضريبية رقم {{TAX_CARD}}",
  "المركز العام: {{COMPANY_HEAD_OFFICE_FULL}}",
] as const;

const SECTIONS: readonly WorkerFormSection[] = [
  {
    headingAr: "أولًا — البيانات الشخصية",
    fields: [
      { labelAr: "الاسم رباعيًا", token: "EMPLOYEE_NAME" },
      { labelAr: "الرقم القومي", token: "NATIONAL_ID" },
      { labelAr: "الجنسية", token: "NATIONALITY" },
      { labelAr: "تاريخ ومحل الميلاد", token: "BIRTH_DATE_PLACE" },
      { labelAr: "الحالة الاجتماعية", token: null },
      { labelAr: "المؤهل وسنة التخرج", token: "QUALIFICATION" },
      { labelAr: "الموقف من التجنيد", token: null },
    ],
  },
  {
    headingAr: "ثانيًا — بيانات الاتصال والعنوان",
    fields: [
      { labelAr: "العنوان الدائم تفصيلًا", token: "ADDRESS" },
      { labelAr: "المحافظة", token: "GOVERNORATE" },
      { labelAr: "المركز أو الحي", token: "MARKAZ" },
      { labelAr: "الهاتف المحمول", token: "PHONE" },
      { labelAr: "البريد الإلكتروني", token: "EMAIL" },
    ],
  },
  {
    headingAr: "ثالثًا — البيانات الوظيفية والتأمينية",
    fields: [
      { labelAr: "الرقم الوظيفي", token: "EMPLOYEE_NUMBER" },
      { labelAr: "تاريخ التعيين", token: "HIRE_DATE" },
      { labelAr: "المسمى الوظيفي", token: "JOB_TITLE" },
      { labelAr: "الإدارة أو القطاع", token: "DEPARTMENT" },
      { labelAr: "الرقم التأميني", token: "INSURANCE_NUMBER" },
      { labelAr: "الخط والنطاق الجغرافي", token: null },
    ],
  },
  {
    headingAr: "رابعًا — بيانات صرف الأجر وحالة الطوارئ",
    fields: [
      { labelAr: "البنك والفرع", token: null },
      { labelAr: "اسم صاحب الحساب", token: null },
      { labelAr: "رقم الحساب (IBAN)", token: null },
      { labelAr: "يُخطَر في حالة الطوارئ", token: null },
      { labelAr: "صلة القرابة والهاتف", token: null },
    ],
  },
];

const DECLARATION_AR =
  "أقر بأن البيانات المدونة أعلاه صحيحة وكاملة وتحت مسؤوليتي، وألتزم بإخطار إدارة الموارد البشرية كتابةً بأي تغيير فيها خلال سبعة أيام من حدوثه، وأقر بأن الإخطارات الموجّهة إليّ على العنوان أو البريد الإلكتروني المدونين أعلاه تُعد صحيحة ونافذة ما لم أخطر الشركة كتابةً بغيرها. وأوافق على صرف أجري بالتحويل على الحساب البنكي المبيّن، وأعلم أن الشركة تعالج هذه البيانات لتنفيذ عقد العمل والوفاء بالتزاماتها القانونية والتأمينية وفقًا للقانون رقم 151 لسنة 2020.";

export const WORKER_FORM_TEMPLATE_V1: WorkerFormTemplate = {
  id: "worker-form-v1",
  version: 1,
  titleAr: "استمارة بيانات العامل",
  subtitleAr: "تُحفظ بملف الخدمة · قانون العمل رقم 14 لسنة 2025",
  noteAr: "تُستوفى يوم التعيين وتُحفظ بملف الخدمة · لا تُرفق بصور العقد",
  companyLinesAr: COMPANY_LINES_AR,
  sections: SECTIONS,
  declarationHeadingAr: "خامسًا — إقرار العامل",
  declarationAr: DECLARATION_AR,
  signatureColumnsAr: ["الاسم", "التوقيع", "التاريخ"],
  signatureRows: [
    { roleAr: "العامل", nameToken: "EMPLOYEE_NAME" },
    { roleAr: "مستلم الاستمارة — الموارد البشرية", nameToken: null },
  ],
  footerAr: "{{COMPANY_NAME}} — إدارة الموارد البشرية — استمارة بيانات العامل",
};

/** The dotted rule an absent value prints as — the same one the contract uses. */
export const WORKER_FORM_BLANK_RULE = "……………………";
