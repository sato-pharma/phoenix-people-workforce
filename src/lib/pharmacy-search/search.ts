/**
 * The search half of Pharmacy Search: one box, three kinds of input, over two registers.
 *
 * A person typing into this box means one of three things and never says which — a pharmacy name
 * (Arabic or English), a code (ours, or a distributor's own code for the pharmacy), or a
 * distributor name whose whole customer list they want. Rather than making them choose a mode,
 * every interpretation runs and the results carry `matchedOn` so the reader can see WHY a row
 * came back.
 *
 * A pharmacy is born down TWO disjoint paths and neither writes the other's table:
 * `source_of_sales_customer_map`, loaded from the distributor files, and `direct_order_pharmacies`,
 * written when someone registers a venue in Phoenix itself. The owner's rule of 2026-08-04 —
 * "when any new pharmacy is added any way into Phoenix, the drop list is updated" — is why
 * `phx_search_direct_order_customers` UNIONs both for the direct-order picker. This screen
 * searched only the first half of it until 2026-09-08, when the owner searched a pharmacy someone
 * had registered by hand five hours earlier, was told it was not in the database, and spent a
 * billed Google Places call being told so.
 */

import { normalizeArabicPharmacyName, removeStopWords } from "@/lib/pharmacy-master/pharmacy-matching";
import type { SourceMaskViewer } from "@/lib/sales/closing-source-mask";
import { getSupabaseAdmin } from "@/lib/supabase/server";

import { getTerritoryReference, resolveTerritory, type TerritoryReference } from "./reference";
import { visibleDistributorRows, visibleTerritoryReference } from "./source-visibility";
import { PHOENIX_PROFILE_ID_PREFIX, type PharmacySearchHit, type PharmacySearchMatchKind } from "./types";

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
    // Filled in by `foldRegistryIntoDirectory` / `collapseByPharmacy` when Phoenix also holds a
    // registration for this pharmacy. A directory row knows nothing about the registry itself.
    phoenixPharmacyCode: null,
    territory: resolveTerritory(reference, {
      areaCode: row.area_code,
      brickId: row.brick_id,
      regionCode: row.region_code,
    }),
  };
}

const CUSTOMER_MAP_COLUMNS = "distributor_code, customer_code, customer_name, address, brick_id, area_code, region_code";

// ── The Phoenix registry ─────────────────────────────────────────────────────────────────────

/**
 * The whole active registry is read on every search, not a filtered slice of it.
 *
 * That is a deliberate trade, and the reason is the Arabic. Matching a typed name against a
 * stored one needs `normalizeArabicPharmacyName` on BOTH sides, and PostgREST cannot call a
 * function inside a filter — the direct-order picker solves the same problem by moving the whole
 * search into a `plpgsql` function (`phx_search_direct_order_customers`) so `phx_normalize_arabic`
 * can run in SQL. Here the table is small enough that reading it whole and matching in memory is
 * both cheaper and simpler, and it keeps the match rule in the same normalizer `collapseByPharmacy`
 * uses — which is what makes a registry hit and a directory hit for one pharmacy collapse at all.
 *
 * Measured on production 2026-09-08: 75 rows ever written, 53 of them active. The ceiling below is
 * ~40x that, so it is a guard against an unexpected import, not a paging limit; if the registry
 * ever approaches it, this branch moves into SQL alongside the picker's.
 */
const REGISTRY_FETCH_LIMIT = 2000;

const REGISTRY_COLUMNS = "id, phoenix_pharmacy_code, pharmacy_name, pharmacy_address, brick_id, area_code, region_code";

type RegistryPharmacyRow = {
  area_code: string | null;
  brick_id: string | null;
  id: string | null;
  pharmacy_address: string | null;
  pharmacy_name: string | null;
  phoenix_pharmacy_code: string | null;
  region_code: string | null;
};

type RegistryCodeRow = {
  customer_code: string | null;
  distributor_code: string | null;
  pharmacy_id: string | null;
};

/** One pharmacy registered inside Phoenix, with every distributor code recorded against it. */
export type RegistryPharmacy = {
  address: string | null;
  areaCode: string | null;
  brickId: string | null;
  /** May be empty — a venue can be registered before any distributor has a code for it. */
  codes: Array<{ customerCode: string; distributorCode: string }>;
  name: string;
  phoenixPharmacyCode: string;
  regionCode: string | null;
};

/**
 * Does this registered pharmacy answer the typed query, and on what?
 *
 * Names are compared with the generic words removed from BOTH sides, which is what makes the
 * production case work: the owner typed "صيدلية الإنسانية" and the registry holds "الإنسانية",
 * so a plain substring test fails in the direction nobody checks — the QUERY is the longer
 * string. `removeStopWords` drops "صيدلية" from the query and the two meet. It never strips a
 * name down to nothing, so a pharmacy called only "صيدلية" stays findable.
 */
function matchRegistryPharmacy(
  pharmacy: RegistryPharmacy,
  query: { normalized: string; raw: string },
): PharmacySearchMatchKind | null {
  const raw = query.raw.trim().toLowerCase();

  // Codes first: a code is an unambiguous identifier, and reporting a code hit as a name hit
  // would tell the reader the wrong thing about why the row came back.
  if (raw && pharmacy.phoenixPharmacyCode.toLowerCase().includes(raw)) return "phoenix_code";
  if (raw && pharmacy.codes.some((code) => code.customerCode.toLowerCase().includes(raw))) return "customer_code";

  if (!query.normalized) return null;
  const name = normalizeArabicPharmacyName(pharmacy.name);
  if (name.includes(query.normalized)) return "name";
  return removeStopWords(name).includes(removeStopWords(query.normalized)) ? "name" : null;
}

/**
 * One hit per distributor code, exactly as the directory branches emit one row per mapping —
 * which is what lets `collapseByPharmacy` count the distributors without a second code list. A
 * pharmacy carrying no distributor code still yields one hit: being invisible for want of a
 * distributor is the whole failure this branch exists to fix.
 *
 * The territory is the VENUE's own — `direct_order_pharmacies.brick_id`, validated against the
 * rep's GPS when it was registered — never the `mapped_*` columns on a code row. Those say where
 * one distributor's catalogue files it, and using them would split one pharmacy's hits across
 * several collapse keys.
 */
function registryHits(
  pharmacy: RegistryPharmacy,
  reference: TerritoryReference,
  matchedOn: PharmacySearchMatchKind,
): PharmacySearchHit[] {
  const territory = resolveTerritory(reference, {
    areaCode: pharmacy.areaCode,
    brickId: pharmacy.brickId,
    regionCode: pharmacy.regionCode,
  });

  const base = {
    address: pharmacy.address,
    matchedOn,
    name: pharmacy.name,
    origin: "phoenix" as const,
    phoenixPharmacyCode: pharmacy.phoenixPharmacyCode,
    territory,
  };

  if (pharmacy.codes.length === 0) {
    return [
      {
        ...base,
        customerCode: null,
        distributorCode: null,
        distributorCount: 0,
        distributorName: null,
        id: `${PHOENIX_PROFILE_ID_PREFIX}${pharmacy.phoenixPharmacyCode}`,
        matchedOn,
      },
    ];
  }

  return pharmacy.codes.map((code) => ({
    ...base,
    customerCode: code.customerCode,
    distributorCode: code.distributorCode,
    distributorCount: 1,
    distributorName: reference.distributorNames.get(code.distributorCode) ?? code.distributorCode,
    // Never `${distributor}:${customer}` on its own: a registry hit that survives beside a
    // directory row for a different pharmacy must not collide with it as a React key.
    id: `${PHOENIX_PROFILE_ID_PREFIX}${pharmacy.phoenixPharmacyCode}:${code.customerCode}`,
  }));
}

/** Read the active registry and its distributor codes. Two plain selects, no embedding. */
async function loadRegistryPharmacies(viewer: SourceMaskViewer): Promise<RegistryPharmacy[]> {
  const supabase = getSupabaseAdmin();

  const [pharmacies, codes] = await Promise.all([
    supabase
      .from("direct_order_pharmacies")
      .select(REGISTRY_COLUMNS)
      .eq("active", true)
      .limit(REGISTRY_FETCH_LIMIT),
    visibleDistributorRows(
      supabase.from("direct_order_pharmacy_distributor_codes").select("pharmacy_id, distributor_code, customer_code"),
      viewer,
    ).limit(REGISTRY_FETCH_LIMIT),
  ]);

  if (pharmacies.error) throw new Error(`Phoenix pharmacy registry search failed: ${pharmacies.error.message}`);
  if (codes.error) throw new Error(`Phoenix pharmacy code lookup failed: ${codes.error.message}`);

  const codesByPharmacy = new Map<string, Array<{ customerCode: string; distributorCode: string }>>();
  for (const row of (codes.data ?? []) as RegistryCodeRow[]) {
    const pharmacyId = row.pharmacy_id?.trim();
    const distributorCode = row.distributor_code?.trim();
    const customerCode = row.customer_code?.trim();
    if (!pharmacyId || !distributorCode || !customerCode) continue;
    const list = codesByPharmacy.get(pharmacyId) ?? [];
    list.push({ customerCode, distributorCode });
    codesByPharmacy.set(pharmacyId, list);
  }

  const result: RegistryPharmacy[] = [];
  for (const row of (pharmacies.data ?? []) as RegistryPharmacyRow[]) {
    const id = row.id?.trim();
    const name = row.pharmacy_name?.trim();
    const phoenixPharmacyCode = row.phoenix_pharmacy_code?.trim();
    if (!id || !name || !phoenixPharmacyCode) continue;

    result.push({
      address: row.pharmacy_address?.trim() || null,
      areaCode: row.area_code?.trim() || null,
      brickId: row.brick_id?.trim() || null,
      codes: codesByPharmacy.get(id) ?? [],
      name,
      phoenixPharmacyCode,
      regionCode: row.region_code?.trim() || null,
    });
  }

  return result;
}

/**
 * Stamp the Phoenix registration onto the directory row it duplicates, and drop the duplicate.
 *
 * A registry hit and a directory hit carrying the SAME distributor AND the same customer code are
 * one entry in one distributor's own catalogue — that is identity by construction, not inference.
 * (The forbidden inference is the other one: a code SHARED BETWEEN distributors proves nothing,
 * because every distributor numbers from its own catalogue. This is the same distributor twice.)
 *
 * The directory row is what survives, because it is the one that carries sales history and whose
 * profile assembles fully — but it inherits `phoenixPharmacyCode`, so the screen can still say the
 * venue is registered. This runs BEFORE `collapseByPharmacy` and independently of it: the
 * distributor-listing path deliberately skips the collapse, and a code appearing twice in one
 * distributor's own list is a duplicate on any path.
 */
function foldRegistryIntoDirectory(
  directoryHits: PharmacySearchHit[],
  fromRegistry: PharmacySearchHit[],
): PharmacySearchHit[] {
  const byPair = new Map<string, PharmacySearchHit>();
  for (const hit of directoryHits) {
    if (hit.distributorCode && hit.customerCode) byPair.set(`${hit.distributorCode}:${hit.customerCode}`, hit);
  }

  const stamped = new Map<PharmacySearchHit, string>();
  const survivors: PharmacySearchHit[] = [];

  for (const hit of fromRegistry) {
    const pair = hit.distributorCode && hit.customerCode ? `${hit.distributorCode}:${hit.customerCode}` : null;
    const twin = pair ? byPair.get(pair) : undefined;
    if (twin && hit.phoenixPharmacyCode) {
      stamped.set(twin, hit.phoenixPharmacyCode);
      continue;
    }
    survivors.push(hit);
  }

  return [
    ...directoryHits.map((hit) => {
      const phoenixPharmacyCode = stamped.get(hit);
      return phoenixPharmacyCode ? { ...hit, phoenixPharmacyCode } : hit;
    }),
    ...survivors,
  ];
}

/**
 * Collapse the same physical pharmacy carried by several distributors into one hit, and count
 * them. A busy pharmacy appears under Overseas AND Ibn Sina with different codes; showing it
 * twice buries the other results. The surviving row keeps the first territory seen — they agree
 * in practice because both derive from the same brick table — and `distributorCount` tells the
 * reader to open it for the full code list.
 *
 * The registry joins the same collapse rather than getting one of its own: 40 of the 53 active
 * registered pharmacies (production, 2026-09-08) are also in the distributor directory at the
 * same brick, so without this the fourth branch would double three quarters of its own results.
 * A directory row wins that tie because it carries the sales history and its profile assembles
 * fully, but the survivor absorbs the address and the Phoenix code from whichever side has them —
 * the point of the collapse is one row that knows everything, not one row that knows most.
 */
function collapseByPharmacy(hits: PharmacySearchHit[]): PharmacySearchHit[] {
  const byKey = new Map<string, PharmacySearchHit>();
  const seenDistributors = new Map<string, Set<string>>();

  for (const hit of hits) {
    const normalized = normalizeArabicPharmacyName(hit.name);
    // Same name in two different bricks is genuinely two pharmacies (4 brick names are known to
    // repeat across areas), so the brick is part of the identity key, not just the name. It cuts
    // both ways for the registry: "الإسعاف" is registered once and sits in 20 separate bricks in
    // the directory, and merging those would report one pharmacy where there are twenty.
    const key = `${normalized}|${hit.territory.brickId ?? ""}`;

    const distributors = seenDistributors.get(key) ?? new Set<string>();
    if (hit.distributorCode) distributors.add(hit.distributorCode);
    seenDistributors.set(key, distributors);

    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, hit);
      continue;
    }

    // A directory row beats a registry row OUTRIGHT — it is the one with sales history behind it
    // and the one whose profile assembles fully. Only when both sides are the same kind does the
    // address decide, and it must not be allowed to promote a registry row over a directory one:
    // the survivor absorbs the address either way, so this choice is about which identity leads,
    // never about which facts are kept.
    const existingIsRegistry = existing.origin === "phoenix";
    const incomingIsRegistry = hit.origin === "phoenix";
    const preferIncoming =
      existingIsRegistry === incomingIsRegistry
        ? !existing.address && Boolean(hit.address)
        : existingIsRegistry;

    const winner = preferIncoming ? { ...hit, id: existing.id } : existing;
    byKey.set(key, {
      ...winner,
      address: winner.address ?? existing.address ?? hit.address,
      phoenixPharmacyCode: winner.phoenixPharmacyCode ?? existing.phoenixPharmacyCode ?? hit.phoenixPharmacyCode,
    });
  }

  return [...byKey.entries()].map(([key, hit]) => ({
    ...hit,
    // Not floored at 1: a venue registered in Phoenix that no distributor has a code for genuinely
    // has zero, and saying "1 distributor" beside a blank distributor name is a small lie the
    // reader has no way to check. Every directory row carries a distributor code (67,233 of
    // 67,233 active rows, production 2026-09-08), so this cannot read 0 for one of those.
    distributorCount: seenDistributors.get(key)?.size ?? 0,
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
export async function searchPharmacies(rawQuery: string, viewer: SourceMaskViewer): Promise<PharmacySearchResult> {
  const query = rawQuery.trim();
  const safe = sanitizeForOrFilter(query);

  if (safe.length < MIN_QUERY_LENGTH) {
    return { hits: [], isEmpty: true, matchedDistributorName: null, query, truncated: false };
  }

  const supabase = getSupabaseAdmin();
  const reference = visibleTerritoryReference(await getTerritoryReference(), viewer);

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
    visibleDistributorRows(
      supabase.from("source_of_sales_customer_map").select(CUSTOMER_MAP_COLUMNS).ilike("customer_name", like),
      viewer,
    )
      .limit(BRANCH_FETCH_LIMIT)
      .then(({ data, error }) => {
        if (error) throw new Error(`Pharmacy name search failed: ${error.message}`);
        return { kind: "name" as const, rows: (data ?? []) as CustomerMapRow[] };
      }),
  );

  if (looksLikeCode(safe)) {
    branches.push(
      visibleDistributorRows(
        supabase.from("source_of_sales_customer_map").select(CUSTOMER_MAP_COLUMNS).ilike("customer_code", `%${safe}%`),
        viewer,
      )
        .limit(BRANCH_FETCH_LIMIT)
        .then(({ data, error }) => {
          if (error) throw new Error(`Customer code search failed: ${error.message}`);
          return { kind: "customer_code" as const, rows: (data ?? []) as CustomerMapRow[] };
        }),
    );
  }

  if (matchedDistributor) {
    branches.push(
      visibleDistributorRows(
        supabase.from("source_of_sales_customer_map").select(CUSTOMER_MAP_COLUMNS).eq("distributor_code", matchedDistributor[0]),
        viewer,
      )
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
      visibleDistributorRows(
        supabase.from("source_of_sales_customer_map").select(CUSTOMER_MAP_COLUMNS).ilike("address", like),
        viewer,
      )
        .limit(BRANCH_FETCH_LIMIT)
        .then(({ data, error }) => {
          if (error) throw new Error(`Address search failed: ${error.message}`);
          return { kind: "address" as const, rows: (data ?? []) as CustomerMapRow[] };
        }),
    );
  }

  // The fourth branch. Read alongside the directory ones rather than after them: it is a
  // different table and answers a different half of the question, so making it wait would add its
  // latency to every search instead of hiding it behind the three that already run.
  const [settled, registry] = await Promise.all([Promise.all(branches), loadRegistryPharmacies(viewer)]);

  const seenRowKeys = new Set<string>();
  const directoryHits: PharmacySearchHit[] = [];
  for (const branch of settled) {
    for (const row of branch.rows) {
      const rowKey = `${row.distributor_code ?? ""}:${row.customer_code ?? ""}:${row.customer_name ?? ""}`;
      if (seenRowKeys.has(rowKey)) continue;
      seenRowKeys.add(rowKey);
      const hit = toHit(row, reference, branch.kind);
      if (hit) directoryHits.push(hit);
    }
  }

  const fromRegistry: PharmacySearchHit[] = [];
  for (const pharmacy of registry) {
    if (matchedDistributor) {
      // "Ibn Sina" means "show me Ibn Sina's pharmacies", and a registered venue Ibn Sina has a
      // code for is one of them. One carrying no code of theirs is not, however it is named.
      const carried = pharmacy.codes.filter((code) => code.distributorCode === matchedDistributor[0]);
      if (carried.length === 0) continue;
      fromRegistry.push(...registryHits({ ...pharmacy, codes: carried }, reference, "distributor"));
      continue;
    }

    const matchedOn = matchRegistryPharmacy(pharmacy, { normalized: normalizedQuery, raw: safe });
    if (matchedOn) fromRegistry.push(...registryHits(pharmacy, reference, matchedOn));
  }

  const merged = foldRegistryIntoDirectory(directoryHits, fromRegistry);
  const collapsed = matchedDistributor ? merged : collapseByPharmacy(merged);
  const ranked = rankHits(collapsed, normalizedQuery);

  return {
    hits: ranked.slice(0, PHARMACY_SEARCH_LIMIT),
    // A Phoenix-only hit counts. `isEmpty` is what makes the caller offer the Google lookup, and
    // spending a billed Places call to be told about a pharmacy we registered ourselves is the
    // exact thing that happened on 2026-09-08.
    isEmpty: ranked.length === 0,
    matchedDistributorName: matchedDistributor?.[1] ?? null,
    query,
    truncated: ranked.length > PHARMACY_SEARCH_LIMIT,
  };
}

/** Exported for the marketing-only fallback path and for tests. */
export const __testables = {
  collapseByPharmacy,
  foldRegistryIntoDirectory,
  looksLikeCode,
  matchRegistryPharmacy,
  rankHits,
  registryHits,
  sanitizeForOrFilter,
};
