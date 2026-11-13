import { compactHrKey } from "@/lib/payroll/copilot/feeders.ts";
import { roundCurrency } from "@/lib/payroll/money";
import { fetchAllRows } from "@/lib/supabase/paginated";
import { getSupabaseAdmin } from "@/lib/supabase/server";

import { recordCaseEvent, type CaseEventInput } from "./events.ts";
import { monthKeyLabel, nextOpenPayrollMonth, payrollMonthState } from "./payroll-month.ts";
import type { DisputeRefund } from "./types.ts";

// Money a revised dispute decision gives back after its month was already paid.
//
// The owner's answers (2026-10-09): a decided case whose money is locked in a published month is
// still reopened — "reopen to احتمال رد خصم الشهر القادم" (with the possibility of refunding the
// deduction next month) — and the refund lands "in additions, other": the next open payroll's
// Additions step, Other Additions cell. It is a RECOMMENDATION, exactly like the standing additions
// feeder: HR sees it with its reason and confirms the step; a figure HR saved by hand still wins.
// Nothing here pays anyone.
//
// One live refund per case (a partial unique index): a second revision cancels the first before it
// recommends again, so revisions never stack two refunds for one deduction.

type RefundRow = {
  amount: number | string;
  case_kind: "deduction" | "digest";
  case_ref: string;
  created_at: string;
  id: string;
  reason: string;
  source_month_key: string;
  status: "recommended" | "cancelled";
  target_month_key: string;
};

const COLUMNS = "id, case_kind, case_ref, source_month_key, target_month_key, amount, reason, status, created_at";

function mapRefund(row: RefundRow): DisputeRefund {
  return {
    amount: Number(row.amount) || 0,
    createdAt: row.created_at,
    id: row.id,
    reason: row.reason,
    sourceMonthKey: row.source_month_key,
    status: row.status,
    targetMonthKey: row.target_month_key,
  };
}

function isMissingTable(error: unknown): boolean {
  const code = String((error as { code?: unknown } | null)?.code ?? "");
  const message = String((error as { message?: unknown } | null)?.message ?? "").toLowerCase();
  return code === "PGRST205" || code === "42P01" || message.includes("could not find the table");
}

export async function listRefundsForCases(
  kind: "deduction" | "digest",
  refs: string[],
): Promise<Map<string, DisputeRefund[]>> {
  const byRef = new Map<string, DisputeRefund[]>();
  const ids = Array.from(new Set(refs.filter(Boolean)));
  if (ids.length === 0) return byRef;
  for (let i = 0; i < ids.length; i += 200) {
    // Every refund of this batch of cases, page by page: a refund missing from a case's screen reads
    // as "nothing recommended", and the reviewer could recommend the same money again.
    let rows: RefundRow[];
    try {
      rows = await fetchAllRows<RefundRow>(
        () =>
          getSupabaseAdmin()
            .from("dispute_refunds")
            .select(COLUMNS)
            .eq("case_kind", kind)
            .in("case_ref", ids.slice(i, i + 200))
            .order("created_at", { ascending: true }),
        "id",
      );
    } catch (error) {
      if (isMissingTable(error)) return byRef;
      throw error;
    }
    for (const row of rows) {
      const list = byRef.get(row.case_ref) ?? [];
      list.push(mapRefund(row));
      byRef.set(row.case_ref, list);
    }
  }
  return byRef;
}

/**
 * Cancel the case's live refund, if its target month is still open. A refund whose target month has
 * since been paid cannot be taken back here — the money already went out — and is reported, never
 * silently dropped.
 */
export async function cancelLiveRefund(input: {
  kind: "deduction" | "digest";
  ref: string;
  actorHrId: string | null;
  actorRole: string | null;
  reason: string;
  /**
   * When given, the "refund_cancelled" event is ADDED here instead of written — the caller writes it
   * with its own last write (decideDeductionDispute, F-PAY-005), so a decision that fails after this
   * step leaves no event behind in the append-only timeline. Omitted: written at once, as before.
   */
  deferEvents?: CaseEventInput[];
}): Promise<{ cancelled: DisputeRefund | null; alreadyPaid: DisputeRefund | null }> {
  const { data, error } = await getSupabaseAdmin()
    .from("dispute_refunds")
    .select(COLUMNS)
    .eq("case_kind", input.kind)
    .eq("case_ref", input.ref)
    .eq("status", "recommended")
    .maybeSingle();
  if (error) {
    if (isMissingTable(error)) return { alreadyPaid: null, cancelled: null };
    throw error;
  }
  if (!data) return { alreadyPaid: null, cancelled: null };
  const live = mapRefund(data as RefundRow);
  if ((await payrollMonthState(live.targetMonthKey)) === "paid") return { alreadyPaid: live, cancelled: null };

  const now = new Date().toISOString();
  const { error: updateError } = await getSupabaseAdmin()
    .from("dispute_refunds")
    .update({ cancel_reason: input.reason, cancelled_at: now, cancelled_by_hr_id: input.actorHrId, status: "cancelled" })
    .eq("id", live.id)
    .eq("status", "recommended");
  if (updateError) throw updateError;
  const cancelledEvent: CaseEventInput = {
    actorHrId: input.actorHrId,
    actorRole: input.actorRole,
    details: { amount: live.amount, refundId: live.id, targetMonthKey: live.targetMonthKey },
    eventType: "refund_cancelled",
    kind: input.kind,
    note: input.reason,
    ref: input.ref,
  };
  if (input.deferEvents) input.deferEvents.push(cancelledEvent);
  else await recordCaseEvent(cancelledEvent);
  return { alreadyPaid: null, cancelled: { ...live, status: "cancelled" } };
}

/**
 * Recommend `amount` back to the employee in the first open payroll after `sourceMonthKey`. Replaces
 * any live refund on the same case. Returns the refund and a sentence saying where it will appear.
 *
 * 🔴 WHEN THE CASE'S EARLIER REFUND HAS ALREADY BEEN PAID, NOTHING NEW IS RECOMMENDED and `refund`
 * comes back null with a sentence saying so. There is one live refund per case — a partial unique
 * index — and a paid one cannot be cancelled to make room, so the insert would have raised a 23505
 * AFTER the decision had already changed the month's money, leaving the decision recorded and the
 * caller holding a database error. HR is told to settle the difference instead.
 */
export async function recommendDisputeRefund(input: {
  kind: "deduction" | "digest";
  ref: string;
  candidateId: string | null;
  employeeHrId: string;
  sourceMonthKey: string;
  amount: number;
  reason: string;
  actorHrId: string | null;
  actorRole: string | null;
  /** As on cancelLiveRefund: collect the events for the caller's own last write instead of writing them. */
  deferEvents?: CaseEventInput[];
}): Promise<{ refund: DisputeRefund | null; sentence: string }> {
  const amount = roundCurrency(input.amount);
  if (!(amount > 0)) throw new Error("Validation: a refund must be more than zero.");
  const replaced = await cancelLiveRefund({
    actorHrId: input.actorHrId,
    actorRole: input.actorRole,
    kind: input.kind,
    reason: "Replaced by a newer decision on the same dispute.",
    ref: input.ref,
    ...(input.deferEvents ? { deferEvents: input.deferEvents } : {}),
  });
  if (replaced.alreadyPaid) {
    const paid = replaced.alreadyPaid;
    return {
      refund: null,
      sentence:
        `${monthKeyLabel(paid.targetMonthKey)} payroll already paid ${paid.amount.toFixed(2)} EGP back on this ` +
        `dispute, so it cannot be replaced and no new refund was recommended. ${amount.toFixed(2)} EGP is what ` +
        `this decision owes back — settle the ${roundCurrency(amount - paid.amount).toFixed(2)} EGP difference by hand.`,
    };
  }
  const targetMonthKey = await nextOpenPayrollMonth(input.sourceMonthKey);
  const { data, error } = await getSupabaseAdmin()
    .from("dispute_refunds")
    .insert({
      amount,
      candidate_id: input.candidateId,
      case_kind: input.kind,
      case_ref: input.ref,
      created_by_hr_id: input.actorHrId,
      employee_hr_id: input.employeeHrId,
      employee_hr_id_compact: compactHrKey(input.employeeHrId),
      reason: input.reason,
      source_month_key: input.sourceMonthKey,
      target_month_key: targetMonthKey,
    })
    .select(COLUMNS)
    .single();
  if (error) throw error;
  const refund = mapRefund(data as RefundRow);
  const recommendedEvent: CaseEventInput = {
    actorHrId: input.actorHrId,
    actorRole: input.actorRole,
    details: { amount, refundId: refund.id, sourceMonthKey: input.sourceMonthKey, targetMonthKey },
    eventType: "refund_recommended",
    kind: input.kind,
    note: input.reason,
    ref: input.ref,
  };
  if (input.deferEvents) input.deferEvents.push(recommendedEvent);
  else await recordCaseEvent(recommendedEvent);
  return {
    refund,
    sentence:
      `${monthKeyLabel(input.sourceMonthKey)} payroll is already paid, so ${amount.toFixed(2)} EGP is recommended back ` +
      `in ${monthKeyLabel(targetMonthKey)} payroll, under Additions → Other additions, for HR to confirm.`,
  };
}
