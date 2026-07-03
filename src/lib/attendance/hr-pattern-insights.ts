// HR pattern insights: aggregate, over-a-period signals mined from the
// settlement ledger + missing-punch history that a single employee's
// passport or a flat ledger export don't surface on their own — who keeps
// getting deducted, who never engages with their digest before auto-
// confirm, who disputes a lot (and loses, or wins — both are signals),
// which weekday clusters the most lateness, and who has repeat missing-
// punch cases. Read-only; informs HR conversations, never acts on its own.

import { getSupabaseAdmin } from "@/lib/supabase/server";
import { normalizeAttendanceHrId } from "@/lib/attendance/metrics";
import { listSettlementLedger, type SettlementLedgerEntry } from "@/lib/attendance/settlement-ledger";

const REPEAT_OFFENDER_MIN_COUNT = 3;
const NON_RESPONDER_MIN_TOTAL = 2;
const NON_RESPONDER_MIN_RATE = 0.5;
const DISPUTE_HEAVY_MIN_COUNT = 2;
const MISSING_PUNCH_REPEATER_MIN_COUNT = 2;
const TOP_N = 20;

const WEEKDAY_LABELS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export type RepeatOffenderInsight = {
  employeeHrId: string;
  employeeName: string;
  settlementCount: number;
  totalDeductionDays: number;
  totalDeductionValue: number;
};

export type NonResponderInsight = {
  employeeHrId: string;
  employeeName: string;
  totalCount: number;
  autoConfirmedCount: number;
  autoConfirmRate: number;
};

export type DisputeHeavyInsight = {
  employeeHrId: string;
  employeeName: string;
  disputeCount: number;
  upheldCount: number;
  rejectedCount: number;
  upheldRate: number;
};

export type WeekdayPatternInsight = {
  weekday: string;
  count: number;
  totalValue: number;
};

export type MissingPunchRepeaterInsight = {
  employeeHrId: string;
  employeeName: string;
  caseCount: number;
};

export type HrPatternInsights = {
  dateFrom: string;
  dateTo: string;
  totalSettlements: number;
  repeatOffenders: RepeatOffenderInsight[];
  nonResponders: NonResponderInsight[];
  disputeHeavy: DisputeHeavyInsight[];
  weekdayPattern: WeekdayPatternInsight[];
  missingPunchRepeaters: MissingPunchRepeaterInsight[];
};

function weekdayOf(dateIso: string): number {
  return new Date(`${dateIso}T00:00:00Z`).getUTCDay();
}

export async function getHrPatternInsights(dateFrom: string, dateTo: string): Promise<HrPatternInsights> {
  const settlements = await listSettlementLedger({ dateFrom, dateTo });

  const byEmployee = new Map<string, SettlementLedgerEntry[]>();
  for (const entry of settlements) {
    const list = byEmployee.get(entry.employeeHrId) ?? [];
    list.push(entry);
    byEmployee.set(entry.employeeHrId, list);
  }

  const repeatOffenders: RepeatOffenderInsight[] = Array.from(byEmployee.entries())
    .map(([employeeHrId, entries]) => {
      const deducted = entries.filter((entry) => entry.action === "confirmed" || entry.action === "auto_confirmed" || entry.action === "dispute_rejected");
      return {
        employeeHrId,
        employeeName: entries[0].employeeName,
        settlementCount: deducted.length,
        totalDeductionDays: deducted.reduce((sum, entry) => sum + entry.deductionDays, 0),
        totalDeductionValue: deducted.reduce((sum, entry) => sum + entry.deductionValue, 0),
      };
    })
    .filter((row) => row.settlementCount >= REPEAT_OFFENDER_MIN_COUNT)
    .sort((left, right) => right.totalDeductionValue - left.totalDeductionValue)
    .slice(0, TOP_N);

  const nonResponders: NonResponderInsight[] = Array.from(byEmployee.entries())
    .map(([employeeHrId, entries]) => {
      const autoConfirmedCount = entries.filter((entry) => entry.action === "auto_confirmed").length;
      return {
        autoConfirmRate: entries.length > 0 ? autoConfirmedCount / entries.length : 0,
        autoConfirmedCount,
        employeeHrId,
        employeeName: entries[0].employeeName,
        totalCount: entries.length,
      };
    })
    .filter((row) => row.totalCount >= NON_RESPONDER_MIN_TOTAL && row.autoConfirmRate >= NON_RESPONDER_MIN_RATE)
    .sort((left, right) => right.autoConfirmRate - left.autoConfirmRate)
    .slice(0, TOP_N);

  const disputeHeavy: DisputeHeavyInsight[] = Array.from(byEmployee.entries())
    .map(([employeeHrId, entries]) => {
      const upheldCount = entries.filter((entry) => entry.action === "dispute_upheld").length;
      const rejectedCount = entries.filter((entry) => entry.action === "dispute_rejected").length;
      const disputeCount = upheldCount + rejectedCount;
      return {
        disputeCount,
        employeeHrId,
        employeeName: entries[0].employeeName,
        rejectedCount,
        upheldCount,
        upheldRate: disputeCount > 0 ? upheldCount / disputeCount : 0,
      };
    })
    .filter((row) => row.disputeCount >= DISPUTE_HEAVY_MIN_COUNT)
    .sort((left, right) => right.disputeCount - left.disputeCount)
    .slice(0, TOP_N);

  const weekdayBuckets = WEEKDAY_LABELS.map((weekday) => ({ count: 0, totalValue: 0, weekday }));
  for (const entry of settlements) {
    if (entry.lineStatus !== "late" && entry.lineStatus !== "short_hours") continue;
    if (entry.action !== "confirmed" && entry.action !== "auto_confirmed" && entry.action !== "dispute_rejected") continue;
    const bucket = weekdayBuckets[weekdayOf(entry.workDate)];
    bucket.count += 1;
    bucket.totalValue += entry.deductionValue;
  }

  const supabase = getSupabaseAdmin();
  const { data: missingPunchRows, error: missingPunchError } = await supabase
    .from("attendance_missing_punch_verifications")
    .select("employee_hr_id")
    .gte("work_date", dateFrom)
    .lte("work_date", dateTo);
  if (missingPunchError) throw new Error(`Missing-punch pattern lookup failed: ${missingPunchError.message}`);

  const missingPunchCountByEmployee = new Map<string, number>();
  for (const row of (missingPunchRows ?? []) as Array<{ employee_hr_id: string }>) {
    const hrId = normalizeAttendanceHrId(row.employee_hr_id);
    if (!hrId) continue;
    missingPunchCountByEmployee.set(hrId, (missingPunchCountByEmployee.get(hrId) ?? 0) + 1);
  }
  const nameByHrId = new Map(settlements.map((entry) => [entry.employeeHrId, entry.employeeName]));
  const missingPunchRepeaters: MissingPunchRepeaterInsight[] = Array.from(missingPunchCountByEmployee.entries())
    .map(([employeeHrId, caseCount]) => ({ caseCount, employeeHrId, employeeName: nameByHrId.get(employeeHrId) ?? employeeHrId }))
    .filter((row) => row.caseCount >= MISSING_PUNCH_REPEATER_MIN_COUNT)
    .sort((left, right) => right.caseCount - left.caseCount)
    .slice(0, TOP_N);

  return {
    dateFrom,
    dateTo,
    disputeHeavy,
    missingPunchRepeaters,
    nonResponders,
    repeatOffenders,
    totalSettlements: settlements.length,
    weekdayPattern: weekdayBuckets,
  };
}
