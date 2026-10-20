import type { AccessContext } from "@/lib/auth/permissions";
import { normalizeMonthKey } from "@/lib/deductions/candidate-key.ts";
import { pushDeduction, withdrawDeduction } from "@/lib/deductions/push.ts";
import { recordDecision } from "@/lib/deductions/service.ts";
import { getSupabaseAdmin } from "@/lib/supabase/server";

import { payrollCharge, type ChargeCandidateRow, type ChargeDecisionRow } from "./charge.ts";
import { monthKeyLabel, payrollMonthState } from "./payroll-month.ts";
import { cancelLiveRefund, recommendDisputeRefund } from "./refunds.ts";
import { dayLabel, moneyLabel } from "./text.ts";

// THE MONEY SIDE OF A REVISED WEEKLY-REVIEW DISPUTE.
//
// A weekly-review day is charged in two places, and a revision has to reach both:
//   * the LINE and its settlement — the weekly review's own record, moved by
//     phx_attendance_revise_digest_dispute (and the leave day given back there, as a reversing entry);
//   * the MONTH-END fingerprint deduction for that same day, which is what payroll actually charges.
// The bridge (attendance/digest-bridge.ts) connects the two for a FIRST decision. It cannot do it for
// a revision: it only ever touches a candidate whose decision is still Pending, and a decided day's
// candidate is not. So the revision carries the money itself, here, through the Deductions module's
// own entry points — never by writing a deduction row directly.
//
// Nothing here pays anybody. A month whose payroll is already final is not rewritten: the money owed
// back is recommended into the next open month's Additions → Other additions (owner, 2026-10-09).

export type RevisionMoneyResult = {
  /** What happened, in one sentence for the reviewer. */
  sentence: string;
  /** Where the money goes back, when the month was already paid. */
  refundSentence: string | null;
  /** Anything a person has to finish by hand — payroll steps already confirmed, a paid month. */
  notices: string[];
};

// The charge columns come with it (`ChargeCandidateRow`): what this day costs is read from the
// candidate's DECISION, never from its payslip line, and `payrollCharge` needs the unit, the detected
// figure, the estimate and the dates to answer in payroll's own terms.
type CandidateRow = ChargeCandidateRow & {
  employee_hr_id: string | null;
  id: string;
  locked_at: string | null;
  month_key: string | null;
};

/**
 * The month-end fingerprint candidate for one employee-day, keyed the way the connector writes it — or,
 * for a day decided in the HR operations report, the row its bridge wrote, keyed the same way
 * (deductionSourceForDigestLine — the same target the month-end bridge applies the answer to).
 */
async function findFingerprintCandidate(
  employeeHrId: string,
  workDate: string,
  target: { category: "fingerprint" | "field_review"; sourceSystem: string | null } = { category: "fingerprint", sourceSystem: null },
): Promise<CandidateRow | null> {
  const monthKey = normalizeMonthKey(workDate.slice(0, 7));
  let query = getSupabaseAdmin()
    .from("deductions_candidates")
    .select("id, month_key, raw_value, locked_at, employee_hr_id, category, unit, estimated_amount, dates")
    .eq("category", target.category)
    .eq("month_key", monthKey)
    .eq("source_record_id", `${employeeHrId}:${workDate}`)
    .is("superseded_at", null);
  if (target.sourceSystem) query = query.eq("source_system", target.sourceSystem);
  const { data, error } = await query.maybeSingle();
  if (error) throw error;
  return (data as CandidateRow | null) ?? null;
}

/** The decision on record for that candidate — the thing payroll actually charges. */
async function decisionFor(candidateId: string): Promise<ChargeDecisionRow | null> {
  const { data, error } = await getSupabaseAdmin()
    .from("deductions_decisions")
    .select("decision_status, applied_value, applied_amount, applied_dates")
    .eq("candidate_id", candidateId)
    .maybeSingle();
  if (error) throw error;
  return (data as ChargeDecisionRow | null) ?? null;
}

/**
 * The live payslip line for that candidate, if there is one — its ID and nothing else.
 *
 * 🔴 IT DELIBERATELY NO LONGER CARRIES `applied_amount`. The line says whether the employee can SEE
 * the deduction on their payslip, which is all it is read for here (withdraw it, or push one when
 * none exists). It is not what payroll charges, and a money figure sitting in this helper is exactly
 * how it became the basis of a refund in the first place — `payrollCharge` answers that question.
 */
async function activeLineFor(candidateId: string): Promise<{ id: string } | null> {
  const { data, error } = await getSupabaseAdmin()
    .from("deductions_publication_lines")
    .select("id")
    .eq("candidate_id", candidateId)
    .eq("line_status", "active")
    .maybeSingle();
  if (error) throw error;
  const row = data as { id: string } | null;
  return row ? { id: row.id } : null;
}

/**
 * Apply a revised weekly-review decision to the month-end deduction for that day.
 *
 * `upheld` — the day is not charged: the deduction is cancelled and its line pulled off the payslip,
 * and if that month's payroll is already paid the amount is recommended back in the next open month.
 *
 * `rejected` — the day IS charged from salary: the deduction is approved and pushed. When the month
 * is already paid this cannot be charged there, and that is REPORTED rather than quietly moved to
 * another month — taking money in a month the employee did not earn it in is not a correction a
 * session may invent.
 */
export async function applyDigestRevisionToDeduction(input: {
  lineId: number;
  employeeHrId: string;
  workDate: string;
  upheld: boolean;
  note: string;
  // The ROLE is the union, not a string: every deductions entry point re-asserts the actor against
  // it, and a widened string here is what made the typecheck refuse this file.
  actor: { hrId: string | null; loginId: string | null; role: AccessContext["role"] };
  reviewerHrId: string | null;
  /** The day's month-end deduction (deductionSourceForDigestLine). Omitted = a `fingerprint` day, as before. */
  deduction?: { category: "fingerprint" | "field_review"; sourceSystem: string | null };
}): Promise<RevisionMoneyResult> {
  const notices: string[] = [];
  const candidate = await findFingerprintCandidate(input.employeeHrId, input.workDate, input.deduction);
  if (!candidate) {
    // Normal for a recent week: the connector builds a month's candidates only after the month
    // closes. The bridge then reads the LINE's current action (effectiveSettlement), so the revision
    // is applied when the candidate appears — nothing is lost.
    return {
      notices,
      refundSentence: null,
      sentence: `${dayLabel(input.workDate)} has no month-end deduction yet, so the revised decision will be applied when that month's deductions are collected.`,
    };
  }

  const monthKey = normalizeMonthKey(String(candidate.month_key ?? input.workDate.slice(0, 7)));
  const monthState = await payrollMonthState(monthKey);
  const line = await activeLineFor(candidate.id);
  // WHAT THIS DAY COSTS IS THE DECISION, NOT THE PAYSLIP LINE (`charge.ts`). The line was the basis
  // here too, and the weekly review is the path where the two disagree most often: the month-end
  // fingerprint candidate is approved by the bridge when the month closes and pushed separately, so
  // "approved, not yet pushed" is the ordinary state of a day for days at a time. Read off the line,
  // a dispute upheld in that window refunded 0.00 while payroll charged the day in full.
  const chargedBefore = payrollCharge(candidate, await decisionFor(candidate.id)).amount;

  if (input.upheld) {
    if (line) {
      const withdrawn = await withdrawDeduction({ actor: input.actor, lineId: line.id });
      if (!withdrawn.ok) {
        notices.push(`The ${monthKeyLabel(monthKey)} deduction for ${dayLabel(input.workDate)} could not be taken off the payslip: ${withdrawn.reason}`);
      }
    }
    try {
      const decision = await recordDecision({
        actor: input.actor,
        candidateId: candidate.id,
        decisionReason: `Weekly attendance dispute revised to upheld${input.note ? `: ${input.note}` : ""}`,
        decisionStatus: "Do Not Take Action",
        hrNote: input.note,
      });
      notices.push(...decision.payrollNotices);
    } catch (error) {
      notices.push(
        `The ${monthKeyLabel(monthKey)} deduction for ${dayLabel(input.workDate)} could not be cancelled: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    let refundSentence: string | null = null;
    if (monthState === "paid" && chargedBefore > 0) {
      const recommended = await recommendDisputeRefund({
        actorHrId: input.reviewerHrId,
        actorRole: input.actor.role,
        amount: chargedBefore,
        candidateId: candidate.id,
        employeeHrId: input.employeeHrId,
        kind: "digest",
        reason: `Refund of a ${monthKeyLabel(monthKey)} deduction: ${dayLabel(input.workDate)} dispute upheld on review`,
        ref: String(input.lineId),
        sourceMonthKey: monthKey,
      });
      // A refund this case already had, whose own month has since been paid, cannot be replaced —
      // one live refund per case — so nothing new is recommended, and that goes to the reviewer as
      // something to settle rather than to the employee as money on the way.
      if (recommended.refund) refundSentence = recommended.sentence;
      else notices.push(recommended.sentence);
    }
    return {
      notices,
      refundSentence,
      sentence:
        chargedBefore > 0
          ? `The ${monthKeyLabel(monthKey)} deduction of ${moneyLabel(chargedBefore)} for ${dayLabel(input.workDate)} is cancelled.`
          : `The ${monthKeyLabel(monthKey)} deduction for ${dayLabel(input.workDate)} is cancelled.`,
    };
  }

  // Revised to rejected: the day is charged from salary again.
  const cancelled = await cancelLiveRefund({
    actorHrId: input.reviewerHrId,
    actorRole: input.actor.role,
    kind: "digest",
    reason: `Replaced: the dispute for ${dayLabel(input.workDate)} was revised to rejected.`,
    ref: String(input.lineId),
  });
  if (cancelled.alreadyPaid) {
    notices.push(
      `${moneyLabel(cancelled.alreadyPaid.amount)} was already refunded in ${monthKeyLabel(cancelled.alreadyPaid.targetMonthKey)} payroll, which is now paid. Settle that by hand.`,
    );
  }

  try {
    const decision = await recordDecision({
      actor: input.actor,
      candidateId: candidate.id,
      decisionReason: `Weekly attendance dispute revised to rejected; deducted from salary${input.note ? `: ${input.note}` : ""}`,
      decisionStatus: "Approved for Payroll",
      hrNote: input.note,
    });
    notices.push(...decision.payrollNotices);
  } catch (error) {
    notices.push(
      `The ${monthKeyLabel(monthKey)} deduction for ${dayLabel(input.workDate)} could not be approved: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return { notices, refundSentence: null, sentence: `${dayLabel(input.workDate)} is charged from salary, but its month-end deduction needs a hand.` };
  }

  if (!line) {
    try {
      await pushDeduction({
        actor: input.actor,
        candidateId: candidate.id,
        // One notice per decision: the dispute's own decision notice is what the employee reads.
        deps: { notify: async () => ({ ccHrIds: [], employeeNotified: false, status: "skipped" as const }) },
        monthKey,
      });
    } catch (error) {
      notices.push(
        `The ${monthKeyLabel(monthKey)} deduction for ${dayLabel(input.workDate)} is approved but not on the payslip yet: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  if (monthState === "paid") {
    notices.push(
      `${monthKeyLabel(monthKey)} payroll is already paid, so this day cannot be charged in it. Decide where it is taken in Automated Payroll.`,
    );
  }
  return {
    notices,
    refundSentence: null,
    sentence: `${dayLabel(input.workDate)} is deducted from salary in ${monthKeyLabel(monthKey)}.`,
  };
}
