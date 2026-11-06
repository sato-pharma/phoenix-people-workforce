// Daily Deductions module: server orchestration. Runs the reused month-module
// connectors over a range (READ-ONLY — nothing here writes the candidate ledger),
// clips their output to the elapsed in-range days, and reads back the published
// snapshots. Publishing itself lives in publish.ts.

import { getSupabaseAdmin } from "@/lib/supabase/server";
import { fetchAllRows } from "@/lib/supabase/paginated";
import { collectFingerprintCandidates } from "@/lib/deductions/connectors/fingerprint.ts";
import { collectCrmCandidates } from "@/lib/deductions/connectors/crm.ts";
import {
  collectInsufficientBalanceVacationCandidates,
  collectUnpaidVacationCandidates,
} from "@/lib/deductions/connectors/vacation.ts";
import { dropDeductionExemptDrafts } from "@/lib/deductions/exempt-employees.ts";
import type { DeductionsCandidateDraft } from "@/lib/deductions/types.ts";
import { aggregateClippedLines, clipDraftToRange, type ClippedDraftLine } from "./compute.ts";
import { collectNoRecordsDailyCandidates } from "./no-records.ts";
import { collectNoWeeklyPlanCandidates } from "./no-weekly-plan.ts";
import { monthsInRange, resolveDailyRange } from "./range.ts";
import {
  dailyDeductionConnectorLabels,
  type DailyConnectorTally,
  type DailyDeductionCategory,
  type DailyDeductionConnector,
  type DailyDeductionRange,
  type DailyDeductionsLine,
  type DailyDeductionsPortalLine,
  type DailyDeductionsPublication,
} from "./types.ts";

type ConnectorRunner = (input: { month: number; year: number }) => Promise<DeductionsCandidateDraft[]>;

const CONNECTOR_RUNNERS: Record<DailyDeductionConnector, ConnectorRunner> = {
  fingerprint: (input) => collectFingerprintCandidates(input),
  crm: (input) => collectCrmCandidates(input),
  unpaid_vacation: (input) => collectUnpaidVacationCandidates(input),
  insufficient_balance_vacation: (input) => collectInsufficientBalanceVacationCandidates(input),
  no_records_activity: (input) => collectNoRecordsDailyCandidates(input),
  no_weekly_plan: (input) => collectNoWeeklyPlanCandidates(input),
};

/**
 * Authoritative compute for ONE connector over a range. One connector per call, by design:
 * each is a company-wide scan, and running the whole set in one request is what put the month
 * module over the 300s Cloud Run limit (#1377). The admin UI steps through the five connectors,
 * one request each, exactly as the month module's collection screen does.
 *
 * Read-only: the connectors return drafts; nothing is written. A connector that throws (a
 * degraded feeder, a refused cutover month) becomes a warning on that connector's tally rather
 * than failing the whole computation — the same isolation collectOneConnectorForMonth gives.
 */
export async function runConnectorForRange(input: {
  connector: DailyDeductionConnector;
  range: DailyDeductionRange;
  todayIso: string;
}): Promise<DailyConnectorTally & { effectiveTo: string; from: string; truncated: boolean }> {
  const label = dailyDeductionConnectorLabels[input.connector];
  const resolved = resolveDailyRange(input.range, input.todayIso);

  if (resolved.empty) {
    return {
      connector: input.connector,
      label,
      lines: [],
      employeeCount: 0,
      lineCount: 0,
      totalAmount: 0,
      warnings: [
        `${label}: the range has no fully-elapsed day yet — a day is only counted once it has ended (Cairo). Nothing to compute through ${resolved.effectiveTo}.`,
      ],
      effectiveTo: resolved.effectiveTo,
      from: resolved.from,
      truncated: resolved.truncated,
    };
  }

  const runner = CONNECTOR_RUNNERS[input.connector];
  const clipped: ClippedDraftLine[] = [];
  const warnings: string[] = [];

  for (const period of monthsInRange(resolved.from, resolved.effectiveTo)) {
    try {
      const drafts = await runner({ month: period.month, year: period.year });
      for (const draft of dropDeductionExemptDrafts(drafts).kept) {
        const line = clipDraftToRange(draft, resolved.from, resolved.effectiveTo);
        if (line) clipped.push(line);
      }
    } catch (error) {
      warnings.push(
        `${label} — ${String(period.month).padStart(2, "0")}/${period.year}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  const aggregated = aggregateClippedLines(clipped);
  if (aggregated.droppedUnidentified > 0) {
    warnings.push(
      `${label}: ${aggregated.droppedUnidentified} finding(s) had no resolvable HR id and were left out of the tally.`,
    );
  }
  if (aggregated.amountUnknownEmployees.length > 0) {
    const shown = aggregated.amountUnknownEmployees.slice(0, 8).join(", ");
    const more = aggregated.amountUnknownEmployees.length > 8 ? `, …and ${aggregated.amountUnknownEmployees.length - 8} more` : "";
    warnings.push(
      `${label}: ${aggregated.amountUnknownEmployees.length} employee(s) have counted days but no computable amount (usually a missing base salary) — days are counted, but the line is held back from release until the salary is on file: ${shown}${more}.`,
    );
  }
  if (resolved.truncated) {
    warnings.push(
      `${label}: the range was counted only through ${resolved.effectiveTo} — today and later are not yet elapsed and are never counted.`,
    );
  }

  const totalAmount = Math.round(aggregated.lines.reduce((sum, line) => sum + line.amount, 0) * 100) / 100;

  return {
    connector: input.connector,
    label,
    lines: aggregated.lines,
    employeeCount: new Set(aggregated.lines.map((line) => line.employeeHrIdCompact)).size,
    lineCount: aggregated.lines.length,
    totalAmount,
    warnings,
    effectiveTo: resolved.effectiveTo,
    from: resolved.from,
    truncated: resolved.truncated,
  };
}

// ── Read mappers ────────────────────────────────────────────────────────────

export function mapDailyPublicationRow(row: Record<string, unknown>): DailyDeductionsPublication {
  return {
    id: String(row.id),
    rangeStart: String(row.range_start),
    rangeEnd: String(row.range_end),
    status: row.status as DailyDeductionsPublication["status"],
    publishedBy: String(row.published_by),
    publishedAt: String(row.published_at),
    supersededAt: (row.superseded_at as string | null) ?? null,
    supersededByPublicationId: (row.superseded_by_publication_id as string | null) ?? null,
    employeeCount: Number(row.employee_count ?? 0),
    lineCount: Number(row.line_count ?? 0),
    categoryTotals: (row.category_totals as Partial<Record<DailyDeductionCategory, number>>) ?? {},
    notes: (row.notes as string | null) ?? null,
    createdAt: String(row.created_at),
  };
}

export function mapDailyLineRow(row: Record<string, unknown>): DailyDeductionsLine {
  return {
    id: String(row.id),
    publicationId: String(row.publication_id),
    category: row.category as DailyDeductionCategory,
    employeeHrId: String(row.employee_hr_id),
    employeeHrIdCompact: String(row.employee_hr_id_compact),
    employeeName: (row.employee_name as string | null) ?? null,
    unit: (row.unit as "days" | "amount") ?? "days",
    rawDaysCount: Number(row.raw_days_count ?? 0),
    daysCount: Number(row.days_count ?? 0),
    amount: Number(row.amount ?? 0),
    dates: Array.isArray(row.dates) ? (row.dates as string[]) : [],
    sourceSystem: String(row.source_system ?? ""),
    reason: (row.reason as string | null) ?? null,
    hrNote: String(row.hr_note ?? ""),
    createdAt: String(row.created_at),
    releasedAt: String(row.released_at ?? row.created_at),
    releasedBy: (row.released_by as string | null) ?? null,
    rangeStart: (row.range_start as string | null) ?? null,
    rangeEnd: (row.range_end as string | null) ?? null,
  };
}

export function mapDailyPortalLine(row: DailyDeductionsLine, publication: DailyDeductionsPublication): DailyDeductionsPortalLine {
  return {
    id: row.id,
    publicationId: row.publicationId,
    employeeCode: row.employeeHrId,
    employeeHrIdCompact: row.employeeHrIdCompact,
    employeeName: row.employeeName,
    category: row.category,
    deductionUnit: row.unit,
    daysCount: row.daysCount,
    amount: row.amount,
    dates: row.dates,
    rangeStart: publication.rangeStart,
    rangeEnd: publication.rangeEnd,
    createdAt: row.createdAt,
  };
}

/** The one active (published, not superseded) snapshot, or null. */
export async function getActiveDailyPublication(): Promise<DailyDeductionsPublication | null> {
  const { data, error } = await getSupabaseAdmin()
    .from("daily_deductions_publications")
    .select("*")
    .eq("status", "published")
    .is("superseded_at", null)
    .order("published_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`Failed to load the active daily deductions publication: ${error.message}`);
  return data ? mapDailyPublicationRow(data as Record<string, unknown>) : null;
}

/** Every snapshot, most recent first (includes superseded history). */
export async function listDailyPublications(): Promise<DailyDeductionsPublication[]> {
  const { data, error } = await getSupabaseAdmin()
    .from("daily_deductions_publications")
    .select("*")
    .order("published_at", { ascending: false });
  if (error) throw new Error(`Failed to list daily deductions publications: ${error.message}`);
  return ((data ?? []) as Array<Record<string, unknown>>).map(mapDailyPublicationRow);
}

/** Every line of one snapshot, paginated (a company-wide range can exceed 1,000 rows). */
export async function getDailyPublicationLines(publicationId: string): Promise<DailyDeductionsLine[]> {
  const supabase = getSupabaseAdmin();
  const rows = await fetchAllRows<Record<string, unknown>>(
    () => supabase.from("daily_deductions_lines").select("*").eq("publication_id", publicationId),
    "id",
  );
  return rows.map(mapDailyLineRow);
}
