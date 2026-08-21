/**
 * Pharmacy Search — one search box over every pharmacy record Phoenix holds, with a Google
 * fallback for the ones it does not.
 *
 * The shape of the answer is deliberately the same whether a row came from our own tables or
 * from Google: the caller renders one profile either way, and `origin` is what tells the reader
 * which half of the world it came from. Nothing here writes; see `save.ts` for the one path
 * that does, and only ever after a human presses the button.
 */

/** Where a fact came from. Rendered on screen — never collapse these into one another. */
export type PharmacySearchOrigin =
  /** A real row in `source_of_sales_customer_map` — a distributor sells to this pharmacy. */
  | "database"
  /** A row in `marketing_pharmacies` — captured by a rep, may not be in any distributor file. */
  | "marketing"
  /** Found on Google Places just now. NOT in Phoenix. Never treat as an authority. */
  | "google";

export type PharmacySearchMatchKind =
  | "customer_code"
  | "distributor_code"
  | "name"
  | "address"
  | "distributor";

export type PharmacyTerritory = {
  areaCode: string | null;
  areaName: string | null;
  blockCode: string | null;
  brickId: string | null;
  brickName: string | null;
  regionCode: string | null;
  regionName: string | null;
};

/** One hit in the results list. Deliberately light — the heavy joins happen in `profile.ts`. */
export type PharmacySearchHit = {
  address: string | null;
  /** How many distributors carry this same pharmacy name. 1 unless it is stocked broadly. */
  distributorCount: number;
  distributorCode: string | null;
  distributorName: string | null;
  customerCode: string | null;
  /** Stable key for the row — `${distributorCode}:${customerCode}` for database hits. */
  id: string;
  matchedOn: PharmacySearchMatchKind;
  name: string;
  origin: PharmacySearchOrigin;
  territory: PharmacyTerritory;
};

export type PharmacyDistributorCode = {
  customerCode: string;
  distributorCode: string;
  distributorName: string | null;
  /** Present when the code came from the imported distributor reference list, not the sales file. */
  fromReferenceList: boolean;
  territory: PharmacyTerritory;
};

export type PharmacySalesPeriod = {
  period: string;
  productCount: number;
  units: number;
};

export type NearbyDoctor = {
  /** Straight-line km from the pharmacy. Not driving distance. */
  distanceKm: number;
  /** Most recent check-in address for the doctor — a human-readable "where". */
  lastSeenAddress: string | null;
  name: string;
  speciality: string | null;
  visits: number;
};

export type NearbyHospital = {
  address: string | null;
  distanceKm: number | null;
  name: string;
  /** "database" when it is one of the 285 hospital customers we already sell to. */
  origin: Extract<PharmacySearchOrigin, "database" | "google">;
  /**
   * How we know where it is, which is what makes `distanceKm` readable:
   * - `checkin` — a rep checked in there; a real measured distance.
   * - `geocoded` — its address was geocoded into `geo_locations`; a real distance.
   * - `same_brick` — a hospital CUSTOMER in this brick with no coordinates anywhere.
   *   `distanceKm` is null and must stay null; "in the same brick" is the whole claim.
   * - `google` — Google Places, only when the reader asked for it.
   */
  proximity: "checkin" | "geocoded" | "google" | "same_brick";
  /** CRM speciality that identified it as a hospital ("Hospital", "University Hospital", …). */
  speciality: string | null;
};

export type PharmacyCoordinates = {
  latitude: number;
  longitude: number;
  /** How the point was obtained, so the reader can judge it. */
  source: "marketing_capture" | "geocode_cache" | "google_lookup" | "brick_centroid";
};

/** The full answer for ONE pharmacy — everything the search engine knows or could find. */
export type PharmacyProfile = {
  address: string | null;
  coordinates: PharmacyCoordinates | null;
  /** Every distributor that carries this pharmacy, with its own code for it. */
  distributorCodes: PharmacyDistributorCode[];
  /** Empty when nothing is within the radius — never a silent zero, the UI says so. */
  hospitals: NearbyHospital[];
  id: string;
  /** Google's own formatted address, when the profile was enriched. */
  googleAddress: string | null;
  googleMapsUrl: string | null;
  name: string;
  nearbyDoctors: NearbyDoctor[];
  origin: PharmacySearchOrigin;
  /** Recent sales periods, newest first. Empty for a Google-only pharmacy. */
  sales: PharmacySalesPeriod[];
  territory: PharmacyTerritory;
  /**
   * Set when the territory was DERIVED from coordinates rather than read from a mapping row —
   * i.e. we snapped the point to the nearest brick centroid. The UI must label it as a guess.
   */
  territoryDerivedFromKm: number | null;
  warnings: string[];
};

export const EMPTY_TERRITORY: PharmacyTerritory = {
  areaCode: null,
  areaName: null,
  blockCode: null,
  brickId: null,
  brickName: null,
  regionCode: null,
  regionName: null,
};
