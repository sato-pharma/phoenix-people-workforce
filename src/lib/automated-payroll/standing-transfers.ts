import { compactHrKey } from "@/lib/payroll/copilot/feeders.ts";
import { roundCurrency } from "@/lib/payroll/money";
import { getSupabaseAdmin } from "@/lib/supabase/server";

import { writeAutomatedPayrollAudit } from "./audit.ts";
import type { MonthlySalaryRun, NonEmployeePart, PayrollPeriod } from "./types.ts";
import { isNonEmployeePart } from "./types.ts";

/**
 * STANDING TRANSFERS — part of an employee's salary paid to a non-employee, every month for a window.
 *
 * Owner request 2026-11-24: 1,500 EGP from each part of Omar Gawish's salary to Anwar Ibrahim Ahmed
 * Ibrahim Gaweesh on the Non-Employees list, "starting from november 2026 and 11 months ahead".
 *
 * One register row is one instalment of one transfer, and it does two things while the month is due:
 *
 *   1. It PRE-FILLS the employee's deduction for that part — Part 1 on Special Situations (Apply To:
 *      First Part), Part 2 on "Any more deductions?". HR still confirms the step, and a figure HR has
 *      already saved on the draft row always wins (recommend.ts `pick`). Nothing is charged here.
 *   2. It SEEDS the payee's line of that amount on the run's Non-Employees list for that part, linked
 *      back by `standing_transfer_id` — one line per run per transfer, so a re-seed never adds twice.
 *      The line is an ordinary per-run entry from then on: edited, locked, sheeted and paid exactly as
 *      a typed one. It never edits a line HR typed.
 *
 * The due rule and the per-part sums are pure so they are tested directly; only the loaders do I/O.
 */

export type StandingTransfer = {
  id: string;
  employeeHrId: string;
  employeeHrIdCompact: string;
  part: NonEmployeePart;
  amount: number;
  /** "YYYY-MM" */
  firstMonthKey: string;
  /** "YYYY-MM", inclusive. */
  lastMonthKey: string;
  payeeFullNameEn: string;
  payeeFullNameAr: string;
  payeeBankName: string;
  payeeBankAccount: string;
  reason: string;
  active: boolean;
};

/** What one employee gives this month, per part. */
export type StandingTransfersForEmployee = {
  first: number;
  second: number;
  firstReason: string;
  secondReason: string;
};

const TABLE = "automated_payroll_standing_transfers";
const RUN_TABLE = "automated_payroll_non_employees";

type Row = Record<string, unknown>;
type SeedClient = Pick<ReturnType<typeof getSupabaseAdmin>, "from">;

function monthIndexFromKey(monthKey: string): number | null {
  const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(monthKey);
  if (!match) return null;
  return Number(match[1]) * 12 + (Number(match[2]) - 1);
}

/** True when the transfer falls due in the given period — every month from the first to the last, inclusive. */
export function isStandingTransferDue(entry: StandingTransfer, period: PayrollPeriod): boolean {
  if (!entry.active || !(entry.amount > 0)) return false;
  const current = period.year * 12 + (period.month - 1);
  const first = monthIndexFromKey(entry.firstMonthKey);
  const last = monthIndexFromKey(entry.lastMonthKey);
  if (first === null || last === null) return false;
  return current >= first && current <= last;
}

/** A plain-words line naming the payee, for the step's reason and its breakdown. */
export function standingTransferReason(entry: StandingTransfer): string {
  const label = entry.part === "first" ? "Part 1" : "Part 2";
  return `Standing transfer to ${entry.payeeFullNameEn.trim()} (Non-Employees, ${label}): ${roundCurrency(entry.amount).toLocaleString("en-US")} EGP, ${entry.firstMonthKey} to ${entry.lastMonthKey}`;
}

/** Everything due this period, summed per employee and part, keyed by the compact HR id the run uses. */
export function standingTransfersByCompact(
  entries: StandingTransfer[],
  period: PayrollPeriod,
): Map<string, StandingTransfersForEmployee> {
  const byCompact = new Map<string, StandingTransfersForEmployee>();
  for (const entry of entries) {
    if (!isStandingTransferDue(entry, period)) continue;
    // Normalised here, not trusted from the row: the run keys every employee by compactHrKey (lower
    // case), and a register row typed "B10" would otherwise match nobody — exactly how the standing
    // additions' "A12" missed its employee.
    const compact = compactHrKey(entry.employeeHrIdCompact || entry.employeeHrId);
    if (!compact) continue;
    const current = byCompact.get(compact) ?? { first: 0, second: 0, firstReason: "", secondReason: "" };
    const reason = standingTransferReason(entry);
    if (entry.part === "first") {
      current.first = roundCurrency(current.first + entry.amount);
      current.firstReason = current.firstReason ? `${current.firstReason}; ${reason}` : reason;
    } else {
      current.second = roundCurrency(current.second + entry.amount);
      current.secondReason = current.secondReason ? `${current.secondReason}; ${reason}` : reason;
    }
    byCompact.set(compact, current);
  }
  return byCompact;
}

function isMissingTableError(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code;
  const message = String((error as { message?: string } | null)?.message ?? error ?? "").toLowerCase();
  return code === "42P01" || code === "PGRST205" || (message.includes("relation") && message.includes("does not exist"));
}

function isMissingTransferColumnError(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code;
  const message = String((error as { message?: string } | null)?.message ?? error ?? "").toLowerCase();
  return code === "42703" || code === "PGRST204" || (message.includes("standing_transfer_id") && message.includes("column"));
}

function mapRow(row: Row): StandingTransfer {
  return {
    id: String(row.id),
    employeeHrId: String(row.employee_hr_id ?? ""),
    employeeHrIdCompact: compactHrKey(String(row.employee_hr_id_compact ?? "") || String(row.employee_hr_id ?? "")),
    part: isNonEmployeePart(row.part) ? row.part : "first",
    amount: Number(row.amount ?? 0),
    firstMonthKey: String(row.first_month_key ?? ""),
    lastMonthKey: String(row.last_month_key ?? ""),
    payeeFullNameEn: String(row.payee_full_name_en ?? ""),
    payeeFullNameAr: String(row.payee_full_name_ar ?? ""),
    payeeBankName: String(row.payee_bank_name ?? ""),
    payeeBankAccount: String(row.payee_bank_account ?? ""),
    reason: String(row.reason ?? ""),
    active: row.active !== false,
  };
}

/**
 * Every active register row. FAILS CLOSED on a read error — a deduction that silently reads as zero
 * pays the employee money that belongs to somebody else. Only a table not yet migrated answers empty.
 */
export async function loadActiveStandingTransfers(client: SeedClient = getSupabaseAdmin()): Promise<StandingTransfer[]> {
  const { data, error } = await client.from(TABLE).select("*").eq("active", true);
  if (error) {
    if (isMissingTableError(error)) return [];
    throw error;
  }
  return ((data ?? []) as Row[]).map(mapRow);
}

/** The deductions due this period, per employee and part — what the two steps pre-fill. */
export async function loadStandingTransfers(period: PayrollPeriod): Promise<Map<string, StandingTransfersForEmployee>> {
  return standingTransfersByCompact(await loadActiveStandingTransfers(), period);
}

/** The same per-part rule the standing list uses: never add to an instalment whose money is out. */
function partStillOpen(part: NonEmployeePart, phase: MonthlySalaryRun["phase"]): boolean {
  return part === "first" ? phase === "part1" : phase === "part1" || phase === "part2";
}

export type StandingTransferSeedResult = {
  /** Lines added by this call, as "<payee> (<part>)". */
  inserted: string[];
  /** Due transfers whose part is already confirmed, so no line could be added. */
  heldBackPartClosed: string[];
};

/**
 * Put each due transfer's payee line on one run's Non-Employees list. Idempotent by
 * `(run_id, standing_transfer_id)`: a line already there is left exactly as it is, amount included.
 */
export async function seedRunFromStandingTransfers(input: {
  runId: string;
  actorHrId: string;
  phase: MonthlySalaryRun["phase"];
  period: PayrollPeriod;
  client?: SeedClient;
}): Promise<StandingTransferSeedResult> {
  const client = input.client ?? getSupabaseAdmin();
  const empty: StandingTransferSeedResult = { inserted: [], heldBackPartClosed: [] };
  const due = (await loadActiveStandingTransfers(client)).filter((entry) => isStandingTransferDue(entry, input.period));
  if (due.length === 0) return empty;

  const { data: existing, error: existingError } = await client
    .from(RUN_TABLE)
    .select("standing_transfer_id")
    .eq("run_id", input.runId);
  if (existingError) {
    if (isMissingTransferColumnError(existingError) || isMissingTableError(existingError)) return empty;
    throw existingError;
  }
  const alreadySeeded = new Set(
    ((existing ?? []) as Row[]).map((row) => String(row.standing_transfer_id ?? "")).filter(Boolean),
  );

  const label = (entry: StandingTransfer) => `${entry.payeeFullNameEn} (${entry.part})`;
  const heldBackPartClosed: string[] = [];
  const pending = due.filter((entry) => {
    if (alreadySeeded.has(entry.id)) return false;
    if (!partStillOpen(entry.part, input.phase)) {
      heldBackPartClosed.push(label(entry));
      return false;
    }
    return true;
  });
  if (pending.length === 0) return { inserted: [], heldBackPartClosed };

  const { error } = await client.from(RUN_TABLE).insert(
    pending.map((entry) => ({
      run_id: input.runId,
      standing_transfer_id: entry.id,
      full_name_ar: entry.payeeFullNameAr,
      full_name_en: entry.payeeFullNameEn,
      total_salary: entry.amount,
      bank_name: entry.payeeBankName,
      bank_account: entry.payeeBankAccount,
      part: entry.part,
      created_by: input.actorHrId,
    })),
  );
  if (error) throw error;

  await writeAutomatedPayrollAudit(
    {
      runId: input.runId,
      actorHrId: input.actorHrId,
      action: "non_employee_standing_transfer_seeded",
      detail: {
        inserted: pending.length,
        names: pending.map(label),
        total: roundCurrency(pending.reduce((sum, entry) => sum + entry.amount, 0)),
        heldBackPartClosed,
      },
    },
    input.client,
  );

  return { inserted: pending.map(label), heldBackPartClosed };
}
