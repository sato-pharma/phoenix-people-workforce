import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  LOCATIONIQ_CONFIDENCE_THRESHOLD,
  scoreForwardConfidence,
  scoreReverseConfidence,
  type LocationIqReverseResult,
  type LocationIqSearchResult,
} from "../src/lib/geocoding/locationiq.ts";

export function runLocationIqGeocodeConfidenceTests() {
  // ── scoreReverseConfidence: address-component granularity proxy ─────────────────────
  assert.equal(scoreReverseConfidence(null), 0, "no result at all scores 0");
  assert.equal(
    scoreReverseConfidence({ display_name: "12 Some Rd, Cairo" } as LocationIqReverseResult),
    0,
    "a result with no structured address object scores 0, even with a display_name",
  );

  const houseLevel: LocationIqReverseResult = {
    address: { house_number: "12", road: "Some Rd" },
    display_name: "12 Some Rd, Nasr City, Cairo, Egypt",
  };
  assert.ok(
    scoreReverseConfidence(houseLevel) >= LOCATIONIQ_CONFIDENCE_THRESHOLD,
    "house_number + road must clear the confidence threshold — precise enough to trust",
  );

  const roadLevel: LocationIqReverseResult = {
    address: { road: "Some Rd" },
    display_name: "Some Rd, Nasr City, Cairo, Egypt",
  };
  assert.ok(
    scoreReverseConfidence(roadLevel) < LOCATIONIQ_CONFIDENCE_THRESHOLD,
    "at the 90-point threshold, road-only (no house_number) is no longer precise enough — must fall back to Google",
  );

  const suburbLevel: LocationIqReverseResult = {
    address: { suburb: "Nasr City" },
    display_name: "Nasr City, Cairo, Egypt",
  };
  assert.ok(
    scoreReverseConfidence(suburbLevel) < LOCATIONIQ_CONFIDENCE_THRESHOLD,
    "suburb-only (no road) is too coarse for a check-in address — must fall under the threshold so the caller retries with Google",
  );

  const cityLevel: LocationIqReverseResult = {
    address: { city: "Cairo" },
    display_name: "Cairo, Egypt",
  };
  assert.ok(
    scoreReverseConfidence(cityLevel) < LOCATIONIQ_CONFIDENCE_THRESHOLD,
    "city-only is far too coarse to be a usable check-in address",
  );

  const countryLevel: LocationIqReverseResult = {
    address: { country: "Egypt" },
    display_name: "Egypt",
  };
  assert.ok(
    scoreReverseConfidence(countryLevel) < LOCATIONIQ_CONFIDENCE_THRESHOLD,
    "country-only must never be accepted as a check-in address",
  );
  assert.ok(
    scoreReverseConfidence(countryLevel) < scoreReverseConfidence(cityLevel),
    "confidence must strictly decrease as the matched address gets coarser (country < city)",
  );

  // ── scoreForwardConfidence: OSM class/type + importance proxy ───────────────────────
  assert.equal(scoreForwardConfidence(null), 0, "no result scores 0");
  assert.equal(
    scoreForwardConfidence({ class: "amenity", display_name: "Some Pharmacy" } as LocationIqSearchResult),
    0,
    "a result missing lat/lon (unusable coordinates) scores 0 regardless of class",
  );

  const poiMatch: LocationIqSearchResult = { class: "amenity", lat: "30.05", lon: "31.24", type: "pharmacy" };
  assert.ok(
    scoreForwardConfidence(poiMatch) >= LOCATIONIQ_CONFIDENCE_THRESHOLD,
    "a specific POI class (amenity/shop/etc) match must clear the threshold",
  );

  const roadMatch: LocationIqSearchResult = { class: "highway", lat: "30.05", lon: "31.24", type: "residential" };
  assert.ok(
    scoreForwardConfidence(roadMatch) < LOCATIONIQ_CONFIDENCE_THRESHOLD,
    "a road-only match (found the street, not the actual place) must fall under the threshold — Google is tried next",
  );

  const placeMatch: LocationIqSearchResult = { class: "place", lat: "30.05", lon: "31.24", type: "city" };
  assert.ok(
    scoreForwardConfidence(placeMatch) < LOCATIONIQ_CONFIDENCE_THRESHOLD,
    "a place/administrative-only match (geocoder matched a whole city, not the pharmacy) is the exact 'ambiguous' case that must fall back to Google",
  );

  const highImportanceUnknownClass: LocationIqSearchResult = {
    class: "unknown_class",
    importance: 0.9,
    lat: "30.05",
    lon: "31.24",
  };
  assert.equal(
    scoreForwardConfidence(highImportanceUnknownClass),
    90,
    "an unrecognized class falls back to the vendor's own importance signal (0-1 -> 0-100)",
  );

  // ── Wiring: static source assertions (no mocked Supabase/network client exists in this repo,
  // same established pattern as tests/visits-report-sync.test.ts) ────────────────────────────

  const checkinGeocode = readFileSync("src/lib/crm/checkin-geocode.ts", "utf8");
  assert.match(
    checkinGeocode,
    /scoreReverseConfidence\(locationIqResult\) >= LOCATIONIQ_CONFIDENCE_THRESHOLD/,
    "CRM check-in reverse geocoding must gate LocationIQ acceptance on the confidence threshold, not just a non-null response",
  );
  assert.match(
    checkinGeocode,
    /return await googleReverseGeocodeLabel\(lat, lon\);/,
    "CRM check-in reverse geocoding must fall back to Google when LocationIQ's confidence is too low",
  );

  const pharmacyGeocode = readFileSync("src/lib/sales/normalizer/pharmacy-geocode.ts", "utf8");
  assert.match(
    pharmacyGeocode,
    /scoreForwardConfidence\(locationIqResult\) >= LOCATIONIQ_CONFIDENCE_THRESHOLD/,
    "pharmacy geocoding must gate LocationIQ acceptance on the confidence threshold",
  );
  assert.match(
    pharmacyGeocode,
    /if \(!hasGoogleServerKey\(\)\) return null;\s*\n\s*const geo = await googleGeocodeComponents\(searchText\);/,
    "pharmacy geocoding must fall back to Google when LocationIQ's match is low-confidence",
  );

  const brickCentroids = readFileSync("src/lib/sales/normalizer/brick-centroids.ts", "utf8");
  assert.match(
    brickCentroids,
    /scoreForwardConfidence\(locationIqResult\) >= LOCATIONIQ_CONFIDENCE_THRESHOLD && locationIqResult\?\.lat && locationIqResult\?\.lon/,
    "brick centroid geocoding must require both a passing confidence score AND real coordinates from LocationIQ before even checking the region gate",
  );
  assert.match(
    brickCentroids,
    /if \(centroidPassesRegionGate\(geo\.governorate, brickRegionCode\)\) \{\s*\n\s*return \{ geo, passesGate: true, provider: "locationiq" \};/,
    "a LocationIQ result must ALSO clear the existing region gate (ground truth) before being accepted outright, not confidence alone",
  );
  assert.match(
    brickCentroids,
    /const googleGeo = await googleGeocodeComponents\(searchText\);\s*\n\s*if \(googleGeo && centroidPassesRegionGate\(googleGeo\.governorate, brickRegionCode\)\)/,
    "when LocationIQ fails the region gate, Google must be retried and checked against the same gate",
  );
}
