import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { stripComments } from "./support/comment-strip.ts";

/**
 * Moving a standalone customer INTO a validated polyclinic (owner, 2026-10-10): the Super Admin ticks
 * several of a rep's customers, picks the building, writes one reason, and each takes the building's
 * location exactly. A customer is counted on his visits and held out of the KPIs until the building's
 * timetable names him.
 *
 * Source-text assertions in the module's own style. Each one is a thing that would break silently.
 */

const ROOT = new URL("../", import.meta.url);

function read(path: string): string {
  return stripComments(readFileSync(new URL(path, ROOT), "utf8").replace(/\r\n/g, "\n"));
}

function fnOf(sql: string, name: string): string {
  const start = sql.indexOf(`create or replace function public.${name}(p jsonb)`);
  assert.ok(start > -1, `${name} is declared in the seat-in-venue migration`);
  const end = sql.indexOf("\n$$;", start);
  assert.ok(end > start, `${name} ends with its dollar quote`);
  return sql.slice(start, end);
}

export function runPhoenixCrmSeatInVenueTests() {
  const sql = readFileSync(new URL("supabase/migrations/20261010210000_phoenix_crm_seat_places_in_venue.sql", ROOT), "utf8").replace(/\r\n/g, "\n");
  const seat = fnOf(sql, "phoenix_crm_seat_places_in_venue");
  const settle = fnOf(sql, "phoenix_crm_settle_venue_timetable");

  // 1. ONE statement sets shared_place_id and photo_path, and clears all three moved_* fields.
  const update = /update public\.phoenix_crm_places pl\s+set([\s\S]*?)where pl\.id = v_place\.id/.exec(seat);
  assert.ok(update, "the seating is one update of the place");
  assert.match(update[1], /shared_place_id = v_venue\.id/, "the same statement sets shared_place_id");
  assert.match(update[1], /photo_path = v_photo/, "and photo_path, because the partial photo index only frees the row at that instant");
  assert.match(update[1], /moved_at = null,\s+moved_by_hr_id = null,\s+move_reason = null/, "and clears all three moved_* fields, which phoenix_crm_places_moved requires");
  assert.match(update[1], /point_source = 'shared_place'/, "the point now says it is the building's");

  // 1b. A seated row must carry its customer's AM or PM session (live check phoenix_crm_places_seated_has_session,
  // found on staging), and a pharmacy has neither, so it is refused rather than left to a bare 23514.
  assert.match(update[1], /session = v_customer.list_type,/, "the same statement gives the seated place its customer's session");
  assert.match(seat, /if v_customer\.list_type not in \('AM', 'PM'\) then\s+raise exception 'phoenix_crm:pharmacy_cannot_be_seated';/, "a pharmacy is refused by name");
  assert.match(read("src/lib/phoenix-crm/server/db.ts"), /pharmacy_cannot_be_seated: { status: 409/, "and the refusal has its sentence");
  assert.match(read("src/components/phoenix-crm/seat-in-venue-screen.tsx"), /customer.listType !== "Pharmacy"/, "and the tick list never offers a pharmacy");

  // 2. photo_path falls back to the place's own photo, never to null.
  assert.match(seat, /v_photo := coalesce\(v_venue\.schedule_photo_path, v_place\.photo_path\);/, "his own door photo is kept until a board exists");

  // 3. The place takes the venue's point exactly; the audit keeps the overwritten photo.
  assert.match(update[1], /lat = v_venue\.lat,\s+lon = v_venue\.lon/, "the point is the building's, copied");
  assert.match(seat, /'photo_path', v_place\.photo_path/, "the overwritten door photo is recoverable from the place_seated event");
  assert.match(seat, /'place_seated'/, "every seating is an audited event");

  // 4. A place already in a venue is never re-seated.
  assert.match(seat, /raise exception 'phoenix_crm:already_in_a_venue'/, "the database refuses a second seating");

  // 5. A venue with no timetable demotes the customer through validated_at, the existing KPI lever.
  assert.match(seat, /if v_venue\.schedule_photo_path is null then[\s\S]*?validated_at = null[\s\S]*?c\.status = 'active'/, "no board: the customer goes back to pending, guarded on active");

  // 6. The settle re-validates only where pending, never past a waiting review, and unjudged never holds.
  assert.match(settle, /v_verdict = 'match' and v_row\.customer_status = 'pending'/, "the settle validates a pending customer on a match only");
  assert.match(settle, /r\.place_id = v_row\.place_id and r\.status = 'pending'/, "never past a review the Super Admin has not decided");
  assert.match(settle, /v_verdict in \('other_name', 'no_schedule'\)/, "only a confident negative holds");
  assert.doesNotMatch(settle, /'unjudged'/, "unjudged is never a hold and never a pass");

  // 7. Service and route: Super Admin only.
  const service = read("src/lib/phoenix-crm/server/place-move.ts");
  const seatFn = /export async function seatPlacesInVenue[\s\S]*?\n\}/.exec(service);
  assert.ok(seatFn, "seatPlacesInVenue is declared");
  assert.match(seatFn[0], /if \(!canDecideSharedPlaces\(viewer\)\) throw forbiddenError/, "the Super Admin alone, through the shared-place decider");
  assert.doesNotMatch(seatFn[0], /assertPlaceMover/, "never the movers' set, which admits the SFE Manager");
  const route = read("app/api/phoenix-crm/list/places/seat/route.ts");
  assert.match(route, /assertPermission\(access, "phoenix_crm", "update"\)/, "the route asks for update");
  assert.doesNotMatch(route, /"approve"/, "not approve, which the SFE Manager holds");

  // 8. The timetable is read from the building's board, which another rep uploaded.
  const venue = read("src/lib/phoenix-crm/server/venue-timetable.ts");
  assert.match(venue, /reusedTimetable: true/, "without it the download door answers null and the verdict is lost");

  // 9. The screen switch has a case, because the default renders the list.
  const tab = read("src/components/phoenix-crm/list-tab.tsx");
  assert.ok(tab.includes('case "seat-in-venue":'), "list-tab draws the seat screen");
  assert.ok(tab.includes('case "venue-timetable":'), "and the timetable screen");
  const screen = read("src/components/phoenix-crm/seat-in-venue-screen.tsx");
  assert.ok(screen.includes("!view.canSeatInVenue"), "the screen refuses to draw for anyone else");
  assert.match(read("src/lib/phoenix-crm/server/list.ts"), /canSeatInVenue: canDecideSharedPlaces\(viewer\),/, "the list view carries the flag from the one rule");

  // 10. A seated pending customer is never offered Validate.
  assert.match(read("src/components/phoenix-crm/list-customer.tsx"), /const offerValidate = canValidateThis && !seatedPending;/, "a customer waiting for the building's timetable is not offered his own door");
}
