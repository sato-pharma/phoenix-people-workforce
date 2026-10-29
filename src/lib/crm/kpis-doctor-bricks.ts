/**
 * KPIs — the brick of each doctor on ONE rep's Coverage and Frequency list (owner, 2026-10-29: "filter
 * the coverage per brick. And the brick is derived from the live photo validation").
 *
 * ## Where the brick comes from
 *
 * A doctor's brick is the one his VALIDATED live photo was filed in: `phoenix_crm_places.brick_name`,
 * set once by `resolvePinGeography` (the nearest Phoenix brick within `BRICK_TRUST_KM`, the capturing
 * seat's area breaking a tie). It is read here and never recomputed, so the KPIs and Customer 360
 * (`customer-360/server/sources.ts`, `loadPhoenix`) can never put one doctor in two bricks.
 *
 * ## The three answers, and the fourth that is not one
 *
 *   - a brick name: validated, and the photo sits in that brick;
 *   - null: validated, but the photo was further than the trust radius from any brick, or the
 *     customer has no active place left;
 *   - missing from the map: no validated Phoenix customer carries his contact — "Not validated yet";
 *   - the whole read returns null when it failed. The board then stamps NOTHING, so the list shows no
 *     brick at all rather than calling every doctor "not validated" — a statement about a rep's work.
 *
 * Read for one rep's list per page load, as the doctor lists themselves are (kpis-board.ts).
 */

import { phoenixContactId, PHOENIX_VALIDATED_AT_COLUMN } from "@/lib/customer-360/validated";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { asyncPool } from "@/lib/utils/async-pool";

const IN_CHUNK = 150;
const PARALLEL_CHUNKS = 4;

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
 * One contact can be validated on more than one customer (a doctor on two lines), and one customer
 * can hold more than one active place (29 on 2026-10-29). The customer still on a list beats a dropped
 * one, then the latest validation wins; among that customer's places a place with a brick beats one
 * without, then the earliest — the validation photo itself, not a later visit's.
 */
export function chooseKpiDoctorBricks(
  customers: readonly KpiBrickCustomer[],
  places: readonly KpiBrickPlace[],
): Map<number, string | null> {
  const chosen = new Map<number, KpiBrickCustomer>();
  for (const customer of customers) {
    const contactId = phoenixContactId(customer);
    if (contactId == null || !customer.validated_at) continue;
    const held = chosen.get(contactId);
    const better =
      !held ||
      (isActive(customer) && !isActive(held)) ||
      (isActive(customer) === isActive(held) && customer.validated_at > (held.validated_at ?? ""));
    if (better) chosen.set(contactId, customer);
  }
  const placeOf = new Map<string, KpiBrickPlace>();
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
  const out = new Map<number, string | null>();
  for (const [contactId, customer] of chosen) {
    out.set(contactId, placeOf.get(customer.id)?.brick_name?.trim() || null);
  }
  return out;
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
