/**
 * Everything Phoenix knows about ONE pharmacy, assembled into a single profile.
 *
 * This is the page's payload: identity, territory, every distributor's own code for it, what it
 * has bought, where it is, and who practises nearby. Read-only — nothing in this file writes.
 */

import { normalizeArabicPharmacyName } from "@/lib/pharmacy-master/pharmacy-matching";
import { getSupabaseAdmin } from "@/lib/supabase/server";

import { googleMapsUrlFor, resolvePharmacyCoordinates } from "./locate";
import { DEFAULT_RADIUS_KM, findKnownHospitals, findNearbyContacts, mergeHospitals } from "./nearby";
import { getTerritoryReference, resolveTerritory, type TerritoryReference } from "./reference";
import {
  EMPTY_TERRITORY,
  PHOENIX_VENUE_ID_PREFIX,
  type NearbyDoctor,
  type NearbyHospital,
  type PharmacyCoordinates,
  type PharmacyDistributorCode,
  type PharmacyProfile,
  type PharmacySalesPeriod,
  type PharmacyTerritory,
} from "./types";

/** Sales periods shown, newest first. A pharmacy with four years of history is unreadable whole. */
const MAX_SALES_PERIODS = 18;

export type PharmacyProfileRequest = {
  customerCode: string | null;
  distributorCode: string | null;
  /** Required when there is no code — the Google-discovered and marketing-only paths. */
  name: string | null;
  /**
   * A venue registered in Phoenix itself, by its own code (`DOP-000079`).
   *
   * Takes precedence over every other identifier here, because a venue usually has NO row in the
   * customer map: the distributor/customer pair cannot find it, and the name lookup would find a
   * different pharmacy that happens to share its name.
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

async function loadSiblingRows(name: string): Promise<CustomerMapRow[]> {
  const supabase = getSupabaseAdmin();
  // `ilike` with no wildcards is a case-insensitive exact match — it catches the same pharmacy
  // filed under different capitalisation by two distributors without dragging in every name that
  // merely contains this one.
  const { data, error } = await supabase
    .from("source_of_sales_customer_map")
    .select("distributor_code, customer_code, customer_name, address, brick_id, area_code, region_code")
    .ilike("customer_name", name)
    .limit(100);

  if (error) throw new Error(`Distributor code lookup failed: ${error.message}`);
  return (data ?? []) as CustomerMapRow[];
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
 * Where the pharmacy is and who is around it — the half of a profile that asks the same question
 * whichever table the pharmacy came from.
 *
 * Shared rather than copied: the venue path below asks it too, and two copies of "no check-in
 * within N km" would drift apart the first time one of them was reworded.
 */
async function loadSurroundings(input: {
  name: string;
  radiusKm: number;
  territory: PharmacyTerritory;
}): Promise<{
  coordinates: PharmacyCoordinates | null;
  hospitals: NearbyHospital[];
  nearbyDoctors: NearbyDoctor[];
  warnings: string[];
}> {
  const { name, radiusKm, territory } = input;
  const coordinates = await resolvePharmacyCoordinates({ brickId: territory.brickId, name });
  const centre = coordinates ? { latitude: coordinates.latitude, longitude: coordinates.longitude } : null;

  const [contacts, knownHospitals] = await Promise.all([
    centre ? findNearbyContacts(centre, radiusKm) : Promise.resolve({ doctors: [], hospitals: [] }),
    findKnownHospitals({ brickId: territory.brickId, centre, radiusKm }),
  ]);
  const nearbyDoctors = contacts.doctors;
  // CRM hospitals first: they are the only ones carrying a measured distance, and `mergeHospitals`
  // keeps whichever entry for a given name actually knows how far away it is.
  const hospitals = mergeHospitals(contacts.hospitals, knownHospitals);

  const warnings: string[] = [];
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

  return { coordinates, hospitals, nearbyDoctors, warnings };
}

/** ONE string literal — see the note on VENUE_COLUMNS in search.ts for why that matters. */
const VENUE_PROFILE_COLUMNS =
  "phoenix_pharmacy_code, pharmacy_name, pharmacy_address, brick_id, area_code, region_code, verification_status, codes:direct_order_pharmacy_distributor_codes(distributor_code, customer_code, mapped_brick_id, mapped_area_code, mapped_region_code)";

type VenueProfileRow = {
  area_code: string | null;
  brick_id: string | null;
  codes:
    | Array<{
        customer_code: string | null;
        distributor_code: string | null;
        mapped_area_code: string | null;
        mapped_brick_id: string | null;
        mapped_region_code: string | null;
      }>
    | null;
  pharmacy_address: string | null;
  pharmacy_name: string | null;
  phoenix_pharmacy_code: string | null;
  region_code: string | null;
  verification_status: string | null;
};

/**
 * The profile for a venue registered in Phoenix itself.
 *
 * Deliberately NOT routed through the customer-map path below, for one reason. That path widens
 * from the name — `loadSiblingRows` matches `customer_name` exactly but case-insensitively — to
 * pick up the same pharmacy filed by other distributors. For a venue that is unsafe: "الانسانية"
 * is FIVE different pharmacies in production, in Beheira, Cairo, Giza, Assiut and Sohag, so
 * widening by name would hang another pharmacy's codes, and its SALES, on this one.
 *
 * A venue's identity is the distributor codes it declares and nothing else. Where it declares
 * none, this says so rather than going looking — which is the common case, and exactly why the
 * venue can be absent from every distributor file and still be real.
 */
async function loadVenueProfile(input: { phoenixPharmacyCode: string; radiusKm: number }): Promise<PharmacyProfile> {
  const supabase = getSupabaseAdmin();
  const reference = await getTerritoryReference();

  const { data, error } = await supabase
    .from("direct_order_pharmacies")
    .select(VENUE_PROFILE_COLUMNS)
    .eq("phoenix_pharmacy_code", input.phoenixPharmacyCode)
    .maybeSingle();
  if (error) throw new Error(`Venue lookup failed: ${error.message}`);

  const row = (data ?? null) as VenueProfileRow | null;
  if (!row) throw new PharmacyNotFoundError(`venue ${input.phoenixPharmacyCode}`);

  const name = String(row.pharmacy_name ?? "").trim();
  const territory = resolveTerritory(reference, {
    areaCode: row.area_code,
    brickId: row.brick_id,
    regionCode: row.region_code,
  });

  const distributorCodes: PharmacyDistributorCode[] = (row.codes ?? [])
    .map((code) => {
      const distributorCode = String(code.distributor_code ?? "").trim();
      return {
        customerCode: String(code.customer_code ?? "").trim(),
        distributorCode,
        distributorName: reference.distributorNames.get(distributorCode) ?? distributorCode,
        fromReferenceList: false,
        // The code's own mapped territory where the customer map answered for it, the venue's
        // otherwise — the same coalesce phx_search_direct_order_customers applies.
        territory: resolveTerritory(reference, {
          areaCode: code.mapped_area_code ?? row.area_code,
          brickId: code.mapped_brick_id ?? row.brick_id,
          regionCode: code.mapped_region_code ?? row.region_code,
        }),
      };
    })
    .filter((entry) => entry.distributorCode.length > 0 && entry.customerCode.length > 0)
    .sort((a, b) => (a.distributorName ?? "").localeCompare(b.distributorName ?? ""));

  const [sales, surroundings] = await Promise.all([
    loadSales(
      distributorCodes.map((entry) => ({ clientCode: entry.customerCode, distributorCode: entry.distributorCode })),
    ),
    loadSurroundings({ name, radiusKm: input.radiusKm, territory }),
  ]);
  const centre = surroundings.coordinates
    ? { latitude: surroundings.coordinates.latitude, longitude: surroundings.coordinates.longitude }
    : null;

  const warnings: string[] = [];
  if (distributorCodes.length === 0) {
    warnings.push(
      "This venue carries no distributor code, so nothing in the customer directory can be attributed to it. The sales section below is empty for that reason, not because it has never sold.",
    );
  }

  const verificationStatus = String(row.verification_status ?? "").trim();
  if (verificationStatus && verificationStatus !== "verified") {
    warnings.push(
      `Registered by hand at the direct-order desk and still "${verificationStatus.replace(/_/g, " ")}" — nobody has yet confirmed that its distributor codes are real.`,
    );
  }

  warnings.push(...surroundings.warnings);

  if (sales.length === 0) {
    warnings.push("No sales rows for this venue in the customer directory.");
  }

  return {
    address: row.pharmacy_address?.trim() || null,
    coordinates: surroundings.coordinates,
    distributorCodes,
    googleAddress: null,
    googleMapsUrl: googleMapsUrlFor(centre, name),
    hospitals: surroundings.hospitals,
    id: `${PHOENIX_VENUE_ID_PREFIX}${String(row.phoenix_pharmacy_code ?? "").trim()}`,
    name,
    nearbyDoctors: surroundings.nearbyDoctors,
    origin: "phoenix",
    sales,
    territory: territory.brickId || territory.areaCode ? territory : EMPTY_TERRITORY,
    territoryDerivedFromKm: null,
    warnings,
  };
}

/**
 * Build the full profile. Throws `PharmacyNotFoundError` only when the identifier resolves to
 * nothing at all — a pharmacy with no sales, no coordinates and no nearby doctors still returns a
 * profile, with `warnings` explaining each empty section. An empty section that looks like a zero
 * is the failure mode this guards against.
 */
export async function loadPharmacyProfile(request: PharmacyProfileRequest): Promise<PharmacyProfile> {
  // Answered first and returned whole: a venue is identified by its own code and must not be
  // widened by name. See loadVenueProfile.
  const phoenixPharmacyCode = request.phoenixPharmacyCode?.trim();
  if (phoenixPharmacyCode) {
    return await loadVenueProfile({ phoenixPharmacyCode, radiusKm: request.radiusKm ?? DEFAULT_RADIUS_KM });
  }

  const supabase = getSupabaseAdmin();
  const reference = await getTerritoryReference();
  const radiusKm = request.radiusKm ?? DEFAULT_RADIUS_KM;
  const warnings: string[] = [];

  let baseRow: CustomerMapRow | null = null;

  if (request.distributorCode && request.customerCode) {
    const { data, error } = await supabase
      .from("source_of_sales_customer_map")
      .select("distributor_code, customer_code, customer_name, address, brick_id, area_code, region_code")
      .eq("distributor_code", request.distributorCode)
      .eq("customer_code", request.customerCode)
      .limit(1);

    if (error) throw new Error(`Pharmacy lookup failed: ${error.message}`);
    baseRow = (data?.[0] as CustomerMapRow | undefined) ?? null;
  }

  if (!baseRow && request.name) {
    const rows = await loadSiblingRows(request.name);
    baseRow = rows[0] ?? null;
  }

  if (!baseRow) {
    throw new PharmacyNotFoundError(
      request.customerCode
        ? `code ${request.customerCode}`
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

  const siblings = await loadSiblingRows(name);
  const distributorCodes: PharmacyDistributorCode[] = [];
  const seenPairs = new Set<string>();

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

  const referenceCodes = await loadReferenceCodes(
    distributorCodes.map((entry) => entry.customerCode).slice(0, 20),
    reference,
  );
  for (const entry of referenceCodes) {
    const pairKey = `${entry.distributorCode}:${entry.customerCode}`;
    if (seenPairs.has(pairKey)) continue;
    seenPairs.add(pairKey);
    distributorCodes.push(entry);
  }

  const [sales, surroundings] = await Promise.all([
    loadSales(
      distributorCodes
        .filter((entry) => !entry.fromReferenceList)
        .map((entry) => ({ clientCode: entry.customerCode, distributorCode: entry.distributorCode })),
    ),
    loadSurroundings({ name, radiusKm, territory }),
  ]);
  const { coordinates, hospitals, nearbyDoctors } = surroundings;
  const centre = coordinates ? { latitude: coordinates.latitude, longitude: coordinates.longitude } : null;
  warnings.push(...surroundings.warnings);

  if (sales.length === 0) {
    warnings.push("No sales rows for this pharmacy in the customer directory.");
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
    id: `${baseRow.distributor_code ?? ""}:${baseRow.customer_code ?? ""}`,
    name,
    nearbyDoctors,
    origin: "database",
    sales,
    territory: territory.brickId || territory.areaCode ? territory : EMPTY_TERRITORY,
    territoryDerivedFromKm: null,
    warnings,
  };
}
