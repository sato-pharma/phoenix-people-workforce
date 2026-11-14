import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { stripComments, stripSqlComments } from "./support/comment-strip.ts";

/**
 * The items the Phoenix CRM validation audit of 14 Nov 2026 left as they were, closed the same day on the
 * owner's word (`20261114062049_phoenix_crm_validation_left_items.sql` and the code that reads its answers):
 *
 *   - approving a held validation behind a building still being checked approves the review and leaves the
 *     customer waiting for the building, and the building's approval then validates him;
 *   - a review left pending on a place no longer in use holds nobody and is listed and counted nowhere;
 *   - every door that validates a customer clears the stamp an old refusal left on him;
 *   - a confirmed retake on a short-named clinic customer tells the Super Admin at once.
 *
 * Source-text assertions on the migration and the services. What the functions DO was proved on production
 * rows inside a rolled-back transaction the day they were applied (docs/phoenix-crm-shared-places.md, "The
 * left items"); these pin the text so a later rewrite cannot lose one quietly. `reviewStillToDecide` is run.
 */

const ROOT = new URL("../", import.meta.url);
const MIGRATION = "supabase/migrations/20261114062049_phoenix_crm_validation_left_items.sql";

function read(path: string): string {
  return readFileSync(new URL(path, ROOT), "utf8").replace(/\r\n/g, "\n");
}

function fnOf(sql: string, name: string): string {
  const start = sql.indexOf(`create or replace function public.${name}(`);
  assert.ok(start > -1, `${name} is defined in the left-items migration`);
  const end = sql.indexOf("\n$$;", start);
  assert.ok(end > start, `${name} ends with its dollar quote`);
  return sql.slice(start, end);
}

/** One TypeScript function's text, from its opening words to the first line that closes it at column 0. */
function tsFn(source: string, opening: string): string {
  const start = source.indexOf(opening);
  assert.ok(start > -1, `"${opening}" is still in the file`);
  const end = source.indexOf("\n}\n", start);
  assert.ok(end > start, `"${opening}" closes`);
  return source.slice(start, end + 2);
}

function assertBefore(source: string, first: string, second: string, why: string): void {
  const a = source.indexOf(first);
  const b = source.indexOf(second);
  assert.ok(a >= 0, `"${first}" is there — ${why}`);
  assert.ok(b >= 0, `"${second}" is there — ${why}`);
  assert.ok(a < b, why);
}

/** The hold both building doors keep: a waiting review on a place in use, or a timetable nobody approved past. */
const BUILDING_HOLD =
  /if exists \(\s+select 1 from public\.phoenix_crm_validation_reviews r\s+where r\.customer_id = v_seated\.customer_id and r\.status = 'pending'\s+and exists \(select 1 from public\.phoenix_crm_places pl where pl\.id = r\.place_id and pl\.status = 'active'\)\s+\)\s+or \(\s+\(v_venue\.schedule_photo_path is null or \(v_seated\.schedule_check ->> 'verdict'\) in \('other_name', 'no_schedule'\)\)\s+and not exists \(\s+select 1 from public\.phoenix_crm_validation_reviews r\s+where r\.place_id = v_seated\.place_id and r\.status = 'approved'\s+\)\s+\) then/;

export function runPhoenixCrmValidationLeftItemsTests(): void {
  const raw = read(MIGRATION);
  const sql = stripSqlComments(raw);
  assert.ok(!raw.includes("$function$"), "the house dollar quote, so the module's boundary test can read each function");

  // ── An approval behind a building still being checked waits for the building ───────────────────
  const decide = fnOf(sql, "phoenix_crm_decide_validation_review");
  assert.match(
    decide,
    /select sp\.status into v_building_status\s+from public\.phoenix_crm_shared_places sp\s+where sp\.id = \(select pl\.shared_place_id from public\.phoenix_crm_places pl where pl\.id = v_review\.place_id\)\s+for share;/,
    "the building's row is read under a share lock",
  );
  assertBefore(
    decide,
    "select sp.status into v_building_status",
    "select c.* into v_customer from public.phoenix_crm_customers c where c.id = v_review.customer_id for update;",
    "🔴 the building is locked BEFORE the customer, the order the building's own decision takes them in",
  );
  assert.match(
    decide,
    /v_waiting := v_review\.kind = 'validation' and v_customer\.status = 'pending' and v_place\.status = 'active'\s+and v_place\.shared_place_id is not null and coalesce\(v_building_status, ''\) = 'held';/,
    "he waits only when the place is seated in a building that is itself still held",
  );
  assert.match(
    decide,
    /if v_review\.kind = 'validation' and v_customer\.status = 'pending' and v_place\.status = 'active' and not v_waiting then\s+update public\.phoenix_crm_customers c\s+set status = 'active',/,
    "🔴 a customer who waits for his building is NOT validated by the review's approval",
  );
  assertBefore(decide, "set status = 'approved', decided_by_hr_id = v_actor", "v_waiting :=", "the review is approved all the same");
  assert.ok(
    decide.includes("jsonb_build_object('review_id', v_id, 'note', v_note, 'validated', v_validated, 'waiting_for_building', v_waiting)"),
    "the event records that he waits",
  );
  assert.match(decide, /'validated', v_validated,\s+'waiting_for_building', v_waiting,/, "and the answer says so, for the screen");

  const restore = fnOf(sql, "phoenix_crm_restore_validation");
  assert.match(
    restore,
    /select sp\.status into v_building_status\s+from public\.phoenix_crm_shared_places sp\s+where sp\.id = v_place\.shared_place_id\s+for share;\s+v_waiting := v_customer\.status = 'pending' and v_place\.shared_place_id is not null and coalesce\(v_building_status, ''\) = 'held';\s+if v_customer\.status = 'pending' and not v_waiting then/,
    "🔴 a rejection taken back into a held building brings the place back and validates nobody yet",
  );
  assert.match(restore, /'renamed', v_renamed, 'waiting_for_building', v_waiting\)/, "the restore's event records the wait");
  assert.match(restore, /\n\s+'waiting_for_building', v_waiting,\n/, "and so does its answer");

  // ── …and the building's approval releases him ──────────────────────────────────────────────────
  const venue = fnOf(sql, "phoenix_crm_decide_shared_place");
  assert.match(venue, BUILDING_HOLD, "🔴 approving a building: a seat a person already approved is not held by the timetable, and a waiting review holds only on a place in use");
  assert.match(
    venue,
    /set status = 'active', validated_at = now\(\), validated_by_hr_id = v_actor, reopened_at = null,\s+status_changed_at = now\(\), updated_at = now\(\)\s+where c\.id = v_seated\.customer_id and c\.status = 'pending';/,
    "and validating him clears the stamp of an old refusal",
  );
  const venueBack = fnOf(sql, "phoenix_crm_restore_shared_place");
  assert.match(venueBack, BUILDING_HOLD, "🔴 taking a building's rejection back keeps the same two holds, word for word");
  for (const [name, body] of [["phoenix_crm_decide_shared_place", venue], ["phoenix_crm_restore_shared_place", venueBack]] as const) {
    assert.doesNotMatch(
      body,
      /where r\.customer_id = v_seated\.customer_id and r\.status = 'pending'\s+\)/,
      `${name}: no test of "any pending review" is left — a review on a retired place is nobody's to decide`,
    );
  }

  // ── A pending review counts only while its place is in use ─────────────────────────────────────
  const trusted = fnOf(sql, "phoenix_crm_place_on_trusted_point");
  assert.match(
    trusted,
    /where r\.customer_id = v_customer\.id and r\.status = 'pending'\s+and exists \(select 1 from public\.phoenix_crm_places pl where pl\.id = r\.place_id and pl\.status = 'active'\)\s+\) then\s+raise exception 'phoenix_crm:location_in_review';/,
    "the trusted point refuses for a review in waiting only while that review's place is in use",
  );

  // ── Every door that validates clears the old refusal's stamp ───────────────────────────────────
  const share = fnOf(sql, "phoenix_crm_share_line_validation");
  const request = fnOf(sql, "phoenix_crm_decide_request");
  const reverse = fnOf(sql, "phoenix_crm_reverse_list_request");
  for (const [name, body] of [
    ["phoenix_crm_share_line_validation", share],
    ["phoenix_crm_decide_request", request],
  ] as const) {
    assert.match(body, /set status = 'active',[^;]*?\breopened_at = null,/, `🔴 ${name}: validating a customer clears reopened_at`);
  }
  // A customer sent to To validate keeps his stamp: only the validating branch clears it.
  assert.doesNotMatch(request, /set status = 'pending',[^;]*?\breopened_at = null,/, "an add admitted with no door on file is still waiting, so his stamp stays");
  assert.match(request, /set status = 'pending',[^;]*?\breopened_at = now\(\),/, "and is stamped from now");
  // A bring-back and a reversed drop: stamped when he comes back with no place, cleared when he comes back
  // validated with one, and left alone for a customer who was never validated.
  const BACK_IN_USE =
    /reopened_at = case\s+when c\.validated_at is not null and not v_has_place then now\(\)\s+when c\.validated_at is not null and v_has_place then null\s+else c\.reopened_at\s+end,/;
  assert.match(request, BACK_IN_USE, "🔴 phoenix_crm_decide_request: a bring-back that returns him validated with his place clears reopened_at");
  assert.match(reverse, BACK_IN_USE, "🔴 phoenix_crm_reverse_list_request: a reversed drop that returns him validated with his place clears reopened_at");

  // ── The two clean-ups, narrow by construction ──────────────────────────────────────────────────
  assert.match(
    sql,
    /update public\.phoenix_crm_customers c\s+set reopened_at = null\s+where c\.status = 'active' and c\.reopened_at is not null;/,
    "the stamps are cleared on customers in use only",
  );
  assert.match(
    sql,
    /update public\.phoenix_crm_places pl\s+set pin_lat = null, pin_lon = null, pin_accuracy_meters = null\s+where pl\.point_source = 'shared_place'\s+and pl\.pin_lat is not null\s+and pl\.pin_lat = pl\.lat\s+and pl\.pin_lon = pl\.lon;/,
    "🔴 only a pin that is an exact copy of a seated place's own point is cleared — never a reading taken at a door",
  );
  assert.ok(raw.includes("phoenix_crm_backup_20261114.left_items_reopen_stamps") && raw.includes("phoenix_crm_backup_20261114.left_items_copied_pins"), "the header names where the pre-image is");

  // ── The services carry the wait to the screen ──────────────────────────────────────────────────
  const reviews = stripComments(read("src/lib/phoenix-crm/server/validation-reviews.ts"));
  const decideTs = tsFn(reviews, "export async function decideValidationReview(");
  assert.ok(decideTs.includes('const waitingForBuilding = decision === "approve" && result.waiting_for_building === true;'), "the wait is the database's own answer, on an approve only");
  assert.ok(decideTs.includes('return { reviewId, status: decision === "approve" ? "approved" : "rejected", waitingForBuilding };'), "and the decision's answer carries it");
  const restoreTs = tsFn(reviews, "export async function restoreValidation(");
  assert.ok(restoreTs.includes("waitingForBuilding: result.waiting_for_building === true,"), "the take-back's answer carries it too");

  const done = read("src/components/phoenix-crm/place-check-done.tsx");
  assert.match(
    done,
    /export function approvalOutcome\(answer: unknown, plain: "approved" \| "restored"\): PlaceCheckOutcome \{\s+const waiting = answer !== null && typeof answer === "object" && \(answer as \{ waitingForBuilding\?: unknown \}\)\.waitingForBuilding === true;\s+return waiting \? "waiting_building" : plain;\s+\}/,
    "one reading of the server's answer, for every approval control",
  );
  assert.ok(done.includes('waiting_building: { text: "Approved, waits for the building", tone: "good" },'), "the saved mark says he waits");
  assert.ok(
    done.includes('export const APPROVED_WAITS_FOR_BUILDING = "Saved. The customer is counted once the building is approved.";'),
    "🔴 and one plain sentence says when he counts — never \"Approved\" over a customer still under To validate",
  );
  assert.ok(read("src/components/place-review-deck/review-deck.tsx").includes('waiting_building: "Approved, waits for the building",'), "the one-by-one review names it in its summary");
  for (const [file, call] of [
    ["src/components/phoenix-crm/validation-review-queue.tsx", 'markSaved(done(decision === "approve" ? approvalOutcome(decided, "approved") : "rejected"));'],
    ["src/components/phoenix-crm/shared-place-customers.tsx", 'markSaved(done(decision === "approve" ? approvalOutcome(decided, "approved") : "rejected"));'],
    ["src/components/phoenix-crm/place-check-restore.tsx", 'markSaved(done(approvalOutcome(restored, "restored")));'],
  ] as const) {
    assert.ok(read(file).includes(call), `${file} draws what the server answered, not what was pressed`);
  }

  // ── A review left waiting on a place no longer in use: listed nowhere, counted nowhere ─────────
  const still = tsFn(reviews, "function reviewStillToDecide(");
  const body = still.slice(still.indexOf("{") + 1, still.lastIndexOf("}"));
  const reviewStillToDecide = new Function("review", "placeById", body) as (review: Record<string, unknown>, placeById: Map<string, Record<string, unknown>>) => boolean;
  const places = new Map<string, Record<string, unknown>>([
    ["in-use", { id: "in-use", status: "active" }],
    ["retired", { id: "retired", status: "retired" }],
  ]);
  assert.equal(reviewStillToDecide({ status: "pending", place_id: "in-use" }, places), true, "a waiting review on a place in use is somebody's to decide");
  assert.equal(reviewStillToDecide({ status: "pending", place_id: "retired" }, places), false, "🔴 a waiting review on a retired place is nobody's to decide");
  assert.equal(reviewStillToDecide({ status: "pending", place_id: "unread" }, places), true, "🔴 a place that could not be read hides nothing");
  assert.equal(reviewStillToDecide({ status: "rejected", place_id: "retired" }, places), true, "a decided row keeps its history and its undo");
  assert.equal(reviewStillToDecide({ status: "approved", place_id: "retired" }, places), true, "approved or rejected alike");

  const twins = stripComments(read("src/lib/phoenix-crm/server/line-twins.ts"));
  const world = tsFn(twins, "export async function loadTwinWorld(");
  assert.ok(world.includes('readAll("phoenix_crm_validation_reviews", "id, customer_id, place_id", scope,'), "the line sharing reads which place each waiting review is about");
  assert.match(
    world,
    /const reviewedPlaces = await selectByIds<Row>\("phoenix_crm_places", "id, status", "id", \[\.\.\.new Set\(reviewRows\.map\(\(row\) => String\(row\.place_id\)\)\)\]\);/,
    "🔴 and asks those places by id — a review and its place can sit on two territories, so the scope's own places are not the answer",
  );
  assert.match(
    world,
    /reviewRows\.filter\(\(row\) => \(reviewedPlaceStatus\.get\(String\(row\.place_id\)\) \?\? "active"\) === "active"\)\.map\(\(row\) => String\(row\.customer_id\)\)/,
    "a customer is in review only for a place in use; a place that could not be read still holds him",
  );

  // ── A confirmed retake on a short-named clinic customer is handed over at once ─────────────────
  const list = stripComments(read("src/lib/phoenix-crm/server/list.ts"));
  const retake = tsFn(list, "export async function retakePlaceSignboard(");
  assert.match(
    retake,
    /if \(confirmed && reviewId\) \{\s+if \(await approveHeldSignboardBySystem\(reviewId\)\) \{\s+if \(!isTest\) await withdrawValidationNotConfirmed\(customerId\);\s+return;\s+\}\s+if \(!isTest && approvalNeedsFullName\(\{ listType, customerName \}\)\) \{\s+await notifyValidationReviewWaiting\(\{ customerName, seat, repHrId: viewer\.hrId, reviewId \}\);\s+\}\s+return;\s+\}/,
    "🔴 the system never approves one or two names, so the Super Admin is told now — and only for that reason, never for a review he already decided",
  );
}
