import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * Phoenix CRM — a place's location is captured, separated, and never editable.
 *
 * Owner, 2026-09-23: "the capture location is never editable and its separated when captured to brick
 * area region clean addresss and raw location".
 *
 * This one is silent when it breaks. Put an address box back on the capture screen and every screen
 * still works, every test still passes, and the only thing that changes is that the proof of WHERE a
 * customer is becomes something a rep typed — which is the whole thing a validation exists to rule
 * out. So each half is pinned at the layer that enforces it:
 *
 *   1. the phone cannot SAY where it is — no address, zone or brick on the wire, and no box to type
 *      one into;
 *   2. the server RESOLVES all five parts from the captured coordinates;
 *   3. the database's edit path cannot WRITE any of them, whatever a caller sends.
 */

function source(path: string): string {
  return readFileSync(path, "utf8");
}

/** The `set` list of the `edit` branch, which is the whole guarantee on the database side. */
function editSetClause(migration: string): string {
  const editBranch = /if v_action = 'edit' then([\s\S]*?)returning pl\.\* into v_after;/.exec(migration);
  assert.ok(editBranch, "the update function still has an edit branch");
  const setClause = /update public\.phoenix_crm_places pl\s*set([\s\S]*?)where pl\.id = v_place\.id/.exec(editBranch[1]);
  assert.ok(setClause, "the edit branch still updates the place");
  return setClause[1];
}

function runWireTests() {
  const entryRules = source("src/lib/phoenix-crm/entry-rules.ts");

  // 1. The wire type. A field that is not on PlaceDraft cannot reach the database, whatever a phone
  //    posts, because the route hands the parsed value on and nothing else reads the body.
  const draft = /export type PlaceDraft = CapturedFix & \{([\s\S]*?)\};/.exec(entryRules);
  assert.ok(draft, "the place draft names what a phone may send");
  for (const banned of ["address", "zone", "brick"]) {
    assert.doesNotMatch(
      draft[1],
      new RegExp(`\\b${banned}\\b`),
      `a phone cannot send a place's ${banned}: the location is resolved from the captured coordinates on the server`,
    );
  }
  assert.match(draft[1], /\blabel\b/, "the place's NAME is still the rep's to write");

  // And the parser must not quietly keep reading them into some other field.
  const parser = /export function parsePlaceDraft\(raw: unknown\)[\s\S]*?\n\}/.exec(entryRules);
  assert.ok(parser, "the place draft is parsed in one place");
  for (const banned of [/body\.address/, /body\.zone/, /body\.brick/]) {
    assert.doesNotMatch(parser[0], banned, "the parser reads no location off the body");
  }

  // The same guarantee, one layer further: a customer SEATED in a polyclinic (owner, 2026-10-09) sends
  // no point for his row — his point is the venue's, taken once at its door. So his draft is the
  // strictest case of this rule, and a fix smuggled back onto it would be the defect. Its one reading,
  // `standingAt` (owner, 3 Nov 2026), asks only whether he is in the building and is never stored:
  // tests/phoenix-crm-seat-at-building.test.ts.
  const sharedRules = source("src/lib/phoenix-crm/shared-place-rules.ts");
  const seated = /export type SeatedPlaceDraft = \{([\s\S]*?)\};/.exec(sharedRules);
  assert.ok(seated, "the seated draft names what a phone may send when it seats a customer");
  for (const banned of ["address", "zone", "brick", "lat", "lon", "accuracyMeters"]) {
    assert.doesNotMatch(
      seated[1],
      new RegExp(`\\b${banned}\\b`),
      `a seating cannot send ${banned}: the point, the brick, the area and the region are the venue's own`,
    );
  }
  const seatedParser = /export function parseSeatedPlaceDraft\(raw: unknown\)[\s\S]*?\n\}/.exec(sharedRules);
  assert.ok(seatedParser, "and it is parsed in one place");
  for (const banned of [/body\.lat/, /body\.lon/, /body\.address/, /body\.accuracyMeters/]) {
    assert.doesNotMatch(seatedParser[0], banned, "the seating parser reads no location off the body either");
  }
}

function runScreenTests() {
  const editor = source("src/components/phoenix-crm/place-editor.tsx");

  // 2. No box to type a location into. The editor holds exactly one <input>, and it is the name.
  const inputs = editor.match(/<input\b/g) ?? [];
  assert.equal(inputs.length, 1, "the place editor has one input — the place's name; the location is shown, never typed");
  assert.match(editor, /id=\{`\$\{idPrefix\}-label`\}/, "the one input is the place name");
  for (const gone of [/-address`\}/, /-zone`\}/]) {
    assert.doesNotMatch(editor, gone, "the address and the part of town are no longer fields");
  }
  assert.doesNotMatch(editor, /Correct it if it is wrong/, "nothing invites a rep to correct the captured address");
  // The rep reads WHERE, never how well (owner, 2026-09-29, Golden Rule #1): the location block he
  // sees on the capture and on an edit carries no coordinates and no accuracy. The raw readings are
  // the Super Admin's and the SFE Manager's, on the place-move screen.
  const block = /function CapturedLocationBlock\([\s\S]*?\n\}/.exec(editor);
  assert.ok(block, "the location block is one function");
  assert.doesNotMatch(block[0], /Coordinates|\.lat\b|\.lon\b/, "the rep's location block shows no coordinates");
  assert.doesNotMatch(block[0], /accuracy|within \$\{/i, "the rep's location block shows no accuracy");

  // The draft the screen holds carries no location either, so there is nothing to send even by hand.
  const draftState = /export type PlaceDraftState = \{([\s\S]*?)\};/.exec(editor);
  assert.ok(draftState, "the screen's draft names what it holds");
  for (const banned of ["address", "zone"]) {
    assert.doesNotMatch(draftState[1], new RegExp(`\\b${banned}:`), `the draft holds no ${banned}`);
  }

  const payload = /export function placePayload\([\s\S]*?\n\}/.exec(editor);
  assert.ok(payload, "the screen builds the save payload in one place");
  for (const banned of [/address:/, /zone:/, /brick:/]) {
    assert.doesNotMatch(payload[0], banned, "the payload carries the photo, the fix, the name and the timings — no location");
  }

  // 3. The visit camera carries no sentence about the location check (owner, 2026-09-23). The check
  //    itself is unchanged; only the text under the camera is gone.
  const visits = source("src/components/phoenix-crm/visits-tab.tsx");
  assert.doesNotMatch(
    visits,
    /hint=\{`Your location is checked against/,
    "the visit camera shows no hint about the location being compared with the validated place",
  );
}

function runServerTests() {
  const list = source("src/lib/phoenix-crm/server/list.ts");

  // 4. The server resolves the whole location itself, from the coordinates it was given.
  //
  //    Since 2026-09-29 the place is captured with TWO readings (the Capture-location pin and the
  //    photo's own shutter reading) and the location is resolved from the FIXED point — the photo's
  //    reading, else the pin (`placePoint`). The resolving moved into `resolvePlaceLocation`, which a
  //    validation and a move (place-move.ts) both call, so the two can never disagree about a brick.
  //    The protection is unchanged: every part comes from coordinates, none from the phone's words.
  const payload = /async function placePayload\(place: PlaceDraft, seat: OrgSeat\): Promise<Row> \{([\s\S]*?)\n\}/.exec(list);
  assert.ok(payload, "the server builds the place row in one place");
  assert.match(payload[1], /const point = placePoint\(place\);/, "the fixed point is the photo's reading, else the pin — chosen by the one pure rule");
  assert.match(
    payload[1],
    /resolvePlaceLocation\(point, territoryOfSeat\(seat\)\)/,
    "the whole location is resolved from that fixed point, in the capturing seat's own territory",
  );
  assert.match(payload[1], /\.\.\.located,/, "and every resolved part is written into the row");
  // Both raw readings are kept beside the fixed point, each as it was measured.
  for (const column of ["pin_lat: place.lat", "pin_lon: place.lon", "photo_lat: place.photoLat", "photo_lon: place.photoLon"]) {
    assert.ok(payload[1].includes(column), `the capture keeps its raw reading ${column.split(":")[0]}`);
  }

  // 🔴 THE RESOLVER MOVED OUT OF `list.ts` ON 2026-10-09 and is read from its own module now:
  // `server/shared-places.ts` has to call it, and `list.ts` imports that file, so leaving it where it
  // was would have closed an import cycle. It is still the ONE resolver — a validation, a move and a
  // venue all call this function — which is the whole point of this assertion.
  // `Promise<Record<string, unknown>>` holds a `>` of its own, so the return type is matched as "the
  // rest of the line", never as `<[^>]*>`.
  const placeLocation = source("src/lib/phoenix-crm/server/place-location.ts");
  const resolver = /export async function resolvePlaceLocation\([\s\S]*?\n\): Promise<Record<string, unknown>> \{([\s\S]*?)\n\}/.exec(placeLocation);
  assert.ok(resolver, "the location is resolved in one place");
  assert.match(
    resolver[1],
    /resolvePinGeography\(point, territory\)/,
    "the place row's location comes from the one geography resolver, read with the fixed point and its territory",
  );
  for (const column of ["area_code", "area_name", "region_code", "region_name", "brick_distance_km"]) {
    assert.match(resolver[1], new RegExp(`${column}:`), `the capture writes ${column}, so the location is separated into its parts`);
  }

  // 4b. And the resolver it reads answers from the coordinates alone.
  //
  //     `resolvePinGeography` was extracted from `resolvePlaceLocation` on 2026-10-09, when a rep was
  //     given a pin on a pharmacy too (owner: "cleaned and separated into area, brick, government").
  //     The protection is unchanged and now shared: EVERY mapping reads this one function, which is
  //     asserted below to be the only caller of the address service in its module, and `list.ts` is
  //     asserted to have stopped calling it at all — two callers would be two answers about which
  //     brick a point is in, which is the defect the extraction prevents.
  const geography = /export async function resolvePinGeography\([\s\S]*?\n\): Promise<PinGeography> \{([\s\S]*?)\n\}/.exec(placeLocation);
  assert.ok(geography, "the geography behind a captured point is resolved in one place");
  // Assert the two ARGUMENTS, not one verbatim call expression: the first version of this test
  // pinned the literal text `{ lat: place.lat, lon: place.lon }` and went green on a call that
  // could not compile, because resolveEvidenceLocation takes latitude/longitude. A test that
  // passes on code typecheck rejects is worse than no test — it says the layer is guarded.
  assert.match(geography[1], /resolveEvidenceLocation\(\s*\{[^}]*\blatitude: point\.lat\b/, "the clean address is resolved from the fixed point's latitude");
  assert.match(geography[1], /resolveEvidenceLocation\(\s*\{[^}]*\blongitude: point\.lon\b/, "the clean address is resolved from the fixed point's longitude");
  assert.match(geography[1], /fileBrickForPoint\(point\.lat, point\.lon, centroids,/, "the brick is resolved from the fixed point");
  // 🔴 AND THE CAPTURING SEAT'S TERRITORY GOES WITH IT. Without this argument the nearest centroid
  // wins outright, and 34 live centroids sit on coordinates two AREAS share — so a capture's area
  // would be decided by array order. It filed a Faisal hospital in Imbaba on 2026-10-10.
  // And past the trust radius only that own area reaches, up to OWN_AREA_REACH_KM (owner, 2026-10-29:
  // "Rep's own area"); the rule itself is pinned by behaviour in runPhoenixCrmCaptureBrickTerritoryTests.
  const filing = geography[1].match(/fileBrickForPoint\(point\.lat, point\.lon, centroids, \{([^}]*)\}\)/);
  assert.ok(filing, "the brick is filed by the one shared filing rule");
  assert.match(filing[1], /\bareaCodes: territory\.areaCodes\b/, "and the seat's own area breaks a near tie");
  assert.match(filing[1], /\btrustKm: BRICK_TRUST_KM\b/, "inside the same trust radius the match is judged by");
  assert.match(filing[1], /\breachKm: OWN_AREA_REACH_KM\b/, "and only the own area reaches past it");
  assert.equal(
    placeLocation.split("resolveEvidenceLocation(").length - 1,
    1,
    "the address service is called once in the resolver's own module — every mapping goes through resolvePinGeography",
  );
  assert.equal(list.split("resolveEvidenceLocation(").length - 1, 0, "and list.ts calls it nowhere any more, so no mapping can bypass the resolver");
  // Nothing on any path may read a location off the draft again.
  for (const body of [payload[1], resolver[1], geography[1]]) {
    for (const banned of [/place\.address/, /place\.zone/, /place\.brick\b/]) {
      assert.doesNotMatch(body, banned, "the row takes no location from what the phone sent");
    }
  }

  // 5. And the edit path sends none of it, so an older phone's body reaches nothing.
  const update = /export async function updatePlace\([\s\S]*?\n\}/.exec(list);
  assert.ok(update, "the edit path is one function");
  for (const banned of [/address:/, /zone:/, /brick_id:/, /brick_name:/]) {
    assert.doesNotMatch(update[0], banned, "an edit changes the place's name and hours, never where it is");
  }
}

function runDatabaseTests() {
  const migration = source("supabase/migrations/20260923020000_phoenix_crm_place_location_is_frozen.sql");
  const setClause = editSetClause(migration);

  // 6. The last line of defence: even a caller that sends an address has nowhere for it to land.
  for (const banned of ["address", "zone", "brick_id", "brick_name", "brick_distance_km", "area_code", "area_name", "region_code", "region_name", "lat", "lon"]) {
    assert.doesNotMatch(
      setClause,
      new RegExp(`\\b${banned}\\s*=`),
      `phoenix_crm_update_place must never write ${banned}: the location belongs to the capture`,
    );
  }
  for (const allowed of ["timings", "label", "updated_at"]) {
    assert.match(setClause, new RegExp(`\\b${allowed}\\s*=`), `an edit still saves ${allowed}`);
  }

  // The capture, by contrast, writes every part.
  const insert = /create or replace function public\.phoenix_crm_insert_place\(([\s\S]*?)\n\$\$;/.exec(migration);
  assert.ok(insert, "the capture function is in this migration");
  for (const column of ["brick_distance_km", "area_code", "area_name", "region_code", "region_name"]) {
    assert.match(insert[1], new RegExp(`\\b${column}\\b`), `the capture stores ${column}`);
  }

  // Every security-definer function restated here re-locks its grants. `revoke ... from anon,
  // authenticated` without `public` is a silent no-op: both roles inherit EXECUTE through PUBLIC.
  for (const fn of ["phoenix_crm_insert_place", "phoenix_crm_update_place"]) {
    const revoke = new RegExp(`revoke execute on function public\\.${fn}\\([^)]*\\) from public, anon, authenticated;`);
    const grant = new RegExp(`grant execute on function public\\.${fn}\\([^)]*\\) to service_role;`);
    assert.match(migration, revoke, `${fn} is revoked from PUBLIC, not just anon and authenticated`);
    assert.match(migration, grant, `${fn} is granted back to service_role, which revoking PUBLIC strips`);
  }
}

export function runPhoenixCrmPlaceLocationFrozenTests() {
  runWireTests();
  runScreenTests();
  runServerTests();
  runDatabaseTests();
}
