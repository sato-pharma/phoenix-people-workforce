import { assertPermission, type AccessContext } from "@/lib/auth/permissions";
import { DEPARTED_EMPLOYMENT_STATUSES, hasDepartedEmployment } from "@/lib/auth/session-lifecycle";
import { getSupabaseAdmin } from "@/lib/supabase/server";

import { PAYROLL_APPROVED_STATUS } from "@/lib/automated-payroll/deductions-source.ts";

import { compactDeductionsHrId } from "./candidate-key.ts";

/**
 * Leavers whose APPROVED deduction has not been collected on-system while there is still a final
 * settlement to net it into. This is the Needs You board's one preventive reading of the leaver-CRM
 * gap — NOT a ledger of money already lost.
 *
 * 🔴 THE OWNER'S SCOPE, 2026-10-07. "He leaves and he takes the money — nothing to do. We audit the
 * history, learn, and build something that prevents this again." Once a leaver has gone and been
 * paid, the money is unrecoverable and must NOT appear here. So this reads only:
 *   - leavers from `CLOSED_COHORT_FLOOR` forward. The August-2026-and-earlier leavers were settled
 *     OFF-system before the 2026-08-23 settlement path existed, and the owner confirmed them closed
 *     (memory: `one-part-employees-have-no-part-2-for-deductions-to-land-in`). The database cannot
 *     tell "settled off-system" from "never collected", so the only safe exclusion is this date floor.
 *   - within a rolling `ACTIONABLE_WINDOW_DAYS`, so the row is about the NEXT one — a leaver whose
 *     final settlement is plausibly still open or just-closed — and never grows into a standing list
 *     of gone money.
 *
 * 🔴 NO EGP ON THE BOARD. This type carries no amount, on purpose — the same rule the payroll and
 * orphaned-requests adapters keep (sources.ts). The figures live on /admin/deductions; the board row
 * says WHO and WHICH months and links there.
 *
 * 🔴 IT THROWS on a read it cannot complete, never returns empty. An empty array from a failed read
 * is exactly the under-report this whole module exists to prevent — the adapter turns a throw into an
 * amber "could not be read" row. Mirrors `getPayrollAwaitingPublish`.
 */

/** Leavers on or before this date were settled off-system and closed by the owner — never surface them. */
export const CLOSED_COHORT_FLOOR = "2026-09-01";

/** A leaver older than this is gone and settled; the row is about the one still inside the window. */
export const ACTIONABLE_WINDOW_DAYS = 90;

const CANDIDATES = "deductions_candidates";
const SALARY_RECORDS = "salary_records";
const EMPLOYEES = "employees";

/** A PostgREST `.in()` carrying several hundred ids returns zero rows and no error. */
const IN_CHUNK = 100;

/**
 * Which `salary_records` column collects each deduction category. A category not in this map is
 * treated as NOT collected (the row shows), because over-reporting a leaver to glance at costs two
 * seconds and under-reporting one costs the money. See the board's governing rule in types.ts.
 */
const CATEGORY_TO_SALARY_COLUMN: Record<string, string> = {
  crm: "crm",
  crm_half_day: "crm",
  field_review: "crm",
  no_records_activity: "crm",
  unpaid_vacation: "unpaid_vacations",
  insufficient_balance_vacation: "unpaid_vacations",
  fingerprint: "finger_print",
  loan: "loans",
  other: "other_deductions",
};

const SALARY_DEDUCTION_COLUMNS = ["crm", "unpaid_vacations", "finger_print", "loans", "other_deductions"] as const;

/**
 * The read-back select, spelled out as a LITERAL — never a `${SALARY_DEDUCTION_COLUMNS.join(", ")}`
 * template. supabase-js parses the select string at COMPILE time, so a runtime-joined select yields
 * a `ParserError` type and the row read loses its type entirely (TS2352 — the CI box caught exactly
 * this). It must name every column in SALARY_DEDUCTION_COLUMNS plus the batch embed; the adapter
 * test pins that so the two cannot drift.
 */
const SALARY_RECORDS_SELECT =
  "hr_id, crm, unpaid_vacations, finger_print, loans, other_deductions, salary_batches(month, year)";

/** `42P01` is Postgres' "undefined table"; `PGRST205` is PostgREST's for the same fact. */
function isMissingTableError(error: unknown): boolean {
  const code = String((error as { code?: unknown } | null)?.code ?? "");
  return code === "42P01" || code === "PGRST205";
}

export type UncollectedLeaverDeduction = {
  hrId: string;
  /** The person's NAME. No EGP field here on purpose — the board never states the amount. */
  name: string | null;
  /** Date-only, the leaver's last working day — the sort key and the age the board shows. */
  lastWorkingDate: string;
  /** The month keys ("YYYY-MM") that carry an uncollected approved deduction, oldest first. */
  months: string[];
  /** Distinct categories across those months, for the row's note. */
  categories: string[];
};

type LeaverRow = {
  hrId: string;
  compact: string;
  name: string | null;
  lastWorkingDate: string;
  employmentStatus: string;
};

type ApprovedCandidate = { compact: string; monthKey: string; category: string };

/**
 * PURE core: given the leavers, their live approved deductions, and the set of
 * `${compact}:${monthKey}:${column}` collections that DID happen, return one entry per leaver who
 * still has an uncollected approved deduction inside the actionable window.
 *
 * Kept pure so the window rule, the floor and the per-category collection check are unit-tested
 * without a database. The DB fetch below only assembles its three inputs.
 */
export function selectUncollectedLeaverDeductions(input: {
  now: Date;
  leavers: readonly LeaverRow[];
  approved: readonly ApprovedCandidate[];
  collected: ReadonlySet<string>;
}): UncollectedLeaverDeduction[] {
  const windowFloor = new Date(input.now.getTime() - ACTIONABLE_WINDOW_DAYS * 86_400_000);
  const eligible = new Map<string, LeaverRow>();
  for (const leaver of input.leavers) {
    if (!hasDepartedEmployment(leaver.employmentStatus)) continue;
    const lwd = String(leaver.lastWorkingDate ?? "").slice(0, 10);
    if (!lwd) continue;
    // The closed-cohort floor AND the rolling window, both. Today the floor binds (the window reaches
    // back past it); once the window's back edge passes the floor it binds instead — either way the
    // August cohort is never shown.
    if (lwd < CLOSED_COHORT_FLOOR) continue;
    if (new Date(`${lwd}T00:00:00Z`).getTime() < windowFloor.getTime()) continue;
    if (leaver.compact) eligible.set(leaver.compact, { ...leaver, lastWorkingDate: lwd });
  }

  const byLeaver = new Map<string, { leaver: LeaverRow; months: Set<string>; categories: Set<string> }>();
  for (const candidate of input.approved) {
    const leaver = eligible.get(candidate.compact);
    if (!leaver) continue;
    const column = CATEGORY_TO_SALARY_COLUMN[candidate.category];
    // A known category collected in its own column is done; an UNKNOWN category is never treated as
    // collected (show it) — the safe, over-reporting direction this board requires.
    if (column && input.collected.has(`${candidate.compact}:${candidate.monthKey}:${column}`)) continue;
    const entry = byLeaver.get(candidate.compact) ?? { leaver, months: new Set(), categories: new Set() };
    entry.months.add(candidate.monthKey);
    entry.categories.add(candidate.category);
    byLeaver.set(candidate.compact, entry);
  }

  return [...byLeaver.values()]
    .map(({ leaver, months, categories }) => ({
      hrId: leaver.hrId,
      name: leaver.name,
      lastWorkingDate: leaver.lastWorkingDate,
      months: [...months].sort(),
      categories: [...categories].sort(),
    }))
    .sort((a, b) => a.lastWorkingDate.localeCompare(b.lastWorkingDate));
}

export async function getUncollectedLeaverDeductions(access: AccessContext): Promise<UncollectedLeaverDeduction[]> {
  // The /admin/deductions gate, asserted HERE not left to the page. A `Forbidden:` from this is a
  // viewer with no rung, which the board reads as a TRUE zero (`not-applicable`), never a failure.
  await assertPermission(access, "deductions", "read");
  const supabase = getSupabaseAdmin();
  const now = new Date();

  // ── leavers from the floor forward (the window is re-applied in the pure core) ──
  const { data: leaverRows, error: leaverError } = await supabase
    .from(EMPLOYEES)
    .select("hr_id, full_name, employment_status, last_working_date")
    .in("employment_status", [...DEPARTED_EMPLOYMENT_STATUSES])
    .gte("last_working_date", CLOSED_COHORT_FLOOR);
  if (leaverError) {
    if (isMissingTableError(leaverError)) {
      throw new Error(`The employees table is not reachable (${leaverError.code}) — this is not "no leavers".`);
    }
    throw new Error(`Could not read the leaver roster: ${leaverError.message}`);
  }

  const leavers: LeaverRow[] = [];
  const compacts: string[] = [];
  const displayHrIds: string[] = [];
  for (const row of leaverRows ?? []) {
    const record = row as Record<string, unknown>;
    const hrId = String(record.hr_id ?? "");
    const compact = compactDeductionsHrId(hrId);
    if (!hrId || !compact) continue;
    leavers.push({
      hrId,
      compact,
      name: record.full_name ? String(record.full_name) : null,
      lastWorkingDate: String(record.last_working_date ?? ""),
      employmentStatus: String(record.employment_status ?? ""),
    });
    compacts.push(compact);
    displayHrIds.push(hrId);
  }
  if (leavers.length === 0) return [];

  // ── their LIVE Approved-for-Payroll deductions ──
  const approved: ApprovedCandidate[] = [];
  for (let from = 0; from < compacts.length; from += IN_CHUNK) {
    const chunk = compacts.slice(from, from + IN_CHUNK);
    const { data, error } = await supabase
      .from(CANDIDATES)
      .select("employee_hr_id_compact, month_key, category, deductions_decisions(decision_status)")
      .is("superseded_at", null)
      .in("employee_hr_id_compact", chunk);
    if (error) {
      if (isMissingTableError(error)) {
        throw new Error(`The deductions tables are not reachable (${error.code}) — this is not "nothing is owed".`);
      }
      throw new Error(`Could not read the leavers' deductions: ${error.message}`);
    }
    for (const row of data ?? []) {
      const record = row as Record<string, unknown>;
      const decisions = record.deductions_decisions;
      const decisionArray = Array.isArray(decisions) ? decisions : decisions ? [decisions] : [];
      const isApproved = decisionArray.some(
        (decision) => String((decision as Record<string, unknown>)?.decision_status ?? "") === PAYROLL_APPROVED_STATUS,
      );
      if (!isApproved) continue;
      const compact = String(record.employee_hr_id_compact ?? "");
      const monthKey = String(record.month_key ?? "");
      const category = String(record.category ?? "");
      if (compact && monthKey && category) approved.push({ compact, monthKey, category });
    }
  }
  if (approved.length === 0) return [];

  // ── what was actually collected onto a payslip, per (compact, month, column) ──
  // `salary_records.hr_id` is the DISPLAY form ("B-112"), the same as `employees.hr_id`, so the
  // filter uses the display ids and each returned row is re-canonicalised to a compact for keying —
  // never filter this table by the lowercase compact, which matches nothing.
  const collected = new Set<string>();
  for (let from = 0; from < displayHrIds.length; from += IN_CHUNK) {
    const chunk = displayHrIds.slice(from, from + IN_CHUNK);
    const { data, error } = await supabase
      .from(SALARY_RECORDS)
      .select(SALARY_RECORDS_SELECT)
      .in("hr_id", chunk);
    if (error) {
      if (isMissingTableError(error)) {
        throw new Error(`The salary records table is not reachable (${error.code}) — "uncollected" cannot be proven, so nothing may read as calm.`);
      }
      throw new Error(`Could not read the collected deductions: ${error.message}`);
    }
    for (const row of data ?? []) {
      const record = row as Record<string, unknown>;
      const compact = compactDeductionsHrId(String(record.hr_id ?? ""));
      const batch = record.salary_batches as Record<string, unknown> | null | undefined;
      const month = Number(batch?.month ?? 0);
      const year = Number(batch?.year ?? 0);
      if (!compact || !month || !year) continue;
      const monthKey = `${year}-${String(month).padStart(2, "0")}`;
      for (const column of SALARY_DEDUCTION_COLUMNS) {
        if (Number(record[column] ?? 0) > 0) collected.add(`${compact}:${monthKey}:${column}`);
      }
    }
  }

  return selectUncollectedLeaverDeductions({ now, leavers, approved, collected });
}
