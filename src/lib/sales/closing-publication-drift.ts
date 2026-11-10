// Has a PUBLISHED month moved — and if it has, WHERE did the money go?
//
// 🔴 WHY THIS EXISTS. `phx_closing_drift_status` is the publication drift check, and it answers
// the question in three numbers: `drifted_cells`, `net_units_delta`, `net_value_delta`. The two
// that read like a verdict are SUMS over the drifted cells, so a redistribution between areas
// cancels to zero in both of them. Measured on production 2026-10-09, Anti Infective 2026-09 — a
// published month:
//
//     drifted_cells 27   net_units_delta 0.000000   net_value_delta 0.000000   verdict unreviewed
//
// Underneath those two zeroes, Menoufia 2 had LOST 1,111.50 EGP and Giza Centers had GAINED 858.45
// against what was published. The check was not wrong, it was unreadable: a person skimming it sees
// a zero where the answer is "money changed area". `areaMoves` below is that missing half.
//
// 🔴 AND IT IS BLIND TO A WHOLE LAYER, WHICH IS THE WORSE HALF. `phx_closing_publication_snapshot`
// is built from `source_of_sales_fact_rollup`, which carries the AS-INVOICED geography. The
// wholesaler city split lives downstream of it, in `au.monthly_store_split_net`, and never enters
// the fact rollup at all — so no snapshot of the rollup can see the split's area placement, however
// finely it is keyed. Measured the same day: 2026-09's frozen net puts 839,283.83 EGP on a
// different area than today's rule does (40 Pedia rows, 16 CNS, 0 Anti Infective) and the
// publication check reports every one of those cells clean, because nothing it reads has changed.
//
// So "has this published month moved?" needs BOTH layers, and until this module there was no one
// place that asked. `phx_closing_drift_status` had no caller in the app at all, and
// `scripts/check-store-split-drift.ts` saw only the split. This joins them, per published line, and
// names the layer each difference came from — `splitOnlyLines` is the class the publication check
// reported as clean.
//
// 🔴 WHY THE SPLIT HALF CANNOT MOVE INTO SQL. Recomputing the split needs the closing's own
// loaders — brick/master geography, the even-split registry, merged areas kept apart. A hand-built
// row set over the fact rollup reported 43 drifted pairs against a real 6 (see
// `store-split-drift.ts`). The recompute therefore stays in TypeScript and this module reads it,
// rather than a second implementation in a migration.
//
// 🔴 IT REPORTS, IT NEVER REPAIRS. Rebuilding a published month's net or re-issuing a closing
// restates an announced number, which is the owner's decision alone (AGENTS.md §4, "a published and
// announced month is never corrected"). Nothing here writes, and nothing here acknowledges a drift
// — `phx_acknowledge_closing_drift` is deliberately not called from this module.

import { logError } from "@/lib/observability/log";
import { ATTRIBUTION_SPLIT_LINES } from "@/lib/sales/attribution-store-split-net";
import { resolveTargetLineCode } from "@/lib/sales/monthly-targets";
import { loadStoreSplitDrift, type StoreSplitDriftReport } from "@/lib/sales/store-split-drift";
import { getSupabaseAdmin } from "@/lib/supabase/server";

/** Below this a difference is float noise, not a movement. Matches `store-split-drift.ts`. */
const VALUE_EPSILON = 0.005;

/**
 * `phx_closing_drift_status` as the RPC returns it — the fact-rollup half, per published line.
 * `valueDelta` is null for a snapshot taken before the snapshot carried value at all (the 2026-09-05
 * migration reports those honestly rather than as a 100% value drift).
 */
export type PublicationCellDrift = {
  cells: number;
  unitsDelta: number;
  valueDelta: number | null;
  acknowledged: boolean;
  acknowledgedBy: string | null;
  verdict: string;
};

/**
 * One area's fact-rollup movement as {@link loadPublicationDriftOverview} returns it — the same
 * fields as {@link PublicationAreaMove} minus `layer`, which the merge adds.
 *
 * It is NAMED rather than written inline at each use because a caller that catches a failed read
 * returns `[line, []]` from the catch and `[line, <rows>]` from the try: with the shape inline those
 * are two different tuple types, and `new Map()` cannot infer a key and value across that union.
 */
export type FactAreaMove = {
  areaCode: string;
  cells: number;
  unitsDelta: number;
  valueDelta: number;
};

/** Both fact-rollup halves for one line, as the single `phx_closing_drift_overview` read hands them back. */
export type PublicationDriftOverview = {
  cellDrift: PublicationCellDrift | null;
  areaMoves: FactAreaMove[];
};

/** One area that holds more, or less, than what was published. */
export type PublicationAreaMove = {
  areaCode: string;
  cells: number;
  unitsDelta: number;
  /** live − published. Positive means the area now holds MORE than the published figure gave it. */
  valueDelta: number;
  /** Which layer this movement came from. */
  layer: "fact-rollup" | "store-split";
};

export type PublicationLineDrift = {
  /** The display line, as the publication row spells it — "Anti Infective", never a code. */
  line: string;
  /** `au` line code (`anti_infective`, `cns`, `pedia`), or null when the line does not map. */
  lineCode: string | null;
  period: string;
  /** The fact-rollup half. Null when the status could not be read for this line. */
  cellDrift: PublicationCellDrift | null;
  /** Every area that gained or lost, biggest absolute movement first, both layers merged. */
  areaMoves: PublicationAreaMove[];
  areasMoved: number;
  /**
   * The money that ends up on a DIFFERENT area than what was published — Σ of the positive area
   * deltas, which is the figure that moves someone's achievement. Not Σ|delta|, which double-counts
   * every movement by including the giver as well as the receiver.
   */
  areaValueMoved: number;
  /**
   * True when this line drifted ONLY in the store-split layer — i.e. the publication check reported
   * it clean. The class this module exists to surface.
   */
  splitOnly: boolean;
  drifted: boolean;
};

export type PublicationDriftReport = {
  period: string;
  /** One row per line published in this period, biggest area movement first. */
  lines: PublicationLineDrift[];
  areaValueMoved: number;
  /** Lines the publication check calls clean while the split layer has moved money. */
  splitOnlyLines: string[];
  /**
   * 🔴 Lines that are NOT published for this period whose stored net no longer matches the rule.
   *
   * Until 20261110103127 the freeze was per PERIOD — publishing ONE line froze
   * `au.monthly_store_split_net` for every line in that month — and this field is how that showed.
   * The freeze is per line now, so an unpublished line's net is rebuilt by the next upload or by
   * the publish gate; what is left here is a net nothing has rebuilt yet. Nothing has been announced for these
   * lines, so none of this is a restatement yet; the exposure is the opposite direction — they will
   * be published ONTO the stale net unless it is rebuilt first. Measured 2026-10-09 on 2026-09:
   * Anti Infective alone was published, and Pedia carried 839,283.83 EGP sitting on a different
   * area than today's rule gives it, with nothing anywhere saying so.
   */
  frozenNotPublished: PublicationLineDrift[];
  frozenNotPublishedValueMoved: number;
  /**
   * True when every drifted line's net unit and value deltas are zero — the shape that makes the
   * publication check's own summary read as "nothing happened". Reported so the output can say it
   * out loud rather than leaving a reader to assume the existing numbers had it covered.
   */
  netDeltasReadAsClean: boolean;
  /**
   * 🔴 WAS THE STORE-SPLIT LAYER ACTUALLY READ? An empty `split.byArea` is indistinguishable from a
   * period whose split has not moved, so without this flag a cheap partial read and a proven clean
   * month have the SAME shape — and a reader would take the partial for the whole. Measured on
   * production 2026-10-09 for 2026-09: `loadStoreSplitDrift` alone is 17,282 ms against 328 ms for
   * the published lines, 743 ms for the cell drift and 424 ms for the fact area moves. So a caller
   * on a latency budget (the Needs You board gives each source 8 s) reads the cheap layers only and
   * sets this FALSE, and `splitOnlyLines` and `frozenNotPublished` are then UNKNOWN, never zero.
   */
  splitLayerRead: boolean;
  /**
   * 🔴 Published lines whose own read FAILED — named, never dropped. `phx_closing_drift_status`
   * times out on some line × period pairs (CNS 2026-07 and 2026-08, measured 2026-10-09), and an
   * unreadable line used to come back as `cellDrift: null`, which is also what a line with no
   * publication row looks like. Anything in this list means the report is incomplete about that
   * line, whatever the rest of it says.
   */
  linesNotRead: string[];
  drifted: boolean;
};

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Merge the two layers into one report. PURE — no database, so the whole merge is unit-tested
 * without one, including the cancellation that makes a net delta read as clean.
 *
 * `publishedLines` decides the rows: a line with no publication row for the period is not reported,
 * because an unpublished line has nothing announced to drift away from.
 */
export function mergePublicationDrift(input: {
  period: string;
  publishedLines: readonly string[];
  statuses: ReadonlyMap<string, PublicationCellDrift>;
  /** Per-cell fact-rollup movement, already aggregated per line and area by the caller. */
  factAreaMoves?: ReadonlyMap<string, readonly FactAreaMove[]>;
  split: Pick<StoreSplitDriftReport, "byArea">;
  /**
   * REQUIRED, with no default, because the safe value is the one a forgetful caller would not pick.
   * Pass `false` when `split` is a placeholder rather than a real read — see
   * {@link PublicationDriftReport.splitLayerRead}.
   */
  splitLayerRead: boolean;
  /** Published lines whose read failed — see {@link PublicationDriftReport.linesNotRead}. */
  linesNotRead: readonly string[];
}): PublicationDriftReport {
  if (!input.splitLayerRead && input.split.byArea.length > 0) {
    // Rows plus "I did not read the layer" is a caller that passed a real read and mislabelled
    // it, or a placeholder that is not empty. Either way the report would understate its coverage.
    throw new Error("publication drift: splitLayerRead is false but split.byArea carries rows");
  }

  const splitByLineCode = new Map<string, PublicationAreaMove[]>();
  for (const area of input.split.byArea) {
    const found = splitByLineCode.get(area.lineCode) ?? [];
    found.push({
      areaCode: area.areaCode,
      cells: area.cells,
      layer: "store-split",
      unitsDelta: area.qtyDelta,
      valueDelta: area.valueDelta,
    });
    splitByLineCode.set(area.lineCode, found);
  }

  const lines: PublicationLineDrift[] = [];
  for (const line of input.publishedLines) {
    const lineCode = resolveTargetLineCode(line) ?? null;
    const cellDrift = input.statuses.get(line) ?? null;
    const factMoves: PublicationAreaMove[] = (input.factAreaMoves?.get(line) ?? []).map((move) => ({
      areaCode: move.areaCode,
      cells: move.cells,
      layer: "fact-rollup" as const,
      unitsDelta: move.unitsDelta,
      valueDelta: move.valueDelta,
    }));
    const splitMoves = lineCode ? (splitByLineCode.get(lineCode) ?? []) : [];
    const areaMoves = [...factMoves, ...splitMoves]
      .filter((move) => Math.abs(move.valueDelta) >= VALUE_EPSILON || move.unitsDelta !== 0)
      .sort((a, b) => Math.abs(b.valueDelta) - Math.abs(a.valueDelta) || a.areaCode.localeCompare(b.areaCode));

    const areaValueMoved = round2(
      areaMoves.reduce((sum, move) => sum + Math.max(0, move.valueDelta), 0),
    );
    const cellsDrifted = cellDrift ? cellDrift.cells > 0 : false;
    const splitOnly = splitMoves.length > 0 && !cellsDrifted;
    lines.push({
      areaMoves,
      areaValueMoved,
      areasMoved: new Set(areaMoves.map((move) => move.areaCode)).size,
      cellDrift,
      drifted: cellsDrifted || areaMoves.length > 0,
      line,
      lineCode,
      period: input.period,
      splitOnly,
    });
  }
  lines.sort((a, b) => b.areaValueMoved - a.areaValueMoved || a.line.localeCompare(b.line));

  // The other direction: a line with no publication row of its own whose stored split has gone stale
  // (before 20261110103127 because somebody else's publication froze it; now only until the next
  // upload or the publish gate rebuilds it). Nothing is
  // announced, so this is never mixed into `lines` — it is reported apart, as the exposure it is.
  // Split lines are named from ATTRIBUTION_SPLIT_LINES through the same resolver the rest of the
  // module uses, so there is no second code -> label table to drift out of step.
  const publishedCodes = new Set(
    input.publishedLines.map((line) => resolveTargetLineCode(line)).filter((code): code is string => code !== null),
  );
  const frozenNotPublished: PublicationLineDrift[] = [];
  for (const line of ATTRIBUTION_SPLIT_LINES) {
    const lineCode = resolveTargetLineCode(line);
    if (!lineCode || publishedCodes.has(lineCode)) continue;
    const areaMoves = (splitByLineCode.get(lineCode) ?? [])
      .filter((move) => Math.abs(move.valueDelta) >= VALUE_EPSILON || move.unitsDelta !== 0)
      .sort((a, b) => Math.abs(b.valueDelta) - Math.abs(a.valueDelta) || a.areaCode.localeCompare(b.areaCode));
    if (areaMoves.length === 0) continue;
    frozenNotPublished.push({
      areaMoves,
      areaValueMoved: round2(areaMoves.reduce((sum, move) => sum + Math.max(0, move.valueDelta), 0)),
      areasMoved: new Set(areaMoves.map((move) => move.areaCode)).size,
      cellDrift: null,
      drifted: true,
      line,
      lineCode,
      period: input.period,
      splitOnly: true,
    });
  }
  frozenNotPublished.sort((a, b) => b.areaValueMoved - a.areaValueMoved || a.line.localeCompare(b.line));

  const drifted = lines.filter((line) => line.drifted);
  // The tell that the existing summary is unreadable: something drifted, and every net delta the
  // publication check prints is zero.
  const netDeltasReadAsClean = drifted.length > 0
    && drifted.every((line) =>
      Math.abs(line.cellDrift?.unitsDelta ?? 0) < 1e-6
      && Math.abs(line.cellDrift?.valueDelta ?? 0) < VALUE_EPSILON);

  return {
    areaValueMoved: round2(lines.reduce((sum, line) => sum + line.areaValueMoved, 0)),
    // A stale frozen net on an unpublished line is drift the report must not call clean: it is the
    // reason a month gets published onto the wrong geography.
    drifted: drifted.length > 0 || frozenNotPublished.length > 0,
    frozenNotPublished,
    frozenNotPublishedValueMoved: round2(
      frozenNotPublished.reduce((sum, line) => sum + line.areaValueMoved, 0),
    ),
    lines,
    netDeltasReadAsClean,
    period: input.period,
    linesNotRead: [...input.linesNotRead].sort(),
    splitLayerRead: input.splitLayerRead,
    splitOnlyLines: lines.filter((line) => line.splitOnly).map((line) => line.line),
  };
}

/** Every line with a live publication row for the period, as the publication spells it. */
export async function loadPublishedLines(period: string): Promise<string[]> {
  const { data, error } = await getSupabaseAdmin()
    .from("monthly_closing_publications")
    .select("line")
    .eq("period", period)
    .is("unpublished_at", null);
  if (error) throw new Error(`publication drift: cannot read the publications for ${period} — ${error.message}`);
  const lines = new Set<string>();
  for (const row of (data ?? []) as { line?: unknown }[]) {
    const line = String(row?.line ?? "").trim();
    if (line !== "") lines.add(line);
  }
  return [...lines].sort();
}

type DriftStatusRow = {
  drifted_cells?: unknown;
  net_units_delta?: unknown;
  net_value_delta?: unknown;
  acknowledged?: unknown;
  acknowledged_by?: unknown;
  verdict?: unknown;
};

/** The status row's shape, as `phx_closing_drift_overview` nests it under `status`. */
function toCellDrift(row: DriftStatusRow): PublicationCellDrift {
  const rawValue = row.net_value_delta;
  return {
    acknowledged: row.acknowledged === true,
    acknowledgedBy: row.acknowledged_by ? String(row.acknowledged_by) : null,
    cells: Number(row.drifted_cells ?? 0),
    unitsDelta: Number(row.net_units_delta ?? 0),
    valueDelta: rawValue === null || rawValue === undefined ? null : Number(rawValue),
    verdict: String(row.verdict ?? ""),
  };
}

/**
 * Per-area movement from the per-cell drift rows. The rollup stays in TypeScript — it is where it
 * has always lived, and putting it in the migration would make the database a second implementation
 * of it.
 */
function rollUpAreaMoves(
  cells: readonly { area_code?: unknown; units_delta?: unknown; value_delta?: unknown }[],
): FactAreaMove[] {
  const byArea = new Map<string, FactAreaMove>();
  for (const row of cells) {
    const areaCode = String(row?.area_code ?? "").trim().toUpperCase();
    // The sentinel row says nothing has ever snapshotted this line and period. It is a state to
    // fix, not an area that moved. `phx_closing_drift_rows` already excludes it; this stays as the
    // second belt, because an area with no code is not an area either.
    if (areaCode === "" || areaCode === "(NO SNAPSHOT)") continue;
    const found = byArea.get(areaCode) ?? { areaCode, cells: 0, unitsDelta: 0, valueDelta: 0 };
    found.cells += 1;
    found.unitsDelta += Number(row?.units_delta ?? 0);
    found.valueDelta += Number(row?.value_delta ?? 0);
    byArea.set(areaCode, found);
  }
  return [...byArea.values()];
}

/**
 * Both fact-rollup halves for one line — the status and the per-area moves — from ONE read.
 *
 * 🔴 WHY ONE CALL AND NOT TWO. `phx_closing_drift_status` and `phx_closing_publication_drift` each
 * recompute `phx_closing_publication_snapshot`, the whole month, and the status function used to pay
 * for it TWICE: once for the fingerprint and once for its own count. Three published lines therefore
 * cost nine recomputes of the month, and at 06:36 Cairo on 2026-10-23 one of them crossed the
 * 8-second `authenticator` statement timeout (sql_state 57014) on the daily digest's board read and
 * took four Needs You sources amber with it. CNS 2026-09 alone measured 3,635 ms that morning,
 * against 743 ms for the whole set on 2026-10-09. `phx_closing_drift_overview` computes the cells
 * once and answers both halves off that one array — three recomputes for three lines.
 *
 * 🔴 AND IT IS NOT A WIDENED LANE OR A RAISED BUDGET. Those are forbidden: the board's amber rows
 * were a scheduling defect, and the way to fix a heavy source is to make it cheaper.
 *
 * 🔴 IT THROWS. It used to catch and return null, and a live run on 2026-10-09 showed why that was
 * wrong: `phx_closing_drift_status` for CNS 2026-07 and 2026-08 answered `canceling statement due to
 * statement timeout`, and the swallowed failure came back as `cellDrift: null` — indistinguishable
 * from a line with no publication row. The Needs You row then rendered one sentence shorter and
 * otherwise identical, which is a failed read presented as a quieter answer. The caller decides what
 * to do with the rejection: {@link loadClosingPublicationDrift} collects it into
 * {@link PublicationDriftReport.linesNotRead} so the script can name it and carry on, and
 * {@link loadPublicationDriftWithoutSplitLayer} lets it travel so the board renders amber.
 */
export async function loadPublicationDriftOverview(
  line: string,
  period: string,
): Promise<PublicationDriftOverview> {
  const { data, error } = await getSupabaseAdmin().rpc("phx_closing_drift_overview", {
    p_line: line,
    p_period: period,
  });
  if (error) {
    // The `event` label is what puts a readable route on the `app_error_events` row. Without one,
    // this morning's failure reached the table with route null and an empty stack — the headline and
    // nothing else, so the table said where it was NOT from and never that it was a timeout.
    logError("Failed to read a closing publication drift status", {
      context: { line, period },
      labels: { event: "closing_publication_drift_read_failed", line, period },
      error,
    });
    throw new Error(`publication drift: cannot read the drift status for ${line} ${period} — ${error.message}`);
  }
  const envelope = (data ?? null) as { status?: DriftStatusRow | null; cells?: unknown } | null;
  const row = envelope?.status ?? null;
  const cells = Array.isArray(envelope?.cells)
    ? (envelope.cells as { area_code?: unknown; units_delta?: unknown; value_delta?: unknown }[])
    : [];
  // A genuine absence — the line has no publication row for the period. This is the ONLY null.
  return { areaMoves: rollUpAreaMoves(cells), cellDrift: row ? toCellDrift(row) : null };
}

/**
 * The whole report for one period, read from production — both layers.
 *
 * 🔴 A LINE WHOSE READ FAILED IS NAMED, NOT DROPPED. `phx_closing_drift_status` times out on some
 * line × period pairs (CNS 2026-07 and 2026-08, measured 2026-10-09: `canceling statement due to
 * statement timeout`). One such line must not take the whole period's report down, because the
 * split half for every other line is still worth printing — so it is collected into `linesNotRead`
 * and the caller says so out loud. {@link publicationDriftProvenClean} is false while that list has
 * anything in it.
 */
export async function loadClosingPublicationDrift(period: string): Promise<PublicationDriftReport> {
  const trimmed = String(period ?? "").trim();
  if (!/^\d{4}-\d{2}$/.test(trimmed)) {
    throw new Error(`publication drift: period must be YYYY-MM, got ${JSON.stringify(period)}`);
  }
  const publishedLines = await loadPublishedLines(trimmed);
  const linesNotRead = new Set<string>();
  const [split, overviewEntries] = await Promise.all([
    loadStoreSplitDrift(trimmed),
    Promise.all(publishedLines.map(
      async (line): Promise<readonly [string, PublicationDriftOverview]> => {
        try {
          return [line, await loadPublicationDriftOverview(line, trimmed)];
        } catch {
          linesNotRead.add(line);
          return [line, { areaMoves: [], cellDrift: null }];
        }
      },
    )),
  ]);

  const statuses = new Map<string, PublicationCellDrift>();
  const factAreaMoves = new Map<string, FactAreaMove[]>();
  for (const [line, overview] of overviewEntries) {
    if (overview.cellDrift) statuses.set(line, overview.cellDrift);
    factAreaMoves.set(line, overview.areaMoves);
  }

  return mergePublicationDrift({
    factAreaMoves,
    linesNotRead: [...linesNotRead].sort(),
    period: trimmed,
    publishedLines,
    split,
    splitLayerRead: true,
    statuses,
  });
}

/**
 * The same report WITHOUT the store-split layer — for a caller that cannot afford it.
 *
 * WHY THIS EXISTS RATHER THAN A TIMEOUT AROUND THE FULL READ. Measured on production 2026-10-09 for
 * 2026-09: the published lines 328 ms, the publication cell drift 743 ms, the fact area moves 424 ms
 * — and `loadStoreSplitDrift` 17,282 ms, because it recomputes the whole period. The Needs You board
 * gives every source 8 seconds and renders a slower one as amber forever, which is how a reader
 * learns to ignore amber (`src/lib/needs-you/types.ts` records the vacation source left out for
 * exactly this reason). So the board reads these three layers and says, in the row itself, that the
 * split layer is not among them.
 *
 * 🔴 IT DOES NOT CATCH A FAILED LINE, deliberately unlike the full read above. The full read is a
 * diagnostic a person is watching, so naming the unreadable line and printing the rest is the useful
 * answer. A board source has no such reader: a partial answer there renders as a row one sentence
 * shorter and otherwise identical to a complete one, so the rejection travels and `service.ts` turns
 * it into the amber "could not be read" row — the one branch this board must never swallow.
 *
 * 🔴 WHAT IT CANNOT ANSWER. `splitOnlyLines` and `frozenNotPublished` come back EMPTY here and that
 * is NOT a zero — `splitLayerRead` is false, and {@link publicationDriftProvenClean} is the only
 * thing a caller may use to say a period is clean.
 */
export async function loadPublicationDriftWithoutSplitLayer(period: string): Promise<PublicationDriftReport> {
  const trimmed = String(period ?? "").trim();
  if (!/^\d{4}-\d{2}$/.test(trimmed)) {
    throw new Error(`publication drift: period must be YYYY-MM, got ${JSON.stringify(period)}`);
  }
  const publishedLines = await loadPublishedLines(trimmed);
  const overviewEntries = await Promise.all(
    publishedLines.map(async (line) => [line, await loadPublicationDriftOverview(line, trimmed)] as const),
  );

  const statuses = new Map<string, PublicationCellDrift>();
  const factAreaMoves = new Map<string, FactAreaMove[]>();
  for (const [line, overview] of overviewEntries) {
    if (overview.cellDrift) statuses.set(line, overview.cellDrift);
    factAreaMoves.set(line, overview.areaMoves);
  }

  return mergePublicationDrift({
    factAreaMoves,
    linesNotRead: [],
    period: trimmed,
    publishedLines,
    split: { byArea: [] },
    splitLayerRead: false,
    statuses,
  });
}

/**
 * The ONLY way to assert a period is clean. `!report.drifted` is not that assertion: a report whose
 * expensive layer was never read is silent about the split, not calm about it — and nor is a report
 * that could not read one of its lines.
 */
export function publicationDriftProvenClean(report: PublicationDriftReport): boolean {
  return report.splitLayerRead && report.linesNotRead.length === 0 && !report.drifted;
}

/**
 * Every period holding a live publication row — the only periods with an announced number to drift
 * away from. One implementation, so the script and the Needs You board cannot disagree about which
 * months are in scope (the script carried its own copy of this query until 2026-10-09).
 */
export async function loadPublishedPeriods(): Promise<string[]> {
  const { data, error } = await getSupabaseAdmin()
    .from("monthly_closing_publications")
    .select("period")
    .is("unpublished_at", null);
  if (error) throw error;
  const periods = new Set<string>();
  for (const row of (data ?? []) as { period?: string | null }[]) {
    const value = String(row?.period ?? "").trim();
    if (/^\d{4}-\d{2}$/.test(value)) periods.add(value);
  }
  return [...periods].sort();
}
