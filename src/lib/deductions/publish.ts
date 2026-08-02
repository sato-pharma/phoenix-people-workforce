// Unified Deductions module: the monthly publish flow. Selection logic lives
// here in application code (mirrors the legacy phx_finalize_monthly_deductions's
// p_lines/p_decision_ids pattern) — phx_publish_deductions only guarantees the
// WRITE is atomic, it does not re-derive eligibility itself.

import { writeAuditLog } from "@/lib/admin/audit";
import type { AccessContext } from "@/lib/auth/permissions";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { isEligibleForPublish, resolveAppliedDeductionDates } from "./calculations.ts";
import { normalizeMonthKey } from "./candidate-key.ts";
import { findDayCollisions } from "./conflict.ts";
import { assertDeductionsPublishActor } from "./permissions.ts";
import { countCandidatesForMonth, listCandidatesForMonth } from "./service.ts";
import type { DeductionsCandidateWithDecision, DeductionsCategory, DeductionsPublication } from "./types.ts";

// The publish-eligibility predicate itself now lives in calculations.ts (pure,
// no DB) so service.ts's Overview totals can use the EXACT same rule without a
// circular import — service.ts ← publish.ts already exists. Re-exported here
// because this is where callers expect to find it.
export { isEligibleForPublish };

function resolveAppliedValue(candidate: DeductionsCandidateWithDecision): number {
  return candidate.decision?.appliedValue ?? candidate.rawValue;
}

/**
 * The days this candidate publishes — the reviewer's narrowed selection when
 * they made one, otherwise everything the engine detected.
 *
 * Used for BOTH the snapshot lines and the double-deduction gate, deliberately.
 * Publishing `candidate.dates` while charging a reduced `appliedValue` produced
 * a line that said "3 days" above a list of 14 dates, and left the collision
 * gate blocking a publish over a day the reviewer had already cleared — the one
 * action the error message tells them to take could not actually resolve it.
 */
function resolvePublishDates(candidate: DeductionsCandidateWithDecision): string[] {
  return resolveAppliedDeductionDates(candidate);
}

/**
 * The publishable amount, or null when it genuinely could not be computed.
 *
 * Deliberately NOT `?? 0`. "We could not work out this employee's amount"
 * (missing base salary, a degraded feeder, a connector that never computed one)
 * is not the same statement as "the correct deduction is nothing" — and the old
 * `?? 0` silently converted the first into the second, so an entire category
 * could publish at 0.00 EGP and still report success. Missing data must never
 * look like a legitimate zero; publishMonth refuses instead, naming the
 * employees involved.
 */
function resolveAppliedAmount(candidate: DeductionsCandidateWithDecision): number | null {
  return candidate.decision?.appliedAmount ?? candidate.estimatedAmount ?? null;
}

function mapPublicationRow(row: Record<string, unknown>): DeductionsPublication {
  return {
    id: String(row.id),
    month: Number(row.month),
    year: Number(row.year),
    monthKey: String(row.month_key),
    status: row.status as DeductionsPublication["status"],
    publishedBy: String(row.published_by),
    publishedAt: String(row.published_at),
    supersededAt: (row.superseded_at as string | null) ?? null,
    supersededByPublicationId: (row.superseded_by_publication_id as string | null) ?? null,
    candidateCount: Number(row.candidate_count),
    employeeCount: Number(row.employee_count),
    categoryTotals: (row.category_totals as Partial<Record<DeductionsCategory, number>>) ?? {},
    notes: (row.notes as string | null) ?? null,
    createdAt: String(row.created_at),
  };
}

export type PublishMonthResult = {
  publication: DeductionsPublication;
  candidateCount: number;
  employeeCount: number;
};

/**
 * Publishes (or republishes, atomically superseding the prior snapshot) a
 * month's deductions. Nothing here writes salary_records/salary_batches —
 * see phx_publish_deductions's own comment; this module's only output is the
 * publication snapshot itself.
 */
export async function publishMonth(input: {
  monthKey: string;
  actor: Pick<AccessContext, "role" | "hrId" | "loginId">;
}): Promise<PublishMonthResult> {
  assertDeductionsPublishActor(input.actor);
  const publishedBy = input.actor.hrId ?? input.actor.loginId ?? "unknown";

  const monthKey = normalizeMonthKey(input.monthKey);
  const [yearStr, monthStr] = monthKey.split("-");
  const month = Number.parseInt(monthStr, 10);
  const year = Number.parseInt(yearStr, 10);

  const candidates = await listCandidatesForMonth({ monthKey });

  // Truncation guard. listCandidatesForMonth is paginated, but a publish writes
  // real money — so prove the read was complete against an INDEPENDENT physical
  // counter rather than trusting the fetch. Same discipline as sales-upload's
  // buildReconciliation ("Aborting to avoid silent data loss"): a partial
  // publish must be impossible, not merely unlikely. Publishing 1,000 of 2,300
  // candidates would silently zero the deduction for every employee past the cut.
  const liveCount = await countCandidatesForMonth({ monthKey });
  if (candidates.length !== liveCount) {
    throw new Error(
      `Aborting to avoid silent data loss: read ${candidates.length} candidate(s) for ${monthKey} but the ledger holds ${liveCount}. Nothing was published.`,
    );
  }

  const eligible = candidates.filter(isEligibleForPublish);

  if (eligible.length === 0) {
    throw new Error(`Validation: no eligible deduction candidates to publish for ${monthKey}.`);
  }

  // Double-deduction gate. Fingerprint, CRM and No-Records-Activity each detect
  // absence independently, so one employee-day can legitimately appear as three
  // candidates — but paying all three deducts one day three times. Checked
  // against ELIGIBLE candidates only: an overlapping day that HR already cleared
  // in one category is resolved, not a conflict.
  const collisions = findDayCollisions(
    eligible.map((candidate) => ({ ...candidate, dates: resolvePublishDates(candidate) })),
  );
  if (collisions.length > 0) {
    const named = collisions
      .slice(0, 10)
      // Employee NAME only — never the HR code. HR reads these messages to act
      // on a person, and a bare code makes them go look it up.
      .map((c) => `${c.employeeName ?? c.employeeHrId} ${c.date} → ${c.categories.join(" + ")}`)
      .join("; ");
    const more = collisions.length > 10 ? ` …and ${collisions.length - 10} more` : "";
    throw new Error(
      `Validation: ${collisions.length} employee-day(s) for ${monthKey} would be deducted more than once across categories. Nothing was published. Clear the duplicate in whichever category is wrong ("Do Not Take Action"), then publish again: ${named}${more}`,
    );
  }

  // An eligible candidate whose amount could not be computed must never publish
  // as 0.00 — that is a silent pay cut in the opposite direction (the employee
  // is under-deducted and the company's books are wrong) and, worse, it looks
  // identical to a successful publish. Refuse and name the people involved so
  // the real cause (usually a missing base salary) can be fixed.
  const unresolved = eligible.filter((candidate) => resolveAppliedAmount(candidate) == null);
  if (unresolved.length > 0) {
    const named = unresolved
      .slice(0, 10)
      // Employee NAME only — the category still matters, the HR code does not.
      .map((candidate) => `${candidate.employeeName ?? candidate.employeeHrId} (${candidate.category})`)
      .join("; ");
    const more = unresolved.length > 10 ? ` …and ${unresolved.length - 10} more` : "";
    throw new Error(
      `Validation: ${unresolved.length} eligible candidate(s) for ${monthKey} have no computable amount and would publish as 0.00 EGP. Nothing was published. Fix the source data (usually a missing base salary) or clear them with "Do Not Take Action": ${named}${more}`,
    );
  }

  const employeeHrIds = new Set(eligible.map((candidate) => candidate.employeeHrIdCompact));
  const categoryTotals: Record<string, number> = {};
  for (const candidate of eligible) {
    const amount = resolveAppliedAmount(candidate) ?? 0; // safe: unresolved rejected above
    categoryTotals[candidate.category] = Math.round(((categoryTotals[candidate.category] ?? 0) + amount) * 100) / 100;
  }

  const lines = eligible.map((candidate) => ({
    candidate_id: candidate.id,
    decision_id: candidate.decision?.id ?? null,
    employee_hr_id: candidate.employeeHrId,
    employee_hr_id_compact: candidate.employeeHrIdCompact,
    employee_name: candidate.employeeName,
    month_key: candidate.monthKey,
    category: candidate.category,
    unit: candidate.unit,
    original_value: candidate.rawValue,
    applied_value: resolveAppliedValue(candidate),
    applied_amount: resolveAppliedAmount(candidate) ?? 0, // safe: unresolved rejected above
    dates: resolvePublishDates(candidate),
    reason: candidate.decision?.decisionReason || candidate.reason,
    hr_note: candidate.decision?.hrNote ?? null,
  }));

  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase.rpc("phx_publish_deductions", {
    p_month_key: monthKey,
    p_month: month,
    p_year: year,
    p_published_by: publishedBy,
    p_candidate_count: eligible.length,
    p_employee_count: employeeHrIds.size,
    p_category_totals: categoryTotals,
    p_notes: null,
    p_lines: lines,
    p_candidate_ids: eligible.map((candidate) => candidate.id),
  });
  if (error) throw new Error(`Failed to publish deductions for ${monthKey}: ${error.message}`);

  const publication = mapPublicationRow(data as Record<string, unknown>);

  try {
    await writeAuditLog({
      actorLoginId: publishedBy,
      entityId: publication.id,
      entityType: "deductions_publication",
      newValues: { monthKey, candidateCount: eligible.length, employeeCount: employeeHrIds.size },
      summary: `Deductions published for ${monthKey}`,
    });
  } catch {
    // writeAuditLog already swallows; defensive in case a custom logger throws.
  }

  return { publication, candidateCount: eligible.length, employeeCount: employeeHrIds.size };
}

/** Publications for a month, most recent first (includes superseded history). */
export async function listPublicationsForMonth(monthKey: string): Promise<DeductionsPublication[]> {
  const normalized = normalizeMonthKey(monthKey);
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("deductions_publications")
    .select("*")
    .eq("month_key", normalized)
    .order("published_at", { ascending: false });
  if (error) throw new Error(`Failed to load publications for ${normalized}: ${error.message}`);
  return ((data ?? []) as Array<Record<string, unknown>>).map(mapPublicationRow);
}

/** The currently-active (status='published') publication for a month, or null. */
export async function getActivePublication(monthKey: string): Promise<DeductionsPublication | null> {
  const publications = await listPublicationsForMonth(monthKey);
  return publications.find((publication) => publication.status === "published") ?? null;
}
