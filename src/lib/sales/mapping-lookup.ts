// Two lookups for the Mapping Database screen, both PURE so they can be unit-tested without a
// database: "I only have a customer code" and "I only have a territory text".
//
// Both exist because the screen today can only answer when you already know the distributor, and
// the answer to the second question is not in the customer map at all.
//
// ── Why the customer-code lookup is allowed to auto-fill the distributor, and where it must not ──
//
// The identity of a Source-of-Sales customer is the PAIR (distributor_code, customer_code) —
// source_of_sales_customer_map carries a UNIQUE index on exactly that, and src/lib/sales/customer-key.ts
// says so out loud. So resolving from a code ALONE is, in principle, the cross-distributor collision
// bug wearing a friendly hat.
//
// Measured on production 2026-09-11, over all 64,990 distinct active codes:
//   61,834 (95.1%) are used by exactly ONE distributor  -> auto-filling is simply correct
//    3,156        are used by TWO (never three)
//      2,612 of those land on the SAME brick anyway     -> the territory answer is identical
//        544        land on a DIFFERENT brick           -> must be chosen, never guessed
//        141        land on a DIFFERENT AREA            -> this is where a sale moves governorate
//
// So the feature is safe for 99.2% of codes and actively dangerous for 544 of them. That is the
// whole design: answer confidently when the data is unambiguous, and REFUSE — with both candidates
// shown side by side — when it is not. Live examples of the refusal set, so nobody is tempted to
// "improve" it into a guess:
//   2029   -> EG  الشفاء - اهناسيا      [UE9 Beni Suef]  vs  QM     شركة تيسلا المنيا [UE2 Minia 2]
//   164002 -> EP-BK                      [CA3 Cairo East] vs  EP-PHS سبشيال فارما      [AB2 Alex Center]
// Different companies, different governorates, identical code.
//
// LEADING ZEROS ARE IDENTITY, NOT FORMATTING. "0001500013" and "1500013" are different customers as
// far as this database is concerned (34,172 of the 68k codes carry a leading zero). The zero-variant
// is therefore offered as a SEPARATE, clearly-labelled suggestion and never merged into the
// candidate list — merging them is precisely the bridge that mis-credits one customer's sales to
// another.

import { normalizeAliasKey } from "@/lib/sales/normalizer/resolvers";
import type { Crosswalks } from "@/lib/sales/normalizer/types";
import { getSupabaseAdmin } from "@/lib/supabase/server";

// ── Customer code, distributor unknown ─────────────────────────────────────────────────────────

export type CodeCandidate = {
  address: string | null;
  areaCode: string | null;
  areaName: string | null;
  brickId: string | null;
  brickName: string | null;
  confidence: number | null;
  customerCode: string;
  customerName: string | null;
  distributorCode: string;
  regionCode: string | null;
};

/** A different spelling of the same digits. Offered, never applied — see the header. */
export type CodeVariant = { candidates: number; customerCode: string; label: string };

export type CodeLookupResult = {
  /** True only when every candidate agrees on the AREA. The 141 that do not are the money cases. */
  agreesOnArea: boolean;
  /** True when every candidate agrees on the brick — the 2,612 harmless duplicates. */
  agreesOnBrick: boolean;
  candidates: CodeCandidate[];
  /** What the UI should do. `choose` means STOP and make a person pick. */
  status: "choose" | "not_found" | "resolved" | "resolved_multi_distributor";
  /** Set only for `not_found`: the same digits spelled with/without leading zeros. */
  variants: CodeVariant[];
};

/** Trimmed, case-preserved. Codes are TEXT: never Number() one, and never strip a leading zero. */
export function normalizeCustomerCodeInput(value: unknown): string {
  return String(value ?? "").trim();
}

/**
 * The two spellings of a purely numeric code. Returns [] for anything alphanumeric, because
 * stripping a zero off "TE001" would invent a code that means nothing.
 */
export function customerCodeVariants(code: string, width = 10): string[] {
  const trimmed = normalizeCustomerCodeInput(code);
  if (!/^\d+$/.test(trimmed)) return [];
  const stripped = trimmed.replace(/^0+(?=\d)/, "");
  const padded = stripped.padStart(width, "0");
  return [...new Set([stripped, padded])].filter((candidate) => candidate !== trimmed);
}

/**
 * Classify what the map knows about one exact code. PURE — the caller does the I/O.
 *
 * `candidates` must be the rows whose customer_code EQUALS the code exactly. Do not pre-merge
 * zero-variants into it; pass those separately as `variantHits` so they stay visibly distinct.
 */
export function classifyCustomerCodeCandidates(
  candidates: readonly CodeCandidate[],
  variantHits: readonly CodeVariant[] = [],
): CodeLookupResult {
  const rows = [...candidates];
  if (rows.length === 0) {
    return { agreesOnArea: false, agreesOnBrick: false, candidates: [], status: "not_found", variants: [...variantHits] };
  }

  const distributors = new Set(rows.map((row) => row.distributorCode));
  const bricks = new Set(rows.map((row) => row.brickId ?? ""));
  const areas = new Set(rows.map((row) => row.areaCode ?? ""));
  const agreesOnBrick = bricks.size === 1;
  const agreesOnArea = areas.size === 1;

  if (distributors.size === 1) {
    return { agreesOnArea, agreesOnBrick, candidates: rows, status: "resolved", variants: [] };
  }
  // Two distributors, one brick: the territory answer is the same either way, so it is safe to
  // show — but the distributor is still genuinely ambiguous and the caller must not silently pick.
  if (agreesOnBrick) {
    return { agreesOnArea, agreesOnBrick, candidates: rows, status: "resolved_multi_distributor", variants: [] };
  }
  return { agreesOnArea, agreesOnBrick, candidates: rows, status: "choose", variants: [] };
}

type MapRow = {
  address: string | null;
  brick_id: string | null;
  confidence: number | null;
  customer_code: string;
  customer_name: string | null;
  distributor_code: string;
  source_of_sales_bricks: { area_code: string | null; brick_name: string | null; region_code: string | null } | null;
};

function toCandidate(row: MapRow, areaName: (code: string | null) => string | null): CodeCandidate {
  const brick = row.source_of_sales_bricks;
  return {
    address: row.address,
    areaCode: brick?.area_code ?? null,
    areaName: areaName(brick?.area_code ?? null),
    brickId: row.brick_id,
    brickName: brick?.brick_name ?? null,
    confidence: row.confidence,
    customerCode: row.customer_code,
    customerName: row.customer_name,
    distributorCode: row.distributor_code,
    regionCode: brick?.region_code ?? null,
  };
}

/**
 * Find every distributor that uses this exact customer code, then classify.
 *
 * The `.eq` is on the EXACT code — no `ltrim`, no numeric canonicalisation. A code that collides
 * only once leading zeros are stripped belongs to a different customer 74 times out of 97, so the
 * zero-variants are counted separately and returned as suggestions, never folded into the answer.
 */
export async function lookupCustomerCodeAcrossDistributors(rawCode: string): Promise<CodeLookupResult> {
  const code = normalizeCustomerCodeInput(rawCode);
  if (!code) return { agreesOnArea: false, agreesOnBrick: false, candidates: [], status: "not_found", variants: [] };

  const supabase = getSupabaseAdmin();
  const select = "distributor_code, customer_code, customer_name, address, brick_id, confidence, source_of_sales_bricks(brick_name, area_code, region_code)";

  const { data, error } = await supabase
    .from("source_of_sales_customer_map")
    .select(select)
    .eq("customer_code", code)
    .order("distributor_code", { ascending: true });
  if (error) throw error;

  const rows = (data ?? []) as unknown as MapRow[];

  // Area NAMES come from the area master, not the brick row — the brick carries only the code.
  const areaCodes = [...new Set(rows.map((row) => row.source_of_sales_bricks?.area_code).filter(Boolean))] as string[];
  const names = new Map<string, string>();
  if (areaCodes.length > 0) {
    const { data: areas } = await supabase
      .from("source_of_sales_areas")
      .select("area_code, area_name")
      .in("area_code", areaCodes);
    for (const area of areas ?? []) names.set(String(area.area_code), String(area.area_name ?? ""));
  }
  const areaName = (areaCode: string | null) => (areaCode ? names.get(areaCode) ?? null : null);

  if (rows.length > 0) {
    return classifyCustomerCodeCandidates(rows.map((row) => toCandidate(row, areaName)));
  }

  // Nothing on the exact code — is the same number spelled differently in the map?
  const variants: CodeVariant[] = [];
  for (const variant of customerCodeVariants(code)) {
    const { count } = await supabase
      .from("source_of_sales_customer_map")
      .select("id", { count: "exact", head: true })
      .eq("customer_code", variant);
    if ((count ?? 0) > 0) {
      variants.push({
        candidates: count ?? 0,
        customerCode: variant,
        label: variant.length > code.length ? "with leading zeros" : "without leading zeros",
      });
    }
  }
  return classifyCustomerCodeCandidates([], variants);
}

// ── Territory text, no customer code ───────────────────────────────────────────────────────────

export type TerritoryLookupResult = {
  areaCode: string | null;
  areaName: string | null;
  brickId: string | null;
  brickName: string | null;
  /** The normalizeAliasKey() form actually looked up — shown so a miss is explicable. */
  key: string;
  regionCode: string | null;
  regionName: string | null;
  /**
   * `brick`      — a brick alias hit. Assign it.
   * `area_only`  — only an area alias hit. Write the area; the brick is an owner question.
   * `ambiguous`  — the key points at two different targets, so production drops it too.
   * `unresolved` — nothing. Not a failure: a bare territory text has no other route.
   */
  status: "ambiguous" | "area_only" | "brick" | "unresolved";
};

const EMPTY: Omit<TerritoryLookupResult, "key" | "status"> = {
  areaCode: null, areaName: null, brickId: null, brickName: null, regionCode: null, regionName: null,
};

/**
 * Resolve a raw territory text the way the import pipeline does — brick alias first, then the
 * SEPARATE area alias table, and nothing else.
 *
 * Three things this deliberately mirrors from resolveBrick()/buildAliasIndex():
 *  1. The key is `normalizeAliasKey`, which KEEPS spaces and does NOT fold ة. Reaching for
 *     phx_normalize_arabic here does not merely miss — it MANUFACTURES hits production would never
 *     return (measured on `الخطاطبة`: the phx form finds 1 alias, the correct key finds 0).
 *  2. An alias key that pointed at two different targets is dropped from every index and parked in
 *     `ambiguousAliasKeys`. Say "ambiguous", never "unknown" — Egypt reuses place names.
 *  3. There is NO brick-NAME route. A bare brick name resolves to nothing rather than being
 *     silently mis-assigned, and that is the resolver working correctly.
 */
export function resolveTerritoryText(text: string, maps: Crosswalks): TerritoryLookupResult {
  const key = normalizeAliasKey(text);
  if (!key) return { ...EMPTY, key: "", status: "unresolved" };

  if (maps.ambiguousAliasKeys?.has(key)) {
    return { ...EMPTY, key, status: "ambiguous" };
  }

  const territory = maps.territoryAliasByKey.get(key);
  if (territory && territory.targetType === "brick") {
    const brick = maps.brickById.get(territory.targetCode);
    if (brick) {
      return {
        areaCode: brick.areaCode, areaName: brick.areaName,
        brickId: brick.brickId, brickName: brick.brickName,
        key, regionCode: brick.regionCode, regionName: brick.regionName, status: "brick",
      };
    }
  }

  const area = maps.areaAliasByKey.get(key);
  if (area) {
    const ref = maps.areaByCode.get(area.areaCode);
    return {
      ...EMPTY,
      areaCode: area.areaCode,
      areaName: ref?.areaName ?? null,
      key,
      regionCode: area.regionCode ?? ref?.regionCode ?? null,
      regionName: ref?.regionName ?? null,
      status: "area_only",
    };
  }

  return { ...EMPTY, key, status: "unresolved" };
}
