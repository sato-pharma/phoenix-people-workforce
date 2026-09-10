import { compactHrKey } from "@/lib/payroll/copilot/feeders.ts";
import { hrIdForStorage } from "@/lib/hr-id";
import { roundCurrency } from "@/lib/payroll/money";
import type { AccessContext } from "@/lib/auth/permissions";
import { getSupabaseAdmin } from "@/lib/supabase/server";

import { writeAutomatedPayrollAudit } from "./audit.ts";
import { actorId, assertAutomatedPayrollHrActor } from "./permissions.ts";

/**
 * "This held salary was already transferred outside payroll."
 *
 * Owner rule 2026-09-10: a held employee is paid by hand during the month, and until now nothing
 * recorded that it happened — so the next month could work the same amount up again, and nobody
 * could answer "was this settled?" a month later.
 *
 * TWO HALVES, DELIBERATELY FROM DIFFERENT SOURCES, because a single source could not be trusted:
 *
 *   - WHAT WAS WITHHELD comes from the run's own `published` audit row, written at the moment
 *     publish dropped the person. It is a fact about what the system did, produced by the system.
 *   - WHAT WAS PAID comes from this table, typed by a human after a bank transfer. It is an
 *     attestation, and nothing here verifies it against a bank.
 *
 * Keeping them apart is what makes a SHORT payment visible. If a settlement simply overwrote the
 * owed figure, paying 5,000 against 9,800 owed would read as fully settled.
 */

const TABLE = "automated_payroll_held_settlements";

export type HeldSettlement = {
  id: string;
  runId: string;
  employeeHrId: string;
  employeeHrIdCompact: string;
  amount: number;
  paidOn: string;
  method: string | null;
  reference: string | null;
  note: string | null;
  recordedBy: string;
  updatedAt: string;
};

export type HeldSettlementInput = {
  hrId: string;
  amount: number;
  paidOn: string;
  method?: string | null;
  reference?: string | null;
  note?: string | null;
};

/** One month's held person: what the run withheld, and what (if anything) was settled by hand. */
export type HeldBalance = {
  runId: string;
  month: number;
  year: number;
  hrId: string;
  compact: string;
  name: string;
  reason: string | null;
  firstPartAlreadyPaid: number;
  secondPartWithheld: number;
  settled: HeldSettlement | null;
  /** Withheld minus settled, floored at zero. The figure that must not be paid twice. */
  outstanding: number;
};

type Row = Record<string, unknown>;

function mapRow(row: Row): HeldSettlement {
  return {
    id: String(row.id),
    runId: String(row.run_id),
    employeeHrId: String(row.employee_hr_id ?? ""),
    employeeHrIdCompact: String(row.employee_hr_id_compact ?? ""),
    amount: Number(row.amount ?? 0),
    paidOn: String(row.paid_on ?? "").slice(0, 10),
    method: (row.method as string | null) ?? null,
    reference: (row.reference as string | null) ?? null,
    note: (row.note as string | null) ?? null,
    recordedBy: String(row.recorded_by ?? ""),
    updatedAt: String(row.updated_at ?? ""),
  };
}

/**
 * True when the table itself has not been migrated into this environment yet. Same add-only
 * tolerance as every other table in this module: a missing settlements table must never take the
 * payroll sheet down with it.
 */
function isMissingTableError(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code;
  const message = String((error as { message?: string } | null)?.message ?? error ?? "").toLowerCase();
  return code === "42P01" || code === "PGRST205" || (message.includes("relation") && message.includes("does not exist"));
}

function validate(input: HeldSettlementInput): void {
  if (!input.hrId?.trim()) throw new Error("Validation: an employee is required.");
  if (!Number.isFinite(input.amount) || input.amount < 0) {
    throw new Error("Validation: the amount transferred must be a non-negative number.");
  }
  // A date is mandatory. "It was paid at some point" is the state this whole table exists to
  // replace, so a settlement with no date would recreate the problem inside the fix.
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(input.paidOn ?? ""))) {
    throw new Error("Validation: the transfer date is required, as YYYY-MM-DD.");
  }
}

/** Settlements recorded against one run, keyed by compact HR id. */
export async function getHeldSettlements(runId: string): Promise<Map<string, HeldSettlement>> {
  const byCompact = new Map<string, HeldSettlement>();
  const { data, error } = await getSupabaseAdmin().from(TABLE).select("*").eq("run_id", runId);
  if (error) {
    if (isMissingTableError(error)) return byCompact;
    throw error;
  }
  for (const row of (data ?? []) as Row[]) {
    const settlement = mapRow(row);
    if (settlement.employeeHrIdCompact) byCompact.set(settlement.employeeHrIdCompact, settlement);
  }
  return byCompact;
}

/**
 * Record (or correct) the fact that a held person was paid outside payroll.
 *
 * Upsert on (run_id, employee) rather than insert: paying in two transfers updates the one row and
 * says so in the note. Stacking partial rows would leave every reader to sum them correctly, and
 * the first reader to forget would report a settled person as unpaid.
 */
export async function recordHeldSettlement(
  access: AccessContext,
  runId: string,
  input: HeldSettlementInput,
): Promise<HeldSettlement> {
  assertAutomatedPayrollHrActor(access);
  validate(input);

  const compact = compactHrKey(input.hrId);
  if (!compact) throw new Error("Validation: that employee id is not usable.");

  const payload = {
    run_id: runId,
    // Storage casing for the human-readable column, compact for every join — the mixed-case HR id
    // trap this repo has repaired in six other columns.
    employee_hr_id: hrIdForStorage(input.hrId) ?? input.hrId.trim(),
    employee_hr_id_compact: compact,
    amount: roundCurrency(input.amount),
    paid_on: input.paidOn,
    method: input.method?.trim() || null,
    reference: input.reference?.trim() || null,
    note: input.note?.trim() || null,
    recorded_by: actorId(access),
    updated_at: new Date().toISOString(),
  };

  const { data, error } = await getSupabaseAdmin()
    .from(TABLE)
    .upsert(payload, { onConflict: "run_id,employee_hr_id_compact" })
    .select("*")
    .single();
  if (error) throw error;

  const settlement = mapRow(data as Row);
  await writeAutomatedPayrollAudit({
    runId,
    actorHrId: actorId(access),
    action: "held_settlement_recorded",
    detail: {
      hrId: settlement.employeeHrId,
      amount: settlement.amount,
      paidOn: settlement.paidOn,
      method: settlement.method,
      reference: settlement.reference,
    },
  });
  return settlement;
}

/** Withdraw a settlement that was recorded in error. Audited, because it re-opens a debt. */
export async function deleteHeldSettlement(
  access: AccessContext,
  runId: string,
  hrId: string,
): Promise<void> {
  assertAutomatedPayrollHrActor(access);
  const compact = compactHrKey(hrId);
  if (!compact) throw new Error("Validation: that employee id is not usable.");

  const { error } = await getSupabaseAdmin()
    .from(TABLE)
    .delete()
    .eq("run_id", runId)
    .eq("employee_hr_id_compact", compact);
  if (error) throw error;

  await writeAutomatedPayrollAudit({
    runId,
    actorHrId: actorId(access),
    action: "held_settlement_withdrawn",
    detail: { hrId, compact },
  });
}

type PublishedHeldEntry = {
  hrId?: unknown;
  name?: unknown;
  reason?: unknown;
  firstPartAlreadyPaid?: unknown;
  secondPartWithheld?: unknown;
};

function num(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Every held person from every PUBLISHED run, with what they were withheld and whether it has been
 * settled by hand since.
 *
 * Reads the `published` audit row rather than re-assembling the month. That row is written at the
 * exact moment publish drops the person and is never recomputed, so it cannot drift as salaries
 * change afterwards — and re-assembling an old month would produce today's numbers for a payment
 * decision taken weeks ago.
 *
 * `excludeRunId` drops the run being worked on, so the current month's own holds do not read as a
 * debt against themselves.
 */
export async function loadHeldBalances(options?: { excludeRunId?: string }): Promise<HeldBalance[]> {
  const admin = getSupabaseAdmin();

  const { data: auditRows, error: auditError } = await admin
    .from("automated_payroll_audit")
    .select("run_id,detail,created_at")
    .eq("action", "published")
    .order("created_at", { ascending: false });
  if (auditError) {
    if (isMissingTableError(auditError)) return [];
    throw auditError;
  }

  const runIds = Array.from(
    new Set(((auditRows ?? []) as Row[]).map((row) => String(row.run_id ?? "")).filter(Boolean)),
  );
  if (runIds.length === 0) return [];

  // Chunked: a PostgREST `.in()` carrying several hundred ids returns zero rows and no error.
  // Run counts are small today, and this is the shape that stays correct when they are not.
  const runsById = new Map<string, { month: number; year: number }>();
  for (let index = 0; index < runIds.length; index += 50) {
    const chunk = runIds.slice(index, index + 50);
    const { data, error } = await admin
      .from("automated_payroll_runs")
      .select("id,month,year")
      .in("id", chunk);
    if (error) throw error;
    for (const row of (data ?? []) as Row[]) {
      runsById.set(String(row.id), { month: Number(row.month ?? 0), year: Number(row.year ?? 0) });
    }
  }

  const settlementsByRun = new Map<string, Map<string, HeldSettlement>>();
  for (const runId of runIds) settlementsByRun.set(runId, await getHeldSettlements(runId));

  const balances: HeldBalance[] = [];
  const seen = new Set<string>();
  for (const row of (auditRows ?? []) as Row[]) {
    const runId = String(row.run_id ?? "");
    if (!runId || runId === options?.excludeRunId) continue;
    // A run can legitimately have more than one `published` audit row (an interrupted publish that
    // was retried). Newest first, so the first one seen is the one that stands.
    if (seen.has(runId)) continue;
    seen.add(runId);

    const period = runsById.get(runId);
    if (!period) continue;
    const detail = (row.detail ?? {}) as { held?: unknown };
    const held = Array.isArray(detail.held) ? (detail.held as PublishedHeldEntry[]) : [];
    const settlements = settlementsByRun.get(runId) ?? new Map<string, HeldSettlement>();

    for (const entry of held) {
      const hrId = String(entry.hrId ?? "");
      const compact = compactHrKey(hrId);
      if (!compact) continue;
      const withheld = roundCurrency(num(entry.secondPartWithheld));
      const settled = settlements.get(compact) ?? null;
      balances.push({
        runId,
        month: period.month,
        year: period.year,
        hrId,
        compact,
        name: String(entry.name ?? ""),
        reason: entry.reason == null ? null : String(entry.reason),
        firstPartAlreadyPaid: roundCurrency(num(entry.firstPartAlreadyPaid)),
        secondPartWithheld: withheld,
        settled,
        outstanding: Math.max(0, roundCurrency(withheld - (settled?.amount ?? 0))),
      });
    }
  }
  return balances;
}

/**
 * Outstanding held money per employee across every earlier published month, keyed by compact HR id.
 *
 * This is what the current run needs in order to answer the owner's question — "the next payroll
 * they should not be added ... I have nothing to say that this is already transferred outside the
 * payroll". A person with an outstanding balance here has money the company still owes; a person
 * with none has either never been held or has been settled by hand and recorded.
 */
export async function outstandingHeldByEmployee(currentRunId: string): Promise<Map<string, HeldBalance[]>> {
  const balances = await loadHeldBalances({ excludeRunId: currentRunId });
  const byEmployee = new Map<string, HeldBalance[]>();
  for (const balance of balances) {
    if (balance.outstanding <= 0) continue;
    const list = byEmployee.get(balance.compact) ?? [];
    list.push(balance);
    byEmployee.set(balance.compact, list);
  }
  return byEmployee;
}
