/**
 * KPIs — the brick of each doctor on ONE rep's Coverage and Frequency list (owner, 2026-10-29: "filter
 * the coverage per brick. And the brick is derived from the live photo validation").
 *
 * ## Where the brick comes from
 *
 * A doctor's brick is the one his VALIDATED live photo was filed in: `phoenix_crm_places.brick_name`,
 * set once by `resolvePinGeography` (`fileBrickForPoint`: a brick within `BRICK_TRUST_KM`, else the
 * capturing seat's own area's nearest within `OWN_AREA_REACH_KM`). It is read here and never
 * recomputed, so the KPIs and Customer 360 (`customer-360/server/sources.ts`, `loadPhoenix`) can never
 * put one doctor in two bricks.
 *
 * ## The three answers, and the fourth that is not one
 *
 *   - a brick name: validated, and the photo sits in that brick;
 *   - null: validated, but the photo sits further than the reach from every brick of the seat's area;
 *   - missing from the map: no validated Phoenix customer of his still has an ACTIVE place — "Not
 *     validated yet". A customer whose places were all retired, or who never had one, has no live
 *     photo behind him, so he is not validated on this list (owner, 2026-10-29: "Not validated yet");
 *   - the whole read returns null when it failed. The board then stamps NOTHING, so the list shows no
 *     brick at all rather than calling every doctor "not validated" — a statement about a rep's work.
 *
 * Read ONCE per page load over every rep's list on the Coverage and Frequency tabs (kpis-board.ts),
 * so the team's By brick table and each row's not-validated count come from the same answer as the
 * open rep's list. Up to `WHOLE_READ_FROM` contacts the read asks for those contacts by id; above it,
 * a company-wide plan list would take dozens of chunked round trips, so it reads every validated
 * customer and every active place in pages instead. The chooser is the same either way.
 */

import { phoenixContactId, PHOENIX_VALIDATED_AT_COLUMN } from "@/lib/customer-360/validated";
import { fetchAllRows } from "@/lib/supabase/paginated";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { asyncPool } from "@/lib/utils/async-pool";

const IN_CHUNK = 150;
const PARALLEL_CHUNKS = 4;
/** Above this many contacts the whole validated set is cheaper to page through than to ask for by id. */
export const WHOLE_READ_FROM = 600;

/** The columns of a validated customer the chooser reads. */
export type KpiBrickCustomer = {
  id: string;
  status: string | null;
  validated_at: string | null;
  reference_contact_crm_id: number | null;
  own_contact_crm_id: number | null;
};

/** The columns of a place the chooser reads; the reader asks only for active, non-test places. */
export type KpiBrickPlace = {
  customer_id: string;
  brick_name: string | null;
  created_at: string | null;
};

const isActive = (customer: KpiBrickCustomer) => String(customer.status ?? "").trim().toLowerCase() !== "dropped";

/**
 * Picks each contact's brick from his validated customers and their active places. Pure, so the
 * choice is pinned by a test with no database near it.
 *
 * Only a customer with an active place counts: no live place, no live photo behind the validation
 * (owner, 2026-10-29 — 26 validated customers had only retired places, 4 never had one).
 *
 * One contact can be validated on more than one customer (a doctor on two lines), and one customer
 * can hold more than one active place (29 on 2026-10-29). The customer still on a list beats a dropped
 * one, then the latest validation wins; among that customer's places a place with a brick beats one
 * without, then the earliest — the validation photo itself, not a later visit's.
 */
export function chooseKpiDoctorBricks(
  customers: readonly KpiBrickCustomer[],
  places: readonly KpiBrickPlace[],
): Map<number, string | null> {
  const out = new Map<number, string | null>();
  for (const [contactId, { place }] of chooseValidatedPlaces(customers, places)) {
    out.set(contactId, place.brick_name?.trim() || null);
  }
  return out;
}

/**
 * Each contact's validated customer and the ONE active place that stands for him, by the rules above.
 * The brick chooser reads the place's brick; the Reps List reads its point (`validated-place-points.ts`),
 * so a doctor is filed in a brick and painted beside his neighbours from the same photo.
 */
export function chooseValidatedPlaces<P extends KpiBrickPlace>(
  customers: readonly KpiBrickCustomer[],
  places: readonly P[],
): Map<number, { customer: KpiBrickCustomer; place: P }> {
  const placeOf = new Map<string, P>();
  for (const place of places) {
    const held = placeOf.get(place.customer_id);
    const hasBrick = Boolean(place.brick_name?.trim());
    const heldHasBrick = Boolean(held?.brick_name?.trim());
    const better =
      !held ||
      (hasBrick && !heldHasBrick) ||
      (hasBrick === heldHasBrick && (place.created_at ?? "") < (held.created_at ?? ""));
    if (better) placeOf.set(place.customer_id, place);
  }
  const chosen = new Map<number, KpiBrickCustomer>();
  for (const customer of customers) {
    const contactId = phoenixContactId(customer);
    if (contactId == null || !customer.validated_at || !placeOf.has(customer.id)) continue;
    const held = chosen.get(contactId);
    const better =
      !held ||
      (isActive(customer) && !isActive(held)) ||
      (isActive(customer) === isActive(held) && customer.validated_at > (held.validated_at ?? ""));
    if (better) chosen.set(contactId, customer);
  }
  const out = new Map<number, { customer: KpiBrickCustomer; place: P }>();
  for (const [contactId, customer] of chosen) {
    const place = placeOf.get(customer.id);
    if (place) out.set(contactId, { customer, place });
  }
  return out;
}

/**
 * The whole read's answer: the chooser over every validated customer and every active place, narrowed
 * to the contacts asked for. A contact's customers are exactly the ones `phoenixContactId` files under
 * him, so the chunked read (by either contact id) and this one give each asked-for contact the same brick.
 */
export function chooseWantedKpiDoctorBricks(
  contactIds: readonly number[],
  customers: readonly KpiBrickCustomer[],
  places: readonly KpiBrickPlace[],
): Map<number, string | null> {
  const wanted = new Set(contactIds);
  return new Map([...chooseKpiDoctorBricks(customers, places)].filter(([contactId]) => wanted.has(contactId)));
}

function chunk<T>(values: readonly T[]): T[][] {
  const out: T[][] = [];
  for (let at = 0; at < values.length; at += IN_CHUNK) out.push(values.slice(at, at + IN_CHUNK));
  return out;
}

async function readChunked<T>(ids: readonly (string | number)[], read: (part: (string | number)[]) => PromiseLike<{ data: unknown; error: unknown }>): Promise<T[]> {
  const pages = await asyncPool(PARALLEL_CHUNKS, chunk(ids), async (part) => {
    const { data, error } = await read(part);
    if (error) throw error;
    return (Array.isArray(data) ? data : []) as T[];
  });
  return pages.flat();
}

/**
 * The bricks of the given contacts, or null when they could not be read. A contact missing from the
 * map has no validated Phoenix customer; a null value is validated with no brick on record.
 */
export async function loadKpiDoctorBricks(contactIds: readonly number[]): Promise<Map<number, string | null> | null> {
  const ids = [...new Set(contactIds.filter((id) => Number.isFinite(id) && id > 0))];
  if (ids.length === 0) return new Map();
  try {
    const db = getSupabaseAdmin();
    const customerColumns = `id, status, ${PHOENIX_VALIDATED_AT_COLUMN}, reference_contact_crm_id, own_contact_crm_id`;
    if (ids.length > WHOLE_READ_FROM) {
      // Every validated customer and every active place (3,868 and 4,017 on 2026-10-29), paged by id:
      // about five round trips where the chunked reads below would take thirty or more. The answer is
      // then narrowed to the contacts asked for, so the map holds exactly what the chunked read would.
      const [customers, places] = await Promise.all([
        fetchAllRows<KpiBrickCustomer>(
          () => db.from("phoenix_crm_customers").select(customerColumns).not(PHOENIX_VALIDATED_AT_COLUMN, "is", null).eq("is_test", false),
          "id",
        ),
        fetchAllRows<KpiBrickPlace>(
          () => db.from("phoenix_crm_places").select("id, customer_id, brick_name, created_at").eq("is_test", false).eq("status", "active"),
          "id",
        ),
      ]);
      return chooseWantedKpiDoctorBricks(ids, customers, places);
    }
    // Two plain `in` reads rather than one `or(…)`: a contact is carried over from iReports360
    // (reference) or minted by Phoenix for a customer a rep added himself (own), and `phoenixContactId`
    // decides which one a customer is known by.
    const readBy = (column: "reference_contact_crm_id" | "own_contact_crm_id") =>
      readChunked<KpiBrickCustomer>(ids, (part) =>
        db
          .from("phoenix_crm_customers")
          .select(customerColumns)
          .not(PHOENIX_VALIDATED_AT_COLUMN, "is", null)
          .eq("is_test", false)
          .in(column, part),
      );
    const [byReference, byOwn] = await Promise.all([readBy("reference_contact_crm_id"), readBy("own_contact_crm_id")]);
    const customers = [...new Map([...byReference, ...byOwn].map((row) => [String(row.id), row])).values()];
    const places =
      customers.length === 0
        ? []
        : await readChunked<KpiBrickPlace>(
            customers.map((row) => String(row.id)),
            (part) =>
              db
                .from("phoenix_crm_places")
                .select("customer_id, brick_name, created_at")
                .eq("is_test", false)
                .eq("status", "active")
                .in("customer_id", part),
          );
    return chooseKpiDoctorBricks(customers, places);
  } catch (error) {
    console.error("[kpis] the doctors' bricks could not be read; the list shows no brick", error);
    return null;
  }
}
