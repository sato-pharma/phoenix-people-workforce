import { assertAutomatedPayrollFinanceActor } from "@/lib/automated-payroll/permissions";
import { loadHeldBalances } from "@/lib/automated-payroll/held-settlements";
import type { AccessContext } from "@/lib/auth/permissions";
import { getSupabaseAdmin } from "@/lib/supabase/server";

/**
 * Which payroll months are waiting to be published, and what is still owed from the ones that were.
 *
 * WHY THIS IS A NEW QUERY. Nothing in this domain could answer "any month". `findActiveRun`
 * (draft-store.ts) takes a month and a year and ends in `.maybeSingle()`; `findPublishedRun` and
 * `readPublishedHoldRecord` are per-run. Every existing reader already knows which period it is
 * looking at, because every existing SCREEN is a period screen. `src/lib/needs-you/` asks the
 * opposite question — is there a month sitting unfinished that I have forgotten about — and that
 * question had no query behind it at all.
 *
 * 🔴 THE FOUR THINGS THIS MUST NOT DO. Each is a real trap in this domain, not a style preference:
 *
 *   1. It must not call `assembleForRun` to count holds. Assembly recomputes TODAY's figures, and a
 *      published month's holds were a payment decision taken weeks ago against the numbers of that
 *      day. `held-settlements.ts` says so at length; this file reuses `loadHeldBalances`, which
 *      reads the published audit row and applies newest-row-wins, rather than re-deriving anything.
 *   2. It must not derive "awaiting publish" from `salary_batches`. The batch is written BY publish,
 *      so a batch-based reading calls a month published the moment `finalizeApproved` runs — before
 *      the run itself is marked — which is the window `run-service.ts` records as able to strand a
 *      month permanently unpublishable.
 *   3. It must not treat a missing table as "nothing is held". `loadHeldBalances` returns `[]` when
 *      the audit table is absent, which is right for its own callers and exactly wrong here: on this
 *      board `[]` renders as "nothing needs you". So the runs read below THROWS on a missing table,
 *      and the adapter turns that into an amber "could not be read" row.
 *   4. It must not sort, rank or decide. It reports; `src/lib/needs-you/classify.ts` orders.
 *
 * Gated on `assertAutomatedPayrollFinanceActor` and not `…Publisher`: this is a READ, and the
 * finance seats already download the locked sheet. The publisher gate guards an ACT. A `Forbidden:`
 * from here means the viewer holds no rung, which the board reads as a true zero rather than a
 * failure.
 */

const RUNS = "automated_payroll_runs";
const DRAFT_ROWS = "automated_payroll_draft_rows";

/** Phases that mean the month is open: work has started and no payslip has been produced. */
const OPEN_PHASES = ["part1", "part2", "ready"] as const;

/** A PostgREST `.in()` carrying several hundred ids returns zero rows and no error. */
const IN_CHUNK = 100;

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
] as const;

/** "September 2026" — the owner reads month names, never `2026-09` and never a run id. */
export function payrollMonthLabel(month: number, year: number): string {
  const name = MONTH_NAMES[month - 1];
  return name ? `${name} ${year}` : `Month ${month} ${year}`;
}

/**
 * Mirrors the private `isMissingTableError` in held-settlements.ts and carry-forward.ts. Kept local
 * for the same reason they each keep their own: neither exports it, and a fourth copy is cheaper
 * than making a shared one that three call sites would then have to be re-pointed at.
 *
 * `42P01` is Postgres' "undefined table". `PGRST205` is what PostgREST answers for a table missing
 * from its schema cache — a different code for the same fact, and the one a session usually meets.
 */
function isMissingTableError(error: unknown): boolean {
  const code = String((error as { code?: unknown } | null)?.code ?? "");
  return code === "42P01" || code === "PGRST205";
}

export type PayrollRunAwaitingPublish = {
  runId: string;
  monthLabel: string;
  phase: (typeof OPEN_PHASES)[number];
  /** When part 2 was confirmed, i.e. when it became publishable. Null while still in part 1. */
  confirmedAt: string | null;
  /** Rows held in this run's draft, or null when the draft rows could not be counted. */
  heldCount: number | null;
};

export type PayrollOutstandingHold = {
  monthLabel: string;
  /** The person's NAME. There is no hrId field here on purpose — see the owner's names rule. */
  name: string;
  outstanding: number;
};

export type PayrollAwaitingPublish = {
  /** Part 2 confirmed, no payslips yet — the months genuinely waiting on a publish. */
  ready: PayrollRunAwaitingPublish[];
  /** Still being worked on. Reported so an abandoned month is visible, never as work waiting. */
  inProgress: PayrollRunAwaitingPublish[];
  /** Money withheld at a past publish and not yet settled. */
  outstandingHolds: PayrollOutstandingHold[];
  /**
   * True when a month recorded a hold COUNT but no names. Pre-2026-09-10 runs filed holds that way,
   * so their people cannot be listed — and a silent short list is exactly what this module must not
   * produce. The board prints this rather than implying the list is complete.
   */
  holdsIncomplete: boolean;
};

export async function getPayrollAwaitingPublish(access: AccessContext): Promise<PayrollAwaitingPublish> {
  assertAutomatedPayrollFinanceActor(access);
  const supabase = getSupabaseAdmin();

  // No month filter, deliberately — that absence IS the new capability.
  const { data: runRows, error: runError } = await supabase
    .from(RUNS)
    .select("id, month, year, phase, part2_confirmed_at")
    .in("phase", [...OPEN_PHASES]);
  if (runError) {
    if (isMissingTableError(runError)) {
      throw new Error(`The payroll runs table is not reachable (${runError.code}) — this is not "no months are open".`);
    }
    throw new Error(`Could not read the open payroll runs: ${runError.message}`);
  }

  const runs = (runRows ?? []).map((row) => {
    const record = row as Record<string, unknown>;
    const month = Number(record.month ?? 0);
    const year = Number(record.year ?? 0);
    return {
      runId: String(record.id ?? ""),
      month,
      year,
      monthLabel: payrollMonthLabel(month, year),
      phase: String(record.phase ?? "") as (typeof OPEN_PHASES)[number],
      confirmedAt: record.part2_confirmed_at ? String(record.part2_confirmed_at) : null,
    };
  }).filter((run) => run.runId);

  const heldByRun = await countHeldDraftRows(runs.map((run) => run.runId));

  const ready: PayrollRunAwaitingPublish[] = [];
  const inProgress: PayrollRunAwaitingPublish[] = [];
  for (const run of runs) {
    const entry: PayrollRunAwaitingPublish = {
      runId: run.runId,
      monthLabel: run.monthLabel,
      phase: run.phase,
      confirmedAt: run.confirmedAt,
      heldCount: heldByRun ? (heldByRun.get(run.runId) ?? 0) : null,
    };
    if (run.phase === "ready") ready.push(entry);
    else inProgress.push(entry);
  }

  // Reused rather than re-derived. `loadHeldBalances` already reads the published audit row, applies
  // newest-row-wins and computes `outstanding`; it also refuses to re-assemble, which is the whole
  // point. No `excludeRunId` here: this board is asked about every month, not about one run's debt
  // against itself.
  const balances = await loadHeldBalances();
  const outstandingHolds = balances
    .filter((balance) => balance.outstanding > 0)
    .map((balance) => ({
      monthLabel: payrollMonthLabel(balance.month, balance.year),
      name: balance.name,
      outstanding: balance.outstanding,
    }));

  return {
    ready,
    inProgress,
    outstandingHolds,
    holdsIncomplete: balances.some((balance) => !balance.name),
  };
}

/**
 * How many rows each open run is holding, or `null` when the draft rows could not be counted.
 *
 * `null` rather than an empty map on purpose: a hold count of 0 and "I could not count the holds"
 * must not render as the same thing, and this whole module exists because they used to.
 */
async function countHeldDraftRows(runIds: readonly string[]): Promise<Map<string, number> | null> {
  if (runIds.length === 0) return new Map();
  const supabase = getSupabaseAdmin();
  const counts = new Map<string, number>();
  for (let from = 0; from < runIds.length; from += IN_CHUNK) {
    const { data, error } = await supabase
      .from(DRAFT_ROWS)
      .select("run_id")
      .eq("on_hold", true)
      .in("run_id", runIds.slice(from, from + IN_CHUNK));
    if (error) return null;
    for (const row of data ?? []) {
      const runId = String((row as Record<string, unknown>).run_id ?? "");
      if (runId) counts.set(runId, (counts.get(runId) ?? 0) + 1);
    }
  }
  return counts;
}
