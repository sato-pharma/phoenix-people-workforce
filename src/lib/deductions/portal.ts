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
import { listDeductionsComments, listRecentDeductionsComments } from "./comments.ts";
import { compactDeductionsHrId, normalizeMonthKey } from "./candidate-key.ts";
import type {
  AdminDeductionCommentThread,
  DeductionsCategory,
  DeductionsComment,
  DeductionsPortalLine,
} from "./types.ts";

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

async function loadNewModuleLines(
  monthKey: string | undefined,
  compactHrIds?: ReadonlySet<string>,
): Promise<{
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
  //
  // ACTIVE lines only. Per-line push withdraws a line (line_status='withdrawn')
  // when the Super Admin pulls a deduction back or re-pushes an edited one; a
  // withdrawn line is kept for the audit trail but deducts nothing, so it must
  // never reach the employee's portal. Legacy wholesale publishes are all
  // 'active' (the column defaults to 'active'), so this changes nothing for them.
  const rows = await fetchAllRows<PublicationLineRow>(
    () => {
      const query = supabase
        .from("deductions_publication_lines")
        .select(
          "id, publication_id, candidate_id, decision_id, employee_hr_id, employee_hr_id_compact, employee_name, month_key, category, unit, original_value, applied_value, applied_amount, dates, reason, hr_note, created_at",
        )
        .in("publication_id", publications.map((p) => p.id))
        .eq("line_status", "active");
      // NARROWED IN SQL (2026-10-01, "slow to transfer between page and page"): a self-only viewer
      // used to page through EVERY active line of every published month, company-wide, to keep
      // his own handful. The same exact-equality test on the same column now runs in the query;
      // getPortalDeductions still filters in JS as the authority, so this can only ever drop rows
      // that filter would have dropped. Absent (a system viewer, or no id at all) = today's read.
      return compactHrIds && compactHrIds.size > 0
        ? query.in("employee_hr_id_compact", [...compactHrIds])
        : query;
    },
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

  // Resolved BEFORE the read (it is pure — no I/O), so a self-only viewer's own ids can narrow
  // the query itself. The JS filter below stays exactly as it was and remains the authority.
  const scope = collectPortalDeductionScope({ access: input.access });
  const { lines: publishedLines } = await loadNewModuleLines(
    monthKey,
    scope.all ? undefined : scope.compactHrIds,
  );
  const sortedLines = sortPortalLines(publishedLines);

  const lines = scope.all
    ? sortedLines
    : sortedLines.filter((line) => scope.compactHrIds.has(line.employeeHrIdCompact));

  const comments = await listDeductionsComments({ candidateIds: lines.map((line) => line.candidateId) });
  return { comments, lines };
}

// Fetch the active published line for each candidate, keyed by candidate id. Mirrors
// loadNewModuleLines' column set and its line_status='active' filter (a withdrawn line
// deducts nothing and must not be the one shown), but keyed on candidate rather than
// publication — these candidates come from the comment table, not a month.
async function loadPublishedLinesByCandidate(
  candidateIds: string[],
): Promise<Map<string, DeductionsPortalLine>> {
  const byCandidate = new Map<string, DeductionsPortalLine>();
  if (candidateIds.length === 0) return byCandidate;
  const supabase = getSupabaseAdmin();
  for (let i = 0; i < candidateIds.length; i += 100) {
    const batch = candidateIds.slice(i, i + 100);
    const { data, error } = await supabase
      .from("deductions_publication_lines")
      .select(
        "id, publication_id, candidate_id, decision_id, employee_hr_id, employee_hr_id_compact, employee_name, month_key, category, unit, original_value, applied_value, applied_amount, dates, reason, hr_note, created_at",
      )
      .in("candidate_id", batch)
      .eq("line_status", "active");
    if (error) throw error;
    for (const row of (data ?? []) as PublicationLineRow[]) {
      // First active line per candidate wins; a candidate has at most one active line.
      if (!byCandidate.has(row.candidate_id)) byCandidate.set(row.candidate_id, mapPublicationLine(row));
    }
  }
  return byCandidate;
}

/**
 * Group newest-first comments into per-candidate threads, attach each candidate's published line,
 * and order the threads by their newest comment. Pure, so it is unit-tested without a database
 * (tests/deductions-dispute-threads.test.ts). The incoming comments MUST already be newest-first —
 * the first one seen for a candidate is taken as that thread's latest, which the sort keys on.
 */
export function groupDeductionCommentThreads(
  comments: DeductionsComment[],
  linesByCandidate: Map<string, DeductionsPortalLine>,
): AdminDeductionCommentThread[] {
  const threads = new Map<string, AdminDeductionCommentThread>();
  for (const comment of comments) {
    // Only a deduction still ACTIVE on the payslip is a dispute to work (owner, 2026-10-08: a
    // "Do Not Take Action" deduction must not show in the Disputes tab). A withdrawn or never-pushed
    // line deducts nothing, so a comment on it has nothing left to contest.
    if (!linesByCandidate.has(comment.candidateId)) continue;
    const existing = threads.get(comment.candidateId);
    if (existing) {
      existing.comments.push(comment);
      continue;
    }
    threads.set(comment.candidateId, {
      candidateId: comment.candidateId,
      line: linesByCandidate.get(comment.candidateId) ?? null,
      comments: [comment],
      latestCommentAt: comment.createdAt,
    });
  }
  return Array.from(threads.values()).sort((a, b) =>
    String(b.latestCommentAt ?? "").localeCompare(String(a.latestCommentAt ?? "")),
  );
}

/**
 * Every employee dispute on a published deduction, newest thread first — the admin Disputes
 * inbox. A deduction comment mails HR a link to /admin/deductions, so this is the read behind
 * the screen that link has to open. Company-wide and month-independent by design: the owner
 * could not reach a comment because the only in-app destination was the current-month workspace,
 * which shows no comments at all. Callers gate this on assertDeductionsReadActor.
 */
export async function listPublishedDeductionCommentThreads(input?: {
  limit?: number;
}): Promise<AdminDeductionCommentThread[]> {
  const comments = await listRecentDeductionsComments({ limit: input?.limit });
  if (comments.length === 0) return [];

  const candidateIds = Array.from(new Set(comments.map((comment) => comment.candidateId)));
  const linesByCandidate = await loadPublishedLinesByCandidate(candidateIds);
  return groupDeductionCommentThreads(comments, linesByCandidate);
}
