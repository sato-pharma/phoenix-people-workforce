// Unified Deductions module: employee-portal read path.
//
// Single source of truth as of the C6 cutover (2026-08-30): every published
// deduction the portal shows comes from THIS module's own publication tables
// (deductions_publications / deductions_publication_lines / deductions_comments).
// The legacy deductions-governance snapshot it used to dual-read from was
// retired in C6 — its portal table (deduction_monthly_summary_lines) had been
// dead-on-arrival (0 rows) since the module went live, so removing that arm
// changes nothing a viewer sees. The two portal call sites
// (app/employee-portals/deductions/page.tsx and admin-shell-employee-pages.tsx's
// WorkspaceDeductionsPage) both call getPortalDeductions, so both surfaces stay
// consistent.
//
// DeductionsPortalWorkspace (the live component both pages render) is
// intentionally left unchanged — its DeductionsPortalLine/DeductionsComment
// props are this module's own types now, but the shape is identical to the
// legacy pair it replaced.

import type { AccessContext } from "@/lib/auth/permissions";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { fetchAllRows } from "@/lib/supabase/paginated";
import { salaryRecordsColumnForCategory } from "./calculations.ts";
import { listDeductionsComments } from "./comments.ts";
import { compactDeductionsHrId, normalizeMonthKey } from "./candidate-key.ts";
import type { DeductionsCategory, DeductionsComment, DeductionsPortalLine } from "./types.ts";

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

export function mapPublicationLine(row: PublicationLineRow): DeductionsPortalLine {
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
  lines: DeductionsPortalLine[];
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

// PORTAL DEDUCTIONS ARE SELF-ONLY FOR EVERY ROLE (owner instruction, 2026-08-06:
// "everyone can only see his deductions only"). Relocated verbatim from the
// retired deductions-governance service in the C6 cutover; `compactDeductionsHrId`
// is byte-identical to the governance `compactHrId` it replaced (same
// canonicalHrIdKey source, same regex — see candidate-key.ts).
//
// This once widened by management subtree and by line, so a Regional Manager, a
// National Sales Manager, a District Manager or any "team"/"hierarchy"/"line"-scoped
// viewer read the deduction amounts of everyone beneath them. A deduction is
// financial AND disciplinary PII — the amount is derived directly from the person's
// base salary, so seeing the row tells you roughly what a colleague earns.
//
// Company-wide review does NOT live here and is unaffected: it is the admin
// Deductions module, gated on its own read actor (Super Admin / CEO / Finance
// Manager). `scope === "system"` below keeps that audience whole. A manager who
// needs a subordinate's figure asks HR.
export function collectPortalDeductionScope(input: {
  access: AccessContext;
}): { all: boolean; compactHrIds: Set<string> } {
  if (input.access.scope === "system") return { all: true, compactHrIds: new Set<string>() };
  const root = compactDeductionsHrId(input.access.hrId ?? input.access.loginId);
  return { all: false, compactHrIds: new Set<string>(root ? [root] : []) };
}

// Display order for the portal: month_key descending, then employee name.
// Kept as a pure exported function (was mergePortalLines, back when a legacy
// arm still fed in) so the ordering stays unit-testable independent of the DB.
export function sortPortalLines(lines: DeductionsPortalLine[]): DeductionsPortalLine[] {
  return [...lines].sort((a, b) => {
    const monthCompare = b.monthKey.localeCompare(a.monthKey);
    if (monthCompare !== 0) return monthCompare;
    return String(a.employeeName ?? "").localeCompare(String(b.employeeName ?? ""));
  });
}

export async function getPortalDeductions(input: {
  access: AccessContext;
  monthKey?: string;
}): Promise<{
  comments: DeductionsComment[];
  lines: DeductionsPortalLine[];
}> {
  const monthKey = safeNormalizeMonthKey(input.monthKey);

  const { lines: publishedLines } = await loadNewModuleLines(monthKey);
  const sortedLines = sortPortalLines(publishedLines);

  const scope = collectPortalDeductionScope({ access: input.access });
  const lines = scope.all
    ? sortedLines
    : sortedLines.filter((line) => scope.compactHrIds.has(line.employeeHrIdCompact));

  const comments = await listDeductionsComments({ candidateIds: lines.map((line) => line.candidateId) });
  return { comments, lines };
}
