import assert from "node:assert/strict";

import { lastDefinerPath, lastDefinerSql } from "./support/sql-definer.ts";

/**
 * Phoenix CRM — rejecting a building closes the reviews still waiting on the places it retires.
 *
 * Place checks, the pass to 9.5 (owner, 23 Nov 2026: every item under 9.5 fixed). A rejected building retired
 * its seats and left their validation reviews 'pending' on retired places: nothing left to decide, yet on the
 * page and counted in "N have waited over 72 hours". On production two real reviews were stranded that way
 * (buildings rejected 19 Nov and 22 Nov 2026); they were closed by an announced data change with a pre-image in
 * phoenix_crm_backup_20261123.validation_reviews_stranded.
 *
 * The fix is `20261123153104_phoenix_crm_building_reject_closes_its_reviews.sql`, proven on production inside a
 * rolled-back transaction (one review closed with the building's own stamp, one list event, a review in another
 * building untouched, and the take-back reopening it). Pinned here against the SQL the database last ran:
 *   1. the REJECT loop closes a review still pending on the place it just retired — that place only — as the
 *      building's own decision (its decider, moment, note and refusal reason), with one list event;
 *   2. it tells the rep nothing more: the function sends no notice of its own;
 *   3. taking the rejection back reopens exactly those reviews — rejected at the building's retired_at, by its
 *      decider, with no stored system advice — and does so BEFORE the holds are read;
 *   4. both stay SECURITY DEFINER, closed to the browser roles and given to the service role alone.
 */

const DECIDE = /\bcreate\s+or\s+replace\s+function\s+public\.phoenix_crm_decide_shared_place\s*\(/i;
const RESTORE = /\bcreate\s+or\s+replace\s+function\s+public\.phoenix_crm_restore_shared_place\s*\(/i;

/** One function's header and body, as its last-defining migration holds it, whitespace folded. */
function functionText(pattern: RegExp, label: string): string {
  const sql = lastDefinerSql(pattern, label).replace(/\r\n/g, "\n");
  const start = sql.search(pattern);
  const end = sql.indexOf("$$;", sql.indexOf("as $$", start) + 5);
  assert.ok(start >= 0 && end > start, `${label}: its body is found in its last-defining migration`);
  return sql.slice(start, end).replace(/\s+/g, " ");
}

function grantsOf(pattern: RegExp, label: string, name: string): void {
  const sql = lastDefinerSql(pattern, label).replace(/\s+/g, " ");
  assert.ok(
    sql.includes(`revoke execute on function public.${name}(jsonb) from public, anon, authenticated;`),
    `${label}: closed to public, anon and authenticated`,
  );
  assert.ok(sql.includes(`grant execute on function public.${name}(jsonb) to service_role;`), `${label}: given to the service role`);
}

function checkDecide(): void {
  const body = functionText(DECIDE, "phoenix_crm_decide_shared_place");
  assert.match(body, /\bsecurity definer\b/, "decide stays SECURITY DEFINER");
  assert.match(body, /set search_path to 'public'/, "decide fixes its search path");

  const reject = body.slice(body.indexOf("set status = 'retired'"));
  assert.ok(reject.length < body.length, "the reject branch is found");
  const loopStart = reject.indexOf(" loop ");
  const loopEnd = reject.indexOf(" end loop;", loopStart);
  assert.ok(loopStart > 0 && loopEnd > loopStart, "the reject branch walks the building's seats");
  const loop = reject.slice(loopStart, loopEnd);

  const retire = loop.indexOf("update public.phoenix_crm_places pl set status = 'retired'");
  const close = loop.indexOf("update public.phoenix_crm_validation_reviews r");
  assert.ok(retire >= 0, "each seat's place is retired in the loop");
  assert.ok(close > retire, "a review still waiting on that place is closed in the same loop, after the place is retired");

  const closeStatement = loop.slice(close, loop.indexOf(";", close));
  assert.match(
    closeStatement,
    /set status = 'rejected', decided_by_hr_id = v_actor, decided_at = now\(\), decision_note = v_note, refusal_reason = v_reason/,
    "the review is closed as the building's own decision: its decider, moment, note and refusal reason",
  );
  assert.match(
    closeStatement,
    /where r\.place_id = v_seated\.place_id and r\.status = 'pending' returning r\.id into v_review_id/,
    "only the review still pending on the place this rejection retired is touched",
  );
  assert.doesNotMatch(closeStatement, /customer_id/, "a review is matched by its place, never by the customer, who may stand on another place");

  assert.match(
    loop,
    /if v_review_id is not null then v_reviews_closed := v_reviews_closed \+ 1; insert into public\.phoenix_crm_list_events \([^)]*\) values \( v_venue\.seat_id, v_seated\.customer_id, v_seated\.place_id, 'validation_review_rejected', v_actor,/,
    "a closed review leaves one validation_review_rejected list event",
  );
  assert.match(loop, /'why', 'shared_place_rejected', 'shared_place_id', v_id/, "the event says the building's rejection closed it");
  assert.match(body, /v_review_id := null; update public\.phoenix_crm_validation_reviews/, "the id is cleared per seat, so one closed review is never counted again");
  assert.match(body, /'reviews_closed', v_reviews_closed/, "the result says how many reviews the rejection closed");

  // The rep is told once, by the building's rejection, through `reopened` — this function sends nothing.
  assert.doesNotMatch(body, /pg_notify|net\.http|_outbox|notifications\b/i, "decide sends no notice of its own");
  assert.match(body, /v_reopened := v_reopened \|\| jsonb_build_array/, "the rep is still told through the reopened list");
}

function checkRestore(): void {
  const body = functionText(RESTORE, "phoenix_crm_restore_shared_place");
  assert.match(body, /\bsecurity definer\b/, "restore stays SECURITY DEFINER");
  assert.match(body, /set search_path to 'public'/, "restore fixes its search path");

  const reopen = body.indexOf("update public.phoenix_crm_validation_reviews r set status = 'pending'");
  assert.ok(reopen > 0, "taking the rejection back reopens the review it closed");
  const statement = body.slice(reopen, body.indexOf(";", reopen));
  assert.match(
    statement,
    /decided_by_hr_id = null, decided_at = null, decision_note = null, refusal_reason = null/,
    "a reopened review is undecided again, as the CHECK (pending = no decided_at) requires",
  );
  assert.match(statement, /where r\.place_id = v_seated\.place_id/, "only a place this take-back brings back");
  assert.match(statement, /r\.status = 'rejected' and r\.decided_at = v_retired_at/, "only a review closed at the building's own moment");
  assert.match(statement, /r\.decided_by_hr_id is not distinct from v_venue\.retired_by_hr_id/, "only a review closed by the building's own decider");
  assert.match(statement, /r\.system_advice_at_decision is null/, "never a review someone decided on its own photo");

  const holds = body.indexOf("if v_seated.customer_status = 'pending' then");
  assert.ok(holds > reopen, "the review waits again BEFORE the holds are read, so the customer is not validated on a photo nobody decided");
  assert.match(body, /'reviews_reopened', v_reviews_reopened/, "the result says how many reviews the take-back reopened");
}

export function runPhoenixCrmBuildingRejectClosesReviewsTests(): void {
  assert.match(
    lastDefinerPath(DECIDE, "phoenix_crm_decide_shared_place"),
    /\d{14}_[a-z0-9_]+\.sql$/,
    "decide is defined by a migration",
  );
  checkDecide();
  checkRestore();
  grantsOf(DECIDE, "phoenix_crm_decide_shared_place", "phoenix_crm_decide_shared_place");
  grantsOf(RESTORE, "phoenix_crm_restore_shared_place", "phoenix_crm_restore_shared_place");
}
