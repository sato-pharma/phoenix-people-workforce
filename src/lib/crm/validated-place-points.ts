/**
 * Reps List — where each doctor's VALIDATED place stands (owner, 2026-10-31: "use the validation pin").
 *
 * A rep's list used to know a doctor's position only from his iReports360 check-ins, so a rep with no
 * check-ins (a new rep, or one whose seat never used iReports360) read "No address on record" on every
 * row and no doctor was ever painted beside a neighbour. The live photo a doctor was validated with
 * already says where he stands; this reads that point.
 *
 * The place is the SAME one the KPIs file the doctor's brick under (`chooseValidatedPlaces`), so the
 * brick a doctor is counted in and the neighbours he is painted with come from one photo. Phoenix CRM's
 * own List follows the same precedence (`rowPoint`: the captured place first, else the check-ins).
 *
 * 🔴 A LOCATION, NEVER A READING (golden rule #1, `phoenix-crm/server/blind-payloads.ts`): the point and
 * the address only — no accuracy, no pin or photo reading, no source. A rep's own board may show where
 * his customers are; it may never show how well a capture was taken.
 */

import { phoenixContactId, PHOENIX_VALIDATED_AT_COLUMN } from "@/lib/customer-360/validated";
import { chooseValidatedPlaces, type KpiBrickCustomer, type KpiBrickPlace } from "@/lib/crm/kpis-doctor-bricks";
import { isUsableFix } from "@/lib/phoenix-crm/geo";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { asyncPool } from "@/lib/utils/async-pool";

const IN_CHUNK = 150;
const PARALLEL_CHUNKS = 4;

/** Where a contact's validated place stands, and when it was validated. */
export type ValidatedPlacePoint = {
  address: string | null;
  lat: number;
  lon: number;
  /** ISO timestamp of the validation, so the page can say how old the point is. */
  validatedAt: string | null;
};

type PlaceRow = KpiBrickPlace & { address: string | null; lat: number | null; lon: number | null };

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
 * The validated place point of each contact. Pure, so the choice is pinned with no database near it:
 * the place `chooseValidatedPlaces` picks, kept only when its point is a usable fix inside Egypt.
 */
export function chooseValidatedPlacePoints(
  customers: readonly KpiBrickCustomer[],
  places: readonly PlaceRow[],
): Map<number, ValidatedPlacePoint> {
  const out = new Map<number, ValidatedPlacePoint>();
  for (const [contactId, { customer, place }] of chooseValidatedPlaces(customers, places)) {
    if (!isUsableFix(place.lat, place.lon)) continue;
    out.set(contactId, {
      address: place.address?.trim() || null,
      lat: Number(place.lat),
      lon: Number(place.lon),
      validatedAt: customer.validated_at,
    });
  }
  return out;
}

/**
 * The validated place points of the given contacts. A contact missing from the map has no validated
 * place with a usable point. A failed read answers an EMPTY map, so the board falls back to the
 * check-ins it always used rather than losing the list.
 */
export async function loadValidatedPlacePoints(contactIds: readonly number[]): Promise<Map<number, ValidatedPlacePoint>> {
  const ids = [...new Set(contactIds.filter((id) => Number.isFinite(id) && id > 0))];
  if (ids.length === 0) return new Map();
  try {
    const db = getSupabaseAdmin();
    const customerColumns = `id, status, ${PHOENIX_VALIDATED_AT_COLUMN}, reference_contact_crm_id, own_contact_crm_id`;
    // By either contact id: a contact is carried over from iReports360 (reference) or minted by Phoenix
    // for a customer a rep added himself (own) — `phoenixContactId` decides which one he is known by.
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
    const wanted = new Set(ids);
    const customers = [...new Map([...byReference, ...byOwn].map((row) => [String(row.id), row])).values()].filter((row) => {
      const contactId = phoenixContactId(row);
      return contactId != null && wanted.has(contactId);
    });
    if (customers.length === 0) return new Map();
    const places = await readChunked<PlaceRow>(
      customers.map((row) => String(row.id)),
      (part) =>
        db
          .from("phoenix_crm_places")
          .select("customer_id, brick_name, created_at, address, lat, lon")
          .eq("is_test", false)
          .eq("status", "active")
          .in("customer_id", part),
    );
    return chooseValidatedPlacePoints(customers, places);
  } catch (error) {
    console.error("[reps-list] the validated place points could not be read; the list falls back to check-ins", error);
    return new Map();
  }
}
