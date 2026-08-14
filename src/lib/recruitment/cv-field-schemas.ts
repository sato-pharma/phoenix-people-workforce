// Recruitment / ATS — CV-extraction field schema.
//
// A pure, isomorphic registry (no DB/AI/Node imports — safe to import from both server code
// like cv-extraction.ts and client components like the review board).
//
// HISTORY / SHAPE OF THIS FILE. Until 2026-08-14 this held two "position schemas" —
// medical_rep and district_manager — which shared the *identical* field array by reference and
// differed only in label and prompt wording. Every inbound CV was extracted against Medical Rep's
// 12 fields regardless of the job applied for, so a Payroll Specialist CV was asked four Medical
// Rep questions and 34% of all extracted field slots came back empty.
//
// The design is now inverted. There is ONE universal schema that reads whatever a CV actually
// contains, and the candidate's job title is an *extracted field* (`currentJobTitle`) rather than
// a precondition chosen before extraction. Adding support for a new role is no longer a code
// change at all.
//
// `positionKey` survives as plumbing only — ~40 call sites thread it, 170 historical
// `ats_candidate_cv_extractions` rows are stamped `medical_rep`, and those rows must keep
// resolving or their review-queue entries break. The legacy keys are therefore kept as ALIASES
// onto the universal schema (see `cvPositionSchemas` at the bottom).
//
// Storage split, deliberate:
//   • scalars  → dedicated `ats_candidates` columns, so they are filterable, indexable and
//                exportable. "Give me every Egyptian candidate" has to be a WHERE clause.
//   • repeating blocks (work history, education, certifications, skills, languages)
//              → `ats_candidates.position_specific_fields` jsonb, because they are arrays of
//                variable length and cannot be columns.

export type CvFieldType = "string" | "boolean" | "date" | "number" | "array";

// A field inside a repeating block (one work-history entry, one qualification, …). Sub-fields are
// always scalar — blocks do not nest — and are stored as part of their parent's jsonb array.
export type CvSubFieldDefinition = {
  key: string;
  label: string;
  type: Exclude<CvFieldType, "array">;
  aiDescription: string;
};

export type CvFieldSection =
  | "identity"
  | "personal"
  | "professional"
  | "education"
  | "history"
  | "pharma";

export type CvFieldDefinition = {
  key: string;
  label: string;
  type: CvFieldType;
  aiDescription: string;
  // "column" = a dedicated ats_candidates column. "jsonb" = merged into
  // position_specific_fields. Every `type: "array"` field is necessarily "jsonb".
  storage: "column" | "jsonb";
  // Groups the field in the review UI and on the field-settings page.
  section: CvFieldSection;
  // Only rendered/required in the review UI when the named boolean field has this value —
  // e.g. medicalRepEmployer only makes sense once hasMedicalRepExperience is true.
  showWhen?: { field: string; equals: boolean };
  // Required for type: "array" — the shape of one entry in the block.
  itemFields?: CvSubFieldDefinition[];
};

export type CvPositionSchema = {
  positionKey: string;
  label: string;
  fields: CvFieldDefinition[];
  instructions: string;
};

// ---------------------------------------------------------------------------
// Identity — who they are and how to reach them.
// ---------------------------------------------------------------------------

const identityFields: CvFieldDefinition[] = [
  {
    aiDescription: "Candidate's full name exactly as written on the CV itself, not as it appears in any covering email.",
    key: "fullName",
    label: "Full name",
    section: "identity",
    storage: "column",
    type: "string",
  },
  {
    aiDescription: "Candidate's email address as printed on the CV.",
    key: "email",
    label: "Email",
    section: "identity",
    storage: "column",
    type: "string",
  },
  {
    aiDescription: "Candidate's primary phone/mobile number, digits as written on the CV.",
    key: "phone",
    label: "Mobile",
    section: "identity",
    storage: "column",
    type: "string",
  },
  {
    aiDescription:
      "A WhatsApp number, ONLY when the CV lists one separately from the primary phone. If the CV says the same number serves both, repeat that number here.",
    key: "whatsapp",
    label: "WhatsApp",
    section: "identity",
    storage: "column",
    type: "string",
  },
  {
    aiDescription: "LinkedIn profile URL, or another professional/portfolio profile link if no LinkedIn is given.",
    key: "linkedinUrl",
    label: "LinkedIn / profile link",
    section: "identity",
    storage: "column",
    type: "string",
  },
  {
    aiDescription: "Egyptian national ID number, only if it is actually printed on the CV.",
    key: "nationalId",
    label: "National ID",
    section: "identity",
    storage: "column",
    type: "string",
  },
];

// ---------------------------------------------------------------------------
// Personal — the block Egyptian CVs conventionally carry near the top.
// ---------------------------------------------------------------------------

const personalFields: CvFieldDefinition[] = [
  {
    aiDescription:
      "The candidate's nationality exactly as stated on the CV (e.g. Egyptian, Indian, Sudanese). If the CV does not state it, leave null — do NOT guess a nationality from the person's name, their university, or their phone number's country code.",
    key: "nationality",
    label: "Nationality",
    section: "personal",
    storage: "column",
    type: "string",
  },
  {
    aiDescription: "Date of birth as YYYY-MM-DD. If only a month and year are given, use day 01.",
    key: "dateOfBirth",
    label: "Date of birth",
    section: "personal",
    storage: "column",
    type: "date",
  },
  {
    aiDescription: "Place of birth (city and/or governorate) as stated.",
    key: "placeOfBirth",
    label: "Place of birth",
    section: "personal",
    storage: "column",
    type: "string",
  },
  {
    aiDescription: 'Gender as stated on the CV — "Male" or "Female". Do not infer it from the candidate\'s name.',
    key: "gender",
    label: "Gender",
    section: "personal",
    storage: "column",
    type: "string",
  },
  {
    aiDescription: 'Marital status as stated, e.g. "Single", "Married", "Divorced".',
    key: "maritalStatus",
    label: "Marital status",
    section: "personal",
    storage: "column",
    type: "string",
  },
  {
    aiDescription:
      'Military service status as stated, e.g. "Exempted", "Completed", "Postponed", "Not applicable". Common on Egyptian male CVs.',
    key: "militaryStatus",
    label: "Military status",
    section: "personal",
    storage: "column",
    type: "string",
  },
  {
    aiDescription: "Candidate's street/detailed address as written, distinct from the governorate.",
    key: "address",
    label: "Address",
    section: "personal",
    storage: "column",
    type: "string",
  },
  {
    aiDescription:
      "The single Egyptian governorate the candidate lives in (e.g. Cairo, Giza, Alexandria) — not a full street address. Leave null for a candidate living outside Egypt.",
    key: "governorate",
    label: "Governorate",
    section: "personal",
    storage: "column",
    type: "string",
  },
];

// ---------------------------------------------------------------------------
// Professional — role-agnostic. `currentJobTitle` is the field that makes this
// schema work for any job; it replaces the old "pick a template first" step.
// ---------------------------------------------------------------------------

const professionalFields: CvFieldDefinition[] = [
  {
    aiDescription:
      "The candidate's own current or most recent professional job title, in their words (e.g. \"HR Recruitment Consultant\", \"Payroll Specialist\", \"Medical Representative\", \"District Sales Manager\"). This is the candidate's title — NOT the vacancy they are applying to.",
    key: "currentJobTitle",
    label: "Current / main job title",
    section: "professional",
    storage: "column",
    type: "string",
  },
  {
    aiDescription:
      "The CV's professional profile, summary or career-objective paragraph, kept close to the candidate's own wording. Null if the CV has no such section.",
    key: "professionalSummary",
    label: "Professional summary",
    section: "professional",
    storage: "column",
    type: "string",
  },
  {
    aiDescription: "The company the candidate currently works for, or most recently worked for.",
    key: "currentEmployer",
    label: "Current employer",
    section: "professional",
    storage: "column",
    type: "string",
  },
  {
    aiDescription:
      "What the candidate actually does in their current/most recent role — the duties and responsibilities as described on the CV.",
    key: "currentRoleResponsibilities",
    label: "Current role responsibilities",
    section: "professional",
    storage: "column",
    type: "string",
  },
  {
    aiDescription:
      "Total years of professional work experience as a number. Derive it from the work history when the CV does not state a total outright; use whole or one-decimal years.",
    key: "yearsExperience",
    label: "Total years of experience",
    section: "professional",
    storage: "column",
    type: "number",
  },
  {
    aiDescription: "Expected or current salary, ONLY when the CV states a figure. Include the currency as written.",
    key: "expectedSalary",
    label: "Expected salary",
    section: "professional",
    storage: "column",
    type: "number",
  },
  {
    aiDescription: 'Notice period, only when stated, e.g. "1 month", "immediate".',
    key: "noticePeriod",
    label: "Notice period",
    section: "professional",
    storage: "column",
    type: "string",
  },
];

// ---------------------------------------------------------------------------
// Education — the highest/most relevant qualification. Additional degrees go
// into the educationHistory block below.
// ---------------------------------------------------------------------------

const educationFields: CvFieldDefinition[] = [
  {
    aiDescription: "Faculty/college within the university, e.g. Faculty of Pharmacy, Faculty of Science.",
    key: "faculty",
    label: "Faculty",
    section: "education",
    storage: "column",
    type: "string",
  },
  {
    aiDescription: "Name of the university or institution the candidate graduated from.",
    key: "university",
    label: "University",
    section: "education",
    storage: "column",
    type: "string",
  },
  {
    aiDescription: 'Degree awarded, e.g. "BSc", "Bachelor", "Diploma", "MBA", "Masters".',
    key: "degree",
    label: "Degree",
    section: "education",
    storage: "column",
    type: "string",
  },
  {
    aiDescription: "Year of graduation as a four-digit year.",
    key: "graduationYear",
    label: "Graduation year",
    section: "education",
    storage: "column",
    type: "number",
  },
  {
    aiDescription: 'Overall grade/classification as stated, e.g. "Very Good", "Excellent", "Good with honours".',
    key: "grade",
    label: "Grade",
    section: "education",
    storage: "column",
    type: "string",
  },
];

// ---------------------------------------------------------------------------
// Repeating blocks. These are what let one CV yield five employer rows and
// another none — the behaviour a fixed column set structurally cannot express.
// ---------------------------------------------------------------------------

const historyFields: CvFieldDefinition[] = [
  {
    aiDescription:
      "EVERY position in the candidate's employment history, most recent first — one entry per role, including freelance and part-time engagements listed separately on the CV. Do not summarise several roles into one entry and do not omit older ones.",
    itemFields: [
      { aiDescription: "Employer / company name.", key: "employer", label: "Employer", type: "string" },
      { aiDescription: "Job title held at that employer.", key: "jobTitle", label: "Job title", type: "string" },
      { aiDescription: "Start date as YYYY-MM-DD; use day 01 when only month/year is given.", key: "from", label: "From", type: "date" },
      {
        aiDescription: 'End date as YYYY-MM-DD, or null if this is the current role. Use "Present" only in the summary text, never here.',
        key: "to",
        label: "To",
        type: "date",
      },
      { aiDescription: "Work location (city/country) for that role, if stated.", key: "location", label: "Location", type: "string" },
      {
        aiDescription: "Duties and responsibilities for that role as described on the CV.",
        key: "responsibilities",
        label: "Responsibilities",
        type: "string",
      },
    ],
    key: "workHistory",
    label: "Work history",
    section: "history",
    storage: "jsonb",
    type: "array",
  },
  {
    aiDescription: "Every qualification the CV lists — one entry per degree, diploma or certificate awarded by an institution.",
    itemFields: [
      { aiDescription: "Institution / university name.", key: "institution", label: "Institution", type: "string" },
      { aiDescription: 'Degree or qualification, e.g. "BSc Pharmacy".', key: "degree", label: "Degree", type: "string" },
      { aiDescription: "Field of study or faculty.", key: "fieldOfStudy", label: "Field of study", type: "string" },
      { aiDescription: "Year awarded, four digits.", key: "year", label: "Year", type: "number" },
      { aiDescription: "Grade or classification, if stated.", key: "grade", label: "Grade", type: "string" },
    ],
    key: "educationHistory",
    label: "Education history",
    section: "history",
    storage: "jsonb",
    type: "array",
  },
  {
    aiDescription: "Professional certifications, courses and training programmes listed on the CV.",
    itemFields: [
      { aiDescription: "Name of the certificate, course or training.", key: "name", label: "Name", type: "string" },
      { aiDescription: "Awarding body or training provider.", key: "issuer", label: "Issuer", type: "string" },
      { aiDescription: "Year obtained, four digits.", key: "year", label: "Year", type: "number" },
    ],
    key: "certifications",
    label: "Certifications / training",
    section: "history",
    storage: "jsonb",
    type: "array",
  },
  {
    aiDescription: "Skills and competencies the CV lists — one entry per skill, not one entry containing a comma-separated list.",
    itemFields: [{ aiDescription: "A single named skill or competency.", key: "name", label: "Skill", type: "string" }],
    key: "skills",
    label: "Skills",
    section: "history",
    storage: "jsonb",
    type: "array",
  },
  {
    aiDescription: "Languages the candidate speaks, with the fluency level stated on the CV.",
    itemFields: [
      { aiDescription: "Language name.", key: "language", label: "Language", type: "string" },
      { aiDescription: 'Stated proficiency, e.g. "Native", "Fluent", "Good".', key: "level", label: "Level", type: "string" },
    ],
    key: "languages",
    label: "Languages",
    section: "history",
    storage: "jsonb",
    type: "array",
  },
];

// ---------------------------------------------------------------------------
// Pharma-specific. Retained because this is a pharma company and these drive
// real screening decisions — but they are now four fields among forty rather
// than a third of the whole schema, and they no longer fire on every CV.
// ---------------------------------------------------------------------------

const pharmaFields: CvFieldDefinition[] = [
  {
    aiDescription: "Whether the candidate has any prior work experience at all, in any field.",
    key: "hasPriorWorkExperience",
    label: "Prior work experience",
    section: "pharma",
    storage: "column",
    type: "boolean",
  },
  {
    aiDescription:
      "Whether the candidate has previously worked specifically as a Medical Rep or in medical sales promotion/detailing. General sales experience in an unrelated field does NOT count here (it still counts toward hasPriorWorkExperience).",
    key: "hasMedicalRepExperience",
    label: "Medical Rep experience",
    section: "pharma",
    storage: "column",
    type: "boolean",
  },
  {
    aiDescription: "Company where the candidate worked as a Medical Rep, only when hasMedicalRepExperience is true.",
    key: "medicalRepEmployer",
    label: "Medical Rep employer",
    section: "pharma",
    showWhen: { equals: true, field: "hasMedicalRepExperience" },
    storage: "column",
    type: "string",
  },
  {
    aiDescription: "Start date (YYYY-MM-DD) of the candidate's Medical Rep tenure, only when hasMedicalRepExperience is true.",
    key: "medicalRepExperienceFrom",
    label: "Medical Rep from",
    section: "pharma",
    showWhen: { equals: true, field: "hasMedicalRepExperience" },
    storage: "column",
    type: "date",
  },
  {
    aiDescription: "End date (YYYY-MM-DD) of the candidate's Medical Rep tenure, only when hasMedicalRepExperience is true.",
    key: "medicalRepExperienceTo",
    label: "Medical Rep to",
    section: "pharma",
    showWhen: { equals: true, field: "hasMedicalRepExperience" },
    storage: "column",
    type: "date",
  },
];

export const universalCvFields: CvFieldDefinition[] = [
  ...identityFields,
  ...personalFields,
  ...professionalFields,
  ...educationFields,
  ...historyFields,
  ...pharmaFields,
];

// Section order and labels for the review UI and the field-settings page.
export const CV_FIELD_SECTIONS: ReadonlyArray<{ key: CvFieldSection; label: string }> = [
  { key: "identity", label: "Identity & contact" },
  { key: "personal", label: "Personal details" },
  { key: "professional", label: "Professional" },
  { key: "education", label: "Education" },
  { key: "history", label: "Full history" },
  { key: "pharma", label: "Pharma-specific" },
];

const universalInstructions = [
  "You extract structured candidate data from a job applicant's CV for an Egyptian pharmaceutical company's HR system.",
  "The applicant may hold ANY job title — medical representative, district sales manager, payroll specialist, HR consultant, accountant, regulatory affairs, IT, anything. Never assume the candidate is a medical representative and never skip a field because it looks unrelated to pharma.",
  "Your goal is that a recruiter can read your output and never need to open the CV itself. Extract everything the CV actually contains.",
  "STRICT RULES:",
  "1. Only extract information that is actually present or clearly inferable in the CV — never invent a value. Accuracy matters more than completeness.",
  '2. If a field is genuinely not in the CV, set value to null and confidence to "low". Never fill a gap with a guess.',
  '3. confidence is "high" only when the value is unambiguous in the CV; use "low" whenever the text is unclear, abbreviated, contradictory, or you had to infer.',
  "4. Do NOT infer nationality, gender, or religion from a person's name, university, or phone country code. Extract them only when the CV states them.",
  "5. currentJobTitle is the CANDIDATE'S OWN title from their CV, never the vacancy they are applying for.",
  "6. For the repeating blocks (workHistory, educationHistory, certifications, skills, languages): return one entry per real item and do not collapse several into one. A CV listing five separate freelance engagements must produce five workHistory entries. Return an empty array when the CV has none — never null.",
  "7. Dates must be formatted YYYY-MM-DD. If only a month and year are given, use day 01. If only a year is given, use January 01 of that year and set confidence to \"low\".",
  "8. For a role the candidate still holds, set its `to` date to null rather than writing a placeholder.",
  "9. Only fill medicalRepEmployer/medicalRepExperienceFrom/medicalRepExperienceTo when hasMedicalRepExperience is true; otherwise set them to null.",
  "10. Preserve the candidate's own wording for summaries and responsibilities. Do not rewrite, shorten, or editorialise them.",
].join("\n\n");

const universalSchema: CvPositionSchema = {
  fields: universalCvFields,
  instructions: universalInstructions,
  label: "Any job title",
  positionKey: "universal",
};

// `medical_rep` and `district_manager` are ALIASES onto the universal schema, kept so the 170
// historical extraction rows stamped with those keys still resolve in the review queue and the
// accuracy analytics. They are no longer separate templates — resolving any of the three keys
// returns the same field list.
export const cvPositionSchemas: Record<string, CvPositionSchema> = {
  district_manager: { ...universalSchema, label: "District Manager (legacy)", positionKey: "district_manager" },
  medical_rep: { ...universalSchema, label: "Medical Rep (legacy)", positionKey: "medical_rep" },
  universal: universalSchema,
};

export const defaultCvPositionKey = "universal";

// Legacy keys still resolve, but only the universal schema is offered for new extractions.
export const LEGACY_CV_POSITION_KEYS: ReadonlySet<string> = new Set(["medical_rep", "district_manager"]);

export function getCvPositionSchema(positionKey: string): CvPositionSchema | null {
  return cvPositionSchemas[positionKey] ?? null;
}

export function listCvPositionSchemas(): CvPositionSchema[] {
  return Object.values(cvPositionSchemas).filter((schema) => !LEGACY_CV_POSITION_KEYS.has(schema.positionKey));
}

// Every field key the schema can produce — the allow-list the save path is driven from, so a new
// field never needs the PATCH route edited again.
export function listCvFieldKeys(): string[] {
  return universalCvFields.map((field) => field.key);
}

export function getCvFieldDefinition(key: string): CvFieldDefinition | null {
  return universalCvFields.find((field) => field.key === key) ?? null;
}
