/**
 * The search half of Pharmacy Search: one box, three kinds of input.
 *
 * A person typing into this box means one of three things and never says which — a pharmacy name
 * (Arabic or English), a code (ours, or a distributor's own code for the pharmacy), or a
 * distributor name whose whole customer list they want. Rather than making them choose a mode,
 * every interpretation runs and the results carry `matchedOn` so the reader can see WHY a row
 * came back.
 */

import { normalizeArabicPharmacyName } from "@/lib/pharmacy-master/pharmacy-matching";
import { getSupabaseAdmin } from "@/lib/supabase/server";

import { getTerritoryReference, resolveTerritory, type TerritoryReference } from "./reference";
import type { PharmacySearchHit, PharmacySearchMatchKind } from "./types";

/** Hard cap on rows returned to the browser. Deep paging is not what a search box is for. */
export const PHARMACY_SEARCH_LIMIT = 60;
const MIN_QUERY_LENGTH = 2;
/** Per-branch fetch ceiling — generous enough to rank well, small enough to stay fast. */
const BRANCH_FETCH_LIMIT = 200;

export type PharmacySearchResult = {
  hits: PharmacySearchHit[];
  /** True when every branch came back empty — the signal that the Google fallback is worth it. */
  isEmpty: boolean;
  /** Distributor whose name the query matched, if any. Drives the "showing all of X" banner. */
  matchedDistributorName: string | null;
  query: string;
  /** True when results were cut at the cap, so the UI can say so instead of implying completeness. */
  truncated: boolean;
};

/**
 * PostgREST parses `or=(...)` itself, so a comma, parenthesis or double quote inside a value
 * terminates the filter early and the query either errors or — worse — silently means something
 * else. Strip them; a pharmacy name never depends on them for identity.
 */
function sanitizeForOrFilter(value: string): string {
  return value.replace(/[(),"*\\]/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * Is this input a code rather than a name?
 *
 * Codes in this estate are digit-led (Overseas `0001559807`, Ibn Sina `344524`) or carry a short
 * letter prefix over digits and separators (`B4-58`). A space, or the absence of any digit at
 * all, means a name — and getting that wrong costs a wasted code scan, not a wrong answer, so
 * the rule stays deliberately simple.
 */
function looksLikeCode(value: string): boolean {
  const compact = value.trim();
  if (compact.length < 3 || /\s/.test(compact)) return false;
  if (!/[0-9]/.test(compact)) return false;
  return /^[A-Za-z]{0,4}[0-9][A-Za-z0-9\-/]*$/.test(compact);
}

function hitId(distributorCode: string | null, customerCode: string | null, fallback: string): string {
  if (distributorCode && customerCode) return `${distributorCode}:${customerCode}`;
  return fallback;
}

type CustomerMapRow = {
  address: string | null;
  area_code: string | null;
  brick_id: string | null;
  customer_code: string | null;
  customer_name: string | null;
  distributor_code: string | null;
  region_code: string | null;
};

function toHit(
  row: CustomerMapRow,
  reference: TerritoryReference,
  matchedOn: PharmacySearchMatchKind,
): PharmacySearchHit | null {
  const name = row.customer_name?.trim();
  if (!name) return null;

  const distributorCode = row.distributor_code?.trim() || null;
  const customerCode = row.customer_code?.trim() || null;

  return {
    address: row.address?.trim() || null,
    customerCode,
    distributorCode,
    distributorCount: 1,
    distributorName: distributorCode ? reference.distributorNames.get(distributorCode) ?? distributorCode : null,
    id: hitId(distributorCode, customerCode, `name:${name}`),
    matchedOn,
    name,
    origin: "database",
    territory: resolveTerritory(reference, {
      areaCode: row.area_code,
      brickId: row.brick_id,
      regionCode: row.region_code,
    }),
  };
}

const CUSTOMER_MAP_COLUMNS = "distributor_code, customer_code, customer_name, address, brick_id, area_code, region_code";

/**
 * Collapse the same physical pharmacy carried by several distributors into one hit, and count
 * them. A busy pharmacy appears under Overseas AND Ibn Sina with different codes; showing it
 * twice buries the other results. The surviving row keeps the first territory seen — they agree
 * in practice because both derive from the same brick table — and `distributorCount` tells the
 * reader to open it for the full code list.
 */
function collapseByPharmacy(hits: PharmacySearchHit[]): PharmacySearchHit[] {
  const byKey = new Map<string, PharmacySearchHit>();
  const seenDistributors = new Map<string, Set<string>>();

  for (const hit of hits) {
    const normalized = normalizeArabicPharmacyName(hit.name);
    // Same name in two different bricks is genuinely two pharmacies (4 brick names are known to
    // repeat across areas), so the brick is part of the identity key, not just the name.
    const key = `${normalized}|${hit.territory.brickId ?? ""}`;

    const distributors = seenDistributors.get(key) ?? new Set<string>();
    if (hit.distributorCode) distributors.add(hit.distributorCode);
    seenDistributors.set(key, distributors);

    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, hit);
      continue;
    }
    // Prefer the row that actually carries an address — the reader needs somewhere to look.
    if (!existing.address && hit.address) byKey.set(key, { ...hit, id: existing.id });
  }

  return [...byKey.entries()].map(([key, hit]) => ({
    ...hit,
    distributorCount: Math.max(1, seenDistributors.get(key)?.size ?? 1),
  }));
}

/** Exact-prefix and shorter names first — "الصيدلية الحديثة" should beat a 90-character name. */
function rankHits(hits: PharmacySearchHit[], normalizedQuery: string): PharmacySearchHit[] {
  return [...hits].sort((a, b) => {
    const aName = normalizeArabicPharmacyName(a.name);
    const bName = normalizeArabicPharmacyName(b.name);
    const aExact = aName === normalizedQuery ? 0 : aName.startsWith(normalizedQuery) ? 1 : 2;
    const bExact = bName === normalizedQuery ? 0 : bName.startsWith(normalizedQuery) ? 1 : 2;
    if (aExact !== bExact) return aExact - bExact;
    if (a.name.length !== b.name.length) return a.name.length - b.name.length;
    return a.name.localeCompare(b.name, "ar");
  });
}

/**
 * Search every pharmacy Phoenix knows about. Read-only.
 *
 * Returns `isEmpty: true` rather than throwing when nothing matches — "not in the database" is a
 * legitimate answer here and the caller offers the Google lookup on the back of it.
 */
export async function searchPharmacies(rawQuery: string): Promise<PharmacySearchResult> {
  const query = rawQuery.trim();
  const safe = sanitizeForOrFilter(query);

  if (safe.length < MIN_QUERY_LENGTH) {
    return { hits: [], isEmpty: true, matchedDistributorName: null, query, truncated: false };
  }

  const supabase = getSupabaseAdmin();
  const reference = await getTerritoryReference();

  // Which distributor, if any, is the person naming? Matched against our 20 distributors before
  // anything else, because "Ibn Sina" as a query means "show me Ibn Sina's pharmacies", not
  // "find a pharmacy called Ibn Sina".
  const normalizedQuery = normalizeArabicPharmacyName(safe);
  const matchedDistributor = [...reference.distributorNames.entries()].find(([code, name]) => {
    const normalizedName = normalizeArabicPharmacyName(name);
    return normalizedName === normalizedQuery || code.toLowerCase() === safe.toLowerCase();
  }) ?? null;

  const like = `%${safe}%`;
  // `PromiseLike`, not `Promise`: a PostgREST query builder is a thenable, and calling `.then()` on
  // one returns another thenable rather than a real Promise. `Promise.all` accepts both.
  const branches: Array<PromiseLike<{ kind: PharmacySearchMatchKind; rows: CustomerMapRow[] }>> = [];

  branches.push(
    supabase
      .from("source_of_sales_customer_map")
      .select(CUSTOMER_MAP_COLUMNS)
      .ilike("customer_name", like)
      .limit(BRANCH_FETCH_LIMIT)
      .then(({ data, error }) => {
        if (error) throw new Error(`Pharmacy name search failed: ${error.message}`);
        return { kind: "name" as const, rows: (data ?? []) as CustomerMapRow[] };
      }),
  );

  if (looksLikeCode(safe)) {
    branches.push(
      supabase
        .from("source_of_sales_customer_map")
        .select(CUSTOMER_MAP_COLUMNS)
        .ilike("customer_code", `%${safe}%`)
        .limit(BRANCH_FETCH_LIMIT)
        .then(({ data, error }) => {
          if (error) throw new Error(`Customer code search failed: ${error.message}`);
          return { kind: "customer_code" as const, rows: (data ?? []) as CustomerMapRow[] };
        }),
    );
  }

  if (matchedDistributor) {
    branches.push(
      supabase
        .from("source_of_sales_customer_map")
        .select(CUSTOMER_MAP_COLUMNS)
        .eq("distributor_code", matchedDistributor[0])
        .order("customer_name")
        .limit(BRANCH_FETCH_LIMIT)
        .then(({ data, error }) => {
          if (error) throw new Error(`Distributor search failed: ${error.message}`);
          return { kind: "distributor" as const, rows: (data ?? []) as CustomerMapRow[] };
        }),
    );
  } else {
    // Only worth scanning addresses when the query is not a code and not a distributor — it is
    // the weakest signal and would otherwise drown a good name match.
    branches.push(
      supabase
        .from("source_of_sales_customer_map")
        .select(CUSTOMER_MAP_COLUMNS)
        .ilike("address", like)
        .limit(BRANCH_FETCH_LIMIT)
        .then(({ data, error }) => {
          if (error) throw new Error(`Address search failed: ${error.message}`);
          return { kind: "address" as const, rows: (data ?? []) as CustomerMapRow[] };
        }),
    );
  }

  const settled = await Promise.all(branches);

  const seenRowKeys = new Set<string>();
  const hits: PharmacySearchHit[] = [];
  for (const branch of settled) {
    for (const row of branch.rows) {
      const rowKey = `${row.distributor_code ?? ""}:${row.customer_code ?? ""}:${row.customer_name ?? ""}`;
      if (seenRowKeys.has(rowKey)) continue;
      seenRowKeys.add(rowKey);
      const hit = toHit(row, reference, branch.kind);
      if (hit) hits.push(hit);
    }
  }

  const collapsed = matchedDistributor ? hits : collapseByPharmacy(hits);
  const ranked = rankHits(collapsed, normalizedQuery);

  return {
    hits: ranked.slice(0, PHARMACY_SEARCH_LIMIT),
    isEmpty: ranked.length === 0,
    matchedDistributorName: matchedDistributor?.[1] ?? null,
    query,
    truncated: ranked.length > PHARMACY_SEARCH_LIMIT,
  };
}

/** Exported for the marketing-only fallback path and for tests. */
export const __testables = { collapseByPharmacy, looksLikeCode, rankHits, sanitizeForOrFilter };
