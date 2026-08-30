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
//
// Since 2026-08-30 there is a THIRD: a candidate pushed to somebody who reports to this caller, so a
// National Sales Manager can open the CVs sitting with his district managers. That one is an org
// walk and lives in hiring-manager-team.ts, which owns the rule about who may look at whom.

import type { AccessContext } from "@/lib/auth/permissions";
import { hrIdsMatch } from "@/lib/hr-id";
import { canSeeAllRecruitment } from "@/lib/recruitment/access";
import { recruitmentDb } from "@/lib/recruitment/db";
import { isCandidateWithinViewerTeam } from "@/lib/recruitment/hiring-manager-team";
import { getFileForDownload, listCandidateFiles, type FileDownload } from "@/lib/recruitment/files";
import { isCandidateSentToManager } from "@/lib/recruitment/manager-sends";
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
  if (Boolean(stamped) && hrIdsMatch(String(stamped), access.hrId)) return true;

  // TWO SOURCES, for the same reason the manager's LIST reads two. This column holds only the LAST
  // manager a CV was sent to, so on its own it hands the file to the most recent recipient and
  // refuses everyone before them — a manager would see the name on their own list and be told the
  // candidate is outside their scope when they clicked it. Since 2026-08-30 a CV can be sent to
  // several managers and each of them keeps it, so the send trail is what answers this.
  //
  // null means the table is not in this database yet; the column's answer above already stands, and
  // a missing migration must never read as a denial.
  return (await isCandidateSentToManager(candidateId, access.hrId)) === true;
}

async function assertCandidateInHiringManagerScope(access: AccessContext, candidateId: string): Promise<void> {
  if (canSeeAllRecruitment(access)) return;
  if (await isCandidateSentToCaller(access, candidateId)) return;
  // THE THIRD ROUTE INTO SCOPE, added 2026-08-30: a CV pushed to somebody who reports to this
  // caller. The owner asked for a National Sales Manager to be able to read the CVs sitting with his
  // district managers, and "read the CV" means opening the actual document — without this the team
  // view would render a card whose View CV button answers 403, which is a worse screen than not
  // showing the card at all. The org walk itself lives in hiring-manager-team.ts.
  if (await isCandidateWithinViewerTeam(access, candidateId)) return;

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
