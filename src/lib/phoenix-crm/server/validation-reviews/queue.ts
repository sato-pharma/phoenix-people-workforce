/**
 * Place checks — the queue read: every review waiting or decided, and the advice on one waiting review.
 * Moved out of `validation-reviews.ts` unchanged on 23 Nov 2026, so no file of Place checks is over 400
 * lines; that file re-exports everything here that it exported, so import from it.
 */

import { formatPhoenixDateTime } from "@/lib/i18n/format";
import { logError } from "@/lib/observability/log";
import type { PlaceCheckAdvice } from "@/lib/phoenix-crm/place-check-advice";
import { adviceOnReviewRecord } from "@/lib/phoenix-crm/place-check-stored-advice";
import { keptBySeatedDecisionsRead, REVIEW_SUBJECTS_SEATED_SELECT, REVIEW_SUBJECTS_SELECT, signboardCheckRead } from "@/lib/phoenix-crm/place-checks-slim-read";
import { parseScheduleHeldBecause, parseScheduleLegibility, parseScheduleProblem } from "@/lib/phoenix-crm/schedule-rules";
import { territoryName } from "@/lib/phoenix-crm/scope";
import { customerKindText } from "@/lib/phoenix-crm/speciality-list";
import { waitingIsLong, waitingOldestFirst, waitingText } from "@/lib/phoenix-crm/waiting-rules";
import { placeChecksSeatScope, readsCompanyPlaceChecks, type PhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { approvalLockFor } from "@/lib/phoenix-crm/server/super-admin-approval";
import { numberOrNull, seatScoped, selectByIds, throwIfError } from "@/lib/phoenix-crm/server/db";
import { readEveryPage } from "@/lib/phoenix-crm/server/paged-read";
import { loadPeopleNames, nameOf } from "@/lib/phoenix-crm/server/people";
import { signboardHoldStillReading } from "@/lib/phoenix-crm/signboard-rules";
import { validationRefusalLabel } from "@/lib/phoenix-crm/validation-feedback";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { DECIDED_SHOWN_DAYS, deciderLabel, isRecord, listingsOf, newestValidatedFirst, reading, REJECTED_SHOWN_DAYS, reviewStillToDecide, type Row, text } from "@/lib/phoenix-crm/server/validation-reviews/shared";
import type { ValidationBoardRead, ValidationReviewRow } from "@/lib/phoenix-crm/server/validation-reviews/types";
import { markDoorsCapturedAgain, markEarlierDecisions } from "@/lib/phoenix-crm/server/validation-reviews/capture-marks";
import { signboardOf } from "@/lib/phoenix-crm/server/validation-reviews/decided";

/** The review's own columns the board reads; the customer and the place are joined beside them. */
const REVIEW_COLUMNS =
  "id, seat_id, customer_id, place_id, is_test, kind, status, google, created_by_hr_id, created_at, decided_by_hr_id, decided_at, decision_note, refusal_reason, system_approved_rule";

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
    /**
     * 🔴 THE SUPER ADMIN'S PAGE READS THE DECISIONS IT SENDS, AND NO OTHERS (owner, 23 Nov 2026: "Fix what is
     * under 9.5"). The page sends the decisions of the customers SEATED in a building, because a building's
     * card shows everybody in it (`decidedSentWithPage`); it read all 1,184 decisions of the last 14 days to
     * keep those — 2.9 of the page's seconds, its slowest read. With this the database sends only the
     * decisions whose place is seated in a building (the place is joined into each review, so it is one
     * filter and no list of ids), and the rows are narrowed again here, so the rule never rests on the
     * request alone. Every waiting review is still read whole. The single clinics' decisions are the wide
     * read's (`server/place-checks-wide-read.ts`), which counts them and hands them to the click.
     */
    seatedDecisionsOnly?: boolean;
  } = {},
): Promise<ValidationBoardRead<ValidationReviewRow>> {
  const seats = placeChecksSeatScope(viewer);
  const decides = readsCompanyPlaceChecks(viewer);
  const seatedDecisionsOnly = options.seatedDecisionsOnly === true;
  const since = new Date(Date.now() - DECIDED_SHOWN_DAYS * 86_400_000).toISOString();
  const rejectedSince = new Date(Date.now() - REJECTED_SHOWN_DAYS * 86_400_000).toISOString();
  // Phoenix CRM validation audit, 14 Nov 2026: the waiting reviews and the decided ones were ONE read
  // with one ceiling of 5,000, newest first. The wide read (`everyDecision`) carries every decision ever
  // made, so once the decisions passed the ceiling the rows it cut were the OLDEST — which is where a
  // review still waiting sits. A place nobody had decided would have left the queue with nothing going
  // red. So the waiting rows are read on their own, whole, and only the decided rows meet the ceiling.
  const reviewsOf = (waiting: boolean) => () => {
    const base = getSupabaseAdmin()
      .from("phoenix_crm_validation_reviews")
      // The same columns either way; only the place's join differs, inner when the database narrows by it.
      .select(seatedDecisionsOnly && !waiting ? `${REVIEW_COLUMNS}, ${REVIEW_SUBJECTS_SEATED_SELECT}` : `${REVIEW_COLUMNS}, ${REVIEW_SUBJECTS_SELECT}`);
    // A rejection keeps its undo for longer than an ordinary decided row keeps its place on the
    // page — see REJECTED_SHOWN_DAYS. The place's own status is not on this table, so a rejection
    // with nothing left to undo is dropped after the read, below.
    const byStatus = waiting
      ? base.eq("status", "pending")
      : options.everyDecision
        ? base.neq("status", "pending")
        : base.neq("status", "pending").or(`decided_at.gte.${since},and(status.eq.rejected,decided_at.gte.${rejectedSince})`);
    // The decisions of the customers seated in a building, picked by the database.
    const query = seatedDecisionsOnly && !waiting ? byStatus.not("place.shared_place_id", "is", null) : byStatus;
    return seatScoped(query, seats)
      .order("created_at", { ascending: false })
      .order("id", { ascending: false });
  };
  const [waitingRead, decidedRead] = await Promise.all([
    readEveryPage<Row>(reviewsOf(true), { maxRows: 50_000, whenFull: "stop", what: "The place checks waiting", uniqueBy: (row) => String(row.id) }),
    // Every decision is three pages today (2,021 decided, 16 Nov 2026): asked for together, not one after
    // another. The recent ones are a single page, so that read stays one page at a time.
    readEveryPage<Row>(reviewsOf(false), { maxRows: 5_000, whenFull: "stop", what: "The place checks decided", uniqueBy: (row) => String(row.id), concurrentPages: options.everyDecision ? 3 : 1 }),
  ]);
  throwIfError(waitingRead.error);
  throwIfError(decidedRead.error);
  // One row per review: a review decided between the two reads is kept once, as decided. Then the
  // order the single read asked the database for, `created_at desc, id desc`, made here.
  const reviewById = new Map<string, Row>();
  for (const row of [...waitingRead.rows, ...decidedRead.rows]) reviewById.set(String(row.id), row);
  // 🔴 SEATED IS THE RULE; THE DATABASE'S NARROWING ONLY SAVES THE DOWNLOAD. A decision whose place sits in
  // no building is dropped here too, so a request that came back wider answers the same rows.
  if (seatedDecisionsOnly) {
    for (const [id, row] of reviewById) {
      if (!keptBySeatedDecisionsRead(row)) reviewById.delete(id);
    }
  }
  const reviews = [...reviewById.values()].sort(newestValidatedFirst);
  const capped = waitingRead.capped || decidedRead.capped;
  if (reviews.length === 0) return { rows: [], capped: false };

  // The customer and the place came joined into each review (`REVIEW_SUBJECTS_SELECT`), so the only reads
  // left are the people's names and the Super Admin's approval lock. A review whose join came back empty is
  // simply absent from its map — the same as the id lookups this replaced, which left a missing row out.
  const customerById = new Map<string, Row>();
  const placeById = new Map<string, Row>();
  for (const review of reviews) {
    const customer: unknown = review.customer;
    const place: unknown = review.place;
    if (isRecord(customer)) customerById.set(String(review.customer_id), customer);
    if (isRecord(place)) placeById.set(String(review.place_id), { ...place, signboard_check: signboardCheckRead(place) });
  }
  const [names, lockedFor] = await Promise.all([
    loadPeopleNames(reviews.flatMap((row) => [text(row.created_by_hr_id), text(row.decided_by_hr_id)])),
    approvalLockFor(viewer),
  ]);

  // One clock for the whole read, so two rows of one instant never read two different waits.
  const now = new Date();
  // A review left waiting on a place no longer in use is nobody's to decide (`reviewStillToDecide`).
  const rows = reviews.filter((row) => reviewStillToDecide(row, placeById)).map((row): ValidationReviewRow => {
    const customer = customerById.get(String(row.customer_id)) ?? {};
    const place = placeById.get(String(row.place_id)) ?? {};
    const google = (row.google && typeof row.google === "object" ? row.google : {}) as Row;
    const point = { lat: numberOrNull(place.lat) ?? 0, lon: numberOrNull(place.lon) ?? 0 };
    const locked = lockedFor(row.status === "approved" ? row.decided_by_hr_id : null, place.created_by_hr_id);
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
        uploaded: schedule && google.uploaded === true,
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
      // A review is never put back to waiting once decided, so its own instant is when the wait began.
      waitingText: status === "pending" ? waitingText(String(row.created_at), now) : null,
      waitingLong: status === "pending" && waitingIsLong(String(row.created_at), now),
      repName: nameOf(names, text(row.created_by_hr_id), "A rep"),
      territory: seat ? territoryName(seat) : "Territory no longer in the organogram",
      line: seat?.lineName ?? null,
      region: seat?.regionName ?? null,
      customerName: String(customer.name ?? "Unknown customer"),
      listType: String(customer.list_type ?? ""),
      speciality: customerKindText(text(customer.customer_type), text(customer.speciality)),
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
      decidedByName: decides ? deciderLabel(names, text(row.decided_by_hr_id)) : null,
      approvedByRule: decides && row.status === "approved" ? text(row.system_approved_rule) : null,
      decidedAtText: text(row.decided_at) ? formatPhoenixDateTime(String(row.decided_at)) : null,
      decidedAt: text(row.decided_at),
      decisionNote: decides ? text(row.decision_note) : null,
      // One review row per place (the UNIQUE index), so this row IS the place's whole story: a
      // rejection can be taken back while the place it retired is still retired, and since
      // 2026-10-15 an APPROVAL can be taken back while the place it approved is still active.
      // 🔴 THE SUPER ADMIN IS NEVER BLOCKED (owner, 24 Nov 2026: "never block admin from appproving
      // rejecting re approving or rejecdting never ever ever never"): every rejection can be approved after
      // all, whatever has happened to its place, its building or its customer since; the take-back clears
      // what stands in the way (migration 20261124113734).
      restorable: status === "rejected",
      // 🔴 Not when the Super Admin approved it, unless the viewer is the Super Admin (owner, 2026-11-16).
      refusable: status === "approved" && place.status === "active" && !locked,
      lockedBySuperAdmin: locked,
      systemStillReading: signboardHoldStillReading({
        isTest: row.is_test === true,
        pending: status === "pending",
        signboardHold: signboard,
        stored: place.signboard_check,
      }),
      recent: true,
    };
  });
  // Asked for together (23 Nov 2026): the first marks decided rows, the second waiting ones, and neither
  // reads what the other writes. Each keeps its own failed read to itself, as before.
  await Promise.all([markDoorsCapturedAgain(rows, reviews, placeById), markEarlierDecisions(rows, reviews, decides)]);
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
      row.status === "pending" ||
      decided === null ||
      decided >= since ||
      (row.status === "rejected" && placeById.get(row.placeId)?.status === "retired" && decided >= rejectedSince);
  }
  const keep = options.everyDecision ? rows : rows.filter((row) => row.recent);
  // 🔴 WHAT IS WAITING IS LISTED OLDEST FIRST (owner, 14 Nov 2026). The decided rows keep the
  // newest-first order made above; only the waiting ones are re-ordered, in the places they already
  // hold, so every screen that splits this one list by status reads the longest wait at the top.
  const ordered = waitingOldestFirst(
    keep,
    (row) => row.status === "pending",
    (row) => ({ at: row.createdAt, id: row.reviewId }),
  );
  return { rows: ordered, capped };
}

// ── The decision ────────────────────────────────────────────────────────────────────────────────

/**
 * The system's advice on a review that is still WAITING, read just before it is decided, so the decision
 * can keep it (the rebuild, 23 Nov 2026; `place-check-stored-advice.ts`). Built from the review's own
 * record through the board row's own readers (`signboardOf`, `listingsOf`), so it is the advice the page
 * showed. Null for a review already decided (a take-back keeps the first advice) and for anything that
 * could not be read. Never throws: a decision is never refused because its advice could not be worked out.
 *
 * Exported so it stands as its own function in this file: the board's read above it is pinned to make no
 * look-up by id after its pages (`phoenix-crm-place-checks-speed.test.ts`), and this one makes two.
 */
export async function adviceOnWaitingReview(reviewId: string): Promise<PlaceCheckAdvice | null> {
  try {
    const { data, error } = await getSupabaseAdmin().from("phoenix_crm_validation_reviews").select("id, status, google, place_id").eq("id", reviewId).maybeSingle();
    const review = data as Row | null;
    if (error || !review || review.status !== "pending") return null;
    const [place] = await selectByIds<Row>("phoenix_crm_places", "id, lat, lon, signboard_check, shared_place_id", "id", [text(review.place_id)]);
    if (!place) return null;
    const venueId = text(place.shared_place_id);
    const [venue] = venueId ? await selectByIds<Row>("phoenix_crm_shared_places", "id, timetable_exempt_at", "id", [venueId]) : [];
    const google = isRecord(review.google) ? review.google : {};
    const nearest = listingsOf(google, { lat: numberOrNull(place.lat) ?? 0, lon: numberOrNull(place.lon) ?? 0 })[0];
    return adviceOnReviewRecord({
      google,
      signboard: signboardOf(place.signboard_check),
      nearestListingMeters: nearest ? nearest.distanceMeters : null,
      buildingHasNoTimetable: text(venue?.timetable_exempt_at) !== null,
    });
  } catch (error) {
    logError("Phoenix CRM place-check advice could not be read before a decision", { error, labels: { event: "phoenix_crm_place_check_advice_unread" } });
    return null;
  }
}
