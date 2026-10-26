// Unified Deductions module: employee-portal read path.
//
// Single source of truth as of the C6 cutover (2026-08-30): every published
// deduction the portal shows comes from THIS module's own publication tables
// (deductions_publications / deductions_publication_lines / deductions_comments).
// The legacy deductions-governance snapshot it used to dual-read from was
// retired in C6 — its portal table (deduction_monthly_summary_lines) had been
// dead-on-arrival (0 rows) since the module went live, so removing that arm
// changes nothing a viewer sees.
//
// TWO READS LIVE HERE SINCE 2026-10-09, and the two portal call sites
// (app/employee-portals/deductions/page.tsx and admin-shell-employee-pages.tsx's
// WorkspaceDeductionsPage) both moved to the second one, so both surfaces stay consistent:
//   * getPortalDeductions      — what was RELEASED to the employee (publication lines only)
//   * getPortalDeductionLedger — what was RAISED against him, decided or not, with HR's answer
// Both resolve visibility through collectPortalDeductionScope, so both are self-only for every
// non-system role.
//
// DeductionsPortalWorkspace (the live component both pages render) is
// intentionally left unchanged — its DeductionsPortalLine/DeductionsComment
// props are this module's own types now, but the shape is identical to the
// legacy pair it replaced.

import type { AccessContext } from "@/lib/auth/permissions";
import { canonicalHrIdKey, hrIdLookupKeys } from "@/lib/hr-id";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { fetchAllRows } from "@/lib/supabase/paginated";
import { salaryRecordsColumnForCategory } from "./calculations.ts";
import { listDeductionsComments, listRecentDeductionsComments } from "./comments.ts";
import { compactDeductionsHrId, normalizeMonthKey } from "./candidate-key.ts";
import { resolveDisputeAudience, toDisputeAudience } from "./dispute-audience.ts";
import { meaningfulHrText } from "./portal-ledger-filters.ts";
import {
  buildDisputeBasis,
  type DisputeCandidateRow,
  type DisputeDecisionRow,
  type DisputeLineExtraRow,
} from "./dispute-basis.ts";
import type {
  AdminDeductionCommentThread,
  DeductionsCategory,
  DeductionsComment,
  DeductionsPortalLedgerRow,
  DeductionsPortalLine,
  DeductionsUnit,
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

// ---------------------------------------------------------------------------
// The portal LEDGER — every deduction raised against the employee, not only the released ones
// ---------------------------------------------------------------------------
// Owner, 2026-10-09: "in deductions in emp portal starting from september salary show all deductions
// should be applied on him and how hr responded to every single row, and employee can filter by
// another month or period or type or status."
//
// WHY THIS IS A SECOND READ AND NOT A WIDENED getPortalDeductions. That one answers "what was
// RELEASED to this employee" — it starts from the publication tables, and a row with no active
// published line does not exist for it. This one answers "what was RAISED against this employee",
// so it starts from the candidates and treats the publication as one more fact about a row. Both
// stay: the publication is still what opens a dispute (a comment needs a released line), and the
// released figures are still what the payslip page quotes.
//
// WHAT THE EMPLOYEE NOW SEES THAT HE DID NOT. An undecided detection (owner's choice, same day:
// show them, marked under review). 67 half-day rows for 26 people were in that state when this
// shipped, so the screen says in words that nothing is deducted until HR decides.
//
// WHY THE DECISION, NOT THE PUBLICATION, DECIDES "on your payslip". Automated Payroll charges the
// DECISION — the push gate was retired on 2026-10-07 — so an "Approved for Payroll" row is money
// whether or not anyone released it. Deriving the outcome from the publication would tell an
// employee a charge was not happening while payroll was charging it.

/** The first payroll month this ledger shows (owner, 2026-10-09: "starting from september salary"). */
export const PORTAL_DEDUCTIONS_FIRST_MONTH = "2026-09";

/** What the employee is actually facing on a row, in the order a person asks about it. */
export type PortalDeductionOutcome =
  | "on_payslip"
  | "cleared"
  | "under_review"
  | "needs_follow_up"
  | "disputed";

/**
 * Pure: HR's decision → what the employee is facing. Keyed on the DECISION, because that is what
 * Automated Payroll charges (deductions-source.ts); the publication only decides whether the row
 * can be argued with. A status this does not know reads as under review rather than as nothing,
 * so a new decision status can never quietly render as "no deduction".
 */
export function derivePortalDeductionOutcome(decisionStatus: string | null | undefined): PortalDeductionOutcome {
  switch (String(decisionStatus ?? "").trim()) {
    case "Approved for Payroll":
      return "on_payslip";
    case "Do Not Take Action":
      return "cleared";
    case "Needs Follow-up":
      return "needs_follow_up";
    case "Disputed":
      return "disputed";
    default:
      return "under_review";
  }
}

type LedgerCandidateRow = {
  id: string;
  employee_hr_id: string;
  employee_hr_id_compact: string;
  employee_name: string | null;
  month_key: string;
  category: DeductionsCategory;
  unit: string;
  raw_value: number | string;
  estimated_amount: number | string | null;
  dates: unknown;
  reason: string | null;
  created_at: string;
  deductions_decisions?: unknown;
};

type LedgerDecisionRow = {
  decision_status?: string | null;
  decision_reason?: string | null;
  hr_note?: string | null;
  applied_value?: number | string | null;
  applied_amount?: number | string | null;
  decided_by?: string | null;
  decided_at?: string | null;
};

function numberOrNull(value: unknown): number | null {
  if (value == null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Pure: one candidate row plus its decision and publication state → the row the portal renders.
 * Exported for its test, and so the mapping can never drift between the two portal surfaces.
 */
export function mapPortalLedgerRow(input: {
  candidate: LedgerCandidateRow;
  decision: LedgerDecisionRow | null;
  releasedLine: DeductionsPortalLine | null;
  decidedByName: string | null;
}): DeductionsPortalLedgerRow {
  const { candidate, decision } = input;
  const unit: DeductionsUnit = candidate.unit === "amount" ? "amount" : "days";
  const detectedValue = numberOrNull(candidate.raw_value) ?? 0;
  const detectedAmount = numberOrNull(candidate.estimated_amount);
  const appliedValue = numberOrNull(decision?.applied_value);
  const appliedAmount = numberOrNull(decision?.applied_amount);
  const outcome = derivePortalDeductionOutcome(decision?.decision_status);
  // An approved decision that was never narrowed carries no applied figure — it charges everything
  // that was detected. Mirrors the admin workspace's own appliedDaysOf/appliedAmountOf fallback, so
  // the two screens quote one number.
  const chargedValue = outcome === "on_payslip" ? appliedValue ?? detectedValue : 0;
  const chargedAmount = outcome === "on_payslip" ? appliedAmount ?? detectedAmount ?? 0 : 0;
  return {
    candidateId: candidate.id,
    releasedLineId: input.releasedLine?.id ?? null,
    employeeCode: candidate.employee_hr_id,
    employeeHrIdCompact: candidate.employee_hr_id_compact,
    employeeName: candidate.employee_name,
    monthKey: candidate.month_key,
    category: candidate.category,
    payrollColumn: salaryRecordsColumnForCategory(candidate.category) ?? "other_deductions",
    unit,
    dates: Array.isArray(candidate.dates) ? (candidate.dates as unknown[]).map(String) : [],
    whyFlagged: candidate.reason,
    detectedValue,
    detectedAmount,
    chargedValue,
    chargedAmount,
    outcome,
    hrStatus: String(decision?.decision_status ?? "").trim() || "Pending",
    hrResponse: meaningfulHrText(decision?.decision_reason),
    hrNote: meaningfulHrText(decision?.hr_note),
    decidedByName: input.decidedByName,
    decidedAt: decision?.decided_at ?? null,
    // His ruling, 2026-10-09: a dispute is for money actually taken, so the comment box stays on
    // the released line exactly as addDeductionsComment's own gate requires. A cleared or
    // still-undecided row shows HR's answer and offers no reply.
    canComment: Boolean(input.releasedLine),
    createdAt: candidate.created_at,
  };
}

/** Newest payroll month first, then the biggest charge, so what costs money leads its month. */
export function sortPortalLedgerRows(rows: readonly DeductionsPortalLedgerRow[]): DeductionsPortalLedgerRow[] {
  return [...rows].sort((left, right) => {
    const byMonth = right.monthKey.localeCompare(left.monthKey);
    if (byMonth !== 0) return byMonth;
    const byAmount = right.chargedAmount - left.chargedAmount;
    if (byAmount !== 0) return byAmount;
    return left.category.localeCompare(right.category);
  });
}

/**
 * Every deduction raised against the employee from {@link PORTAL_DEDUCTIONS_FIRST_MONTH} onwards,
 * with HR's answer on each. Self-only for every role, through the same
 * {@link collectPortalDeductionScope} the released read uses — a manager never reads a
 * subordinate's figures here either.
 */
export async function getPortalDeductionLedger(input: {
  access: AccessContext;
}): Promise<{
  rows: DeductionsPortalLedgerRow[];
  comments: DeductionsComment[];
  firstMonthKey: string;
}> {
  const scope = collectPortalDeductionScope({ access: input.access });
  const supabase = getSupabaseAdmin();

  // The month floor is applied HERE and asserted again in JS below, because it is the owner's
  // instruction and not a performance filter: an earlier month's rows were never reviewed with an
  // employee reading them and must not surface by way of a widened query.
  const candidates = await fetchAllRows<LedgerCandidateRow>(
    () => {
      const query = supabase
        .from("deductions_candidates")
        .select(
          "id, employee_hr_id, employee_hr_id_compact, employee_name, month_key, category, unit, raw_value, estimated_amount, dates, reason, created_at, deductions_decisions(decision_status, decision_reason, hr_note, applied_value, applied_amount, decided_by, decided_at)",
        )
        .is("superseded_at", null)
        .gte("month_key", PORTAL_DEDUCTIONS_FIRST_MONTH);
      return scope.all ? query : query.in("employee_hr_id_compact", [...scope.compactHrIds]);
    },
    "id",
  );

  const mine = candidates.filter(
    (row) =>
      String(row.month_key ?? "") >= PORTAL_DEDUCTIONS_FIRST_MONTH &&
      (scope.all || scope.compactHrIds.has(String(row.employee_hr_id_compact ?? ""))),
  );
  if (mine.length === 0) return { rows: [], comments: [], firstMonthKey: PORTAL_DEDUCTIONS_FIRST_MONTH };

  const decisionOf = (row: LedgerCandidateRow): LedgerDecisionRow | null => {
    const nested = row.deductions_decisions;
    const decision = Array.isArray(nested) ? (nested[0] ?? null) : (nested ?? null);
    return (decision as LedgerDecisionRow | null) ?? null;
  };

  const [releasedByCandidate, names] = await Promise.all([
    loadPublishedLinesByCandidate(mine.map((row) => row.id)),
    loadEmployeeNames(mine.map((row) => decisionOf(row)?.decided_by ?? null)),
  ]);

  const rows = sortPortalLedgerRows(
    mine.map((candidate) => {
      const decision = decisionOf(candidate);
      const decidedByKey = canonicalHrIdKey(decision?.decided_by);
      return mapPortalLedgerRow({
        candidate,
        decision,
        releasedLine: releasedByCandidate.get(candidate.id) ?? null,
        decidedByName: decidedByKey ? names.get(decidedByKey) ?? null : null,
      });
    }),
  );

  // Only a released row can carry a conversation, so only those ids are asked for.
  const comments = await listDeductionsComments({
    candidateIds: rows.filter((row) => row.canComment).map((row) => row.candidateId),
  });
  return { rows, comments, firstMonthKey: PORTAL_DEDUCTIONS_FIRST_MONTH };
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
  const threads = groupDeductionCommentThreads(comments, linesByCandidate);
  return attachDisputeDetail(threads);
}

/** Names for a set of HR ids (the people who decided and pushed), keyed by canonical id. */
async function loadEmployeeNames(hrIds: Array<string | null | undefined>): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  const lookups = Array.from(new Set(hrIds.flatMap((hrId) => hrIdLookupKeys(hrId))));
  if (lookups.length === 0) return names;
  const { data, error } = await getSupabaseAdmin().from("employees").select("hr_id, full_name").in("hr_id", lookups);
  if (error) return names;
  for (const row of (data ?? []) as Array<{ hr_id?: string | null; full_name?: string | null }>) {
    const key = canonicalHrIdKey(row.hr_id);
    const name = String(row.full_name ?? "").trim();
    if (key && name) names.set(key, name);
  }
  return names;
}

/**
 * Give every thread the two things the person answering needs beside the conversation (owner,
 * 2026-10-08): WHY the deduction was made — the candidate row, its evidence and the decision that
 * put it on the payslip — and WHO a reply reaches, the employee and their managers. Best-effort per
 * part: a failed read leaves that part null and the thread still renders, because the conversation
 * is the thing that must never be lost to a detail panel.
 */
async function attachDisputeDetail(threads: AdminDeductionCommentThread[]): Promise<AdminDeductionCommentThread[]> {
  if (threads.length === 0) return threads;
  const supabase = getSupabaseAdmin();
  const candidateIds = threads.map((thread) => thread.candidateId);

  const [candidatesResult, decisionsResult, extrasResult] = await Promise.all([
    supabase
      .from("deductions_candidates")
      .select("id, category, source_system, unit, raw_value, estimated_amount, calculation_status, severity, reason, evidence, dates")
      .in("id", candidateIds),
    supabase
      .from("deductions_decisions")
      .select("candidate_id, decision_status, decision_reason, hr_note, applied_value, applied_amount, applied_dates, decided_by, decided_at, updated_at")
      .in("candidate_id", candidateIds)
      .order("updated_at", { ascending: false }),
    supabase
      .from("deductions_publication_lines")
      .select("candidate_id, pushed_at, pushed_by")
      .in("candidate_id", candidateIds)
      .eq("line_status", "active"),
  ]);

  const candidates = new Map<string, DisputeCandidateRow>();
  for (const row of (candidatesResult.data ?? []) as DisputeCandidateRow[]) candidates.set(row.id, row);
  const decisions = new Map<string, DisputeDecisionRow>();
  for (const row of (decisionsResult.data ?? []) as DisputeDecisionRow[]) {
    // Newest first: the first row seen for a candidate is its current decision.
    if (!decisions.has(row.candidate_id)) decisions.set(row.candidate_id, row);
  }
  const extras = new Map<string, DisputeLineExtraRow>();
  for (const row of (extrasResult.data ?? []) as DisputeLineExtraRow[]) {
    if (!extras.has(row.candidate_id)) extras.set(row.candidate_id, row);
  }

  const names = await loadEmployeeNames([
    ...Array.from(decisions.values()).map((row) => row.decided_by),
    ...Array.from(extras.values()).map((row) => row.pushed_by),
  ]);
  const nameFor = (hrId: string | null | undefined) => {
    const key = canonicalHrIdKey(hrId);
    return key ? names.get(key) ?? null : null;
  };

  return Promise.all(
    threads.map(async (thread) => {
      const candidate = candidates.get(thread.candidateId);
      const basis =
        candidate && thread.line
          ? buildDisputeBasis({
              candidate,
              decision: decisions.get(thread.candidateId) ?? null,
              line: thread.line,
              lineExtra: extras.get(thread.candidateId) ?? null,
              nameFor,
            })
          : null;
      let replyAudience = null;
      try {
        replyAudience = thread.line ? toDisputeAudience(await resolveDisputeAudience(thread.line.employeeCode)) : null;
      } catch {
        replyAudience = null;
      }
      return { ...thread, basis, replyAudience };
    }),
  );
}
