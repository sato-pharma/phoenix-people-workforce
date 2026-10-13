// Has a month's STORED Office allocation drifted away from where the rule would put it today?
//
// 🔴 WHY THIS EXISTS, AND WHY NOTHING ELSE COULD SEE IT. The Office channel carries no geography of
// its own, so the owner's golden rule spreads it: each area takes its share of the line's NON-Office
// VALUE (units × master factory price), one blended share per line applied to every product. Those
// shares are computed when the Office file is COMMITTED and written into the rows. Nothing ever
// re-runs them. So "import Office last" is necessary but not sufficient — a distributor batch whose
// customers are re-resolved AFTER the Office commit moves the non-Office value base underneath a
// spread that has already been frozen into the rows, and no screen, log or check says so.
//
// MEASURED ON PRODUCTION, 2026-10-09, which is why this module was built. August 2026 CNS: the
// Office batch holds 109,719 units and was committed 10 Sep 20:15 Cairo — correctly last of the
// brick-carrying channels. Seven distributor batches (PS, IS, IS-S, EP-PHS, EG, SF, RM) were then
// re-touched on 13–14 Sep. Against today's base, **3,698 of those units (3.37%) belong in a
// different area**, and the movement is almost entirely between SIBLING areas of one governorate,
// which is the signature of a customer-map move: Sohag1 −1,099 / Sohag2 +1,050, Mahalla −781 /
// Tanta +752, Qena1 −513 / Qena2 +515, Assuit2 −411 / Assuit1 +413.
//
// 🔴 IT COMPARES WHERE THE UNITS SIT, AND THE LINE TOTAL IS IDENTICAL ON BOTH SIDES BY
// CONSTRUCTION — that is the whole design constraint, not a preference. Today's side is built by
// applying today's area shares to the line's OWN stored Office unit total, so both sides total the
// same units per line however badly they disagree about which area holds them. The publication
// drift check compares a line's total units (`monthly_closing_locks.snapshot_units`, one scalar) and
// is therefore structurally blind to every drift this module detects. `lineUnitTotalsAgree` in the
// report is true by construction and is reported precisely so the output says that out loud.
//
// 🔴 AND WHY TODAY'S SIDE IS NOT A RE-RUN OF THE ALLOCATOR. Re-running `computeOfficeAllocation`
// would drop any product whose net units for the period are ≤ 0 — `allocateProduct` opens with
// `if (!(units > 0)) return [];` inside the locked region — so the output total comes out HIGHER
// than the input (measured on 2026-02: +7 units from DO003 netting −7 across 173 rows). That is a
// real trap for a re-run, and it is not this module's subject: mixing it in would move the line
// total and make a geographic drift unreadable. The shares come from the repo's own
// `buildOfficeAreaWeightsByLine`, never a second implementation of the rule.
//
// 🔴 ITS SUBJECT IS THE STORED ROWS, WHICH IS WHY ITS AUGUST NUMBER IS NOT THE RESPREAD'S. The
// read-time respread (`closing-office-respread.ts`, from the September closing, CNS only) measures
// the same month through the closing LOADER, after the city-split rails, and reads 6,834 packs /
// 6.23% / 548,777 EGP. This module compares the Office BATCH's own rows with today's shares and
// reads 3,698 units / 3.37%. Both are true of August CNS — two measurements at two points, not a
// disagreement, and a session that "reconciles" them will break one of them. From the September
// closing the respread absorbs this drift at read time; for every earlier month the stored geography
// is what the published closing was built on, and this is the only thing that can say how far it has
// since moved.
//
// 🔴 SO FOR A MONTH THE RESPREAD COVERS, THIS MODULE'S NUMBER IS NOT A TASK. The closing already
// reads those units in the right area, and the board says so rather than asking him to re-commit the
// book (`officeAllocationDriftItems` in needs-you/office-allocation-drift-items.ts puts such a row
// in worth-knowing). What
// it still measures is the STORED rows, which is what a future re-upload, a re-map or any reader of
// the raw table meets — never nothing.
//
// 🔴 IT REPORTS, IT NEVER REPAIRS. Re-allocating a published month restates an announced number,
// and a published and announced month is never corrected however justified the fix — the owner's
// rule of 2026-09-07, made in answer to exactly such a fix. `monthly_closing_locks` is his
// decision. This module measures the difference and names the months, lines and areas; nothing
// here writes, and nothing may act on it without his word about that specific month. Its twin for
// the frozen wholesaler city split is `src/lib/sales/store-split-drift.ts`.

import { buildOfficeAreaWeightsByLine, loadOfficeBrickShare } from "@/lib/sales/office-allocation";
import { isOfficeDistributorCode } from "@/lib/sales/office-distributor";
import { loadSalesReferenceData } from "@/lib/sales/monthly-distributor-import";
import { normalizeCodeKey } from "@/lib/sales/normalizer/resolvers";
import { getSupabaseAdmin } from "@/lib/supabase/server";

/** One line×area cell of an Office allocation, from either side of the comparison. */
export type OfficeAllocationCell = {
  /** `source_of_sales_import_rows.official_line` — the product's official line, e.g. `CNS`. */
  lineCode: string;
  areaCode: string;
  units: number;
};

export type OfficeAllocationDriftArea = {
  lineCode: string;
  areaCode: string;
  /** What the rows hold today. */
  storedUnits: number;
  /** What today's value base would put here, on the same line total. */
  todaysUnits: number;
  /** `todaysUnits - storedUnits`. Positive means the area is under-credited in the stored rows. */
  unitsDelta: number;
};

export type OfficeAllocationDriftLine = {
  lineCode: string;
  /** The line's Office units — the same figure on both sides, by construction. */
  officeUnits: number;
  /** Σ |unitsDelta| / 2 — the units that would actually change area, counted once. */
  unitsThatWouldMove: number;
  /** `unitsThatWouldMove` as a percentage of `officeUnits`. The one number worth quoting. */
  percentOfOfficeUnits: number;
  /** Only the areas that disagree, biggest absolute movement first. */
  areas: OfficeAllocationDriftArea[];
};

/** A distributor batch re-touched after the Office commit — the cause, not the symptom. */
export type OfficeBaseTouchedAfterCommit = {
  distributorCode: string;
  /** The distributor's own name — what a reader is shown. Falls back to the code when it is blank. */
  distributorName: string;
  /** Cairo-local, formatted by the caller; this is the raw ISO instant. */
  updatedAt: string;
};

export type OfficeAllocationDriftReport = {
  period: string;
  /** Null when the period has no Office batch at all — nothing is frozen, so nothing can be stale. */
  officeCommittedAt: string | null;
  /** Batches whose customers moved after the commit. Empty is the healthy state. */
  baseTouchedAfterCommit: OfficeBaseTouchedAfterCommit[];
  lines: OfficeAllocationDriftLine[];
  /** Σ over lines of `unitsThatWouldMove`. */
  unitsThatWouldMove: number;
  /**
   * True when every line's Office unit total agrees across the two sides. TRUE BY CONSTRUCTION —
   * today's side is today's shares applied to the stored line total — and reported anyway, because
   * it is exactly why the units-based publication drift check cannot see any of this.
   */
  lineUnitTotalsAgree: boolean;
  /** Whether any line's units would move. The one boolean a caller should branch on. */
  drifted: boolean;
};

/** Below this a difference is float noise from the share arithmetic, not a movement. */
const UNITS_EPSILON = 0.5;

function cellKey(cell: { lineCode: string; areaCode: string }): string {
  return `${cell.lineCode}|${cell.areaCode}`;
}

function sumUnits(cells: readonly OfficeAllocationCell[]): Map<string, number> {
  const byLine = new Map<string, number>();
  for (const cell of cells) byLine.set(cell.lineCode, (byLine.get(cell.lineCode) ?? 0) + cell.units);
  return byLine;
}

/**
 * The pure comparison. `stored` is what the rows hold; `todays` is today's shares applied to each
 * line's own stored total. Both are line×area cells; either side may be missing an area the other
 * has, and a missing area is read as zero rather than skipped — an area that lost ALL of its Office
 * units is the largest movement there is, and skipping it would hide exactly that.
 */
export function diffOfficeAllocation(input: {
  period: string;
  stored: readonly OfficeAllocationCell[];
  todays: readonly OfficeAllocationCell[];
  officeCommittedAt?: string | null;
  baseTouchedAfterCommit?: readonly OfficeBaseTouchedAfterCommit[];
}): OfficeAllocationDriftReport {
  const storedByCell = new Map<string, number>();
  for (const cell of input.stored) {
    storedByCell.set(cellKey(cell), (storedByCell.get(cellKey(cell)) ?? 0) + cell.units);
  }
  const todaysByCell = new Map<string, number>();
  for (const cell of input.todays) {
    todaysByCell.set(cellKey(cell), (todaysByCell.get(cellKey(cell)) ?? 0) + cell.units);
  }

  const storedByLine = sumUnits(input.stored);
  const todaysByLine = sumUnits(input.todays);

  const areasByLine = new Map<string, OfficeAllocationDriftArea[]>();
  for (const key of new Set([...storedByCell.keys(), ...todaysByCell.keys()])) {
    const [lineCode, areaCode] = key.split("|");
    const storedUnits = storedByCell.get(key) ?? 0;
    const todaysUnits = todaysByCell.get(key) ?? 0;
    const unitsDelta = todaysUnits - storedUnits;
    if (Math.abs(unitsDelta) < UNITS_EPSILON) continue;
    const list = areasByLine.get(lineCode) ?? [];
    list.push({ areaCode, lineCode, storedUnits, todaysUnits, unitsDelta });
    areasByLine.set(lineCode, list);
  }

  const lines: OfficeAllocationDriftLine[] = [];
  for (const [lineCode, areas] of areasByLine) {
    areas.sort((a, b) => Math.abs(b.unitsDelta) - Math.abs(a.unitsDelta));
    const officeUnits = storedByLine.get(lineCode) ?? 0;
    // Halved because every unit that leaves an area arrives in another: Σ|delta| counts each move
    // twice, and the figure worth quoting is how many units change area, not how many deltas exist.
    const unitsThatWouldMove = areas.reduce((acc, a) => acc + Math.abs(a.unitsDelta), 0) / 2;
    lines.push({
      areas,
      lineCode,
      officeUnits,
      percentOfOfficeUnits: officeUnits > 0 ? (unitsThatWouldMove / officeUnits) * 100 : 0,
      unitsThatWouldMove,
    });
  }
  lines.sort((a, b) => b.unitsThatWouldMove - a.unitsThatWouldMove);

  const lineUnitTotalsAgree = [...new Set([...storedByLine.keys(), ...todaysByLine.keys()])].every(
    (line) => Math.abs((storedByLine.get(line) ?? 0) - (todaysByLine.get(line) ?? 0)) < UNITS_EPSILON,
  );

  const unitsThatWouldMove = lines.reduce((acc, line) => acc + line.unitsThatWouldMove, 0);
  return {
    baseTouchedAfterCommit: [...(input.baseTouchedAfterCommit ?? [])],
    drifted: unitsThatWouldMove >= UNITS_EPSILON,
    lineUnitTotalsAgree,
    lines,
    officeCommittedAt: input.officeCommittedAt ?? null,
    period: input.period,
    unitsThatWouldMove,
  };
}

/** One import batch of a period, as much of it as both sides of this comparison need. */
export type PeriodBatch = {
  id: string;
  distributorCode: string;
  /**
   * `distributor_name` — read alongside the code because the owner's standing rule is names, never
   * codes, and the Needs You board prints this straight onto his screen. Empty when the column is
   * null, and every consumer falls back to the code rather than printing nothing.
   */
  distributorName: string;
  /** `created_at` — when the batch was inserted, i.e. when its rows were computed. */
  createdAt: string | null;
  /** `updated_at` — the last write to the batch, which a customer re-map moves. */
  updatedAt: string | null;
};

/**
 * Every import batch of a period, read once and used for both sides.
 *
 * `status` is not filtered: every one of the 151 batches on production is `validated` (read
 * 2026-10-09), because this table holds committed uploads and a rejected preview never reaches it.
 */
export async function loadPeriodBatches(period: string): Promise<PeriodBatch[]> {
  const supabase = getSupabaseAdmin();
  const result = await supabase
    .from("source_of_sales_import_batches")
    .select("id, distributor_code, distributor_name, created_at, updated_at")
    .eq("period", period);
  if (result.error) throw new Error(`batch read failed: ${result.error.message}`);
  const rows = (result.data ?? []) as Array<{
    id?: string;
    distributor_code?: string;
    distributor_name?: string;
    created_at?: string;
    updated_at?: string;
  }>;
  return rows
    .filter((row) => row.id)
    .map((row) => ({
      createdAt: row.created_at ?? null,
      distributorCode: String(row.distributor_code ?? "").trim(),
      distributorName: String(row.distributor_name ?? "").trim(),
      id: String(row.id),
      updatedAt: row.updated_at ?? null,
    }));
}

/**
 * Every period that has an Office batch at all — the only periods where a spread can be stale.
 *
 * Read tolerantly for the same reason `pickOfficeBatch` is: an equality test on the code is one
 * stored-casing change away from answering "no period has an Office batch", which reads as a clean
 * machine rather than as a failed read.
 */
export async function loadPeriodsWithOfficeBatch(): Promise<string[]> {
  const supabase = getSupabaseAdmin();
  const result = await supabase
    .from("source_of_sales_import_batches")
    .select("period, distributor_code")
    .order("period", { ascending: false });
  if (result.error) throw new Error(`period read failed: ${result.error.message}`);
  const rows = (result.data ?? []) as Array<{ period?: string; distributor_code?: string }>;
  const periods: string[] = [];
  for (const row of rows) {
    const period = String(row.period ?? "").trim();
    if (!/^\d{4}-\d{2}$/.test(period)) continue;
    if (!isOfficeDistributorCode(row.distributor_code)) continue;
    if (!periods.includes(period)) periods.push(period);
  }
  return periods;
}

/**
 * The Office batch of a period, or null when the channel was never committed for it.
 *
 * 🔴 ITS COMMIT INSTANT IS `created_at`, NEVER `updated_at`. A backfill UPDATE on 2026-09-04
 * 18:33:55 UTC touched a whole generation of batches at once, so Jan–Jul 2026's Office batches all
 * carry THAT as `updated_at` — up to 23 days after they were really written. Reading it as the
 * commit instant would move the commit forward past the very base moves this looks for and report
 * those months clean. August is the one where the two agree (created 17:15:54, updated 17:16:16 —
 * the 22 seconds its own rows took to write).
 *
 * Matched with `isOfficeDistributorCode`, not an equality test: production stores exactly `Office`
 * today, and the repo's own question about a row is case- and space-tolerant for a reason.
 */
export function pickOfficeBatch(batches: readonly PeriodBatch[]): PeriodBatch | null {
  const office = batches
    .filter((batch) => isOfficeDistributorCode(batch.distributorCode))
    .sort((a, b) => String(b.createdAt ?? "").localeCompare(String(a.createdAt ?? "")));
  return office[0] ?? null;
}

/**
 * What the rows hold: the committed Office allocation, summed per official line and area.
 *
 * Paged past PostgREST's 1,000-row cap — August's Office batch alone is 3,840 rows, so an unpaged
 * read would silently return a quarter of it and report a clean month.
 */
export async function loadStoredOfficeAllocation(batchId: string): Promise<OfficeAllocationCell[]> {
  const supabase = getSupabaseAdmin();
  const byCell = new Map<string, OfficeAllocationCell>();
  const pageSize = 1000;
  for (let from = 0; ; from += pageSize) {
    const result = await supabase
      .from("source_of_sales_import_rows")
      .select("official_line, area_code, qty")
      .eq("batch_id", batchId)
      .order("id", { ascending: true })
      .range(from, from + pageSize - 1);
    if (result.error) throw new Error(`office rows read failed: ${result.error.message}`);
    const page = (result.data ?? []) as Array<{ official_line?: string; area_code?: string; qty?: number | string }>;
    for (const row of page) {
      const lineCode = String(row.official_line ?? "").trim();
      const areaCode = String(row.area_code ?? "").trim();
      if (!lineCode || !areaCode) continue;
      const key = `${lineCode}|${areaCode}`;
      const existing = byCell.get(key);
      const units = Number(row.qty ?? 0);
      if (existing) existing.units += units;
      else byCell.set(key, { areaCode, lineCode, units });
    }
    if (page.length < pageSize) break;
  }
  return [...byCell.values()];
}

/**
 * Where today's base would put the same units: the rule's area shares as of now, applied to each
 * line's OWN stored Office total.
 *
 * The shares come from `buildOfficeAreaWeightsByLine` with `references.products[].factoryPrice` as
 * `priceOf` and that product's official `line` as `lineOf` — the identical two callbacks
 * `computeOfficeAllocation` passes, so this is the rule's own output and not a restatement of it.
 */
export async function loadTodaysOfficeAllocation(
  period: string,
  stored: readonly OfficeAllocationCell[],
): Promise<OfficeAllocationCell[]> {
  const [brickShare, references] = await Promise.all([
    loadOfficeBrickShare(period),
    // Skips the customer→brick crosswalk, which nothing here reads: 69,217 active rows on
    // 2026-09-15, paged 1,000 at a time — 70 round-trips and ~3.5 s for a list this module ignores.
    loadSalesReferenceData({ includeCustomerBricks: false }),
  ]);
  // 🔴 KEYED THROUGH `normalizeCodeKey`, EXACTLY AS THE ALLOCATOR KEYS IT (office-allocation.ts:321).
  // Both callbacks fall back to a falsy default on a miss — price 0, line "" — so a raw-string key
  // that failed to match would not throw: it would build zero-value weights and every line would
  // report "the rule cannot speak", i.e. no drift. The failure is silent and reads as a CLEAN month,
  // which is the one wrong answer this module must never give.
  const productByCode = new Map(references.products.map((p) => [normalizeCodeKey(p.productCode), p]));
  const weightsByLine = buildOfficeAreaWeightsByLine(
    brickShare,
    (productCode) => productByCode.get(normalizeCodeKey(productCode))?.factoryPrice ?? 0,
    (productCode) => productByCode.get(normalizeCodeKey(productCode))?.line ?? "",
  );

  const cells: OfficeAllocationCell[] = [];
  for (const [lineCode, lineTotal] of sumUnits(stored)) {
    const weights = weightsByLine.get(lineCode);
    // A line with no non-Office brick rows today has no base to spread on. Emitting nothing would
    // read as "every unit moved away"; the honest answer is that the rule cannot speak, so the
    // stored cells are carried over unchanged and the line reports no drift.
    if (!weights || weights.areaShare.size === 0 || !(weights.totalValue > 0)) {
      for (const cell of stored) if (cell.lineCode === lineCode) cells.push({ ...cell });
      continue;
    }
    for (const [areaCode, share] of weights.areaShare) {
      cells.push({ areaCode, lineCode, units: share * lineTotal });
    }
  }
  return cells;
}

/**
 * The batches whose rows were last touched AFTER the Office commit — the CAUSE, named beside the
 * magnitude, and a pure filter over a list already read.
 *
 * Direct channels are excluded: they carry no brick, so `phx_office_brick_share` never sees them and
 * they cannot move the base however often they are re-uploaded. The Office batch itself is excluded
 * for the same reason — it is the thing being measured, not part of its own base.
 *
 * 🔴 THIS LIST IS ADVISORY AND THE MAGNITUDE IS NOT. The 2026-09-04 18:33:55 UTC backfill UPDATE
 * stamped that instant on a whole generation of batches, so for a month whose Office commit predates
 * it the list can name batches whose CUSTOMERS never moved. The units figure is computed from the
 * two allocations and owes the timestamps nothing — read the list as "look here first", never as an
 * audit of what changed.
 */
export function baseTouchedAfterCommit(
  batches: readonly PeriodBatch[],
  officeCommittedAt: string | null,
): OfficeBaseTouchedAfterCommit[] {
  if (!officeCommittedAt) return [];
  return batches
    .filter((batch) => {
      if (isOfficeDistributorCode(batch.distributorCode)) return false;
      if (!batch.distributorCode || /^direct/i.test(batch.distributorCode)) return false;
      return String(batch.updatedAt ?? "") > officeCommittedAt;
    })
    .map((batch) => ({
      distributorCode: batch.distributorCode,
      distributorName: batch.distributorName.length > 0 ? batch.distributorName : batch.distributorCode,
      updatedAt: String(batch.updatedAt ?? ""),
    }))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/** The whole reading for one period. Reads only. */
export async function loadOfficeAllocationDrift(period: string): Promise<OfficeAllocationDriftReport> {
  const batches = await loadPeriodBatches(period);
  const office = pickOfficeBatch(batches);
  if (!office) {
    return {
      baseTouchedAfterCommit: [],
      drifted: false,
      lineUnitTotalsAgree: true,
      lines: [],
      officeCommittedAt: null,
      period,
      unitsThatWouldMove: 0,
    };
  }
  const stored = await loadStoredOfficeAllocation(office.id);
  const todays = await loadTodaysOfficeAllocation(period, stored);
  return diffOfficeAllocation({
    baseTouchedAfterCommit: baseTouchedAfterCommit(batches, office.createdAt),
    officeCommittedAt: office.createdAt,
    period,
    stored,
    todays,
  });
}
