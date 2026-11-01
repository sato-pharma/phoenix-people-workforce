/**
 * The "not in the database" half of Pharmacy Search.
 *
 * When our own tables have never heard of a pharmacy, this asks Google where it is and then does
 * the thing that actually matters: turns Google's coordinate back into a Phoenix **brick, area
 * and region** by snapping it to the nearest of the 696 geocoded brick centroids — and lists the
 * doctors OUR reps have checked into around that point.
 *
 * Nothing here writes. Every fact carries `origin: "google"` so the reader can see it is not ours,
 * and the territory carries the snap distance so a 12 km guess cannot be mistaken for a mapping.
 *
 * Cost note: each lookup is one Places call (autocomplete or details) plus at most one nearby
 * search, and it runs only when a person presses the button — never automatically on every keystroke.
 */

import {
  googlePlaceDetails,
  googlePlacesAutocomplete,
  googlePlacesNearbySearch,
  hasGoogleServerKey,
  type PlaceSuggestion,
} from "@/lib/google-maps/server";
import type { SourceMaskViewer } from "@/lib/sales/closing-source-mask";

import { haversineKm, roundKm } from "./geo";
import { googleMapsUrlFor, snapToNearestBrick } from "./locate";
import { DEFAULT_RADIUS_KM, findKnownHospitals, findNearbyContacts, mergeHospitals } from "./nearby";
import { EMPTY_TERRITORY, type NearbyHospital, type PharmacyProfile } from "./types";

export class GoogleLookupUnavailableError extends Error {
  constructor() {
    super("Google lookup is not configured on this server (no Maps key).");
    this.name = "GoogleLookupUnavailableError";
  }
}

export type ExternalCandidate = PlaceSuggestion;

/**
 * Ranked Google candidates for a query, for the human to pick from.
 *
 * Deliberately NOT auto-picking: the shared text-search helper prefers a geographic result over a
 * business, which is right for geocoding a district and wrong here — it would skip past the very
 * pharmacy being looked for in favour of the neighbourhood it sits in.
 */
export async function findExternalCandidates(query: string): Promise<ExternalCandidate[]> {
  if (!hasGoogleServerKey()) throw new GoogleLookupUnavailableError();
  const trimmed = query.trim();
  if (trimmed.length < 2) return [];
  // Nudging Google towards pharmacies keeps a query like "الحديثة" from returning cafés first.
  const suggestions = await googlePlacesAutocomplete(`${trimmed} pharmacy Egypt`);
  if (suggestions.length > 0) return suggestions;
  return await googlePlacesAutocomplete(trimmed);
}

/**
 * Build a full profile for a pharmacy that only Google knows about.
 *
 * The territory is DERIVED, never read: `territoryDerivedFromKm` is the distance to the brick
 * centroid it was snapped to, and it is the single most important number on the result — a 0.4 km
 * snap is as good as a mapping, a 14 km snap is a hint at best.
 */
export async function loadExternalPharmacyProfile(options: {
  includeGoogleHospitals?: boolean;
  placeId: string;
  radiusKm?: number;
  viewer: SourceMaskViewer;
}): Promise<PharmacyProfile> {
  if (!hasGoogleServerKey()) throw new GoogleLookupUnavailableError();

  const place = await googlePlaceDetails(options.placeId);
  if (!place) {
    throw new Error("Google returned no details for that place.");
  }

  const radiusKm = options.radiusKm ?? DEFAULT_RADIUS_KM;
  const centre = { latitude: place.lat, longitude: place.lng };
  const warnings: string[] = [];

  const [snap, contacts, knownHospitals] = await Promise.all([
    snapToNearestBrick(centre),
    findNearbyContacts(centre, radiusKm),
    findKnownHospitals({ brickId: null, centre, radiusKm, viewer: options.viewer }),
  ]);
  const nearbyDoctors = contacts.doctors;

  // Our own hospitals first — a pharmacy Google has never heard of is often surrounded by
  // hospitals we visit weekly, and those carry a CRM name the owner will recognise. Google only
  // adds the ones we do not already hold.
  const googleHospitals: NearbyHospital[] = [];
  if (options.includeGoogleHospitals !== false) {
    const found = await googlePlacesNearbySearch({
      includedType: "hospital",
      latitude: centre.latitude,
      longitude: centre.longitude,
      maxResultCount: 10,
      radiusMeters: Math.round(radiusKm * 1000),
    });

    for (const hospital of found) {
      googleHospitals.push({
        address: hospital.address,
        distanceKm: roundKm(haversineKm(centre, { latitude: hospital.lat, longitude: hospital.lng })),
        name: hospital.name,
        origin: "google",
        proximity: "google",
        speciality: null,
      });
    }
  }

  const hospitals = mergeHospitals(contacts.hospitals, knownHospitals, googleHospitals);

  if (!snap) {
    warnings.push(
      "This point is more than 25 km from every brick centroid we hold, so no brick could be assigned. Treat the area and region as unknown.",
    );
  } else if (snap.distanceKm > 5) {
    warnings.push(
      `Brick assigned by nearest centroid, ${snap.distanceKm} km away — far enough that it is a hint, not a mapping. Confirm before relying on it.`,
    );
  }

  if (nearbyDoctors.length === 0) {
    warnings.push(
      `No rep check-in within ${radiusKm} km of this point. Check-ins are a partial feed — this is not proof that no doctor practises nearby.`,
    );
  }

  warnings.push("This pharmacy is NOT in the Phoenix database. Everything above came from Google just now.");

  return {
    address: place.formattedAddress,
    coordinates: { latitude: centre.latitude, longitude: centre.longitude, source: "google_lookup" },
    distributorCodes: [],
    googleAddress: place.formattedAddress,
    googleMapsUrl: googleMapsUrlFor(centre, place.name ?? ""),
    hospitals,
    id: `google:${options.placeId}`,
    name: place.name ?? place.formattedAddress ?? "Unnamed place",
    nearbyDoctors,
    origin: "google",
    sales: [],
    territory: snap?.territory ?? EMPTY_TERRITORY,
    territoryDerivedFromKm: snap?.distanceKm ?? null,
    warnings,
  };
}
