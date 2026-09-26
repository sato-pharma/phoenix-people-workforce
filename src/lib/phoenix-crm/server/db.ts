/**
 * Phoenix CRM — calling the module's database functions, and turning their refusals into sentences.
 *
 * Every save function raises `phoenix_crm:<code>` (supabase/migrations/20260916150000_phoenix_crm.sql).
 * Each code maps to what the person on the phone should do next; anything else is an infrastructure
 * error and stays one (toApiError hides its detail from the client).
 */

import { ApiError } from "@/lib/http/api-errors";
import { getSupabaseAdmin } from "@/lib/supabase/server";

type Refusal = { status: number; message: string };

const REFUSALS: Record<string, Refusal> = {
  bad_input: { status: 400, message: "Something in this entry is missing. Reload the page and try again." },
  not_on_reference_list: { status: 404, message: "This customer is no longer on the territory's reference list. Reload the list." },
  already_validated: { status: 409, message: "This customer is already validated on the list." },
  same_name: {
    status: 409,
    message: "A customer with this name is already on the list. If this is a different person, confirm it and save again.",
  },
  customer_not_found: { status: 404, message: "This customer is not on the territory's list. Reload the list." },
  customer_dropped: { status: 409, message: "This customer has left the list." },
  too_many_places: { status: 409, message: "A customer can have at most five places." },
  place_not_found: { status: 404, message: "This place is no longer on the list. Reload the list." },
  place_retired: { status: 409, message: "This place was already removed." },
  last_place: { status: 409, message: "A customer keeps at least one place. To take the customer off the list, ask for a drop." },
  note_required: { status: 400, message: "Write a note explaining why." },
  not_validated: { status: 409, message: "Validate this customer first." },
  same_grade: { status: 409, message: "The customer already has this grade." },
  already_pending: { status: 409, message: "A request for this customer is already waiting for a decision." },
  request_not_found: { status: 404, message: "This request is no longer there. Reload the page." },
  request_decided: { status: 409, message: "This request was already decided. Reload the page." },
  day_not_editable: { status: 409, message: "A day that has passed cannot be changed. Reload the planner." },
  version_conflict: { status: 409, message: "This plan was changed on another screen. Reload it and try again." },
  not_editable: { status: 409, message: "This plan is waiting for review or approved. Reopen it to change it." },
  customer_not_on_list: { status: 409, message: "A planned customer is no longer on the validated list. Reload the planner." },
  place_changed: { status: 409, message: "A customer's place was changed. Reload and try again." },
  plan_not_found: { status: 404, message: "This plan is no longer there. Reload the page." },
  bad_transition: { status: 409, message: "This plan has already moved on. Reload it." },
  week_passed: { status: 409, message: "This week is over, so its plan can no longer change. Reload the page." },
  empty_plan: { status: 409, message: "Place at least one customer before sending the plan." },
  bad_participants: { status: 400, message: "Choose who was on the visit." },
  id_conflict: { status: 409, message: "This visit could not be saved. Start the visit again." },
  photo_not_issued: { status: 400, message: "This photo was not taken in Phoenix CRM. Take the photo again." },
  photo_used: { status: 409, message: "This photo is already used. Take a new photo." },
  photo_expired: { status: 409, message: "This photo was taken more than 2 hours ago. Take a new photo." },
  photo_missing: { status: 409, message: "The photo did not finish uploading. Check your connection and take the photo again." },
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
