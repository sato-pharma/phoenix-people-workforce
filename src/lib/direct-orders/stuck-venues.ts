import type { AccessContext } from "@/lib/auth/permissions";
import { canDecideDirectOrderPharmacyValidations } from "@/lib/direct-orders/pharmacy-validation";
import { resolveEmployeeDisplayName } from "@/lib/employees/display-name";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { normalizeVenueType, type VenueType } from "@/lib/venues/venue-type";

// ─────────────────────────────────────────────────────────────────────────────
// Venues waiting for a capture that nobody has filed — the validation desk's blind spot.
//
// WHY IT EXISTS. Owner, 2026-09-29: "add a stuck-venues list to the validation desk." The desk
// lists CLAIMS. A venue with no claim has no row there, so a venue nobody ever captured is not
// merely unflagged — it is structurally invisible on the one screen built to look at venue evidence.
//
// That is how three of them sat unnoticed. On the day this was written, production held five
// `pending_review` venues with no live claim, carrying 307,441 EGP of direct orders between them,
// and the only way anyone found them was a hand-written SQL query. `DOP-000131` (زمزم, 133,056 EGP)
// had been stuck since before that day with nobody looking at all.
//
// It is a LIST, not a queue. There is no button here and there must not be one: the missing thing
// is a rep standing in front of the venue with a phone, and nobody at this desk can supply that
// (`canCaptureDirectOrderValidation` — only the order's own requester may capture, because the GPS
// check is run against THEIR area). An admin action here would be a photograph of a place the
// admin never stood, which is worse than no evidence because it looks like proof.
// ─────────────────────────────────────────────────────────────────────────────

export type DirectOrderStuckVenue = {
  id: string;
  phoenixPharmacyCode: string;
  pharmacyName: string;
  venueType: VenueType;
  areaCode: string | null;
  /** Who raised it, resolved to a name — never an HR id on screen (owner's standing rule). */
  raisedByName: string | null;
  /** How long it has been sitting there, so the oldest can be read at a glance. */
  createdAtIso: string | null;
  orders: number;
  ordersValue: number;
  /** `returned`, `rejected`, … — what the orders behind it are actually doing. */
  orderStates: string[];
};

/**
 * Every active venue still `pending_review` that has NO claim awaiting a decision.
 *
 * "No LIVE claim", not "no claim at all": a venue whose only claim was rejected is back to having
 * nothing in front of the desk, which is exactly the stuck state. A venue with a pending claim is
 * not stuck — it is the desk's normal work and already has a row above.
 *
 * Gated to the viewers who decide every claim. An SFE Manager's desk is narrowed to invoice claims
 * (`listDirectOrderPharmacyValidations` does the same), and a missing FIELD capture is not theirs to
 * chase, so they get an empty list rather than a queue they cannot act on.
 *
 * Never throws: this is a panel under the desk's real work, and a desk that loses its claims because
 * a decoration could not be read would be a worse screen than one without the panel.
 */
export async function listDirectOrderStuckVenues(access: AccessContext): Promise<DirectOrderStuckVenue[]> {
  if (!canDecideDirectOrderPharmacyValidations(access)) return [];
  const supabase = getSupabaseAdmin();

  const { data: venueRows, error } = await supabase
    .from("direct_order_pharmacies")
    .select("id, phoenix_pharmacy_code, pharmacy_name, venue_type, area_code, created_by_hr_id, created_at")
    .eq("active", true)
    .eq("verification_status", "pending_review")
    .limit(500);
  if (error) return [];
  const venues = (venueRows ?? []) as Array<{
    id: string;
    phoenix_pharmacy_code?: string | null;
    pharmacy_name?: string | null;
    venue_type?: string | null;
    area_code?: string | null;
    created_by_hr_id?: string | null;
    created_at?: string | null;
  }>;
  if (venues.length === 0) return [];

  const ids = venues.map((v) => String(v.id)).filter(Boolean);

  // Which of them already have a claim in front of the desk. Chunked at 50 — a PostgREST `.in()`
  // returns zero rows and no error once its header grows, and an empty answer HERE would list every
  // venue as stuck, including the ones the desk is actively working.
  const venuesWithLiveClaim = new Set<string>();
  const ordersByVenue = new Map<string, { count: number; value: number; states: Set<string> }>();
  for (let index = 0; index < ids.length; index += 50) {
    const slice = ids.slice(index, index + 50);
    const [{ data: claims }, { data: orders }] = await Promise.all([
      supabase.from("direct_order_pharmacy_validations").select("pharmacy_id, status").in("pharmacy_id", slice),
      supabase.from("direct_order_requests").select("pharmacy_id, status, sales_value").in("pharmacy_id", slice),
    ]);
    for (const claim of ((claims ?? []) as Array<{ pharmacy_id?: string | null; status?: string | null }>)) {
      if (String(claim.status ?? "") !== "rejected") venuesWithLiveClaim.add(String(claim.pharmacy_id ?? ""));
    }
    for (const order of ((orders ?? []) as Array<{
      pharmacy_id?: string | null;
      status?: string | null;
      sales_value?: number | string | null;
    }>)) {
      const key = String(order.pharmacy_id ?? "");
      if (!key) continue;
      const bucket = ordersByVenue.get(key) ?? { count: 0, value: 0, states: new Set<string>() };
      bucket.count += 1;
      bucket.value += Number(order.sales_value ?? 0) || 0;
      const state = String(order.status ?? "").trim();
      if (state) bucket.states.add(state);
      ordersByVenue.set(key, bucket);
    }
  }

  const stuck = venues.filter((venue) => !venuesWithLiveClaim.has(String(venue.id)));
  if (stuck.length === 0) return [];

  // Names, never HR ids on screen. Case-insensitive on purpose: `created_by_hr_id` holds both the
  // canonical and the lower-cased spelling, and an exact-cased join silently returns nothing.
  const nameByHr = new Map<string, string>();
  const hrIds = [...new Set(stuck.map((v) => String(v.created_by_hr_id ?? "").trim()).filter(Boolean))];
  if (hrIds.length > 0) {
    const { data: people } = await supabase
      .from("employees")
      .select("hr_id, full_name, nickname")
      .in("hr_id", [...hrIds, ...hrIds.map((id) => id.toLowerCase()), ...hrIds.map((id) => id.toUpperCase())]);
    for (const person of ((people ?? []) as Array<{ hr_id?: string | null; full_name?: string | null; nickname?: string | null }>)) {
      const key = String(person.hr_id ?? "").toUpperCase();
      if (key && person.full_name) {
        nameByHr.set(key, resolveEmployeeDisplayName(person.full_name, person.nickname, person.hr_id));
      }
    }
  }

  return stuck
    .map((venue) => {
      const orders = ordersByVenue.get(String(venue.id));
      return {
        id: String(venue.id),
        phoenixPharmacyCode: String(venue.phoenix_pharmacy_code ?? "").trim() || "—",
        pharmacyName: String(venue.pharmacy_name ?? "").trim() || "Venue",
        venueType: normalizeVenueType(venue.venue_type),
        areaCode: String(venue.area_code ?? "").trim() || null,
        raisedByName: nameByHr.get(String(venue.created_by_hr_id ?? "").toUpperCase()) ?? null,
        createdAtIso: venue.created_at ?? null,
        orders: orders?.count ?? 0,
        ordersValue: orders?.value ?? 0,
        orderStates: orders ? [...orders.states].sort() : [],
      };
    })
    // Most money first: the panel exists so the biggest thing nobody is looking at is the first
    // thing read. A venue with no orders yet sorts to the bottom, which is where it belongs.
    .sort((a, b) => b.ordersValue - a.ordersValue || a.pharmacyName.localeCompare(b.pharmacyName));
}
