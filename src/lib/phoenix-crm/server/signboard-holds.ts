/**
 * Phoenix CRM — a place the DOOR held because its signboard did not confirm the customer, and the
 * system's own work on it before the Super Admin is asked (owner, 2026-10-17).
 *
 * His words, asked on the Place checks page about the photos filed "Not readable": *"how come any
 * unreadable should be not validated, should be wait until the system check and I manual approve or
 * reject"* — answered "Hold; re-read; else you decide". So the door saves every unconfirmed place HELD
 * (`signboardDoorHolds`), the rep reads "The system is checking this place", and this file:
 *
 *   1. re-reads the place right after the rep's reply, then hourly, up to `SIGNBOARD_HELD_MAX_READS`
 *      reads in all (`rereadHeldPlaceSignboard`: a blind read, then a guided read whose answer only a
 *      blind close look may confirm);
 *   2. 🔴 APPROVES THE HOLD ITSELF ON A CONFIRMED MATCH, through the SAME
 *      `phoenix_crm_decide_validation_review` approve the Super Admin's own button runs, as the actor
 *      `SYSTEM` — so one approve path, one audit shape, and the board can say "the system" approved it;
 *   3. tells the Super Admin only when it is DONE — every read spent, nothing confirmed — rather than
 *      at the door, because until then there is nothing for him to decide.
 *
 * THREE THINGS IT NEVER DOES, each of which would look like a tidy-up:
 *
 *   - it never REJECTS. A frame nobody can read is the Super Admin's; the system only ever says yes;
 *   - it never touches a Google hold (`google.verdict` is a Google kind there, never `signboard`), nor a
 *     VENUE — a building is the Super Admin's own decision since he un-validated the 19 with no
 *     timetable (2026-10-17), and the first capture of a building never has one yet;
 *   - it never tells the rep anything. He reads his customer validated, or still being checked.
 */

import { hasAiApiKey } from "@/lib/ai/openai-client";
import { logError } from "@/lib/observability/log";
import type { OrgSeat } from "@/lib/phoenix-crm/scope";
import { callPhoenixCrm, selectByIds, throwIfError } from "@/lib/phoenix-crm/server/db";
import { loadPhoenixCrmOrg } from "@/lib/phoenix-crm/server/org";
import { recordPlaceSignboard, rereadHeldPlaceSignboard } from "@/lib/phoenix-crm/server/signboard-check";
import { notifyValidationReviewWaiting, withdrawValidationReviewWaiting } from "@/lib/phoenix-crm/server/validation-reviews";
import {
  heldSignboardCheckToKeep,
  heldSignboardOutcome,
  heldSignboardReaderIsDown,
  heldSignboardReadHappened,
  SIGNBOARD_HELD_MAX_READS,
  signboardApplies,
  signboardNameIsUsable,
  signboardReadsRecorded,
} from "@/lib/phoenix-crm/signboard-rules";
import type { PhoenixCrmListType } from "@/lib/phoenix-crm/types";
import { getSupabaseAdmin } from "@/lib/supabase/server";

type Row = Record<string, unknown>;

/**
 * Who decided, when the system did. Upper-case because `phoenix_crm_decide_validation_review`
 * upper-cases its actor, and the same word the manager-plan expiry already writes. No person has it.
 */
export const SIGNBOARD_SYSTEM_ACTOR = "SYSTEM";

/** The decision note the board shows beside "the system" — the one sentence of why. */
export const SIGNBOARD_SYSTEM_APPROVAL_NOTE = "The system read the customer's name on the signboard.";

/** Places re-read in one hourly run, and how long the run may keep starting them. */
export const HELD_SIGNBOARD_RECHECK_LIMIT = 12;
export const HELD_SIGNBOARD_RECHECK_BUDGET_MS = 50_000;
const HELD_SIGNBOARD_RECHECK_CONCURRENCY = 4;

export type HeldSignboardPlace = {
  reviewId: string;
  placeId: string;
  customerId: string;
  seatId: string;
  repHrId: string;
  isTest: boolean;
  photoPath: string;
  customerName: string;
  listType: PhoenixCrmListType;
  /** Reads already recorded on the place, the door's included. */
  readsSoFar: number;
};

export type HeldSignboardSettlement = "approved" | "again" | "done" | "lost" | "unread";

/**
 * Approve a held place as the system, because a reading confirmed the customer's name — through the SAME
 * `phoenix_crm_decide_validation_review` approve the Super Admin's own button runs. False when it did not
 * land: he decided it first (`review_decided`), or the review is gone, and his decision stands. One
 * approve for the hourly re-read, the one-off read of the old places and the rep's new photo alike.
 */
export async function approveHeldSignboardBySystem(reviewId: string): Promise<boolean> {
  try {
    await callPhoenixCrm<Row>("phoenix_crm_decide_validation_review", {
      p: {
        review_id: reviewId,
        actor_hr_id: SIGNBOARD_SYSTEM_ACTOR,
        decision: "approve",
        note: SIGNBOARD_SYSTEM_APPROVAL_NOTE,
        refusal_reason: null,
      },
    });
  } catch (error) {
    logError("Phoenix CRM held signboard approval did not land", {
      error,
      labels: { event: "phoenix_crm_held_signboard_approve_skipped" },
    });
    return false;
  }
  // A notice may already be in his bell from an older hold; it is answered now.
  await withdrawValidationReviewWaiting(reviewId);
  return true;
}

/**
 * Read one held place once more and act on what the read says. Never throws: it runs after a rep's
 * reply and inside a cron, and the place is already saved and held whatever happens here.
 *
 * `lost` is a place whose decision raced the Super Admin's own (he approved or rejected it first, and
 * the RPC answered `review_decided`) — his decision stands and nothing more is done. `unread` is a read
 * the reader never answered (`heldSignboardReadHappened`): nothing is written and nothing is spent.
 */
export async function settleHeldSignboard(
  place: HeldSignboardPlace,
  context: { seat: OrgSeat | undefined },
): Promise<HeldSignboardSettlement> {
  try {
    const read = await rereadHeldPlaceSignboard({
      customerName: place.customerName,
      listType: place.listType,
      photoPath: place.photoPath,
    });
    // No key, or a reader that never answered (out of credit, down, timing out), is no read at all:
    // nothing is spent, and the place waits for the next run.
    if (!heldSignboardReadHappened(read)) return "unread";
    const reads = place.readsSoFar + 1;
    const outcome = heldSignboardOutcome(read, reads);
    await recordPlaceSignboard(place.placeId, heldSignboardCheckToKeep(read, reads, outcome));

    if (outcome === "approve") return (await approveHeldSignboardBySystem(place.reviewId)) ? "approved" : "lost";
    if (outcome === "done" && !place.isTest && context.seat) {
      await notifyValidationReviewWaiting({
        customerName: place.customerName,
        repHrId: place.repHrId,
        reviewId: place.reviewId,
        seat: context.seat,
      });
    }
    return outcome;
  } catch (error) {
    logError("Phoenix CRM held signboard re-read failed", { error, labels: { event: "phoenix_crm_held_signboard_failed" } });
    return "again";
  }
}

/**
 * Every place held by the SIGNBOARD and still waiting, oldest hold first — the ones the system still
 * has reads left on. A review raised by Google carries a Google verdict and is never here.
 *
 * Read in two steps rather than one filter over a JSON number: the reads left are counted here, in
 * code, from the place's own stored check — a wrong JSON filter reads as an empty queue with nothing
 * going red (this module's own rule for the night's backlog).
 */
export async function loadHeldSignboardPlaces(options: { limit?: number; includeSpent?: boolean } = {}): Promise<HeldSignboardPlace[]> {
  // Every page, not the first 500: a caller asking "is this place held?" must never read a hold past
  // the cap as no hold at all. `limit` (none = every one) trims the result, never the read.
  const reviews: Row[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await getSupabaseAdmin()
      .from("phoenix_crm_validation_reviews")
      .select("id, place_id, customer_id, seat_id, is_test, created_by_hr_id, created_at")
      // Both kinds: a first validation, and another clinic of a customer already validated
      // (`added_place`), whose approve settles the review and leaves the customer as he is.
      .eq("status", "pending")
      .eq("is_test", false)
      .eq("google->>verdict", "signboard")
      .order("created_at", { ascending: true })
      .order("id", { ascending: true })
      .range(from, from + 999);
    throwIfError(error);
    const page = (data ?? []) as Row[];
    reviews.push(...page);
    if (page.length < 1000) break;
  }
  if (reviews.length === 0) return [];

  const [places, customers] = await Promise.all([
    selectByIds<Row>("phoenix_crm_places", "id, photo_path, status, signboard_check, shared_place_id", "id", reviews.map((row) => String(row.place_id))),
    selectByIds<Row>("phoenix_crm_customers", "id, name, list_type", "id", reviews.map((row) => String(row.customer_id))),
  ]);
  const placeById = new Map(places.map((row) => [String(row.id), row]));
  const customerById = new Map(customers.map((row) => [String(row.id), row]));

  const held: HeldSignboardPlace[] = [];
  for (const review of reviews) {
    const place = placeById.get(String(review.place_id));
    const customer = customerById.get(String(review.customer_id));
    if (!place || !customer || place.status !== "active" || place.shared_place_id) continue;
    const listType = String(customer.list_type ?? "") as PhoenixCrmListType;
    const customerName = String(customer.name ?? "");
    const photoPath = String(place.photo_path ?? "");
    if (!photoPath || !signboardApplies(listType) || !signboardNameIsUsable(customerName)) continue;
    const readsSoFar = signboardReadsRecorded(place.signboard_check);
    if (!options.includeSpent && readsSoFar >= SIGNBOARD_HELD_MAX_READS) continue;
    held.push({
      customerId: String(review.customer_id),
      customerName,
      isTest: review.is_test === true,
      listType,
      photoPath,
      placeId: String(review.place_id),
      readsSoFar,
      repHrId: String(review.created_by_hr_id ?? ""),
      reviewId: String(review.id),
      seatId: String(review.seat_id ?? ""),
    });
  }
  return options.limit === undefined ? held : held.slice(0, options.limit);
}

/** The ids of every place a signboard hold is waiting on — so the night's backlog leaves them to this file. */
export async function loadHeldSignboardPlaceIds(): Promise<Set<string>> {
  const held = await loadHeldSignboardPlaces({ includeSpent: true });
  return new Set(held.map((place) => place.placeId));
}

export type HeldSignboardRecheckResult = {
  read: number;
  approved: number;
  /** Places that spent their last read this run and are now the Super Admin's. */
  done: number;
  moreWaiting: boolean;
  /** Places the reader never answered; none of their reads was spent. */
  unread: number;
  skipped: "no_api_key" | "reader_unavailable" | null;
};

/**
 * The hourly re-read of held places — riding the visit roll-up's hourly fire, after it. Allowed to
 * throw on the queue read (the caller catches it, so the roll-up is never failed by it); never on one
 * place, because `settleHeldSignboard` swallows its own.
 */
export async function runHeldSignboardRecheck(
  options: { limit?: number; budgetMs?: number } = {},
): Promise<HeldSignboardRecheckResult> {
  const result: HeldSignboardRecheckResult = { approved: 0, done: 0, moreWaiting: false, read: 0, skipped: null, unread: 0 };
  if (!hasAiApiKey()) return { ...result, skipped: "no_api_key" };
  const limit = Math.max(1, Math.min(options.limit ?? HELD_SIGNBOARD_RECHECK_LIMIT, 50));
  const deadline = Date.now() + (options.budgetMs ?? HELD_SIGNBOARD_RECHECK_BUDGET_MS);
  const queue = await loadHeldSignboardPlaces({ limit });
  result.moreWaiting = queue.length >= limit;
  if (queue.length === 0) return result;
  const org = await loadPhoenixCrmOrg();

  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < queue.length) {
      if (Date.now() >= deadline) {
        result.moreWaiting = true;
        return;
      }
      // The reader is down (out of credit, say): stop asking it, and spend no place's reads on it.
      if (heldSignboardReaderIsDown({ answered: result.read, unread: result.unread })) {
        result.moreWaiting = true;
        result.skipped = "reader_unavailable";
        return;
      }
      const place = queue[next];
      next += 1;
      const settled = await settleHeldSignboard(place, { seat: org.seats.get(place.seatId) });
      if (settled === "unread") {
        result.unread += 1;
        continue;
      }
      result.read += 1;
      if (settled === "approved") result.approved += 1;
      if (settled === "done") result.done += 1;
    }
  };
  await Promise.all(Array.from({ length: Math.min(HELD_SIGNBOARD_RECHECK_CONCURRENCY, queue.length) }, () => worker()));
  return result;
}
