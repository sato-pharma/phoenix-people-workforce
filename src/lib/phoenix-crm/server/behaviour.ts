/**
 * Phoenix CRM — running the behaviour rules over a month, and filing the verdicts.
 *
 * The rules are pure and live in `@/lib/phoenix-crm/behaviour-integrity`; this file is their I/O.
 *
 * ## 🔴 IT READS `phoenix_crm_visits`, NOT `phoenix_crm_countable_visits`
 *
 * Everywhere else in this module that predicate is the law, and here it is exactly wrong. An
 * off-plan visit waiting for its two approvals is not countable, and it is the single visit you most
 * want judged — a month built out of them would be invisible to a sweep that read the view. This is
 * evidence, not a KPI, and nothing it writes reaches a number anybody is measured by.
 *
 * ## 🔴 THE SALES HALF DOES NOT APPLY THE EL QEMA MASK, DELIBERATELY
 *
 * `withoutMaskedSourceRows` is a PRESENTATION rule: it removes a distributor's detail rows so a
 * screen cannot announce a source that leaves no trace in a closing. Applying it here would remove
 * real money from a total and manufacture "the area sold nothing" for every territory El Qema
 * serves — an accusation built on a mask. So the sweep reads the true totals and then throws the
 * figures away: what it stores is a BOOLEAN, never an amount, so no masked money can reach the
 * signals blob or the board.
 *
 * ## THE REP MUST NOT KNOW, and the sweep tells nobody at all
 *
 * No notification, in either direction — not to a rep, and not to a manager. It computes, it writes,
 * it stops. The board is where a human looks.
 */

import {
  judgeBehaviour,
  monthBounds,
  monthsToRecompute,
  type BehaviourInput,
  type BehaviourVisit,
} from "@/lib/phoenix-crm/behaviour-integrity";
import { throwIfError } from "@/lib/phoenix-crm/server/db";
import { loadClosingBrickSales, upperCode } from "@/lib/sales/closing-brick-sales";
import { lineName } from "@/lib/sales/monthly-targets";
import { SALES_HISTORY_FLOOR, loadUploadedPeriodsInRange } from "@/lib/sales/vs-target";
import { getSupabaseAdmin } from "@/lib/supabase/server";

type Row = Record<string, unknown>;

/** Far above a real month for the whole company; low enough that one night cannot pull the table. */
const VISIT_READ_MAX = 50_000;

export type BehaviourSweepResult = {
  months: string[];
  /** Reps judged, across every month recomputed. */
  reps: number;
  /** Of those, how many months were too thin to judge and were stored as NOT CHECKED. */
  notChecked: number;
  flagged: number;
};

const cairoToday = (): string =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Cairo", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());

function toVisit(row: Row): BehaviourVisit | null {
  const capturedAt = new Date(String(row.captured_at));
  if (Number.isNaN(capturedAt.getTime())) return null;
  const formOpen = row.form_open_seconds === null || row.form_open_seconds === undefined ? null : Number(row.form_open_seconds);
  return {
    visitId: String(row.id ?? ""),
    capturedAt,
    visitDate: String(row.visit_date ?? "").slice(0, 10),
    customerId: String(row.customer_id ?? ""),
    formOpenSeconds: formOpen !== null && Number.isFinite(formOpen) ? formOpen : null,
    objection: typeof row.objection === "string" ? row.objection : null,
  };
}

/** Whose month this is. A manager visiting alone owns his own visit, exactly as the photo sweep reads it. */
function personOf(row: Row): string {
  return String(row.rep_hr_id ?? row.manager_hr_id ?? row.entered_by_hr_id ?? "").toUpperCase();
}

/**
 * One month's sales answer per line: did this line sell at all, and which area codes saw money.
 *
 * Read once per line per month rather than per rep — the closing's brick grain is per line, and a
 * hundred and forty reps across three lines would otherwise make a hundred and forty identical
 * reads. Totals are read TRUE (see the header) and reduced immediately to the set of area codes
 * that saw anything, so no figure survives this function.
 */
async function salesByLine(lines: string[], month: string): Promise<Map<string, { areas: Set<string>; sold: boolean }>> {
  const out = new Map<string, { areas: Set<string>; sold: boolean }>();
  for (const code of lines) {
    try {
      const rows = await loadClosingBrickSales(lineName(code), month);
      const areas = new Set<string>();
      let sold = false;
      for (const row of rows) {
        if (!(row.value > 0)) continue;
        sold = true;
        const area = upperCode(row.areaCode);
        if (area) areas.add(area);
      }
      out.set(code, { areas, sold });
    } catch {
      // A line the closing could not answer for is a line this month says nothing about. Recording
      // it as "sold nothing" would flag every rep on it for a read that failed.
      out.set(code, { areas: new Set<string>(), sold: false });
    }
  }
  return out;
}

async function recomputeMonth(month: string, landed: ReadonlySet<string>): Promise<{ reps: number; notChecked: number; flagged: number }> {
  const bounds = monthBounds(month);
  if (!bounds) return { reps: 0, notChecked: 0, flagged: 0 };
  const supabase = getSupabaseAdmin();

  // 🔴 The raw table, not the countable view — see the header.
  const visitRead = await supabase
    .from("phoenix_crm_visits")
    .select("id, seat_id, line_code, customer_id, visit_date, captured_at, rep_hr_id, manager_hr_id, entered_by_hr_id, form_open_seconds, objection, is_test")
    .gte("visit_date", bounds.from)
    .lte("visit_date", bounds.to)
    .eq("is_test", false)
    .order("captured_at", { ascending: true })
    .limit(VISIT_READ_MAX);
  throwIfError(visitRead.error);
  const rows = (visitRead.data ?? []) as Row[];
  if (rows.length === 0) {
    const cleared = await supabase.from("phoenix_crm_behaviour_integrity").delete().eq("month", month).eq("is_test", false);
    throwIfError(cleared.error);
    return { reps: 0, notChecked: 0, flagged: 0 };
  }

  const perRep = new Map<string, { seatId: string | null; lineCode: string | null; visits: BehaviourVisit[]; customers: Set<string> }>();
  for (const row of rows) {
    const person = personOf(row);
    const visit = toVisit(row);
    if (!person || !visit) continue;
    const entry = perRep.get(person) ?? {
      seatId: row.seat_id ? String(row.seat_id) : null,
      lineCode: row.line_code ? String(row.line_code) : null,
      visits: [],
      customers: new Set<string>(),
    };
    entry.visits.push(visit);
    if (visit.customerId) entry.customers.add(visit.customerId);
    perRep.set(person, entry);
  }

  const seatIds = [...new Set([...perRep.values()].map((entry) => entry.seatId).filter((id): id is string => Boolean(id)))];
  const lines = [...new Set([...perRep.values()].map((entry) => entry.lineCode).filter((code): code is string => Boolean(code)))];

  const [readinessRead, placeRead, sales] = await Promise.all([
    seatIds.length === 0
      ? Promise.resolve({ data: [] as Row[], error: null })
      : supabase.from("phoenix_crm_territory_readiness").select("seat_id, reference_total, dropped").in("seat_id", seatIds),
    seatIds.length === 0
      ? Promise.resolve({ data: [] as Row[], error: null })
      : supabase.from("phoenix_crm_places").select("seat_id, area_code").in("seat_id", seatIds),
    // 🔴 Only a month whose distributor files have LANDED can say anything about sales at all.
    landed.has(month) ? salesByLine(lines, month) : Promise.resolve(new Map<string, { areas: Set<string>; sold: boolean }>()),
  ]);
  throwIfError((readinessRead as { error: unknown }).error);
  throwIfError((placeRead as { error: unknown }).error);

  const listSize = new Map<string, number>();
  for (const row of ((readinessRead as { data?: Row[] }).data ?? []) as Row[]) {
    const total = Number(row.reference_total ?? 0) - Number(row.dropped ?? 0);
    listSize.set(String(row.seat_id), Math.max(0, total));
  }
  const areasBySeat = new Map<string, Set<string>>();
  for (const row of ((placeRead as { data?: Row[] }).data ?? []) as Row[]) {
    const code = upperCode(row.area_code ? String(row.area_code) : null);
    if (!code) continue;
    const seat = String(row.seat_id);
    const set = areasBySeat.get(seat) ?? new Set<string>();
    set.add(code);
    areasBySeat.set(seat, set);
  }

  const verdicts = [...perRep.entries()].map(([repHrId, entry]) => {
    const customers = entry.seatId ? listSize.get(entry.seatId) ?? null : null;
    const lineSales = entry.lineCode ? sales.get(entry.lineCode) ?? null : null;
    const seatAreas = entry.seatId ? areasBySeat.get(entry.seatId) ?? new Set<string>() : new Set<string>();
    const input: BehaviourInput = {
      repHrId,
      month,
      seatId: entry.seatId,
      visits: entry.visits,
      coverage: customers === null ? null : { customers, visited: entry.customers.size },
      sales:
        lineSales === null
          ? null
          : {
              areaSawSales: [...seatAreas].some((area) => lineSales.areas.has(area)),
              lineSawSales: lineSales.sold,
            },
    };
    return judgeBehaviour(input);
  });

  // RECOMPUTED WHOLE: the month's rows go, then this run's replace them. A verdict that no longer
  // holds — a rep whose later visits broke a metronome — must disappear rather than linger.
  const cleared = await supabase.from("phoenix_crm_behaviour_integrity").delete().eq("month", month).eq("is_test", false);
  throwIfError(cleared.error);

  const written = await supabase.from("phoenix_crm_behaviour_integrity").insert(
    verdicts.map((verdict) => ({
      month: verdict.month,
      rep_hr_id: verdict.repHrId,
      seat_id: verdict.seatId,
      visits: verdict.visits,
      measured: verdict.measured,
      flags: verdict.flags,
      strong: verdict.strong,
      signals: verdict.signals,
      is_test: false,
    })),
  );
  throwIfError(written.error);

  return {
    reps: verdicts.length,
    notChecked: verdicts.filter((verdict) => !verdict.measured).length,
    flagged: verdicts.filter((verdict) => verdict.flags.length > 0).length,
  };
}

/**
 * The behaviour pass of the nightly sweep.
 *
 * This month always, and the month before in its first week — a month's last visits land on its last
 * evening, so a sweep that stopped at midnight would judge every month on a day that was not
 * finished.
 */
export async function runPhoenixCrmBehaviourSweep(options: { today?: string } = {}): Promise<BehaviourSweepResult> {
  const months = monthsToRecompute(options.today ?? cairoToday());
  const landed = await loadUploadedPeriodsInRange(SALES_HISTORY_FLOOR, months[months.length - 1] ?? SALES_HISTORY_FLOOR).catch(
    () => new Set<string>(),
  );
  const result: BehaviourSweepResult = { months, reps: 0, notChecked: 0, flagged: 0 };
  for (const month of months) {
    const one = await recomputeMonth(month, landed);
    result.reps += one.reps;
    result.notChecked += one.notChecked;
    result.flagged += one.flagged;
  }
  return result;
}
