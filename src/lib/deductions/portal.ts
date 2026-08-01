// Unified Deductions module: employee-portal read path (Phase 4).
//
// Dual-read-by-month: a given month_key is served by AT MOST ONE system —
// the new module if it has an active (status='published') publication for
// that month, otherwise the legacy deductions-governance snapshot. This is
// lower-risk than a one-time backfill (per the approved plan) and requires no
// new migration on the legacy side. The two portal call sites
// (app/employee-portals/deductions/page.tsx and admin-shell-employee-pages.tsx's
// WorkspaceDeductionsPage) both call this instead of
// deductions-governance/service.ts's listPublishedDeductionsForPortal
// directly, so both surfaces stay consistent.
//
// The output shape is the legacy DeductionMonthlySummaryLine/DeductionComment
// pair verbatim — DeductionsPortalWorkspace (the live component both pages
// render) is intentionally left unchanged, per the plan's "keep its current
// shape, don't redesign it" instruction.

import type { AccessContext } from "@/lib/auth/permissions";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { fetchAllRows } from "@/lib/supabase/paginated";
import {
  collectPortalDeductionScope,
  listDeductionComments,
  mapSummaryLineRow,
  type EmployeeScopeRow,
  type SummaryLineRow,
} from "@/lib/deductions-governance/service";
import type { DeductionComment, DeductionMonthlySummaryLine } from "@/lib/deductions-governance/types";
import { salaryRecordsColumnForCategory } from "./calculations.ts";
import { listDeductionsComments } from "./comments.ts";
import { normalizeMonthKey } from "./candidate-key.ts";
import type { DeductionsCategory } from "./types.ts";

function safeNormalizeMonthKey(input: string | undefined): string | undefined {
  if (typeof input !== "string" || !input.trim()) return undefined;
  try {
    return normalizeMonthKey(input);
  } catch {
    return undefined;
  }
}

type PublicationLineRow = {
  id: string;
  publication_id: string;
  candidate_id: string;
  decision_id: string | null;
  employee_hr_id: string;
  employee_hr_id_compact: string;
  employee_name: string | null;
  month_key: string;
  category: DeductionsCategory;
  unit: string;
  original_value: number;
  applied_value: number;
  applied_amount: number;
  dates: unknown;
  reason: string | null;
  hr_note: string | null;
  created_at: string;
};

export function mapPublicationLine(row: PublicationLineRow): DeductionMonthlySummaryLine {
  const deductionUnit = row.unit === "amount" ? "amount" : "days";
  return {
    id: row.id,
    summaryId: row.publication_id,
    candidateId: row.candidate_id,
    decisionId: row.decision_id ?? "",
    employeeCode: row.employee_hr_id,
    employeeHrIdCompact: row.employee_hr_id_compact,
    employeeName: row.employee_name,
    monthKey: row.month_key,
    sourceModule: "DEDUCTIONS_MODULE",
    deductionType: row.category,
    payrollColumn: salaryRecordsColumnForCategory(row.category) ?? "other_deductions",
    deductionUnit,
    originalDeductionValue: Number(row.original_value ?? 0),
    appliedDeductionValue: Number(row.applied_value ?? 0),
    appliedAmount: Number(row.applied_amount ?? 0),
    dates: Array.isArray(row.dates) ? (row.dates as string[]) : [],
    reason: row.reason,
    hrNote: row.hr_note,
    createdAt: row.created_at,
  };
}

async function loadNewModuleLines(monthKey: string | undefined): Promise<{
  lines: DeductionMonthlySummaryLine[];
  coveredMonthKeys: Set<string>;
}> {
  const supabase = getSupabaseAdmin();
  let pubsQuery = supabase.from("deductions_publications").select("id, month_key").eq("status", "published");
  if (monthKey) pubsQuery = pubsQuery.eq("month_key", monthKey);
  const { data: pubs, error: pubsError } = await pubsQuery;
  if (pubsError) throw pubsError;

  const publications = (pubs ?? []) as Array<{ id: string; month_key: string }>;
  const coveredMonthKeys = new Set(publications.map((p) => p.month_key));
  if (publications.length === 0) return { lines: [], coveredMonthKeys };

  // Paginated: a company-wide month can exceed PostgREST's 1000-row cap, which
  // previously meant arbitrary employees saw NO deductions in the portal while
  // payroll still deducted them.
  const rows = await fetchAllRows<PublicationLineRow>(
    () =>
      supabase
        .from("deductions_publication_lines")
        .select(
          "id, publication_id, candidate_id, decision_id, employee_hr_id, employee_hr_id_compact, employee_name, month_key, category, unit, original_value, applied_value, applied_amount, dates, reason, hr_note, created_at",
        )
        .in("publication_id", publications.map((p) => p.id)),
    "id",
  );

  return { lines: rows.map(mapPublicationLine), coveredMonthKeys };
}

async function loadLegacyLines(monthKey: string | undefined): Promise<DeductionMonthlySummaryLine[]> {
  // Mirrors deductions-governance/service.ts's listPublishedDeductionsForPortal
  // query verbatim (same table, same columns, same ordering) — that function
  // isn't reused directly here because its own scope-filter/comment-fetch
  // steps need to run once, after this module's lines are merged in, not twice.
  const supabase = getSupabaseAdmin();
  // Paginated for the same reason as the new-module loader above. The "id"
  // tiebreak (stable + unique) is what .range() paging needs for a total order —
  // fetchAllRows applies it itself. Display order is applied in mergePortalLines.
  const rows = await fetchAllRows<SummaryLineRow>(() => {
    let query = supabase
      .from("deduction_monthly_summary_lines")
      .select(
        "id, summary_id, candidate_id, decision_id, employee_code, employee_hr_id_compact, employee_name, month_key, source_module, deduction_type, payroll_column, deduction_unit, original_deduction_value, applied_deduction_value, applied_amount, dates, reason, hr_note, created_at",
      );
    if (monthKey) query = query.eq("month_key", monthKey);
    return query;
  }, "id");

  return rows.map(mapSummaryLineRow);
}

// The dual-read-by-month rule, isolated as a pure function: a month is owned
// by AT MOST ONE system. If the new module has an active publication for a
// month, that month's legacy rows are stale by definition and must not
// appear alongside the new ones — the whole point of cutover is that the new
// snapshot replaces the old one, not supplements it.
export function mergePortalLines(
  newLines: DeductionMonthlySummaryLine[],
  legacyLines: DeductionMonthlySummaryLine[],
  coveredMonthKeys: Set<string>,
): DeductionMonthlySummaryLine[] {
  const survivingLegacyLines = legacyLines.filter((line) => !coveredMonthKeys.has(line.monthKey));
  return [...newLines, ...survivingLegacyLines].sort((a, b) => {
    const monthCompare = b.monthKey.localeCompare(a.monthKey);
    if (monthCompare !== 0) return monthCompare;
    return String(a.employeeName ?? "").localeCompare(String(b.employeeName ?? ""));
  });
}

export async function getPortalDeductions(input: {
  access: AccessContext;
  monthKey?: string;
}): Promise<{
  comments: DeductionComment[];
  lines: DeductionMonthlySummaryLine[];
}> {
  const monthKey = safeNormalizeMonthKey(input.monthKey);
  const supabase = getSupabaseAdmin();

  const [{ data: employees, error: employeesError }, { lines: newLines, coveredMonthKeys }, legacyLinesRaw] =
    await Promise.all([
      supabase.from("employees").select("hr_id,full_name,manager_hr_id,line_id,line_name"),
      loadNewModuleLines(monthKey),
      loadLegacyLines(monthKey),
    ]);
  if (employeesError) throw employeesError;

  const allLines = mergePortalLines(newLines, legacyLinesRaw, coveredMonthKeys);

  const scope = collectPortalDeductionScope({
    access: input.access,
    employees: (employees ?? []) as EmployeeScopeRow[],
  });
  const lines = scope.all ? allLines : allLines.filter((line) => scope.compactHrIds.has(line.employeeHrIdCompact));

  const newLineIds = new Set(newLines.map((line) => line.candidateId));
  const newCandidateIds = lines.filter((l) => newLineIds.has(l.candidateId)).map((l) => l.candidateId);
  const legacyCandidateIds = lines.filter((l) => !newLineIds.has(l.candidateId)).map((l) => l.candidateId);

  const [newComments, legacyComments] = await Promise.all([
    listDeductionsComments({ candidateIds: newCandidateIds }),
    listDeductionComments({ access: input.access, candidateIds: legacyCandidateIds }),
  ]);
  const comments = [...newComments, ...legacyComments].sort((a, b) =>
    String(b.createdAt ?? "").localeCompare(String(a.createdAt ?? "")),
  );

  return { comments, lines };
}
