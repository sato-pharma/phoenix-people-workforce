// Unified Deductions module: the per-line PUSH flow.
//
// Owner rule (2026-09-22): deductions are functioning but NEVER automatic. The
// Super Admin reviews an employee's candidates and PUSHES them one at a time —
// "push two of an employee's three, leave one". A pushed line is the single gate
// for two things at once:
//   * the employee's PORTAL shows it (portal.ts reads active lines only), and
//   * PAYROLL deducts it (deductions-source.ts gates on the active pushed set
//     from the push cutover month onward).
// Nothing else releases a deduction. Push also fires the employee + manager-chain
// notification (notify-deduction.ts); withdraw pulls the line back and frees the
// candidate to be edited and re-pushed.
//
// SUPER ADMIN ONLY. Every entry point asserts `assertDeductionsPublishActor`
// before it touches the database — the same gate the month-atomic publish uses.
// The RPCs are service_role-only precisely because this application gate, not a
// database grant, is what authorizes the write.

import type { AccessContext } from "@/lib/auth/permissions";
import { getSupabaseAdmin } from "@/lib/supabase/server";

import {
  isEligibleForPublish,
  resolveAppliedDeductionDates,
  resolvePublishedAppliedAmount,
  resolvePublishedAppliedValue,
} from "./calculations.ts";
import { normalizeMonthKey } from "./candidate-key.ts";
import {
  notifyDeductionPushed,
  type DeductionPushNoticeLine,
  type DeductionPushNotificationResult,
} from "./notify-deduction.ts";
import { assertDeductionsPublishActor } from "./permissions.ts";
import { countCandidatesForMonth, listCandidatesForMonth } from "./service.ts";
import type { DeductionsCandidateWithDecision, DeductionsCategory } from "./types.ts";

type PushActor = Pick<AccessContext, "role" | "hrId" | "loginId">;

/** A line that was successfully pushed (released to portal + payroll). */
export type PushedLineResult = {
  ok: true;
  candidateId: string;
  lineId: string;
  employeeName: string | null;
  monthKey: string;
  category: DeductionsCategory;
  appliedAmount: number;
  notification: DeductionPushNotificationResult;
};

/** A candidate that could not be pushed, with the reason (never money-bearing). */
export type PushSkipped = {
  ok: false;
  candidateId: string;
  reason: string;
};

export type PushForEmployeeResult = {
  pushed: PushedLineResult[];
  skipped: PushSkipped[];
};

/** Optional injection point so the push→notify wiring is testable without live sends. */
type PushDeps = {
  notify?: typeof notifyDeductionPushed;
};

/**
 * Build the `p_line` jsonb for `phx_push_deduction` — byte-for-byte the shape
 * publishMonth builds, so a pushed line is indistinguishable from a wholesale one
 * except for its status/push columns. `applied_amount` is frozen here via the
 * SAME helper the portal and payroll agree on; a null amount is refused before
 * this is reached, so the `?? 0` never fires (the day-amount CHECK backstops it).
 */
function buildPushLine(candidate: DeductionsCandidateWithDecision) {
  return {
    candidate_id: candidate.id,
    decision_id: candidate.decision?.id ?? null,
    employee_hr_id: candidate.employeeHrId,
    employee_hr_id_compact: candidate.employeeHrIdCompact,
    employee_name: candidate.employeeName,
    month_key: candidate.monthKey,
    category: candidate.category,
    unit: candidate.unit,
    original_value: candidate.rawValue,
    applied_value: resolvePublishedAppliedValue(candidate),
    applied_amount: resolvePublishedAppliedAmount(candidate) ?? 0,
    dates: resolveAppliedDeductionDates(candidate),
    reason: candidate.decision?.decisionReason || candidate.reason,
    hr_note: candidate.decision?.hrNote ?? null,
  };
}

/** Why a candidate cannot be pushed right now, or null if it can. */
function reasonNotPushable(candidate: DeductionsCandidateWithDecision): string | null {
  if (candidate.supersededAt) {
    return "Validation: this candidate was superseded by a re-collect and can no longer be pushed.";
  }
  if (!isEligibleForPublish(candidate)) {
    return 'Validation: this deduction is not approved for payroll — mark it "Approved for Payroll" first.';
  }
  if (resolvePublishedAppliedAmount(candidate) == null) {
    return "Validation: this deduction has no computable amount (usually a missing base salary) and would push as 0.00 EGP.";
  }
  return null;
}

async function stampNotificationResult(
  lineId: string,
  result: DeductionPushNotificationResult,
): Promise<void> {
  try {
    await getSupabaseAdmin()
      .from("deductions_publication_lines")
      .update({ notified_at: new Date().toISOString(), notification_status: result.status })
      .eq("id", lineId);
  } catch {
    // Best-effort: the line is pushed and the notice already went out (or not).
    // A failure to stamp the audit column must never unwind either.
  }
}

/**
 * Push one candidate. Returns the mapped result, or throws a prefixed error
 * (Conflict:/Validation:/not found) that `jsonError` turns into the right status.
 */
async function pushOneCandidate(input: {
  candidate: DeductionsCandidateWithDecision;
  month: number;
  year: number;
  pushedBy: string;
  actorHrId: string | null;
  notify: typeof notifyDeductionPushed;
}): Promise<PushedLineResult> {
  const { candidate } = input;
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase.rpc("phx_push_deduction", {
    p_month_key: candidate.monthKey,
    p_month: input.month,
    p_year: input.year,
    p_pushed_by: input.pushedBy,
    p_line: buildPushLine(candidate),
  });

  if (error) {
    // 23505 = unique_violation. The re-push path withdraws the candidate's own
    // active line first, so this is the day-overlap guard firing: another active
    // line already deducts one of these days. Surface it as a conflict the way
    // publishMonth surfaces its collisions.
    if (error.code === "23505") {
      throw new Error(
        `Conflict: ${candidate.employeeName ?? candidate.employeeHrId} is already being deducted for one of these days under another category in this month. Withdraw or clear the duplicate first.`,
      );
    }
    throw new Error(`Validation: could not push this deduction: ${error.message}`);
  }

  const row = (data ?? {}) as Record<string, unknown>;
  const lineId = String(row.id ?? "");
  const noticeLine: DeductionPushNoticeLine = {
    id: lineId,
    employeeHrId: String(row.employee_hr_id ?? candidate.employeeHrId),
    employeeName: (row.employee_name as string | null) ?? candidate.employeeName ?? null,
    monthKey: String(row.month_key ?? candidate.monthKey),
    category: (row.category as DeductionsCategory) ?? candidate.category,
  };

  // Notification is best-effort by contract (the money is already committed);
  // notifyDeductionPushed never throws. Record what happened on the line.
  const notification = await input.notify({ line: noticeLine, actorHrId: input.actorHrId });
  await stampNotificationResult(lineId, notification);

  return {
    ok: true,
    candidateId: candidate.id,
    lineId,
    employeeName: noticeLine.employeeName,
    monthKey: noticeLine.monthKey,
    category: noticeLine.category,
    appliedAmount: Number(row.applied_amount ?? 0),
    notification,
  };
}

/**
 * Push some or all of ONE employee's deductions for a month.
 *
 * `candidateIds` restricts to specific candidates (the per-line "push two, leave
 * one"); omit it to push every remaining eligible candidate for the employee
 * ("push all remaining"). A candidate that is not eligible or has no computable
 * amount is returned in `skipped`, never silently dropped.
 */
export async function pushForEmployee(input: {
  monthKey: string;
  employeeHrIdCompact: string;
  candidateIds?: readonly string[] | null;
  actor: PushActor;
  deps?: PushDeps;
}): Promise<PushForEmployeeResult> {
  assertDeductionsPublishActor(input.actor);
  const pushedBy = input.actor.hrId ?? input.actor.loginId ?? "unknown";
  const actorHrId = input.actor.hrId ?? null;
  const notify = input.deps?.notify ?? notifyDeductionPushed;

  const monthKey = normalizeMonthKey(input.monthKey);
  const [yearStr, monthStr] = monthKey.split("-");
  const month = Number.parseInt(monthStr, 10);
  const year = Number.parseInt(yearStr, 10);

  const candidates = await listCandidatesForMonth({
    monthKey,
    employeeHrIdCompact: input.employeeHrIdCompact,
  });
  // Truncation guard — a push writes real money, so prove the read was complete
  // against the independent counter (same discipline as publishMonth). Scoped to
  // one employee, this is tiny, but a partial read must be impossible, not rare.
  const liveCount = await countCandidatesForMonth({
    monthKey,
    employeeHrIdCompact: input.employeeHrIdCompact,
  });
  if (candidates.length !== liveCount) {
    throw new Error(
      `Aborting to avoid silent data loss: read ${candidates.length} candidate(s) for this employee in ${monthKey} but the ledger holds ${liveCount}. Nothing was pushed.`,
    );
  }

  const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));

  // Which candidates are we asked to push? A named subset, or every one the
  // employee has this month.
  const requestedIds = input.candidateIds ?? candidates.map((candidate) => candidate.id);

  const pushed: PushedLineResult[] = [];
  const skipped: PushSkipped[] = [];

  for (const candidateId of requestedIds) {
    const candidate = byId.get(candidateId);
    if (!candidate) {
      skipped.push({ ok: false, candidateId, reason: "not found for this employee in this month" });
      continue;
    }
    const notPushable = reasonNotPushable(candidate);
    if (notPushable) {
      skipped.push({ ok: false, candidateId, reason: notPushable });
      continue;
    }
    // A per-candidate failure (e.g. a day-overlap conflict) must not abort the
    // rest of the employee's push — record it and move on.
    try {
      pushed.push(
        await pushOneCandidate({ candidate, month, year, pushedBy, actorHrId, notify }),
      );
    } catch (error) {
      skipped.push({
        ok: false,
        candidateId,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { pushed, skipped };
}

/**
 * Push exactly ONE candidate by id. Resolves the candidate's employee first (a
 * single lightweight read) so the eligibility + amount checks run against the
 * directory-enriched candidate, then delegates to `pushForEmployee`.
 */
export async function pushDeduction(input: {
  monthKey: string;
  candidateId: string;
  actor: PushActor;
  deps?: PushDeps;
}): Promise<PushedLineResult> {
  assertDeductionsPublishActor(input.actor);
  const monthKey = normalizeMonthKey(input.monthKey);

  const { data, error } = await getSupabaseAdmin()
    .from("deductions_candidates")
    .select("employee_hr_id_compact")
    .eq("id", input.candidateId)
    .eq("month_key", monthKey)
    .is("superseded_at", null)
    .maybeSingle();
  if (error) throw new Error(`Validation: could not load the deduction: ${error.message}`);
  const compact = (data as { employee_hr_id_compact?: string | null } | null)?.employee_hr_id_compact;
  if (!compact) throw new Error(`not found: no live deduction ${input.candidateId} for ${monthKey}.`);

  const result = await pushForEmployee({
    monthKey,
    employeeHrIdCompact: compact,
    candidateIds: [input.candidateId],
    actor: input.actor,
    deps: input.deps,
  });

  const pushed = result.pushed[0];
  if (pushed) return pushed;
  const skipped = result.skipped[0];
  throw new Error(skipped?.reason ?? `Validation: ${input.candidateId} could not be pushed.`);
}

export type WithdrawResult = {
  ok: boolean;
  publicationId?: string;
  candidateId?: string;
  lineId?: string;
  reason?: string;
};

/**
 * Withdraw one pushed line. The candidate's lock is cleared so HR can edit and
 * re-push it; the line is kept (line_status='withdrawn') for the audit trail and
 * vanishes from both the portal and payroll. Withdrawing an already-withdrawn or
 * unknown line is a no-op that reports `ok:false`, not an error.
 */
export async function withdrawDeduction(input: {
  lineId: string;
  actor: PushActor;
}): Promise<WithdrawResult> {
  assertDeductionsPublishActor(input.actor);
  const actor = input.actor.hrId ?? input.actor.loginId ?? "unknown";

  const { data, error } = await getSupabaseAdmin().rpc("phx_withdraw_deduction", {
    p_line_id: input.lineId,
    p_actor: actor,
  });
  if (error) throw new Error(`Validation: could not withdraw this deduction: ${error.message}`);

  const row = (data ?? {}) as Record<string, unknown>;
  if (row.ok === true) {
    return {
      ok: true,
      publicationId: row.publication_id ? String(row.publication_id) : undefined,
      candidateId: row.candidate_id ? String(row.candidate_id) : undefined,
      lineId: row.line_id ? String(row.line_id) : undefined,
    };
  }
  return { ok: false, reason: (row.reason as string | undefined) ?? "line not found or already withdrawn" };
}
