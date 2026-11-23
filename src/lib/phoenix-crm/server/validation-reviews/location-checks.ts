/**
 * Place checks — the hold on a rep's list, and the count of what waits on the Super Admin.
 * Moved out of `validation-reviews.ts` unchanged on 23 Nov 2026, so no file of Place checks is over 400
 * lines; that file re-exports everything here that it exported, so import from it.
 */

import type { LocationCheckState } from "@/lib/phoenix-crm/google-place-rules";
import { parsePlaceRecommendation } from "@/lib/phoenix-crm/place-note-rules";
import { selectByIds, throwIfError } from "@/lib/phoenix-crm/server/db";
import { readEveryPage } from "@/lib/phoenix-crm/server/paged-read";
import { sharedPlaceIsOnTheBoard } from "@/lib/phoenix-crm/server/shared-places";
import { needsYouDecisionCountWithSfe } from "@/lib/phoenix-crm/shared-place-groups";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { mapWithConcurrency } from "@/lib/reconciliation/concurrency";
import { activePlaceIds, decidedLater, isRecord, reviewStillToDecide, type Row, text } from "@/lib/phoenix-crm/server/validation-reviews/shared";

// ── What the rep's own list reads ───────────────────────────────────────────────────────────────

/** One customer's standing, as his own list reads it. */
export type LocationCheckReading = {
  state: LocationCheckState;
  /**
   * What is wrong with the PHOTO, from `@/lib/phoenix-crm/validation-feedback`, on a `not_confirmed`
   * row only. Null for a refusal decided before `refusal_reason` existed, and for every other state.
   */
  reason: string | null;
  decidedAt: string | null;
};

/**
 * Each customer's check, as his list shows it: `checking` while one waits, `not_confirmed` when the
 * latest one was turned down, and with it the one sentence he is told about his own picture. A customer
 * never held is simply absent.
 *
 * 🔴 IT PAGES, AND THE ORDER IS A TOTAL ONE. This ran on `.limit(1000)` until 2026-10-08, which on a
 * busy seat silently answered about its newest thousand reviews and left an older `not_confirmed`
 * reading as nothing at all. `created_at desc` ALONE is not enough either — two reviews written in the
 * same millisecond make the walk both skip and repeat at the page seam, and here that would flicker a
 * rep's own row between "Validate again" and nothing between two reloads of the same list.
 */
export async function loadLocationChecks(seatId: string, isTest: boolean): Promise<Map<string, LocationCheckReading>> {
  const { rows, error } = await readEveryPage<Row>(
    () =>
      getSupabaseAdmin()
        .from("phoenix_crm_validation_reviews")
        .select("id, customer_id, place_id, status, created_at, decided_at, refusal_reason")
        .eq("seat_id", seatId)
        .eq("is_test", isTest)
        .order("created_at", { ascending: false })
        .order("id", { ascending: false }),
    {
      maxRows: 5_000,
      // It PRESENTS, it does not JUDGE — and newest first means a ceiling loses only the oldest
      // answers, which are the ones a customer has already moved on from.
      whenFull: "stop",
      what: "The validation checks on this territory's customers",
      uniqueBy: (row) => String(row.id),
    },
  );
  throwIfError(error);
  // Phoenix CRM validation audit, 14 Nov 2026: a waiting review says "checking" only while its place is
  // still in use. A review left pending on a retired place (a rejected building, a place removed from the
  // list) is nobody's to decide, and it kept the rep's row on "checking" with no way out.
  const inUse = await activePlaceIds(rows.filter((row) => row.status === "pending").map((row) => text(row.place_id)));
  const checks = new Map<string, LocationCheckReading>();
  // Phoenix CRM validation audit, 14 Nov 2026: his latest ANSWER is the row decided last, not the row
  // created last. A place has one review row for all time, so refusing a place approved weeks ago decides
  // an old row today; read by `created_at`, a newer approval of another place of his hid that refusal and
  // his list never said "Validate again". The board's reopened list reads `decided_at`, and so does this.
  const answered = new Map<string, Row>();
  for (const row of rows) {
    const customerId = String(row.customer_id);
    if (row.status === "pending") {
      if (inUse.has(String(row.place_id))) checks.set(customerId, { decidedAt: null, reason: null, state: "checking" });
      continue;
    }
    const current = answered.get(customerId);
    if (!current || decidedLater(row.decided_at, current.decided_at)) answered.set(customerId, row);
  }
  for (const [customerId, row] of answered) {
    // A waiting one already spoke.
    if (checks.has(customerId)) continue;
    const rejected = row.status === "rejected";
    checks.set(customerId, {
      decidedAt: rejected ? text(row.decided_at) : null,
      reason: rejected ? text(row.refusal_reason) : null,
      state: rejected ? "not_confirmed" : null,
    });
  }
  return checks;
}

/** Whether a customer's place is with the Super Admin right now. */
export async function pendingLocationReview(customerId: string): Promise<boolean> {
  // Phoenix CRM validation audit, 14 Nov 2026: this was a head count of every pending review, so a
  // review left pending on a retired place held the customer's requests for ever. It reads the places
  // the pending reviews are about and counts only the ones still in use (`activePlaceIds`).
  const { data, error } = await getSupabaseAdmin()
    .from("phoenix_crm_validation_reviews")
    .select("place_id")
    .eq("customer_id", customerId)
    .eq("status", "pending");
  throwIfError(error);
  const waiting = ((data ?? []) as Row[]).map((row) => text(row.place_id));
  if (waiting.length === 0) return false;
  return (await activePlaceIds(waiting)).size > 0;
}

/**
 * Which of these customers' places are with the Super Admin right now — `pendingLocationReview` for a
 * whole page of request cards in one read per chunk, so a card can say a request waits on Place checks
 * before anyone presses an Approve the server would refuse. Throws on a failed read, like the single one.
 */
export async function pendingLocationReviewCustomers(customerIds: ReadonlyArray<string>): Promise<Set<string>> {
  const unique = [...new Set(customerIds)];
  const held = new Set<string>();
  // Four chunks at a time, merged in chunk order (2026-10-31, "fix the slowest five pages"): on a wide scope the chunks
  // were read one after another.
  const slices: string[][] = [];
  for (let start = 0; start < unique.length; start += 150) slices.push(unique.slice(start, start + 150));
  const answers = await mapWithConcurrency(slices, 4, async (slice) =>
    getSupabaseAdmin().from("phoenix_crm_validation_reviews").select("customer_id, place_id").in("customer_id", slice).eq("status", "pending"),
  );
  const waiting: Row[] = [];
  for (const { data, error } of answers) {
    throwIfError(error);
    waiting.push(...((data ?? []) as Row[]));
  }
  // Phoenix CRM validation audit, 14 Nov 2026: the same test as the single check above. A pending
  // review whose place is retired holds nobody, so a request card is not told to wait on it.
  const inUse = await activePlaceIds(waiting.map((row) => text(row.place_id)));
  for (const row of waiting) {
    if (inUse.has(String(row.place_id))) held.add(String(row.customer_id));
  }
  return held;
}

/**
 * How many places are waiting on his decision right now, and when the oldest of them was held — the
 * one figure the central Needs You board asks of this queue (`src/lib/needs-you`, added 2026-10-05).
 *
 * 🔴 REAL ENTRIES ONLY, BECAUSE THE PAGE DRAWS NO TEST ENTRY (owner, 17 Nov 2026, the audit's wrong
 * counts). Until then it counted both worlds, on the ground that the page listed both; the page has drawn
 * no test entry anywhere since 2026-10-17 (`isReal`, "a report that really shows me data"), so one held
 * test validation read "1 place is held for your approval" over a page that showed none.
 *
 * 🔴 AND IT COUNTS THE WAY THE NEEDS YOU TAB COUNTS — a building is one decision, held or with anybody
 * waiting behind it (`needsYouDecisionCount`); review rows alone missed every held building.
 *
 * 🔴 AND WHAT THE SFE MANAGER RECOMMENDED ON IS COUNTED APART (22 Nov 2026, the deep audit). Place checks
 * hands those to the SFE recommendations page, so counting them here read 25 more than the page drew, on
 * a row that opened a page where they were nowhere. `sfeRecommended` is that page's own figure, a held
 * building he recommended on counted once and taken off the board with its customers; they are still
 * the Super Admin's alone to decide (`needsYouDecisionCountWithSfe`).
 *
 * Read whole and paged, so PostgREST's 1,000-row ceiling cannot shorten it, with the oldest stamp so the
 * row can state its age. It THROWS on a failed read, and on a read it could not finish: the board turns a
 * rejection into its amber "could not be read" row, and a zero it cannot prove is the one shape that
 * board must never have.
 */
export async function countValidationReviewsWaiting(): Promise<{
  count: number;
  oldestAt: string | null;
  /** The checks the SFE Manager recommended on, waiting on the SFE recommendations page instead. */
  sfeRecommended: { count: number; oldestAt: string | null };
}> {
  // 🔴 ONLY WHAT CAN STILL BE DECIDED IS COUNTED (owner, 14 Nov 2026, the items the audit left). A review
  // left pending on a retired place (a rejected building, a place removed from the list) is nobody's to
  // decide and the page no longer lists it (`reviewStillToDecide`), so a head count of every pending
  // review would read 1 where the page shows nothing. The waiting rows are read whole, paged, oldest
  // first, and the places they are about are asked for their status and building. Still throws on a failed read.
  const supabase = getSupabaseAdmin();
  const [{ rows, error, capped }, heldRead] = await Promise.all([
    readEveryPage<Row>(
      () =>
        supabase
          .from("phoenix_crm_validation_reviews")
          .select("id, place_id, status, created_at")
          .eq("status", "pending")
          .eq("is_test", false)
          .order("created_at", { ascending: true })
          .order("id", { ascending: true }),
      { maxRows: 50_000, whenFull: "stop", what: "The place checks waiting", uniqueBy: (row) => String(row.id) },
    ),
    readEveryPage<Row>(
      () =>
        supabase
          .from("phoenix_crm_shared_places")
          .select("id, status, is_test, created_at")
          .eq("status", "held")
          .eq("is_test", false)
          .order("created_at", { ascending: true })
          .order("id", { ascending: true }),
      { maxRows: 10_000, whenFull: "stop", what: "The buildings held for a decision", uniqueBy: (row) => String(row.id) },
    ),
  ]);
  throwIfError(error);
  throwIfError(heldRead.error);
  if (capped || heldRead.capped) throw new Error("The place checks waiting could not be counted whole.");
  // Each place's building comes joined into the same read, over its named key, so no lookup by id waits
  // behind it (17 Nov 2026). What the SFE Manager recommended on is read beside it, in the same wave.
  const placeIds = [...new Set(rows.map((row) => String(row.place_id)))];
  const [places, sfe] = await Promise.all([
    selectByIds<Row>(
      "phoenix_crm_places",
      "id, status, shared_place_id, venue:phoenix_crm_shared_places!phoenix_crm_places_shared_place_id_fkey(id, status, is_test, retired_at)",
      "id",
      placeIds,
    ),
    loadSfeRecommendedSubjects(
      placeIds,
      heldRead.rows.map((row) => String(row.id)),
    ),
  ]);
  const placeById = new Map(places.map((row) => [String(row.id), row]));
  const waiting = rows.filter((row) => reviewStillToDecide(row, placeById));
  const buildingOf = (row: Row) => text(placeById.get(String(row.place_id))?.shared_place_id);
  const venues = waiting.flatMap((row) => {
    const venue: unknown = placeById.get(String(row.place_id))?.venue;
    return isRecord(venue) ? [venue] : [];
  });
  const venuesOnBoard = new Set([...venues, ...heldRead.rows].filter(sharedPlaceIsOnTheBoard).map((row) => String(row.id)));
  return needsYouDecisionCountWithSfe({
    waiting: waiting.map((row) => ({ id: String(row.id), at: String(row.created_at), placeId: String(row.place_id), sharedPlaceId: buildingOf(row) })),
    heldVenues: heldRead.rows.map((row) => ({ id: String(row.id), at: String(row.created_at) })),
    venuesOnBoard,
    sfeRecommendedPlaces: sfe.places,
    sfeRecommendedVenues: sfe.venues,
  });
}

/**
 * The waiting places and held buildings the SFE Manager has recommended on — read as the board's own
 * note index reads them (`loadPlaceNoteIndex`): his rows only, and a recommendation the code does not know
 * is none, so `sfeRecommendationOf` and this agree on every row. It throws on a failed read, like the count.
 */
async function loadSfeRecommendedSubjects(
  placeIds: ReadonlyArray<string>,
  venueIds: ReadonlyArray<string>,
): Promise<{ places: Set<string>; venues: Set<string> }> {
  const columns = "id, place_id, shared_place_id, recommendation, writer_role";
  const [onPlaces, onVenues] = await Promise.all([
    selectByIds<Row>("phoenix_crm_place_recommendations", columns, "place_id", placeIds),
    selectByIds<Row>("phoenix_crm_place_recommendations", columns, "shared_place_id", venueIds),
  ]);
  const bySfeManager = (row: Row) => row.writer_role === "sfe_manager" && parsePlaceRecommendation(row.recommendation) !== null;
  return {
    places: new Set(onPlaces.filter(bySfeManager).map((row) => String(row.place_id))),
    venues: new Set(onVenues.filter(bySfeManager).map((row) => String(row.shared_place_id))),
  };
}
