import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { stripComments } from "./support/comment-strip.ts";

/**
 * Phoenix CRM — a validated clinic's location moves ONLY by the Super Admin or the SFE Manager, with a
 * written reason, and every move is on record.
 *
 * Owner, 2026-09-29: "the location is fixed forever, only the system administrator changes it" — widened
 * by him the same day to the SFE Manager. A rep never moves one and is never offered to (Golden Rule #1:
 * the readings a move is decided on are measurements, and the rep sees none).
 *
 * `place-move.ts` is a server file (it reads the database), so it cannot be imported here; every layer
 * is pinned by source instead, from the database up to the button:
 *
 *   1. the database refuses a move with no reason and records before and after;
 *   2. the service checks WHO before it reads anything, needs the reason, resolves the new location
 *      the way a validation does, and measures the customer's visits again;
 *   3. the access rule says who: the Super Admin (with update rights) and the SFE Manager in scope —
 *      never a test account, and never the SFE Manager in test mode;
 *   4. the screen is reachable only where the list says `canMovePlaces`, and asks for the reason.
 */

const ROOT = new URL("../", import.meta.url);

function read(path: string): string {
  return stripComments(readFileSync(new URL(path, ROOT), "utf8").replace(/\r\n/g, "\n"));
}

/** `export (async )?function name(...) { ... }` — the text from its signature to its closing brace at column 0. */
function functionBody(source: string, name: string): string {
  const match = new RegExp(`export (?:async )?function ${name}\\([\\s\\S]*?\\n\\}`).exec(source);
  assert.ok(match, `${name} is still declared as an exported function — this test resolves it by that name`);
  return match[0];
}

function checkDatabase(): void {
  const migration = readFileSync(new URL("supabase/migrations/20260929235106_phoenix_crm_list_admission.sql", ROOT), "utf8").replace(/\r\n/g, "\n");
  const fn = /create or replace function public\.phoenix_crm_move_place\(p jsonb\)([\s\S]*?)\n\$\$;/.exec(migration);
  assert.ok(fn, "phoenix_crm_move_place is in the list-admission migration");
  assert.match(fn[1], /char_length\(v_reason\) < 10/, "the database refuses a reason under 10 characters");
  assert.match(fn[1], /raise exception 'phoenix_crm:move_reason_required';/, "with its own refusal the screen names");
  assert.match(fn[1], /'place_moved'/, "every move is recorded as a place_moved event");
  assert.match(fn[1], /'before', jsonb_build_object\(/, "holding the point before the move");
  assert.match(fn[1], /'after', jsonb_build_object\(/, "and after it");
  assert.match(fn[1], /point_source = 'moved'/, "the clinic says its point was moved");
  assert.match(fn[1], /move_reason = v_reason/, "and why");
  // The two readings the rep captured stay as they were: a move replaces the FIXED point only.
  assert.doesNotMatch(fn[1], /\b(pin_lat|pin_lon|photo_lat|photo_lon)\s*=/, "a move never overwrites the readings the clinic was validated with");
}

function checkService(): void {
  const service = read("src/lib/phoenix-crm/server/place-move.ts");

  const move = functionBody(service, "movePlace");
  const gate = move.indexOf("assertPlaceMover(viewer, seat, isTest);");
  const firstRead = move.indexOf('.from("phoenix_crm_places")');
  assert.ok(gate > -1, "movePlace asks who is moving");
  assert.ok(firstRead > -1, "movePlace reads the place");
  assert.ok(gate < firstRead, "WHO is checked before anything is read — a rep learns nothing about the clinic from a refused move");
  assert.match(service, /export const PLACE_MOVE_REASON_MIN = 10;/, "a move's reason is at least 10 characters");
  assert.match(move, /if \(!reason \|\| reason\.length < PLACE_MOVE_REASON_MIN\)/, "and a shorter one is refused before the database is asked");
  assert.match(move, /const location = await resolvePlaceLocation\(point, territoryOfSeat\(seat\)\);/, "the new point is resolved into address, brick, area and region the way a validation is");
  assert.match(move, /restampVisitLocationsQuietly\(\{[\s\S]*?scope: "all",[\s\S]*?\}\)/, "every visit to the customer is measured again against the moved clinic");
  // The new point is one of the clinic's own readings, or coordinates held to Egypt's field bounds.
  assert.match(service, /if \(!isUsableFix\(lat, lon\)\) return null;/, "pasted coordinates outside Egypt's field range are refused");

  const retire = functionBody(service, "retirePlace");
  const retireGate = retire.indexOf("assertPlaceMover(viewer, seat, isTest);");
  const retireCall = retire.indexOf("callPhoenixCrm");
  assert.ok(retireGate > -1 && retireCall > -1 && retireGate < retireCall, "removing a clinic is the movers' alone, checked first");

  // A removal is kept exactly as a move is (2026-10-02): a written reason, and the customer's visits
  // measured again. Both live in retirePlace, so the rep's own edit path REFUSES a removal rather than
  // reaching the same RPC with neither — a second implementation is how one of them silently drifts.
  assert.match(retire, /reason\.length < PLACE_MOVE_REASON_MIN/, "a removal needs the same written reason a move does");
  assert.match(retire, /restampVisitLocationsQuietly\(\{[\s\S]*?scope: "all",[\s\S]*?\}\)/, "and re-measures the customer's visits");
  const list = read("src/lib/phoenix-crm/server/list.ts");
  const update = functionBody(list, "updatePlace");
  assert.match(update, /if \(body\.action === "retire"\) \{\s+throw validationError\(/, "the edit route refuses a removal: retirePlace is the one door");
}

function checkAccess(): void {
  const access = read("src/lib/phoenix-crm/server/access.ts");
  const can = functionBody(access, "canMovePlaces");
  const lines = can
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("if") || line.startsWith("return"));
  assert.deepEqual(
    lines,
    [
      "if (viewer.isTestPersona) return false;",
      "if (viewer.isSuperAdmin) return viewer.canUpdate;",
      "if (isTest) return false;",
      "return viewer.isSfeManager && viewer.canApprove && viewer.scopeTerritories.some((entry) => entry.seatId === seat.seatId);",
    ],
    "a place is moved by the Super Admin (with update rights) and the SFE Manager in scope — never a test account, never anyone else",
  );
  const assertMover = functionBody(access, "assertPlaceMover");
  assert.match(assertMover, /if \(!canMovePlaces\(viewer, seat, isTest\)\) \{\s*throw forbiddenError\(/, "the assert is the same rule, refusing");

  // The list tells the screens, from the same rule.
  const list = read("src/lib/phoenix-crm/server/list.ts");
  assert.match(list, /canMovePlaces: canMovePlaces\(viewer, seat, isTest\),/, "the list view carries canMovePlaces from the one rule");

  const route = read("app/api/phoenix-crm/list/places/move/route.ts");
  assert.match(route, /await assertPermission\(access, "phoenix_crm", "approve"\);/, "the move route is an approver's route");
  assert.match(route, /movePlace\(viewer, body\)/, "it moves through the service");
  assert.match(route, /retirePlace\(viewer, body\)/, "and removes through it");
}

function checkScreens(): void {
  const screen = read("src/components/phoenix-crm/place-move-screen.tsx");
  assert.match(screen, /const gone = !view\.canMovePlaces\s*\?/, "the move screen draws for the movers alone");
  assert.match(screen, /const MOVE_REASON_MIN = 10;/, "it holds the database's reason floor");
  assert.match(
    screen,
    /if \(reasonLength < MOVE_REASON_MIN\) return `Write why the clinic is moved/,
    "and asks for the reason before the move is sent",
  );
  assert.match(screen, /"\/api\/phoenix-crm\/list\/places\/move"/, "it moves through the one route");
  assert.match(screen, /reason: reason\.trim\(\),/, "with the reason");
  for (const option of ["Use the photo reading", "Use the pin reading", "Enter coordinates"]) {
    assert.ok(screen.includes(option), `the mover chooses: ${option}`);
  }

  const customer = read("src/components/phoenix-crm/list-customer.tsx");
  const moveButton = customer.indexOf("Move this place");
  assert.ok(moveButton > -1, "the customer's page offers Move this place");
  const gate = customer.lastIndexOf("{view.canMovePlaces ? (", moveButton);
  assert.ok(gate > -1 && moveButton - gate < 400, "Move this place is drawn only under view.canMovePlaces");
  const removeButton = customer.indexOf("Remove this place");
  const removeGate = customer.lastIndexOf("{view.canMovePlaces && customer.places.length > 1 ? (", removeButton);
  assert.ok(removeButton > -1 && removeGate > -1 && removeButton - removeGate < 400, "Remove this place is the movers' too, and a customer keeps his last clinic");
  assert.match(
    customer,
    /"\/api\/phoenix-crm\/list\/places\/move",\s*\{ seatId, test, placeId: place\.placeId, action: "retire", reason: reason\.trim\(\) \}/,
    "removing goes through the movers' route, and carries the written reason (2026-10-02)",
  );
  assert.match(customer, /disabled=\{reasonLength < PLACE_REASON_MIN\}/, "and Remove cannot be pressed without one");

  const tab = read("src/components/phoenix-crm/list-tab.tsx");
  assert.match(tab, /case "move-place": \{[\s\S]*?<PlaceMoveScreen\b/, "the List opens the move screen, which itself refuses anyone but a mover");
}

export function runPhoenixCrmPlaceMoveTests(): void {
  checkDatabase();
  checkService();
  checkAccess();
  checkScreens();
}
