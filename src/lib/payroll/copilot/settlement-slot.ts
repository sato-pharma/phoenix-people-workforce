import { getEmployeeDirectory } from "@/lib/employees/employee-directory";
import { getSupabaseAdmin } from "@/lib/supabase/server";

/**
 * The one rule every writer of payroll_copilot_vacation_settlements has to obey, in one place.
 *
 * `payroll_copilot_vacation_settlements_live_idx` is a UNIQUE index over
 * (employee_hr_id_compact, start_date) WHERE superseded_at IS NULL. So one employee+date has
 * exactly ONE live row across every writer of this ledger — the Copilot's unpaid-vacation decision,
 * the Copilot's holiday-bridging exclusion, an automated payroll run, and a one-off system
 * correction all compete for the same slot.
 *
 * That is why the ordering matters. A writer that retires the live row BEFORE inserting its
 * replacement destroys somebody else's decision whenever its own insert then fails — and on
 * 2026-08-04 07:49:03 Cairo exactly that happened on production: a payroll run retired Khaled
 * Mohamed Ali Bedair's 1.00-day balance settlement of 2026-07-12, written by
 * `system:crm-correction-2026-07-21`, and replaced it with nothing (fixed for that writer in #5032).
 *
 * The ordering every writer here uses instead: INSERT FIRST with nothing retired. A failure that is
 * not the live-slot collision means the row was never going to land, so nothing may be retired on
 * its behalf. Only the collision justifies a supersede, and only over a row the caller can show is
 * its OWN earlier answer to the same question.
 */

/** The methods that record a PAYMENT decision — the figure-bearing four. */
export const SETTLEMENT_PAYMENT_METHODS = ["salary", "balance", "partial_balance", "defer_to_balance"] as const;

/**
 * HR's exclusion of one mandatory holiday-bridging day. Deliberately NOT a payment method: it
 * carries neither figure, and `balanceSettledDaysInPeriod` sums only the four above, so a bridging
 * exclusion can never move a leave balance.
 */
export const HOLIDAY_BRIDGE_EXCLUDED_METHOD = "holiday_bridge_excluded";

/**
 * The live-slot collision on `payroll_copilot_vacation_settlements_live_idx`. It is the ONE insert
 * failure a supersede can legitimately clear; every other failure means the row was never going to
 * land, so nothing may be retired on its behalf.
 *
 * Postgres raises the unique violation BEFORE a foreign-key one, so stopping at a non-collision
 * error is not sufficient on its own — the holder of the slot is still identified before anything is
 * touched.
 */
export function isLiveSettlementCollision(error: unknown): boolean {
  return String((error as { code?: unknown } | null)?.code ?? "") === "23505";
}

export type LiveSettlementSlotHolder = {
  id: string;
  runId: string | null;
  decidedBy: string | null;
  settlementMethod: string;
  vacationRequestIds: string[];
};

/**
 * Who currently holds the live slot for this employee+date, or null when it is free. At most one row
 * can come back — the partial unique index guarantees it.
 *
 * Read this BEFORE retiring anything. A slot held by a decision the caller did not make belongs to
 * somebody else: report it, never clear it.
 */
export async function readLiveSettlementSlotHolder(
  client: Pick<ReturnType<typeof getSupabaseAdmin>, "from">,
  employeeHrIdCompact: string,
  startDate: string,
): Promise<{ holder: LiveSettlementSlotHolder | null; error: unknown }> {
  const { data, error } = await client
    .from("payroll_copilot_vacation_settlements")
    .select("id,run_id,decided_by,settlement_method,vacation_request_ids")
    .eq("employee_hr_id_compact", employeeHrIdCompact)
    .eq("start_date", startDate)
    .is("superseded_at", null)
    .maybeSingle();
  if (error) return { holder: null, error };
  if (!data) return { holder: null, error: null };

  const row = data as {
    id: string;
    run_id: string | null;
    decided_by: string | null;
    settlement_method: string | null;
    vacation_request_ids: unknown;
  };
  // jsonb, so it arrives as a parsed array — but a hand-written correction row could hold anything.
  const requestIds = Array.isArray(row.vacation_request_ids)
    ? row.vacation_request_ids.map((value) => String(value))
    : [];
  return {
    holder: {
      id: row.id,
      runId: row.run_id ?? null,
      decidedBy: row.decided_by ?? null,
      settlementMethod: String(row.settlement_method ?? ""),
      vacationRequestIds: requestIds,
    },
    error: null,
  };
}

/**
 * Replaces the caller's OWN earlier row in a slot: retire it, insert the replacement, and PUT THE
 * EARLIER ROW BACK if the replacement does not land.
 *
 * Insert-first ordering alone does not finish the job, and a test caught it: the unique index is
 * evaluated inside the row insert while the CHECK and the foreign key are evaluated after it, so
 * Postgres reports `23505` FIRST whenever the slot is occupied. A re-decision therefore sees a
 * collision, legitimately supersedes its own earlier row — and only then discovers, on the retry
 * against a now-free slot, that the row could never have landed at all (`23514` from the method
 * CHECK, `23503` from the run_id foreign key). That leaves the slot empty: exactly the "destroy a
 * row, write nothing" outcome insert-first was adopted to prevent, reached by a longer route.
 *
 * So the retirement is undone. The compensating update is narrow — it reverses a write that
 * succeeded moments earlier — and if it is itself refused the ledger refuses to corrupt rather than
 * silently diverging: `..._live_idx` would reject a second live row in the slot, so the worst case is
 * a retired row that is reported loudly, never two live rows double-counting a leave balance.
 */
export async function replaceOwnSettlementRow(
  client: Pick<ReturnType<typeof getSupabaseAdmin>, "from">,
  holder: LiveSettlementSlotHolder,
  row: Record<string, unknown>,
): Promise<{ error: unknown; retiredAndNotReplaced: boolean }> {
  // The exact stamp this call writes, so the reversal below can match on it.
  const supersededAt = new Date().toISOString();
  const { error: supersedeError } = await client
    .from("payroll_copilot_vacation_settlements")
    .update({ superseded_at: supersededAt })
    .eq("id", holder.id)
    .is("superseded_at", null);
  if (supersedeError) return { error: supersedeError, retiredAndNotReplaced: false };

  const retry = await client.from("payroll_copilot_vacation_settlements").insert(row);
  if (!retry.error) return { error: null, retiredAndNotReplaced: false };

  // Reverse ONLY a retirement this call made. `.eq("superseded_at", supersededAt)` is what makes that
  // true: PostgREST reports no error for an update that matched nothing, so without the stamp this
  // would un-retire the row whoever had retired it — and if another writer (a `reject`, an `include`,
  // a hand correction) retired it inside this window, the slot is free, the unique index has nothing
  // to object to, and a deliberately retired settlement comes back to life. One that consumed balance
  // would then have its leave days counted a second time by balanceSettledDaysInPeriod.
  const { error: restoreError } = await client
    .from("payroll_copilot_vacation_settlements")
    .update({ superseded_at: null })
    .eq("id", holder.id)
    .eq("superseded_at", supersededAt);
  return { error: retry.error, retiredAndNotReplaced: Boolean(restoreError) };
}

export type SettlementWriteOutcome =
  /** The row is live in the slot. Any predecessor it replaced is superseded. */
  | { kind: "written" }
  /** The slot is held by a decision the caller did not make. NOTHING was retired. */
  | { kind: "conflict"; holder: LiveSettlementSlotHolder }
  /** The row did not land. `retiredAndNotReplaced` is the one state that needs a human. */
  | { kind: "failed"; error: unknown; retiredAndNotReplaced: boolean };

/**
 * Claims the slot for `row`, retiring the caller's OWN earlier answer if one holds it and never
 * anybody else's. The whole ordering rule, in one place, for every writer of this ledger.
 *
 * THE HOLDER IS READ FIRST, NOT INFERRED FROM A COLLISION. An earlier version of this leaned on
 * Postgres raising `23505` to discover that the slot was occupied, which made the supersede depend
 * on `..._live_idx` existing: drop that index and a re-decision would insert a SECOND live row for
 * one employee+date, which `balanceSettledDaysInPeriod` sums — it would double-count somebody's
 * consumed leave with nothing erroring. A pre-read costs one query and makes the behaviour the
 * code's own rather than the index's. The collision is still handled, because a read-then-insert can
 * be raced, and the index remains the backstop that makes the race safe rather than the mechanism.
 */
export async function writeIntoSettlementSlot(
  client: Pick<ReturnType<typeof getSupabaseAdmin>, "from">,
  input: {
    employeeHrIdCompact: string;
    startDate: string;
    row: Record<string, unknown>;
    /** True when the live holder is the caller's OWN earlier answer to the same question. */
    ownsHolder: (holder: LiveSettlementSlotHolder) => boolean;
  },
): Promise<SettlementWriteOutcome> {
  const claim = async (holder: LiveSettlementSlotHolder): Promise<SettlementWriteOutcome> => {
    if (!input.ownsHolder(holder)) return { kind: "conflict", holder };
    const { error, retiredAndNotReplaced } = await replaceOwnSettlementRow(client, holder, input.row);
    return error ? { kind: "failed", error, retiredAndNotReplaced } : { kind: "written" };
  };

  const first = await readLiveSettlementSlotHolder(client, input.employeeHrIdCompact, input.startDate);
  if (first.error) return { kind: "failed", error: first.error, retiredAndNotReplaced: false };
  if (first.holder) return claim(first.holder);

  // The slot read as free, so the insert is attempted with nothing retired.
  const attempt = await client.from("payroll_copilot_vacation_settlements").insert(input.row);
  if (!attempt.error) return { kind: "written" };
  if (!isLiveSettlementCollision(attempt.error)) {
    return { kind: "failed", error: attempt.error, retiredAndNotReplaced: false };
  }

  // Raced: somebody claimed the slot between the read and the insert. Re-read and decide again.
  const second = await readLiveSettlementSlotHolder(client, input.employeeHrIdCompact, input.startDate);
  if (second.error || !second.holder) {
    return { kind: "failed", error: second.error ?? attempt.error, retiredAndNotReplaced: false };
  }
  return claim(second.holder);
}

/** How each stored method reads to a person. Never the raw column value. */
const METHOD_LABELS: Record<string, string> = {
  salary: "a salary-deduction settlement",
  balance: "a settlement taken from leave balance",
  partial_balance: "a part-balance, part-salary settlement",
  defer_to_balance: "a settlement deferred to future leave balance",
  [HOLIDAY_BRIDGE_EXCLUDED_METHOD]: "a holiday-bridging exclusion",
};

/**
 * Describes the holder for an error message HR or the CEO will read — by NAME, never by HR id or
 * stored code, which is the owner's standing rule for anything a person reads.
 *
 * `decided_by` is an HR id (`B-10`) or a system token (`system:crm-correction-2026-07-21`), so the
 * raw value can never be shown: the directory resolves the id to a person, and a system token is
 * rendered as what it is. A directory read that fails degrades to "another decision" rather than
 * leaking the code or throwing — this sits on an error path, and failing it would replace a useful
 * refusal with an outage.
 */
export async function describeSlotHolder(holder: LiveSettlementSlotHolder): Promise<string> {
  const method = METHOD_LABELS[holder.settlementMethod] ?? "an existing settlement";
  const decidedBy = holder.decidedBy?.trim();
  if (!decidedBy) return `${method} with no recorded decider`;

  if (decidedBy.startsWith("system:")) {
    return `${method} recorded by an automated correction (${decidedBy.slice("system:".length)})`;
  }

  try {
    const directory = await getEmployeeDirectory();
    const key = decidedBy.toLowerCase().replace(/[^a-z0-9]+/g, "");
    const person = directory.employees.find(
      (employee) => employee.hrId.toLowerCase().replace(/[^a-z0-9]+/g, "") === key,
    );
    if (person?.fullName) return `${method} recorded by ${person.fullName}`;
  } catch {
    // Fall through — an unresolvable decider must not turn a clear refusal into a failed request.
  }
  return `${method} recorded by another decision`;
}
