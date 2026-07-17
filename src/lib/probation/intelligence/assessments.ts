// Probation SFE & HR assessments (Phase 5: T02 SFE submit, T03 HR gate, T04 confidential
// redaction, T05 role auth, T06 audit).
//
// Design invariants:
//   * SFE score is data-informed but human-owned: system_evidence (buildSfeEvidence) is stored
//     ALONGSIDE the SFE user's score/comments/overrides — never conflated. Overrides carry a reason.
//   * HR assessment is available by default for this field-force module (Med Reps + DMs), gated
//     only by the admin config.hrAssessmentEnabled switch. HR enters a score with the field-relevant
//     auto signals (leave/deductions) + HR judgment. If an admin disables it, submit is refused and
//     the HR component reports "unavailable".
//   * Confidential notes are visible only to HR (probation admin) / CEO — redacted otherwise.

import { writeAuditLog } from "@/lib/admin/audit";
import { normalizeHrId, type AccessContext } from "@/lib/auth/permissions";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { isProbationAdministrator } from "@/lib/probation/service";

import { assertCaseAcceptsSubmissions } from "./cases";
import { getProbationConfig } from "./config";
import { buildSfeEvidence } from "./sfe-evidence";
import { buildHrEvidence } from "./hr-evidence";
import { probationEndDate } from "@/lib/probation/date";
import type { ProbationAssessment, ProbationAssessmentKind } from "./types";

// ── Role authorization (P5-T05) ──────────────────────────────────────────────

export function canSubmitSfeAssessment(access: Pick<AccessContext, "role" | "scope">): boolean {
  return access.role === "SFE Manager" || isProbationAdministrator(access);
}

export function canSubmitHrAssessment(access: Pick<AccessContext, "role" | "scope">): boolean {
  // HR authority = Super Admin (the B-10 HR Manager account) / system.
  return isProbationAdministrator(access);
}

/** Confidential HR/SFE notes are visible only to HR (probation admin) and the CEO. */
export function canSeeConfidentialNote(access: Pick<AccessContext, "role" | "scope">): boolean {
  return access.role === "CEO" || isProbationAdministrator(access);
}

// ── Types + mapping ───────────────────────────────────────────────────────────

type AssessmentRow = {
  id: string; case_id: string; employee_hr_id: string; kind: ProbationAssessmentKind;
  system_evidence: Record<string, unknown>; score: number | null; comments: string | null;
  overrides: Record<string, unknown>; override_reason: string | null; confidential_note: string | null;
  status: "pending" | "submitted" | "unavailable"; submitted_by: string | null;
  submitted_at: string | null; created_at: string; updated_at: string;
};

const COLS =
  "id, case_id, employee_hr_id, kind, system_evidence, score, comments, overrides, " +
  "override_reason, confidential_note, status, submitted_by, submitted_at, created_at, updated_at";

function mapAssessment(row: AssessmentRow, redactConfidential: boolean): ProbationAssessment {
  return {
    id: row.id, caseId: row.case_id, employeeHrId: row.employee_hr_id, kind: row.kind,
    systemEvidence: row.system_evidence ?? {}, score: row.score, comments: row.comments,
    overrides: row.overrides ?? {}, overrideReason: row.override_reason,
    confidentialNote: redactConfidential ? null : row.confidential_note,
    status: row.status, submittedBy: row.submitted_by, submittedAt: row.submitted_at,
    createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

type CaseRow = {
  id: string; employee_hr_id: string; hire_date: string | null;
  probation_start_date: string | null; probation_end_date: string | null;
};

async function loadCase(caseId: string): Promise<CaseRow | null> {
  const { data, error } = await getSupabaseAdmin()
    .from("probation_cases")
    .select("id, employee_hr_id, hire_date, probation_start_date, probation_end_date")
    .eq("id", caseId)
    .maybeSingle();
  if (error) throw error;
  return (data as CaseRow | null) ?? null;
}

function todayDateOnly(): string {
  return new Date().toISOString().slice(0, 10);
}

/** SFE evidence window: probation start (or hire) → min(probation end, today). */
function evidenceWindow(c: CaseRow): { from: string | null; to: string } {
  const from = c.probation_start_date ?? c.hire_date ?? null;
  const end = c.probation_end_date ?? probationEndDate(c.hire_date) ?? todayDateOnly();
  const today = todayDateOnly();
  return { from, to: end < today ? end : today };
}

export type AssessmentInput = {
  score?: number | null;
  comments?: string | null;
  overrides?: Record<string, unknown> | null;
  overrideReason?: string | null;
  confidentialNote?: string | null;
};

// Resolve the confidential note to persist WITHOUT letting a caller who cannot see the note wipe it.
// The SFE/HR row is a single upsert shared by the SFE Manager (cannot see the note) and HR/CEO (can).
// A privileged caller's value wins (empty clears); a non-privileged caller preserves the existing note.
async function resolveConfidentialNote(
  access: AccessContext,
  caseId: string,
  kind: ProbationAssessmentKind,
  inputNote: string | null | undefined,
): Promise<string | null> {
  if (canSeeConfidentialNote(access)) return inputNote ?? null;
  const { data } = await getSupabaseAdmin()
    .from("probation_assessments")
    .select("confidential_note")
    .eq("case_id", caseId)
    .eq("kind", kind)
    .maybeSingle();
  return (data as { confidential_note?: string | null } | null)?.confidential_note ?? null;
}

function validateScore(score: number | null | undefined, min: number, max: number): number | null {
  if (score === null || score === undefined) return null;
  const n = Number(score);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new Error(`Validation failed: score must be an integer between ${min} and ${max}.`);
  }
  return n;
}

// ── SFE submit (P5-T02) ──────────────────────────────────────────────────────

export async function submitSfeAssessment(
  access: AccessContext,
  caseId: string,
  input: AssessmentInput,
): Promise<ProbationAssessment> {
  if (!canSubmitSfeAssessment(access)) {
    throw new Error("Forbidden: only the SFE Manager (or a probation administrator) may submit the SFE assessment.");
  }
  const c = await loadCase(caseId);
  if (!c) throw new Error("Not found: probation case does not exist.");

  const config = await getProbationConfig();
  const score = validateScore(input.score, config.scoringScale.min, config.scoringScale.max);
  if ((input.overrides && Object.keys(input.overrides).length > 0) && !(input.overrideReason && input.overrideReason.trim())) {
    throw new Error("Validation failed: an override reason is required when overriding system evidence.");
  }

  // Recompute the system evidence at submit time so the human score sits next to fresh data.
  const evidence = await buildSfeEvidence(c.employee_hr_id, evidenceWindow(c));

  const assessment = await upsertAssessment(access, c, "sfe", {
    system_evidence: evidence as unknown as Record<string, unknown>,
    score,
    comments: input.comments ?? null,
    overrides: input.overrides ?? {},
    override_reason: input.overrideReason ?? null,
    confidential_note: await resolveConfidentialNote(access, c.id, "sfe", input.confidentialNote),
    status: "submitted",
  });

  await writeAuditLog({
    actorLoginId: access.loginId ?? normalizeHrId(access.hrId),
    entityType: "probation_assessment",
    entityId: assessment.id,
    newValues: { kind: "sfe", score, hasOverride: Boolean(input.overrides && Object.keys(input.overrides).length) },
    summary: `Probation SFE assessment submitted for ${c.employee_hr_id}`,
  });
  return assessment;
}

// ── HR submit (P5-T03, gated) ────────────────────────────────────────────────

export async function submitHrAssessment(
  access: AccessContext,
  caseId: string,
  input: AssessmentInput,
): Promise<ProbationAssessment> {
  if (!canSubmitHrAssessment(access)) {
    throw new Error("Forbidden: only HR (a probation administrator) may submit the HR assessment.");
  }
  const config = await getProbationConfig();
  if (!config.hrAssessmentEnabled) {
    throw new Error("Blocked: the HR assessment is currently disabled by an administrator.");
  }
  const c = await loadCase(caseId);
  if (!c) throw new Error("Not found: probation case does not exist.");

  const score = validateScore(input.score, config.scoringScale.min, config.scoringScale.max);
  const evidence = await buildHrEvidence(c.employee_hr_id, evidenceWindow(c));

  const assessment = await upsertAssessment(access, c, "hr", {
    system_evidence: evidence as unknown as Record<string, unknown>,
    score,
    comments: input.comments ?? null,
    overrides: input.overrides ?? {},
    override_reason: input.overrideReason ?? null,
    confidential_note: await resolveConfidentialNote(access, c.id, "hr", input.confidentialNote),
    status: "submitted",
  });

  await writeAuditLog({
    actorLoginId: access.loginId ?? normalizeHrId(access.hrId),
    entityType: "probation_assessment",
    entityId: assessment.id,
    newValues: { kind: "hr", score },
    summary: `Probation HR assessment submitted for ${c.employee_hr_id}`,
  });
  return assessment;
}

async function upsertAssessment(
  access: AccessContext,
  c: CaseRow,
  kind: ProbationAssessmentKind,
  fields: Omit<AssessmentRow, "id" | "case_id" | "employee_hr_id" | "kind" | "submitted_by" | "submitted_at" | "created_at" | "updated_at">,
): Promise<ProbationAssessment> {
  // Post-decision lock (Phase 10): a decided case accepts no further assessment input.
  await assertCaseAcceptsSubmissions(c.id);
  const now = new Date().toISOString();
  const actorHrId = normalizeHrId(access.hrId) || access.loginId || access.role;
  const { data, error } = await getSupabaseAdmin()
    .from("probation_assessments")
    .upsert(
      {
        case_id: c.id,
        employee_hr_id: c.employee_hr_id,
        kind,
        ...fields,
        submitted_by: actorHrId,
        submitted_at: now,
        updated_at: now,
      },
      { onConflict: "case_id,kind" },
    )
    .select(COLS)
    .single();
  if (error) throw error;
  return mapAssessment(data as unknown as AssessmentRow, false);
}

// ── Read (P5-T04 confidential redaction) ─────────────────────────────────────

export type CaseAssessments = {
  sfe: ProbationAssessment | null;
  hr: ProbationAssessment | { kind: "hr"; status: "unavailable" | "pending"; reason: string } | null;
  hrAssessmentEnabled: boolean;
};

/** Live SFE evidence preview for a case (fresh KPI aggregation), for the SFE review screen. */
export async function getSfeEvidencePreview(caseId: string) {
  const c = await loadCase(caseId);
  if (!c) throw new Error("Not found: probation case does not exist.");
  return buildSfeEvidence(c.employee_hr_id, evidenceWindow(c));
}

/** Live HR evidence preview (limited signals; the rest reported unavailable). */
export async function getHrEvidencePreview(caseId: string) {
  const c = await loadCase(caseId);
  if (!c) throw new Error("Not found: probation case does not exist.");
  return buildHrEvidence(c.employee_hr_id, evidenceWindow(c));
}

export async function getCaseAssessments(access: AccessContext, caseId: string): Promise<CaseAssessments> {
  const config = await getProbationConfig();
  const redact = !canSeeConfidentialNote(access);
  const { data, error } = await getSupabaseAdmin()
    .from("probation_assessments")
    .select(COLS)
    .eq("case_id", caseId);
  if (error) throw error;

  const rows = (data ?? []) as unknown as AssessmentRow[];
  const sfe = rows.find((r) => r.kind === "sfe") ?? null;
  const hr = rows.find((r) => r.kind === "hr") ?? null;

  return {
    sfe: sfe ? mapAssessment(sfe, redact) : null,
    hr: hr
      ? mapAssessment(hr, redact)
      : {
          kind: "hr",
          status: config.hrAssessmentEnabled ? "pending" : "unavailable",
          reason: config.hrAssessmentEnabled
            ? "HR assessment not yet submitted."
            : "HR assessment currently disabled by an administrator.",
        },
    hrAssessmentEnabled: config.hrAssessmentEnabled,
  };
}
