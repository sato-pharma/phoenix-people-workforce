// Unified Deductions module: comment thread on a published candidate (Phase 4).
// Mirrors deductions-governance/service.ts's listDeductionComments/addDeductionComment
// 1:1 — same self-only authorship rule, same "only after publication" gate,
// same audit-log call — just pointed at this module's own deductions_comments/
// deductions_candidates/deductions_publication_lines tables instead of the
// legacy singular-named ones.

import { writeAuditLog } from "@/lib/admin/audit";
import type { AccessContext } from "@/lib/auth/permissions";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { compactDeductionsHrId } from "./candidate-key.ts";
import type { DeductionsComment } from "./types.ts";
import { hrIdForStorage } from "@/lib/hr-id";

type CommentRow = {
  id: string;
  candidate_id: string;
  author_login_id: string;
  author_hr_id: string | null;
  author_role: string | null;
  body: string;
  created_at: string;
};

function mapCommentRow(row: CommentRow): DeductionsComment {
  return {
    id: row.id,
    candidateId: row.candidate_id,
    authorLoginId: row.author_login_id,
    authorHrId: row.author_hr_id,
    authorRole: row.author_role,
    body: row.body,
    createdAt: row.created_at,
  };
}

export async function listDeductionsComments(input: {
  candidateIds: string[];
}): Promise<DeductionsComment[]> {
  if (input.candidateIds.length === 0) return [];
  const rows: CommentRow[] = [];
  for (let i = 0; i < input.candidateIds.length; i += 100) {
    const batch = input.candidateIds.slice(i, i + 100);
    const { data, error } = await getSupabaseAdmin()
      .from("deductions_comments")
      .select("id, candidate_id, author_login_id, author_hr_id, author_role, body, created_at")
      .in("candidate_id", batch)
      .order("created_at", { ascending: false });
    if (error) throw error;
    rows.push(...((data ?? []) as CommentRow[]));
  }
  rows.sort((left, right) => String(right.created_at ?? "").localeCompare(String(left.created_at ?? "")));
  return rows.map(mapCommentRow);
}

/** Returns the candidate's employee_hr_id_compact, or throws if this candidateId
 * doesn't belong to this module at all (the caller falls back to the legacy path). */
export async function findDeductionsCandidateOwner(candidateId: string): Promise<string | null> {
  const { data, error } = await getSupabaseAdmin()
    .from("deductions_candidates")
    .select("employee_hr_id_compact")
    .eq("id", candidateId)
    .maybeSingle();
  if (error) throw error;
  return (data as { employee_hr_id_compact: string } | null)?.employee_hr_id_compact ?? null;
}

async function assertEmployeeCanCommentOnCandidate(access: AccessContext, candidateId: string) {
  const ownerCompactHrId = await findDeductionsCandidateOwner(candidateId);
  if (!ownerCompactHrId) throw new Error("Deduction candidate not found.");
  const actorHr = compactDeductionsHrId(access.hrId ?? access.loginId);
  if (!actorHr || actorHr !== ownerCompactHrId) {
    throw new Error("Forbidden: employees can comment only on their own published deductions.");
  }
  const { data, error } = await getSupabaseAdmin()
    .from("deductions_publication_lines")
    .select("id, publication_id, deductions_publications!inner(status)")
    .eq("candidate_id", candidateId)
    .eq("deductions_publications.status", "published")
    .limit(1);
  if (error) throw error;
  if (!Array.isArray(data) || data.length === 0) {
    throw new Error("Comments are available only after the deduction is finalized.");
  }
}

export async function addDeductionsComment(input: {
  access: AccessContext;
  body: string;
  candidateId: string;
}): Promise<DeductionsComment> {
  await assertEmployeeCanCommentOnCandidate(input.access, input.candidateId);
  const body = String(input.body ?? "").replace(/\s+/g, " ").trim();
  if (!body) throw new Error("Comment is required.");
  if (body.length > 2000) throw new Error("Comment cannot exceed 2000 characters.");
  const payload = {
    author_hr_id: hrIdForStorage(input.access.hrId),
    author_login_id: input.access.loginId ?? input.access.hrId ?? "employee",
    author_role: input.access.role,
    body,
    candidate_id: input.candidateId,
  };
  const { data, error } = await getSupabaseAdmin()
    .from("deductions_comments")
    .insert(payload)
    .select("id, candidate_id, author_login_id, author_hr_id, author_role, body, created_at")
    .single();
  if (error) throw error;

  await writeAuditLog({
    actorLoginId: payload.author_login_id,
    entityId: input.candidateId,
    entityType: "deductions_comment",
    newValues: { bodyLength: body.length },
    summary: "Employee comment added to published deduction (unified module).",
  });

  return mapCommentRow(data as CommentRow);
}
