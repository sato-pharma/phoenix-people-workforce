// Missing-punch verification: sequential 3-step sign-off (standing verifier ->
// HR approver -> CEO) for a missing-punch digest line. Zero EGP impact —
// informational/compliance only, entirely separate from the confirm/dispute
// settlement flow in settlement-service.ts (see that file's own scope note).
//
// Same TOCTOU-safe pattern as the rest of this module: every transition
// guards on the row's CURRENT status in the WHERE clause and treats a 0-row
// update as a conflict, not a silent no-op.

import { getSupabaseAdmin } from "@/lib/supabase/server";
import { conflictError, validationError } from "@/lib/http/api-errors";
import { normalizeAttendanceHrId } from "@/lib/attendance/metrics";
import { ceoHrIds, getDigestSettings } from "@/lib/attendance/digest-recipients";
import { notifyMissingPunchDecided, notifyMissingPunchStepReady, notifyMissingPunchSubmitted } from "@/lib/attendance/digest-notify";

export type MissingPunchStatus =
  | "awaiting_employee"
  | "awaiting_verifier"
  | "awaiting_hr"
  | "awaiting_ceo"
  | "fully_verified"
  | "rejected";

export type MissingPunchStep = "verifier" | "hr" | "ceo";

export type MissingPunchVerificationRow = {
  id: number;
  digest_line_id: number;
  employee_hr_id: string;
  work_date: string;
  employee_reason: string | null;
  employee_proof_url: string | null;
  status: MissingPunchStatus;
  verifier_hr_id: string | null;
  hr_hr_id: string | null;
  ceo_hr_id: string | null;
  rejected_by: string | null;
  rejected_at_step: MissingPunchStep | null;
  rejection_reason: string | null;
};

const COLUMNS =
  "id,digest_line_id,employee_hr_id,work_date,employee_reason,employee_proof_url,status,verifier_hr_id,hr_hr_id,ceo_hr_id,rejected_by,rejected_at_step,rejection_reason";

/** Which step is pending for a given status, or null if there is none (terminal state). */
export function pendingStepFor(status: MissingPunchStatus): MissingPunchStep | null {
  if (status === "awaiting_verifier") return "verifier";
  if (status === "awaiting_hr") return "hr";
  if (status === "awaiting_ceo") return "ceo";
  return null;
}

async function loadVerificationByDigestLine(digestLineId: number): Promise<MissingPunchVerificationRow | null> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("attendance_missing_punch_verifications")
    .select(COLUMNS)
    .eq("digest_line_id", digestLineId)
    .maybeSingle();
  if (error) throw error;
  return data as MissingPunchVerificationRow | null;
}

async function loadVerificationById(id: number): Promise<MissingPunchVerificationRow> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("attendance_missing_punch_verifications")
    .select(COLUMNS)
    .eq("id", id)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw validationError("Missing-punch verification was not found.");
  return data as MissingPunchVerificationRow;
}

async function loadDigestLine(digestLineId: number) {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("attendance_digest_lines")
    .select("id,digest_id,work_date,status")
    .eq("id", digestLineId)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw validationError("Digest line was not found.");
  return data as { id: number; digest_id: number; work_date: string; status: string };
}

async function loadDigestEmployee(digestId: number): Promise<string> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase.from("attendance_weekly_digests").select("employee_hr_id").eq("id", digestId).maybeSingle();
  if (error) throw error;
  if (!data) throw validationError("Digest was not found.");
  return (data as { employee_hr_id: string }).employee_hr_id;
}

/**
 * Employee submits (or re-submits, if previously rejected) a reason + proof
 * for a missing-punch line. Creates the verification row on first submission.
 */
export async function submitMissingPunchReason(input: {
  digestLineId: number;
  actorHrId: string;
  reason: string;
  proofUrl: string | null;
}): Promise<MissingPunchVerificationRow> {
  const reason = input.reason.trim();
  if (!reason) throw validationError("A reason is required.");

  const line = await loadDigestLine(input.digestLineId);
  if (line.status !== "missing_punch") throw validationError("This line is not a missing-punch item.");

  const employeeHrId = await loadDigestEmployee(line.digest_id);
  const actor = normalizeAttendanceHrId(input.actorHrId);
  if (!actor || actor !== normalizeAttendanceHrId(employeeHrId)) {
    throw new Error("Forbidden: you can only submit a reason for your own missing punch.");
  }

  const supabase = getSupabaseAdmin();
  const now = new Date().toISOString();
  const existing = await loadVerificationByDigestLine(input.digestLineId);

  if (existing && existing.status !== "awaiting_employee" && existing.status !== "rejected") {
    throw conflictError("A reason has already been submitted and is under review.");
  }

  const payload = {
    digest_line_id: input.digestLineId,
    employee_hr_id: employeeHrId,
    employee_proof_url: input.proofUrl,
    employee_reason: reason,
    rejected_at: null,
    rejected_at_step: null,
    rejected_by: null,
    status: "awaiting_verifier" as const,
    submitted_at: now,
    updated_at: now,
    work_date: line.work_date,
  };

  const { data, error } = await supabase
    .from("attendance_missing_punch_verifications")
    .upsert(payload, { onConflict: "digest_line_id" })
    .select(COLUMNS)
    .single();
  if (error) throw error;

  const settings = await getDigestSettings();
  if (settings.missingPunchVerifierHrId) {
    await notifyMissingPunchSubmitted({
      employeeHrId,
      recipientHrId: settings.missingPunchVerifierHrId,
      reason,
      workDate: line.work_date,
    });
  }

  return data as MissingPunchVerificationRow;
}

async function resolveAuthorizedActors(step: MissingPunchStep): Promise<string[]> {
  const settings = await getDigestSettings();
  if (step === "verifier") return settings.missingPunchVerifierHrId ? [settings.missingPunchVerifierHrId] : [];
  if (step === "hr") return settings.approverHrIds;
  return ceoHrIds();
}

const nextStatusFor: Record<MissingPunchStep, MissingPunchStatus> = {
  ceo: "fully_verified",
  hr: "awaiting_ceo",
  verifier: "awaiting_hr",
};
const expectedStatusFor: Record<MissingPunchStep, MissingPunchStatus> = {
  ceo: "awaiting_ceo",
  hr: "awaiting_hr",
  verifier: "awaiting_verifier",
};
const actorColumnFor: Record<MissingPunchStep, "verifier_hr_id" | "hr_hr_id" | "ceo_hr_id"> = {
  ceo: "ceo_hr_id",
  hr: "hr_hr_id",
  verifier: "verifier_hr_id",
};
const confirmedAtColumnFor: Record<MissingPunchStep, "verifier_confirmed_at" | "hr_confirmed_at" | "ceo_confirmed_at"> = {
  ceo: "ceo_confirmed_at",
  hr: "hr_confirmed_at",
  verifier: "verifier_confirmed_at",
};

/**
 * A verifier/HR/CEO confirms or rejects at whatever step is currently
 * pending. isSuperAdmin bypasses the specific-person/list check (safety
 * valve, matching the same pattern used for dispute review) but NEVER
 * bypasses which STEP is next — a Super Admin can act as "the HR step" but
 * cannot skip straight to CEO out of sequence.
 */
export async function decideMissingPunchStep(input: {
  verificationId: number;
  actorHrId: string;
  isSuperAdmin: boolean;
  decision: "confirm" | "reject";
  notes: string | null;
}): Promise<MissingPunchVerificationRow> {
  const verification = await loadVerificationById(input.verificationId);
  const step = pendingStepFor(verification.status);
  if (!step) throw validationError("This verification has no pending step to act on.");

  const actor = normalizeAttendanceHrId(input.actorHrId);
  if (!actor) throw validationError("No HR ID on session.");

  if (!input.isSuperAdmin) {
    const authorized = await resolveAuthorizedActors(step);
    if (!authorized.includes(actor)) {
      throw new Error(`Forbidden: you are not authorized for the ${step} step of this missing-punch verification.`);
    }
  }

  const supabase = getSupabaseAdmin();
  const now = new Date().toISOString();
  const expectedStatus = expectedStatusFor[step];

  const patch: Record<string, unknown> =
    input.decision === "confirm"
      ? { [actorColumnFor[step]]: actor, [confirmedAtColumnFor[step]]: now, status: nextStatusFor[step], updated_at: now }
      : {
          rejected_at: now,
          rejected_at_step: step,
          rejected_by: actor,
          rejection_reason: input.notes,
          status: "rejected",
          updated_at: now,
        };

  const { data, error } = await supabase
    .from("attendance_missing_punch_verifications")
    .update(patch)
    .eq("id", input.verificationId)
    .eq("status", expectedStatus)
    .select(COLUMNS)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw conflictError("This step has already been acted on.");

  const result = data as MissingPunchVerificationRow;

  if (input.decision === "reject") {
    await notifyMissingPunchDecided({ employeeHrId: result.employee_hr_id, rejected: true, reason: input.notes, step, workDate: result.work_date });
    return result;
  }

  const nextStep = pendingStepFor(result.status);
  // "verifier" can never be the next step here — confirming any step only ever
  // advances forward (verifier -> hr -> ceo -> fully_verified), so the only
  // remaining possibilities after a confirm are "hr", "ceo", or done.
  if (nextStep === "hr" || nextStep === "ceo") {
    const nextActors = await resolveAuthorizedActors(nextStep);
    await notifyMissingPunchStepReady({ employeeHrId: result.employee_hr_id, recipients: nextActors, step: nextStep, workDate: result.work_date });
  } else {
    await notifyMissingPunchDecided({ employeeHrId: result.employee_hr_id, rejected: false, reason: null, step, workDate: result.work_date });
  }

  return result;
}

/** Verifications where the given actor is authorized to act on the current pending step. */
export async function listMyPendingMissingPunchActions(actorHrId: string | null, isSuperAdmin: boolean) {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("attendance_missing_punch_verifications")
    .select(COLUMNS)
    .in("status", ["awaiting_verifier", "awaiting_hr", "awaiting_ceo"])
    .order("submitted_at", { ascending: true });
  if (error) throw error;

  const rows = (data ?? []) as MissingPunchVerificationRow[];
  if (isSuperAdmin) return rows;

  const actor = normalizeAttendanceHrId(actorHrId);
  if (!actor) return [];

  const settings = await getDigestSettings();
  const ceoIds = await ceoHrIds();
  return rows.filter((row) => {
    const step = pendingStepFor(row.status);
    if (step === "verifier") return settings.missingPunchVerifierHrId === actor;
    if (step === "hr") return settings.approverHrIds.includes(actor);
    if (step === "ceo") return ceoIds.includes(actor);
    return false;
  });
}
