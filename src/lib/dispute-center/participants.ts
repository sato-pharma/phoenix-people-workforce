import { normalizeHrId, resolveEmployeeIdentityId, type AccessContext } from "@/lib/auth/permissions";
import { canReviewDisputes } from "@/lib/attendance/digest-service.ts";
import { compactDeductionsHrId } from "@/lib/deductions/candidate-key.ts";
import { isDeductionsDecisionActor, isDeductionsReadActor } from "@/lib/deductions/permissions.ts";
import { forbiddenError, notFoundError } from "@/lib/http/api-errors";
import { hrIdsMatch } from "@/lib/hr-id";
import { getSupabaseAdmin } from "@/lib/supabase/server";

import type { DisputeCaseKind } from "./types.ts";

// WHO IS IN A DISPUTE — the one gate every Dispute Center read and write goes through.
//
// Each module already had its own narrow rule, and they are kept exactly:
//   - calendar   the employee who raised it, and the Super Admin (assertDisputeDecisionActor).
//   - deduction  the employee the deduction belongs to; the Super Admin replies and decides; the CEO,
//                the Finance Manager and HR Operations READ (isDeductionsReadActor) and cannot write.
//   - daily      the employee the released daily line belongs to; the Super Admin answers and decides
//                (the daily module's own release actor); the deductions read actors READ.
//   - digest     the employee whose week it is; the Super Admin and the named dispute reviewers
//                (canReviewDisputes) answer and decide — never on their own pay (assertNotOwnPay).
// A manager holding attendance:read is in none of these, on purpose: a colleague's pay-affecting
// dispute is not theirs to read.

export type DisputeParticipant = {
  /** The employee the case belongs to, as stored on the record. */
  ownerHrId: string;
  isOwner: boolean;
  /** May answer and decide. */
  isReviewer: boolean;
  /** May read the case (owner, reviewer, or a company-wide reader). */
  canRead: boolean;
  /** The viewer's own HR id, for authorship. */
  viewerHrId: string | null;
};

export function viewerHrIdOf(access: Pick<AccessContext, "hrId" | "loginId">): string | null {
  return resolveEmployeeIdentityId(access) ?? normalizeHrId(access.hrId) ?? normalizeHrId(access.loginId) ?? null;
}

/** The employee a case belongs to, read from the module's own record. Throws not-found. */
export async function loadCaseOwnerHrId(kind: DisputeCaseKind, ref: string): Promise<string> {
  const supabase = getSupabaseAdmin();
  if (kind === "calendar") {
    const { data, error } = await supabase.from("private_calendar_data_disputes").select("employee_hr_id").eq("id", ref).maybeSingle();
    if (error) throw error;
    const owner = (data as { employee_hr_id?: string | null } | null)?.employee_hr_id;
    if (!owner) throw notFoundError("That dispute no longer exists.");
    return owner;
  }
  if (kind === "deduction") {
    const { data, error } = await supabase
      .from("deductions_candidates")
      .select("employee_hr_id, employee_hr_id_compact")
      .eq("id", ref)
      .maybeSingle();
    if (error) throw error;
    const row = data as { employee_hr_id?: string | null; employee_hr_id_compact?: string | null } | null;
    const owner = row?.employee_hr_id || row?.employee_hr_id_compact;
    if (!owner) throw notFoundError("That deduction no longer exists.");
    return owner;
  }
  if (kind === "daily") {
    const { data, error } = await supabase
      .from("daily_deductions_disputes")
      .select("employee_hr_id, employee_hr_id_compact")
      .eq("id", ref)
      .maybeSingle();
    if (error) throw error;
    const row = data as { employee_hr_id?: string | null; employee_hr_id_compact?: string | null } | null;
    const owner = row?.employee_hr_id || row?.employee_hr_id_compact;
    if (!owner) throw notFoundError("That dispute no longer exists.");
    return owner;
  }
  const lineId = Number(ref);
  if (!Number.isInteger(lineId) || lineId <= 0) throw notFoundError("That day was not found.");
  const { data, error } = await supabase
    .from("attendance_digest_lines")
    .select("id, attendance_weekly_digests!inner(employee_hr_id)")
    .eq("id", lineId)
    .maybeSingle();
  if (error) throw error;
  const nested = (data as { attendance_weekly_digests?: unknown } | null)?.attendance_weekly_digests as
    | { employee_hr_id?: string }
    | Array<{ employee_hr_id?: string }>
    | null
    | undefined;
  const owner = Array.isArray(nested) ? nested[0]?.employee_hr_id : nested?.employee_hr_id;
  if (!owner) throw notFoundError("That day was not found.");
  return owner;
}

/**
 * Pure: who the viewer is to this case. Exported so the rule is pinned without a database
 * (tests/dispute-center-participants.test.ts). `digestReviewer` is the async canReviewDisputes answer,
 * resolved by the caller.
 */
export function resolveParticipant(input: {
  kind: DisputeCaseKind;
  ownerHrId: string;
  role: string | null | undefined;
  viewerHrId: string | null;
  digestReviewer?: boolean;
}): DisputeParticipant {
  const isOwner =
    input.kind === "deduction" || input.kind === "daily"
      ? Boolean(input.viewerHrId) && compactDeductionsHrId(input.viewerHrId) === compactDeductionsHrId(input.ownerHrId)
      : hrIdsMatch(input.viewerHrId, input.ownerHrId);
  const role = { role: (input.role ?? "") as AccessContext["role"] };
  let isReviewer = false;
  let companyReader = false;
  if (input.kind === "calendar") isReviewer = input.role === "Super Admin";
  if (input.kind === "deduction") {
    isReviewer = isDeductionsDecisionActor(role);
    companyReader = isDeductionsReadActor(role);
  }
  if (input.kind === "daily") {
    // Only the Super Admin releases or withdraws a daily line, so only he decides its dispute.
    isReviewer = input.role === "Super Admin";
    companyReader = isDeductionsReadActor(role);
  }
  if (input.kind === "digest") {
    // A named reviewer never rules on their own week; the Super Admin is exempt (nobody above him).
    isReviewer = Boolean(input.digestReviewer) && (input.role === "Super Admin" || !isOwner);
  }
  return {
    canRead: isOwner || isReviewer || companyReader,
    isOwner,
    isReviewer,
    ownerHrId: input.ownerHrId,
    viewerHrId: input.viewerHrId,
  };
}

/** Load the case owner and resolve the viewer against it. Throws forbidden when they may not read it. */
export async function resolveCaseParticipant(
  access: AccessContext,
  kind: DisputeCaseKind,
  ref: string,
): Promise<DisputeParticipant> {
  const ownerHrId = await loadCaseOwnerHrId(kind, ref);
  const viewerHrId = viewerHrIdOf(access);
  const digestReviewer = kind === "digest" ? await canReviewDisputes(access) : false;
  const participant = resolveParticipant({ digestReviewer, kind, ownerHrId, role: access.role, viewerHrId });
  if (!participant.canRead) {
    throw forbiddenError("Only the employee this dispute belongs to, or its reviewer, can open it.");
  }
  return participant;
}
