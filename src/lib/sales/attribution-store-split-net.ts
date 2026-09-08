// The wholesaler city split, materialised for ATTRIBUTION.
//
// The Closing Matrix applies the split live when it renders (closing-store-split-net.ts).
// au.f_monthly_attribution — which feeds Sales vs Target, the Business Review, incentives and every
// achievement surface — reads public.source_of_sales_fact_rollup straight and cannot see it. Before
// this module the two disagreed: measured on production 2026-09-07 for August Pedia, El Qema's
// Qalubeya wholesalers read 950.86 units in D11 on the closing and 6,656 on Sales vs Target.
//
// 🔴 THIS IS THE ONE PLACE THE TWO SIDES MEET, AND IT DELIBERATELY CARRIES NO RULE OF ITS OWN.
// Deciding who is a wholesaler means Arabic letter-folding, the owner's six keywords, four override
// lists, the trade phrase, the never-a-store words, the wholesale-only distributor registry and the
// PER-LINE period gate. That lives once, in customer-channel.ts and store-sales-city-split.ts, pinned
// by tests in the required CI `validate` job. This module calls those functions and converts their
// OUTPUT into rows; it never re-decides anything. A second copy of the rule would drift silently and
// move money between reps with no error anywhere.
//
// WHY TWO PASSES. The rollup carries two measures and attribution uses BOTH: total_qty becomes
// sales_units, and effective_units (qty x (1 - discount)) is what gets priced into sales_value.
// splitStoreSalesAcrossCityAreas moves `qty`, so it is run twice — once on the real qty and once on
// rows whose qty has been replaced by effectiveUnits. Eligibility cannot differ between the passes:
// isSplitEligible reads isDirect, includedInClosing, officialLine, the customer fields and the area,
// and none of those is touched. splitRowCount is compared anyway, because "cannot differ" is an
// argument and the assertion is a fact.
//
// The two measures are equal on all 21,066 production rows from 2026-08 today. That is a fact about
// the current data, not a definition, so they are carried separately.

import { loadOthersAreas } from "@/lib/sales/closing-organogram-regions";
import {
  isSplitEligibleLine,
  isStoreCitySplitActive,
  splitStoreSalesAcrossCityAreas,
  type StoreSplitAreaMovement,
  type StoreSplitRow,
} from "@/lib/sales/store-sales-city-split";

/**
 * The lines the split can touch, spelled as `au.sos_official_line_map.official_line` spells them.
 *
 * NOT lower-cased or otherwise normalised here on purpose: the map is NOT the identity
 * ("Anti Infective" resolves to `anti_infective`), so the resolution belongs in SQL, inside
 * phx_write_monthly_store_split_net, which refuses a name it cannot map rather than writing a net
 * that would join to nothing. Head Office is absent because the split never applies to it.
 */
export const ATTRIBUTION_SPLIT_LINES = ["Pedia", "Anti Infective", "CNS"] as const;

/** One row of the payload phx_write_monthly_store_split_net consumes. */
export type StoreSplitNetPayloadRow = {
  official_line: string;
  area_code: string;
  product_code: string;
  net_qty: number;
  net_effective_units: number;
};

/**
 * A closing detail row, narrowed to what this module needs.
 *
 * `effectiveUnits` is required rather than optional: a caller that omitted it would silently produce
 * a net whose money half is zero, which reads as "this line does not split" instead of as an error.
 */
export type AttributionSplitRow = StoreSplitRow & { effectiveUnits: number };

/** Rounding floor. Below this a cell is noise from float arithmetic, not a movement. */
const EPSILON = 1e-9;

function accumulate(
  into: Map<string, StoreSplitNetPayloadRow>,
  officialLine: string,
  movements: readonly StoreSplitAreaMovement[],
  field: "net_qty" | "net_effective_units",
): void {
  for (const movement of movements) {
    const areaCode = String(movement.areaCode ?? "").trim().toUpperCase();
    const productCode = String(movement.productCode ?? "").trim().toUpperCase();
    if (!areaCode || !productCode) continue;
    const key = `${areaCode}${productCode}`;
    const row = into.get(key) ?? {
      official_line: officialLine,
      area_code: areaCode,
      product_code: productCode,
      net_qty: 0,
      net_effective_units: 0,
    };
    row[field] += movement.inQty - movement.outQty;
    into.set(key, row);
  }
}

/**
 * The net this line's split moves, per area and product. Empty whenever nothing moves — a period
 * before the split's own start, a line it never touches, or a month with no wholesaler in it — and
 * an empty payload is a legitimate answer, not a failure.
 *
 * The returned rows sum to zero per product by construction, which is what
 * phx_write_monthly_store_split_net independently re-checks before it writes.
 */
export function buildStoreSplitNetPayload(
  officialLine: string,
  rows: readonly AttributionSplitRow[],
  period: string,
  othersAreas?: ReadonlySet<string>,
): StoreSplitNetPayloadRow[] {
  if (!isStoreCitySplitActive(period)) return [];
  if (!isSplitEligibleLine(officialLine)) return [];

  // Both passes take the SAME exclusion set. They already have to move the same rows (asserted
  // below); handing one of them a different set of target areas would put units on one geography
  // and money on another, which is the one shape this function exists to make impossible.
  const qtyPass = splitStoreSalesAcrossCityAreas(rows, period, othersAreas);
  const effectivePass = splitStoreSalesAcrossCityAreas(
    rows.map((row) => ({ ...row, qty: row.effectiveUnits })),
    period,
    othersAreas,
  );

  // Both passes must have moved the SAME rows — see the header. If they ever diverge the net would
  // be internally inconsistent (units from one population, money from another), so this throws
  // rather than writing something plausible.
  if (qtyPass.splitRowCount !== effectivePass.splitRowCount) {
    throw new Error(
      `attribution store split: the two passes disagreed for ${officialLine} ${period} `
      + `(${qtyPass.splitRowCount} vs ${effectivePass.splitRowCount} rows) — refusing to build a net`,
    );
  }

  const byCell = new Map<string, StoreSplitNetPayloadRow>();
  accumulate(byCell, officialLine, qtyPass.movements, "net_qty");
  accumulate(byCell, officialLine, effectivePass.movements, "net_effective_units");

  return [...byCell.values()].filter(
    (row) => Math.abs(row.net_qty) > EPSILON || Math.abs(row.net_effective_units) > EPSILON,
  );
}

/** What `writeAttributionStoreSplitNet` did, for the caller's log line. */
export type AttributionStoreSplitWriteResult = {
  period: string;
  /** Rows sent to the database, across every line. */
  payloadRows: number;
  /** Rows the database kept — it drops cells whose in and out cancel exactly. */
  written: number;
  /** Lines that produced at least one moved cell. */
  linesWithMovement: string[];
};

type SupabaseLike = {
  rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: unknown }>;
};

/**
 * Recompute and store the whole period's split net.
 *
 * ALWAYS every eligible line, never just the line that happened to be imported:
 * phx_write_monthly_store_split_net replaces the period wholesale, so writing one line's rows would
 * delete the other two lines' and silently un-split them.
 *
 * `loadRowsForLine` is injected rather than imported so the arithmetic above can be tested without a
 * database, and so this module does not drag the closing detail loader into every caller's bundle.
 */
export async function writeAttributionStoreSplitNet(input: {
  period: string;
  supabase: SupabaseLike;
  loadRowsForLine: (line: string, period: string) => Promise<readonly AttributionSplitRow[]>;
  /**
   * The organogram's Others set for a line and month. Injectable for the same reason
   * `loadRowsForLine` is: without it this function reaches into the live org chart, and a test that
   * cannot control that answer either hits production or silently exercises an EMPTY set — which is
   * indistinguishable from the rule not applying at all. Defaults to the real loader.
   */
  loadOthersAreasForLine?: (line: string, period: string) => Promise<ReadonlySet<string>>;
}): Promise<AttributionStoreSplitWriteResult> {
  const period = String(input.period ?? "").trim();
  const payload: StoreSplitNetPayloadRow[] = [];
  const linesWithMovement: string[] = [];

  // A period the split never touches still writes — an EMPTY payload, which clears any net a
  // previous run left behind. Skipping the call instead would strand stale rows the moment the
  // owner moved a start period later, and attribution would keep applying a split that no longer
  // exists.
  if (isStoreCitySplitActive(period)) {
    for (const line of ATTRIBUTION_SPLIT_LINES) {
      const rows = await input.loadRowsForLine(line, period);
      // The organogram's Others set, for THIS line and THIS month — see loadOthersAreas. Loaded
      // per line because the set genuinely differs between them: Qalubeya is Others on Anti
      // Infective and a district of its own on Pedia.
      const othersAreas = await (input.loadOthersAreasForLine ?? loadOthersAreas)(line, period);
      const lineRows = buildStoreSplitNetPayload(line, rows, period, othersAreas);
      if (lineRows.length > 0) linesWithMovement.push(line);
      payload.push(...lineRows);
    }
  }

  const { data, error } = await input.supabase.rpc("phx_write_monthly_store_split_net", {
    p_period: period,
    p_rows: payload,
  });
  if (error) {
    const message = typeof error === "object" && error !== null && "message" in error
      ? String((error as { message: unknown }).message)
      : String(error);
    throw new Error(`attribution store split: writing the net for ${period} failed — ${message}`);
  }

  return {
    period,
    payloadRows: payload.length,
    written: typeof data === "number" ? data : Number(data ?? 0),
    linesWithMovement,
  };
}
