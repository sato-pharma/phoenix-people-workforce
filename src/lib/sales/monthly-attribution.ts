import { getSupabaseAdmin, rpcAll } from "@/lib/supabase/server";

// ─────────────────────────────────────────────────────────────────────────────
// Automatic Monthly Closing — SoS fact rollup attributed to the 42-area seat model
// (`au` schema). Read path for Phase 5. Achievement % is intentionally absent —
// it needs targets (Phase 6). Attribution rules and reconciliation guarantees are
// documented in docs/area-unification/phase5-monthly-closing-attribution.md.
//
// Every fact row (validated batches only, confidential products stripped) lands in
// exactly one bucket, so per line: sum(attributed) === sum(raw fact). The DB proves
// this via phx_monthly_attribution_reconcile; loadReconcile() surfaces it.
// ─────────────────────────────────────────────────────────────────────────────

type AttributionChannel = "indirect" | "direct" | "unmapped";

/** One attributed (or unmapped) slice for a period, as returned by the DB RPC. */
export type MonthlyAttributionRow = {
  period: string;
  channel: AttributionChannel;
  lineCode: string | null;
  regionCode: string | null;
  areaCode: string | null;
  areaState: string | null;
  isOther: boolean;
  repSeatId: string | null;
  repHrId: string | null;
  dmSeatId: string | null;
  dmHrId: string | null;
  productCode: string;
  salesUnits: number;
  salesValue: number;
  mapped: boolean;
  unmappedReason: string | null;
};

export type MonthlyAttributionReconcileRow = {
  lineCode: string;
  mappedValue: number;
  unmappedValue: number;
  attributedValue: number;
  rawValue: number;
  diff: number;
};

const PERIOD_RE = /^\d{4}-\d{2}$/;

function isValidPeriod(period: string | null | undefined): period is string {
  return typeof period === "string" && PERIOD_RE.test(period);
}

function num(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function str(value: unknown): string {
  return value == null ? "" : String(value);
}

function optStr(value: unknown): string | null {
  const s = value == null ? "" : String(value).trim();
  return s ? s : null;
}

function mapRow(row: Record<string, unknown>): MonthlyAttributionRow {
  const channelRaw = str(row.channel);
  const channel: AttributionChannel =
    channelRaw === "direct" || channelRaw === "unmapped" ? channelRaw : "indirect";
  return {
    period: str(row.period),
    channel,
    lineCode: optStr(row.line_code),
    regionCode: optStr(row.region_code),
    areaCode: optStr(row.area_code),
    areaState: optStr(row.area_state),
    isOther: row.is_other === true,
    repSeatId: optStr(row.rep_seat_id),
    repHrId: optStr(row.rep_hr_id),
    dmSeatId: optStr(row.dm_seat_id),
    dmHrId: optStr(row.dm_hr_id),
    productCode: str(row.product_code),
    salesUnits: num(row.sales_units),
    salesValue: num(row.sales_value),
    mapped: row.mapped === true,
    unmappedReason: optStr(row.unmapped_reason),
  };
}

/**
 * Load the attributed monthly closing for one period (YYYY-MM). Returns [] for a
 * malformed period. Throws on a real query error (caller decides how to surface).
 */
export async function loadMonthlyAttribution(period: string): Promise<MonthlyAttributionRow[]> {
  if (!isValidPeriod(period)) return [];
  const supabase = getSupabaseAdmin();
  const rows = await rpcAll<Record<string, unknown>>(
    supabase,
    "phx_monthly_attribution",
    { p_period: period },
    ["line_code", "region_code", "area_code", "product_code", "channel"],
  );
  return rows.map(mapRow);
}

// ── Pure rollups (no IO) ──────────────────────────────────────────────────────
// The DB returns product-grained rows; these fold them up for the org hierarchy.
// Direct/unmapped rows have no rep/DM/area and are simply skipped by the person
// and area rollups (they still belong to their line/region totals).

type AttributionTotal = { salesUnits: number; salesValue: number };

function addTotal(target: Map<string, AttributionTotal>, key: string, row: MonthlyAttributionRow): void {
  const current = target.get(key) ?? { salesUnits: 0, salesValue: 0 };
  current.salesUnits += row.salesUnits;
  current.salesValue += row.salesValue;
  target.set(key, current);
}

type RepAttribution = AttributionTotal & {
  repHrId: string;
  lineCode: string | null;
  dmHrId: string | null;
};

/** Sum indirect sales per rep (only rows that have a resolved occupant). */
export function rollupByRep(rows: MonthlyAttributionRow[]): RepAttribution[] {
  const totals = new Map<string, AttributionTotal>();
  const meta = new Map<string, { lineCode: string | null; dmHrId: string | null }>();
  for (const row of rows) {
    if (row.channel !== "indirect" || !row.repHrId) continue;
    addTotal(totals, row.repHrId, row);
    if (!meta.has(row.repHrId)) meta.set(row.repHrId, { lineCode: row.lineCode, dmHrId: row.dmHrId });
  }
  return [...totals.entries()].map(([repHrId, total]) => ({
    repHrId,
    lineCode: meta.get(repHrId)?.lineCode ?? null,
    dmHrId: meta.get(repHrId)?.dmHrId ?? null,
    ...total,
  }));
}

type RegionAttribution = AttributionTotal & { lineCode: string; regionCode: string };

/** Sum sales per (line, region). Includes indirect + direct; skips unmapped. */
export function rollupByRegion(rows: MonthlyAttributionRow[]): RegionAttribution[] {
  const totals = new Map<string, AttributionTotal>();
  // Composite key uses a printable "|" separator (line/region codes never contain it).
  const keyOf = (line: string, region: string) => `${line}|${region}`;
  for (const row of rows) {
    if (!row.mapped || !row.lineCode || !row.regionCode) continue;
    addTotal(totals, keyOf(row.lineCode, row.regionCode), row);
  }
  return [...totals.entries()].map(([key, total]) => {
    const [lineCode, regionCode] = key.split("|");
    return { lineCode, regionCode, ...total };
  });
}

export type LineAttribution = AttributionTotal & { lineCode: string };

