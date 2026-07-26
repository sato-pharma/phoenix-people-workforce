// Unified Deductions module: service layer. NEVER writes salary_records/
// salary_batches — this module's only outputs (once Phase 2 lands) are
// deductions_publications/deductions_publication_lines. Governance-only here.

import { writeAuditLog } from "@/lib/admin/audit";
import type { AccessContext } from "@/lib/auth/permissions";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { fetchAllRows } from "@/lib/supabase/paginated";
import { isEligibleForPublish } from "./calculations.ts";
import { findDayCollisions } from "./conflict.ts";
import { assertDeductionsDecisionActor } from "./permissions.ts";
import {
  buildDeductionsCandidateKey,
  compactDeductionsHrId,
  normalizeDates,
  normalizeMonthKey,
} from "./candidate-key.ts";
import {
  deductionsCalculationStatuses,
  deductionsCategories,
  deductionsDecisionStatuses,
  deductionsSeverities,
  deductionsUnits,
  type DeductionsCandidate,
  type DeductionsCandidateDraft,
  type DeductionsCandidateWithDecision,
  type DeductionsDecision,
  type DeductionsDecisionStatus,
} from "./types.ts";

export type CandidateValidationResult = {
  valid: boolean;
  errors: string[];
};

export function validateCandidateDraft(draft: DeductionsCandidateDraft): CandidateValidationResult {
  const errors: string[] = [];
  if (!draft || typeof draft !== "object") {
    return { valid: false, errors: ["draft must be an object"] };
  }

  if (!deductionsCategories.includes(draft.category)) {
    errors.push(`category "${String(draft.category)}" is not recognized`);
  }
  if (typeof draft.sourceSystem !== "string" || !draft.sourceSystem.trim()) {
    errors.push("sourceSystem must be a non-empty string");
  }
  if (typeof draft.sourceRecordId !== "string" || !draft.sourceRecordId.trim()) {
    errors.push("sourceRecordId must be a non-empty string");
  }
  if (typeof draft.employeeHrId !== "string" || !draft.employeeHrId.trim()) {
    errors.push("employeeHrId must be a non-empty string");
  } else if (!compactDeductionsHrId(draft.employeeHrId)) {
    errors.push("employeeHrId could not be normalized to a canonical HR_ID");
  }

  let normalizedMonthKey: string | null = null;
  if (typeof draft.monthKey !== "string" || !draft.monthKey.trim()) {
    errors.push("monthKey must be a non-empty string");
  } else {
    try {
      normalizedMonthKey = normalizeMonthKey(draft.monthKey);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  if (!Number.isInteger(draft.month) || draft.month < 1 || draft.month > 12) {
    errors.push("month must be an integer between 1 and 12");
  }
  if (!Number.isInteger(draft.year) || draft.year < 2000 || draft.year > 2100) {
    errors.push("year must be an integer between 2000 and 2100");
  }
  if (normalizedMonthKey) {
    const [yearStr, monthStr] = normalizedMonthKey.split("-");
    if (Number.parseInt(yearStr, 10) !== draft.year) {
      errors.push(`year ${draft.year} does not match monthKey ${normalizedMonthKey}`);
    }
    if (Number.parseInt(monthStr, 10) !== draft.month) {
      errors.push(`month ${draft.month} does not match monthKey ${normalizedMonthKey}`);
    }
  }

  if (!deductionsUnits.includes(draft.unit)) {
    errors.push(`unit "${String(draft.unit)}" is not recognized`);
  }
  if (typeof draft.rawValue !== "number" || !Number.isFinite(draft.rawValue) || draft.rawValue < 0) {
    errors.push("rawValue must be a finite non-negative number");
  }
  if (draft.estimatedAmount !== undefined && draft.estimatedAmount !== null) {
    if (typeof draft.estimatedAmount !== "number" || !Number.isFinite(draft.estimatedAmount)) {
      errors.push("estimatedAmount must be a finite number when provided");
    }
  }
  if (draft.calculationStatus !== undefined && !deductionsCalculationStatuses.includes(draft.calculationStatus)) {
    errors.push(`calculationStatus "${String(draft.calculationStatus)}" is not recognized`);
  }
  if (draft.severity !== undefined && draft.severity !== null && !deductionsSeverities.includes(draft.severity)) {
    errors.push(`severity "${String(draft.severity)}" is not recognized`);
  }
  if (!Array.isArray(draft.dates) || draft.dates.length === 0) {
    errors.push("dates must be a non-empty array");
  } else {
    try {
      const normalized = normalizeDates(draft.dates);
      // Every date must fall inside the candidate's own month. A candidate
      // carrying out-of-month dates is how a leave request spanning a month
      // boundary silently got deducted twice — once in each month, each time
      // for the FULL span. It also breaks same-day overlap detection, which
      // groups by (employee, month, day).
      if (normalizedMonthKey) {
        const outOfMonth = normalized.filter((date) => !date.startsWith(`${normalizedMonthKey}-`));
        if (outOfMonth.length > 0) {
          errors.push(
            `dates must fall inside monthKey ${normalizedMonthKey}; found ${outOfMonth.length} outside it (${outOfMonth.slice(0, 3).join(", ")}${outOfMonth.length > 3 ? ", …" : ""})`,
          );
        }
      }
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }

  return { valid: errors.length === 0, errors };
}

type CandidateInsertPayload = {
  category: string;
  source_system: string;
  source_record_id: string;
  candidate_key: string;
  employee_hr_id: string;
  employee_hr_id_compact: string;
  employee_name: string | null;
  month_key: string;
  month: number;
  year: number;
  unit: string;
  raw_value: number;
  estimated_amount: number | null;
  calculation_status: string;
  severity: string | null;
  reason: string | null;
  evidence: Record<string, unknown>;
  dates: string[];
  hierarchy_snapshot: Record<string, unknown>;
  created_by: string;
};

export function prepareCandidateInsertPayload(
  draft: DeductionsCandidateDraft,
  options: { createdBy: string },
): CandidateInsertPayload {
  const validation = validateCandidateDraft(draft);
  if (!validation.valid) {
    throw new Error(`Invalid deductions candidate draft: ${validation.errors.join("; ")}`);
  }
  if (!options?.createdBy?.trim()) {
    throw new Error("prepareCandidateInsertPayload requires options.createdBy");
  }

  const compactHr = compactDeductionsHrId(draft.employeeHrId);
  if (!compactHr) {
    throw new Error("employeeHrId could not be normalized to a canonical HR_ID");
  }

  const normalizedMonthKey = normalizeMonthKey(draft.monthKey);
  const normalizedDates = normalizeDates(draft.dates);
  const candidateKey = buildDeductionsCandidateKey({
    sourceSystem: draft.sourceSystem,
    sourceRecordId: draft.sourceRecordId,
    employeeHrId: draft.employeeHrId,
    monthKey: draft.monthKey,
    category: draft.category,
    dates: draft.dates,
  });

  return {
    category: draft.category,
    source_system: draft.sourceSystem.trim(),
    source_record_id: draft.sourceRecordId.trim(),
    candidate_key: candidateKey,
    employee_hr_id: draft.employeeHrId.trim(),
    employee_hr_id_compact: compactHr,
    employee_name: draft.employeeName ?? null,
    month_key: normalizedMonthKey,
    month: draft.month,
    year: draft.year,
    unit: draft.unit,
    raw_value: draft.rawValue,
    estimated_amount: draft.estimatedAmount ?? null,
    calculation_status: draft.calculationStatus ?? "requires_review",
    severity: draft.severity ?? null,
    reason: draft.reason ?? null,
    evidence: draft.evidence ?? {},
    dates: normalizedDates,
    hierarchy_snapshot: draft.hierarchySnapshot ?? {},
    created_by: options.createdBy.trim(),
  };
}

export type CandidateDraftInsertResult = {
  created: number;
  skippedExisting: number;
  superseded?: number;
  warnings: string[];
};

/**
 * Retires a live candidate, optionally pointing at the row that replaces it.
 *
 * This is the ONLY sanctioned way to change a candidate that has already been
 * published: `locked_at` plus the guard trigger make published values
 * immutable in place, deliberately — a number an employee has already seen
 * must never silently change under them. Correction happens by superseding
 * (this row is retired, a new row states the truth) so the history of what was
 * claimed, and when, stays intact and auditable.
 *
 * Nothing in the module wrote `superseded_at` before this existed, which meant
 * a vacation later corrected to paid, or CRM visits that synced in late, still
 * got deducted with no way to fix it.
 */
export async function supersedeCandidate(input: {
  candidateId: string;
  reason: string;
  actorHrId: string;
  replacementCandidateId?: string | null;
}): Promise<void> {
  if (!input.reason?.trim()) {
    throw new Error("Validation: a reason is required to supersede a deduction candidate.");
  }
  const supabase = getSupabaseAdmin();
  const { error } = await supabase
    .from("deductions_candidates")
    .update({
      superseded_at: new Date().toISOString(),
      superseded_by_candidate_id: input.replacementCandidateId ?? null,
    })
    .eq("id", input.candidateId)
    .is("superseded_at", null);
  if (error) throw new Error(`Failed to supersede candidate ${input.candidateId}: ${error.message}`);

  // Module-specific audit trail (mirrors automated_payroll_audit's shape).
  // Best-effort: a failed audit insert must never block the correction itself.
  try {
    await supabase.from("deductions_audit").insert({
      candidate_id: input.candidateId,
      actor_hr_id: input.actorHrId,
      action: "superseded",
      detail: { reason: input.reason.trim(), replacementCandidateId: input.replacementCandidateId ?? null },
    });
  } catch {
    // swallowed on purpose — see above
  }

  try {
    await writeAuditLog({
      actorLoginId: input.actorHrId,
      entityId: input.candidateId,
      entityType: "deductions_candidate",
      newValues: { supersededBy: input.replacementCandidateId ?? null, reason: input.reason.trim() },
      summary: "Deduction candidate superseded",
    });
  } catch {
    // writeAuditLog already swallows; defensive.
  }
}

/**
 * Bulk insert-only sync: skips a draft whose deterministic candidate_key
 * already exists live (the unique partial index on (category, candidate_key)
 * WHERE superseded_at IS NULL is the real idempotency guarantee — this probe
 * is just an early, cheaper check). Auto-creates each candidate's paired
 * decision row (default "Pending", or `autoDecideStatus` when the caller
 * knows every draft should start pre-decided — e.g. a manual HR entry).
 */
export async function insertCandidateDrafts(input: {
  createdBy: string;
  drafts: DeductionsCandidateDraft[];
  sourceLabel: string;
  autoDecideStatus?: DeductionsDecisionStatus;
  autoDecideReason?: string;
}): Promise<CandidateDraftInsertResult> {
  if (!input.createdBy?.trim()) {
    throw new Error("insertCandidateDrafts requires createdBy");
  }
  const supabase = getSupabaseAdmin();
  let created = 0;
  let skippedExisting = 0;
  const warnings: string[] = [];

  for (const draft of input.drafts) {
    let payload: CandidateInsertPayload;
    try {
      payload = prepareCandidateInsertPayload(draft, { createdBy: input.createdBy });
    } catch (error) {
      warnings.push(`${input.sourceLabel}: invalid draft: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }

    const probe = await supabase
      .from("deductions_candidates")
      .select("id")
      .eq("category", payload.category)
      .eq("candidate_key", payload.candidate_key)
      .is("superseded_at", null)
      .limit(1);
    if (probe.error) {
      warnings.push(`${input.sourceLabel}: duplicate probe failed: ${probe.error.message}`);
      continue;
    }
    if (Array.isArray(probe.data) && probe.data.length > 0) {
      skippedExisting += 1;
      continue;
    }

    const insert = await supabase.from("deductions_candidates").insert(payload).select("id").single();
    if (insert.error) {
      const code = (insert.error as { code?: string }).code ?? "";
      if (code === "23505") {
        skippedExisting += 1;
        continue;
      }
      warnings.push(`${input.sourceLabel}: insert failed: ${insert.error.message}`);
      continue;
    }

    created += 1;
    const candidateId = (insert.data as { id?: string } | null)?.id ?? null;

    if (candidateId) {
      const decisionPayload = input.autoDecideStatus
        ? {
            candidate_id: candidateId,
            decision_status: input.autoDecideStatus,
            decision_reason: input.autoDecideReason ?? `Auto-decided at insert (${input.sourceLabel})`,
            decided_by: input.createdBy,
            decided_at: new Date().toISOString(),
            actor_role_at_decision: "system",
          }
        : { candidate_id: candidateId };
      const decisionInsert = await supabase.from("deductions_decisions").insert(decisionPayload);
      if (decisionInsert.error) {
        warnings.push(`${input.sourceLabel}: paired decision row failed for candidate ${candidateId}: ${decisionInsert.error.message}`);
      }
    }

    try {
      await writeAuditLog({
        actorLoginId: input.createdBy,
        entityId: candidateId,
        entityType: "deductions_candidate",
        newValues: payload as unknown as Record<string, unknown>,
        summary: `Deduction candidate created from ${input.sourceLabel}`,
      });
    } catch {
      // writeAuditLog already swallows; defensive in case a custom logger throws.
    }
  }

  // Surface cross-category day collisions as warnings, not failures.
  //
  // Three detectors noticing the same absence day is expected and reviewable —
  // aborting the collection run over it would be wrong. But the collision must
  // be VISIBLE now rather than first appearing as a publish-time rejection at
  // the end of the month, so HR can clear the wrong one while there is still
  // time. publishMonth enforces it hard (findDayCollisions), and a DB trigger
  // backstops the publication itself.
  if (created > 0) {
    const monthKeys = new Set(input.drafts.map((draft) => draft.monthKey));
    for (const monthKey of monthKeys) {
      try {
        const live = await listCandidatesForMonth({ monthKey });
        const collisions = findDayCollisions(live);
        for (const collision of collisions.slice(0, 20)) {
          warnings.push(
            `${input.sourceLabel}: ${collision.employeeName ?? collision.employeeHrId} (${collision.employeeHrId}) is claimed on ${collision.date} by ${collision.categories.join(" + ")} — clear the wrong one or the month cannot be published.`,
          );
        }
        if (collisions.length > 20) {
          warnings.push(`${input.sourceLabel}: …and ${collisions.length - 20} more overlapping employee-day(s).`);
        }
      } catch (error) {
        warnings.push(
          `${input.sourceLabel}: overlap check could not run for ${monthKey}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  return { created, skippedExisting, warnings };
}

/**
 * Reconciles a connector's fresh output against what is already in the ledger:
 * inserts what's new, and RETIRES live unlocked candidates that the source no
 * longer supports.
 *
 * Implemented once here rather than in each of the five connectors — they all
 * emit drafts, so the diff belongs in the layer that owns the ledger.
 *
 * The problem this solves: connectors were insert-only. A vacation later
 * corrected from unpaid to paid, a fingerprint day later covered by a
 * back-dated excuse, or CRM visits that synced in after collection all left
 * their original candidate standing — and it was still deducted. Re-running
 * collection could not fix it either, because the candidate_key was unchanged
 * so the duplicate probe simply skipped it.
 *
 * Locked (published) candidates are never touched here: correcting those is a
 * deliberate, audited act via supersedeCandidate + republish, not a silent
 * side effect of a nightly re-collect.
 */
export async function reconcileCandidateDrafts(input: {
  createdBy: string;
  drafts: DeductionsCandidateDraft[];
  sourceLabel: string;
  /** Category + month this run authoritatively covers. Anything live in this
   *  scope that the fresh drafts no longer contain is considered retracted. */
  scope: { category: DeductionsCandidate["category"]; monthKey: string };
  autoDecideStatus?: DeductionsDecisionStatus;
  autoDecideReason?: string;
}): Promise<CandidateDraftInsertResult> {
  const insertResult = await insertCandidateDrafts({
    createdBy: input.createdBy,
    drafts: input.drafts,
    sourceLabel: input.sourceLabel,
    autoDecideStatus: input.autoDecideStatus,
    autoDecideReason: input.autoDecideReason,
  });

  const warnings = [...insertResult.warnings];
  let superseded = 0;

  try {
    const live = await listCandidatesForMonth({
      monthKey: input.scope.monthKey,
      category: input.scope.category,
    });

    // Fresh drafts, keyed the same deterministic way the ledger keys them.
    const freshKeys = new Set<string>();
    for (const draft of input.drafts) {
      try {
        freshKeys.add(prepareCandidateInsertPayload(draft, { createdBy: input.createdBy }).candidate_key);
      } catch {
        // Invalid drafts are already reported by insertCandidateDrafts.
      }
    }

    for (const candidate of live) {
      if (freshKeys.has(candidate.candidateKey)) continue;
      // Published numbers are immutable by design — never silently retract one.
      if (candidate.lockedAt) {
        warnings.push(
          `${input.sourceLabel}: ${candidate.employeeName ?? candidate.employeeHrId} (${candidate.employeeHrId}) is no longer supported by the source, but was already published on ${String(candidate.lockedAt).slice(0, 10)} — correct it deliberately rather than automatically.`,
        );
        continue;
      }
      await supersedeCandidate({
        candidateId: candidate.id,
        reason: `Source data no longer supports this candidate (re-collected by ${input.sourceLabel})`,
        actorHrId: input.createdBy,
      });
      superseded += 1;
    }
  } catch (error) {
    warnings.push(
      `${input.sourceLabel}: reconcile pass failed (new candidates were still inserted): ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  return { ...insertResult, superseded, warnings };
}

function mapCandidateRow(row: Record<string, unknown>): DeductionsCandidate {
  return {
    id: String(row.id),
    category: row.category as DeductionsCandidate["category"],
    sourceSystem: String(row.source_system),
    sourceRecordId: String(row.source_record_id),
    candidateKey: String(row.candidate_key),
    employeeHrId: String(row.employee_hr_id),
    employeeHrIdCompact: String(row.employee_hr_id_compact),
    employeeName: (row.employee_name as string | null) ?? null,
    monthKey: String(row.month_key),
    month: Number(row.month),
    year: Number(row.year),
    unit: row.unit as DeductionsCandidate["unit"],
    rawValue: Number(row.raw_value),
    estimatedAmount: row.estimated_amount == null ? null : Number(row.estimated_amount),
    calculationStatus: row.calculation_status as DeductionsCandidate["calculationStatus"],
    severity: (row.severity as DeductionsCandidate["severity"]) ?? null,
    reason: (row.reason as string | null) ?? null,
    evidence: (row.evidence as Record<string, unknown>) ?? {},
    dates: Array.isArray(row.dates) ? (row.dates as string[]) : [],
    hierarchySnapshot: (row.hierarchy_snapshot as Record<string, unknown>) ?? {},
    createdBy: String(row.created_by),
    createdAt: String(row.created_at),
    refreshedAt: (row.refreshed_at as string | null) ?? null,
    lockedAt: (row.locked_at as string | null) ?? null,
    supersededAt: (row.superseded_at as string | null) ?? null,
    supersededByCandidateId: (row.superseded_by_candidate_id as string | null) ?? null,
  };
}

function mapDecisionRow(row: Record<string, unknown> | null): DeductionsDecision | null {
  if (!row) return null;
  return {
    id: String(row.id),
    candidateId: String(row.candidate_id),
    decisionStatus: row.decision_status as DeductionsDecisionStatus,
    decisionReason: String(row.decision_reason ?? ""),
    hrNote: String(row.hr_note ?? ""),
    appliedValue: row.applied_value == null ? null : Number(row.applied_value),
    appliedAmount: row.applied_amount == null ? null : Number(row.applied_amount),
    decidedBy: (row.decided_by as string | null) ?? null,
    decidedAt: (row.decided_at as string | null) ?? null,
    actorRoleAtDecision: (row.actor_role_at_decision as string | null) ?? null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

type CandidateRowWithDecision = Record<string, unknown> & {
  deductions_decisions: Record<string, unknown>[] | Record<string, unknown> | null;
};

/**
 * Live (non-superseded) candidate count for a month — the independent physical
 * counter used to prove a read was not silently truncated. Deliberately a
 * separate `head: true` count rather than trusting the fetched array length,
 * mirroring the "independent counter" discipline in sales-upload's
 * buildReconciliation.
 */
export async function countCandidatesForMonth(input: {
  monthKey: string;
  category?: DeductionsCandidate["category"];
  employeeHrIdCompact?: string;
}): Promise<number> {
  const monthKey = normalizeMonthKey(input.monthKey);
  let query = getSupabaseAdmin()
    .from("deductions_candidates")
    .select("id", { count: "exact", head: true })
    .eq("month_key", monthKey)
    .is("superseded_at", null);
  if (input.category) query = query.eq("category", input.category);
  if (input.employeeHrIdCompact) query = query.eq("employee_hr_id_compact", input.employeeHrIdCompact);
  const { count, error } = await query;
  if (error) throw new Error(`Failed to count deduction candidates: ${error.message}`);
  return count ?? 0;
}

/**
 * Live (non-superseded) candidates for a month, optionally scoped to one category, joined with their decision.
 *
 * Paginated via fetchAllRows: PostgREST caps every response at db-max-rows
 * (default 1000), and a real month can exceed 2,000 candidates — an unbounded
 * select silently dropped the remainder, and `publishMonth` then published only
 * what it received while reporting success.
 */
export async function listCandidatesForMonth(input: {
  monthKey: string;
  category?: DeductionsCandidate["category"];
  employeeHrIdCompact?: string;
}): Promise<DeductionsCandidateWithDecision[]> {
  const monthKey = normalizeMonthKey(input.monthKey);
  const supabase = getSupabaseAdmin();
  const buildQuery = () => {
    let query = supabase
      .from("deductions_candidates")
      .select("*, deductions_decisions(*)")
      .eq("month_key", monthKey)
      .is("superseded_at", null);
    if (input.category) query = query.eq("category", input.category);
    if (input.employeeHrIdCompact) query = query.eq("employee_hr_id_compact", input.employeeHrIdCompact);
    // Ordered by id, not employee_name: fetchAllRows pages with .range(), which
    // needs a stable total order. employee_name is nullable and non-unique, so
    // paging on it can repeat or skip rows at page boundaries. Callers that need
    // display order sort in memory below.
    return query.order("id", { ascending: true });
  };

  const rows = await fetchAllRows<CandidateRowWithDecision>(buildQuery);

  return rows
    .map((row) => {
      const { deductions_decisions: decisionRaw, ...candidateRow } = row;
      const decisionRow = Array.isArray(decisionRaw) ? (decisionRaw[0] ?? null) : decisionRaw;
      return {
        ...mapCandidateRow(candidateRow),
        decision: mapDecisionRow(decisionRow),
      };
    })
    .sort((left, right) => String(left.employeeName ?? "").localeCompare(String(right.employeeName ?? "")));
}

export type EmployeeMonthDeductionSummary = {
  employeeHrId: string;
  employeeName: string | null;
  monthKey: string;
  byCategory: Partial<Record<DeductionsCandidate["category"], { days: number; amount: number; candidateCount: number }>>;
  totalAmount: number;
};

/** The per-employee deduction summary — every category's totals for one employee, one month. */
export async function getEmployeeMonthSummary(input: {
  monthKey: string;
  employeeHrId: string;
}): Promise<EmployeeMonthDeductionSummary | null> {
  const compact = compactDeductionsHrId(input.employeeHrId);
  if (!compact) return null;
  const candidates = await listCandidatesForMonth({ monthKey: input.monthKey, employeeHrIdCompact: compact });
  if (candidates.length === 0) return null;

  const byCategory: EmployeeMonthDeductionSummary["byCategory"] = {};
  let totalAmount = 0;
  for (const candidate of candidates) {
    if (candidate.decision?.decisionStatus === "Do Not Take Action") continue;
    const amount = candidate.decision?.appliedAmount ?? candidate.estimatedAmount ?? 0;
    const days = candidate.unit === "days" ? (candidate.decision?.appliedValue ?? candidate.rawValue) : 0;
    const entry = byCategory[candidate.category] ?? { days: 0, amount: 0, candidateCount: 0 };
    entry.days += days;
    entry.amount += amount;
    entry.candidateCount += 1;
    byCategory[candidate.category] = entry;
    totalAmount += amount;
  }

  return {
    employeeHrId: candidates[0].employeeHrId,
    employeeName: candidates[0].employeeName,
    monthKey: normalizeMonthKey(input.monthKey),
    byCategory,
    totalAmount: Math.round(totalAmount * 100) / 100,
  };
}

export type CategorySummaryBucket = {
  candidateCount: number;
  employeeCount: number;
  totalAmount: number;
};

export type CompanyMonthSummary = {
  /** What pressing Publish right now would actually commit. */
  willPublish: Record<DeductionsCandidate["category"], CategorySummaryBucket>;
  /** Detected but NOT eligible yet — awaiting a decision. Will not be deducted. */
  pending: Record<DeductionsCandidate["category"], CategorySummaryBucket>;
  willPublishTotal: number;
  pendingTotal: number;
};

function emptyBuckets(): Record<DeductionsCandidate["category"], CategorySummaryBucket> {
  const result = {} as Record<DeductionsCandidate["category"], CategorySummaryBucket>;
  for (const category of deductionsCategories) {
    result[category] = { candidateCount: 0, employeeCount: 0, totalAmount: 0 };
  }
  return result;
}

/**
 * Company-wide totals by category for a month — the admin Overview tab.
 *
 * Reports TWO figures, deliberately. The old single total counted every
 * candidate that wasn't explicitly cleared (including Pending ones), while
 * publish only takes "Approved for Payroll" for the six approval-required
 * categories — so on a freshly-collected month Overview read ~384,000 EGP
 * while Publish would emit ~118,000. HR reasonably acted on the bigger number.
 * `willPublish` uses the exact same predicate publishMonth uses, so the two can
 * never disagree again; `pending` is the gap, stated explicitly rather than
 * silently folded in.
 */
export async function getCompanyMonthSummaryByCategory(input: {
  monthKey: string;
}): Promise<CompanyMonthSummary> {
  const candidates = await listCandidatesForMonth({ monthKey: input.monthKey });

  const willPublish = emptyBuckets();
  const pending = emptyBuckets();
  const willPublishEmployees = new Map<string, Set<string>>();
  const pendingEmployees = new Map<string, Set<string>>();

  for (const candidate of candidates) {
    if (candidate.decision?.decisionStatus === "Do Not Take Action") continue;
    const eligible = isEligibleForPublish(candidate);
    const bucket = eligible ? willPublish[candidate.category] : pending[candidate.category];
    const employees = eligible ? willPublishEmployees : pendingEmployees;
    bucket.candidateCount += 1;
    bucket.totalAmount += candidate.decision?.appliedAmount ?? candidate.estimatedAmount ?? 0;
    const seen = employees.get(candidate.category) ?? new Set<string>();
    seen.add(candidate.employeeHrIdCompact);
    employees.set(candidate.category, seen);
  }

  let willPublishTotal = 0;
  let pendingTotal = 0;
  for (const category of deductionsCategories) {
    willPublish[category].employeeCount = willPublishEmployees.get(category)?.size ?? 0;
    willPublish[category].totalAmount = Math.round(willPublish[category].totalAmount * 100) / 100;
    pending[category].employeeCount = pendingEmployees.get(category)?.size ?? 0;
    pending[category].totalAmount = Math.round(pending[category].totalAmount * 100) / 100;
    willPublishTotal += willPublish[category].totalAmount;
    pendingTotal += pending[category].totalAmount;
  }

  return {
    willPublish,
    pending,
    willPublishTotal: Math.round(willPublishTotal * 100) / 100,
    pendingTotal: Math.round(pendingTotal * 100) / 100,
  };
}

/** Super-Admin-gated: record or update a candidate's decision. */
export async function recordDecision(input: {
  actor: Pick<AccessContext, "role" | "hrId" | "loginId">;
  candidateId: string;
  decisionStatus: DeductionsDecisionStatus;
  decisionReason: string;
  hrNote?: string;
  appliedValue?: number | null;
  appliedAmount?: number | null;
}): Promise<DeductionsDecision> {
  assertDeductionsDecisionActor(input.actor);
  if (!deductionsDecisionStatuses.includes(input.decisionStatus)) {
    throw new Error(`Validation: decisionStatus "${input.decisionStatus}" is not recognized`);
  }
  if (input.decisionStatus !== "Pending" && !input.decisionReason.trim()) {
    throw new Error("Validation: decisionReason is required for a non-Pending decision");
  }

  const supabase = getSupabaseAdmin();
  const candidate = await supabase.from("deductions_candidates").select("id, locked_at").eq("id", input.candidateId).single();
  if (candidate.error) throw new Error(`Not found: deductions candidate could not be loaded (${candidate.error.message})`);
  if ((candidate.data as { locked_at: string | null }).locked_at) {
    throw new Error("Conflict: this candidate is locked by a publication — it can no longer be decided directly.");
  }

  const now = new Date().toISOString();
  const payload = {
    candidate_id: input.candidateId,
    decision_status: input.decisionStatus,
    decision_reason: input.decisionStatus === "Pending" ? "" : input.decisionReason.trim(),
    hr_note: input.hrNote?.trim() ?? "",
    applied_value: input.appliedValue ?? null,
    applied_amount: input.appliedAmount ?? null,
    decided_by: input.actor.hrId ?? input.actor.loginId ?? null,
    decided_at: now,
    actor_role_at_decision: input.actor.role,
  };

  const { data, error } = await supabase
    .from("deductions_decisions")
    .upsert(payload, { onConflict: "candidate_id" })
    .select("*")
    .single();
  if (error) throw new Error(`Failed to save the deduction decision: ${error.message}`);

  await writeAuditLog({
    actorLoginId: input.actor.loginId ?? input.actor.hrId ?? "unknown",
    entityId: input.candidateId,
    entityType: "deductions_decision",
    newValues: payload as unknown as Record<string, unknown>,
    summary: `Deductions decision recorded: ${input.decisionStatus}`,
  });

  return mapDecisionRow(data as Record<string, unknown>)!;
}
