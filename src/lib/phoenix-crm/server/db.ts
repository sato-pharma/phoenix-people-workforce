/**
 * Phoenix CRM — calling the module's database functions, and turning their refusals into sentences.
 *
 * Every save function raises `phoenix_crm:<code>` (supabase/migrations/20260916150000_phoenix_crm.sql).
 * Each code maps to what the person on the phone should do next; anything else is an infrastructure
 * error and stays one (toApiError hides its detail from the client).
 */

import { ApiError } from "@/lib/http/api-errors";
import { CUSTOMER_PHONE_ERROR } from "@/lib/phoenix-crm/entry-rules";
import { SHARED_PLACE_DAY_FULL_TEXT } from "@/lib/phoenix-crm/shared-place-rules";
import { OFFPLAN_DAY_FULL_TEXT, OFFPLAN_WEEK_FULL_TEXT } from "@/lib/phoenix-crm/unplanned-rules";
import { fetchAllRowsKeyset } from "@/lib/supabase/paginated";
import { getSupabaseAdmin } from "@/lib/supabase/server";

type Refusal = { status: number; message: string };

const REFUSALS: Record<string, Refusal> = {
  bad_input: { status: 400, message: "Something in this entry is missing. Reload the page and try again." },
  not_on_reference_list: { status: 404, message: "This customer is no longer on the territory's reference list. Reload the list." },
  already_validated: { status: 409, message: "This customer is already validated on the list." },
  // The Google check (owner, 2026-10-03). The rep's words are the system's, never a person's.
  location_in_review: { status: 409, message: "The system is still checking this customer's location. It confirms it automatically." },
  review_not_found: { status: 404, message: "This place is no longer waiting. Reload the page." },
  review_decided: { status: 409, message: "This place was already decided. Reload the page." },
  // Approving after a rejection (owner, 2026-10-03: "add the option to approve after reject").
  review_not_rejected: { status: 409, message: "This place was not rejected, so there is nothing to bring back. Reload the page." },
  place_not_retired: { status: 409, message: "This place is not retired any more. Reload the page." },
  same_name: {
    status: 409,
    message: "A customer with this name is already on the list. If this is a different person, confirm it and save again.",
  },
  customer_not_found: { status: 404, message: "This customer is not on the territory's list. Reload the list." },
  // The trigger that refuses a LATE reference id (public.phoenix_crm_customers_no_late_reference).
  // It existed only in production until its migration was written, so this table had never seen the
  // code and the refusal reached the screen as the generic "could not be saved". The person who
  // meets it is doing an identity correction, and merging the two records is the way out.
  customer_already_has_own_contact_id: {
    status: 409,
    message:
      "This customer already has an own id that every report outside Phoenix CRM counts, so a reference id cannot be set now — it would restate months that have already been read. Merge the two records instead.",
  },
  // The trigger that refuses a customer row pointing at a doctor the rep already added under his own id
  // (public.phoenix_crm_customers_no_double_add, owner 2026-10-12). Nothing in the app inserts one on
  // purpose; this is the answer if a door ever does.
  doctor_already_on_list: { status: 409, message: "This customer is already on the list. Reload the list." },
  // The database's own check on the phone (owner, 2026-09-30), in the same words the form uses.
  bad_phone: { status: 400, message: CUSTOMER_PHONE_ERROR },
  customer_dropped: { status: 409, message: "This customer has left the list." },
  // A pharmacy's own location and its responsible person's phone (owner, 2026-10-09) belong to a
  // pharmacy alone: a clinic's place is captured at the door with a photo and two readings.
  not_a_pharmacy: { status: 409, message: "Only a pharmacy keeps its location this way. Reload the list." },
  too_many_places: { status: 409, message: "A customer can have at most five places." },
  place_not_found: { status: 404, message: "This place is no longer on the list. Reload the list." },
  place_retired: { status: 409, message: "This place was already removed." },
  last_place: { status: 409, message: "A customer keeps at least one place. To take the customer off the list, ask for a drop." },
  // A shared place — a polyclinic, a medical centre, a medical tower, a hospital outpatient suite
  // (owner, 2026-10-09). The cap is the database's own BEFORE INSERT trigger on the visits table, so
  // it answers the rep's save, a manager's entry for him and the Super Admin's entry alike.
  shared_place_day_full: { status: 409, message: SHARED_PLACE_DAY_FULL_TEXT },
  // The off-plan cap (owner, 2026-10-10): two doctors a day, eight a week, out of plan. The database's
  // own BEFORE INSERT trigger, so it answers the rep's save, a manager's entry and the Super Admin's.
  offplan_day_full: { status: 409, message: OFFPLAN_DAY_FULL_TEXT },
  offplan_week_full: { status: 409, message: OFFPLAN_WEEK_FULL_TEXT },
  shared_place_not_found: { status: 404, message: "This polyclinic or centre is no longer there. Reload the page." },
  shared_place_retired: { status: 409, message: "This polyclinic or centre was removed. Reload the page." },
  // The mirror of `place_not_retired`: the rejection this would take back is not the state the venue
  // is in any more — somebody has already brought it back, or it was never rejected.
  shared_place_not_retired: { status: 409, message: "This polyclinic or centre is not waiting to be brought back. Reload the page." },
  shared_place_held: {
    status: 409,
    // Only the Super Admin's MOVE reaches this now (a rep's seating in a held venue is allowed since
    // 2026-10-14), so the sentence tells the person who can actually clear it.
    message: "This polyclinic or centre is still waiting for your decision. Approve it on the Place checks board, then move customers into it.",
  },
  // 🔴 THIS IS WHAT MAKES A SEATING IDEMPOTENT NOW (owner, 2026-10-10 — one timetable for the whole
  // building). Until that day every seating consumed a single-use photo slot, so a second Save
  // answered `photo_used`; a customer seated against the board already on file consumes no slot, so
  // the second Save is refused here instead — checked inside `phoenix_crm_insert_place` while the
  // venue's row is locked, which also serialises two reps seating the same doctor at the same second.
  // His hours are windows in the ONE row, so a second row was never how a doctor receives twice.
  already_seated: {
    status: 409,
    message: "This customer is already registered in this polyclinic or centre. Open the place to change the hours.",
  },
  // Moving a standalone clinic INTO a polyclinic (owner, 2026-10-10 — "add the option to the admin to
  // move this doctor to"). A place already inside a building is never re-seated: its point is that
  // building's, so a second move would overwrite the record of where it came from with a point that was
  // never its own.
  already_in_a_venue: { status: 409, message: "This clinic is already inside a polyclinic or centre. Reload the list." },
  pharmacy_cannot_be_seated: { status: 409, message: "A pharmacy cannot be moved into a polyclinic or centre." },
  no_places_chosen: { status: 400, message: "Tick at least one customer to move into the polyclinic." },
  note_required: { status: 400, message: "Write a note explaining why." },
  // Removing a clinic is kept on record exactly as a move is (2026-10-02), so the reason has the same
  // bounds and the same sentence: the person refused here is a mover, and he is told the length.
  reason_required: { status: 400, message: "Write why the place is removed (at least 10 characters)." },
  // The SFE's list upload, and the only person who can meet it is the one holding the sheet.
  too_many_rows: { status: 400, message: "That sheet holds too many customers for one upload. Split it and load it in two." },
  not_validated: { status: 409, message: "Validate this customer first." },
  same_grade: { status: 409, message: "The customer already has this grade." },
  already_pending: { status: 409, message: "A request for this customer is already waiting for a decision." },
  request_not_found: { status: 404, message: "This request is no longer there. Reload the page." },
  request_decided: { status: 409, message: "This request was already decided. Reload the page." },
  already_decided: { status: 409, message: "This was already decided. Reload the page." },
  day_not_editable: { status: 409, message: "A day that has passed cannot be changed. Reload the planner." },
  version_conflict: { status: 409, message: "This plan was changed on another screen. Reload it and try again." },
  not_editable: { status: 409, message: "This plan is waiting for review or approved. Ask to edit this week to change it." },
  customer_not_on_list: { status: 409, message: "A planned customer is no longer on the validated list. Reload the planner." },
  place_changed: { status: 409, message: "A customer's place was changed. Reload and try again." },
  plan_not_found: { status: 404, message: "This plan is no longer there. Reload the page." },
  bad_transition: { status: 409, message: "This plan has already moved on. Reload it." },
  week_passed: { status: 409, message: "This week is over, so its plan can no longer change. Reload the page." },
  month_passed: { status: 409, message: "This month is over, so its plan can no longer change. Reload the page." },
  empty_plan: { status: 409, message: "Place at least one customer before sending the plan." },
  // Returning ONE day of a sent week (owner, 2026-10-02): a working day of that week that has not passed.
  day_not_returnable: {
    status: 409,
    message: "That day cannot be returned on its own: choose a day of this week that has not passed. Reload the page.",
  },
  // Asking to edit a sent week (owner, 2026-10-01): the district manager, then SFE, then HR.
  plan_edit_not_sent: { status: 409, message: "This week is not sent, so there is nothing to ask for. Reload the plan." },
  plan_edit_already_open: { status: 409, message: "You already asked to edit this week. It is waiting for a decision." },
  plan_edit_not_found: { status: 404, message: "This request is no longer there. Reload the page." },
  plan_edit_decided: { status: 409, message: "This request was already decided. Reload the page." },
  plan_edit_wrong_stage: { status: 409, message: "This request has moved on to the next step. Reload the page." },
  // The Administrator taking back a decision (owner, 2026-10-08): each refusal says what is in the way.
  plan_edit_not_reopened: { status: 409, message: "This week is not reopened any more. Reload the page." },
  plan_edit_cannot_reverse: {
    status: 409,
    message: "This week was already changed or sent again, or its week has passed, so it cannot be closed again. Return the week with a comment instead.",
  },
  unplanned_not_approved: { status: 409, message: "This visit is not approved any more. Reload the page." },
  request_not_approved: { status: 409, message: "This request is not approved any more. Reload the page." },
  reverse_customer_moved_on: {
    status: 409,
    message: "Something else has changed for this customer since the decision, so it cannot be undone safely.",
  },
  bad_participants: { status: 400, message: "Choose who was on the visit." },
  id_conflict: { status: 409, message: "This visit could not be saved. Start the visit again." },
  photo_not_issued: { status: 400, message: "This photo was not taken in Phoenix CRM. Take the photo again." },
  photo_used: { status: 409, message: "This photo is already used. Take a new photo." },
  photo_expired: { status: 409, message: "This photo was taken more than 2 hours ago. Take a new photo." },
  photo_missing: { status: 409, message: "The photo did not finish uploading. Check your connection and take the photo again." },
  // The voice note's four, word-for-word beside the photo's because they are the same four states of
  // the same kind of slot. Without them a rep whose recording slot lapsed was told only "this entry
  // could not be saved", which names nothing he can act on — and re-recording is exactly what he has
  // to do. The two hours are the slot's, set in phoenix_crm_take_voice.
  voice_not_issued: { status: 400, message: "This recording was not made in Phoenix CRM. Record the note again." },
  voice_used: { status: 409, message: "This recording is already on a visit. Record a new note." },
  voice_expired: { status: 409, message: "This recording was made more than 2 hours ago. Record it again." },
  voice_missing: { status: 409, message: "The recording did not finish uploading. Check your connection and record it again." },
  // The visit recording the Super Admin requires of chosen reps (owner, 2026-10-16). Each one sends the
  // rep back to the recorder: the screen drops the recording it holds when it reads any of these codes.
  recording_not_issued: { status: 400, message: "This recording was not made in Phoenix CRM. Record the visit again." },
  recording_used: { status: 409, message: "This recording is already on another visit. Record this visit again." },
  recording_expired: { status: 409, message: "This recording was made more than 6 hours ago. Record the visit again." },
  recording_too_short: { status: 409, message: "A visit recording is at least 30 seconds long. Record the visit again." },
  recording_missing: { status: 409, message: "The recording did not finish uploading. Check your connection and send it again." },
  // The Administrator's approval of a recorded visit (owner, 2026-10-16). Only his page meets these.
  recording_review_not_found: { status: 404, message: "This recorded visit is no longer there. Reload the page." },
  recording_reviewed: { status: 409, message: "This recorded visit was already decided. Reload the page." },
  already_visited: { status: 409, message: "This customer's visit for today is already saved." },
  // The database's own sent-plan test disagreed with the form: the customer was not on a plan this rep
  // had sent for that day, so the visit needs a reason before it can be saved as an off-plan one.
  clarification_required: {
    status: 400,
    message: "This customer is not on a plan you have sent for today. Write why you went, then save again.",
  },
  unplanned_not_found: { status: 404, message: "This visit is no longer waiting for a decision. Reload the page." },
  unplanned_decided: { status: 409, message: "This visit was already decided. Reload the page." },
  unplanned_wrong_stage: { status: 409, message: "This visit has moved on to the next step. Reload the page." },
  // The rep's flow rebuilt, 2026-09-29 (supabase/migrations/20260929235106_phoenix_crm_list_admission.sql).
  archived: {
    status: 409,
    message: "This customer is in the Archive. Open them there and ask to bring them back to your list.",
  },
  request_with_rep: { status: 409, message: "This request is waiting for the rep's comment. It can be approved once the rep has answered." },
  already_returned: { status: 409, message: "This request has already been returned to the rep." },
  not_returned: { status: 409, message: "This request is no longer waiting for your comment. Reload the page." },
  cannot_return: { status: 409, message: "Only the step SFE holds can be returned for a comment." },
  request_wrong_stage: { status: 409, message: "This request has moved on to the next step. Reload the page." },
  potential_grade_required: { status: 400, message: "Choose the customer's potential (AA to BC) before approving." },
  not_outside: { status: 409, message: "This customer is no longer waiting outside the list. Reload the page." },
  not_archived: { status: 409, message: "This customer is not in the Archive. Reload the page." },
  not_on_list: { status: 409, message: "This customer is not on your list yet. Ask to add them to your list first." },
  move_reason_required: { status: 400, message: "Write why the place is moved (at least 10 characters)." },
  // Moving a customer from one rep's list to another's (owner, 2026-10-06). The reason's own refusal is
  // `note_required` above, in the same words a place move uses.
  same_seat: { status: 400, message: "That is the rep this customer is with already. Choose a different rep." },
  duplicate_at_destination: {
    status: 409,
    message:
      "That rep already has this customer on the same list. Drop whichever of the two is wrong instead of moving a second copy onto it.",
  },
  // The daily forecast (owner, 2026-10-01): CNS only, and the database refuses any other line itself.
  not_forecast_line: { status: 403, message: "The daily forecast is for the CNS line only." },
  // A record a rep missed, entered by the Super Admin (owner, 2026-10-01): any day that has begun.
  future_day: { status: 400, message: "That day has not begun yet. Choose today or an earlier day." },
  // ...and taken back by him when entered by mistake: his own entry only.
  visit_not_found: { status: 404, message: "This visit is no longer there. Reload the page." },
  not_entered_by_you: { status: 403, message: "Only a visit you entered for a rep can be removed. A rep's own visit stays their record." },
  // ...and CORRECTED by him when a rep chose wrongly (owner, 2026-10-06): who was on it, its products and
  // its comment. The database refuses a visit a manager entered, whose people stay as the manager recorded.
  visit_people_fixed: {
    status: 409,
    message: "A manager entered this visit, so who was on it stays as they recorded. The products and the comment can still be corrected.",
  },
  // The REP fills in his own visit's detail (owner, 2026-10-15). The service refuses all three before
  // it calls, so these answer a stale page rather than a wrong screen.
  visit_not_yours: { status: 409, message: "This visit is not yours, so its detail stays as it was recorded. Reload the page." },
  visit_is_linked: {
    status: 409,
    message: "This pharmacy visit came from the visit that named it. Add the detail on that visit.",
  },
  pharmacy_name_fixed: {
    status: 409,
    message: "The pharmacy you named stays as you recorded it. You can still change what it has. Reload the page.",
  },
  // The district manager's double-visit plan (owner, 2026-10-02): one half-day at a time.
  double_visit_not_field_time: {
    status: 400,
    message: "A double visit is planned on a field day: Saturday to Wednesday AM or PM, Thursday AM only.",
  },
  double_visit_day_passed: { status: 409, message: "This day has passed, so its double visits stay as they were planned. Reload the page." },
  double_visit_week_ahead: { status: 409, message: "Double visits are planned for this week and the coming week. Reload the page." },
  double_visit_changed: { status: 409, message: "This half-day was changed on another screen. Reload the page and choose again." },
  // A rep's ask for a visit with somebody (owner, 2026-10-02): raised, answered, taken back.
  visit_ask_not_on_list: { status: 409, message: "This customer is not on your list, so a visit cannot be asked for yet. Ask once the customer is on it." },
  visit_ask_already_open: { status: 409, message: "You already asked for this visit. Its answer shows on this customer's page." },
  visit_ask_not_found: { status: 404, message: "This ask is no longer there. Reload the page." },
  visit_ask_answered: { status: 409, message: "This ask was already answered. Reload the page." },
  visit_ask_cancelled: { status: 409, message: "The rep cancelled this ask. Reload the page." },
  visit_ask_bad_day: { status: 409, message: "Choose one of the days offered: today or a field day in the next four weeks, never a Friday. Reload the page." },
  // A rep's request for a double visit (owner, 2026-10-16): raised from the visit's last question, its days edited, answered. No cancel.
  double_visit_bad_days: { status: 409, message: "Choose one to three days from the list offered: today or a field day in the next four weeks, never a Friday. Reload the page." },
  double_visit_not_requestable: { status: 409, message: "A double visit can be asked for an AM or PM customer on your list only." },
  double_visit_not_found: { status: 404, message: "This request is no longer there. Reload the page." },
  double_visit_not_yours: { status: 403, message: "Only the rep who raised this request changes its days." },
  double_visit_not_asked: { status: 403, message: "Only a person asked answers this request." },
  double_visit_bad_day: { status: 409, message: "Choose one of the days the rep offered that has not passed. Reload the page." },
  // The same-seat duplicate merge (owner, 2026-10-08). Only the one-off script reaches these — the
  // function is service-role only — so the reader is whoever runs it, and each names the pair it skips.
  keeper_is_loser: { status: 400, message: "A customer cannot be merged into itself. Choose two different records." },
  not_same_list: { status: 409, message: "These two records are not on the same rep's list, so they are not merged." },
  list_type_differs: { status: 409, message: "One record is AM and the other PM, so they are not merged." },
  keeper_not_validated: { status: 409, message: "The record being kept is not validated, so the pair is not merged." },
  keeper_holds_no_place: { status: 409, message: "The record being kept has no place while the other has one, so the pair is not merged." },
  loser_has_moves: { status: 409, message: "The record being removed was moved between reps, so the pair is left for a person to decide." },
  visit_same_day: { status: 409, message: "Both records have a visit on the same day, so the pair is left for a person to decide." },
  plan_same_day: { status: 409, message: "Both records are planned on the same day, so the pair is left for a person to decide." },
  ask_waiting_twice: { status: 409, message: "Both records have a visit ask waiting, so the pair is left for a person to decide." },
};

function messageOf(error: unknown): string {
  const message = (error as { message?: unknown } | null)?.message;
  return typeof message === "string" ? message : "";
}

/** The refusal behind a database error, or null when it is not one of this module's. */
export function phoenixCrmRefusal(error: unknown): ApiError | null {
  const match = /phoenix_crm:([a-z_]+)/.exec(messageOf(error));
  if (match) {
    const refusal = REFUSALS[match[1]] ?? { status: 409, message: "This entry could not be saved. Reload the page and try again." };
    return new ApiError(refusal.status, `phoenix_crm_${match[1]}`, refusal.message);
  }
  // A race the function's own checks did not see (they run under a lock, so this should stay rare).
  if ((error as { code?: unknown } | null)?.code === "23505") {
    return new ApiError(409, "phoenix_crm_conflict", "This was already saved on another screen. Reload the page.");
  }
  return null;
}

export async function callPhoenixCrm<T>(fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await getSupabaseAdmin().rpc(fn, args);
  if (error) {
    throw phoenixCrmRefusal(error) ?? error;
  }
  return data as T;
}

/** For `from(...)` reads: a PostgREST error is thrown as it is, never read as an empty result. */
export function throwIfError(error: unknown): void {
  if (error) throw error;
}

export function chunk<T>(values: ReadonlyArray<T>, size = 200): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += size) chunks.push(values.slice(index, index + size));
  return chunks;
}

/**
 * The id list for a `.in()`, cleaned: nullish and empty ids dropped (a single `null` reaches Postgres
 * as the text `"null"` and 22P02s the whole read) and the rest de-duplicated. `new Set(...)` alone does
 * not save you — it keeps one copy of the null.
 */
export function dedupeIds(ids: ReadonlyArray<string | null | undefined>): string[] {
  return [...new Set(ids.filter((id): id is string => typeof id === "string" && id.length > 0))];
}

/**
 * The largest id chunk `selectByIds` sends in one `.in()`. The request URL is echoed back,
 * percent-encoded, in the `Content-Location` response header, which crosses undici's 16 KB cap at
 * ~395 uuid ids — so this stays well under it. (postgrest-in-with-hundreds-of-ids-silently-returns-nothing.)
 */
export const IN_ID_CHUNK = 150;

/**
 * Narrow a Place checks read to a set of org seats — `null` meaning the whole company.
 *
 * WHY THIS IS A HELPER AND NOT `query.in("seat_id", seats)` WRITTEN AT EACH READ. The seat scope
 * (owner, 2026-10-13: a district manager sees "only his team") is the one `.in()` on this board that
 * is NOT a derived id list: it is the viewer's own manager seats, which `teamPlaceChecksSeats` caps
 * at one district — single digits, nowhere near the ~395 cliff above. That makes it safe, and an
 * assertion in `tests/phoenix-crm-place-checks-in-overflow.test.ts` reads the loaders' bodies for a
 * bare `.in(` precisely because a derived one is NOT. Both facts want the same thing: one named place
 * where the seat filter is applied, so the loaders stay clean to read and the bound is checked once.
 *
 * 🔴 AND IT IS CHECKED, not assumed. The seat list is small because of WHICH TIERS
 * `TEAM_PLACE_CHECKS_TIERS` admits; widen that set to a rung with hundreds of seats below it and this
 * `.in()` would reach the cliff, where node's `fetch` throws `UND_ERR_HEADERS_OVERFLOW` and the page
 * renders as "unavailable" with nothing naming the cause. So an over-large scope throws HERE, saying
 * what it is, rather than reaching the wire — the next person to add a tier gets a sentence, not an
 * outage.
 */
/*
 * 🔴 THE CONSTRAINT IS INSIDE, NOT ON `Q`. Written the obvious way —
 * `<Q extends { in: (column: string, values: readonly string[]) => Q }>` — this fails to compile at
 * every call site with TS2589, *Type instantiation is excessively deep and possibly infinite*: a
 * PostgREST builder's own type is deeply recursive, and asking TypeScript to match it against a
 * constraint that refers to `Q` in its own return position sets that recursion going. It is the same
 * wall `selectByIds` meets, which is why its `tune` takes `any`. So `Q` is unconstrained — the call
 * site keeps the builder's exact type, as it must to chain `.order()` afterwards — and the one
 * structural requirement is asserted here, where it costs nothing and reads plainly.
 */
export function seatScoped<Q>(query: Q, seats: readonly string[] | null): Q {
  if (!seats) return query;
  if (seats.length > IN_ID_CHUNK) {
    throw new Error(
      `A Place checks seat scope of ${seats.length} seats cannot be read in one request (the cap is ${IN_ID_CHUNK}). ` +
        "A tier with this many seats below it needs the read chunked, the way selectByIds chunks an id list.",
    );
  }
  return (query as { in: (column: string, values: readonly string[]) => Q }).in("seat_id", seats);
}

/**
 * Read every row of `table` whose `idColumn` is one of `ids` — safely, whatever the size of the field.
 *
 * A PostgREST `.in()` puts the id list in the request URL, which fails THREE ways and only one is
 * quiet (see the memory note `postgrest-in-with-hundreds-of-ids-silently-returns-nothing`):
 *   1. a few hundred ids make the URL — echoed back, percent-encoded, in the `Content-Location`
 *      RESPONSE header — cross undici's 16 KB header cap, and node's `fetch` throws
 *      `UND_ERR_HEADERS_OVERFLOW` ("fetch failed"), which reads as a network fault. The cliff is ~395
 *      ids. This is what took the Place checks page down once the active-place list grew past it;
 *   2. a single `null`/empty id reaches Postgres as the text `"null"` and 22P02s the WHOLE read;
 *   3. an un-paged read stops dead at PostgREST's 1,000-row cap with no error and no marker.
 *
 * So the ids are de-duplicated and nullish ones dropped, each id chunk is kept well under the cliff,
 * and every chunk is keyset-paged on `id`. `columns` MUST therefore include `id`.
 */
export async function selectByIds<T extends Record<string, unknown> = Record<string, unknown>>(
  table: string,
  columns: string,
  idColumn: string,
  ids: ReadonlyArray<string | null | undefined>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tune?: (query: any) => any,
): Promise<T[]> {
  const unique = dedupeIds(ids);
  if (unique.length === 0) return [];
  const rows: T[] = [];
  for (const part of chunk(unique, IN_ID_CHUNK)) {
    const page = await fetchAllRowsKeyset<T>(
      () => {
        const base = getSupabaseAdmin().from(table).select(columns).in(idColumn, part);
        return tune ? tune(base) : base;
      },
      { cursorColumn: "id", cursorOf: (row) => (row.id == null ? null : String(row.id)) },
    );
    rows.push(...page);
  }
  return rows;
}

export function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function textOrNull(value: unknown): string | null {
  const text = typeof value === "string" ? value.trim() : value === null || value === undefined ? "" : String(value).trim();
  return text.length > 0 ? text : null;
}
