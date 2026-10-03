/**
 * Phoenix CRM — calling the module's database functions, and turning their refusals into sentences.
 *
 * Every save function raises `phoenix_crm:<code>` (supabase/migrations/20260916150000_phoenix_crm.sql).
 * Each code maps to what the person on the phone should do next; anything else is an infrastructure
 * error and stays one (toApiError hides its detail from the client).
 */

import { ApiError } from "@/lib/http/api-errors";
import { CUSTOMER_PHONE_ERROR } from "@/lib/phoenix-crm/entry-rules";
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
  // The database's own check on the phone (owner, 2026-09-30), in the same words the form uses.
  bad_phone: { status: 400, message: CUSTOMER_PHONE_ERROR },
  customer_dropped: { status: 409, message: "This customer has left the list." },
  too_many_places: { status: 409, message: "A customer can have at most five places." },
  place_not_found: { status: 404, message: "This place is no longer on the list. Reload the list." },
  place_retired: { status: 409, message: "This place was already removed." },
  last_place: { status: 409, message: "A customer keeps at least one place. To take the customer off the list, ask for a drop." },
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
    message: "This customer is in the Archive. Open him there and ask to bring him back to your list.",
  },
  request_wrong_stage: { status: 409, message: "This request has moved on to the next step. Reload the page." },
  potential_grade_required: { status: 400, message: "Choose the customer's potential (AA to BC) before approving." },
  not_outside: { status: 409, message: "This customer is no longer waiting outside the list. Reload the page." },
  not_archived: { status: 409, message: "This customer is not in the Archive. Reload the page." },
  not_on_list: { status: 409, message: "This customer is not on your list yet. Ask to add him to your list first." },
  move_reason_required: { status: 400, message: "Write why the place is moved (at least 10 characters)." },
  // The daily forecast (owner, 2026-10-01): CNS only, and the database refuses any other line itself.
  not_forecast_line: { status: 403, message: "The daily forecast is for the CNS line only." },
  // A record a rep missed, entered by the Super Admin (owner, 2026-10-01): any day that has begun.
  future_day: { status: 400, message: "That day has not begun yet. Choose today or an earlier day." },
  // ...and taken back by him when entered by mistake: his own entry only.
  visit_not_found: { status: 404, message: "This visit is no longer there. Reload the page." },
  not_entered_by_you: { status: 403, message: "Only a visit you entered for a rep can be removed. A rep's own visit stays his record." },
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

export function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function textOrNull(value: unknown): string | null {
  const text = typeof value === "string" ? value.trim() : value === null || value === undefined ? "" : String(value).trim();
  return text.length > 0 ? text : null;
}
