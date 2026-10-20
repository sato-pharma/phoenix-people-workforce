// HR Daily & Weekly Reports — building a report and writing it.
//
// ONE REPORT PER PERIOD (`period_key` is unique), so the cron that fires twice a day, and the HR
// Manager's Rebuild button, update the same row rather than make a second one. A rebuild refreshes
// the FACTS of every row (punches, visits, flags, the policy's days) and never touches her review
// or his decision: the upsert writes only the fact columns. Once she has submitted a report it is
// frozen — what she reviewed is what he decides.
//
// A weekly row for a person's day that was already decided in its daily report is CARRIED
// (`carried_from_line_id`): shown in the week for completeness, never reviewed or decided twice.

import { getSupabaseAdmin } from "@/lib/supabase/server";

import { buildFieldSection } from "./field-section";
import { buildOfficeSection } from "./office-section";
import { periodEnd, periodTitle } from "./periods";
import { lineFlags } from "./rules";
import { findReportByPeriod, getDecidedLinesInWindow, getReportLines, LINES_TABLE, REPORTS_TABLE, storeError } from "./store";
import { HR_OPS_SECTIONS, HrOpsReportsError, type HrOpsLineDraft, type HrOpsPeriod, type HrOpsReportRow, type HrOpsSection } from "./types";

export type HrOpsBuildResult = {
  reportId: string;
  periodKey: string;
  title: string;
  /** True when this call made the report; false when it refreshed one already there. */
  created: boolean;
  /** Set when the report was left as it was — submitted or decided reports are never rebuilt. */
  skipped: "frozen" | null;
  lineCount: number;
  flaggedCount: number;
  warnings: string[];
};

const BATCH = 400;

function lineKey(line: { section: string; hr_key?: string; hrKey?: string; work_date?: string; workDate?: string }): string {
  return `${line.section}|${line.hrKey ?? line.hr_key}|${line.workDate ?? line.work_date}`;
}

/**
 * Collapse lines that name one person's day twice (the same person reached through two hr id
 * spellings): the first kept, its flags and notes joined with the second's, so nothing is lost and
 * the unique (report, section, person, day) key holds.
 */
export function dedupeLines(lines: readonly HrOpsLineDraft[]): HrOpsLineDraft[] {
  const byKey = new Map<string, HrOpsLineDraft>();
  for (const line of lines) {
    const key = lineKey(line);
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, { ...line, flags: [...line.flags], metrics: { ...line.metrics, notes: [...line.metrics.notes] } as HrOpsLineDraft["metrics"] });
      continue;
    }
    existing.flags = [...new Set([...existing.flags, ...line.flags])];
    existing.metrics.notes.push(...line.metrics.notes.filter((note) => !existing.metrics.notes.includes(note)));
    if (existing.suggestedDays === null) existing.suggestedDays = line.suggestedDays;
  }
  return [...byKey.values()];
}

/**
 * Build both sections for a period. Each degrades alone; what it could not read is returned.
 *
 * `incomplete` marks each section whose build raised a warning — meaning a source behind its ROWS
 * could not be read in full — and the stale sweep in `buildHrOpsReport` leaves those rows alone.
 */
export async function buildPeriodLines(
  period: HrOpsPeriod,
  today: string,
): Promise<{ incomplete: Record<HrOpsSection, boolean>; lines: HrOpsLineDraft[]; warnings: string[] }> {
  const [office, field] = await Promise.all([
    period.officeFrom && period.officeTo
      ? buildOfficeSection({ from: period.officeFrom, to: period.officeTo }).catch((error) => ({
          lines: [],
          warnings: [`Head office: the section could not be built (${error instanceof Error ? error.message : String(error)}).`],
        }))
      : Promise.resolve({ lines: [], warnings: [] }),
    period.fieldFrom && period.fieldTo
      ? buildFieldSection({ end: period.fieldTo, start: period.fieldFrom, today }).catch((error) => ({
          lines: [],
          warnings: [`Field force: the section could not be built (${error instanceof Error ? error.message : String(error)}).`],
        }))
      : Promise.resolve({ lines: [], warnings: [] }),
  ]);
  const incomplete = { field: field.warnings.length > 0, office: office.warnings.length > 0 };
  return { incomplete, lines: dedupeLines([...office.lines, ...field.lines]), warnings: [...office.warnings, ...field.warnings] };
}

/**
 * Build (or refresh) the report for a period. Refuses a period that has not finished: a day still
 * running would be flagged for punches and visits that have not happened yet.
 */
export async function buildHrOpsReport(input: { period: HrOpsPeriod; today: string }): Promise<HrOpsBuildResult> {
  const { period, today } = input;
  const title = periodTitle({ anchor: period.anchor, fieldTo: period.fieldTo, kind: period.kind, officeTo: period.officeTo });
  if (periodEnd(period) >= today) {
    throw new HrOpsReportsError(`${title} cannot be built until its last day has ended.`, 409);
  }

  const existing = await findReportByPeriod(period.periodKey);
  if (existing && existing.status !== "in_review") {
    return {
      created: false,
      flaggedCount: 0,
      lineCount: existing.line_count,
      periodKey: period.periodKey,
      reportId: existing.id,
      skipped: "frozen",
      title,
      warnings: [],
    };
  }

  const built = await buildPeriodLines(period, today);
  const supabase = getSupabaseAdmin();
  const now = new Date().toISOString();

  let report: HrOpsReportRow;
  // Stored on the report, not only said in `build_warnings`: `submitReport` refuses while it is
  // non-empty (rules.ts `degradedSubmitRefusal`), so a build that could not read a section cannot be
  // frozen with its rows missing. A clean build writes `[]` and clears it.
  const incompleteList = HR_OPS_SECTIONS.filter((section) => built.incomplete[section]);
  const windows = {
    field_from: period.fieldFrom,
    field_to: period.fieldTo,
    office_from: period.officeFrom,
    office_to: period.officeTo,
  };
  if (existing) {
    const { data, error } = await supabase
      .from(REPORTS_TABLE)
      .update({ ...windows, build_warnings: built.warnings, incomplete_sections: incompleteList, rebuilt_at: now, updated_at: now })
      .eq("id", existing.id)
      .eq("status", "in_review")
      .select("*")
      .maybeSingle();
    if (error) throw storeError(error, "refresh the report");
    if (!data) {
      // She submitted it between the read and this write — leave it exactly as she sent it.
      return { created: false, flaggedCount: 0, lineCount: existing.line_count, periodKey: period.periodKey, reportId: existing.id, skipped: "frozen", title, warnings: [] };
    }
    report = data as HrOpsReportRow;
  } else {
    const { data, error } = await supabase
      .from(REPORTS_TABLE)
      .upsert(
        { ...windows, build_warnings: built.warnings, built_at: now, incomplete_sections: incompleteList, kind: period.kind, period_key: period.periodKey, status: "in_review" },
        { ignoreDuplicates: true, onConflict: "period_key" },
      )
      .select("*")
      .maybeSingle();
    if (error) throw storeError(error, "create the report");
    if (!data) {
      // A concurrent run created it first; refresh that one instead of failing.
      return buildHrOpsReport(input);
    }
    report = data as HrOpsReportRow;
  }

  // A weekly report carries every day already decided elsewhere.
  const carriedFrom = new Map<string, string>();
  if (period.kind === "weekly") {
    const from = [period.fieldFrom, period.officeFrom].filter((value): value is string => Boolean(value)).sort()[0] ?? period.anchor;
    const decided = await getDecidedLinesInWindow({ excludeReportId: report.id, from, to: periodEnd(period) });
    for (const line of decided) carriedFrom.set(lineKey(line), line.id);
  }

  const rows = built.lines.map((line) => ({
    area_name: line.areaName,
    carried_from_line_id: carriedFrom.get(lineKey(line)) ?? null,
    employee_name: line.employeeName,
    flags: line.flags,
    hr_id: line.hrId,
    hr_key: line.hrKey,
    job_title: line.jobTitle,
    line_name: line.lineName,
    manager_name: line.managerName,
    metrics: line.metrics,
    report_id: report.id,
    section: line.section,
    suggested_days: line.suggestedDays,
    updated_at: now,
    work_date: line.workDate,
  }));
  for (let index = 0; index < rows.length; index += BATCH) {
    const { error } = await supabase
      .from(LINES_TABLE)
      .upsert(rows.slice(index, index + BATCH), { onConflict: "report_id,section,hr_key,work_date" });
    if (error) throw storeError(error, "write the report's rows");
  }

  // A row the refreshed build no longer produces goes — unless she or he already acted on it, in
  // which case it stays, so no answer anyone gave is ever lost.
  //
  // 🔴 A SECTION WHOSE BUILD RAISED A WARNING IS NOT SWEPT AT ALL: its absent rows mean "could not
  // be read", never "no longer applies". A section whose source fails does not throw — it comes back
  // `lines: []` with the reason named — and the cron refreshes a report still with her TWICE a Cairo
  // day, so sweeping on a degraded second run deleted exactly the flagged rows she had not answered
  // yet. `line_count` dropped, nothing turned red, and `submitReport` then found nothing waiting:
  // the report could be submitted and decided with those days gone from the weekly review for good.
  if (existing) {
    const current = new Set(rows.map((row) => lineKey(row)));
    const stale = (await getReportLines(report.id, "id,section,hr_key,work_date,review_action,decision"))
      .filter((line) => !built.incomplete[line.section] && !current.has(lineKey(line)) && !line.review_action && !line.decision)
      .map((line) => line.id);
    for (let index = 0; index < stale.length; index += BATCH) {
      const { error } = await supabase.from(LINES_TABLE).delete().in("id", stale.slice(index, index + BATCH)).eq("report_id", report.id);
      if (error) throw storeError(error, "remove rows that no longer apply");
    }
  }

  const { count, error: countError } = await supabase
    .from(LINES_TABLE)
    .select("id", { count: "exact", head: true })
    .eq("report_id", report.id);
  if (countError) throw storeError(countError, "count the report's rows");
  const lineCount = count ?? rows.length;
  const { error: finalError } = await supabase.from(REPORTS_TABLE).update({ line_count: lineCount, updated_at: now }).eq("id", report.id);
  if (finalError) throw storeError(finalError, "finish the report");

  return {
    created: !existing,
    flaggedCount: built.lines.filter((line) => lineFlags(line).length > 0 && !carriedFrom.has(lineKey(line))).length,
    lineCount,
    periodKey: period.periodKey,
    reportId: report.id,
    skipped: null,
    title,
    warnings: built.warnings,
  };
}
