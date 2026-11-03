/**
 * What the approval screens read from the list check: the flag sentence for a customer, and the two
 * photos side by side (owner, 2026-10-27: "you must don't block but flag … in the approval window, you
 * will show the two photos").
 *
 * 🔴 Every read here degrades to nothing. A decision screen must always open, and an unreadable check is
 * no reason to stop an approver. Kept apart from `crm-list-check.ts` so `service.ts` can import it without
 * pulling the whole check and the organogram into every marketing request.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import { metresBetween } from "@/lib/crm/location-confidence";
import type { CrmListFlagCheck } from "@/lib/marketing-requests/crm-doctor-pick";
import { loadMarketingEvidencePhoto } from "@/lib/marketing-requests/evidence-photo-storage";
import { isUsableFix } from "@/lib/phoenix-crm/geo";
import { matchAnchorOf } from "@/lib/phoenix-crm/server/place-match-groups";

const PHOENIX_CRM_PHOTO_BUCKET = "phoenix-crm-photos";
const DOCTOR_PHOTO_URL_SECONDS = 15 * 60;

/** The row that speaks for a customer: the worst state across his lines, a nursery on any of them. */
const FLAG_ORDER = ["left_list", "check", "not_on_list", "no_holder", "no_location", "on_list"];

type FlagRow = { customer_id?: unknown; looks_like_nursery?: unknown; metres_apart?: unknown; state?: unknown };

export function worstListCheckFlagFacts(rows: readonly FlagRow[]): CrmListFlagCheck | null {
  if (rows.length === 0) return null;
  const rank = (row: FlagRow) => {
    const at = FLAG_ORDER.indexOf(String(row.state));
    return at < 0 ? FLAG_ORDER.length : at;
  };
  const worst = [...rows].sort((left, right) => rank(left) - rank(right))[0];
  return {
    looksLikeNursery: rows.some((row) => row.looks_like_nursery === true),
    metresApart: typeof worst.metres_apart === "number" ? worst.metres_apart : null,
    state: typeof worst.state === "string" ? worst.state : null,
  };
}

/** The check's facts per customer. An empty map on any failure: the flag then falls back to the status alone. */
export async function loadListCheckFlagFacts(supabase: SupabaseClient, customerIds: readonly string[]): Promise<Map<string, CrmListFlagCheck>> {
  const out = new Map<string, CrmListFlagCheck>();
  const ids = [...new Set(customerIds.filter(Boolean))];
  if (ids.length === 0) return out;
  try {
    const { data, error } = await supabase
      .from("marketing_customer_list_checks")
      .select("customer_id, looks_like_nursery, metres_apart, state")
      .in("customer_id", ids);
    if (error) throw error;
    const byCustomer = new Map<string, FlagRow[]>();
    for (const row of (data ?? []) as FlagRow[]) {
      const customerId = String(row.customer_id);
      byCustomer.set(customerId, [...(byCustomer.get(customerId) ?? []), row]);
    }
    for (const [customerId, rows] of byCustomer) {
      const facts = worstListCheckFlagFacts(rows);
      if (facts) out.set(customerId, facts);
    }
  } catch (error) {
    console.error("[marketing-list-check] the flag facts could not be read; the approval screen falls back to the stored status", error);
  }
  return out;
}

export type ListCheckTwoPhotos = {
  customerPhotoUrl: string | null;
  doctorName: string | null;
  doctorPhotoUrl: string | null;
  metresApart: number | null;
  reason: string;
};

/** A signed link to one doctor's place photo, or null. Shared by the approval window and the board. */
export async function signDoctorPlacePhoto(supabase: SupabaseClient, path: string | null | undefined): Promise<string | null> {
  if (!path) return null;
  const { data, error } = await supabase.storage.from(PHOENIX_CRM_PHOTO_BUCKET).createSignedUrl(path, DOCTOR_PHOTO_URL_SECONDS);
  return error ? null : (data?.signedUrl ?? null);
}

export type DoctorPlaceRow = Record<string, unknown>;

export const DOCTOR_PLACE_COLUMNS =
  "customer_id, lat, lon, accuracy_meters, pin_lat, pin_lon, pin_accuracy_meters, photo_lat, photo_lon, photo_accuracy_meters, photo_path";

/** The photo of the place nearest the customer's point, read where the check itself reads a place. */
export function nearestDoctorPhotoPath(rows: readonly DoctorPlaceRow[], point: { lat: unknown; lon: unknown }): string | null {
  const distance = (row: DoctorPlaceRow): number => {
    const anchor = matchAnchorOf(row);
    if (!anchor || !isUsableFix(point.lat, point.lon)) return Number.MAX_SAFE_INTEGER;
    return metresBetween(Number(point.lat), Number(point.lon), anchor.point.lat, anchor.point.lon);
  };
  const nearest = [...rows].filter((row) => row.photo_path).sort((left, right) => distance(left) - distance(right))[0];
  return nearest ? String(nearest.photo_path) : null;
}

/** The doctor's place nearest the customer's point, among those that kept a photo. */
export async function loadDoctorPlacePhotoPath(
  supabase: SupabaseClient,
  crmCustomerId: string,
  point: { lat: unknown; lon: unknown },
): Promise<string | null> {
  const { data, error } = await supabase
    .from("phoenix_crm_places")
    .select(DOCTOR_PLACE_COLUMNS)
    .eq("customer_id", crmCustomerId)
    .eq("is_test", false)
    .eq("status", "active")
    .not("photo_path", "is", null);
  if (error) return null;
  return nearestDoctorPhotoPath((data ?? []) as DoctorPlaceRow[], point);
}

/** Both photos for one customer, when the check tied him to a row of a rep's list. Null otherwise, or on any failure. */
export async function loadListCheckTwoPhotos(supabase: SupabaseClient, customerId: string): Promise<ListCheckTwoPhotos | null> {
  try {
    const { data, error } = await supabase
      .from("marketing_customer_list_checks")
      .select("matched_crm_customer_id, matched_name, metres_apart, reason, marketing_customers:customer_id(captured_latitude, captured_longitude)")
      .eq("customer_id", customerId)
      .not("matched_crm_customer_id", "is", null)
      .order("checked_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error || !data) return null;
    const row = data as unknown as {
      marketing_customers: { captured_latitude: unknown; captured_longitude: unknown } | null;
      matched_crm_customer_id: string;
      matched_name: string | null;
      metres_apart: number | null;
      reason: string;
    };
    const [customerPhoto, doctorPath] = await Promise.all([
      loadMarketingEvidencePhoto({ entityId: customerId, entityType: "customer", supabase }),
      loadDoctorPlacePhotoPath(supabase, row.matched_crm_customer_id, {
        lat: row.marketing_customers?.captured_latitude,
        lon: row.marketing_customers?.captured_longitude,
      }),
    ]);
    return {
      customerPhotoUrl: customerPhoto?.signedUrl ?? null,
      doctorName: row.matched_name,
      doctorPhotoUrl: await signDoctorPlacePhoto(supabase, doctorPath),
      metresApart: row.metres_apart,
      reason: row.reason,
    };
  } catch (error) {
    console.error("[marketing-list-check] the two photos could not be read; the approval window opens without them", error);
    return null;
  }
}
