// ─────────────────────────────────────────────────────────────────────────────────────────────────
// What a held mapping change is actually worth, what the distributor's own file said, and what the
// normalizer would answer — the three things the Mapping guard screen was deciding without.
//
// Owner, 2026-10-09, after a district manager found a customer in her closing sheet and gone from
// the next download: "add the lock button and the money on each hold row", then "add the normalizer
// to recommend and suggest", then "add the column that have the address that came with the
// distributor ... get the address, the brick, the government. Very important."
//
// The screen used to show six facts — the code, the kind, where the mapping sits, where the change
// wanted it, why it was stopped, and who wrote it. None of them is the question he was being asked.
// The question is whether that pharmacy really belongs where the file says, and how much money
// rides on the answer. Both live in data this screen never read.
//
// EVERY READING IS A SEPARATE, OPTIONAL LAYER. A hold must stay decidable when the suggestion
// pipeline is unavailable (it reads the whole customer map, and the AI step is deliberately off
// here), when a customer has filed no sales at all, and when the two new database functions have
// not been applied yet. So each loader catches its own failure and the row simply renders without
// that panel — never an error page over a decision he can still take correctly from the rest.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

import { logError } from "@/lib/observability/log";
import { ATTRIBUTION_SPLIT_LINES } from "@/lib/sales/attribution-store-split-net";
import type { HeldMappingChange } from "@/lib/sales/mapping-guard";
import {
  CUSTOMER_MAP_TABLE,
  currentCairoPeriod,
  pickDistributorFacts,
  summarizeHoldSales,
  verdictForSuggestion,
  type HoldDetail,
  type HoldDistributorFact,
  type HoldSalesImpactRow,
  type HoldSuggestion,
} from "@/lib/sales/mapping-guard-hold-shape";
import { suggestCustomerBricks } from "@/lib/sales/normalizer/customer-suggest";
import { getSupabaseAdmin } from "@/lib/supabase/server";

// The types and the pure shaping live in mapping-guard-hold-shape.ts, because the review screen is
// a client component and this file reaches the Supabase admin client and the normalizer. Re-exported
// so a server caller has one import.
export * from "@/lib/sales/mapping-guard-hold-shape";

/** Tracked money only — CNS, Anti Infective and Pedia. Head Office carries no price at all. */
export const TRACKED_IMPACT_LINES: readonly string[] = ATTRIBUTION_SPLIT_LINES;

// ── The loaders ────────────────────────────────────────────────────────────────────────────────

type MapRow = {
  id: number;
  customer_name: string | null;
  address: string | null;
  customer_code: string | null;
  distributor_code: string | null;
};

/**
 * Everything the screen needs beyond the hold itself, keyed by hold id.
 *
 * One pass for all the holds rather than one pass per row: the suggestion pipeline reads the whole
 * live customer map (about 50,000 rows), and paying that per hold would make the screen unusable at
 * the 92 customers he was handed on 2026-10-09.
 */
export async function loadHoldDetails(holds: readonly HeldMappingChange[]): Promise<Record<number, HoldDetail>> {
  const details: Record<number, HoldDetail> = {};
  if (holds.length === 0) return details;

  const customerHolds = holds.filter((hold) => hold.tableName === CUSTOMER_MAP_TABLE && hold.rowId > 0);

  const mapRows = new Map<number, MapRow>();
  const siblingsBySubject = new Map<string, number>();
  for (const hold of holds) {
    siblingsBySubject.set(hold.subject, (siblingsBySubject.get(hold.subject) ?? 0) + 1);
  }

  for (const hold of holds) {
    details[hold.id] = {
      distributorName: null,
      filed: [],
      holdId: hold.id,
      lockable: hold.tableName === CUSTOMER_MAP_TABLE && hold.rowId > 0,
      sales: null,
      // Its own row is in the count, so a customer appearing once has no siblings.
      siblingPending: Math.max(0, (siblingsBySubject.get(hold.subject) ?? 1) - 1),
      storedAddress: null,
      storedName: null,
      suggestion: null,
    };
  }
  if (customerHolds.length === 0) return details;

  const holdIds = customerHolds.map((hold) => hold.id);

  const [maps, impacts, filed] = await Promise.all([
    readMapRows(customerHolds.map((hold) => hold.rowId)),
    readSalesImpact(holdIds),
    readDistributorFacts(holdIds),
  ]);

  for (const row of maps) mapRows.set(row.id, row);

  const salesByHold = summarizeHoldSales(impacts, currentCairoPeriod());
  const filedByHold = new Map<number, HoldDistributorFact[]>();
  for (const entry of filed) {
    filedByHold.set(entry.holdId, [...(filedByHold.get(entry.holdId) ?? []), entry.fact]);
  }

  const distributorNames = await loadDistributorNames(
    [...new Set([...mapRows.values()].map((row) => String(row.distributor_code ?? "").trim()).filter(Boolean))],
  );

  const suggestions = await loadSuggestions(customerHolds, mapRows);

  for (const hold of customerHolds) {
    const detail = details[hold.id];
    const map = mapRows.get(hold.rowId);
    detail.storedAddress = map?.address?.trim() || null;
    detail.storedName = map?.customer_name?.trim() || null;
    detail.distributorName = distributorNames.get(String(map?.distributor_code ?? "").trim().toUpperCase()) ?? null;
    detail.sales = salesByHold.get(hold.id) ?? null;
    detail.filed = pickDistributorFacts(filedByHold.get(hold.id) ?? []);
    detail.suggestion = suggestions.get(hold.id) ?? null;
  }

  return details;
}

// ── The three readings, each one optional ──────────────────────────────────────────────────────
//
// Each is its own function with its own try/catch, and deliberately NOT a `.catch()` hung on the
// query builder: Supabase's `.then()` returns a PromiseLike, which has no `.catch` at all
// (TS2339, caught by the PR's typecheck on 2026-10-09), and the two-argument `.then(ok, onError)`
// would not see the error the `ok` handler itself throws for `result.error` — which is every
// database failure there is.
//
// A failure here must cost that ONE panel, never the decision. The row still renders, he can still
// answer it from the rest, and the reason is in the log.

async function readMapRows(ids: readonly number[]): Promise<MapRow[]> {
  try {
    const { data, error } = await getSupabaseAdmin()
      .from(CUSTOMER_MAP_TABLE)
      .select("id,customer_name,address,customer_code,distributor_code")
      .in("id", [...ids]);
    if (error) throw error;
    return (data ?? []) as MapRow[];
  } catch (error) {
    logError("Mapping guard detail: the held customers could not be read", {
      labels: { event: "mapping_guard_detail_map_failed" },
      error,
    });
    return [];
  }
}

async function readSalesImpact(holdIds: readonly number[]): Promise<HoldSalesImpactRow[]> {
  try {
    const { data, error } = await getSupabaseAdmin().rpc("sos_map_hold_sales_impact", {
      p_hold_ids: [...holdIds],
      p_lines: [...TRACKED_IMPACT_LINES],
    });
    if (error) throw error;
    return (
      (data ?? []) as Array<{ hold_id: number; period: string; tracked_value: number | string; row_count: number | string }>
    ).map((row) => ({
      holdId: Number(row.hold_id),
      period: String(row.period ?? ""),
      rowCount: Number(row.row_count ?? 0),
      trackedValue: Number(row.tracked_value ?? 0),
    }));
  } catch (error) {
    // The function lands with this migration; before it is applied the screen is simply the one it
    // was yesterday, rather than an error page.
    logError("Mapping guard detail: the sales behind the holds could not be read", {
      labels: { event: "mapping_guard_detail_impact_failed" },
      error,
    });
    return [];
  }
}

async function readDistributorFacts(
  holdIds: readonly number[],
): Promise<Array<{ holdId: number; fact: HoldDistributorFact }>> {
  try {
    const { data, error } = await getSupabaseAdmin().rpc("sos_map_hold_distributor_facts", {
      p_hold_ids: [...holdIds],
    });
    if (error) throw error;
    return ((data ?? []) as Array<Record<string, unknown>>).map((row) => ({
      holdId: Number(row.hold_id),
      fact: {
        filedAddress: (row.filed_address as string | null) ?? null,
        filedArea: (row.filed_area as string | null) ?? null,
        filedBrickId: (row.filed_brick_id as string | null) ?? null,
        filedBrickName: (row.filed_brick_name as string | null) ?? null,
        filedName: (row.filed_name as string | null) ?? null,
        filedRegion: (row.filed_region as string | null) ?? null,
        lastFiled: (row.last_filed as string | null) ?? null,
        period: String(row.period ?? ""),
        rowsFiled: Number(row.rows_filed ?? 0),
      } satisfies HoldDistributorFact,
    }));
  } catch (error) {
    logError("Mapping guard detail: what the distributors filed could not be read", {
      labels: { event: "mapping_guard_detail_filed_failed" },
      error,
    });
    return [];
  }
}

async function loadDistributorNames(codes: readonly string[]): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  if (codes.length === 0) return names;
  const { data, error } = await getSupabaseAdmin()
    .from("source_of_sales_distributors")
    .select("distributor_code,distributor_name")
    .in("distributor_code", [...codes]);
  if (error) {
    logError("Mapping guard detail: distributor names could not be read", {
      labels: { event: "mapping_guard_detail_distributors_failed" },
      error,
    });
    return names;
  }
  for (const row of (data ?? []) as Array<{ distributor_code: string; distributor_name: string | null }>) {
    const name = String(row.distributor_name ?? "").trim();
    if (name) names.set(String(row.distributor_code).trim().toUpperCase(), name);
  }
  return names;
}

/**
 * What the normalizer would answer for each held pharmacy — "add the normalizer to recommend and
 * suggest" (owner, 2026-10-09).
 *
 * `ai: false` deliberately: the free steps (an already-mapped twin, the same address as a mapped
 * pharmacy, one of our own brick names inside the pharmacy name) plus AI answers already paid for.
 * No AI call and no AI key needed, so opening this screen cannot spend money and cannot hang on a
 * provider — and what comes back is the same pipeline the monthly import itself resolves with,
 * which is the point: the recommendation has to be the system's own answer, not a second opinion
 * invented for this screen.
 */
async function loadSuggestions(
  holds: readonly HeldMappingChange[],
  mapRows: ReadonlyMap<number, MapRow>,
): Promise<Map<number, HoldSuggestion>> {
  const byHold = new Map<number, HoldSuggestion>();
  const unknowns: Array<{ raw: string; rawName?: string; rawAddress?: string }> = [];
  const holdsByRaw = new Map<string, HeldMappingChange[]>();

  for (const hold of holds) {
    const map = mapRows.get(hold.rowId);
    const name = String(map?.customer_name ?? "").trim();
    const address = String(map?.address ?? "").trim();
    if (!name && !address) continue;
    // The raw key identifies the pharmacy to the pipeline AND keys the answer back to the hold.
    const raw = `${hold.subject} ${name}`.trim();
    if (!holdsByRaw.has(raw)) {
      unknowns.push({ raw, rawAddress: address || undefined, rawName: name || undefined });
    }
    holdsByRaw.set(raw, [...(holdsByRaw.get(raw) ?? []), hold]);
  }
  if (unknowns.length === 0) return byHold;

  try {
    const { bricks, suggestions } = await suggestCustomerBricks(unknowns, { ai: false });
    for (const suggestion of suggestions) {
      const matched = holdsByRaw.get(suggestion.raw) ?? [];
      const brick = bricks.get(suggestion.code);
      const label = brick
        ? [brick.brickName, [brick.areaName, brick.regionName].filter(Boolean).join(", ")].filter(Boolean).join(" — ")
        : suggestion.code;
      for (const hold of matched) {
        byHold.set(hold.id, {
          brickId: suggestion.code,
          confidence: typeof suggestion.confidence === "number" ? suggestion.confidence : null,
          label,
          source: suggestion.source,
          verdict: verdictForSuggestion(suggestion.code, hold.fromBrickId, hold.toBrickId),
        });
      }
    }
  } catch (error) {
    // A screen that cannot suggest is still a screen he can decide on.
    logError("Mapping guard detail: the normalizer could not suggest", {
      labels: { event: "mapping_guard_detail_suggest_failed" },
      error,
    });
  }
  return byHold;
}
