import { resolveGovernorate } from "@/lib/geo/egypt-locations";
import type { PharmacyGeo } from "@/lib/sales/normalizer/pharmacy-geocode";
import type { SalesBrickReference } from "@/lib/sales/monthly-distributor-import";

// Objective confidence for an AI/propagated brick suggestion, from real geography instead of the
// LLM's self-reported score. Pure — no I/O. Callers geocode the pharmacy (cache-first via
// pharmacy-geocode.ts) and load brick centroids (brick-centroids.ts), then score here.

// English governorate names as returned by Google Geocoding (language=en, " Governorate"
// suffix stripped), mapped to Phoenix region codes.
export const GOVERNORATE_TO_REGION: Record<string, string> = {
  // Cairo
  cairo: "CA",
  // Giza region (includes Fayoum and Beni Suef in Phoenix territory scope)
  giza: "GZ",
  fayoum: "GZ",
  faiyum: "GZ",
  "beni suef": "GZ",
  // Upper Egypt
  minia: "UE",
  minya: "UE",
  asyut: "UE",
  assiut: "UE",
  sohag: "UE",
  qena: "UE",
  luxor: "UE",
  // Alexandria + Beheira
  alexandria: "AB",
  beheira: "AB",
  matrouh: "AB",
  // Delta (1): Qalubeya, Menoufia, Gharbia, Kafr El Sheikh
  qalyubia: "D1",
  monufia: "D1",
  menofia: "D1",
  gharbia: "D1",
  "kafr el sheikh": "D1",
  // Delta (2): Dakahlia, Damietta, Port Said
  dakahlia: "D2",
  damietta: "D2",
  "port said": "D2",
  // Delta (3) unambiguous cases: Suez and Ismailia are exclusively D3
  suez: "D3",
  ismailia: "D3",
  // Sharkia is ambiguous (bricks split between D2 and D3 after the carve-out)
  // — handled by AMBIGUOUS_GOVERNORATES below
  // Others / remote
  "south sinai": "OT",
  "north sinai": "OT",
  "red sea": "OT",
  "new valley": "OT",
  aswan: "OT",
};

// Sharkia governorate bricks were carved between D2 and D3; governorate alone cannot resolve
// which sub-region a brick belongs to.
export const AMBIGUOUS_GOVERNORATES = new Set(["sharqia", "sharkia", "ash sharqiyah"]);

// ── Canonical governorate → region ───────────────────────────────────────────
// GOVERNORATE_TO_REGION above is keyed on RAW geocoder output and is matched by exact
// lowercase string. That silently fails on the shapes providers actually return —
// "Al-Sharqia", "Kafr El-Sheikh", "Marsa Matrouh", "The New Valley", and Arabic
// ("محافظة الدقهلية") — because none of them equal a key. A brick or pharmacy in one of
// those governorates then reads as "unknown governorate" and its (correct) coordinate is
// rejected. Both maps are kept: the raw one for backward compatibility, this one keyed on
// the canonical names `resolveGovernorate` returns.
//
// INPUT CONTRACT: pass a governorate-level field (Google's administrative_area_level_1,
// LocationIQ's `state`), NOT a full free-text address. `resolveGovernorate` also recognises
// town names, so a whole address could resolve via a town and mask a genuine mismatch.
const CANONICAL_GOVERNORATE_TO_REGION: Record<string, string> = {
  Cairo: "CA",
  Giza: "GZ",
  Fayoum: "GZ",
  "Beni Suef": "GZ",
  Minya: "UE",
  Assiut: "UE",
  Sohag: "UE",
  Qena: "UE",
  Luxor: "UE",
  Alexandria: "AB",
  Beheira: "AB",
  Matrouh: "AB",
  Qalyubia: "D1",
  Menoufia: "D1",
  Gharbia: "D1",
  "Kafr El-Sheikh": "D1",
  Dakahlia: "D2",
  Damietta: "D2",
  "Port Said": "D2",
  Suez: "D3",
  Ismailia: "D3",
  "South Sinai": "OT",
  "North Sinai": "OT",
  "Red Sea": "OT",
  "New Valley": "OT",
  Aswan: "OT",
};

// Canonical form of AMBIGUOUS_GOVERNORATES — `resolveGovernorate` folds every Sharkia
// spelling to this single label.
const AMBIGUOUS_CANONICAL_GOVERNORATES = new Set(["Sharqia"]);

export type GovernorateRegionMatch = {
  /** Canonical governorate name, or null when nothing was confidently recognised. */
  canonical: string | null;
  /** Phoenix region code. Null when unrecognised OR ambiguous — check `ambiguous`. */
  regionCode: string | null;
  /** Sharkia: split D2/D3, so governorate alone cannot decide the region. */
  ambiguous: boolean;
};

/**
 * Resolve any governorate spelling (English, Arabic, "Al-"/"El-" prefixed, hyphenated) to a
 * Phoenix region code. This is the single entry point for governorate→region — never index
 * GOVERNORATE_TO_REGION directly, that is what caused the rejected-coordinate bug.
 */
export function resolveGovernorateRegion(raw: string | null | undefined): GovernorateRegionMatch {
  const canonical = resolveGovernorate(raw);
  if (!canonical) return { ambiguous: false, canonical: null, regionCode: null };
  if (AMBIGUOUS_CANONICAL_GOVERNORATES.has(canonical)) {
    return { ambiguous: true, canonical, regionCode: null };
  }
  return { ambiguous: false, canonical, regionCode: CANONICAL_GOVERNORATE_TO_REGION[canonical] ?? null };
}

export type BrickCentroid = {
  lat: number;
  lng: number;
  governorate: string | null;
  markaz: string | null;
  // 'success' = passed the region sanity gate; anything else must never drive distance tiers.
  status: string;
  // How the pin was obtained (geocode_provider). The field-GPS pass reads it so a weaker source
  // never replaces a better pin.
  provider?: string | null;
};

export type GeoSignals = {
  distanceKm: number | null;
  markazMatch: boolean;
  governorateMatch: boolean;
  geocoded: boolean;
};

export type GeoScore = { confidence: number; signals: GeoSignals };

// Confidence used when no Google server key is configured — the caller short-circuits with this
// instead of scoring (a scorer can't tell "no key" from "no result").
export const NO_KEY_CONFIDENCE = 40;

export function haversineKm(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(s));
}

// Google's admin_area_level_2 comes as "Markaz Talkha" / "Qesm El Mansoura" — strip the
// administrative prefixes and articles so the same markaz compares equal.
export function normalizeMarkaz(value: string | null | undefined): string {
  return String(value ?? "")
    .toLowerCase()
    .replace(/\b(markaz|qism|qesm|kism)\b/g, " ")
    .replace(/\b(el|al|ash|as)[\s-]+/g, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

// Tier ladder, first match wins:
//   not geocoded → 25 | distance<5km → 95 | distance<15km → 85 | markaz equal → 80
//   | governorate→region match → 70 | Sharkia+D2/D3 → 58 | region mismatch → 12 (>50km → 10)
//   | governorate unknown → 35
export function scoreCustomerBrick(
  pharmacy: PharmacyGeo | null,
  brick: SalesBrickReference,
  centroid: BrickCentroid | undefined,
): GeoScore {
  const signals: GeoSignals = { distanceKm: null, geocoded: false, governorateMatch: false, markazMatch: false };

  if (!pharmacy) return { confidence: 25, signals };
  signals.geocoded = true;

  const centroidUsable = centroid != null && centroid.status === "success";
  if (centroidUsable) {
    signals.distanceKm = Math.round(haversineKm(pharmacy.lat, pharmacy.lng, centroid.lat, centroid.lng) * 10) / 10;
  }

  const pharmacyMarkaz = normalizeMarkaz(pharmacy.markaz);
  const centroidMarkaz = normalizeMarkaz(centroid?.markaz);
  signals.markazMatch = pharmacyMarkaz !== "" && pharmacyMarkaz === centroidMarkaz;

  const govRegion = resolveGovernorateRegion(pharmacy.governorate);
  const mappedRegion = govRegion.regionCode;
  signals.governorateMatch = mappedRegion != null && mappedRegion === brick.regionCode;

  if (signals.distanceKm != null && signals.distanceKm < 5) return { confidence: 95, signals };
  if (signals.distanceKm != null && signals.distanceKm < 15) return { confidence: 85, signals };

  if (signals.markazMatch) return { confidence: 80, signals };

  if (signals.governorateMatch) return { confidence: 70, signals };

  if (govRegion.ambiguous) {
    if (brick.regionCode === "D2" || brick.regionCode === "D3") return { confidence: 58, signals };
  }

  if (mappedRegion != null) {
    // Region mismatch — the pharmacy is provably somewhere else.
    if (signals.distanceKm != null && signals.distanceKm > 50) return { confidence: 10, signals };
    return { confidence: 12, signals };
  }

  // Geocoded but the governorate is unknown to the map (or missing) — weak signal either way.
  return { confidence: 35, signals };
}
