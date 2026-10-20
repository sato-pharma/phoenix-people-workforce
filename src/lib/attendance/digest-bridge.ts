// Applies a settled weekly-digest answer to the deduction candidate the month-end
// Fingerprint connector created for that same day.
//
// WHY A BRIDGE RATHER THAN A SECOND WRITER. The 2026-07 digest created its own
// deduction candidates at settlement time, which meant two independent things could
// write the same employee-day. That shape is what charged 19 employee-days twice in
// July 2026 (8,822.54 EGP) when the vacation collectors were insert-only. Here the
// connector stays the sole author of deductions_candidates and this module only
// answers the question the candidate is already asking, keyed on the connector's own
// `${hrId}:${dateIso}` source_record_id.
//
// WHAT IT REFUSES TO DO
//   • It never touches a candidate whose decision is not still Pending. A human who
//     has already ruled on a day outranks a digest answer, including an auto-confirm.
//   • It never applies a settlement recorded under dry-run. A trial-run week is never
//     released (owner, 2026-09-15), so none should exist — this is the backstop.
//   • It stamps `applied_candidate_id` write-once, enforced by a trigger, so a re-run
//     cannot answer the same day twice.

import { writeAuditLog } from "@/lib/admin/audit";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { recordDecision } from "@/lib/deductions/service.ts";
import type { DeductionsDecisionStatus } from "@/lib/deductions/types.ts";
import {
  decisionForSettlement,
  deductionSourceForDigestLine,
  editedDaysApplyToCandidate,
  effectiveSettlement,
  payrollDaysForSettledLine,
} from "@/lib/attendance/digest-rules.ts";

const SYSTEM_ACTOR = "system:weekly-attendance-digest";

export type BridgeResult = {
  monthKey: string;
  considered: number;
  applied: number;
  skippedAlreadyDecided: number;
  skippedNoCandidate: number;
  skippedDryRun: number;
  warnings: string[];
  /** Money taken twice or a balance-paid day that could not be closed. The daily job goes 500 on any. */
  alerts: string[];
};

/** Did this settlement spend annual leave? Mirrors v_charges_balance in the settle function. */
function chargedAnnualBalance(settlement: { action: string; method: string | null }): boolean {
  return settlement.action === "annual_balance" || (settlement.action === "dispute_rejected" && settlement.method === "annual_balance");
}

type SettlementRow = {
  id: number;
  employee_hr_id: string;
  work_date: string;
  action: string;
  method: string | null;
  digest_line_id: number;
};

/**
 * The mapping lives in digest-rules.ts so it can be tested without a database.
 *
 * Since 2026-09-15 an unanswered day DOES reach this function: the employee was told when the
 * week was released, and after 2 working days the daily job settles the day as `auto_salary`
 * (owner decision). A day the employee chose to pay from annual balance closes its candidate
 * with "Do Not Take Action" — the leave ledger carries it, and payroll must not take it again.
 */
function decisionFor(action: string, method: string | null): { status: DeductionsDecisionStatus; reason: string } | null {
  return decisionForSettlement(action, method);
}

/**
 * Apply every unapplied settlement whose work_date falls in `monthKey` to the
 * matching fingerprint candidate. Safe to re-run: applied settlements are skipped by
 * the `applied_candidate_id is null` filter, and a candidate that a person has
 * already decided is left exactly as they left it.
 */
export async function applyDigestAnswersForMonth(monthKey: string): Promise<BridgeResult> {
  if (!/^\d{4}-\d{2}$/.test(monthKey)) {
    throw new Error(`Validation: monthKey must be YYYY-MM, received "${monthKey}".`);
  }
  const supabase = getSupabaseAdmin();
  const monthStart = `${monthKey}-01`;
  const [year, month] = monthKey.split("-").map(Number);
  const monthEnd = `${monthKey}-${String(new Date(year!, month!, 0).getDate()).padStart(2, "0")}`;

  // Every unapplied settlement in the month, page by page. A row skipped as already decided or with
  // no candidate is never stamped, so a single capped read would let those rows fill the window for
  // good and hide newer answers behind them.
  const PAGE = 1000;
  const settlements: SettlementRow[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from("attendance_settlements")
      .select("id,employee_hr_id,work_date,action,method,digest_line_id")
      .is("applied_candidate_id", null)
      .gte("work_date", monthStart)
      .lte("work_date", monthEnd)
      .order("work_date", { ascending: true })
      .order("id", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw error;
    const page = (data ?? []) as SettlementRow[];
    settlements.push(...page);
    if (page.length < PAGE) break;
  }
  const result: BridgeResult = {
    monthKey,
    considered: settlements.length,
    applied: 0,
    skippedAlreadyDecided: 0,
    skippedNoCandidate: 0,
    skippedDryRun: 0,
    warnings: [],
    alerts: [],
  };
  if (!settlements.length) return result;

  // Which of these came from a dry-run digest? Read the flag frozen on the DIGEST at
  // generation time, never the live setting — a cycle that ran in dry-run must stay
  // dry-run even after the flag is switched off.
  const dryByLine = new Map<number, boolean>();
  // The days the Super Admin set on a day before releasing its week, when he changed them.
  const payrollDaysByLine = new Map<number, number>();
  const detectedDaysByLine = new Map<number, number>();
  // The day's CURRENT outcome — a reopened dispute re-decided since its settlement was written.
  const lineNowById = new Map<number, { action: string | null; chosenMethod: string | null }>();
  // Which month-end deduction each day's answer belongs to: `fingerprint`, or — for a day decided in the
  // HR operations report (src/lib/hr-ops-reports/bridge.ts) — the row that bridge wrote.
  const deductionByLine = new Map<number, ReturnType<typeof deductionSourceForDigestLine>>();
  const lineIds = settlements.map((row) => row.digest_line_id);
  for (let index = 0; index < lineIds.length; index += 200) {
    const { data: dryData, error: dryError } = await supabase
      .from("attendance_digest_lines")
      .select("id,status,deduction_days,detected_days,action,chosen_method,attendance_weekly_digests!inner(dry_run)")
      .in("id", lineIds.slice(index, index + 200));
    if (dryError) throw dryError;
    for (const raw of (dryData ?? []) as Array<Record<string, unknown>>) {
      const nested = raw.attendance_weekly_digests as { dry_run?: boolean } | Array<{ dry_run?: boolean }> | null;
      const flag = Array.isArray(nested) ? nested[0]?.dry_run : nested?.dry_run;
      dryByLine.set(Number(raw.id), flag !== false);
      deductionByLine.set(Number(raw.id), deductionSourceForDigestLine(raw.status == null ? null : String(raw.status)));
      lineNowById.set(Number(raw.id), {
        action: raw.action == null ? null : String(raw.action),
        chosenMethod: raw.chosen_method == null ? null : String(raw.chosen_method),
      });
      const days = payrollDaysForSettledLine({
        deductionDays: Number(raw.deduction_days) || 0,
        detectedDays: raw.detected_days == null ? null : Number(raw.detected_days),
      });
      if (days !== undefined) payrollDaysByLine.set(Number(raw.id), days);
      if (raw.detected_days != null) detectedDaysByLine.set(Number(raw.id), Number(raw.detected_days));
    }
  }

  for (const settlement of settlements) {
    if (dryByLine.get(settlement.digest_line_id) !== false) {
      result.skippedDryRun += 1;
      continue;
    }
    // A reopened dispute re-decided since this settlement was written is applied as it stands NOW.
    const effective = effectiveSettlement(settlement, lineNowById.get(settlement.digest_line_id));
    const decision = decisionFor(effective.action, effective.method);
    if (!decision) {
      result.warnings.push(`Settlement ${settlement.id} has an unmapped action "${settlement.action}".`);
      continue;
    }

    const sourceRecordId = `${settlement.employee_hr_id}:${settlement.work_date}`;
    const target = deductionByLine.get(settlement.digest_line_id) ?? deductionSourceForDigestLine(null);
    let candidateQuery = supabase
      .from("deductions_candidates")
      .select("id,unit,raw_value")
      .eq("category", target.category)
      .eq("month_key", monthKey)
      .eq("source_record_id", sourceRecordId)
      .is("superseded_at", null);
    if (target.sourceSystem) candidateQuery = candidateQuery.eq("source_system", target.sourceSystem);
    const { data: candidateData, error: candidateError } = await candidateQuery.maybeSingle();
    if (candidateError) throw candidateError;
    const candidateId = (candidateData as { id: string } | null)?.id ?? null;
    const candidateUnit = (candidateData as { unit?: string } | null)?.unit ?? null;
    const candidateRaw = Number((candidateData as { raw_value?: unknown } | null)?.raw_value);
    if (!candidateId) {
      // Normal, not an error: the connector builds a month's candidates only after the month
      // closes, and a day can also be cancelled by evidence that arrived afterwards (an excuse, an
      // approved leave), in which case no candidate is ever created. KNOWN LIMITATION: a day
      // already paid from annual balance and then cancelled that way keeps its balance charge —
      // the charge is immutable, and restoring the leave is a person's decision.
      result.skippedNoCandidate += 1;
      continue;
    }

    const { data: existingDecision, error: decisionError } = await supabase
      .from("deductions_decisions")
      .select("decision_status")
      .eq("candidate_id", candidateId)
      .maybeSingle();
    if (decisionError) throw decisionError;
    const currentStatus = (existingDecision as { decision_status: string } | null)?.decision_status ?? "Pending";
    const paidFromBalance = chargedAnnualBalance(effective);
    if (currentStatus !== "Pending") {
      result.skippedAlreadyDecided += 1;
      // The review said this day is not charged to salary (paid from balance, removed before
      // release, or a dispute upheld), but payroll already approved it. The settle function and
      // recordDecision refuse both orders, so this should never happen; a race or a decision made
      // before those guards shipped can still land here. Say so every run until a person clears it.
      if (decision.status === "Do Not Take Action" && currentStatus === "Approved for Payroll") {
        const why = paidFromBalance
          ? "paid from annual balance — the day is being taken twice"
          : effective.action === "removed"
            ? "removed from the weekly review before release — the day should not be charged"
            : "dispute upheld — the day should not be charged";
        result.alerts.push(
          `${settlement.employee_hr_id} ${settlement.work_date}: ${why}, but the month-end deduction is already Approved for Payroll. Set it to Do Not Take Action.`,
        );
      }
      continue;
    }

    // A day the Super Admin changed before release is charged at HIS figure, higher than detected
    // included (owner, 2026-09-15: "Raise too"). A cleared day has no figure to pass.
    const setDays = decision.status === "Approved for Payroll" && candidateUnit === "days" ? payrollDaysByLine.get(settlement.digest_line_id) : undefined;
    // His figure is a number of the days the WEEKLY review detected. When month-end detected
    // different days, the charge would be priced from another base — lowering a day could cost
    // more. Leave it Pending and unstamped so it is raised every run until a person decides.
    if (setDays !== undefined && !editedDaysApplyToCandidate({ detectedDays: detectedDaysByLine.get(settlement.digest_line_id) ?? Number.NaN, candidateRawValue: candidateRaw })) {
      result.alerts.push(
        `${settlement.employee_hr_id} ${settlement.work_date}: the Super Admin set ${setDays} day(s) on the weekly review, but the month-end deduction detected ${Number.isFinite(candidateRaw) ? candidateRaw : "an unreadable number of"} day(s) where the week detected ${detectedDaysByLine.get(settlement.digest_line_id) ?? "none"}. Decide it by hand.`,
      );
      continue;
    }
    try {
      const recorded = await recordDecision({
        actor: { role: "Super Admin", hrId: SYSTEM_ACTOR, loginId: SYSTEM_ACTOR },
        candidateId,
        decisionStatus: decision.status,
        decisionReason: decision.reason,
        hrNote:
          setDays === undefined
            ? `Applied from the weekly attendance digest settlement recorded on ${settlement.work_date}.`
            : `Applied from the weekly attendance digest settlement recorded on ${settlement.work_date}, at ${setDays} day(s) set by the Super Admin before release.`,
        ...(setDays === undefined ? {} : { appliedValue: setDays, allowAboveDetected: true }),
      });
      // The decision is saved, but payroll did not follow it — money, so it alerts.
      for (const notice of recorded.payrollNotices) {
        result.alerts.push(`${settlement.employee_hr_id} ${settlement.work_date}: ${notice}`);
      }
    } catch (decisionFailure) {
      // One locked or refused candidate must not stop every other day in the month from being
      // applied. A balance-paid day that cannot be closed is money taken twice, so it alerts.
      const message = decisionFailure instanceof Error ? decisionFailure.message : String(decisionFailure);
      const line = `${settlement.employee_hr_id} ${settlement.work_date}: could not apply "${decision.status}" — ${message}`;
      // A day the review cleared that cannot be closed stays chargeable — that is money, so it alerts.
      if (decision.status === "Do Not Take Action") result.alerts.push(line);
      else result.warnings.push(line);
      continue;
    }

    const { error: stampError } = await supabase
      .from("attendance_settlements")
      .update({ applied_candidate_id: candidateId, applied_at: new Date().toISOString() })
      .eq("id", settlement.id)
      .is("applied_candidate_id", null);
    if (stampError) throw stampError;
    result.applied += 1;
  }

  await writeAuditLog({
    actorLoginId: SYSTEM_ACTOR,
    entityId: monthKey,
    entityType: "attendance_digest_bridge_run",
    newValues: result as unknown as Record<string, unknown>,
    summary: `Weekly-digest answers applied to ${result.applied} fingerprint candidate(s) for ${monthKey}`,
  });

  return result;
}
