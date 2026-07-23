// Recruitment / ATS — per-position CV-extraction field schemas.
//
// A pure, isomorphic registry (no DB/AI/Node imports — safe to import from both server code
// like cv-extraction.ts and client components like the review board). Adding a second position
// is data, not a redesign: define its CvPositionSchema entry here with storage: "jsonb" fields
// (persisted into recruitment_candidates.position_specific_fields) — the fixed dedicated
// columns below are Medical Rep's alone and stay untouched by any future position.

export type CvFieldType = "string" | "boolean";

export type CvFieldDefinition = {
  key: string;
  label: string;
  type: CvFieldType;
  aiDescription: string;
  // "column" = an existing dedicated recruitment_candidates column (Medical Rep's 8 fields
  // plus the shared fullName/email/phone/governorate). "jsonb" = merged into the generic
  // position_specific_fields column — the storage path a future position's fields would use.
  storage: "column" | "jsonb";
  // Only rendered/required in the review UI when the named boolean field has this value —
  // e.g. medicalRepEmployer only makes sense once hasMedicalRepExperience is true.
  showWhen?: { field: string; equals: boolean };
};

export type CvPositionSchema = {
  positionKey: string;
  label: string;
  fields: CvFieldDefinition[];
  instructions: string;
};

const medicalRepFields: CvFieldDefinition[] = [
  { aiDescription: "Candidate's full name.", key: "fullName", label: "Full name", storage: "column", type: "string" },
  { aiDescription: "Candidate's email address.", key: "email", label: "Email", storage: "column", type: "string" },
  {
    aiDescription: "Candidate's phone number, digits as written on the CV.",
    key: "phone",
    label: "Phone",
    storage: "column",
    type: "string",
  },
  {
    aiDescription: "Candidate's street/detailed address, distinct from governorate.",
    key: "address",
    label: "Address",
    storage: "column",
    type: "string",
  },
  {
    aiDescription: "The single Egyptian governorate the candidate lives in (e.g. Cairo, Giza, Alexandria) — not a full street address.",
    key: "governorate",
    label: "Governorate",
    storage: "column",
    type: "string",
  },
  {
    aiDescription: "Faculty/college within the candidate's university, e.g. Faculty of Pharmacy.",
    key: "faculty",
    label: "Faculty",
    storage: "column",
    type: "string",
  },
  {
    aiDescription: "Name of the university the candidate graduated from.",
    key: "university",
    label: "University",
    storage: "column",
    type: "string",
  },
  {
    aiDescription: "Whether the candidate has any prior work experience at all, in any field.",
    key: "hasPriorWorkExperience",
    label: "Prior work experience",
    storage: "column",
    type: "boolean",
  },
  {
    aiDescription: "Whether the candidate has previously worked specifically as a Medical Rep / in medical sales promotion or detailing.",
    key: "hasMedicalRepExperience",
    label: "Medical Rep experience",
    storage: "column",
    type: "boolean",
  },
  {
    aiDescription: "Company where the candidate worked as a Medical Rep, only when hasMedicalRepExperience is true.",
    key: "medicalRepEmployer",
    label: "Medical Rep employer",
    showWhen: { equals: true, field: "hasMedicalRepExperience" },
    storage: "column",
    type: "string",
  },
  {
    aiDescription: "Start date (YYYY-MM-DD) of the candidate's Medical Rep tenure, only when hasMedicalRepExperience is true.",
    key: "medicalRepExperienceFrom",
    label: "From",
    showWhen: { equals: true, field: "hasMedicalRepExperience" },
    storage: "column",
    type: "string",
  },
  {
    aiDescription: "End date (YYYY-MM-DD) of the candidate's Medical Rep tenure, only when hasMedicalRepExperience is true.",
    key: "medicalRepExperienceTo",
    label: "To",
    showWhen: { equals: true, field: "hasMedicalRepExperience" },
    storage: "column",
    type: "string",
  },
];

const medicalRepInstructions = [
  "You extract structured candidate fields from a Medical Rep job applicant's CV for an Egyptian pharma company's HR system.",
  "Read the raw CV text given to you and fill every field in the schema.",
  "STRICT RULES:",
  "1. Only extract information that is actually present or clearly inferable in the CV text — never invent a value.",
  '2. If a field is not present in the CV, set value to null and confidence to "low".',
  '3. confidence is "high" only when you are confident the value is correct and unambiguous; use "low" whenever the CV text is unclear, abbreviated, contradictory, or you had to infer/guess.',
  "4. hasMedicalRepExperience means specifically prior experience as a Medical Rep or in medical sales promotion/detailing — general sales experience in an unrelated field does not count as true (it still counts toward hasPriorWorkExperience).",
  "5. Only fill medicalRepEmployer/medicalRepExperienceFrom/medicalRepExperienceTo when hasMedicalRepExperience is true; otherwise set them to null.",
  "6. Dates must be formatted YYYY-MM-DD. If only a month/year is given, use day 01.",
].join("\n\n");

export const cvPositionSchemas: Record<string, CvPositionSchema> = {
  medical_rep: {
    fields: medicalRepFields,
    instructions: medicalRepInstructions,
    label: "Medical Rep",
    positionKey: "medical_rep",
  },
};

export const defaultCvPositionKey = "medical_rep";

export function getCvPositionSchema(positionKey: string): CvPositionSchema | null {
  return cvPositionSchemas[positionKey] ?? null;
}

export function listCvPositionSchemas(): CvPositionSchema[] {
  return Object.values(cvPositionSchemas);
}
