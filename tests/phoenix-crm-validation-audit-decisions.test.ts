import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { DOOR_CAPTURED_AGAIN_METERS, doorCapturedAgain, type DoorPlace } from "@/lib/phoenix-crm/door-captured-again";

import { stripComments, stripSqlComments } from "./support/comment-strip.ts";
import { placeCheckListSourceAt } from "./support/place-check-list-source.ts";

/**
 * The owner's decisions of 14 Nov 2026 on the Phoenix CRM validation audit, as the database holds them
 * (`20261114051314_phoenix_crm_validation_owner_decisions.sql`):
 *
 *   - "Stop and say why" — "Approve it after all" is refused, by name, when the customer was dropped, when
 *     the place sits in a retired building, or when the same door was captured again since;
 *   - "Stay in on his clinic" — a customer a building's board does not name, who is validated at a place
 *     of his own, is not sent out of the KPIs by the settle or by the Super Admin's move.
 *
 * Source-text assertions on the migration. What the functions DO was proved on production rows inside a
 * rolled-back transaction the day they were applied (docs/phoenix-crm-shared-places.md, "The validation
 * audit"); these pin the text so a later rewrite of either function cannot lose a decision quietly.
 */

const ROOT = new URL("../", import.meta.url);

function read(path: string): string {
  return readFileSync(new URL(path, ROOT), "utf8").replace(/\r\n/g, "\n");
}

function fnOf(sql: string, name: string): string {
  const start = sql.indexOf(`create or replace function public.${name}(`);
  assert.ok(start > -1, `${name} is defined in the owner-decisions migration`);
  const end = sql.indexOf("\n$$;", start);
  assert.ok(end > start, `${name} ends with its dollar quote`);
  return sql.slice(start, end);
}

function assertBefore(source: string, first: string, second: string, why: string): void {
  const a = source.indexOf(first);
  const b = source.indexOf(second);
  assert.ok(a >= 0, `"${first}" is there — ${why}`);
  assert.ok(b >= 0, `"${second}" is there — ${why}`);
  assert.ok(a < b, why);
}

export function runPhoenixCrmValidationAuditDecisionsTests(): void {
  const file = "supabase/migrations/20261114051314_phoenix_crm_validation_owner_decisions.sql";
  const sql = stripSqlComments(read(file));

  // ── "Stop and say why" ─────────────────────────────────────────────────────────────────────────
  const restore = fnOf(sql, "phoenix_crm_restore_validation");
  const firstWrite = /update public\.phoenix_crm_places pl\s+set status = 'active'/.exec(restore);
  assert.ok(firstWrite, "the restore still brings the place back");
  for (const refusal of ["restore_customer_dropped", "restore_building_retired", "restore_door_captured_again"]) {
    assertBefore(restore, `raise exception 'phoenix_crm:${refusal}'`, firstWrite[0], `${refusal} is raised before the place is brought back`);
    assertBefore(restore, `raise exception 'phoenix_crm:${refusal}'`, "perform public.phoenix_crm_rename_customer(", `${refusal} is raised before the customer is renamed`);
  }
  assertBefore(restore, "raise exception 'phoenix_crm:place_not_retired'", "raise exception 'phoenix_crm:restore_customer_dropped'", "the stale-page refusal still comes first");
  assert.match(restore, /if v_customer\.status = 'dropped' then\s+raise exception 'phoenix_crm:restore_customer_dropped';/, "a dropped customer");
  assert.match(
    restore,
    /v_place\.shared_place_id is not null and exists \(\s+select 1 from public\.phoenix_crm_shared_places sp\s+where sp\.id = v_place\.shared_place_id and sp\.status = 'retired'\s+\) then\s+raise exception 'phoenix_crm:restore_building_retired';/,
    "a retired building",
  );
  const again = restore.slice(restore.indexOf("raise exception 'phoenix_crm:restore_building_retired'"), restore.indexOf("raise exception 'phoenix_crm:restore_door_captured_again'"));
  assert.ok(again.includes("o.customer_id = v_place.customer_id") && again.includes("o.id <> v_place.id") && again.includes("o.status = 'active'"), "the same door: another ACTIVE place of the SAME customer");
  assert.ok(again.includes("o.shared_place_id = v_place.shared_place_id"), "in the same building");
  assert.match(again, /\) <= 150\b/, "or within 150 m of this one");
  assert.ok(again.includes("least(1, sqrt("), "the distance never asks asin for more than 1");
  assert.match(restore, /validated_by_hr_id = v_review\.created_by_hr_id,\s+reopened_at = null,/, "validating him clears the stamp of the old refusal");

  const sentences = stripComments(read("src/lib/phoenix-crm/server/db.ts"));
  for (const refusal of ["restore_customer_dropped", "restore_building_retired", "restore_door_captured_again"]) {
    assert.match(sentences, new RegExp(`${refusal}: \\{\\s+status: 409,\\s+message: "`), `${refusal} has its own sentence, so he reads WHY and not "something went wrong"`);
  }

  // ── The board asks the captured-again test BEFORE it draws the button (19 Nov 2026) ───────────────
  // The Super Admin pressed "Approve it after all" on a customer already captured again at that door and
  // met the refusal. The board now makes the database's own test and draws the reason instead.
  const door = (id: string, lat: number | null, lon: number | null, sharedPlaceId: string | null = null, customerId = "c1"): DoorPlace => ({
    id,
    customerId,
    lat,
    lon,
    sharedPlaceId,
  });
  const refused = door("refused", 30.0444, 31.2357);
  // 0.001° of latitude is about 111 m; 0.0015° about 167 m.
  assert.equal(doorCapturedAgain(refused, [door("again", 30.0454, 31.2357)]), true, "another active place of his within 150 m is the same door");
  assert.equal(doorCapturedAgain(refused, [door("elsewhere", 30.0459, 31.2357)]), false, "past 150 m it is another clinic — the take-back stands");
  assert.equal(doorCapturedAgain(refused, [door("refused", 30.0444, 31.2357)]), false, "the refused place itself never counts against itself");
  assert.equal(doorCapturedAgain(refused, [door("someone", 30.0444, 31.2357, null, "c2")]), false, "another customer's place at the door is not his");
  assert.equal(
    doorCapturedAgain(door("seat", 30.0444, 31.2357, "b1"), [door("reseat", 31.5, 32.5, "b1")]),
    true,
    "in the same building is the same door, whatever its stored point",
  );
  assert.equal(doorCapturedAgain(door("seat", null, null, "b1"), [door("other", 30.0444, 31.2357, "b2")]), false, "no point and another building: nothing to compare");
  assert.equal(DOOR_CAPTURED_AGAIN_METERS, 150, "the line the restore function draws");
  assert.match(again, new RegExp(`\\) <= ${DOOR_CAPTURED_AGAIN_METERS}\\b`), "🔴 the board's radius is the database's radius");

  const loader = stripComments(read("src/lib/phoenix-crm/server/validation-reviews.ts"));
  const marked = loader.slice(loader.indexOf("async function markDoorsCapturedAgain("), loader.indexOf("export async function loadValidationReviews("));
  assert.ok(marked.includes('query.eq("status", "active")'), "the customer's ACTIVE places are what the door is compared with");
  assert.match(marked, /row\.restorable = false;\s+row\.capturedAgain = true;/, "🔴 a captured-again row offers no take-back, and says why");
  assertBefore(loader, "await Promise.all([markDoorsCapturedAgain(rows, reviews, placeById), markEarlierDecisions(rows, reviews, decides)]);", "row.status === \"rejected\" && row.restorable && decided >= rejectedSince", "it is marked before the 90-day undo window is judged, so it drops back to 14 days");
  for (const screen of ["src/components/phoenix-crm/validation-review-queue.tsx", "src/components/phoenix-crm/shared-place-customers.tsx"]) {
    assert.ok(stripComments(placeCheckListSourceAt(screen, read)).includes("DOOR_CAPTURED_AGAIN_TEXT"), `${screen} draws the reason where the button was`);
  }
  assert.match(stripComments(read("src/lib/phoenix-crm/shared-place-groups.ts")), /capturedAgain: row\.capturedAgain === true,/, "a seated customer carries it too");

  // ── "Stay in on his clinic" ────────────────────────────────────────────────────────────────────
  const stands = fnOf(sql, "phoenix_crm_customer_stands_on_another_place");
  assert.ok(stands.includes("o.customer_id = p_customer_id") && stands.includes("o.id <> p_place_id"), "another place of the same customer");
  assert.ok(stands.includes("o.status = 'active'"), "🔴 an active one — a retired place validates nobody");
  assert.match(stands, /and not exists \(\s+select 1 from public\.phoenix_crm_validation_reviews r\s+where r\.place_id = o\.id and r\.status = 'pending'\s+\)/, "🔴 never a place still waiting for a decision");
  assert.ok(stands.includes("o.shared_place_id is null"), "a place of his own");
  assert.match(stands, /sp\.id = o\.shared_place_id and sp\.status = 'active'/, "or a seat in a building that is itself active");
  assert.ok(stands.includes("o.schedule_check ->> 'verdict' = 'match'"), "which its board names");
  assert.match(stands, /r\.place_id = o\.id and r\.status = 'approved'/, "or a person approved");
  assert.ok(
    sql.includes("revoke execute on function public.phoenix_crm_customer_stands_on_another_place(uuid, uuid) from public, anon, authenticated;"),
    "the new function is nobody's to call from a browser",
  );

  const settle = fnOf(sql, "phoenix_crm_settle_venue_timetable");
  const keep = "and public.phoenix_crm_customer_stands_on_another_place(v_row.customer_id, v_row.place_id) then";
  const demote = "elsif v_venue.schedule_photo_path is null or v_verdict in ('other_name', 'no_schedule') then";
  assertBefore(settle, keep, demote, "the settle asks whether he stands elsewhere BEFORE it sends him out of the KPIs");
  const kept = settle.slice(settle.indexOf(keep), settle.indexOf(demote));
  assert.ok(!/update public\.phoenix_crm_customers/.test(kept), "🔴 and writes nothing on a customer it keeps");
  assert.ok(kept.includes("v_kept := v_kept ||"), "he is returned under `kept`, for the record");
  assertBefore(settle, "r.place_id = v_row.place_id and r.status = 'approved'", keep, "a decision of his is still the first thing the settle respects");
  assert.match(settle, /'held', v_held,\s+'kept', v_kept/, "the answer carries both lists");
  assert.match(settle, /validated_by_hr_id = v_actor,\s+reopened_at = null,/, "a customer the board validates carries no old refusal's stamp");

  const seat = fnOf(sql, "phoenix_crm_seat_places_in_venue");
  assert.match(
    seat,
    /if v_venue\.schedule_photo_path is null\s+and not public\.phoenix_crm_customer_stands_on_another_place\(v_place\.customer_id, v_place\.id\) then\s+update public\.phoenix_crm_customers c\s+set status = 'pending'/,
    "the Super Admin's move into a building with no board keeps him in on a place of his own",
  );
  // The move's other rules are untouched: the pharmacy refusal and the second-seating refusal still stand.
  assert.ok(seat.includes("raise exception 'phoenix_crm:pharmacy_cannot_be_seated'") && seat.includes("raise exception 'phoenix_crm:already_in_a_venue'"), "the rest of the move is as it was");

  for (const name of ["phoenix_crm_restore_validation", "phoenix_crm_settle_venue_timetable", "phoenix_crm_seat_places_in_venue"]) {
    assert.ok(sql.includes(`revoke execute on function public.${name}(jsonb) from public, anon, authenticated;`), `${name} stays service_role only`);
    assert.ok(sql.includes(`grant execute on function public.${name}(jsonb) to service_role;`), `${name} is granted back to the service role`);
  }
}
