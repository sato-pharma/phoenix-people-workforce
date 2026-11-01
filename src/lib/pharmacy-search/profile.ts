/**
 * Everything Phoenix knows about ONE pharmacy, assembled into a single profile.
 *
 * This is the page's payload: identity, territory, every distributor's own code for it, what it
 * has bought, where it is, and who practises nearby. Read-only — nothing in this file writes.
 */

import { normalizeArabicPharmacyName } from "@/lib/pharmacy-master/pharmacy-matching";
import type { SourceMaskViewer } from "@/lib/sales/closing-source-mask";
import { getSupabaseAdmin } from "@/lib/supabase/server";

import { googleMapsUrlFor, resolvePharmacyCoordinates } from "./locate";
import { DEFAULT_RADIUS_KM, findKnownHospitals, findNearbyContacts, mergeHospitals } from "./nearby";
import { getTerritoryReference, resolveTerritory, type TerritoryReference } from "./reference";
import { visibleDistributorRows, visibleTerritoryReference, withoutHiddenReferenceCodes } from "./source-visibility";
import {
  EMPTY_TERRITORY,
  PHOENIX_PROFILE_ID_PREFIX,
  type PharmacyDistributorCode,
  type PharmacyProfile,
  type PharmacySalesPeriod,
} from "./types";

/** Sales periods shown, newest first. A pharmacy with four years of history is unreadable whole. */
const MAX_SALES_PERIODS = 18;

export type PharmacyProfileRequest = {
  customerCode: string | null;
  distributorCode: string | null;
  /** Required when there is no code — the Google-discovered and marketing-only paths. */
  name: string | null;
  /**
   * `DOP-000079`, when the row the reader clicked came from `direct_order_pharmacies`. Carried
   * separately from the codes because a registered venue may have none: 6 of the 53 active ones
   * (production, 2026-09-08) have no distributor code at all, and they are precisely the ones the
   * distributor directory cannot answer for.
   */
  phoenixPharmacyCode?: string | null;
  radiusKm?: number;
};

export class PharmacyNotFoundError extends Error {
  constructor(label: string) {
    super(`No pharmacy found for ${label}.`);
    this.name = "PharmacyNotFoundError";
  }
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

async function loadSiblingRows(name: string, viewer: SourceMaskViewer): Promise<CustomerMapRow[]> {
  const supabase = getSupabaseAdmin();
  // `ilike` with no wildcards is a case-insensitive exact match — it catches the same pharmacy
  // filed under different capitalisation by two distributors without dragging in every name that
  // merely contains this one.
  const { data, error } = await visibleDistributorRows(
    supabase
      .from("source_of_sales_customer_map")
      .select("distributor_code, customer_code, customer_name, address, brick_id, area_code, region_code")
      .ilike("customer_name", name),
    viewer,
  ).limit(100);

  if (error) throw new Error(`Distributor code lookup failed: ${error.message}`);
  return (data ?? []) as CustomerMapRow[];
}

type RegistryBase = {
  /** The venue shaped as a mapping row, so everything downstream reads one thing. */
  row: CustomerMapRow;
  /** Codes the registry itself holds. Authoritative for this venue in a way a sibling is not. */
  codes: Array<{ customerCode: string; distributorCode: string }>;
  phoenixPharmacyCode: string;
};

/**
 * A pharmacy registered inside Phoenix, by its `DOP-` code.
 *
 * This is what stops a search result being unopenable. The registry and the distributor directory
 * are disjoint tables, so a venue someone registered by hand has no row in
 * `source_of_sales_customer_map` at all — and every lookup above it would answer
 * `PharmacyNotFoundError`, which on screen reads as "this pharmacy does not exist" about a
 * pharmacy the search box just listed.
 */
async function loadRegistryBase(phoenixPharmacyCode: string, viewer: SourceMaskViewer): Promise<RegistryBase | null> {
  const supabase = getSupabaseAdmin();

  const { data, error } = await supabase
    .from("direct_order_pharmacies")
    .select("id, phoenix_pharmacy_code, pharmacy_name, pharmacy_address, brick_id, area_code, region_code")
    .eq("phoenix_pharmacy_code", phoenixPharmacyCode)
    .eq("active", true)
    .limit(1);

  if (error) throw new Error(`Phoenix pharmacy registry lookup failed: ${error.message}`);
  const row = data?.[0];
  if (!row) return null;

  const id = String(row.id ?? "").trim();
  const name = String(row.pharmacy_name ?? "").trim();
  const code = String(row.phoenix_pharmacy_code ?? "").trim();
  if (!id || !name || !code) return null;

  const { data: codeRows, error: codeError } = await visibleDistributorRows(
    supabase.from("direct_order_pharmacy_distributor_codes").select("distributor_code, customer_code").eq("pharmacy_id", id),
    viewer,
  ).limit(50);

  if (codeError) throw new Error(`Phoenix pharmacy code lookup failed: ${codeError.message}`);

  const codes: Array<{ customerCode: string; distributorCode: string }> = [];
  for (const codeRow of codeRows ?? []) {
    const distributorCode = String(codeRow.distributor_code ?? "").trim();
    const customerCode = String(codeRow.customer_code ?? "").trim();
    if (distributorCode && customerCode) codes.push({ customerCode, distributorCode });
  }

  return {
    codes,
    phoenixPharmacyCode: code,
    row: {
      address: String(row.pharmacy_address ?? "").trim() || null,
      area_code: String(row.area_code ?? "").trim() || null,
      brick_id: String(row.brick_id ?? "").trim() || null,
      customer_code: codes[0]?.customerCode ?? null,
      customer_name: name,
      distributor_code: codes[0]?.distributorCode ?? null,
      region_code: String(row.region_code ?? "").trim() || null,
    },
  };
}

/**
 * Which name-matched directory rows are the SAME pharmacy as this registry venue?
 *
 * `loadSiblingRows` answers "same name", and for a directory-backed profile that is the whole
 * question — the rows all describe one customer under several distributors. For a REGISTRY venue
 * it is not: a sibling is a different pharmacy that happens to be spelt the same, and this data
 * has plenty (10 of the 54 active venues have an exact-name twin in another brick). Left
 * unfiltered, those codes reach `loadSales` and another pharmacy's sales are printed as this
 * venue's — the failure mode being that the number looks perfectly ordinary.
 *
 * The test is the one the search collapse already uses: same name AND same brick is one pharmacy;
 * a different brick is a different pharmacy. Pure, so it can be exercised without a database.
 */
export function sameVenueSiblings<T extends { brick_id: string | null }>(
  siblings: T[],
  registry: { row: { brick_id: string | null } } | null,
): T[] {
  if (!registry) return siblings;
  const venueBrick = registry.row.brick_id?.trim() || null;
  // No brick on the venue means nothing to agree with, so nothing can be proven to be the same
  // pharmacy. Widening on name alone there is exactly the guess this exists to refuse.
  if (!venueBrick) return [];
  return siblings.filter((row) => (row.brick_id?.trim() || null) === venueBrick);
}

async function loadReferenceCodes(
  codes: string[],
  reference: TerritoryReference,
): Promise<PharmacyDistributorCode[]> {
  if (codes.length === 0) return [];
  const supabase = getSupabaseAdmin();

  // The imported distributor reference list (50,935 rows) is a point-in-time snapshot, not live
  // truth — it is worth showing because it often carries a code no sales file has, but it is
  // flagged `fromReferenceList` so nobody mistakes it for a confirmed mapping.
  const { data, error } = await supabase
    .from("marketing_pharmacy_code_references")
    .select("raw_pharmacy_code, normalized_pharmacy_code, raw_distributor_name, raw_region, raw_area")
    .in("normalized_pharmacy_code", codes)
    .limit(50);

  if (error) throw new Error(`Distributor reference lookup failed: ${error.message}`);

  return (data ?? []).map((row) => ({
    customerCode: String(row.raw_pharmacy_code ?? "").trim(),
    distributorCode: String(row.raw_distributor_name ?? "").trim(),
    distributorName: String(row.raw_distributor_name ?? "").trim() || null,
    fromReferenceList: true,
    territory: resolveTerritory(reference, { areaCode: null, brickId: null, regionCode: null }),
  })).filter((entry) => entry.customerCode.length > 0);
}

async function loadSales(pairs: Array<{ clientCode: string; distributorCode: string }>): Promise<PharmacySalesPeriod[]> {
  if (pairs.length === 0) return [];
  const supabase = getSupabaseAdmin();

  const clientCodes = [...new Set(pairs.map((pair) => pair.clientCode))];
  const distributorCodes = [...new Set(pairs.map((pair) => pair.distributorCode))];

  const { data, error } = await supabase
    .from("source_of_sales_customer_directory_rollup")
    .select("period, distributor_code, client_code, product_code, effective_units")
    .in("client_code", clientCodes)
    .in("distributor_code", distributorCodes)
    .limit(4000);

  if (error) throw new Error(`Sales history lookup failed: ${error.message}`);

  const allowed = new Set(pairs.map((pair) => `${pair.distributorCode}:${pair.clientCode}`));
  const byPeriod = new Map<string, { products: Set<string>; units: number }>();

  for (const row of data ?? []) {
    const key = `${String(row.distributor_code ?? "")}:${String(row.client_code ?? "")}`;
    if (!allowed.has(key)) continue;
    const period = String(row.period ?? "").trim();
    if (!period) continue;

    const entry = byPeriod.get(period) ?? { products: new Set<string>(), units: 0 };
    const units = Number(row.effective_units ?? 0);
    if (Number.isFinite(units)) entry.units += units;
    const productCode = String(row.product_code ?? "").trim();
    if (productCode) entry.products.add(productCode);
    byPeriod.set(period, entry);
  }

  return [...byPeriod.entries()]
    .map(([period, entry]) => ({
      period,
      productCount: entry.products.size,
      units: Math.round(entry.units * 100) / 100,
    }))
    .sort((a, b) => b.period.localeCompare(a.period))
    .slice(0, MAX_SALES_PERIODS);
}

/**
 * Build the full profile. Throws `PharmacyNotFoundError` only when the identifier resolves to
 * nothing at all — a pharmacy with no sales, no coordinates and no nearby doctors still returns a
 * profile, with `warnings` explaining each empty section. An empty section that looks like a zero
 * is the failure mode this guards against.
 */
export async function loadPharmacyProfile(
  request: PharmacyProfileRequest,
  viewer: SourceMaskViewer,
): Promise<PharmacyProfile> {
  const supabase = getSupabaseAdmin();
  const fullReference = await getTerritoryReference();
  const reference = visibleTerritoryReference(fullReference, viewer);
  const radiusKm = request.radiusKm ?? DEFAULT_RADIUS_KM;
  const warnings: string[] = [];

  let baseRow: CustomerMapRow | null = null;

  if (request.distributorCode && request.customerCode) {
    const { data, error } = await visibleDistributorRows(
      supabase
        .from("source_of_sales_customer_map")
        .select("distributor_code, customer_code, customer_name, address, brick_id, area_code, region_code")
        .eq("distributor_code", request.distributorCode)
        .eq("customer_code", request.customerCode),
      viewer,
    ).limit(1);

    if (error) throw new Error(`Pharmacy lookup failed: ${error.message}`);
    baseRow = (data?.[0] as CustomerMapRow | undefined) ?? null;
  }

  // BEFORE the bare-name fallback, and after the code lookup above. A caller naming a Phoenix
  // venue is naming THE subject; `loadSiblingRows` matches `customer_name` exactly but only
  // case-insensitively, and exact-name duplicates are real here — 10 of the 54 active venues have
  // a same-named directory pharmacy in a DIFFERENT brick (production, 2026-09-08). Letting the
  // name win substituted that other pharmacy wholesale: DOP-000038 "المنصورية" (brick B160-6)
  // opened as brick B193-6, labelled `database`, carrying three codes and two sales periods that
  // were not its own. The code lookup still runs first, so a venue the directory can answer for
  // keeps resolving to its directory row — that is the better base and the search collapses to it
  // for the same reason.
  let registry: RegistryBase | null = null;
  if (!baseRow && request.phoenixPharmacyCode) {
    registry = await loadRegistryBase(request.phoenixPharmacyCode, viewer);
    baseRow = registry?.row ?? null;
  }

  if (!baseRow && request.name) {
    const rows = await loadSiblingRows(request.name, viewer);
    baseRow = rows[0] ?? null;
  }

  if (!baseRow) {
    throw new PharmacyNotFoundError(
      request.customerCode
        ? `code ${request.customerCode}`
        : request.phoenixPharmacyCode
          ? `Phoenix code ${request.phoenixPharmacyCode}`
          : request.name
            ? `"${request.name}"`
            : "the requested pharmacy",
    );
  }

  const name = String(baseRow.customer_name ?? "").trim();
  const normalizedName = normalizeArabicPharmacyName(name);
  const territory = resolveTerritory(reference, {
    areaCode: baseRow.area_code,
    brickId: baseRow.brick_id,
    regionCode: baseRow.region_code,
  });

  const siblings = sameVenueSiblings(await loadSiblingRows(name, viewer), registry);
  const distributorCodes: PharmacyDistributorCode[] = [];
  const seenPairs = new Set<string>();

  // The registry's own codes go in first, and they are not `fromReferenceList`: someone recorded
  // them against this specific venue in Phoenix. A name-matched sibling row is a weaker claim —
  // it is another pharmacy that happens to be spelt the same — so it must not displace one.
  for (const code of registry?.codes ?? []) {
    const pairKey = `${code.distributorCode}:${code.customerCode}`;
    if (seenPairs.has(pairKey)) continue;
    seenPairs.add(pairKey);
    distributorCodes.push({
      customerCode: code.customerCode,
      distributorCode: code.distributorCode,
      distributorName: reference.distributorNames.get(code.distributorCode) ?? code.distributorCode,
      fromReferenceList: false,
      territory,
    });
  }

  for (const row of siblings) {
    if (normalizeArabicPharmacyName(row.customer_name) !== normalizedName) continue;
    const distributorCode = row.distributor_code?.trim();
    const customerCode = row.customer_code?.trim();
    if (!distributorCode || !customerCode) continue;
    const pairKey = `${distributorCode}:${customerCode}`;
    if (seenPairs.has(pairKey)) continue;
    seenPairs.add(pairKey);

    distributorCodes.push({
      customerCode,
      distributorCode,
      distributorName: reference.distributorNames.get(distributorCode) ?? distributorCode,
      fromReferenceList: false,
      territory: resolveTerritory(reference, {
        areaCode: row.area_code,
        brickId: row.brick_id,
        regionCode: row.region_code,
      }),
    });
  }

  const referenceCodes = withoutHiddenReferenceCodes(
    await loadReferenceCodes(distributorCodes.map((entry) => entry.customerCode).slice(0, 20), reference),
    fullReference,
    viewer,
  );
  for (const entry of referenceCodes) {
    const pairKey = `${entry.distributorCode}:${entry.customerCode}`;
    if (seenPairs.has(pairKey)) continue;
    seenPairs.add(pairKey);
    distributorCodes.push(entry);
  }

  const [sales, coordinates] = await Promise.all([
    loadSales(
      distributorCodes
        .filter((entry) => !entry.fromReferenceList)
        .map((entry) => ({ clientCode: entry.customerCode, distributorCode: entry.distributorCode })),
    ),
    resolvePharmacyCoordinates({ brickId: territory.brickId, name }),
  ]);

  const centre = coordinates ? { latitude: coordinates.latitude, longitude: coordinates.longitude } : null;
  const [contacts, knownHospitals] = await Promise.all([
    centre ? findNearbyContacts(centre, radiusKm) : Promise.resolve({ doctors: [], hospitals: [] }),
    findKnownHospitals({ brickId: territory.brickId, centre, radiusKm, viewer }),
  ]);
  const nearbyDoctors = contacts.doctors;
  // CRM hospitals first: they are the only ones carrying a measured distance, and `mergeHospitals`
  // keeps whichever entry for a given name actually knows how far away it is.
  const hospitals = mergeHospitals(contacts.hospitals, knownHospitals);

  if (!coordinates) {
    warnings.push(
      "No coordinates for this pharmacy — no rep has captured it, its address was never geocoded, and its brick has no centroid. Nearby doctors cannot be listed without a point.",
    );
  } else if (coordinates.source === "brick_centroid") {
    warnings.push(
      `Location is the centre of brick ${territory.brickName ?? territory.brickId ?? "unknown"}, not the pharmacy itself. Distances below are from that centre.`,
    );
  }

  if (centre && nearbyDoctors.length === 0) {
    warnings.push(
      `No rep check-in within ${radiusKm} km. Check-ins are a partial feed — this means no visit was recorded here, not that no doctor practises nearby.`,
    );
  }

  if (sales.length === 0) {
    warnings.push("No sales rows for this pharmacy in the customer directory.");
  }

  if (registry) {
    warnings.push(
      `Registered in Phoenix as ${registry.phoenixPharmacyCode}, not loaded from a distributor file. `
        + (registry.codes.length === 0
          ? "No distributor has a code for it yet, so it has no sales history to read."
          : "Its territory is the one recorded when the venue was registered."),
    );
  }

  return {
    address: baseRow.address?.trim() || null,
    coordinates,
    distributorCodes: distributorCodes.sort((a, b) => {
      if (a.fromReferenceList !== b.fromReferenceList) return a.fromReferenceList ? 1 : -1;
      return (a.distributorName ?? "").localeCompare(b.distributorName ?? "");
    }),
    googleAddress: null,
    googleMapsUrl: googleMapsUrlFor(centre, name),
    hospitals,
    id: registry
      ? `${PHOENIX_PROFILE_ID_PREFIX}${registry.phoenixPharmacyCode}`
      : `${baseRow.distributor_code ?? ""}:${baseRow.customer_code ?? ""}`,
    name,
    nearbyDoctors,
    // `saveDiscoveredPharmacy` refuses anything that is not "google", and the Save button only
    // renders for one — so a registered venue is correctly unsaveable here. It is already saved.
    origin: registry ? "phoenix" : "database",
    sales,
    territory: territory.brickId || territory.areaCode ? territory : EMPTY_TERRITORY,
    territoryDerivedFromKm: null,
    warnings,
  };
}
