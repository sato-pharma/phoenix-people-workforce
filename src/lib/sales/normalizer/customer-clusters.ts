import { haversineKm, normalizeMarkaz, type BrickCentroid } from "@/lib/sales/normalizer/geo-validate";
import { pharmacyGeoKey, type PharmacyGeo } from "@/lib/sales/normalizer/pharmacy-geocode";
import { normalizeAliasKey } from "@/lib/sales/normalizer/resolvers";

// Cluster unknown customers by WHERE THEY ACTUALLY ARE so the operator can map dozens in one
// gesture ("Dakahlia — Mansoura, 23 pharmacies → one brick pick"). Pure — callers resolve the
// geo lookups (cache-first) and brick centroids, then cluster here.
//
// Grouping precedence per unknown:
//   1. cached geocode (governorate, markaz)   — real location
//   2. distributor territory text (normalized) — weaker but still groupable
//   3. "no location signal" bucket             — residue, mapped one by one

export type ClusterUnknown = {
  raw: string;
  rawName?: string;
  rawAddress?: string;
  rawTerritory?: string;
  count?: number;
};

export type SuggestedBrick = { brickId: string; distanceKm: number | null };

export type CustomerCluster = {
  key: string;
  kind: "geo" | "territory" | "none";
  label: string;
  governorate: string | null;
  markaz: string | null;
  members: ClusterUnknown[];
  suggestedBricks: SuggestedBrick[];
};

const MAX_SUGGESTED_BRICKS = 8;

export function clusterUnknownCustomers(
  unknowns: ClusterUnknown[],
  geoByKey: Map<string, PharmacyGeo>,
  centroids: Map<string, BrickCentroid>,
): CustomerCluster[] {
  type Bucket = {
    kind: "geo" | "territory" | "none";
    governorate: string | null;
    markaz: string | null;
    label: string;
    members: ClusterUnknown[];
    lats: number[];
    lngs: number[];
  };
  const buckets = new Map<string, Bucket>();

  for (const unknown of unknowns) {
    const geo = geoByKey.get(pharmacyGeoKey(unknown.rawName ?? unknown.raw, unknown.rawAddress ?? "")) ?? null;
    let key: string;
    let bucket = null as Bucket | null;
    if (geo && (geo.governorate || geo.markaz)) {
      const gov = geo.governorate ?? "";
      const markaz = normalizeMarkaz(geo.markaz);
      key = `g|${gov.toLowerCase()}|${markaz}`;
      bucket = buckets.get(key) ?? {
        governorate: geo.governorate,
        kind: "geo",
        label: [geo.governorate, geo.markaz].filter(Boolean).join(" — ") || "Located",
        lats: [],
        lngs: [],
        markaz: geo.markaz,
        members: [],
      };
      bucket.lats.push(geo.lat);
      bucket.lngs.push(geo.lng);
    } else {
      const territoryKey = normalizeAliasKey(unknown.rawTerritory ?? "");
      if (territoryKey) {
        key = `t|${territoryKey}`;
        bucket = buckets.get(key) ?? {
          governorate: null,
          kind: "territory",
          label: `Territory: ${String(unknown.rawTerritory ?? "").trim()}`,
          lats: [],
          lngs: [],
          markaz: null,
          members: [],
        };
      } else {
        key = "none";
        bucket = buckets.get(key) ?? {
          governorate: null,
          kind: "none",
          label: "No location signal",
          lats: [],
          lngs: [],
          markaz: null,
          members: [],
        };
      }
    }
    bucket.members.push(unknown);
    buckets.set(key, bucket);
  }

  const clusters: CustomerCluster[] = [];
  for (const [key, bucket] of buckets) {
    let suggestedBricks: SuggestedBrick[] = [];
    if (bucket.kind === "geo") {
      const meanLat = bucket.lats.length ? bucket.lats.reduce((a, b) => a + b, 0) / bucket.lats.length : null;
      const meanLng = bucket.lngs.length ? bucket.lngs.reduce((a, b) => a + b, 0) / bucket.lngs.length : null;
      const clusterMarkaz = normalizeMarkaz(bucket.markaz);
      const clusterGov = String(bucket.governorate ?? "").toLowerCase().trim();
      for (const [brickId, centroid] of centroids) {
        if (centroid.status !== "success") continue;
        const brickMarkaz = normalizeMarkaz(centroid.markaz);
        const brickGov = String(centroid.governorate ?? "").toLowerCase().trim();
        const markazHit = clusterMarkaz !== "" && clusterMarkaz === brickMarkaz;
        const govHit = clusterGov !== "" && clusterGov === brickGov;
        if (!markazHit && !govHit) continue;
        const distanceKm = meanLat != null && meanLng != null
          ? Math.round(haversineKm(meanLat, meanLng, centroid.lat, centroid.lng) * 10) / 10
          : null;
        suggestedBricks.push({ brickId, distanceKm });
      }
      suggestedBricks.sort((a, b) => (a.distanceKm ?? Number.POSITIVE_INFINITY) - (b.distanceKm ?? Number.POSITIVE_INFINITY));
      suggestedBricks = suggestedBricks.slice(0, MAX_SUGGESTED_BRICKS);
    }
    clusters.push({
      governorate: bucket.governorate,
      key,
      kind: bucket.kind,
      label: bucket.label,
      markaz: bucket.markaz,
      members: bucket.members,
      suggestedBricks,
    });
  }

  // Biggest clusters first; the "no location signal" bucket always last.
  clusters.sort((a, b) => {
    if (a.kind === "none") return 1;
    if (b.kind === "none") return -1;
    return b.members.length - a.members.length;
  });
  return clusters;
}
