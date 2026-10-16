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

import type { SupabaseClient } from "@supabase/supabase-js";

import {
  judgeBehaviour,
  monthBounds,
  monthsToRecompute,
  type BehaviourInput,
  type BehaviourVisit,
} from "@/lib/phoenix-crm/behaviour-integrity";
// The settled-case test, pure, and the same one the board, the fraud scan and Phoenix Ranks apply.
import { isSettledIntegrityRow } from "@/lib/phoenix-crm/integrity-settlement";
import { throwIfError } from "@/lib/phoenix-crm/server/db";
import { readEveryPage } from "@/lib/phoenix-crm/server/paged-read";
import { loadClosingBrickSales, upperCode } from "@/lib/sales/closing-brick-sales";
import { lineName } from "@/lib/sales/monthly-targets";
import { mapWithConcurrency } from "@/lib/reconciliation/concurrency";
import { SALES_HISTORY_FLOOR, loadUploadedPeriodsInRange } from "@/lib/sales/vs-target";
import { getSupabaseAdmin } from "@/lib/supabase/server";

type Row = Record<string, unknown>;

/**
 * Far above a real month for the whole company; low enough that one night cannot pull the table.
 *
 * 🔴 A CEILING, NOT A PAGE SIZE. PostgREST stops every response at 1,000 rows whatever `.limit()`
 * asks for, so this is reachable only through the pager in `readMonthVisits` — and past it the month
 * is REFUSED rather than judged on part of itself.
 */
export const VISIT_READ_MAX = 50_000;

/** One row per seat (readiness) or per validated place. Far above the company's real numbers. */
export const SEAT_ROW_READ_MAX = 100_000;

/** Strong position and photo cases in one month. A company-wide month cannot approach this. */
export const STRONG_CASE_READ_MAX = 20_000;

/** How many lines' closing sales are read at once. The company has three. */
const LINES_AT_ONCE = 4;

const JUDGED_VISIT_COLUMNS =
  "id, seat_id, line_code, customer_id, visit_date, captured_at, rep_hr_id, manager_hr_id, entered_by_hr_id, form_open_seconds, objection, is_test";

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
  // The lines are asked side by side rather than one after another (Phoenix CRM performance audit,
  // 2026-10-16). Each keeps its own failure: one line the closing cannot answer for is still that
  // line alone, and the answers are filed in the lines' own order.
  const answers = await mapWithConcurrency(lines, LINES_AT_ONCE, async (code) => {
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
      return { areas, sold };
    } catch {
      // A line the closing could not answer for is a line this month says nothing about. Recording
      // it as "sold nothing" would flag every rep on it for a read that failed.
      return { areas: new Set<string>(), sold: false };
    }
  });
  const out = new Map<string, { areas: Set<string>; sold: boolean }>();
  for (const [position, code] of lines.entries()) out.set(code, answers[position]!);
  return out;
}

/**
 * Every visit of a month the behaviour rules judge, in capture order.
 *
 * 🔴 PAGED. Until 2026-10-02 this read ended in `.limit(VISIT_READ_MAX)`, and PostgREST stops every
 * response at 1,000 rows with no error — so, read in capture order, the sweep judged the FIRST ~1,000
 * visits of the month company-wide and never saw the rest. A rep whose month started after them was
 * judged on nothing, and a rep half inside them on half a month. Past the ceiling the month is
 * refused, never judged on part of itself (`src/lib/phoenix-crm/server/paged-read.ts`).
 *
 * 🔴 The raw table, not the countable view — see the header. And never a visit the Super Admin
 * entered for a rep who missed logging it (owner, 2026-10-01): its time is the one HE typed, or noon,
 * and it has no form and no reading, so it says nothing about how the rep works — three of them
 * entered at noon would read as three visits in the same minute.
 *
 * Takes its client so the paging test can hand it a fake that stops at 1,000 rows, as the server does.
 */
export async function readMonthVisits(client: Pick<SupabaseClient, "from">, bounds: { from: string; to: string }): Promise<Row[]> {
  const read = await readEveryPage<Row>(
    () =>
      client
        .from("phoenix_crm_visits")
        .select(JUDGED_VISIT_COLUMNS)
        .gte("visit_date", bounds.from)
        .lte("visit_date", bounds.to)
        .eq("is_test", false)
        .neq("capture_source", "admin")
        // Nor the pharmacy visit a doctor's visit filed beside itself (owner, 2026-10-03): it carries the
        // doctor visit's own time and reading, so it would read as a second visit in the same second.
        .is("linked_from_visit_id", null)
        // A TOTAL order, or paging drops and repeats rows: two visits can share a capture instant.
        .order("captured_at", { ascending: true })
        .order("id", { ascending: true }),
    { maxRows: VISIT_READ_MAX, whenFull: "refuse", what: "A month of Phoenix CRM visits", uniqueBy: (row) => String(row.id ?? "") },
  );
  throwIfError(read.error);
  return read.rows;
}

/**
 * Rows for a set of seats, paged.
 *
 * 🔴 NEITHER OF THESE READS HAD A `.limit()` AT ALL, which is not safer than a high one — PostgREST
 * still stops at 1,000 rows and still says nothing. The places read is the one that can accuse
 * somebody: past 1,000 real places a seat comes back with no areas, `areaSawSales` is then false for
 * a rep whose area did sell, and `flat_coverage_no_sales` fires on a rep who covered his list and
 * sold behind it. Production holds 12 places today and every validated customer adds one, so this is
 * a defect with a date on it rather than a hypothetical. Refused past the ceiling, never halved.
 */
async function readSeatRows(
  client: Pick<SupabaseClient, "from">,
  table: "phoenix_crm_territory_readiness" | "phoenix_crm_places",
  columns: string,
  seatIds: readonly string[],
  realOnly: boolean,
): Promise<Row[]> {
  const read = await readEveryPage<Row>(
    () => {
      const query = client.from(table).select(columns).in("seat_id", [...seatIds]);
      // A TOTAL order. `seat_id` alone repeats across rows of one seat, which is exactly where an
      // offset walk loses them; readiness holds one row per seat, and a place carries its own id.
      return realOnly ? query.eq("is_test", false).order("id", { ascending: true }) : query.order("seat_id", { ascending: true });
    },
    { maxRows: SEAT_ROW_READ_MAX, whenFull: "refuse", what: `Phoenix CRM ${table}` },
  );
  throwIfError(read.error);
  return read.rows;
}

/**
 * The reps holding a STRONG position or photo case in this month — the company a save-time pattern
 * needs before the board may print it (owner, 2026-10-02).
 *
 * Read by `visit_date`, which is the column both detectors file, so a case follows the visit's own
 * Cairo day rather than the night the sweep ran. The photo pass runs BEFORE this one in the same
 * sweep (`runPhoenixCrmIntegritySweep`), so tonight's duplicate photographs are already here.
 *
 * A failed read answers with an EMPTY set, deliberately: that holds the weak flags back instead of
 * printing them alone, and a missed catch is the right side of this rule to fail on.
 *
 * 🔴 A CASE THE SUPER ADMIN HAS SETTLED IS NOT COMPANY (owner, 2026-10-09: "make settling drop the
 * behaviour board's strong-case gate too" — the third and last reader of this table to honour a
 * settlement, after the weekly fraud scan and Phoenix Ranks). The gate exists so a save-time pattern
 * is never printed about a rep on its own; a settled case is one the Super Admin has already looked
 * at and closed, so letting it unlock a pattern would be the board using a closed case as grounds to
 * raise a new suspicion about the same person.
 *
 * 🔴 AND IT COMES BACK BY ITSELF, because the test is `settled_flags = flags` and nothing else: the
 * detectors upsert on (subject_kind, subject_id, source), so a fresh finding replaces `flags` in
 * place, the stored settlement stops describing the row, and the rep is company again on the next
 * nightly pass. Dropping settled rows can only SHRINK the set, which is the same direction a failed
 * read fails in — patterns held back, never printed on evidence that is not there.
 *
 * The four `settled_*` columns are selected because the test is a column against a column, which
 * PostgREST cannot ask for; `settled_at is null` would wrongly keep dropping a case the detectors
 * have since flagged again.
 */
async function readStrongCaseReps(client: Pick<SupabaseClient, "from">, bounds: { from: string; to: string }): Promise<Set<string>> {
  const read = await readEveryPage<Row>(
    () =>
      client
        .from("phoenix_crm_location_integrity")
        .select("id, rep_hr_id, flags, settled_at, settled_by, settled_note, settled_flags")
        .eq("is_test", false)
        .eq("strong", true)
        .in("source", ["gps", "photo"])
        .gte("visit_date", bounds.from)
        .lte("visit_date", bounds.to)
        .order("id", { ascending: true }),
    { maxRows: STRONG_CASE_READ_MAX, whenFull: "stop", what: "Phoenix CRM strong integrity cases" },
  );
  if (read.error) {
    console.error("[phoenix-crm] strong cases not read; save-time patterns stay held back", { month: bounds.from.slice(0, 7) });
    return new Set<string>();
  }
  return new Set(
    read.rows
      .filter((row) => !isSettledIntegrityRow(row))
      .map((row) => String(row.rep_hr_id ?? "").toUpperCase())
      .filter(Boolean),
  );
}

async function recomputeMonth(month: string, landed: ReadonlySet<string>): Promise<{ reps: number; notChecked: number; flagged: number }> {
  const bounds = monthBounds(month);
  if (!bounds) return { reps: 0, notChecked: 0, flagged: 0 };
  const supabase = getSupabaseAdmin();

  const rows = await readMonthVisits(supabase, bounds);
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

  const [readiness, places, strongCases, sales] = await Promise.all([
    seatIds.length === 0 ? Promise.resolve([] as Row[]) : readSeatRows(supabase, "phoenix_crm_territory_readiness", "seat_id, reference_total, dropped", seatIds, false),
    // Real places only. Test places sit on real seats too (the Super Admin's try-outs, and every
    // test account's), and without this their area codes fed the real rep's sales-area verdict.
    seatIds.length === 0 ? Promise.resolve([] as Row[]) : readSeatRows(supabase, "phoenix_crm_places", "id, seat_id, area_code", seatIds, true),
    readStrongCaseReps(supabase, bounds),
    // 🔴 Only a month whose distributor files have LANDED can say anything about sales at all.
    landed.has(month) ? salesByLine(lines, month) : Promise.resolve(new Map<string, { areas: Set<string>; sold: boolean }>()),
  ]);

  const listSize = new Map<string, number>();
  for (const row of readiness) {
    const total = Number(row.reference_total ?? 0) - Number(row.dropped ?? 0);
    listSize.set(String(row.seat_id), Math.max(0, total));
  }
  const areasBySeat = new Map<string, Set<string>>();
  for (const row of places) {
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
      // 🔴 The owner's 2026-10-02 ruling needs a company this month: a save-time pattern is shown
      // only beside a strong flag, and a strong position or photo case counts as one.
      strongCaseThisMonth: strongCases.has(repHrId),
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
