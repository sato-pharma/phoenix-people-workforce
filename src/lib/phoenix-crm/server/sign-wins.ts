/**
 * Phoenix CRM — "the sign wins", the reads and the one write (owner, 23 Nov 2026).
 *
 * The rule itself is `sign-wins-rules.ts` and nothing here decides anything that file does not: this
 * reads what the rule asks about, runs `signWinsVerdict`, and approves through the SAME
 * `approveHeldSignboardBySystem` the held-signboard re-read uses, so there is still one approve path,
 * one audit shape and the actor `SYSTEM`. Then it marks the review (`system_approved_rule`) so the page
 * can list it under "Approved by the system" and a take-back of it can be counted.
 *
 * 🔴 EVERY READ FAILS CLOSED. A switch, a place, an integrity case or a recommendation that could not
 * be read approves nothing: the place stays waiting for him, which is where it was before this rule.
 *
 * 🔴 NOTHING HERE THROWS to its caller. It runs after a rep's reply and inside an hourly job; the place
 * is already saved and held whatever happens here.
 */

import { logError } from "@/lib/observability/log";
import { isSettledIntegrityRow } from "@/lib/phoenix-crm/integrity-settlement";
import { GOOGLE_SIGN_MATCH_CODE } from "@/lib/phoenix-crm/place-check-advice";
import { parsePlaceRecommendation } from "@/lib/phoenix-crm/place-note-rules";
import { storedAdviceOf } from "@/lib/phoenix-crm/place-check-stored-advice";
import { approvalNeedsFullName } from "@/lib/phoenix-crm/pm-name-rules";
import { selectByIds } from "@/lib/phoenix-crm/server/db";
import { readEveryPage } from "@/lib/phoenix-crm/server/paged-read";
import { approveHeldSignboardBySystem, SIGNBOARD_SYSTEM_ACTOR } from "@/lib/phoenix-crm/server/signboard-holds";
import { readPlaceSignboardNow } from "@/lib/phoenix-crm/server/signboard-sweep";
import {
  GOOGLE_HOLD_REASONS,
  SIGN_WINS_NOTE,
  SIGN_WINS_RULE,
  SIGN_WINS_STARTED_AT,
  SIGN_WINS_SWEEP_LIMIT,
  SIGN_WINS_WINDOW_DAYS,
  signWinsSwitch,
  signWinsVerdict,
  type SignWinsCandidate,
  type SignWinsLeftBecause,
  type SignWinsSwitch,
} from "@/lib/phoenix-crm/sign-wins-rules";
import { getSupabaseAdmin } from "@/lib/supabase/server";

type Row = Record<string, unknown>;

const REVIEW_COLUMNS = "id, status, is_test, google, created_at, place_id, customer_id";

/** The most rows either read below may hold. Far above a month of this rule; a bound on memory only. */
const SIGN_WINS_READ_MAX = 2_000;

/** How many times the mark is written before the approval is left unmarked and logged. */
const SIGN_WINS_MARK_ATTEMPTS = 3;

function isRecord(value: unknown): value is Row {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/**
 * What the rule approved in the window and how many of those he took back. Throws when it cannot be
 * read: a caller that cannot read the switch treats it as off.
 */
export async function readSignWinsSwitch(now: number = Date.now()): Promise<SignWinsSwitch> {
  const since = new Date(now - SIGN_WINS_WINDOW_DAYS * 86_400_000).toISOString();
  const read = await readEveryPage<Row>(
    () =>
      getSupabaseAdmin()
        .from("phoenix_crm_validation_reviews")
        .select("id, status")
        .eq("system_approved_rule", SIGN_WINS_RULE)
        .eq("is_test", false)
        .gte("system_approved_at", since)
        .order("system_approved_at", { ascending: true })
        .order("id", { ascending: true }),
    { maxRows: SIGN_WINS_READ_MAX, whenFull: "refuse", what: "Phoenix CRM sign-wins approvals" },
  );
  if (read.error) throw read.error;
  // A take-back is the Super Admin's reject of a review the system approved (`decideValidationReview`
  // accepts it since 2026-10-15), which leaves the row `rejected` with its mark still on it.
  return signWinsSwitch({ approvals: read.rows.length, takeBacks: read.rows.filter((row) => row.status === "rejected").length });
}

/** Everything the rule asks about each of these reviews, in five reads whatever their number. */
async function loadCandidates(reviews: ReadonlyArray<Row>): Promise<Map<string, SignWinsCandidate>> {
  const placeIds = reviews.map((row) => String(row.place_id));
  const [places, customers, cases, recommendations] = await Promise.all([
    selectByIds<Row>("phoenix_crm_places", "id, status, shared_place_id, photo_path, signboard_check", "id", placeIds),
    selectByIds<Row>("phoenix_crm_customers", "id, name, list_type", "id", reviews.map((row) => String(row.customer_id))),
    // The yes/no of a settlement goes through `isSettledIntegrityRow`, as every reader of this table does.
    selectByIds<Row>("phoenix_crm_location_integrity", "id, subject_id, flags, settled_at, settled_by, settled_note, settled_flags", "subject_id", placeIds, (query) =>
      query.eq("subject_kind", "place"),
    ),
    selectByIds<Row>("phoenix_crm_place_recommendations", "id, place_id, recommendation, writer_role", "place_id", placeIds),
  ]);
  const placeById = new Map(places.map((row) => [String(row.id), row]));
  const customerById = new Map(customers.map((row) => [String(row.id), row]));
  const openCase = new Set(cases.filter((row) => !isSettledIntegrityRow(row)).map((row) => String(row.subject_id)));
  const sfeRecommended = new Set(
    recommendations.filter((row) => row.writer_role === "sfe_manager" && parsePlaceRecommendation(row.recommendation) !== null).map((row) => String(row.place_id)),
  );

  const candidates = new Map<string, SignWinsCandidate>();
  for (const review of reviews) {
    const place = placeById.get(String(review.place_id));
    const customer = customerById.get(String(review.customer_id));
    // A place or a customer that was not read is a row that cannot be read: left, never guessed at.
    if (!place || !customer) continue;
    const google = isRecord(review.google) ? review.google : {};
    const sign = isRecord(place.signboard_check) ? place.signboard_check : {};
    candidates.set(String(review.id), {
      reviewStatus: text(review.status),
      isTest: review.is_test === true,
      holdVerdict: text(google.verdict),
      holdReason: text(google.reason),
      createdAt: text(review.created_at),
      placeStatus: text(place.status),
      sharedPlaceId: text(place.shared_place_id),
      hasPhoto: text(place.photo_path) !== null,
      signVerdict: text(sign.verdict),
      needsFullName: approvalNeedsFullName({ listType: customer.list_type, customerName: customer.name }),
      openIntegrityCase: openCase.has(String(review.place_id)),
      sfeRecommended: sfeRecommended.has(String(review.place_id)),
    });
  }
  return candidates;
}

/**
 * Approve one review the rule has already passed, and mark it. False when the approval did not land:
 * he decided it first, or the short-name gate refused it, and the place stays as it is.
 */
async function approveUnderTheRule(reviewId: string): Promise<boolean> {
  if (!(await approveHeldSignboardBySystem(reviewId, SIGN_WINS_NOTE))) return false;
  // The mark, and the advice the system acted on, so the 30-day switch and the meter can read them.
  // Only on the row the system itself just approved: his own decision is never marked as the rule's.
  //
  // 🔴 THE MARK IS TRIED AGAIN, because the switch counts marked rows only: an approval left unmarked
  // would be one a take-back of could never stop the rule. The same guarded write each time, so a try
  // that did land is simply written again.
  const approvedAt = new Date().toISOString();
  let error: unknown = null;
  for (let attempt = 1; attempt <= SIGN_WINS_MARK_ATTEMPTS; attempt += 1) {
    const written = await getSupabaseAdmin()
      .from("phoenix_crm_validation_reviews")
      .update({
        system_approved_rule: SIGN_WINS_RULE,
        system_approved_at: approvedAt,
        ...storedAdviceOf({ kind: "approve", code: GOOGLE_SIGN_MATCH_CODE }),
      })
      .eq("id", reviewId)
      .eq("status", "approved")
      .eq("decided_by_hr_id", SIGNBOARD_SYSTEM_ACTOR);
    error = written.error;
    if (!error) break;
  }
  if (error) {
    // The approval stands and reads "the system" on the board; it is only missing from the rule's count.
    logError("Phoenix CRM sign-wins approval was not marked", { error, labels: { event: "phoenix_crm_sign_wins_mark_failed" } });
  }
  return true;
}

export type SignWinsOutcome = {
  approved: boolean;
  /** Why it was left to him; null when it was approved. */
  because: SignWinsLeftBecause | "switched_off" | "decided_first" | "not_read" | null;
};

/**
 * The door's own call, right after a place is saved held: approve it now if the rule applies. Never
 * throws. The caller tells the Super Admin about the hold only when this did not approve it.
 */
export async function signWinsAtTheDoor(reviewId: string): Promise<SignWinsOutcome> {
  try {
    const { data, error } = await getSupabaseAdmin().from("phoenix_crm_validation_reviews").select(REVIEW_COLUMNS).eq("id", reviewId).maybeSingle();
    if (error || !data) return { approved: false, because: "not_read" };
    const candidate = (await loadCandidates([data as Row])).get(reviewId);
    if (!candidate) return { approved: false, because: "not_read" };
    const verdict = signWinsVerdict(candidate);
    if (!verdict.applies) return { approved: false, because: verdict.because };
    if (!(await readSignWinsSwitch()).on) return { approved: false, because: "switched_off" };
    return (await approveUnderTheRule(reviewId)) ? { approved: true, because: null } : { approved: false, because: "decided_first" };
  } catch (error) {
    logError("Phoenix CRM sign-wins check failed at the door", { error, labels: { event: "phoenix_crm_sign_wins_failed" } });
    return { approved: false, because: "not_read" };
  }
}

/**
 * The door's call for a place GOOGLE held: read its sign now, then ask the rule.
 *
 * 🔴 THE DOOR READS NO SIGN FOR A PLACE GOOGLE HOLDS (`held_elsewhere`), so `signWinsAtTheDoor` alone
 * could never approve one: the stored reading it asks for did not exist until the 03:35 pass. This makes
 * that one read first (`readPlaceSignboardNow`, the night's own read of one place, never a second
 * one). A read that gave no answer leaves the place to him and to the night, as before. Never throws.
 */
export async function signWinsAfterGoogleHold(reviewId: string, placeId: string): Promise<SignWinsOutcome> {
  await readPlaceSignboardNow(placeId);
  return signWinsAtTheDoor(reviewId);
}

export type SignWinsSweepResult = {
  /** Waiting Google holds raised since the rule began. */
  looked: number;
  approved: number;
  /** The rule is off, so nothing was approved this run. */
  switchedOff: boolean;
  /** More passed the rule than one run approves; the next run takes them. */
  moreWaiting: boolean;
};

/**
 * The hourly pass: a place the door left because its case was still open, or its sign had not been read
 * yet, is met again here once that has changed. Oldest first. Never throws.
 */
export async function runSignWinsSweep(): Promise<SignWinsSweepResult> {
  const result: SignWinsSweepResult = { approved: 0, looked: 0, moreWaiting: false, switchedOff: false };
  try {
    const read = await readEveryPage<Row>(
      () =>
        getSupabaseAdmin()
          .from("phoenix_crm_validation_reviews")
          .select(REVIEW_COLUMNS)
          .eq("status", "pending")
          .eq("is_test", false)
          .in("google->>reason", [...GOOGLE_HOLD_REASONS])
          .gte("created_at", SIGN_WINS_STARTED_AT)
          .order("created_at", { ascending: true })
          .order("id", { ascending: true }),
      { maxRows: SIGN_WINS_READ_MAX, whenFull: "stop", what: "Phoenix CRM waiting Google holds" },
    );
    if (read.error) throw read.error;
    result.looked = read.rows.length;
    if (read.rows.length === 0) return result;
    const candidates = await loadCandidates(read.rows);
    const passing = read.rows.map((row) => String(row.id)).filter((id) => {
      const candidate = candidates.get(id);
      return candidate !== undefined && signWinsVerdict(candidate).applies;
    });
    if (passing.length === 0) return result;
    if (!(await readSignWinsSwitch()).on) return { ...result, switchedOff: true };
    result.moreWaiting = passing.length > SIGN_WINS_SWEEP_LIMIT;
    for (const reviewId of passing.slice(0, SIGN_WINS_SWEEP_LIMIT)) {
      if (await approveUnderTheRule(reviewId)) result.approved += 1;
    }
    return result;
  } catch (error) {
    logError("Phoenix CRM sign-wins sweep failed", { error, labels: { event: "phoenix_crm_sign_wins_sweep_failed" } });
    return result;
  }
}
