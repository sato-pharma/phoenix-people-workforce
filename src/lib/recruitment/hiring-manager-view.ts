// Recruitment / ATS — District-Manager-safe (hiring-manager) candidate file access.
//
// The `recruitment`, `candidates`, and `offers` permission resources are ALL hard-boundary
// -locked to Super Admin/Talent Acquisition (see hardBoundaryAllowedActions in
// src/lib/auth/permissions.ts) — a role like District Manager can never be granted any of
// them, even scoped, even via a role_permission_override. Rather than weaken that lock,
// District Manager (and the other hiring-manager-type roles already listed in the
// workflow-registry's app_record_hm_interview allowedRoles) instead get a separate, narrow
// `hiring_interviews` permission resource — deliberately NOT hard-boundary-capped — reached
// only through the routes under app/api/recruitment/hiring-manager/**. Those routes call the
// same underlying service functions as the Talent Acquisition workspace (listApplications,
// createInterview, recordInterviewOutcome, runApplicationTransition); the existing per-record
// scoping in those functions (canSeeApplication/getRequisition, keyed on the caller's own
// hiring_manager_hr_id) already restricts a caller to their own requisitions regardless of
// which permission resource gated the route.
//
// This module specifically exposes just the CV file(s) of a candidate the caller can already
// see through that same scope. A candidate outside the caller's own requisitions is invisible
// here even to someone who guesses its id.
//
// Since 2026-08-15 there are TWO ways into that scope, not one: the requisition walk below, and a
// candidate a recruiter pushed straight to this caller with no requisition in between. The second
// is the one the module is actually used for — see isCandidateSentToCaller.

import type { AccessContext } from "@/lib/auth/permissions";
import { hrIdsMatch } from "@/lib/hr-id";
import { canSeeAllRecruitment } from "@/lib/recruitment/access";
import { recruitmentDb } from "@/lib/recruitment/db";
import { getFileForDownload, listCandidateFiles, type FileDownload } from "@/lib/recruitment/files";
import { getRequisition } from "@/lib/recruitment/requisitions";
import type { RecruitmentFile } from "@/lib/recruitment/types";

/**
 * True when a recruiter pushed this exact candidate to this exact caller.
 *
 * The second, shorter route into scope, and the one the owner's flow actually uses: CV arrives, AI
 * reads it, recruiter sends the person to a District Manager. That push writes
 * manager_notified_hr_id on the candidate and creates no application at all — so the requisition
 * walk below can never find it, and before this check the manager could not open the CV of somebody
 * deliberately sent to them.
 *
 * Read with select("*") rather than a filtered query on purpose: the column arrives with migration
 * 20260815180000_candidate_manager_push, and filtering on a column that does not exist yet fails the
 * whole request, while reading a row that simply lacks the field yields undefined and answers false.
 */
export async function isCandidateSentToCaller(access: AccessContext, candidateId: string): Promise<boolean> {
  if (!access.hrId) return false;
  const { data, error } = await recruitmentDb()
    .from("ats_candidates")
    .select("*")
    .eq("id", candidateId)
    .maybeSingle();
  if (error) throw error;
  const stamped = (data as { manager_notified_hr_id?: unknown } | null)?.manager_notified_hr_id;
  return Boolean(stamped) && hrIdsMatch(String(stamped), access.hrId);
}

async function assertCandidateInHiringManagerScope(access: AccessContext, candidateId: string): Promise<void> {
  if (canSeeAllRecruitment(access)) return;
  if (await isCandidateSentToCaller(access, candidateId)) return;

  const supabase = recruitmentDb();
  const { data, error } = await supabase
    .from("ats_applications")
    .select("requisition_id")
    .eq("candidate_id", candidateId);
  if (error) throw error;

  const requisitionIds = Array.from(
    new Set(((data ?? []) as Array<{ requisition_id: unknown }>).map((row) => String(row.requisition_id))),
  );
  for (const requisitionId of requisitionIds) {
    try {
      // getRequisition throws Forbidden internally when out of scope — a caught throw
      // just means "not this one", so keep checking the candidate's other requisitions.
      const requisition = await getRequisition(access, requisitionId);
      if (requisition) return;
    } catch {
      /* try the next requisition */
    }
  }
  throw new Error("Forbidden: candidate is outside your recruitment scope.");
}

export async function listHiringManagerCandidateFiles(
  access: AccessContext,
  candidateId: string,
): Promise<RecruitmentFile[]> {
  await assertCandidateInHiringManagerScope(access, candidateId);
  return listCandidateFiles(candidateId);
}

export async function downloadHiringManagerCandidateFile(
  access: AccessContext,
  candidateId: string,
  fileId: string,
): Promise<FileDownload | null> {
  await assertCandidateInHiringManagerScope(access, candidateId);
  const files = await listCandidateFiles(candidateId);
  if (!files.some((file) => file.id === fileId)) {
    throw new Error("Forbidden: file does not belong to this candidate.");
  }
  return getFileForDownload(fileId);
}
