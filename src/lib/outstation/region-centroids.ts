// Curated map-centroids for the brick-master regions/areas the org actually uses.
//
// Outstation expenses that have no GPS coordinate (historical Excel uploads, manual
// admin entries — the bulk of spend) still carry a brick-master region. We place them
// on the map at their region centroid so the FULL spend appears as a weighted bubble,
// instead of only the small GPS-captured subset. This is deterministic (no geocoding,
// no DB, no API quota): the org's region names are groupings ("Delta (1)", "ALEX-BHR",
// "Head office", "Upper Egypt") that public geocoding can't resolve reliably, so a
// curated lookup is both simpler and more correct than live geocoding.
//
// Coordinates are approximate governorate/city centroids in Egypt. Add a row here when
// a new region appears (the dashboard discloses any still-unmapped spend honestly).

export type RegionCentroid = { lat: number; lng: number };

function normalizeRegionKey(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

const CENTROIDS: Record<string, RegionCentroid> = {
  // Org region groupings (brick master)
  "upper egypt": { lat: 27.1809, lng: 31.1837 }, // Assiut — central Upper Egypt
  "delta 1": { lat: 30.7865, lng: 31.0004 }, // Tanta — west/central Delta
  "delta 2": { lat: 31.0409, lng: 31.3785 }, // Mansoura — east Delta
  "delta 3": { lat: 30.5877, lng: 31.502 }, // Zagazig — Sharkia/Suez/Ismailia/Qalubeya cluster
  "alex bhr": { lat: 31.2001, lng: 29.9187 }, // Alexandria–Behira
  "alex behiera": { lat: 31.0418, lng: 30.4736 }, // Damanhour — Behira
  "head office": { lat: 30.0444, lng: 31.2357 }, // Cairo HQ
  egypt: { lat: 30.0444, lng: 31.2357 }, // national → Cairo

  // Governorates / cities (for resilience as new regions appear)
  cairo: { lat: 30.0444, lng: 31.2357 },
  giza: { lat: 30.0131, lng: 31.2089 },
  alexandria: { lat: 31.2001, lng: 29.9187 },
  alex: { lat: 31.2001, lng: 29.9187 },
  behira: { lat: 30.9876, lng: 30.4682 },
  behiera: { lat: 30.9876, lng: 30.4682 },
  gharbia: { lat: 30.8754, lng: 31.0335 },
  dakahlia: { lat: 31.0409, lng: 31.3785 },
  sharkia: { lat: 30.7327, lng: 31.7195 },
  menoufia: { lat: 30.5587, lng: 31.0094 },
  menofia: { lat: 30.5587, lng: 31.0094 },
  qalyubia: { lat: 30.4078, lng: 31.2189 },
  fayoum: { lat: 29.3084, lng: 30.8428 },
  "beni suef": { lat: 29.0661, lng: 31.0994 },
  "bani suef": { lat: 29.0661, lng: 31.0994 },
  minya: { lat: 28.1099, lng: 30.7503 },
  minia: { lat: 28.1099, lng: 30.7503 },
  assiut: { lat: 27.1809, lng: 31.1837 },
  sohag: { lat: 26.5571, lng: 31.6996 },
  qena: { lat: 26.1551, lng: 32.716 },
  luxor: { lat: 25.6872, lng: 32.6396 },
  aswan: { lat: 24.0889, lng: 32.8998 },
  "port said": { lat: 31.2653, lng: 32.3019 },
  ismailia: { lat: 30.5965, lng: 32.2715 },
  suez: { lat: 29.9668, lng: 32.5498 },
  damietta: { lat: 31.4165, lng: 31.8133 },
  "kafr el sheikh": { lat: 31.1117, lng: 30.9396 },
};

/**
 * Resolve a brick-master region name to a map centroid. Tries an exact normalized
 * match, then progressively shorter prefixes (so "Menoufia 1" → "menoufia",
 * "Alex Center 2" → "alex"), then the first token. Returns null if unknown.
 */
export function resolveRegionCentroid(region: string | null | undefined): RegionCentroid | null {
  if (!region) return null;
  const key = normalizeRegionKey(region);
  if (!key) return null;
  if (CENTROIDS[key]) return CENTROIDS[key];

  const tokens = key.split(" ").filter(Boolean);
  for (let take = tokens.length - 1; take >= 1; take -= 1) {
    const prefix = tokens.slice(0, take).join(" ");
    if (CENTROIDS[prefix]) return CENTROIDS[prefix];
  }
  return tokens[0] && CENTROIDS[tokens[0]] ? CENTROIDS[tokens[0]] : null;
}
