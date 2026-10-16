// Recruitment / ATS — attach one screened CV to an open requisition, in one press.
//
// The owner, 2026-10-16: "by one click from admin or TA the CV is requisitioned, or kept
// shortlisted, or rejected". This is the first of those three. It is the existing assignment —
// `createApplication`, which refuses a duplicate and tells the requisition's hiring manager — plus
// the status a person would otherwise set by hand: a CV attached to a requisition is SHORTLISTED.
//
// ADMIN OR TA, IN WORDS AS WELL AS IN THE GRANT. `candidates:update` is already hard-locked to those
// two roles, but this press opens an application and reaches a manager, so it says so itself rather
// than inheriting the answer from a permission matrix an override could one day widen.

import type { AccessContext } from "@/lib/auth/permissions";
import { forbiddenError } from "@/lib/http/api-errors";
import { createApplication } from "@/lib/recruitment/applications";
import { candidateStatusLabels, normalizeCandidateStatus } from "@/lib/recruitment/candidate-status";
import { getCandidate, updateCandidateStatus } from "@/lib/recruitment/candidates";
import { numberOrNull, recruitmentDb, textOrNull } from "@/lib/recruitment/db";
import type { OpenRequisitionOption } from "@/lib/recruitment/requisition-match";
import { getRequisition } from "@/lib/recruitment/requisitions";
import type { VacancyOption } from "@/lib/recruitment/vacancy-options";

/** The two seats that may attach a CV to a requisition (owner, 2026-10-16: "admin or ta"). */
export const REQUISITION_ATTACH_ROLES = ["Super Admin", "HR Resourcing"] as const;

const RECRUITING = new Set(["req_open", "req_published"]);
/** A CV in one of these is past the screen. */
const ATTACH_REFUSED_STATUSES = new Set<string>(["hired", "rejected", "sent_to_manager"]);

export function canAttachToRequisition(access: Pick<AccessContext, "role">): boolean {
  return (REQUISITION_ATTACH_ROLES as readonly string[]).includes(access.role);
}

/**
 * The requisitions recruiting now, and which candidates already have an application on each.
 *
 * Named from the open seat behind each when there is one (`vacancies`, the send picker's own list),
 * so the recommendation reads "Medical Representative · Nasr City · Pedia" and never a code.
 */
export async function loadRequisitionMatchInputs(vacancies: readonly VacancyOption[]): Promise<{
  requisitions: OpenRequisitionOption[];
  attachedByCandidate: Map<string, string[]>;
}> {
  const supabase = recruitmentDb();
  const { data, error } = await supabase
    .from("ats_requisitions")
    .select("id,requisition_code,job_title,vacancy_id,status,created_at")
    .in("status", [...RECRUITING])
    .order("created_at", { ascending: true });
  if (error) throw error;
  const byVacancy = new Map(vacancies.map((vacancy) => [vacancy.id, vacancy]));
  const requisitions: OpenRequisitionOption[] = ((data ?? []) as Array<Record<string, unknown>>).map((row) => {
    const vacancyId = numberOrNull(row.vacancy_id);
    const seat = vacancyId === null ? undefined : byVacancy.get(vacancyId);
    return {
      areaName: seat?.areaName ?? null,
      code: textOrNull(row.requisition_code) ?? String(row.id),
      id: String(row.id),
      jobTitle: textOrNull(row.job_title) ?? seat?.jobTitle ?? "",
      lineName: seat?.lineName ?? null,
      regionName: seat?.regionName ?? null,
      vacancyId,
    };
  });

  const attachedByCandidate = new Map<string, string[]>();
  if (requisitions.length > 0) {
    const { data: applications, error: applicationsError } = await supabase
      .from("ats_applications")
      .select("candidate_id,requisition_id")
      .in("requisition_id", requisitions.map((requisition) => requisition.id));
    if (applicationsError) throw applicationsError;
    for (const row of (applications ?? []) as Array<{ candidate_id?: string | null; requisition_id?: string | null }>) {
      const candidateId = textOrNull(row.candidate_id);
      const requisitionId = textOrNull(row.requisition_id);
      if (!candidateId || !requisitionId) continue;
      const list = attachedByCandidate.get(candidateId) ?? [];
      list.push(requisitionId);
      attachedByCandidate.set(candidateId, list);
    }
  }
  return { attachedByCandidate, requisitions };
}

export async function attachCandidateToRequisition(
  access: AccessContext,
  input: { candidateId: string; requisitionId: string },
): Promise<{ applicationId: string; requisitionCode: string; status: string }> {
  if (!canAttachToRequisition(access)) {
    throw forbiddenError("Only an Admin or Talent Acquisition can attach a CV to a requisition.");
  }

  const [candidate, requisition] = await Promise.all([
    getCandidate(input.candidateId),
    getRequisition(access, input.requisitionId),
  ]);
  if (!candidate) throw new Error("Candidate not found.");
  if (!requisition) throw new Error("Requisition not found.");
  // The same three the recommendation stays silent on: a hired or rejected CV is decided, and one
  // with a manager is the manager's — a press from a stale screen must not reopen any of them.
  const decided = normalizeCandidateStatus(candidate.status);
  if (decided && ATTACH_REFUSED_STATUSES.has(decided)) {
    throw new Error(`This CV is already ${candidateStatusLabels[decided].toLowerCase()}, so it cannot be attached to a requisition.`);
  }
  if (!RECRUITING.has(requisition.status)) {
    throw new Error(`${requisition.requisitionCode} is not open any more, so nobody can be attached to it.`);
  }

  const application = await createApplication(
    // The channel the CV came in on, the same value every other application carries in `source`.
    { candidateId: candidate.id, requisitionId: requisition.id, source: candidate.source },
    access,
  );

  // Shortlisted, unless the CV already sits further on — a CV with a manager is never walked back
  // (statusChangeRefusal), and one already shortlisted needs no second history row.
  const current = normalizeCandidateStatus(candidate.status) ?? "new";
  let status: string = current;
  if (current === "new" || current === "backup") {
    const updated = await updateCandidateStatus(
      access,
      candidate.id,
      "shortlisted",
      `Attached to ${requisition.requisitionCode}.`,
    );
    status = updated.status ?? "shortlisted";
  }

  return { applicationId: application.id, requisitionCode: requisition.requisitionCode, status };
}
