import { terminalApplicationStages, type ApplicationStage } from "@/lib/recruitment/types";

/**
 * Deciding a candidate merge — the pure half.
 *
 * Two rows for one person is the normal state of this pool, not an anomaly: 337 people arrived on
 * WhatsApp and 211 by email, and someone who sent their CV both ways is two candidates holding
 * half the facts each. `findPossibleDuplicate` (candidate-matching.ts) has always FLAGGED them;
 * nothing has ever been able to join them back together.
 *
 * Two principles hold this file together, and both exist because a merge deletes a row:
 *
 *  1. **A merge never overwrites.** The survivor keeps every value it already has; the duplicate
 *     only fills blanks. So the worst a wrong merge can do is add facts to the wrong person —
 *     recoverable by editing. Overwriting would destroy the survivor's own CV data, which is not.
 *  2. **A merge that cannot complete cleanly is refused, never half-applied.** The reasons below
 *     each map to something the database would otherwise reject mid-way, leaving files moved and
 *     applications stranded.
 */

/**
 * The columns the survivor may borrow, with the words a recruiter would use for them.
 *
 * Deliberately not "every column": `status`, `statusNote`, `notes` and `source` stay with the
 * survivor untouched. A borrowed status would silently undo a decision someone made, and a
 * borrowed `source` would claim the survivor arrived through a channel it did not.
 */
export const mergeableFields = [
  { column: "national_id", key: "nationalId", label: "national ID" },
  { column: "email", key: "email", label: "email" },
  { column: "phone", key: "phone", label: "phone number" },
  { column: "whatsapp", key: "whatsapp", label: "WhatsApp number" },
  { column: "linkedin_url", key: "linkedinUrl", label: "LinkedIn profile" },
  { column: "nationality", key: "nationality", label: "nationality" },
  { column: "date_of_birth", key: "dateOfBirth", label: "date of birth" },
  { column: "place_of_birth", key: "placeOfBirth", label: "place of birth" },
  { column: "gender", key: "gender", label: "gender" },
  { column: "marital_status", key: "maritalStatus", label: "marital status" },
  { column: "military_status", key: "militaryStatus", label: "military status" },
  { column: "address", key: "address", label: "address" },
  { column: "governorate", key: "governorate", label: "governorate" },
  { column: "current_job_title", key: "currentJobTitle", label: "current job title" },
  { column: "applied_for_job_title", key: "appliedForJobTitle", label: "job applied for" },
  { column: "applied_for_evidence", key: "appliedForEvidence", label: "evidence of the job applied for" },
  { column: "professional_summary", key: "professionalSummary", label: "professional summary" },
  { column: "current_employer", key: "currentEmployer", label: "current employer" },
  { column: "current_role_responsibilities", key: "currentRoleResponsibilities", label: "current responsibilities" },
  { column: "years_experience", key: "yearsExperience", label: "years of experience" },
  { column: "expected_salary", key: "expectedSalary", label: "expected salary" },
  { column: "notice_period", key: "noticePeriod", label: "notice period" },
  { column: "cv_reference_name", key: "cvReferenceName", label: "CV file" },
  { column: "cv_external_url", key: "cvExternalUrl", label: "CV link" },
  { column: "faculty", key: "faculty", label: "faculty" },
  { column: "university", key: "university", label: "university" },
  { column: "degree", key: "degree", label: "degree" },
  { column: "graduation_year", key: "graduationYear", label: "graduation year" },
  { column: "grade", key: "grade", label: "grade" },
  { column: "medical_rep_employer", key: "medicalRepEmployer", label: "medical rep employer" },
  { column: "medical_rep_experience_from", key: "medicalRepExperienceFrom", label: "medical rep experience start" },
  { column: "medical_rep_experience_to", key: "medicalRepExperienceTo", label: "medical rep experience end" },
] as const;

export type MergeableField = (typeof mergeableFields)[number];
export type MergeableFieldKey = MergeableField["key"];

export type MergeCandidateFacts = {
  [Key in MergeableFieldKey]?: string | number | null;
} & {
  fullName?: string | null;
  id: string;
};

export type MergeApplicationFacts = {
  convertedEmployeeHrId?: string | null;
  requisitionId: string;
  requisitionTitle?: string | null;
  stage: ApplicationStage | string;
};

export type BorrowedField = {
  column: string;
  key: MergeableFieldKey;
  label: string;
  value: string | number;
};

const terminalStages = new Set<string>(terminalApplicationStages);

/** An application still moving — the same set `recruitment_applications_active_uidx` guards. */
export function isActiveApplicationStage(stage: string): boolean {
  return !terminalStages.has(stage);
}

function isBlank(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === "string") return value.trim() === "";
  return false;
}

/**
 * Every field the duplicate can fill in on the survivor: the survivor's is blank, the duplicate's
 * is not. Blank-only in one direction — this is what makes a merge non-destructive.
 */
export function borrowableFields(survivor: MergeCandidateFacts, duplicate: MergeCandidateFacts): BorrowedField[] {
  const borrowed: BorrowedField[] = [];
  for (const field of mergeableFields) {
    const incoming = duplicate[field.key];
    if (isBlank(incoming)) continue;
    if (!isBlank(survivor[field.key])) continue;
    borrowed.push({
      column: field.column,
      key: field.key,
      label: field.label,
      value: typeof incoming === "string" ? incoming.trim() : (incoming as number),
    });
  }
  return borrowed;
}

/** "email, phone number and university" — for the confirmation line and the history entry. */
export function describeBorrowedFields(borrowed: readonly BorrowedField[]): string {
  const labels = borrowed.map((field) => field.label);
  if (labels.length === 0) return "";
  if (labels.length === 1) return labels[0];
  return `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`;
}

/**
 * Why this merge must not run, in the words the recruiter needs — or null when it may proceed.
 *
 * The order matters: identity first, then the two states the database itself would reject.
 */
export function mergeBlockReason(input: {
  duplicate: MergeCandidateFacts | null;
  duplicateApplications: readonly MergeApplicationFacts[];
  survivor: MergeCandidateFacts | null;
  survivorApplications: readonly MergeApplicationFacts[];
}): string | null {
  const { duplicate, duplicateApplications, survivor, survivorApplications } = input;
  if (!survivor) return "The candidate to keep no longer exists.";
  if (!duplicate) return "The duplicate candidate no longer exists.";
  if (survivor.id === duplicate.id) return "A candidate cannot be merged into itself.";

  // The duplicate row is the one that gets deleted. Once someone has been converted to an employee
  // that row is the evidence of who was hired and on what basis, so deleting it would leave the
  // employee record pointing at an application whose candidate facts came from somewhere else.
  const hired = duplicateApplications.find(
    (application) => application.convertedEmployeeHrId || application.stage === "hired",
  );
  if (hired) {
    const name = duplicate.fullName?.trim() || "This duplicate record";
    return `${name} has already been hired, so this record cannot be merged away — it is the evidence of that hire. Correct the surviving record by hand instead.`;
  }

  // Only ONE live application per person per requisition is allowed
  // (recruitment_applications_active_uidx). Moving the duplicate's onto the survivor would collide,
  // and by then the files and CV extractions have already moved — so refuse before touching
  // anything and let a human close whichever application is the wrong one.
  const survivorActive = new Set(
    survivorApplications
      .filter((application) => isActiveApplicationStage(application.stage))
      .map((application) => application.requisitionId),
  );
  const collision = duplicateApplications.find(
    (application) => isActiveApplicationStage(application.stage) && survivorActive.has(application.requisitionId),
  );
  if (collision) {
    const where = collision.requisitionTitle?.trim() || "the same opening";
    return `Both records have a live application for ${where}. Withdraw or reject one of them first, then merge.`;
  }

  return null;
}

export function canMergeCandidates(input: Parameters<typeof mergeBlockReason>[0]): boolean {
  return mergeBlockReason(input) === null;
}
