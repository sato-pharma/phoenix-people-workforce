/**
 * Place checks — the customers sent back to validate again, their count and their photographs.
 * Moved out of `validation-reviews.ts` unchanged on 23 Nov 2026, so no file of Place checks is over 400
 * lines; that file re-exports everything here that it exported, so import from it.
 */

import { formatPhoenixDateTime } from "@/lib/i18n/format";
import { isUuid } from "@/lib/phoenix-crm/plan-rules";
import { territoryName } from "@/lib/phoenix-crm/scope";
import { placeChecksSeatScope, readsCompanyPlaceChecks, type PhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { seatScoped, selectByIds, throwIfError } from "@/lib/phoenix-crm/server/db";
import { readEveryPage } from "@/lib/phoenix-crm/server/paged-read";
import { loadPeopleNames, nameOf, type PeopleNames } from "@/lib/phoenix-crm/server/people";
import { loadSharedPlaceRefusalsForCustomers } from "@/lib/phoenix-crm/server/shared-places";
import { validationRefusalLabel } from "@/lib/phoenix-crm/validation-feedback";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { decidedLater, deciderLabel, type Row, text } from "@/lib/phoenix-crm/server/validation-reviews/shared";
import type { ValidationBoardRead } from "@/lib/phoenix-crm/server/validation-reviews/types";

// ── Waiting to be captured again ────────────────────────────────────────────────────────────────

export type ReopenedCustomerRow = {
  customerId: string;
  customerName: string;
  listType: string;
  isTest: boolean;
  repName: string;
  territory: string;
  line: string | null;
  region: string | null;
  reopenedAt: string;
  reopenedAtText: string;
  /** Whole hours since he went back to To validate. The AGE is the point — see the header below. */
  waitingHours: number;
  /** What was wrong with the photo, as chosen — null for a refusal that predates the reason. */
  reasonLabel: string | null;
  /**
   * Who refused it and when (owner, 2026-10-20) — null when the refusal predates the record. 🔴 The name
   * is also null for a viewer who decides nothing.
   */
  refusedByName: string | null;
  refusedAtText: string | null;
  /**
   * The polyclinic or centre whose own refusal reopened him, when that is what happened — so the
   * reason above is read as being about the VENUE's photo and not about his own capture. Null for an
   * ordinary refusal of his own place, which is every row this list held before 2026-10-09.
   */
  sharedPlaceName: string | null;
  /** That venue's id, so the board files him under his building (owner, 2026-10-17). */
  sharedPlaceId: string | null;
};

/**
 * Every customer sent back to To validate by a refused place and not validated since — oldest wait
 * first.
 *
 * 🔴 IT CARRIES THE AGE, NOT A VERDICT (2026-10-08). Measured the day it landed: 0 of the 22 reopened
 * customers had been validated again, average wait 40.8 hours, oldest 76.7 — and nothing anywhere
 * said so, because "Validate again" lived only on the rep's own row. The module publishes no SLA, so
 * this invents none (`overdue` stays false on the Needs You board); it states how long each has waited.
 *
 * The same two worlds the rest of the page shows, each row marked, so a count here can never read 0
 * where the page lists a row. Paged with a total order, and it stops rather than refuses: it presents.
 */
/**
 * Whose name a sent-back customer's row carries (14 Nov 2026, owner: "fix the 'A rep' name on both
 * boards"). The rep who took the refused photo first; but a customer sent back by a clean-up rather than
 * a refused photo has no refusal to name anybody — measured on production the same day, 42 of the
 * customers waiting to be captured again had no refused review of their own, among them the ones the
 * 11 Nov bring-back fix returned at 01:52 — and every one of them was filed under one "A rep" line on the
 * place checks scorecard. Every one of them carries the rep who captured it, and all 17 of those people
 * have a name. So: the refusal's rep, then the capturer, then the seat's territory, and "A rep" only when
 * none of the three is on file.
 */
export function sentBackRepName(input: {
  names: PeopleNames;
  refusedBy: string | null | undefined;
  capturedBy: string | null | undefined;
  territory: string | null | undefined;
}): string {
  const refused = nameOf(input.names, input.refusedBy, "");
  if (refused) return refused;
  const captured = nameOf(input.names, input.capturedBy, "");
  if (captured) return captured;
  return input.territory?.trim() || "A rep";
}

export async function loadReopenedCustomers(viewer: PhoenixCrmViewer): Promise<ValidationBoardRead<ReopenedCustomerRow>> {
  const seats = placeChecksSeatScope(viewer);
  const decides = readsCompanyPlaceChecks(viewer);
  const read = await readEveryPage<Row>(
    () => {
      const query = getSupabaseAdmin()
        .from("phoenix_crm_customers")
        .select("id, seat_id, name, list_type, is_test, reopened_at, created_by_hr_id")
        .eq("status", "pending")
        .not("reopened_at", "is", null);
      return seatScoped(query, seats)
        .order("reopened_at", { ascending: true })
        .order("id", { ascending: true });
    },
    { maxRows: 5_000, whenFull: "stop", what: "The customers waiting to be captured again", uniqueBy: (row) => String(row.id) },
  );
  throwIfError(read.error);
  const customers = await withoutACaptureSince(read.rows);
  if (customers.length === 0) return { rows: [], capped: read.capped };

  // His own refusals and his building's are asked for together (23 Nov 2026): both read by customer only.
  const customerIds = customers.map((row) => String(row.id));
  const [reviews, viaVenue] = await Promise.all([
    selectByIds<Row>(
      "phoenix_crm_validation_reviews",
      "id, customer_id, status, refusal_reason, created_by_hr_id, decided_by_hr_id, decided_at",
      "customer_id",
      customerIds,
      (query) => query.eq("status", "rejected"),
    ),
    loadSharedPlaceRefusalsForCustomers(customerIds),
  ]);
  // The LATEST refusal per customer is the one he is waiting on.
  const latest = new Map<string, Row>();
  for (const review of reviews) {
    const customerId = String(review.customer_id);
    const current = latest.get(customerId);
    if (!current || decidedLater(review.decided_at, current.decided_at)) latest.set(customerId, review);
  }
  // 🔴 A VENUE'S REFUSAL WRITES NO REVIEW ROW FOR THE CUSTOMER, so the read above finds nothing for a
  // customer reopened by a rejected polyclinic and this list rendered "A rep" and "No reason was
  // chosen — refused before the reason list existed." while `no_signboard` sat on the venue (measured
  // on staging, 2026-10-09, both customers of one rejected venue). The reason lives on the venue and
  // the rep on the retired seating, so those are asked for.
  //
  // Phoenix CRM validation audit, 14 Nov 2026: asked for EVERY reopened customer, no longer only the
  // ones with no refused review of their own. A customer whose own place was refused once, who was then
  // seated in a building, and whose building was refused later, was shown under the OLD refusal: the
  // wrong reason, the wrong rep, the wrong date, and filed among the single clinics. Whichever refusal
  // was decided later is the one he is waiting on (`decidedLater`), and the row is built from that one.
  const names = await loadPeopleNames([
    ...[...latest.values()].map((row) => text(row.created_by_hr_id)),
    ...[...viaVenue.values()].map((row) => row.repHrId),
    ...[...latest.values()].map((row) => text(row.decided_by_hr_id)),
    ...[...viaVenue.values()].map((row) => row.decidedByHrId),
    ...customers.map((row) => text(row.created_by_hr_id)),
  ]);
  const now = Date.now();

  const rows = customers.map((row): ReopenedCustomerRow => {
    const ownRefusal = latest.get(String(row.id));
    const venueRefusal = viaVenue.get(String(row.id));
    // The later of the two refusals; with only one on file, that one. A building's refusal with no
    // instant on record (before 2026-10-20) never outranks a refusal of his own place that has one.
    const venueIsLater = venueRefusal !== undefined && (!ownRefusal || decidedLater(venueRefusal.decidedAt, ownRefusal.decided_at));
    const review = venueIsLater ? undefined : ownRefusal;
    const venue = venueIsLater ? venueRefusal : undefined;
    const seat = viewer.org.seats.get(String(row.seat_id));
    const reopenedAt = String(row.reopened_at);
    const refusedAt = review ? text(review.decided_at) : (venue?.decidedAt ?? null);
    const at = new Date(reopenedAt).getTime();
    return {
      customerId: String(row.id),
      customerName: String(row.name ?? "Unknown customer"),
      listType: String(row.list_type ?? ""),
      isTest: row.is_test === true,
      // The rep who took the refused photo — the occupant may since have changed.
      repName: sentBackRepName({
        names,
        refusedBy: review ? text(review.created_by_hr_id) : (venue?.repHrId ?? null),
        capturedBy: text(row.created_by_hr_id),
        territory: seat ? territoryName(seat) : null,
      }),
      territory: seat ? territoryName(seat) : "Territory no longer in the organogram",
      line: seat?.lineName ?? null,
      region: seat?.regionName ?? null,
      reopenedAt,
      reopenedAtText: formatPhoenixDateTime(reopenedAt),
      waitingHours: Number.isNaN(at) ? 0 : Math.max(0, Math.floor((now - at) / 3_600_000)),
      reasonLabel: validationRefusalLabel(review ? text(review.refusal_reason) : (venue?.refusalReason ?? null)),
      refusedByName: decides ? deciderLabel(names, review ? text(review.decided_by_hr_id) : (venue?.decidedByHrId ?? null)) : null,
      refusedAtText: refusedAt ? formatPhoenixDateTime(refusedAt) : null,
      sharedPlaceName: venue?.sharedPlaceName ?? null,
      sharedPlaceId: venue?.sharedPlaceId ?? null,
    };
  });
  return { rows, capped: read.capped };
}

/**
 * The sent-back customers who have NOT captured again (owner, 17 Nov 2026, the audit's wrong counts).
 * `reopened_at` is cleared only when the customer is validated, so a customer whose new capture is held,
 * or approved and waiting for its building, stayed under "waiting to be captured again" as well: the
 * scorecard counted him in Waiting and in Sent back, and Needs you listed him in both rows (10 real
 * customers on production that day). A place in use is a capture since the refusal — the refused place
 * itself was retired — so a customer with one is left out here and is counted where his capture is.
 */
async function withoutACaptureSince(customers: Row[]): Promise<Row[]> {
  if (customers.length === 0) return customers;
  const places = await selectByIds<Row>("phoenix_crm_places", "id, customer_id", "customer_id", customers.map((row) => String(row.id)), (query) =>
    query.eq("status", "active"),
  );
  const capturedAgain = new Set(places.map((row) => String(row.customer_id)));
  return customers.filter((row) => !capturedAgain.has(String(row.id)));
}

/** A customer's places in use, joined so the count below keeps only the customers with none. */
const NO_PLACE_IN_USE_JOIN = "active_place:phoenix_crm_places!phoenix_crm_places_customer_id_fkey(id)";

/**
 * How many customers wait to be captured again, and since when — the figure the Needs You board asks.
 * The same customers the page lists (`loadReopenedCustomers`): real entries only, because the page draws
 * no test entry, and without anybody who has captured again (`withoutACaptureSince`).
 *
 * A head count plus the oldest stamp, so PostgREST's 1,000-row ceiling cannot shorten it and the backlog's
 * size never decides its cost (17 Nov 2026). The database leaves out a customer with a place in use itself:
 * his active places are joined over the named key and only the customers with none are kept
 * (`is(…, null)`) — on production that day 237 of 247, the same 237 and the same oldest stamp as reading
 * every one and taking away those with a place. Throws on a failed read: the board turns that into "could
 * not be read", never a zero it cannot prove.
 */
export async function countReopenedCustomersWaiting(): Promise<{ count: number; oldestAt: string | null }> {
  const supabase = getSupabaseAdmin();
  const [waiting, oldest] = await Promise.all([
    supabase
      .from("phoenix_crm_customers")
      .select(`id, ${NO_PLACE_IN_USE_JOIN}`, { count: "exact", head: true })
      .eq("status", "pending")
      .eq("is_test", false)
      .not("reopened_at", "is", null)
      .eq("active_place.status", "active")
      .is("active_place", null),
    supabase
      .from("phoenix_crm_customers")
      .select(`reopened_at, ${NO_PLACE_IN_USE_JOIN}`)
      .eq("status", "pending")
      .eq("is_test", false)
      .not("reopened_at", "is", null)
      .eq("active_place.status", "active")
      .is("active_place", null)
      .order("reopened_at", { ascending: true })
      .order("id", { ascending: true })
      .limit(1),
  ]);
  throwIfError(waiting.error);
  throwIfError(oldest.error);
  const first = ((oldest.data ?? []) as Row[])[0];
  return { count: waiting.count ?? 0, oldestAt: first ? String(first.reopened_at) : null };
}

/**
 * The photo each "Validate again" notice is about, for the "New for you" strip (owner, 19 Nov 2026:
 * "render those validation photos here"). The notice's key carries the review id — or, for a refused
 * polyclinic or centre, the building's own id (`notifyRepsOfRefusedSharedPlace`) — so both are asked
 * for at once and whichever answers gives the photo: the place's signboard, or the building's door.
 *
 * It is the rep's OWN picture, the one the notice already tells him to take again — never a distance, a
 * reading or a decider (golden rule #1). At most a handful of ids (the strip names four), so three tiny
 * reads; the caller still checks every path against the viewer's reach before it is drawn.
 */
export async function loadValidateAgainPhotoPaths(ids: readonly string[]): Promise<Map<string, string>> {
  const wanted = [...new Set(ids.filter((id) => isUuid(id)))];
  const photos = new Map<string, string>();
  if (wanted.length === 0) return photos;
  const [reviews, buildings] = await Promise.all([
    selectByIds<{ id: string; place_id: string | null }>("phoenix_crm_validation_reviews", "id, place_id", "id", wanted),
    selectByIds<{ id: string; photo_path: string | null }>("phoenix_crm_shared_places", "id, photo_path", "id", wanted),
  ]);
  for (const building of buildings) {
    if (building.photo_path) photos.set(String(building.id), building.photo_path);
  }
  const places = await selectByIds<{ id: string; photo_path: string | null }>(
    "phoenix_crm_places",
    "id, photo_path",
    "id",
    reviews.map((review) => review.place_id),
  );
  const placePhoto = new Map(places.map((place) => [String(place.id), place.photo_path]));
  for (const review of reviews) {
    const path = review.place_id ? placePhoto.get(String(review.place_id)) : null;
    if (path) photos.set(String(review.id), path);
  }
  return photos;
}
