// Offer pipeline — approval-chain engine.
//
// Pure helpers (computeRequiredApprovers, evaluateChainState, canCastOfferApproval)
// plus thin data-access helpers over the `offer_approval_steps` table. The chain is
// threshold based: HR Manager (Super Admin role) is always required; the requisition's
// hiring manager (Department Head) is added when present; CEO is added above the
// per-position salary cap. Finance Manager is NOT an approver.
//
// Authority is enforced data-drivenly (canCastOfferApproval) — the permission matrix
// is NOT widened. This module only touches offer_approval_steps (no import of the
// applications/offers services), so the staged services can compose it cycle-free.

import type { AccessContext, PhoenixRole } from "@/lib/auth/permissions";
import { normalizeHrId } from "@/lib/auth/permissions";
import { getSupabaseAdmin } from "@/lib/supabase/server";

export type ApproverKind = "role" | "person";
export type ApprovalDecision = "pending" | "approved" | "rejected" | "returned";
export type ChainState = "pending" | "approved" | "rejected" | "returned";

export type RequiredApprover = {
  sequence: number;
  kind: ApproverKind;
  role: PhoenixRole | null;
  hrId: string | null;
  required: boolean;
  label: string;
};

export type ApprovalStepRow = {
  id: string;
  offerId: string;
  applicationId: string | null;
  version: number;
  sequence: number;
  approverKind: ApproverKind;
  approverRole: string | null;
  approverHrId: string | null;
  required: boolean;
  decision: ApprovalDecision;
  decidedBy: string | null;
  decidedAt: string | null;
  reason: string | null;
};

// Pure: required approvers for an offer. HR Manager (Super Admin role) is always
// required. The requisition's hiring manager (Department Head) is added when present.
// CEO is added when net salary exceeds the per-position cap.
// Finance Manager is NOT an approver — Financial Advisor only executes already-approved requests.
//
// Governance: the "HR Manager" approval is reserved for Super Admin (Admin-HR) and the
// HR Manager B-10 (Omar Anwar Gawish), who holds the Super Admin role. The retired
// HR access role and A-16 must NOT approve offers.
export function computeRequiredApprovers(input: {
  netSalary: number | null;
  hiringManagerHrId: string | null;
  threshold: number;
}): RequiredApprover[] {
  const steps: Array<Omit<RequiredApprover, "sequence">> = [
    { kind: "role", role: "Super Admin", hrId: null, required: true, label: "HR Manager" },
  ];

  if (normalizeHrId(input.hiringManagerHrId)) {
    steps.push({ kind: "person", role: null, hrId: input.hiringManagerHrId, required: true, label: "Department Head" });
  }

  const net = typeof input.netSalary === "number" && Number.isFinite(input.netSalary) ? input.netSalary : null;
  if (net !== null && net > input.threshold) {
    steps.push({ kind: "role", role: "CEO", hrId: null, required: true, label: "CEO" });
  }

  return steps.map((step, index) => ({ ...step, sequence: index + 1 }));
}

// Pure: collapse the step decisions into an overall chain state.
export function evaluateChainState(steps: Array<Pick<ApprovalStepRow, "required" | "decision">>): ChainState {
  const required = steps.filter((step) => step.required);
  if (required.some((step) => step.decision === "rejected")) return "rejected";
  if (required.some((step) => step.decision === "returned")) return "returned";
  if (required.length > 0 && required.every((step) => step.decision === "approved")) return "approved";
  return "pending";
}

// Pure: can this caller cast the decision for a given step?
export function canCastOfferApproval(
  access: Pick<AccessContext, "role" | "scope" | "hrId">,
  step: Pick<ApprovalStepRow, "approverKind" | "approverRole" | "approverHrId">,
): boolean {
  if (access.role === "Super Admin" || access.scope === "system") return true;
  if (step.approverKind === "person") {
    return Boolean(step.approverHrId) && normalizeHrId(access.hrId) === normalizeHrId(step.approverHrId);
  }
  return Boolean(step.approverRole) && access.role === step.approverRole;
}

function mapStep(row: Record<string, unknown>): ApprovalStepRow {
  return {
    id: String(row.id),
    offerId: String(row.offer_id),
    applicationId: row.application_id ? String(row.application_id) : null,
    version: Number(row.version ?? 1),
    sequence: Number(row.sequence ?? 0),
    approverKind: (String(row.approver_kind ?? "role") === "person" ? "person" : "role"),
    approverRole: row.approver_role ? String(row.approver_role) : null,
    approverHrId: row.approver_hr_id ? String(row.approver_hr_id) : null,
    required: row.required !== false,
    decision: (["approved", "rejected", "returned"].includes(String(row.decision)) ? String(row.decision) : "pending") as ApprovalDecision,
    decidedBy: row.decided_by ? String(row.decided_by) : null,
    decidedAt: row.decided_at ? String(row.decided_at) : null,
    reason: row.reason ? String(row.reason) : null,
  };
}

// Next approval round number for an offer (1 if none yet). Each submit-for-approval
// (initial, post-rejection, or post-negotiation) seeds a fresh round.
export async function nextApprovalVersion(offerId: string): Promise<number> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("offer_approval_steps")
    .select("version")
    .eq("offer_id", offerId)
    .order("version", { ascending: false })
    .limit(1);
  if (error) throw error;
  const latest = Number((data?.[0] as { version?: number } | undefined)?.version ?? 0);
  return (Number.isFinite(latest) ? latest : 0) + 1;
}

export async function seedApprovalSteps(input: {
  offerId: string;
  applicationId: string | null;
  version: number;
  approvers: RequiredApprover[];
}): Promise<void> {
  const supabase = getSupabaseAdmin();
  // Idempotent re-seed of this round.
  await supabase.from("offer_approval_steps").delete().eq("offer_id", input.offerId).eq("version", input.version);
  if (input.approvers.length === 0) return;
  const { error } = await supabase.from("offer_approval_steps").insert(
    input.approvers.map((approver) => ({
      offer_id: input.offerId,
      application_id: input.applicationId,
      version: input.version,
      sequence: approver.sequence,
      approver_kind: approver.kind,
      approver_role: approver.role,
      approver_hr_id: approver.hrId,
      required: approver.required,
      decision: "pending",
    })),
  );
  if (error) throw error;
}

export async function getApprovalStep(stepId: string): Promise<ApprovalStepRow | null> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase.from("offer_approval_steps").select("*").eq("id", stepId).maybeSingle();
  if (error) throw error;
  return data ? mapStep(data as Record<string, unknown>) : null;
}

export async function loadApprovalSteps(offerId: string, version: number): Promise<ApprovalStepRow[]> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("offer_approval_steps")
    .select("*")
    .eq("offer_id", offerId)
    .eq("version", version)
    .order("sequence", { ascending: true });
  if (error) throw error;
  return ((data ?? []) as Array<Record<string, unknown>>).map(mapStep);
}

// The latest round's steps (for the UI checklist).
export async function loadLatestApprovalSteps(offerId: string): Promise<ApprovalStepRow[]> {
  const version = await nextApprovalVersion(offerId);
  if (version <= 1) {
    const all = await loadApprovalSteps(offerId, 1);
    return all;
  }
  return loadApprovalSteps(offerId, version - 1);
}

export async function recordApprovalDecision(input: {
  stepId: string;
  decision: "approved" | "rejected" | "returned";
  decidedBy: string | null;
  reason?: string | null;
}): Promise<void> {
  const supabase = getSupabaseAdmin();
  const { error } = await supabase
    .from("offer_approval_steps")
    .update({
      decision: input.decision,
      decided_by: input.decidedBy,
      decided_at: new Date().toISOString(),
      reason: input.reason ?? null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", input.stepId);
  if (error) throw error;
}
