// Recruitment / ATS — the one place a CV-extraction field key is tied to its database column.
//
// WHY THIS FILE EXISTS. Before 2026-08-14 the PATCH /api/recruitment/candidates/[id] route
// enumerated all 21 writable candidate keys by hand. The review board renders whatever the field
// schema declares, so adding a field meant it was rendered, edited, dragged and submitted — and
// then silently dropped by the route, with no error anywhere. That made the schema and the save
// path independently editable, which is exactly how they drifted.
//
// Now the route is driven from this map. Adding a scalar field is: declare it in
// cv-field-schemas.ts, add one line here, add the column in a migration. Adding a repeating block
// needs no entry at all — array fields are storage:"jsonb" and land in position_specific_fields.
//
// Kept separate from cv-field-schemas.ts on purpose: that file is imported by client components
// and must stay free of database concerns.

import { universalCvFields, type CvFieldDefinition } from "@/lib/recruitment/cv-field-schemas";

// Extraction field key -> ats_candidates column. Only `storage: "column"` fields appear here;
// cvFieldStorageDrift() below asserts this map against the schema in both directions, and
// tests/recruitment-cv-extraction.test.ts requires it to come back empty — so a field added to one
// and not the other fails CI instead of silently never being saved.
export const CV_FIELD_COLUMNS: Readonly<Record<string, string>> = {
  // Identity
  fullName: "full_name",
  email: "email",
  phone: "phone",
  whatsapp: "whatsapp",
  linkedinUrl: "linkedin_url",
  nationalId: "national_id",
  // Personal
  nationality: "nationality",
  dateOfBirth: "date_of_birth",
  placeOfBirth: "place_of_birth",
  gender: "gender",
  maritalStatus: "marital_status",
  militaryStatus: "military_status",
  address: "address",
  governorate: "governorate",
  // Professional
  currentJobTitle: "current_job_title",
  professionalSummary: "professional_summary",
  currentEmployer: "current_employer",
  currentRoleResponsibilities: "current_role_responsibilities",
  yearsExperience: "years_experience",
  expectedSalary: "expected_salary",
  noticePeriod: "notice_period",
  // Education
  faculty: "faculty",
  university: "university",
  degree: "degree",
  graduationYear: "graduation_year",
  grade: "grade",
  // Pharma-specific
  hasPriorWorkExperience: "has_prior_work_experience",
  hasMedicalRepExperience: "has_medical_rep_experience",
  medicalRepEmployer: "medical_rep_employer",
  medicalRepExperienceFrom: "medical_rep_experience_from",
  medicalRepExperienceTo: "medical_rep_experience_to",
};

export function cvFieldColumn(key: string): string | null {
  return CV_FIELD_COLUMNS[key] ?? null;
}

// Fields the AI can propose that are NOT part of the identity triple. The identity fields stay
// excluded from auto-apply and from the review queue (see CV_IDENTITY_FIELD_KEYS in
// cv-auto-apply.ts) because createCandidate owns identity resolution before the row exists —
// re-applying them later risks repointing an already-matched candidate onto another person.
export function listWritableCvFields(): CvFieldDefinition[] {
  return universalCvFields.filter((field) => field.storage === "column" && cvFieldColumn(field.key) !== null);
}

export function listJsonbCvFields(): CvFieldDefinition[] {
  return universalCvFields.filter((field) => field.storage === "jsonb");
}

// Returns the mismatches between the schema and this map, both directions, so a field declared in
// one place and forgotten in the other surfaces as a red test rather than as a silently unsaved
// value months later. Both lists must be empty.
export function cvFieldStorageDrift(): { missingColumn: string[]; orphanColumn: string[] } {
  const schemaColumnKeys = new Set(
    universalCvFields.filter((field) => field.storage === "column").map((field) => field.key),
  );
  const mapKeys = new Set(Object.keys(CV_FIELD_COLUMNS));

  const missingColumn = [...schemaColumnKeys].filter((key) => !mapKeys.has(key)).sort();
  const orphanColumn = [...mapKeys].filter((key) => !schemaColumnKeys.has(key)).sort();
  return { missingColumn, orphanColumn };
}
