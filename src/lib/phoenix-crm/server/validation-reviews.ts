/**
 * Phoenix CRM — places the Google Maps check could not confirm, and the administrator's decision on each.
 *
 * Owner, 2026-10-03: an account Google has no listing for is "held for review and only system admin can
 * approve or reject … but do not show the rep that a person is accepting or rejecting — show him that
 * it's automated from system". Widened 2026-10-19 to the SFE Manager, who sees the same page and takes
 * the same decisions. So:
 *   · TWO deciders, one predicate: the Super Admin and the SFE Manager (`canDecideValidationReviews`),
 *     never a test account and never a district manager. The page lives under /admin, a tree a rep
 *     cannot open.
 *   · The rep reads only `locationCheck` on his own list ("checking" / "not_confirmed"), worded as the
 *     system's (google-place-rules.ts). Nothing he receives names who decided, or that anybody did.
 *
 * The writes are `phoenix_crm_validate_customer` / `phoenix_crm_add_place` (the hold) and
 * `phoenix_crm_decide_validation_review` (the decision) — migration 20261003130536.
 */

import { forbiddenError, notFoundError, validationError } from "@/lib/http/api-errors";
import { formatPhoenixDateTime } from "@/lib/i18n/format";
import { withdrawInAppNotificationsByEventKeyPrefix } from "@/lib/notifications/in-app";
import { phoenixCrmChannels } from "@/lib/notifications/phoenix-crm-channel-guard";
import { resolveHrIdsForRole } from "@/lib/notifications/role-recipients";
import { createSystemNotificationForRecipients } from "@/lib/notifications/system";
import { logError } from "@/lib/observability/log";
import { cleanText } from "@/lib/phoenix-crm/entry-rules";
import { distanceMeters, type GeoPoint } from "@/lib/phoenix-crm/geo";
import type { GoogleListing, LocationCheckState } from "@/lib/phoenix-crm/google-place-rules";
import { isUuid } from "@/lib/phoenix-crm/plan-rules";
import {
  parseScheduleHeldBecause,
  parseScheduleLegibility,
  parseScheduleProblem,
  type ScheduleHeldBecause,
  type ScheduleLegibility,
  type ScheduleProblem,
} from "@/lib/phoenix-crm/schedule-rules";
import { territoryName, type OrgSeat } from "@/lib/phoenix-crm/scope";
import { canDecideValidationReviews, placeChecksSeatScope, type PhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { callPhoenixCrm, numberOrNull, seatScoped, selectByIds, throwIfError } from "@/lib/phoenix-crm/server/db";
import { readEveryPage } from "@/lib/phoenix-crm/server/paged-read";
import { notifyPhoenixCrm, PHOENIX_CRM_NOTIFICATION_CATEGORY, PHOENIX_CRM_NOTIFICATION_MODULE } from "@/lib/phoenix-crm/server/notifications";
import { loadPeopleNames, nameOf } from "@/lib/phoenix-crm/server/people";
import { restampVisitLocationsQuietly } from "@/lib/phoenix-crm/server/visit-locations";
import { loadSharedPlaceNames, loadSharedPlaceRefusalsForCustomers } from "@/lib/phoenix-crm/server/shared-places";
import {
  parseSignboardPhotoProblem,
  signboardHoldStillReading,
  signboardRetakeWaiting,
  type SignboardPhotoProblem,
} from "@/lib/phoenix-crm/signboard-rules";
import {
  parseValidationRefusalReason,
  validationRefusalLabel,
  VALIDATION_REASON_REQUIRED,
  type ValidationPhotoKind,
} from "@/lib/phoenix-crm/validation-feedback";
import { invalidateMyMapSnapshotCache } from "@/lib/dashboard/invalidation";
import { getSupabaseAdmin } from "@/lib/supabase/server";

type Row = Record<string, unknown>;

/** Where the Super Admin and the SFE Manager decide them. */
export const VALIDATION_REVIEWS_PATH = "/admin/field-crm/validation-reviews";

/** How long a decided review stays on the page beside the waiting ones. */
const DECIDED_SHOWN_DAYS = 14;

/**
 * How long a REJECTED review stays, which is longer — because it still carries an action.
 *
 * 🔴 THE 14-DAY WINDOW WAS ABOUT TO TAKE THE UNDO WITH IT. `Approve it after all` lives on the
 * rejected row, so a rejection that scrolls off the page cannot be taken back by anybody: measured
 * 2026-10-15, all 49 of production's rejected reviews were inside 14 days, and the oldest (5 October)
 * would have lost its undo on the 19th — silently, with nothing going red. 90 days covers "I rejected
 * that last month by mistake"; a rejection whose place is no longer retired has nothing left to undo
 * and falls back under the ordinary window.
 */
const REJECTED_SHOWN_DAYS = 90;

/**
 * The decider, and the seat scope of a Place checks read — BOTH declared in `server/access.ts` and
 * re-exported here under the names every caller already imports. The reason they cannot live in this
 * file is written out where they are: one of the four section reads is the venue board in
 * `server/shared-places.ts`, which this file imports from, so declaring them here and importing them
 * there would close a cycle.
 */
export { canDecideValidationReviews, placeChecksSeatScope } from "@/lib/phoenix-crm/server/access";

function text(value: unknown): string | null {
  const cleaned = typeof value === "string" ? value.trim() : "";
  return cleaned ? cleaned : null;
}

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
        .select("id, customer_id, status, created_at, decided_at, refusal_reason")
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
  const checks = new Map<string, LocationCheckReading>();
  for (const row of rows) {
    const customerId = String(row.customer_id);
    if (row.status === "pending") {
      checks.set(customerId, { decidedAt: null, reason: null, state: "checking" });
      continue;
    }
    // Newest first: the first decided row is his latest answer, unless a waiting one already spoke.
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
  const { count, error } = await getSupabaseAdmin()
    .from("phoenix_crm_validation_reviews")
    .select("id", { count: "exact", head: true })
    .eq("customer_id", customerId)
    .eq("status", "pending");
  throwIfError(error);
  return (count ?? 0) > 0;
}

/**
 * Which of these customers' places are with the Super Admin right now — `pendingLocationReview` for a
 * whole page of request cards in one read per chunk, so a card can say a request waits on Place checks
 * before anyone presses an Approve the server would refuse. Throws on a failed read, like the single one.
 */
export async function pendingLocationReviewCustomers(customerIds: ReadonlyArray<string>): Promise<Set<string>> {
  const unique = [...new Set(customerIds)];
  const held = new Set<string>();
  for (let start = 0; start < unique.length; start += 150) {
    const { data, error } = await getSupabaseAdmin()
      .from("phoenix_crm_validation_reviews")
      .select("customer_id")
      .in("customer_id", unique.slice(start, start + 150))
      .eq("status", "pending");
    throwIfError(error);
    for (const row of data ?? []) held.add(String(row.customer_id));
  }
  return held;
}

/**
 * How many places are waiting on his decision right now, and when the oldest of them was held — the
 * one figure the central Needs You board asks of this queue (`src/lib/needs-you`, added 2026-10-05).
 *
 * 🔴 THE SAME TWO WORLDS THE PAGE SHOWS, and so no `is_test` filter. `loadValidationReviews` lists
 * every waiting review and marks each row's world rather than hiding one, so a count that filtered
 * either way would read 0 where the page shows a row — the under-report that `needs-you/types.ts`
 * exists to make impossible. The decider is the Super Admin alone and his own entries are test
 * entries (owner, 2026-09-16), so a real-only count would be a board permanently calm about the only
 * queue that is his by name.
 *
 * A head count, so PostgREST's 1,000-row ceiling cannot shorten it, plus the oldest stamp so the row
 * can state its age. It THROWS on a failed read: the board turns a rejection into its amber "could
 * not be read" row, and a zero it cannot prove is the one shape that board must never have.
 */
export async function countValidationReviewsWaiting(): Promise<{ count: number; oldestAt: string | null }> {
  const supabase = getSupabaseAdmin();
  const [waiting, oldest] = await Promise.all([
    supabase.from("phoenix_crm_validation_reviews").select("id", { count: "exact", head: true }).eq("status", "pending"),
    supabase.from("phoenix_crm_validation_reviews").select("created_at").eq("status", "pending").order("created_at", { ascending: true }).limit(1),
  ]);
  throwIfError(waiting.error);
  throwIfError(oldest.error);
  const first = ((oldest.data ?? []) as Row[])[0];
  return { count: waiting.count ?? 0, oldestAt: first ? String(first.created_at) : null };
}

// ── Telling the Super Admin ─────────────────────────────────────────────────────────────────────

function reviewNoticeKey(reviewId: string): string {
  return `phoenix_crm:validation_review:${reviewId}`;
}

/**
 * The decider the system writes when it approves a held signboard (`SIGNBOARD_SYSTEM_ACTOR` in
 * server/signboard-holds.ts, which imports this file — so the word is restated here rather than
 * imported back, and `tests/phoenix-crm-held-signboard.test.ts` holds the two equal).
 */
const SYSTEM_DECIDER = "SYSTEM";

/** Who decided a review, as a word the screen can print: the system's own word, a person's name, or nothing. */
function deciderLabel(names: Awaited<ReturnType<typeof loadPeopleNames>>, hrId: string | null): string | null {
  if (!hrId) return null;
  return hrId === SYSTEM_DECIDER ? "The system" : nameOf(names, hrId, "") || null;
}

/** Answer the "waiting for you" notice of one review — when the system approved it first. Never throws. */
export async function withdrawValidationReviewWaiting(reviewId: string): Promise<void> {
  if (!reviewId) return;
  await withdrawInAppNotificationsByEventKeyPrefix(reviewNoticeKey(reviewId)).catch(() => undefined);
}

/**
 * A held place is waiting, to every Super Admin — which in practice is the owner alone.
 *
 * 🔴 EMAIL, IN-APP AND TELEGRAM (and the phone), BY HIS OWN ORDER (owner, 2026-10-05, naming the page:
 * "when an update here /admin/field-crm/validation-reviews I must be notified by email, in app and
 * telegram"). This is the module's one email that goes nowhere but to him, so the volume argument that
 * keeps the rest of Phoenix CRM email-free does not apply. The channels are NOT written out here: they
 * come from `phoenixCrmChannels`, whose allowlist is the single place the module's email exception is
 * declared and the only place the guard will honour — naming them here would be a second truth that
 * the guard silently overrules.
 *
 * Never throws: the place is already saved, and a notice that cannot be sent must not turn the rep's
 * save into an error.
 */
export async function notifyValidationReviewWaiting(input: { customerName: string; seat: OrgSeat; repHrId: string; reviewId: string | null }): Promise<void> {
  if (!input.reviewId) return;
  try {
    const [{ hrIds }, names] = await Promise.all([resolveHrIdsForRole("Super Admin", "Phoenix CRM — validation reviews"), loadPeopleNames([input.repHrId])]);
    const recipients = hrIds.filter((hrId) => !hrId.startsWith("TEST-"));
    if (recipients.length === 0) return;
    const rep = nameOf(names, input.repHrId, "A rep");
    await createSystemNotificationForRecipients(
      {
        actionUrl: VALIDATION_REVIEWS_PATH,
        category: PHOENIX_CRM_NOTIFICATION_CATEGORY,
        channels: phoenixCrmChannels("validation_review_waiting"),
        eventType: "validation_review_waiting",
        message: `${rep} validated ${input.customerName} (${territoryName(input.seat)}), and the system could not confirm it — against Google Maps, or from its signboard. It waits for your decision.`,
        metadata: { idempotencyKey: reviewNoticeKey(input.reviewId), seatId: input.seat.seatId },
        module: PHOENIX_CRM_NOTIFICATION_MODULE,
        priority: "normal",
        recordId: input.reviewId,
        subjectHrId: input.repHrId,
        telegram: { ctaLabel: "Open the reviews", ctaUrl: VALIDATION_REVIEWS_PATH },
        title: `Place to check: ${input.customerName}`,
      },
      recipients,
    );
  } catch (error) {
    logError("Phoenix CRM validation review notice failed", { error, labels: { event: "phoenix_crm_validation_review_notify_failed" } });
  }
}

// ── Telling the rep what is wrong with his photo (2026-10-08) ───────────────────────────────────

/** Every "validate this one again" notice ever raised about one customer — every review, both worlds. */
export function validationNotConfirmedKeyPrefix(customerId: string): string {
  return `phoenix_crm:validation_not_confirmed:${customerId}:`;
}

/**
 * Withdraw the rep's "validate again" notice about one customer — when he has validated him again,
 * and when the refusal is taken back. A bell left asking for something already done is the exact
 * frustration the owner named. Never throws.
 */
export async function withdrawValidationNotConfirmed(customerId: string): Promise<void> {
  if (!customerId) return;
  await withdrawInAppNotificationsByEventKeyPrefix(validationNotConfirmedKeyPrefix(customerId)).catch(() => undefined);
}

/**
 * Tell the rep, in-app only, that one customer is back under To validate and what is wrong with his
 * photo. Built from what `phoenix_crm_decide_validation_review` returns, so no second read is made.
 *
 * 🔴 ONLY WHEN THE CUSTOMER IS REALLY BACK UNDER TO VALIDATE. A rejected SECOND place of a customer who
 * keeps another one changes nothing on his list, and a bell about it would be a judgement with nothing
 * for him to do — the very thing Golden Rule #1 keeps off his phone. Never throws.
 */
async function tellRepValidateAgain(viewer: PhoenixCrmViewer, result: Row): Promise<void> {
  try {
    const customerId = text(result.customer_id);
    const repHrId = text(result.rep_hr_id);
    const reviewId = text(result.review_id);
    const seat = viewer.org.seats.get(String(result.seat_id));
    if (!customerId || !repHrId || !reviewId || !seat) return;
    const { data, error } = await getSupabaseAdmin().from("phoenix_crm_customers").select("status").eq("id", customerId).maybeSingle();
    throwIfError(error);
    if ((data as Row | null)?.status !== "pending") return;
    await notifyPhoenixCrm(
      {
        kind: "validation_not_confirmed",
        seat,
        repHrId,
        customerId,
        customerName: text(result.customer_name) ?? "A customer",
        reviewId,
        reason: parseValidationRefusalReason(result.refusal_reason),
      },
      result.is_test === true,
    );
  } catch (error) {
    logError("Phoenix CRM validate-again notice failed", { error, labels: { event: "phoenix_crm_validate_again_notify_failed" } });
  }
}

// ── The Super Admin's page ──────────────────────────────────────────────────────────────────────

export type ValidationReviewReading = { lat: number; lon: number; accuracyMeters: number | null };

export type ValidationReviewRow = {
  reviewId: string;
  /**
   * The PLACE this review is about. Carried since 2026-10-13 because a comment and a recommendation
   * hang off the place, not off the review: a place has exactly one review row for all time
   * (`phoenix_crm_validation_reviews_place_idx`), while most of the places a manager comments on have
   * no review row at all — 598 of the module's first 643 had never been looked at by anybody.
   */
  placeId: string;
  status: "pending" | "approved" | "rejected";
  kind: "validation" | "added_place";
  isTest: boolean;
  createdAt: string;
  createdAtText: string;
  repName: string;
  territory: string;
  /** The seat's line and region, carried apart from `territory` so the page can filter by each. */
  line: string | null;
  region: string | null;
  customerName: string;
  listType: string;
  speciality: string | null;
  placeLabel: string | null;
  address: string | null;
  brickName: string | null;
  areaName: string | null;
  point: { lat: number; lon: number };
  mapsLink: string;
  pin: ValidationReviewReading | null;
  photo: ValidationReviewReading | null;
  /** The signboard photo, signed on the page by the CRM's own photo link (the Super Admin reads all). */
  photoPath: string | null;
  /**
   * Why the system held it, and every listing Google returned for the name. Since 2026-10-08 a place
   * can also be held for what its SIGNBOARD says (`sign_other_name` / `sign_no_name`), and since
   * 2026-10-09 for what the TIMETABLE inside a polyclinic says (`schedule_other_name` /
   * `schedule_missing`); the record sits in the same `google` column either way — see
   * `signboardHoldRecord` for why that column's name is the wrong one rather than the code.
   */
  reason:
    | "no_confident_listing"
    | "lookup_failed"
    | "listing_far"
    | "listing_off"
    | "refused_by_admin"
    | "sign_other_name"
    | "sign_no_name"
    | "schedule_other_name"
    | "schedule_missing"
    | null;
  /**
   * WHICH PHOTO this row is about, so the Super Admin is offered only the refusal reasons that can
   * honestly be said about it (`reasonsFor`): a timetable is paper on purpose, so "a photo of paper,
   * not a building" must never be offered on one.
   */
  photoKind: ValidationPhotoKind;
  /** The polyclinic or centre the customer is seated in — set on a timetable hold only. */
  sharedPlaceName: string | null;
  /**
   * The venue this place is seated in, read off the PLACE row and so set whatever the hold was about
   * (owner, 2026-10-17: group every polyclinic with the customers in it). `sharedPlaceName` above
   * rides the hold's record and is null on a review that is not a timetable hold; this is how the
   * Place checks board files every such row under its building instead of among the single clinics.
   */
  sharedPlaceId: string | null;
  /** The hours read beside this customer's name on the timetable, as written. Evidence, never parsed. */
  hoursRead: string | null;
  /**
   * The evidence the system's RECOMMENDATION is built from (owner, 2026-10-17: "add system
   * recommendations to approve or no on every validation … and the reason"): the record's own reason
   * as written (`unreadable`, `call_failed` …, which the narrower `reason` above drops), why the
   * timetable scanner held it and how much of the board it could read, and what was read on the
   * place's own signboard — a Google hold carries no reading of the sign in its record, but the place
   * row does. See `place-check-advice.ts`.
   */
  evidence: {
    checkReason: string | null;
    heldBecause: ScheduleHeldBecause | null;
    legibility: ScheduleLegibility | null;
    problem: ScheduleProblem | null;
    signboard: {
      verdict: "match" | "other_name" | "no_name" | "unjudged";
      reason: string | null;
      signText: string | null;
      problem?: SignboardPhotoProblem | null;
    } | null;
  };
  /** What the system read on the signboard — or on the timetable — verbatim. */
  signText: string | null;
  /** The names the system read on it, people and places together, for the Super Admin's eye. */
  signNames: string[];
  /**
   * The OTHER signs that were in the same photograph, as read — the clothes shop beside the practice,
   * the room number, the pharmacy next door.
   *
   * 🔴 IT IS WHY THE VERDICT IS WHAT IT IS. Four of the five holds of 2026-10-09 were a second sign in
   * the frame, and the board showed only the one that had been judged, so nothing on the screen could
   * tell him that the sign quoted to him was a clothes shop. Empty for a timetable hold and for a hold
   * recorded before the reader returned a list.
   */
  otherSigns: string[];
  /** What was wrong with the photo, as the Super Admin chose it on a rejection — his label, not the rep's sentence. */
  refusalLabel: string | null;
  query: string | null;
  listings: Array<GoogleListing & { distanceMeters: number }>;
  decidedByName: string | null;
  decidedAtText: string | null;
  /** The raw instant, for the reads and filters that compare it. `decidedAtText` is for the screen. */
  decidedAt: string | null;
  decisionNote: string | null;
  /**
   * Whether this rejection can still be taken back (owner, 2026-10-03: "add the option to approve
   * after reject"): the place is still retired, and nothing newer has been said about it.
   */
  restorable: boolean;
  /**
   * Whether this APPROVAL can still be taken back (owner, 2026-10-15: "make admin able to reject
   * validation even if approved before"): the place it approved is still active, so rejecting it now
   * has something to retire. The mirror image of `restorable`, and the same test the database makes.
   */
  refusable: boolean;
  /**
   * A door signboard hold the system is still re-reading (owner, 2026-10-17: "Hold; re-read; else you
   * decide"). He may still decide it now; the row says the system has not finished with it.
   */
  systemStillReading: boolean;
  /**
   * Whether the board shows this row with no decider chosen: waiting, decided in the last 14 days, or a
   * rejection still taken back within 90. Always true unless the read asked for `everyDecision`.
   */
  recent: boolean;
};

function reading(lat: unknown, lon: unknown, accuracy: unknown): ValidationReviewReading | null {
  const latitude = numberOrNull(lat);
  const longitude = numberOrNull(lon);
  return latitude === null || longitude === null ? null : { lat: latitude, lon: longitude, accuracyMeters: numberOrNull(accuracy) };
}

function listingsOf(google: Row, point: GeoPoint): Array<GoogleListing & { distanceMeters: number }> {
  const raw = Array.isArray(google.listings) ? (google.listings as Row[]) : [];
  const listings: Array<GoogleListing & { distanceMeters: number }> = [];
  for (const listing of raw) {
    const lat = numberOrNull(listing.lat);
    const lon = numberOrNull(listing.lon);
    if (lat === null || lon === null) continue;
    listings.push({
      placeId: String(listing.placeId ?? ""),
      name: String(listing.name ?? ""),
      lat,
      lon,
      mapsUri: text(listing.mapsUri),
      distanceMeters: distanceMeters(point, { lat, lon }),
    });
  }
  return listings.sort((left, right) => left.distanceMeters - right.distanceMeters);
}

/** A read the page presents, and whether it stopped at its ceiling so the page can say so honestly. */
export type ValidationBoardRead<T> = { rows: T[]; capped: boolean };

/**
 * Every waiting review, and the ones decided in the last two weeks — newest first.
 *
 * 🔴 IT PAGES (2026-10-08). It ran on `.limit(500)`, which silently answered about the newest 500 and
 * presented that as the queue. The order is a TOTAL one (`created_at`, then `id`) or the walk skips and
 * repeats at a page seam; `whenFull: "stop"` because this read PRESENTS rather than judges, and newest
 * first means a ceiling loses only the oldest — which `capped` then says out loud.
 */
export async function loadValidationReviews(
  viewer: PhoenixCrmViewer,
  options: {
    /**
     * Every decision ever made, not only the recent ones (owner, 2026-10-26: "view only approved by me or
     * only by khaled bedair"). 🔴 THE 14-DAY WINDOW WOULD HAVE HIDDEN 86 OF HIS 480 DECISIONS, so a
     * "Decided by" filter on the recent read alone answers a smaller number than the one he was told. The
     * Super Admin's page asks for it (772 decisions in all, 2026-10-26); each row says whether it is
     * `recent`, and the board shows the others only while a decider is chosen.
     */
    everyDecision?: boolean;
  } = {},
): Promise<ValidationBoardRead<ValidationReviewRow>> {
  const seats = placeChecksSeatScope(viewer);
  const since = new Date(Date.now() - DECIDED_SHOWN_DAYS * 86_400_000).toISOString();
  const rejectedSince = new Date(Date.now() - REJECTED_SHOWN_DAYS * 86_400_000).toISOString();
  const read = await readEveryPage<Row>(
    () => {
      const base = getSupabaseAdmin()
        .from("phoenix_crm_validation_reviews")
        .select(
          "id, seat_id, customer_id, place_id, is_test, kind, status, google, created_by_hr_id, created_at, decided_by_hr_id, decided_at, decision_note, refusal_reason",
        );
      // A rejection keeps its undo for longer than an ordinary decided row keeps its place on the
      // page — see REJECTED_SHOWN_DAYS. The place's own status is not on this table, so a rejection
      // with nothing left to undo is dropped after the read, below.
      const query = options.everyDecision
        ? base
        : base.or(`status.eq.pending,decided_at.gte.${since},and(status.eq.rejected,decided_at.gte.${rejectedSince})`);
      return seatScoped(query, seats)
        .order("created_at", { ascending: false })
        .order("id", { ascending: false });
    },
    { maxRows: 5_000, whenFull: "stop", what: "The place checks waiting and decided", uniqueBy: (row) => String(row.id) },
  );
  throwIfError(read.error);
  const reviews = read.rows;
  if (reviews.length === 0) return { rows: [], capped: false };

  const customerIds = [...new Set(reviews.map((row) => String(row.customer_id)))];
  const placeIds = [...new Set(reviews.map((row) => String(row.place_id)))];
  // selectByIds, never a bare `.in()`: at the page's 500-review cap these id lists can cross the ~395
  // that overflows the request headers (see selectByIds / the postgrest-in memory note).
  const [customers, places] = await Promise.all([
    selectByIds<Row>("phoenix_crm_customers", "id, name, list_type, speciality", "id", customerIds),
    selectByIds<Row>(
      "phoenix_crm_places",
      "id, label, address, brick_name, area_name, lat, lon, pin_lat, pin_lon, pin_accuracy_meters, photo_lat, photo_lon, photo_accuracy_meters, photo_path, status, shared_place_id, signboard_check",
      "id",
      placeIds,
    ),
  ]);
  const customerById = new Map(customers.map((row) => [String(row.id), row]));
  const placeById = new Map(places.map((row) => [String(row.id), row]));
  const names = await loadPeopleNames(reviews.flatMap((row) => [text(row.created_by_hr_id), text(row.decided_by_hr_id)]));

  const rows = reviews.map((row): ValidationReviewRow => {
    const customer = customerById.get(String(row.customer_id)) ?? {};
    const place = placeById.get(String(row.place_id)) ?? {};
    const google = (row.google && typeof row.google === "object" ? row.google : {}) as Row;
    const point = { lat: numberOrNull(place.lat) ?? 0, lon: numberOrNull(place.lon) ?? 0 };
    const seat = viewer.org.seats.get(String(row.seat_id));
    const photoPath = text(place.photo_path);
    const status = row.status === "approved" || row.status === "rejected" ? row.status : "pending";
    const reason =
      google.reason === "no_confident_listing" ||
      google.reason === "lookup_failed" ||
      google.reason === "listing_far" ||
      google.reason === "listing_off" ||
      google.reason === "refused_by_admin" ||
      google.reason === "sign_other_name" ||
      google.reason === "sign_no_name" ||
      google.reason === "schedule_other_name" ||
      google.reason === "schedule_missing"
        ? google.reason
        : null;
    // A signboard hold carries what was read; a Google hold does not, and reads as nothing here.
    const signboard = google.verdict === "signboard";
    // A TIMETABLE hold rides the same column with `verdict: "schedule"` (scheduleHoldRecord): what was
    // read is the schedule's text and the people named on it, so it is shown in the same two fields.
    const schedule = google.verdict === "schedule";
    const signNames = signboard
      ? [...(Array.isArray(google.personNames) ? google.personNames : []), ...(Array.isArray(google.placeNames) ? google.placeNames : [])]
          .map((name) => text(name))
          .filter((name): name is string => name !== null)
      : schedule
        ? (Array.isArray(google.personNames) ? google.personNames : []).map((name) => text(name)).filter((name): name is string => name !== null)
        : [];
    // Every sign the reader saw, minus the one quoted above — kept in the record's own order, which
    // puts the judged sign first.
    const judgedText = signboard ? text(google.signText) : null;
    const otherSigns = signboard && Array.isArray(google.signs)
      ? (google.signs as Row[])
          .map((sign) => (sign && typeof sign === "object" ? text(sign.text) : null))
          .filter((sign): sign is string => sign !== null && sign !== judgedText)
          .slice(0, 6)
      : [];
    const venue = schedule && google.sharedPlace && typeof google.sharedPlace === "object" ? (google.sharedPlace as Row) : null;
    return {
      // 🔴 THE RECORD DECIDES, NEVER THE PLACE ROW. A seating is `point_source = 'shared_place'`, but a
      // seated place can later be MOVED by the Super Admin, which rewrites that column — and this row
      // is about the photo that was taken, which does not change when the point does.
      photoKind: schedule ? "schedule" : "signboard",
      sharedPlaceName: venue ? text(venue.name) : null,
      sharedPlaceId: text(place.shared_place_id),
      hoursRead: schedule ? text(google.hoursRead) : null,
      evidence: {
        checkReason: text(google.reason),
        heldBecause: schedule ? parseScheduleHeldBecause(google.heldBecause) : null,
        legibility: schedule ? parseScheduleLegibility(google.legibility) : null,
        problem: schedule ? parseScheduleProblem(google.problem) : null,
        signboard: signboardOf(place.signboard_check),
      },
      signText: signboard || schedule ? text(signboard ? google.signText : google.scheduleText) : null,
      signNames,
      otherSigns,
      refusalLabel: status === "rejected" ? validationRefusalLabel(text(row.refusal_reason)) : null,
      placeId: String(row.place_id),
      reviewId: String(row.id),
      status,
      kind: row.kind === "added_place" ? "added_place" : "validation",
      isTest: row.is_test === true,
      createdAt: String(row.created_at),
      createdAtText: formatPhoenixDateTime(String(row.created_at)),
      repName: nameOf(names, text(row.created_by_hr_id), "A rep"),
      territory: seat ? territoryName(seat) : "Territory no longer in the organogram",
      line: seat?.lineName ?? null,
      region: seat?.regionName ?? null,
      customerName: String(customer.name ?? "Unknown customer"),
      listType: String(customer.list_type ?? ""),
      speciality: text(customer.speciality),
      placeLabel: text(place.label),
      address: text(place.address),
      brickName: text(place.brick_name),
      areaName: text(place.area_name),
      point,
      mapsLink: `https://www.google.com/maps/search/?api=1&query=${point.lat},${point.lon}`,
      pin: reading(place.pin_lat, place.pin_lon, place.pin_accuracy_meters),
      photo: reading(place.photo_lat, place.photo_lon, place.photo_accuracy_meters),
      photoPath,
      reason,
      query: text(google.query),
      listings: listingsOf(google, point),
      // The system approves a held signboard itself once a reading confirms the customer (2026-10-17,
      // server/signboard-holds.ts), as the actor SYSTEM — a word no person carries, shown as a word.
      decidedByName: deciderLabel(names, text(row.decided_by_hr_id)),
      decidedAtText: text(row.decided_at) ? formatPhoenixDateTime(String(row.decided_at)) : null,
      decidedAt: text(row.decided_at),
      decisionNote: text(row.decision_note),
      // One review row per place (the UNIQUE index), so this row IS the place's whole story: a
      // rejection can be taken back while the place it retired is still retired, and since
      // 2026-10-15 an APPROVAL can be taken back while the place it approved is still active.
      restorable: status === "rejected" && place.status === "retired",
      refusable: status === "approved" && place.status === "active",
      systemStillReading: signboardHoldStillReading({
        isTest: row.is_test === true,
        pending: status === "pending",
        signboardHold: signboard,
        stored: place.signboard_check,
      }),
      recent: true,
    };
  });
  // 🔴 THE LONGER WINDOW IS FOR THE UNDO, NOT FOR THE HISTORY. A rejection older than the ordinary
  // 14 days is kept only while it can still be taken back — its place still retired. One whose place
  // is active again, or gone, has nothing left to reverse, so it drops back under the ordinary window
  // rather than sitting on a working screen for three months. The history is in
  // `phoenix_crm_list_events`, as it always was.
  // The same two windows the narrow read asks the database for, applied here so the wide read can say
  // of every row whether it is one the board shows by default.
  for (const row of rows) {
    const decided = row.decidedAt;
    row.recent =
      row.status === "pending" || decided === null || decided >= since || (row.status === "rejected" && row.restorable && decided >= rejectedSince);
  }
  const keep = options.everyDecision ? rows : rows.filter((row) => row.recent);
  return { rows: keep, capped: read.capped };
}

// ── The decision ────────────────────────────────────────────────────────────────────────────────

/**
 * Approve or reject one held place. Approve validates a held customer in the rep's own name; reject
 * retires the place and, when it was his only one, sends him back to To validate.
 *
 * 🔴 A REJECTION NOW CARRIES WHAT IS WRONG WITH THE PHOTO, AND THE REP IS TOLD IT (owner, 2026-10-08:
 * "tell the rep why"). The reason is REQUIRED on a reject and never asked on an approve; it is one of
 * the eight in validation-feedback.ts, and the rep reads only its sentence about his own picture —
 * never the free-text note, never who decided, never that anybody did. The note is OPTIONAL and always
 * was on this path.
 *
 * 🔴 AND A REJECT IS ACCEPTED ON A REVIEW THIS PAGE ALREADY APPROVED (owner, 2026-10-15: "make admin
 * able to reject validation even if approved before"). `phoenix_crm_decide_validation_review` lets
 * that one case through its `review_decided` guard since migration 20261015212903, so the undo of an
 * approval runs the SAME reject as a held place's — same events, same restamp, same one sentence to
 * the rep — and the review row KEEPS the evidence the system held it on. Approving an approved review,
 * and anything at all on a rejected one, still raise `review_decided`; taking a REJECTION back is
 * `restoreValidation` below.
 */
export async function decideValidationReview(viewer: PhoenixCrmViewer, raw: unknown): Promise<{ reviewId: string; status: "approved" | "rejected" }> {
  if (!canDecideValidationReviews(viewer)) throw forbiddenError("Only the Super Admin and the SFE Manager decide these.");
  const body = (raw && typeof raw === "object" ? raw : {}) as Row;
  if (!isUuid(body.reviewId)) throw validationError("Choose the place to decide.");
  const decision = body.decision === "approve" ? "approve" : body.decision === "reject" ? "reject" : null;
  if (!decision) throw validationError("Choose approve or reject.");
  const refusalReason = decision === "reject" ? parseValidationRefusalReason(body.refusalReason) : null;
  if (decision === "reject" && !refusalReason) throw validationError(VALIDATION_REASON_REQUIRED);
  const reviewId = String(body.reviewId).toLowerCase();
  // `review_not_found` and `review_decided` come back worded by the module's refusal table (db.ts).
  const result = await callPhoenixCrm<Row>("phoenix_crm_decide_validation_review", {
    p: { review_id: reviewId, actor_hr_id: viewer.hrId, decision, note: cleanText(body.note, 500), refusal_reason: refusalReason },
  });
  // A retired place changes what every visit to the customer is measured against.
  if (decision === "reject") {
    await restampVisitLocationsQuietly({
      seatId: String(result.seat_id),
      isTest: result.is_test === true,
      customerId: String(result.customer_id),
      actorHrId: viewer.hrId,
      settings: viewer.config.settings,
      scope: "all",
    });
  }
  // The "waiting for you" notice is answered.
  await withdrawInAppNotificationsByEventKeyPrefix(reviewNoticeKey(reviewId)).catch(() => undefined);
  // And the rep is told what is wrong with his photo — in-app only, about his picture alone.
  if (decision === "reject") await tellRepValidateAgain(viewer, result);
  // A rejected place leaves My map; its landing cards read again rather than waiting out their minute.
  invalidateMyMapSnapshotCache("phoenix-crm-decide-validation-review");
  return { reviewId, status: decision === "approve" ? "approved" : "rejected" };
}

/**
 * Take a rejection back (owner, 2026-10-03: "add the option to approve after reject"). The place comes
 * back, and the customer is validated again in the REP's own name where the rejection had sent him to
 * To validate — he did validate it, and a reversal does not take that away from him.
 *
 * The place's one review row turns from `rejected` to `approved` (it is UNIQUE per place), carrying who
 * rejected it and why in its `google` payload, beside the four events the list keeps. The rep's list
 * simply stops saying "Validate again", with no word about a person (golden rule #1).
 *
 * 🔴 THE NOTE IS OPTIONAL SINCE 2026-10-15 (owner: "admin comment is optional"). It was required here
 * and on the refusal below, on the reasoning that a decision reversed in silence cannot be understood
 * months later — and what that produced was a dash: 22 of the module's first 24 refusals carried the
 * single character `-`. Who reversed it, when, and what the rejection had said are all on the record
 * either way (`decided_by_hr_id`, `decided_at`, and the `google` payload the function carries over).
 */
export async function restoreValidation(viewer: PhoenixCrmViewer, raw: unknown): Promise<{ reviewId: string; validated: boolean }> {
  if (!canDecideValidationReviews(viewer)) throw forbiddenError("Only the Super Admin and the SFE Manager decide these.");
  const body = (raw && typeof raw === "object" ? raw : {}) as Row;
  if (!isUuid(body.reviewId)) throw validationError("Choose the rejection to take back.");
  const note = cleanText(body.note, 500);

  // `review_not_found`, `review_not_rejected` and `place_not_retired` come back worded by the
  // module's refusal table (db.ts).
  const result = await callPhoenixCrm<Row>("phoenix_crm_restore_validation", {
    p: { review_id: String(body.reviewId).toLowerCase(), actor_hr_id: viewer.hrId, note },
  });
  // The place is measurable again, so every visit to the customer gets its distance back.
  await restampVisitLocationsQuietly({
    seatId: String(result.seat_id),
    isTest: result.is_test === true,
    customerId: String(result.customer_id),
    actorHrId: viewer.hrId,
    settings: viewer.config.settings,
    scope: "all",
  });
  // The refusal is taken back, so the bell that asked him to capture it again goes with it.
  await withdrawValidationNotConfirmed(String(result.customer_id));
  return { reviewId: String(result.review_id), validated: result.validated === true };
}

// ── Refusing a validation the system never held ─────────────────────────────────────────────────

/**
 * Only AM customers are checked against Google (`googleCheckApplies`), so a DOCTOR's validation — and
 * any AM one that matched its listing — is never held and never reaches the queue above. There was no
 * way to undo one: on 2026-10-03 a rep's validation had to be refused by hand in SQL.
 *
 * This is that, as a button. It writes the SAME review row the automatic check would have written —
 * `refused_by_admin`, in the rep's name, decided by the Super Admin — and then runs the SAME
 * `phoenix_crm_decide_validation_review` reject. So there is one reject path, one audit shape, and the
 * rep's own list reads `not_confirmed` in the system's automated wording either way (golden rule #1:
 * "do not show the rep that a person is accepting or rejecting").
 */

export type ValidatedPlaceRow = {
  placeId: string;
  customerId: string;
  customerName: string;
  listType: string;
  speciality: string | null;
  isTest: boolean;
  repName: string;
  territory: string;
  /** The seat's line and region, carried apart from `territory` so the page can filter by each. */
  line: string | null;
  region: string | null;
  validatedAt: string;
  validatedAtText: string;
  placeLabel: string | null;
  address: string | null;
  brickName: string | null;
  areaName: string | null;
  point: { lat: number; lon: number };
  mapsLink: string;
  pin: ValidationReviewReading | null;
  photo: ValidationReviewReading | null;
  photoPath: string | null;
  /** Visits already measured against this place — refusing it un-places every one of them. */
  visits: number;
  /** Other active places this customer has: when there are none, refusing sends him back to To validate. */
  otherPlaces: number;
  /**
   * Whether ANY review row exists for this place, whatever its status. False is "never looked at by
   * anybody" — 598 of the first 643 places, which nothing on this page could say until 2026-10-08.
   */
  reviewed: boolean;
  /**
   * Who approved this place and when, from its one review row (owner, 2026-10-20). Null for a place
   * nobody has decided, and for a decision that predates the record.
   */
  decidedByName: string | null;
  decidedAtText: string | null;
  /**
   * What the system read on this place's signboard: null when it has not been read yet. A verdict,
   * never a decision — the Super Admin decides each one himself (owner, 2026-10-08).
   */
  /**
   * 🔴 `reason` IS CARRIED BECAUSE `unjudged` IS FOUR DIFFERENT ANSWERS SINCE 2026-10-09, and one
   * sentence for all four would be wrong for three of them: a frame that will be read again, one
   * that has had every attempt it gets, a verdict two readings disagreed about, and a place there is
   * nothing to compare at all. Before the re-read existed they were one state and one sentence.
   */
  signboard: {
    verdict: "match" | "other_name" | "no_name" | "unjudged";
    reason: string | null;
    signText: string | null;
    /** The photo shows no readable name and the rep has been asked for a new one (2026-10-18). */
    retake?: boolean;
    /** What the reader said stops the name being read; `none` is a legible sign that did not confirm. */
    problem?: SignboardPhotoProblem | null;
  } | null;
  /**
   * Which photo this place's evidence IS — the sign on a building, or the timetable of a polyclinic —
   * so the refusal pick-list offered here matches the one the hold queue offers (`reasonsFor`).
   *
   * Read from `shared_place_id`, not from `point_source`: a seated place the Super Admin later MOVES
   * becomes `point_source = 'moved'`, and its evidence is still a timetable.
   */
  photoKind: ValidationPhotoKind;
  /** The polyclinic or centre this place sits in, when it is seated in one. */
  sharedPlaceName: string | null;
  /** That venue's id, so the board files this place under its building (owner, 2026-10-17). */
  sharedPlaceId: string | null;
  /**
   * What the system read on the timetable: null when this place is not seated or was not read. The
   * reason, legibility and problem are the recommendation's evidence (`place-check-advice.ts`).
   */
  schedule: {
    verdict: "match" | "other_name" | "no_schedule" | "unjudged";
    scheduleText: string | null;
    hoursRead: string | null;
    reason?: string | null;
    legibility?: ScheduleLegibility | null;
    problem?: ScheduleProblem | null;
  } | null;
};

/**
 * Every place still active and not already waiting in the queue above — newest first, so "he just
 * validated this, take it back" is the top row.
 *
 * 🔴 NO DATE FLOOR AND NO 400-ROW CAP ANY MORE (2026-10-08). It read the newest 400 of the last 30 days,
 * so on the day it was measured the page showed 400 of 612 and presented that as the field — and the
 * 30-day floor made the board's own "Any time" period a lie. The whole set goes to the browser on
 * purpose: the board filters rep, line, region, area, list, period and text IN THE BROWSER, so a server
 * page would make every filter answer about one page. It pages with a total order and stops at a
 * ceiling far above the field, and says so when it does.
 *
 * 🔴 THE PAGES WALK THE PRIMARY KEY; THE NEWEST-FIRST ORDER IS MADE HERE, NOT IN THE DATABASE (production
 * read audit, 28 Oct 2026). There is no index on `created_at`, so `ORDER BY created_at DESC, id DESC`
 * made every one of the ~5 pages a load reads scan and sort the whole table (4,178 rows at about 1.8 KB
 * each) to return 1,000 of them — 1,440 calls, 116 s over 25–28 Oct. `id` alone is still a total order,
 * which is all the pager needs, and the primary key serves it with no sort. The rows are then put back
 * in `created_at desc, id desc` by `newestValidatedFirst`, so the board shows exactly the order it did.
 * At the ceiling the read keeps the first 10,000 by id rather than the newest — with the whole table
 * under half of that, today's answer is the same, and `capped` still says when it happens.
 */
export async function loadValidatedPlaces(viewer: PhoenixCrmViewer): Promise<ValidationBoardRead<ValidatedPlaceRow>> {
  const seats = placeChecksSeatScope(viewer);
  const read = await readEveryPage<Row>(
    () => {
      const query = getSupabaseAdmin()
        .from("phoenix_crm_places")
        .select(
          // 🔴 ONE STRING, AND A COLUMN THAT IS NOT THERE YET FAILS THE WHOLE READ. `shared_place_id`
          // and `schedule_check` arrive with migration 20261010013001, which reaches staging and
          // production before this file ships.
          "id, seat_id, customer_id, is_test, label, address, brick_name, area_name, lat, lon, pin_lat, pin_lon, pin_accuracy_meters, photo_lat, photo_lon, photo_accuracy_meters, photo_path, created_by_hr_id, created_at, signboard_check, shared_place_id, schedule_check",
        )
        .eq("status", "active");
      return seatScoped(query, seats).order("id", { ascending: false });
    },
    { maxRows: 10_000, whenFull: "stop", what: "The validated places in use", uniqueBy: (row) => String(row.id) },
  );
  throwIfError(read.error);
  const places = [...read.rows].sort(newestValidatedFirst);
  if (places.length === 0) return { rows: [], capped: false };

  const customerIds = [...new Set(places.map((row) => String(row.customer_id)))];
  // selectByIds, never a bare `.in()`: with the field grown past ~395 active places (482 on
  // production, 2026-10-07), a 400-id `.in()` overflowed the response headers and threw
  // UND_ERR_HEADERS_OVERFLOW ("fetch failed"), which the admin error boundary showed as "Admin
  // workspace unavailable". It also pages each chunk, so the visit count cannot be cut at 1,000 rows.
  // Every review of these customers, whatever its status: the pending ones are held above and left out
  // here, and ANY one at all means somebody has looked at that place.
  const [customers, reviewRows, visits, activePlaces] = await Promise.all([
    selectByIds<Row>("phoenix_crm_customers", "id, name, list_type, speciality", "id", customerIds),
    selectByIds<Row>("phoenix_crm_validation_reviews", "id, place_id, status, decided_by_hr_id, decided_at", "customer_id", customerIds),
    selectByIds<Row>(
      "phoenix_crm_visits",
      "id, place_id",
      "place_id",
      places.map((row) => String(row.id)),
    ),
    selectByIds<Row>("phoenix_crm_places", "id, customer_id", "customer_id", customerIds, (query) => query.eq("status", "active")),
  ]);
  const customerById = new Map(customers.map((row) => [String(row.id), row]));
  const held = new Set(reviewRows.filter((row) => row.status === "pending").map((row) => String(row.place_id)));
  const reviewed = new Set(reviewRows.map((row) => String(row.place_id)));
  // One review row per place, for all time (the UNIQUE index), so the approval that let a place stand is
  // this row and no other; a pending or rejected one says nothing about who approved it.
  const approvals = new Map(reviewRows.filter((row) => row.status === "approved").map((row) => [String(row.place_id), row] as const));
  const visitsByPlace = new Map<string, number>();
  for (const row of visits) {
    const placeId = String(row.place_id ?? "");
    if (placeId) visitsByPlace.set(placeId, (visitsByPlace.get(placeId) ?? 0) + 1);
  }
  const placesByCustomer = new Map<string, number>();
  for (const row of activePlaces) {
    const customerId = String(row.customer_id);
    placesByCustomer.set(customerId, (placesByCustomer.get(customerId) ?? 0) + 1);
  }
  const [names, venues] = await Promise.all([
    loadPeopleNames([
      ...places.map((row) => text(row.created_by_hr_id)),
      ...[...approvals.values()].map((row) => text(row.decided_by_hr_id)),
    ]),
    // The venue each seated place sits in, by name — the Super Admin reads names, never ids.
    loadSharedPlaceNames(places.map((row) => text(row.shared_place_id))),
  ]);

  const rows = places
    .filter((row) => !held.has(String(row.id)))
    .map((row): ValidatedPlaceRow => {
      const customer = customerById.get(String(row.customer_id)) ?? {};
      const point = { lat: numberOrNull(row.lat) ?? 0, lon: numberOrNull(row.lon) ?? 0 };
      const seat = viewer.org.seats.get(String(row.seat_id));
      return {
        placeId: String(row.id),
        customerId: String(row.customer_id),
        customerName: String(customer.name ?? "Unknown customer"),
        listType: String(customer.list_type ?? ""),
        speciality: text(customer.speciality),
        isTest: row.is_test === true,
        repName: nameOf(names, text(row.created_by_hr_id), "A rep"),
        territory: seat ? territoryName(seat) : "Territory no longer in the organogram",
        line: seat?.lineName ?? null,
        region: seat?.regionName ?? null,
        validatedAt: String(row.created_at),
        validatedAtText: formatPhoenixDateTime(String(row.created_at)),
        placeLabel: text(row.label),
        address: text(row.address),
        brickName: text(row.brick_name),
        areaName: text(row.area_name),
        point,
        mapsLink: `https://www.google.com/maps/search/?api=1&query=${point.lat},${point.lon}`,
        pin: reading(row.pin_lat, row.pin_lon, row.pin_accuracy_meters),
        photo: reading(row.photo_lat, row.photo_lon, row.photo_accuracy_meters),
        photoPath: text(row.photo_path),
        visits: visitsByPlace.get(String(row.id)) ?? 0,
        otherPlaces: Math.max((placesByCustomer.get(String(row.customer_id)) ?? 1) - 1, 0),
        reviewed: reviewed.has(String(row.id)),
        decidedByName: deciderLabel(names, text(approvals.get(String(row.id))?.decided_by_hr_id)),
        decidedAtText: text(approvals.get(String(row.id))?.decided_at)
          ? formatPhoenixDateTime(String(approvals.get(String(row.id))?.decided_at))
          : null,
        signboard: signboardOf(row.signboard_check),
        photoKind: text(row.shared_place_id) ? "schedule" : "signboard",
        sharedPlaceName: venues.get(String(row.shared_place_id ?? ""))?.name ?? null,
        sharedPlaceId: text(row.shared_place_id),
        schedule: scheduleOf(row.schedule_check),
      };
    });
  return { rows, capped: read.capped };
}

/**
 * `created_at desc, id desc` — the order `loadValidatedPlaces` used to ask the database for. Time is
 * compared as an instant first (an offset in the text cannot reorder it); two stamps in the same
 * millisecond fall back to the text, which carries the microseconds; then the id, compared as plain
 * text because a lowercase uuid string sorts exactly as Postgres sorts the uuid.
 */
function newestValidatedFirst(left: Row, right: Row): number {
  const leftAt = String(left.created_at ?? "");
  const rightAt = String(right.created_at ?? "");
  const byInstant = Date.parse(rightAt) - Date.parse(leftAt);
  if (Number.isFinite(byInstant) && byInstant !== 0) return byInstant;
  if (leftAt !== rightAt) return leftAt < rightAt ? 1 : -1;
  const leftId = String(left.id);
  const rightId = String(right.id);
  return leftId === rightId ? 0 : leftId < rightId ? 1 : -1;
}

/** The stored timetable verdict, read as defensively as the signboard's: unrecognised is "not read". */
function scheduleOf(value: unknown): ValidatedPlaceRow["schedule"] {
  if (!value || typeof value !== "object") return null;
  const check = value as Row;
  const verdict = check.verdict;
  if (verdict !== "match" && verdict !== "other_name" && verdict !== "no_schedule" && verdict !== "unjudged") return null;
  return {
    verdict,
    scheduleText: text(check.scheduleText),
    hoursRead: text(check.hoursRead),
    reason: text(check.reason),
    legibility: parseScheduleLegibility(check.legibility),
    problem: parseScheduleProblem(check.problem),
  };
}

/** The stored signboard verdict, read defensively: anything unrecognised is "not read yet". */
function signboardOf(value: unknown): ValidatedPlaceRow["signboard"] {
  if (!value || typeof value !== "object") return null;
  const check = value as Row;
  const verdict = check.verdict;
  if (verdict !== "match" && verdict !== "other_name" && verdict !== "no_name" && verdict !== "unjudged") return null;
  return {
    problem: parseSignboardPhotoProblem(check.problem),
    reason: text(check.reason),
    retake: signboardRetakeWaiting(check) !== null,
    signText: text(check.signText),
    verdict,
  };
}

/**
 * Refuse one validation the system never questioned.
 *
 * 🔴 THE NOTE IS OPTIONAL SINCE 2026-10-15 (owner: "admin comment is optional"); the REASON — the one
 * sentence the rep is told — is still required. The note was mandatory because a hand refusal carries
 * no Google evidence of its own, and the answer to a mandatory field nobody reads was a dash in 22 of
 * the first 24 refusals.
 */
export async function refuseValidatedPlace(viewer: PhoenixCrmViewer, raw: unknown): Promise<{ placeId: string; reopened: boolean }> {
  if (!canDecideValidationReviews(viewer)) throw forbiddenError("Only the Super Admin and the SFE Manager decide these.");
  const body = (raw && typeof raw === "object" ? raw : {}) as Row;
  if (!isUuid(body.placeId)) throw validationError("Choose the place to refuse.");
  // What is wrong with the photo, because it is the one thing the rep is told (2026-10-08). The note
  // beside it is the record a reader comes back to, the rep never sees it, and it is his to leave empty.
  const refusalReason = parseValidationRefusalReason(body.refusalReason);
  if (!refusalReason) throw validationError(VALIDATION_REASON_REQUIRED);
  const note = cleanText(body.note, 500);
  const placeId = String(body.placeId).toLowerCase();

  const { data, error } = await getSupabaseAdmin()
    .from("phoenix_crm_places")
    .select("id, seat_id, customer_id, is_test, status, created_by_hr_id")
    .eq("id", placeId)
    .maybeSingle();
  throwIfError(error);
  const place = data as Row | null;
  if (!place) throw notFoundError("This place is no longer there. Reload the page.");
  if (place.status !== "active") throw validationError("This place is already retired. Reload the page.");

  // The review the automatic check would have written, had this customer been in its scope.
  //
  // 🔴 An UPSERT on place_id, never a plain insert: `phoenix_crm_validation_reviews_place_idx` is
  // UNIQUE on place_id, so a place that was already held once — an AM one the check held and then
  // approved — has a row, and inserting a second died on 23505. It is put back to `pending` (and
  // `decided_at` cleared with it, or the table's own CHECK refuses the row) so the shared reject
  // below is what decides it, exactly as it decides an automatic hold.
  const upserted = await getSupabaseAdmin()
    .from("phoenix_crm_validation_reviews")
    .upsert(
      {
        seat_id: String(place.seat_id),
        customer_id: String(place.customer_id),
        place_id: placeId,
        is_test: place.is_test === true,
        kind: "validation",
        status: "pending",
        google: { reason: "refused_by_admin", refused_by_hr_id: viewer.hrId },
        created_by_hr_id: String(place.created_by_hr_id),
        decided_by_hr_id: null,
        decided_at: null,
        decision_note: null,
      },
      { onConflict: "place_id" },
    )
    .select("id")
    .single();
  throwIfError(upserted.error);
  const reviewId = String((upserted.data as Row).id);

  const result = await callPhoenixCrm<Row>("phoenix_crm_decide_validation_review", {
    p: { review_id: reviewId, actor_hr_id: viewer.hrId, decision: "reject", note, refusal_reason: refusalReason },
  });
  // A retired place changes what every visit to the customer is measured against.
  await restampVisitLocationsQuietly({
    seatId: String(result.seat_id),
    isTest: result.is_test === true,
    customerId: String(result.customer_id),
    actorHrId: viewer.hrId,
    settings: viewer.config.settings,
    scope: "all",
  });
  // He is told what is wrong with his photo, exactly as an automatic hold's rejection tells him — one
  // notice, one wording, and nothing in it says a person looked.
  await tellRepValidateAgain(viewer, result);
  return { placeId, reopened: result.reopened === true };
}

/**
 * Confirm one validation the system could not (owner, 2026-10-17: *"make me able to approve"*, asked on
 * the Not confirmed photographs — "I can read them. So why you cannot?").
 *
 * The mirror of `refuseValidatedPlace`: the SAME review row the automatic check writes, in the rep's
 * name, put to `pending` and then decided by the SAME `phoenix_crm_decide_validation_review` approve —
 * so a confirmation is one more `validation_review_approved` event, and the place leaves Not confirmed
 * because a review now exists for it (`reviewed`). The customer is already validated, so nothing the
 * rep sees changes and he is told nothing (golden rule #1).
 *
 * A place someone has already decided is left exactly as it is, and a place the door is still holding
 * is approved on its own review, keeping the evidence it was held on.
 */
export async function approveValidatedPlace(viewer: PhoenixCrmViewer, raw: unknown): Promise<{ placeId: string; approved: boolean }> {
  if (!canDecideValidationReviews(viewer)) throw forbiddenError("Only the Super Admin and the SFE Manager decide these.");
  const body = (raw && typeof raw === "object" ? raw : {}) as Row;
  if (!isUuid(body.placeId)) throw validationError("Choose the place to approve.");
  const note = cleanText(body.note, 500);
  const placeId = String(body.placeId).toLowerCase();

  const [placeRead, reviewRead] = await Promise.all([
    getSupabaseAdmin().from("phoenix_crm_places").select("id, seat_id, customer_id, is_test, status, created_by_hr_id").eq("id", placeId).maybeSingle(),
    getSupabaseAdmin().from("phoenix_crm_validation_reviews").select("id, status").eq("place_id", placeId).maybeSingle(),
  ]);
  throwIfError(placeRead.error);
  throwIfError(reviewRead.error);
  const place = placeRead.data as Row | null;
  if (!place) throw notFoundError("This place is no longer there. Reload the page.");
  if (place.status !== "active") throw validationError("This place is already retired. Reload the page.");
  const existing = reviewRead.data as Row | null;
  // Decided already — by him, or by the system's own reading. Nothing to add.
  if (existing && existing.status !== "pending") return { placeId, approved: false };

  let reviewId = existing ? String(existing.id) : null;
  if (!reviewId) {
    // 🔴 An UPSERT on place_id, for the reason `refuseValidatedPlace` gives: the index is UNIQUE.
    const upserted = await getSupabaseAdmin()
      .from("phoenix_crm_validation_reviews")
      .upsert(
        {
          seat_id: String(place.seat_id),
          customer_id: String(place.customer_id),
          place_id: placeId,
          is_test: place.is_test === true,
          kind: "validation",
          status: "pending",
          google: { reason: "confirmed_by_admin", confirmed_by_hr_id: viewer.hrId },
          created_by_hr_id: String(place.created_by_hr_id),
          decided_by_hr_id: null,
          decided_at: null,
          decision_note: null,
        },
        { onConflict: "place_id" },
      )
      .select("id")
      .single();
    throwIfError(upserted.error);
    reviewId = String((upserted.data as Row).id);
  }

  await callPhoenixCrm<Row>("phoenix_crm_decide_validation_review", {
    p: { review_id: reviewId, actor_hr_id: viewer.hrId, decision: "approve", note, refusal_reason: null },
  });
  // A held place's "waiting for you" notice is answered.
  await withdrawValidationReviewWaiting(reviewId);
  return { placeId, approved: true };
}

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
  /** Who refused it and when (owner, 2026-10-20) — null when the refusal predates the record. */
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
export async function loadReopenedCustomers(viewer: PhoenixCrmViewer): Promise<ValidationBoardRead<ReopenedCustomerRow>> {
  const seats = placeChecksSeatScope(viewer);
  const read = await readEveryPage<Row>(
    () => {
      const query = getSupabaseAdmin()
        .from("phoenix_crm_customers")
        .select("id, seat_id, name, list_type, is_test, reopened_at")
        .eq("status", "pending")
        .not("reopened_at", "is", null);
      return seatScoped(query, seats)
        .order("reopened_at", { ascending: true })
        .order("id", { ascending: true });
    },
    { maxRows: 5_000, whenFull: "stop", what: "The customers waiting to be captured again", uniqueBy: (row) => String(row.id) },
  );
  throwIfError(read.error);
  const customers = read.rows;
  if (customers.length === 0) return { rows: [], capped: false };

  const reviews = await selectByIds<Row>(
    "phoenix_crm_validation_reviews",
    "id, customer_id, status, refusal_reason, created_by_hr_id, decided_by_hr_id, decided_at",
    "customer_id",
    customers.map((row) => String(row.id)),
    (query) => query.eq("status", "rejected"),
  );
  // The LATEST refusal per customer is the one he is waiting on.
  const latest = new Map<string, Row>();
  for (const review of reviews) {
    const customerId = String(review.customer_id);
    const current = latest.get(customerId);
    if (!current || String(review.decided_at ?? "") > String(current.decided_at ?? "")) latest.set(customerId, review);
  }
  // 🔴 A VENUE'S REFUSAL WRITES NO REVIEW ROW FOR THE CUSTOMER, so the read above finds nothing for a
  // customer reopened by a rejected polyclinic and this list rendered "A rep" and "No reason was
  // chosen — refused before the reason list existed." while `no_signboard` sat on the venue (measured
  // on staging, 2026-10-09, both customers of one rejected venue). The reason lives on the venue and
  // the rep on the retired seating, so those are asked for — only for the customers with no review.
  const viaVenue = await loadSharedPlaceRefusalsForCustomers(
    customers.map((row) => String(row.id)).filter((id) => !latest.has(id)),
  );
  const names = await loadPeopleNames([
    ...[...latest.values()].map((row) => text(row.created_by_hr_id)),
    ...[...viaVenue.values()].map((row) => row.repHrId),
    ...[...latest.values()].map((row) => text(row.decided_by_hr_id)),
    ...[...viaVenue.values()].map((row) => row.decidedByHrId),
  ]);
  const now = Date.now();

  const rows = customers.map((row): ReopenedCustomerRow => {
    const review = latest.get(String(row.id));
    const venue = review ? undefined : viaVenue.get(String(row.id));
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
      repName: nameOf(names, review ? text(review.created_by_hr_id) : (venue?.repHrId ?? null), "A rep"),
      territory: seat ? territoryName(seat) : "Territory no longer in the organogram",
      line: seat?.lineName ?? null,
      region: seat?.regionName ?? null,
      reopenedAt,
      reopenedAtText: formatPhoenixDateTime(reopenedAt),
      waitingHours: Number.isNaN(at) ? 0 : Math.max(0, Math.floor((now - at) / 3_600_000)),
      reasonLabel: validationRefusalLabel(review ? text(review.refusal_reason) : (venue?.refusalReason ?? null)),
      refusedByName: deciderLabel(names, review ? text(review.decided_by_hr_id) : (venue?.decidedByHrId ?? null)),
      refusedAtText: refusedAt ? formatPhoenixDateTime(refusedAt) : null,
      sharedPlaceName: venue?.sharedPlaceName ?? null,
      sharedPlaceId: venue?.sharedPlaceId ?? null,
    };
  });
  return { rows, capped: read.capped };
}

/**
 * How many customers wait to be captured again, and since when — the figure the Needs You board asks.
 * A head count plus the oldest stamp, so PostgREST's 1,000-row ceiling cannot shorten it. Throws on a
 * failed read: the board turns that into "could not be read", never a zero it cannot prove.
 */
export async function countReopenedCustomersWaiting(): Promise<{ count: number; oldestAt: string | null }> {
  const supabase = getSupabaseAdmin();
  const [waiting, oldest] = await Promise.all([
    supabase.from("phoenix_crm_customers").select("id", { count: "exact", head: true }).eq("status", "pending").not("reopened_at", "is", null),
    supabase
      .from("phoenix_crm_customers")
      .select("reopened_at")
      .eq("status", "pending")
      .not("reopened_at", "is", null)
      .order("reopened_at", { ascending: true })
      .limit(1),
  ]);
  throwIfError(waiting.error);
  throwIfError(oldest.error);
  const first = ((oldest.data ?? []) as Row[])[0];
  return { count: waiting.count ?? 0, oldestAt: first ? String(first.reopened_at) : null };
}
