/**
 * The ONE write path in Pharmacy Search.
 *
 * Owner decision, 2026-08-21: Google-derived data is shown, never saved automatically — a human
 * presses Save. That decision is enforced here by what this module does NOT do: it never touches
 * `source_of_sales_customer_map`, so nothing written from a Google lookup can move which area is
 * credited for a sale. Discoveries land in their own register instead.
 *
 * The geocode is also cached into `geo_locations`, which is what that table is for — it makes the
 * same pharmacy free to look up next time instead of re-billing a Places call.
 */

import { writeAuditLog } from "@/lib/admin/audit";
import type { AccessContext } from "@/lib/auth/permissions";
import { foldCustomerName } from "@/lib/customer-master/name-key";
import { getSupabaseAdmin } from "@/lib/supabase/server";

import type { PharmacyProfile } from "./types";
import { hrIdForStorage } from "@/lib/hr-id";

export class NotSaveableError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "NotSaveableError";
  }
}

export type SaveDiscoveryResult = {
  discoveryId: string;
  geocodeCached: boolean;
  pharmacyName: string;
};

/**
 * Persist a Google-discovered pharmacy. Only a profile with `origin: "google"` is saveable — a
 * pharmacy already in the database has nothing to add here, and saving it would create a
 * duplicate identity for a customer that already has one.
 */
export async function saveDiscoveredPharmacy(options: {
  access: AccessContext;
  notes: string | null;
  profile: PharmacyProfile;
}): Promise<SaveDiscoveryResult> {
  const { access, notes, profile } = options;

  if (profile.origin !== "google") {
    throw new NotSaveableError("Only a pharmacy found on Google can be saved — this one is already in the database.");
  }

  const placeId = profile.id.startsWith("google:") ? profile.id.slice("google:".length) : "";
  if (!placeId) {
    throw new NotSaveableError("This result has no Google place id, so it cannot be saved.");
  }

  const supabase = getSupabaseAdmin();

  const { data, error } = await supabase
    .from("pharmacy_search_discoveries")
    .upsert(
      {
        area_code: profile.territory.areaCode,
        brick_id: profile.territory.brickId,
        google_address: profile.googleAddress,
        google_place_id: placeId,
        latitude: profile.coordinates?.latitude ?? null,
        longitude: profile.coordinates?.longitude ?? null,
        notes: notes?.trim() || null,
        pharmacy_name: profile.name,
        region_code: profile.territory.regionCode,
        saved_by_hr_id: hrIdForStorage(access.hrId),
        snap_distance_km: profile.territoryDerivedFromKm,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "google_place_id" },
    )
    .select("id")
    .single();

  if (error) throw new Error(`Could not save the discovery: ${error.message}`);

  // Cache the geocode so the next lookup of this pharmacy costs nothing. Best-effort: a failure
  // here must not fail the save the user just asked for.
  let geocodeCached = false;
  const normalizedName = foldCustomerName(profile.name);
  if (normalizedName && profile.coordinates) {
    const { error: cacheError } = await supabase.from("geo_locations").upsert(
      {
        address_text: profile.googleAddress,
        geocode_provider: "google",
        geocode_status: "success",
        label: profile.name,
        latitude: profile.coordinates.latitude,
        longitude: profile.coordinates.longitude,
        source_key: normalizedName,
        source_type: "pharmacy_address",
        updated_at: new Date().toISOString(),
      },
      { onConflict: "source_type,source_key" },
    );
    geocodeCached = !cacheError;
  }

  await writeAuditLog({
    actorLoginId: access.loginId ?? access.hrId ?? null,
    entityId: String(data.id),
    entityType: "pharmacy_search_discovery",
    newValues: {
      areaCode: profile.territory.areaCode,
      brickId: profile.territory.brickId,
      googlePlaceId: placeId,
      pharmacyName: profile.name,
      regionCode: profile.territory.regionCode,
      snapDistanceKm: profile.territoryDerivedFromKm,
    },
    summary: `Saved Google-discovered pharmacy "${profile.name}" to the discovery register${
      profile.territory.brickName ? ` (brick ${profile.territory.brickName})` : ""
    }`,
  });

  return { discoveryId: String(data.id), geocodeCached, pharmacyName: profile.name };
}
