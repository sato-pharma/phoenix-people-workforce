import assert from "node:assert/strict";

import { clusterUnknownCustomers, type ClusterUnknown } from "../src/lib/sales/normalizer/customer-clusters.ts";
import type { BrickCentroid } from "../src/lib/sales/normalizer/geo-validate.ts";
import { pharmacyGeoKey, type PharmacyGeo } from "../src/lib/sales/normalizer/pharmacy-geocode.ts";

function geo(lat: number, lng: number, governorate: string | null, markaz: string | null): PharmacyGeo {
  return { governorate, lat, lng, markaz };
}

export function runCustomerClustersTests() {
  const unknowns: ClusterUnknown[] = [
    { raw: "A-1", rawAddress: "شارع الجمهورية", rawName: "صيدلية النور" },
    { raw: "A-2", rawAddress: "شارع الجيش", rawName: "صيدلية الامل" },
    { raw: "B-1", rawAddress: "طنطا", rawName: "صيدلية الشفاء", rawTerritory: "" },
    { raw: "C-1", rawName: "صيدلية بلا عنوان", rawTerritory: "مركز قويسنا" },
    { raw: "C-2", rawName: "صيدلية اخرى", rawTerritory: "مركز قويسنا" },
    { raw: "D-1", rawName: "صيدلية مجهولة" },
  ];

  const geoByKey = new Map<string, PharmacyGeo>([
    // A-1 + A-2 in Mansoura, Dakahlia (same governorate+markaz → same cluster)
    [pharmacyGeoKey("صيدلية النور", "شارع الجمهورية"), geo(31.04, 31.38, "Dakahlia", "Qesm El Mansoura")],
    [pharmacyGeoKey("صيدلية الامل", "شارع الجيش"), geo(31.05, 31.37, "Dakahlia", "Markaz El Mansoura")],
    // B-1 in Tanta, Gharbia
    [pharmacyGeoKey("صيدلية الشفاء", "طنطا"), geo(30.79, 31.0, "Gharbia", "Tanta")],
    // C-1, C-2, D-1 have no geocode
  ]);

  const centroids = new Map<string, BrickCentroid>([
    ["BR-MANS-1", { governorate: "Dakahlia", lat: 31.045, lng: 31.375, markaz: "El Mansoura", status: "success" }],
    ["BR-MANS-FAR", { governorate: "Dakahlia", lat: 31.4, lng: 31.8, markaz: "Belqas", status: "success" }],
    ["BR-TANTA", { governorate: "Gharbia", lat: 30.79, lng: 31.0, markaz: "Tanta", status: "success" }],
    ["BR-BAD", { governorate: "Dakahlia", lat: 31.05, lng: 31.37, markaz: "El Mansoura", status: "region_mismatch" }],
  ]);

  const clusters = clusterUnknownCustomers(unknowns, geoByKey, centroids);

  // Expect 4 clusters: Mansoura-geo x2 members... wait — A-1 is "Qesm El Mansoura", A-2 is
  // "Markaz El Mansoura": normalizeMarkaz folds both to "mansoura", same governorate → same key.
  const mansoura = clusters.find((c) => c.kind === "geo" && c.members.some((m) => m.raw === "A-1"));
  assert.ok(mansoura);
  assert.deepEqual(mansoura.members.map((m) => m.raw).sort(), ["A-1", "A-2"]);

  // Suggested bricks: markaz/governorate matches sorted by distance; mismatched-status brick excluded.
  assert.ok(mansoura.suggestedBricks.length >= 2);
  assert.equal(mansoura.suggestedBricks[0].brickId, "BR-MANS-1"); // closest first
  assert.ok(!mansoura.suggestedBricks.some((s) => s.brickId === "BR-BAD"));
  assert.ok(!mansoura.suggestedBricks.some((s) => s.brickId === "BR-TANTA"));

  const tanta = clusters.find((c) => c.kind === "geo" && c.members.some((m) => m.raw === "B-1"));
  assert.ok(tanta);
  assert.equal(tanta.members.length, 1); // single-member clusters are kept
  assert.equal(tanta.suggestedBricks[0]?.brickId, "BR-TANTA");

  // Territory fallback: C-1 + C-2 group on normalized territory text.
  const territory = clusters.find((c) => c.kind === "territory");
  assert.ok(territory);
  assert.deepEqual(territory.members.map((m) => m.raw).sort(), ["C-1", "C-2"]);
  assert.equal(territory.suggestedBricks.length, 0);

  // No-signal bucket last.
  const none = clusters[clusters.length - 1];
  assert.equal(none.kind, "none");
  assert.deepEqual(none.members.map((m) => m.raw), ["D-1"]);

  // Geo grouping beats territory text: a geocoded unknown with territory text still clusters by geo.
  const geoWins = clusterUnknownCustomers(
    [{ raw: "X-1", rawName: "صيدلية النور", rawAddress: "شارع الجمهورية", rawTerritory: "مركز قويسنا" }],
    geoByKey,
    centroids,
  );
  assert.equal(geoWins[0].kind, "geo");

  // Empty input → empty output.
  assert.deepEqual(clusterUnknownCustomers([], geoByKey, centroids), []);
}
