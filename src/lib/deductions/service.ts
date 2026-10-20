// Unified Deductions module: service layer. NEVER writes salary_records/
// salary_batches — this module's only outputs (once Phase 2 lands) are
// deductions_publications/deductions_publication_lines. Governance-only here.

import { writeAuditLog } from "@/lib/admin/audit";
import {
  describeDeductionResyncNotApplied,
  resyncPayrollDeductionSteps,
} from "@/lib/automated-payroll/deduction-resync";
import type { AccessContext } from "@/lib/auth/permissions";
import { isTerminalEmploymentStatus } from "@/lib/auth/session-lifecycle";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { fetchAllRows } from "@/lib/supabase/paginated";
import {
  carriedAppliedFigures,
  daysForTickedDates,
  isEligibleForPublish,
  normalizeAppliedDeductionDates,
  resolveAppliedDeductionDates,
  resolveCarriedDecision,
  scaleDeductionAmountToDays,
} from "./calculations.ts";
import { findDayCollisions } from "./conflict.ts";
import { dropDeductionExemptDrafts } from "./exempt-employees.ts";
import { computeHolidayBridgeDays, isFieldForceWorkingDay, type HolidayBridgeDay } from "./holiday-bridge.ts";
import { getConfirmedNationalHolidays } from "@/lib/vacation/national-holidays";
import { effectiveSettlement } from "@/lib/attendance/digest-rules.ts";
import { assertDeductionsDecisionActor } from "./permissions.ts";
import { getLeaveBalanceChargeForCandidate } from "./leave-balance-ledger.ts";
import {
  buildDeductionsCandidateKey,
  compactDeductionsHrId,
  deductionsCandidateIdentityKey,
  normalizeDates,
  normalizeMonthKey,
} from "./candidate-key.ts";
import {
  deductionsCalculationStatuses,
  deductionsCategories,
  deductionsDecisionStatuses,
  deductionsSeverities,
  deductionsUnits,
  isLeaveBalanceCategory,
  type DeductionsCandidate,
  type DeductionsCandidateDraft,
  type DeductionsCandidateWithDecision,
  type DeductionsCategory,
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

// NOTE: no `month_key`. On deductions_candidates that column is
// GENERATED ALWAYS AS (year || '-' || lpad(month,2,'0')) STORED, and Postgres
// rejects any INSERT that supplies a value for it (SQLSTATE 428C9,
// "cannot insert a non-DEFAULT value into column"). Sending it made EVERY
// insert fail — the first real production run produced 0 candidates and 120
// "insert failed" warnings. month + year below are the inputs the database
// derives it from; keep it out of this type so it cannot be reintroduced.
type CandidateInsertPayload = {
  category: string;
  source_system: string;
  source_record_id: string;
  candidate_key: string;
  employee_hr_id: string;
  employee_hr_id_compact: string;
  employee_name: string | null;
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

  // Still normalized (it throws on a malformed monthKey) even though the value
  // is no longer sent — the database derives month_key from month + year.
  normalizeMonthKey(draft.monthKey);
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
    // month_key is deliberately NOT sent — the column is GENERATED ALWAYS.
    // normalizedMonthKey above is still computed because validating it is how
    // a draft whose month/year disagree with its monthKey gets rejected.
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
  /** Newly inserted candidate ids keyed by IDENTITY (the candidate key without its dates hash), so
   * a reconcile pass can pair a retired row with the row that replaced it. Absent on the
   * fail-closed early returns, where nothing was inserted. */
  insertedByIdentity?: ReadonlyMap<string, string>;
  skippedExisting: number;
  superseded?: number;
  /** Decisions carried onto a replacement candidate by a reconcile pass. */
  decisionsCarried?: number;
  /** Decisions a reconcile pass reset to Pending because the replacement covered days the
   * approver had never seen. */
  decisionsReset?: number;
  warnings: string[];
};

// Batch sizes for insertCandidateDrafts. The probe chunk is the smaller of the
// two because those keys go into a PostgREST `in.(…)` filter on the URL, which
// has a header-size ceiling (see #1294); the insert chunk travels in the body
// and only needs to stay a reasonable statement size.
// The duplicate probe sends candidate_keys in a PostgREST `in.(…)` filter, which
// travels in the URL. Budget by ENCODED BYTES, not row count: measured in
// production, candidate_key runs ~69 chars for fingerprint but averages 145 and
// peaks at 367 for CRM, so a flat 200-row chunk built a ~73 KB URL and the
// request failed outright. 3,000 encoded chars leaves ample room for the base
// URL, the select list and the other filters inside a typical 8 KB limit.
const PROBE_URL_BUDGET_CHARS = 3_000;
const CANDIDATE_INSERT_CHUNK = 500;

/**
 * Splits items so the URL-encoded length of their keys stays inside `budget`.
 * A single oversized key still gets its own chunk rather than being dropped —
 * losing a candidate silently is far worse than one long request.
 */
export function chunkByEncodedLength<T>(
  items: readonly T[],
  keyOf: (item: T) => string,
  budget: number,
): T[][] {
  const chunks: T[][] = [];
  let current: T[] = [];
  let used = 0;
  for (const item of items) {
    // +3 for the comma and the quoting PostgREST adds around each value.
    const cost = encodeURIComponent(keyOf(item)).length + 3;
    if (current.length > 0 && used + cost > budget) {
      chunks.push(current);
      current = [];
      used = 0;
    }
    current.push(item);
    used += cost;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

/**
 * Exported for test: a chunking bug here does not throw, it silently drops
 * candidates from a payroll run — the exact failure class that is invisible
 * until someone is deducted the wrong amount.
 */
export function chunkList<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

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

  // ── Batched, not per-draft ────────────────────────────────────────────────
  // This loop used to do FOUR sequential round-trips per draft (probe, insert
  // candidate, insert decision, audit). Cost scaled linearly with candidates,
  // which is what put a company-wide collection run over the 300s Cloud Run
  // limit and got the module reverted (#1377). Measured on production data,
  // July 2026 yields ~301 CRM no-activity candidates alone — ~1,200 sequential
  // queries for one connector. Everything below is chunked so the round-trip
  // count is bounded by batches rather than by rows.

  // 1. Validate locally first — no I/O at all in this pass.
  const payloads: CandidateInsertPayload[] = [];
  // Owner-exempt people are never raised by an AUTOMATED writer. A manual HR entry
  // (autoDecideStatus set) is the owner's own deliberate act and passes through.
  const writable = input.autoDecideStatus ? input.drafts : dropDeductionExemptDrafts(input.drafts).kept;
  for (const draft of writable) {
    try {
      payloads.push(prepareCandidateInsertPayload(draft, { createdBy: input.createdBy }));
    } catch (error) {
      warnings.push(`${input.sourceLabel}: invalid draft: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // Collapse duplicates WITHIN the batch. The per-draft version could never see
  // these (each probe ran before its own insert); a bulk insert would send both
  // rows in one statement and lose the whole chunk to the unique index.
  const pairKey = (categoryValue: string, candidateKey: string) => `${categoryValue}\u0000${candidateKey}`;
  const seenInBatch = new Set<string>();
  const deduped: CandidateInsertPayload[] = [];
  for (const payload of payloads) {
    const key = pairKey(payload.category, payload.candidate_key);
    if (seenInBatch.has(key)) {
      skippedExisting += 1;
      continue;
    }
    seenInBatch.add(key);
    deduped.push(payload);
  }

  // 2. One probe per chunk instead of one per draft. Filtering on candidate_key
  //    alone and pairing with category in memory keeps the URL short; the
  //    (category, candidate_key) pair is what actually decides a duplicate.
  //
  //    Chunked by URL BYTES, not by row count. These keys go into a PostgREST
  //    `in.(…)` filter that travels in the URL, and candidate_key length varies
  //    hugely by category — measured in production: fingerprint ~69 chars, crm
  //    averages 145 and reaches 367. A flat 200-row chunk therefore built a
  //    ~73 KB URL and the request died as `TypeError: fetch failed`, which
  //    (correctly) failed the run closed and collected nothing.
  const alreadyLive = new Set<string>();
  let probeFailed = false;

  const probeChunk = async (chunk: CandidateInsertPayload[]): Promise<boolean> => {
    const probe = await supabase
      .from("deductions_candidates")
      .select("category, candidate_key")
      .in("candidate_key", chunk.map((payload) => payload.candidate_key))
      .is("superseded_at", null);
    if (!probe.error) {
      for (const row of (probe.data ?? []) as Array<{ category: string; candidate_key: string }>) {
        alreadyLive.add(pairKey(row.category, row.candidate_key));
      }
      return true;
    }
    // Self-heal rather than trust the budget: if a chunk still fails, split it
    // and retry. A single key can always be sent alone, so this terminates —
    // and it means no future key-length surprise can break collection again.
    if (chunk.length > 1) {
      const mid = Math.ceil(chunk.length / 2);
      const left = await probeChunk(chunk.slice(0, mid));
      const right = await probeChunk(chunk.slice(mid));
      return left && right;
    }
    warnings.push(`${input.sourceLabel}: duplicate probe failed: ${probe.error.message}`);
    return false;
  };

  for (const chunk of chunkByEncodedLength(deduped, (payload) => payload.candidate_key, PROBE_URL_BUDGET_CHARS)) {
    if (!(await probeChunk(chunk))) {
      probeFailed = true;
      break;
    }
  }
  // Fail closed: without a trustworthy probe we cannot tell new from existing,
  // and guessing here would either double-insert or silently skip real rows.
  if (probeFailed) return { created: 0, skippedExisting, warnings };

  const toInsert = deduped.filter((payload) => {
    if (alreadyLive.has(pairKey(payload.category, payload.candidate_key))) {
      skippedExisting += 1;
      return false;
    }
    return true;
  });

  // 3. Bulk insert. A chunk that trips the unique index (another run racing us)
  //    is retried row-by-row so one collision cannot discard its whole chunk.
  const insertedByKey = new Map<string, string>();
  for (const chunk of chunkList(toInsert, CANDIDATE_INSERT_CHUNK)) {
    const bulk = await supabase.from("deductions_candidates").insert(chunk).select("id, category, candidate_key");
    if (!bulk.error) {
      for (const row of (bulk.data ?? []) as Array<{ id: string; category: string; candidate_key: string }>) {
        insertedByKey.set(pairKey(row.category, row.candidate_key), row.id);
        created += 1;
      }
      continue;
    }
    for (const payload of chunk) {
      const single = await supabase.from("deductions_candidates").insert(payload).select("id").single();
      if (single.error) {
        if ((single.error as { code?: string }).code === "23505") skippedExisting += 1;
        else warnings.push(`${input.sourceLabel}: insert failed: ${single.error.message}`);
        continue;
      }
      const id = (single.data as { id?: string } | null)?.id;
      if (id) insertedByKey.set(pairKey(payload.category, payload.candidate_key), id);
      created += 1;
    }
  }

  // 4. Paired decision rows, bulk. Built as two concrete arrays rather than one
  //    array of a ternary: the generated Supabase insert types infer the row
  //    shape from the argument, and a union of "full row" | "candidate_id only"
  //    resolves to the full row with every other column typed `undefined`.
  const insertedIds = [...insertedByKey.values()];
  for (const chunk of chunkList(insertedIds, CANDIDATE_INSERT_CHUNK)) {
    const decisionInsert = input.autoDecideStatus
      ? await supabase.from("deductions_decisions").insert(
          chunk.map((candidateId) => ({
            candidate_id: candidateId,
            decision_status: input.autoDecideStatus!,
            decision_reason: input.autoDecideReason ?? `Auto-decided at insert (${input.sourceLabel})`,
            decided_by: input.createdBy,
            decided_at: new Date().toISOString(),
            actor_role_at_decision: "system",
          })),
        )
      : await supabase.from("deductions_decisions").insert(chunk.map((candidateId) => ({ candidate_id: candidateId })));
    if (decisionInsert.error) {
      warnings.push(`${input.sourceLabel}: paired decision rows failed for ${chunk.length} candidate(s): ${decisionInsert.error.message}`);
    }
  }

  // 5. Audit — one row PER CANDIDATE. This is a financial ledger; collapsing it
  //    to a per-batch summary would lose the per-row trail.
  //
  //    WRITTEN SEQUENTIALLY ON PURPOSE. A previous version fanned these out 25 at
  //    a time with Promise.all. Measured against production it silently lost 43
  //    of 57 fingerprint audit rows — scattered at random, with no error surfaced,
  //    because writeAuditLog swallows its own failures. An audit trail that is
  //    usually complete is not an audit trail. Sequential is the shape the
  //    original had, and it lost nothing.
  //
  //    This is NOT where the latency was: the win came from collapsing the probe
  //    and insert path from ~4 round-trips per candidate to a handful of chunked
  //    calls. Audit was always going to be one write per row.
  const auditable = toInsert.filter((payload) => insertedByKey.has(pairKey(payload.category, payload.candidate_key)));
  let auditWritten = 0;
  for (const payload of auditable) {
    try {
      await writeAuditLog({
        actorLoginId: input.createdBy,
        entityId: insertedByKey.get(pairKey(payload.category, payload.candidate_key)) ?? null,
        entityType: "deductions_candidate",
        newValues: payload as unknown as Record<string, unknown>,
        summary: `Deduction candidate created from ${input.sourceLabel}`,
      });
      auditWritten += 1;
    } catch {
      // writeAuditLog swallows internally; this only guards a custom logger throwing.
    }
  }
  // Never let a short audit trail pass silently again — if the count does not
  // match, say so where someone will actually read it.
  if (auditWritten < auditable.length) {
    warnings.push(
      `${input.sourceLabel}: audit trail incomplete — ${auditWritten} of ${auditable.length} candidate(s) were logged. The candidates were created; their audit rows were not.`,
    );
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
        // Applied days, not detected days — same basis publishMonth uses. A day
        // the reviewer already unticked is resolved, and re-warning about it
        // would tell them to go clear something they have already cleared.
        const collisions = findDayCollisions(
          live.map((candidate) => ({ ...candidate, dates: resolveAppliedDeductionDates(candidate) })),
        );
        for (const collision of collisions.slice(0, 20)) {
          warnings.push(
            // Employee NAME only — never the HR code.
            `${input.sourceLabel}: ${collision.employeeName ?? collision.employeeHrId} is claimed on ${collision.date} by ${collision.categories.join(" + ")} — clear the wrong one or the month cannot be published.`,
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

  // Keyed by IDENTITY (the candidate key minus its dates hash) so a caller can pair a row it is
  // about to retire with the row that replaced it. See deductionsCandidateIdentityKey.
  const insertedByIdentity = new Map<string, string>();
  for (const [key, id] of insertedByKey) {
    const candidateKey = key.slice(key.indexOf("\u0000") + 1);
    insertedByIdentity.set(deductionsCandidateIdentityKey(candidateKey), id);
  }

  return { created, insertedByIdentity, skippedExisting, warnings };
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
   *  scope that the fresh drafts no longer contain is considered retracted.
   *
   *  `sourceSystems` narrows that authority to the sources this collector actually writes. Without
   *  it a category with more than one writer could not reconcile at all: `crm` is fed by both
   *  `crm_visits_mirror` and `dsm_no_record`, and `other` by both `holiday_bridge` and `manual_hr`,
   *  so a whole-category pass would retire the other writer's rows on every run. That is why four
   *  of six collectors were left insert-only — and being insert-only is why a corrected re-collect
   *  adds a SECOND live row beside the wrong one instead of replacing it. */
  scope: {
    category: DeductionsCandidate["category"];
    monthKey: string;
    sourceSystems?: readonly string[];
  };
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
  const supabase = getSupabaseAdmin();
  let superseded = 0;
  let decisionsCarried = 0;
  let decisionsReset = 0;
  // Employees whose APPROVED deduction this pass retired, re-derived or dropped —
  // every one of which can leave a confirmed Automated Payroll step frozen on a
  // figure the module has just moved. Resynced once after the pass (see below).
  const payrollResyncCompacts = new Set<string>();

  try {
    const live = await listCandidatesForMonth({
      monthKey: input.scope.monthKey,
      category: input.scope.category,
    });

    // Fresh drafts, keyed the same deterministic way the ledger keys them. `datesByIdentity` is
    // what lets a retired row find the days its replacement now covers, which is the input the
    // carry-forward rule needs.
    const freshKeys = new Set<string>();
    const datesByIdentity = new Map<string, string[]>();
    // The replacement's OWN estimate and detected-day count, by identity — what a narrowed or
    // zeroed carried decision scales its applied_amount from (see the carry write below).
    const replacementByIdentity = new Map<string, { estimatedAmount: number | null; rawValue: number }>();
    for (const draft of input.drafts) {
      try {
        const payload = prepareCandidateInsertPayload(draft, { createdBy: input.createdBy });
        freshKeys.add(payload.candidate_key);
        const identity = deductionsCandidateIdentityKey(payload.candidate_key);
        datesByIdentity.set(identity, payload.dates);
        replacementByIdentity.set(identity, {
          estimatedAmount: draft.estimatedAmount ?? null,
          rawValue: Number(draft.rawValue ?? 0),
        });
      } catch {
        // Invalid drafts are already reported by insertCandidateDrafts.
      }
    }

    const scoped = input.scope.sourceSystems
      ? live.filter((candidate) => input.scope.sourceSystems!.includes(candidate.sourceSystem))
      : live;

    // A SOURCE THAT PRODUCED NOTHING DOES NOT GET TO RETIRE EVERYTHING.
    //
    // Retirement is driven by absence: a live candidate whose key is not in the fresh set is
    // treated as retracted. That is right when the source ran and genuinely no longer supports a
    // row. It is catastrophic when the source ran and produced nothing at all, because then EVERY
    // live candidate in scope is absent, and one collection run silently wipes the month's
    // deductions.
    //
    // An outright empty draft set is far more likely to mean the source failed than that a month
    // is genuinely clean — and when a month IS genuinely clean there are no live candidates to
    // retire either, so this guard costs nothing in the honest case. It only bites when the source
    // says "nothing" while the ledger holds live rows, which is precisely the suspicious shape.
    //
    // The connector's own read errors already throw, and collect.ts turns those into a warning
    // without reconciling. This is the backstop for a read that returns empty WITHOUT throwing.
    if (input.drafts.length === 0 && scoped.length > 0) {
      warnings.push(
        `${input.sourceLabel}: produced no candidates at all while ${scoped.length} live one(s) exist for ` +
          `${input.scope.category} ${input.scope.monthKey}. Nothing was retired — a source that returns ` +
          "nothing is treated as a failed read, not as a retraction of the whole month. Re-run the " +
          "collection once the source is healthy.",
      );
      return {
        created: insertResult.created,
        skippedExisting: insertResult.skippedExisting,
        insertedByIdentity: insertResult.insertedByIdentity,
        warnings,
      };
    }

    for (const candidate of scoped) {
      if (freshKeys.has(candidate.candidateKey)) continue;
      // Published numbers are immutable by design — never silently retract one.
      if (candidate.lockedAt) {
        warnings.push(
          `${input.sourceLabel}: ${candidate.employeeName ?? candidate.employeeHrId} (${candidate.employeeHrId}) is no longer supported by the source, but was already published on ${String(candidate.lockedAt).slice(0, 10)} — correct it deliberately rather than automatically.`,
        );
        continue;
      }
      // Pair the row being retired with the row that replaced it. The candidate_key changes
      // whenever the day set changes, so the pairing has to be on the IDENTITY underneath it —
      // otherwise a recalculation is indistinguishable from a brand-new finding, which is exactly
      // why superseded_by_candidate_id was NULL on every row and 21 approvals were lost.
      const identity = deductionsCandidateIdentityKey(candidate.candidateKey);
      const replacementCandidateId = insertResult.insertedByIdentity?.get(identity) ?? null;

      await supersedeCandidate({
        candidateId: candidate.id,
        reason: replacementCandidateId
          ? `Re-calculated by ${input.sourceLabel} (replaced by a fresh candidate)`
          : `Source data no longer supports this candidate (re-collected by ${input.sourceLabel})`,
        actorHrId: input.createdBy,
        replacementCandidateId,
      });
      superseded += 1;

      const previous = candidate.decision;
      const previousStatus = previous?.decisionStatus ?? "Pending";
      if (previousStatus === "Pending") continue;

      // Only an APPROVED decision reaches the payroll sheet (deductions-source.ts),
      // so only an approved one now being retired, re-derived onto a replacement, or
      // dropped to Pending can leave a confirmed Automated Payroll step frozen on a
      // stale figure. Collect the employee and resync after the pass — the same
      // safeguard recordDecision and the manual route already apply to a single
      // decision. A non-approved row charges 0.00 before and after and is left alone.
      if (previousStatus === "Approved for Payroll" && candidate.employeeHrIdCompact) {
        payrollResyncCompacts.add(candidate.employeeHrIdCompact);
      }

      // A decided row is being retired. Either carry that decision onto its replacement, or — if
      // there is no replacement — say so loudly, because silently dropping an approval is how
      // 9,306.42 EGP of review work disappeared and had to be re-entered by hand.
      if (!replacementCandidateId) {
        warnings.push(
          `${input.sourceLabel}: ${candidate.employeeName ?? candidate.employeeHrId} had a "${previousStatus}" decision that the source no longer supports — it was retired, not carried. Re-review if that is wrong.`,
        );
        continue;
      }

      const carried = resolveCarriedDecision({
        previousAppliedDates: previous?.appliedDates ?? null,
        previousDates: candidate.dates,
        previousReason: previous?.decisionReason ?? "",
        previousStatus,
        replacementDates: datesByIdentity.get(identity) ?? [],
      });
      if (!carried) continue;

      // The figures are re-expressed against the REPLACEMENT, never carried from the old day set.
      //   - A never-narrowed selection (appliedDates null) keeps both figures null, so the publish
      //     resolvers re-derive the replacement's full value/amount — the only figure that matches
      //     what the reviewer now sees on screen.
      //   - A NARROWED or EMPTIED selection pins value + amount to that subset. Leaving them null
      //     here was the bug: the resolvers' `?? rawValue` / `?? estimatedAmount` fallback then
      //     republished a narrowed approval at FULL and re-armed a zeroed one to a full charge.
      const replacement = replacementByIdentity.get(identity) ?? { estimatedAmount: null, rawValue: 0 };
      const { appliedValue, appliedAmount } = carriedAppliedFigures({
        appliedDates: carried.appliedDates,
        // The replacement's FULL day set — the denominator for the retained fraction, so a
        // fractional-day candidate (a fingerprint half-day is rawValue 0.5 on one date) is not
        // re-charged as a full day by counting dates against its fractional rawValue.
        replacementDates: datesByIdentity.get(identity) ?? [],
        replacementEstimatedAmount: replacement.estimatedAmount,
        replacementRawValue: replacement.rawValue,
      });
      const { error: carryError } = await supabase
        .from("deductions_decisions")
        .update({
          applied_dates: carried.appliedDates,
          applied_amount: appliedAmount,
          applied_value: appliedValue,
          decision_reason: carried.decisionReason,
          decision_status: carried.decisionStatus,
          updated_at: new Date().toISOString(),
        })
        .eq("candidate_id", replacementCandidateId);

      if (carryError) {
        warnings.push(
          `${input.sourceLabel}: could not carry the "${previousStatus}" decision for ${candidate.employeeName ?? candidate.employeeHrId} onto the re-calculated candidate: ${carryError.message}`,
        );
        continue;
      }

      if (carried.droppedToPending) {
        decisionsReset += 1;
        warnings.push(
          `${input.sourceLabel}: ${candidate.employeeName ?? candidate.employeeHrId} was "${previousStatus}", but the re-calculated deduction now covers days that decision never saw — reset to Pending for re-review.`,
        );
      } else {
        decisionsCarried += 1;
      }
    }

    // One resync for the whole pass: clear the frozen columns and re-open any
    // confirmed step that owns a moved figure, so the sheet re-derives from the
    // live candidates rather than paying a figure the re-collect has superseded.
    // Never throws; a run whose Part 2 is already confirmed comes back as a
    // warning the caller can surface, exactly as the single-decision paths do.
    if (payrollResyncCompacts.size > 0) {
      const resync = await resyncPayrollDeductionSteps({
        monthKey: normalizeMonthKey(input.scope.monthKey),
        employees: Array.from(payrollResyncCompacts, (hrIdCompact) => ({
          hrIdCompact,
          categories: [input.scope.category],
        })),
      });
      warnings.push(...describeDeductionResyncNotApplied(resync));
    }
  } catch (error) {
    warnings.push(
      `${input.sourceLabel}: reconcile pass failed (new candidates were still inserted): ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  return { ...insertResult, decisionsCarried, decisionsReset, superseded, warnings };
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
    // null (never narrowed) and [] (every day cleared) are different answers, so
    // this must not collapse to `?? []`. A non-array — which is what a read gets
    // back if the applied_dates migration has not been applied yet — is treated
    // as "never narrowed", so the read path degrades to today's behaviour rather
    // than to a company-wide 0.00 EGP.
    appliedDates: Array.isArray(row.applied_dates) ? (row.applied_dates as string[]) : null,
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
 * The month the unified Deductions module became the system of record — the first month it holds
 * HR-decided candidates (production has none before it). From here on the module owns every month,
 * so `describeUnifiedDeductionsConflict` refuses the legacy sheet path for these months structurally,
 * not merely when candidate rows happen to exist yet. `YYYY-MM`, compared lexically — safe because the
 * month is zero-padded, so string order matches chronological order across years.
 */
export const DEDUCTIONS_CUTOVER_MONTH_KEY = "2026-07";

/**
 * Guard for a payroll path that does NOT read this module.
 *
 * WHY. Two deduction systems shipped side by side with table names one letter apart —
 * `deductions_candidates`/`deductions_decisions` (this module, where HR actually decides) and
 * `deduction_candidates`/`deduction_decisions` (the older governance flow). The Payroll Copilot's
 * sheet generation still reads the SECOND. Measured on production 2026-08-06 for 2026-07: it would
 * charge ~224,216.71 EGP of CRM deductions off legacy rows nobody approved, against 28,233.87 EGP
 * HR actually approved here. `startRun` refuses once a salary batch exists for the period — but no
 * July batch exists, so today nothing refuses.
 *
 * Refusal has TWO tiers. From the cutover month (`DEDUCTIONS_CUTOVER_MONTH_KEY`) onward this module
 * is the system of record for EVERY month, so the legacy sheet path is refused STRUCTURALLY — whether
 * or not that month's collection has run yet. The old row-count-only rule could not do this: an
 * untouched cutover month (the state on the 1st, before collection) counts zero live candidates and
 * would wave the legacy sheet through in exactly the window it is most dangerous. For pre-cutover
 * months, which predate this module, the row-count rule stands as a safety net — refuse only if a
 * candidate was ever backfilled there, otherwise there is genuinely nothing to conflict with.
 *
 * DELIBERATELY NOT APPLIED to Automated Payroll's own publish path: that one already reads this
 * module through `loadConfirmedDeductions`, and it never reads `deductions_publications` at all —
 * so gating it on "a publication exists" would deadlock it permanently, since publishing deductions
 * has never been a prerequisite for paying anyone. Its problem is a stale latched figure, which is a
 * different fix.
 */
export async function describeUnifiedDeductionsConflict(input: {
  month: number;
  year: number;
}): Promise<string | null> {
  const monthKey = normalizeMonthKey(`${input.year}-${String(input.month).padStart(2, "0")}`);

  // Structural refusal (mossy-ocean C4). Month keys are zero-padded `YYYY-MM`, so a lexical `>=`
  // orders them correctly across years. From the cutover the module owns the month unconditionally,
  // so an empty September must refuse just as a populated July does.
  if (monthKey >= DEDUCTIONS_CUTOVER_MONTH_KEY) {
    return (
      `The Deductions module is the system of record for ${monthKey} — every month from ` +
      `${DEDUCTIONS_CUTOVER_MONTH_KEY} onward is decided there, whether or not its collection has run. ` +
      "This screen reads the older deductions tables, so generating a sheet here would charge figures " +
      "that were never reviewed in the Deductions workspace. Use Automated Payroll for this month."
    );
  }

  // Pre-cutover safety net: those months predate the module and legacy was legitimate there, but
  // still refuse if a candidate was ever backfilled into this module for one of them.
  const liveCandidates = await countCandidatesForMonth({ monthKey });
  if (liveCandidates === 0) return null;
  return (
    `The Deductions module holds ${liveCandidates} live deduction candidate(s) for ${monthKey}. ` +
    "This screen reads the older deductions tables, so generating a sheet here would charge figures " +
    "that were never reviewed in the Deductions workspace. Use Automated Payroll for this month."
  );
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
  /**
   * Also return RETIRED candidates. Off by default, and it must stay that way: a superseded row is
   * exactly what the module no longer stands behind, so everything that decides money keeps seeing
   * only the live ones. The reconciliation report is the single caller that needs them — to compare
   * a published run against the approvals it was actually built on, not against the module as it
   * looks weeks later. See `loadConfirmedDeductions`'s `countSupersededApprovedAfter`.
   */
  includeSuperseded?: boolean;
}): Promise<DeductionsCandidateWithDecision[]> {
  const monthKey = normalizeMonthKey(input.monthKey);
  const supabase = getSupabaseAdmin();
  const buildQuery = () => {
    let query = supabase
      .from("deductions_candidates")
      .select("*, deductions_decisions(*)")
      .eq("month_key", monthKey);
    if (!input.includeSuperseded) query = query.is("superseded_at", null);
    if (input.category) query = query.eq("category", input.category);
    if (input.employeeHrIdCompact) query = query.eq("employee_hr_id_compact", input.employeeHrIdCompact);
    return query;
  };

  // Tiebreak on id, not employee_name: fetchAllRows pages with .range(), which
  // needs a stable total order. employee_name is nullable and non-unique, so
  // paging on it can repeat or skip rows at page boundaries. Callers that need
  // display order sort in memory below.
  const [rows, directory, bridgeDays] = await Promise.all([
    fetchAllRows<CandidateRowWithDecision>(buildQuery, "id"),
    getEmployeeDirectory(),
    getHolidayBridgeDaysForMonth(monthKey),
  ]);
  // Annotation only — an unreachable calendar just means no badges on the table,
  // which is harmless. The CONNECTOR refuses outright in that case; see there.
  const bridgeByDate = new Map(bridgeDays.bridgeDays.map((bridge) => [bridge.date, bridge]));

  return rows
    .map((row) => {
      const { deductions_decisions: decisionRaw, ...candidateRow } = row;
      const decisionRow = Array.isArray(decisionRaw) ? (decisionRaw[0] ?? null) : decisionRaw;
      const candidate = mapCandidateRow(candidateRow);
      const known = directory.get(candidate.employeeHrIdCompact);
      const storedName = candidate.employeeName?.trim();
      return {
        ...candidate,
        // The stored name wins when it exists — it is the name as at collection
        // time. The directory only fills the gap that made a code appear.
        employeeName: storedName || known?.fullName?.trim() || null,
        hireDate: known?.hireDate ?? null,
        // Which of THIS candidate's days sit directly beside a governmental
        // holiday. Annotation only — it explains a row, it does not change what
        // the row charges.
        holidayBridges: candidate.dates
          .map((date) => bridgeByDate.get(date))
          .filter((bridge): bridge is HolidayBridgeDay => Boolean(bridge)),
        decision: mapDecisionRow(decisionRow),
      };
    })
    // Sorted AFTER resolution, so a candidate that arrived without a name is
    // filed under the name the reviewer actually sees rather than at the top.
    .sort((left, right) => String(left.employeeName ?? "").localeCompare(String(right.employeeName ?? "")));
}

/**
 * The governmental-holiday bridge days that land inside this month.
 *
 * Holidays from the ADJACENT months are pulled in too: a holiday on the 1st
 * bridges the last working day of the prior month, and one on the 31st bridges
 * into the next — reading only this month's holidays would silently drop both.
 *
 * Defensive on purpose. This annotates rows for display; a holiday-calendar
 * hiccup must show an unannotated table, never fail the whole deductions read.
 */
export async function getHolidayBridgeDaysForMonth(
  monthKey: string,
): Promise<{ bridgeDays: HolidayBridgeDay[]; calendarReachable: boolean }> {
  const [yearStr, monthStr] = monthKey.split("-");
  const year = Number.parseInt(yearStr ?? "", 10);
  const month = Number.parseInt(monthStr ?? "", 10);
  if (!Number.isFinite(year) || !Number.isFinite(month)) return { bridgeDays: [], calendarReachable: false };

  const periods = [
    month === 1 ? { month: 12, year: year - 1 } : { month: month - 1, year },
    { month, year },
    month === 12 ? { month: 1, year: year + 1 } : { month: month + 1, year },
  ];

  try {
    const results = await Promise.all(periods.map((period) => getConfirmedNationalHolidays(period)));
    // Every month must have been READ, not merely "connected". When the Egypt
    // holiday calendar is unreachable the result can still carry a hardcoded
    // company entry while every public holiday is missing — and a missing
    // holiday reads downstream as an ordinary working day. That would let this
    // flag a day that was actually a national holiday and deduct a day's pay
    // for it. The module's own doc comment warns money-safe consumers to gate
    // on exactly this flag.
    const calendarReachable = results.every((result) => result.calendarReachable);
    const seen = new Set<string>();
    const holidays = [];
    for (const result of results) {
      for (const holiday of result.holidays) {
        if (seen.has(holiday.id)) continue;
        seen.add(holiday.id);
        holidays.push({
          id: holiday.id,
          name: holiday.name,
          startDate: holiday.startDate,
          endDate: holiday.endDate ?? null,
        });
      }
    }
    return {
      bridgeDays: computeHolidayBridgeDays({ holidays, monthKey, isWorkingDay: isFieldForceWorkingDay }),
      calendarReachable,
    };
  } catch {
    return { bridgeDays: [], calendarReachable: false };
  }
}

type EmployeeDirectoryEntry = { fullName: string | null; hireDate: string | null };

/**
 * Compact-HR-key -> name and hire date, for display only.
 *
 * The candidate stores `employee_name` as it was at collection time and it is
 * sometimes null, which made the workspace print the HR code instead — barred:
 * a person is shown by name, never by a code. Resolving here rather than in the
 * component keeps every consumer (table, mobile cards, XLSX export) on one
 * answer.
 *
 * Deliberately non-fatal: this is presentation, and a directory hiccup must
 * never take down a deductions read. A miss degrades to whatever the candidate
 * already carried.
 */
async function getEmployeeDirectory(): Promise<Map<string, EmployeeDirectoryEntry>> {
  const map = new Map<string, EmployeeDirectoryEntry>();
  try {
    const rows = await fetchAllRows<{ hr_id: string; full_name: string | null; hire_date: string | null }>(
      () => getSupabaseAdmin().from("employees").select("hr_id, full_name, hire_date"),
      "hr_id",
    );
    for (const row of rows) {
      const key = compactDeductionsHrId(String(row.hr_id ?? ""));
      if (key) map.set(key, { fullName: row.full_name ?? null, hireDate: row.hire_date ?? null });
    }
  } catch {
    // Swallowed on purpose — see the doc comment above.
  }
  return map;
}

export type EmployeeCategoryBucket = { days: number; amount: number; candidateCount: number };

export type EmployeeMonthDeductionSummary = {
  employeeHrId: string;
  employeeName: string | null;
  monthKey: string;
  /** What pressing Publish right now would actually deduct from THIS employee. */
  willPublish: Partial<Record<DeductionsCandidate["category"], EmployeeCategoryBucket>>;
  /** Detected but NOT eligible yet — awaiting a decision. Will not be deducted. */
  pending: Partial<Record<DeductionsCandidate["category"], EmployeeCategoryBucket>>;
  willPublishTotal: number;
  pendingTotal: number;
};

/**
 * The per-employee split, pure and exported so it can be tested without a DB.
 *
 * Uses `isEligibleForPublish` — the predicate publishMonth itself uses — for the
 * identical reason getCompanyMonthSummaryByCategory does: six of the seven
 * categories publish only on an explicit "Approved for Payroll", so summing
 * every not-cleared candidate tells an employee they will lose money that
 * publishing will never take. On production 2026-07 that made one person's card
 * read 6,183.86 EGP against a real deduction of 0.00. Splitting the two figures
 * here is what keeps the By Employee tab and the Overview tab in agreement by
 * construction rather than by two hand-maintained rules.
 */
export function summarizeEmployeeMonthCandidates(input: {
  candidates: readonly DeductionsCandidateWithDecision[];
  monthKey: string;
}): EmployeeMonthDeductionSummary | null {
  if (input.candidates.length === 0) return null;

  const willPublish: EmployeeMonthDeductionSummary["willPublish"] = {};
  const pending: EmployeeMonthDeductionSummary["pending"] = {};
  let willPublishTotal = 0;
  let pendingTotal = 0;
  for (const candidate of input.candidates) {
    if (candidate.decision?.decisionStatus === "Do Not Take Action") continue;
    const amount = candidate.decision?.appliedAmount ?? candidate.estimatedAmount ?? 0;
    const days = candidate.unit === "days" ? (candidate.decision?.appliedValue ?? candidate.rawValue) : 0;
    const eligible = isEligibleForPublish(candidate);
    const target = eligible ? willPublish : pending;
    const entry = target[candidate.category] ?? { days: 0, amount: 0, candidateCount: 0 };
    entry.days += days;
    entry.amount += amount;
    entry.candidateCount += 1;
    target[candidate.category] = entry;
    if (eligible) willPublishTotal += amount;
    else pendingTotal += amount;
  }

  for (const category of deductionsCategories) {
    const publishable = willPublish[category];
    if (publishable) publishable.amount = Math.round(publishable.amount * 100) / 100;
    const awaiting = pending[category];
    if (awaiting) awaiting.amount = Math.round(awaiting.amount * 100) / 100;
  }

  return {
    employeeHrId: input.candidates[0].employeeHrId,
    employeeName: input.candidates[0].employeeName,
    monthKey: normalizeMonthKey(input.monthKey),
    willPublish,
    pending,
    willPublishTotal: Math.round(willPublishTotal * 100) / 100,
    pendingTotal: Math.round(pendingTotal * 100) / 100,
  };
}

/** The per-employee deduction summary — every category's totals for one employee, one month. */
export async function getEmployeeMonthSummary(input: {
  monthKey: string;
  employeeHrId: string;
}): Promise<EmployeeMonthDeductionSummary | null> {
  const compact = compactDeductionsHrId(input.employeeHrId);
  if (!compact) return null;
  const candidates = await listCandidatesForMonth({ monthKey: input.monthKey, employeeHrIdCompact: compact });
  return summarizeEmployeeMonthCandidates({ candidates, monthKey: input.monthKey });
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

/**
 * Resolves what a decision actually charges once the reviewer has narrowed the
 * days and/or typed a day count over the top.
 *
 * Pure, and exported for the tests: this is the money. The rules are
 *
 *   1. A selected day must be a day the engine detected. A reviewer removes
 *      days; they never invent one, because an invented day has no evidence.
 *   2. The day count follows the ticked days unless the reviewer explicitly
 *      typed one, and can never EXCEED what was detected. 140 typed instead of
 *      14 is a 10x pay cut that no downstream check would have caught.
 *   3. The amount is derived from the candidate's own estimate, never taken
 *      from the caller — a browser must not be able to dictate a payroll figure.
 */
export function resolveDecisionCharge(input: {
  candidate: { unit: DeductionsCandidate["unit"]; rawValue: number; estimatedAmount: number | null; dates: readonly string[] };
  appliedDates?: readonly unknown[] | null;
  appliedValue?: number | null;
  /**
   * Let the applied days exceed what was detected. Only for a figure the Super Admin set himself
   * before releasing the week on the weekly attendance review (owner, 2026-09-15: "Raise too"), or
   * one already recorded that way. A reviewer typing here is still capped.
   */
  allowAboveDetected?: boolean;
}): { appliedDates: string[] | null; appliedValue: number | null; appliedAmount: number | null } {
  const { candidate } = input;

  let appliedDates: string[] | null = null;
  if (input.appliedDates != null) {
    const normalized = normalizeAppliedDeductionDates({
      candidateDates: candidate.dates,
      selected: input.appliedDates,
    });
    if (normalized.rejected.length > 0) {
      throw new Error(
        `Validation: ${normalized.rejected.join(", ")} is not one of the days detected for this deduction — a day can be removed, never added.`,
      );
    }
    appliedDates = normalized.dates;
  }

  // An amount-unit candidate (loan, other, a manual entry) has no days to tick;
  // its appliedValue IS the money, so it is passed through untouched.
  if (candidate.unit !== "days") {
    const value = input.appliedValue ?? null;
    if (value != null && (!Number.isFinite(value) || value < 0)) {
      throw new Error("Validation: the applied amount must be a non-negative number.");
    }
    return { appliedDates: null, appliedValue: value, appliedAmount: value };
  }

  // Ticked dates weigh what the candidate's own dates weigh — a half-day date is 0.5, never 1.
  const appliedValue =
    input.appliedValue ??
    (appliedDates == null
      ? null
      : daysForTickedDates({
          rawValue: candidate.rawValue,
          detectedDates: candidate.dates.length,
          tickedDates: appliedDates.length,
        }));
  if (appliedValue != null) {
    if (!Number.isFinite(appliedValue) || appliedValue < 0) {
      throw new Error("Validation: the number of deducted days must be a non-negative number.");
    }
    if (appliedValue > candidate.rawValue && input.allowAboveDetected !== true) {
      throw new Error(
        `Validation: cannot deduct ${appliedValue} day(s) — only ${candidate.rawValue} were detected for this employee. Lower the number or clear the deduction instead.`,
      );
    }
  }

  if (appliedValue == null) {
    return { appliedDates, appliedValue: null, appliedAmount: null };
  }

  return {
    appliedDates,
    appliedValue,
    appliedAmount: scaleDeductionAmountToDays({
      estimatedAmount: candidate.estimatedAmount,
      rawValue: candidate.rawValue,
      appliedDays: appliedValue,
    }),
  };
}

/**
 * Refuse to approve a fingerprint deduction for a day the employee already paid from annual
 * leave in the weekly attendance review (owner decision 2026-09-15). That charge is permanent;
 * approving the deduction as well takes the same day twice — once from leave, once from pay.
 * The settle function refuses the opposite order (a balance charge after a decision).
 *
 * Fails CLOSED on a read error, except when the ledger table does not exist yet (the migration not
 * applied), because then no such charge can exist either.
 */
async function assertDayNotPaidFromAnnualBalance(input: { employeeHrId: string | null; dates: string[] }) {
  const hrId = String(input.employeeHrId ?? "").trim();
  const dates = input.dates.filter((date) => /^\d{4}-\d{2}-\d{2}$/.test(date));
  if (!hrId || !dates.length) return;
  const { data, error } = await getSupabaseAdmin()
    .from("attendance_annual_balance_charges")
    // select("*"), not a column list: the `source` column only exists once the leave-balance migration has
    // run, and a named column that is missing fails the whole read.
    .select("*")
    .ilike("employee_hr_id", hrId.replace(/[\\%_]/g, (char) => `\\${char}`))
    .in("work_date", dates);
  if (error) {
    const code = String((error as { code?: unknown }).code ?? "");
    const message = String((error as { message?: unknown }).message ?? "");
    if (code === "PGRST205" || code === "42P01" || /could not find the table/i.test(message)) return;
    throw new Error(`Failed to check the annual balance charges for this day: ${message}`);
  }
  // NET per day (2026-10-09): leave given back by a revised dispute is a negative row on the same
  // day (a reversing entry), and a day whose charge was reversed is no longer paid from leave.
  const netByDay = new Map<string, number>();
  for (const row of (data ?? []) as Array<{ work_date: string; days: number | string | null; source?: string | null }>) {
    // A CRM deduction taken from leave (source = 'deductions') is a different deduction on possibly the
    // same date, and this message names the weekly review.
    if (row.source === "deductions") continue;
    const day = String(row.work_date);
    netByDay.set(day, (netByDay.get(day) ?? 0) + (Number(row.days) || 0));
  }
  const charged = Array.from(netByDay.entries())
    .filter(([, days]) => days > 0.0005)
    .map(([day]) => day)
    .sort();
  if (charged.length) {
    throw new Error(
      `Conflict: the employee already paid ${charged.join(", ")} from their annual vacation balance in the weekly attendance review. Approving this deduction would take the day twice — record it as Do Not Take Action instead.`,
    );
  }
}

function isMissingTableError(error: unknown): boolean {
  const code = String((error as { code?: unknown }).code ?? "");
  const message = String((error as { message?: unknown }).message ?? "");
  return code === "PGRST205" || code === "42P01" || /could not find the table/i.test(message);
}

/**
 * Whether the employee record says this person has LEFT: any employment status outside active and
 * on leave, read through the auth module's own isTerminalEmploymentStatus so nobody here keeps a
 * second list of statuses. Fails CLOSED — an unreadable record, or no record at all, counts as
 * still with the company, which keeps the month-end block in place.
 */
async function employeeHasLeft(employeeHrId: string): Promise<boolean> {
  const { data, error } = await getSupabaseAdmin()
    .from("employees")
    .select("employment_status")
    .ilike("hr_id", employeeHrId)
    .limit(1)
    .maybeSingle();
  if (error || !data) return false;
  return isTerminalEmploymentStatus((data as { employment_status?: string | null }).employment_status);
}

/**
 * Refuse to approve a fingerprint deduction for a day the weekly attendance review said is NOT
 * charged, or has not finished deciding:
 *   • removed before the week was released (the owner took it out),
 *   • a dispute the reviewer upheld,
 *   • a dispute still waiting for the reviewer — approving now would pre-empt that decision,
 *   • a day still pending in a week waiting for release (owner, 2026-09-15 — "Block until
 *     released"): the employee has not been asked, and the Super Admin may still untick the day,
 *   • a day still pending in a released week (owner, 2026-09-16 — "Block until answered"): the
 *     employee can still pay it from annual balance or dispute it, until they answer or the answer
 *     deadline settles it.
 * A day still pending when payroll closes is not deducted that month. The bridge closes the cleared
 * days as Do Not Take Action, but only while the deduction is still Pending; a person approving it
 * first would have charged a day the review cleared, with nothing reporting it. The bridge's own
 * approvals never trip the pending check: a fingerprint deduction is one day (the connector writes
 * `dates: [row.dateIso]`), and the bridge approves a day only once it has settled. Fails CLOSED on a
 * read error.
 */
async function assertDayNotClearedInAttendanceReview(input: { employeeHrId: string | null; dates: string[] }) {
  const hrId = String(input.employeeHrId ?? "").trim();
  const dates = input.dates.filter((date) => /^\d{4}-\d{2}-\d{2}$/.test(date));
  if (!hrId || !dates.length) return;
  const hrPattern = hrId.replace(/[\\%_]/g, (char) => `\\${char}`);
  const supabase = getSupabaseAdmin();

  const [cleared, disputed, undecided] = await Promise.all([
    // A trial-run week's removal never reaches payroll (the bridge skips it), so it must not block
    // the real deduction either.
    supabase
      .from("attendance_settlements")
      // The day's own action and method ride along: a reopened dispute re-decided since its settlement
      // was written is judged as it stands NOW (effectiveSettlement), in both directions.
      .select(
        "work_date,action,method,attendance_digest_lines!inner(action,chosen_method,attendance_weekly_digests!inner(dry_run))",
      )
      .ilike("employee_hr_id", hrPattern)
      .in("work_date", dates)
      .in("action", ["removed", "dispute_upheld", "dispute_rejected"])
      .eq("attendance_digest_lines.attendance_weekly_digests.dry_run", false),
    supabase
      .from("attendance_digest_lines")
      .select("work_date,attendance_weekly_digests!inner(employee_hr_id,dry_run)")
      .eq("action", "disputed")
      .in("work_date", dates)
      .ilike("attendance_weekly_digests.employee_hr_id", hrPattern)
      .eq("attendance_weekly_digests.dry_run", false),
    // A day still pending in a real week: waiting for release, or released and not answered yet. A
    // trial-run week is never released, so it never blocks.
    supabase
      .from("attendance_digest_lines")
      .select("work_date,attendance_weekly_digests!inner(employee_hr_id,status,dry_run,notified_at)")
      .eq("action", "pending")
      .in("work_date", dates)
      .ilike("attendance_weekly_digests.employee_hr_id", hrPattern)
      .in("attendance_weekly_digests.status", ["awaiting_release", "open"])
      .eq("attendance_weekly_digests.dry_run", false),
  ]);
  for (const read of [cleared, disputed, undecided]) {
    if (read.error && !isMissingTableError(read.error)) {
      throw new Error(`Failed to check the weekly attendance review for this day: ${read.error.message}`);
    }
  }

  const clearedRows = ((cleared.error ? [] : (cleared.data ?? [])) as Array<{
    work_date: string;
    action: string;
    method: string | null;
    attendance_digest_lines?: unknown;
  }>)
    .map((row) => {
      const nested = row.attendance_digest_lines as
        | { action?: string | null; chosen_method?: string | null }
        | Array<{ action?: string | null; chosen_method?: string | null }>
        | null
        | undefined;
      const line = Array.isArray(nested) ? nested[0] : nested;
      const now = effectiveSettlement(
        { action: row.action, method: row.method },
        line ? { action: line.action ?? null, chosenMethod: line.chosen_method ?? null } : null,
      );
      return { work_date: row.work_date, action: now.action };
    })
    .filter((row) => row.action === "removed" || row.action === "dispute_upheld");
  if (clearedRows.length) {
    const days = clearedRows.map((row) => `${row.work_date} (${row.action === "removed" ? "removed before release" : "dispute upheld"})`);
    throw new Error(
      `Conflict: the weekly attendance review already cleared ${days.join(", ")}. Approving this deduction would charge a day the review said is not charged — record it as Do Not Take Action instead.`,
    );
  }
  const disputedRows = (disputed.error ? [] : (disputed.data ?? [])) as Array<{ work_date: string }>;
  if (disputedRows.length) {
    throw new Error(
      `Conflict: the employee has an open dispute for ${disputedRows.map((row) => String(row.work_date)).join(", ")} in the weekly attendance review. Decide the dispute first, or mark this deduction Needs Follow-up.`,
    );
  }
  const allUndecidedRows = (undecided.error ? [] : (undecided.data ?? [])) as Array<{ work_date: string; attendance_weekly_digests: unknown }>;
  const nestedDigest = (row: { attendance_weekly_digests: unknown }) => {
    const nested = row.attendance_weekly_digests as
      | { status?: string; notified_at?: string | null }
      | Array<{ status?: string; notified_at?: string | null }>
      | null;
    return Array.isArray(nested) ? nested[0] : nested;
  };
  const weekStatus = (row: { attendance_weekly_digests: unknown }) => nestedDigest(row)?.status;
  const weekNotified = (row: { attendance_weekly_digests: unknown }) => Boolean(nestedDigest(row)?.notified_at);
  // A day of a released week whose notice reached NOBODY, for somebody who has LEFT, blocks nothing:
  // HR decides it (the owner's answer, 2026-09-16). Notices only go to current staff, so a leaver is
  // never told, their answer deadline never runs out, and this check would otherwise refuse the day
  // in their FINAL payroll for ever. HR settles it here as it did before the weekly review existed —
  // approve it from the final pay, or record Do Not Take Action. Nothing is deducted automatically
  // without a notice, and the annual-balance guard still refuses a day already decided, so no day is
  // ever charged twice. Anyone still with the company keeps the block, because they can answer; so
  // does a week still waiting for release, which is still the Super Admin's to untick.
  const untold = allUndecidedRows.filter((row) => weekStatus(row) === "open" && !weekNotified(row));
  const undecidedRows = untold.length && (await employeeHasLeft(hrId)) ? allUndecidedRows.filter((row) => !untold.includes(row)) : allUndecidedRows;
  if (undecidedRows.length) {
    const daysOf = (rows: Array<{ work_date: string }>) => Array.from(new Set(rows.map((row) => String(row.work_date))));
    const unreleased = daysOf(undecidedRows.filter((row) => weekStatus(row) === "awaiting_release"));
    if (unreleased.length) {
      throw new Error(
        `Conflict: ${unreleased.join(", ")} ${unreleased.length === 1 ? "is" : "are"} still waiting for release in the weekly attendance review, so the employee has not been asked yet. Release that week on the Weekly Attendance Review page first, or mark this deduction Needs Follow-up.`,
      );
    }
    // Released and not answered yet: the employee can still pay the day from annual balance or dispute it.
    throw new Error(
      `Conflict: the employee has not answered ${daysOf(undecidedRows).join(", ")} in the weekly attendance review yet, and can still choose annual balance or dispute. Wait for their answer or for the answer deadline to settle it, or mark this deduction Needs Follow-up.`,
    );
  }
}

/**
 * The two weekly-attendance-review checks recordDecision runs before approving a fingerprint day,
 * for a caller that WRITES before it calls recordDecision. The Employee Day-by-Day Report creates
 * the day's candidate, or raises its stored ceiling, first — so without this an approval the review
 * refuses would still leave that write behind. recordDecision runs them both again itself.
 */
export async function assertFingerprintDayApprovable(input: { employeeHrId: string | null; dates: string[] }) {
  await assertDayNotPaidFromAnnualBalance(input);
  await assertDayNotClearedInAttendanceReview(input);
}

/** Super-Admin-gated: record or update a candidate's decision. */
export async function recordDecision(input: {
  actor: Pick<AccessContext, "role" | "hrId" | "loginId">;
  candidateId: string;
  decisionStatus: DeductionsDecisionStatus;
  decisionReason: string;
  hrNote?: string;
  /**
   * `undefined` means "leave whatever is already recorded alone"; an explicit
   * `null` clears it. The distinction matters because this is an UPSERT of the
   * whole row: without it, pressing "Decide" — which says nothing about days —
   * would silently blank a day selection the reviewer had already saved and put
   * the deduction back to charging the full month.
   */
  appliedValue?: number | null;
  appliedDates?: readonly unknown[] | null;
  /** See resolveDecisionCharge. Passed only by the weekly attendance bridge. */
  allowAboveDetected?: boolean;
  /**
   * Passed only by leave-balance.ts (the "Deduct from leave balance" / "Return to salary" buttons).
   * Every other caller is refused while the deduction is taken from annual leave, because deciding it
   * by hand would leave the days on the leave balance AND on salary, or the other way round.
   */
  viaLeaveBalance?: boolean;
}): Promise<DeductionsDecision & { payrollNotices: string[] }> {
  assertDeductionsDecisionActor(input.actor);
  if (!deductionsDecisionStatuses.includes(input.decisionStatus)) {
    throw new Error(`Validation: decisionStatus "${input.decisionStatus}" is not recognized`);
  }
  if (input.decisionStatus !== "Pending" && !input.decisionReason.trim()) {
    throw new Error("Validation: decisionReason is required for a non-Pending decision");
  }

  const supabase = getSupabaseAdmin();
  const candidate = await supabase
    .from("deductions_candidates")
    .select("id, locked_at, unit, raw_value, estimated_amount, dates, category, employee_hr_id, employee_hr_id_compact, month_key")
    .eq("id", input.candidateId)
    .single();
  if (candidate.error) throw new Error(`Not found: deductions candidate could not be loaded (${candidate.error.message})`);
  const candidateRow = candidate.data as {
    locked_at: string | null;
    unit: DeductionsCandidate["unit"];
    raw_value: number | string;
    estimated_amount: number | string | null;
    dates: unknown;
    category: string | null;
    employee_hr_id: string | null;
    employee_hr_id_compact: string | null;
    month_key: string | null;
  };
  if (candidateRow.locked_at) {
    throw new Error("Conflict: this candidate is locked by a publication — it can no longer be decided directly.");
  }
  // Every category the leave-balance button reaches: a charged row must not be decided from anywhere
  // else, or the same day is taken from salary AND from leave. Reads the one shared list, so widening
  // the button cannot leave this guard behind.
  if (input.viaLeaveBalance !== true && isLeaveBalanceCategory(candidateRow.category)) {
    if (await getLeaveBalanceChargeForCandidate(input.candidateId)) {
      throw new Error(
        "Conflict: this deduction is taken from the employee's annual leave balance. Press Return to salary first, then decide it.",
      );
    }
  }
  // A field day reviewed in the HR operations report travels the weekly attendance review exactly as a
  // fingerprint day does (src/lib/hr-ops-reports/bridge.ts), so it is held by the same two checks.
  if (
    input.decisionStatus === "Approved for Payroll" &&
    (candidateRow.category === "fingerprint" || candidateRow.category === "field_review")
  ) {
    const reviewedDay = {
      employeeHrId: candidateRow.employee_hr_id,
      dates: Array.isArray(candidateRow.dates) ? (candidateRow.dates as unknown[]).map(String) : [],
    };
    await assertDayNotPaidFromAnnualBalance(reviewedDay);
    await assertDayNotClearedInAttendanceReview(reviewedDay);
  }

  // Carry forward what is already recorded for anything this call did not
  // mention. This is an upsert of the entire row, so an omitted field would
  // otherwise be written as null — and the "Decide" action, which has no opinion
  // about days at all, would quietly undo a reviewer's day selection.
  const existing = await supabase
    .from("deductions_decisions")
    .select("applied_value, applied_dates, decision_status, applied_amount")
    .eq("candidate_id", input.candidateId)
    .maybeSingle();
  // Refuse on a failed read rather than treating it as "there was nothing here".
  // With maybeSingle() an absent row returns data null AND error null, so any
  // error is a real one — and swallowing it would carry `null` forward into the
  // upsert and blank the very day selection this read exists to protect. That is
  // the fail-open shape: the save still reports success while quietly restoring
  // the full month.
  if (existing.error) {
    throw new Error(`Failed to load the existing deduction decision: ${existing.error.message}`);
  }
  const existingRow = (existing.data ?? null) as {
    applied_value: number | string | null;
    applied_dates: unknown;
    decision_status: string | null;
    applied_amount: number | string | null;
  } | null;

  const appliedValueInput =
    input.appliedValue === undefined
      ? existingRow?.applied_value == null
        ? null
        : Number(existingRow.applied_value)
      : input.appliedValue;
  const appliedDatesInput =
    input.appliedDates === undefined
      ? Array.isArray(existingRow?.applied_dates)
        ? (existingRow.applied_dates as unknown[])
        : null
      : input.appliedDates;

  // The amount is RE-DERIVED here from the candidate the database holds, never
  // accepted from the request body. The route is Super-Admin gated, but "only an
  // admin can send it" is not the same guarantee as "the number cannot be wrong",
  // and this one is somebody's salary.
  const charge = resolveDecisionCharge({
    candidate: {
      unit: candidateRow.unit,
      rawValue: Number(candidateRow.raw_value),
      estimatedAmount: candidateRow.estimated_amount == null ? null : Number(candidateRow.estimated_amount),
      dates: Array.isArray(candidateRow.dates) ? (candidateRow.dates as string[]) : [],
    },
    appliedDates: appliedDatesInput,
    appliedValue: appliedValueInput,
    // A raised figure already on the decision was accepted when it was written. Carrying it forward
    // must not throw, or every later "Decide" on that day would fail.
    allowAboveDetected:
      input.allowAboveDetected === true ||
      (input.appliedValue === undefined && appliedValueInput != null && appliedValueInput > Number(candidateRow.raw_value)),
  });

  const now = new Date().toISOString();
  const payload = {
    candidate_id: input.candidateId,
    decision_status: input.decisionStatus,
    decision_reason: input.decisionStatus === "Pending" ? "" : input.decisionReason.trim(),
    hr_note: input.hrNote?.trim() ?? "",
    applied_value: charge.appliedValue,
    applied_amount: charge.appliedAmount,
    applied_dates: charge.appliedDates,
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

  // The decision is what Automated Payroll charges (owner, 2026-10-07 — the push gate is retired), so
  // a decision that moves payroll money has to reach a step that was already confirmed, exactly as a
  // push did while the push was the gate. Never throws: the decision is saved and is his intent.
  const payrollNotices =
    decisionMovesPayroll({
      before: existingRow
        ? { decisionStatus: existingRow.decision_status, appliedAmount: existingRow.applied_amount }
        : null,
      after: { decisionStatus: input.decisionStatus, appliedAmount: charge.appliedAmount },
    }) && candidateRow.month_key && candidateRow.employee_hr_id_compact && candidateRow.category
      ? describeDeductionResyncNotApplied(
          await resyncPayrollDeductionSteps({
            monthKey: normalizeMonthKey(candidateRow.month_key),
            employees: [
              {
                hrIdCompact: candidateRow.employee_hr_id_compact,
                categories: [candidateRow.category as DeductionsCategory],
              },
            ],
          }),
        )
      : [];

  return { ...mapDecisionRow(data as Record<string, unknown>)!, payrollNotices };
}

/**
 * Whether a decision change moves what Automated Payroll charges, and so has to reach a payroll step
 * that was already confirmed.
 *
 * Payroll counts a candidate iff its decision is "Approved for Payroll" (deductions-source.ts), so
 * money moves when the decision crosses into or out of that status, or when an approved decision's
 * amount changes (days narrowed or widened). Anything else — Pending to Needs Follow-up, a reason or
 * a note edited — charges 0.00 before and after, and re-opening a confirmed step for it would only
 * make HR confirm the same figure again.
 *
 * Pure and exported so the rule is pinned without a database.
 */
export function decisionMovesPayroll(input: {
  before: { decisionStatus: string | null; appliedAmount: number | string | null } | null;
  after: { decisionStatus: string; appliedAmount: number | string | null };
}): boolean {
  const approved = (status: string | null | undefined) => status === "Approved for Payroll";
  const wasApproved = approved(input.before?.decisionStatus);
  const isApproved = approved(input.after.decisionStatus);
  if (wasApproved !== isApproved) return true;
  if (!isApproved) return false;
  const amount = (value: number | string | null | undefined) => (value == null ? null : Number(value));
  return amount(input.before?.appliedAmount) !== amount(input.after.appliedAmount);
}
