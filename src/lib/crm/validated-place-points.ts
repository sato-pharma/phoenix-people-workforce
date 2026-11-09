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
 *
 * ## The brick comes from Phoenix CRM too (owner, 2026-10-31)
 *
 * "donot show no crm region from the address get the brick area and region … any data anywhere depending
 * on data from ireports must shift to pulling its data from phoenix crm". A doctor a rep added in Phoenix
 * CRM has no iReports360 contact, so the list used to file every one of them under "No CRM region
 * recorded" (Shahd's 122 doctors on 2026-10-31, all of them). Phoenix CRM already knows where each one is:
 *
 *   - a validated doctor's place was filed in a brick when it was captured (`phoenix_crm_places.brick_id`,
 *     the same place the KPIs count him under);
 *   - a doctor still waiting to be validated carries the "where to find" the SFE wrote on the list sheet
 *     (`phoenix_crm_customers.intake_where`, e.g. "Damanhor-Behira I-Alex": locality, area, region).
 *
 * This file reads both; `reps-list.ts` decides the order.
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

type PlaceRow = KpiBrickPlace & { address: string | null; brick_id: string | null; lat: number | null; lon: number | null };

type CustomerRow = KpiBrickCustomer & { intake_where: string | null };

/** What Phoenix CRM knows about where each contact on a list is. */
export type PhoenixContactPlaces = {
  /** The brick id the validated place was filed in. Missing when not validated, or filed in no brick. */
  brickIds: Map<number, string>;
  /** The SFE sheet's "where to find" text, for a contact Phoenix CRM holds one for. */
  intakes: Map<number, string>;
  /** The validated place's point, kept only when it is a usable fix. */
  points: Map<number, ValidatedPlacePoint>;
  /**
   * When each contact was validated — every validated, not-dropped customer, with or without a usable
   * place, so a doctor validated with a poor fix still reads "Validated" (owner, 2026-11-09: "in rep
   * list show what's validated").
   */
  validatedAt: Map<number, string>;
  /** False when Phoenix CRM could not be read: the board then says so instead of "Not validated yet". */
  read: boolean;
};

const EMPTY_PLACES = (read = true): PhoenixContactPlaces => ({
  brickIds: new Map(),
  intakes: new Map(),
  points: new Map(),
  read,
  validatedAt: new Map(),
});

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
 * When each contact was validated. Pure. A dropped customer is not validated on anyone's list; when two
 * customers carry one contact (two reps, or carried over and added), the EARLIEST validation answers.
 */
export function chooseValidatedDates(
  customers: ReadonlyArray<Pick<CustomerRow, "status" | "validated_at" | "reference_contact_crm_id" | "own_contact_crm_id">>,
): Map<number, string> {
  const out = new Map<number, string>();
  for (const row of customers) {
    const at = String(row.validated_at ?? "").trim();
    if (!at || String(row.status ?? "").trim().toLowerCase() === "dropped") continue;
    const contactId = phoenixContactId(row);
    if (contactId == null) continue;
    const before = out.get(contactId);
    if (!before || Date.parse(at) < Date.parse(before)) out.set(contactId, at);
  }
  return out;
}

/** The brick id each contact's validated place was filed in — the SAME place `chooseValidatedPlacePoints` reads. */
export function chooseValidatedPlaceBricks(
  customers: readonly KpiBrickCustomer[],
  places: readonly PlaceRow[],
): Map<number, string> {
  const out = new Map<number, string>();
  for (const [contactId, { place }] of chooseValidatedPlaces(customers, places)) {
    const brickId = place.brick_id?.trim();
    if (brickId) out.set(contactId, brickId);
  }
  return out;
}

/**
 * The "where to find" of each contact: from a customer still on a list before a dropped one, then the
 * latest validated, then the lowest id so the answer never depends on read order.
 */
export function chooseIntakeWhere(customers: readonly CustomerRow[]): Map<number, string> {
  const held = new Map<number, CustomerRow>();
  const active = (row: CustomerRow) => String(row.status ?? "").trim().toLowerCase() !== "dropped";
  for (const row of customers) {
    if (!row.intake_where?.trim()) continue;
    const contactId = phoenixContactId(row);
    if (contactId == null) continue;
    const before = held.get(contactId);
    const better =
      !before ||
      (active(row) && !active(before)) ||
      (active(row) === active(before) &&
        ((row.validated_at ?? "") > (before.validated_at ?? "") ||
          ((row.validated_at ?? "") === (before.validated_at ?? "") && row.id < before.id)));
    if (better) held.set(contactId, row);
  }
  return new Map([...held].map(([contactId, row]) => [contactId, String(row.intake_where).trim()]));
}

/**
 * What Phoenix CRM knows about where the given contacts are: each validated place's point and brick,
 * and each customer's "where to find". A failed read answers EMPTY maps, so the board falls back to the
 * check-ins and the iReports360 mapping it always used rather than losing the list.
 */
export async function loadPhoenixContactPlaces(contactIds: readonly number[]): Promise<PhoenixContactPlaces> {
  const ids = [...new Set(contactIds.filter((id) => Number.isFinite(id) && id > 0))];
  if (ids.length === 0) return EMPTY_PLACES();
  try {
    const db = getSupabaseAdmin();
    const customerColumns = `id, status, ${PHOENIX_VALIDATED_AT_COLUMN}, reference_contact_crm_id, own_contact_crm_id, intake_where`;
    // By either contact id: a contact is carried over from iReports360 (reference) or minted by Phoenix
    // for a customer a rep added himself (own) — `phoenixContactId` decides which one he is known by.
    // Every customer, validated or not: a doctor still waiting carries the SFE's "where to find".
    const readBy = (column: "reference_contact_crm_id" | "own_contact_crm_id") =>
      readChunked<CustomerRow>(ids, (part) =>
        db.from("phoenix_crm_customers").select(customerColumns).eq("is_test", false).in(column, part),
      );
    const [byReference, byOwn] = await Promise.all([readBy("reference_contact_crm_id"), readBy("own_contact_crm_id")]);
    const wanted = new Set(ids);
    const customers = [...new Map([...byReference, ...byOwn].map((row) => [String(row.id), row])).values()].filter((row) => {
      const contactId = phoenixContactId(row);
      return contactId != null && wanted.has(contactId);
    });
    if (customers.length === 0) return EMPTY_PLACES();
    const validated = customers.filter((row) => row.validated_at);
    const places =
      validated.length === 0
        ? []
        : await readChunked<PlaceRow>(
            validated.map((row) => String(row.id)),
            (part) =>
              db
                .from("phoenix_crm_places")
                .select("customer_id, brick_id, brick_name, created_at, address, lat, lon")
                .eq("is_test", false)
                .eq("status", "active")
                .in("customer_id", part),
          );
    return {
      brickIds: chooseValidatedPlaceBricks(validated, places),
      intakes: chooseIntakeWhere(customers),
      points: chooseValidatedPlacePoints(validated, places),
      read: true,
      validatedAt: chooseValidatedDates(customers),
    };
  } catch (error) {
    console.error("[reps-list] Phoenix CRM's places could not be read; the list falls back to check-ins and the iReports360 mapping", error);
    return EMPTY_PLACES(false);
  }
}
