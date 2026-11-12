import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  areLineTwins,
  LINE_TWIN_MAX_PLACES,
  LINE_TWIN_MOVE_REASON,
  lineTwinSummary,
  planLineTwinMerges,
  planLineTwinShares,
  twinNameWords,
  type TwinCustomer,
  type TwinPlace,
} from "../src/lib/phoenix-crm/line-twins.ts";

/**
 * Phoenix CRM — one doctor on the three lines' lists (owner, 2026-11-12: "if it is one place in the three
 * or one customer, then and it is validated, make in the three lines validation"; "You will compare only
 * in the Phoenix validated customers"; "Both").
 *
 * 1. Who is the same doctor: same list (AM/PM), same area, a DIFFERENT line, the same name of three words or
 *    more, no known speciality against it. Two-word names, another area, the same line, a pharmacy and a
 *    clashing speciality are never matched.
 * 2. A waiting row joins: it takes the validated line's places (the best point first, never two within
 *    150 m, at most five) — unless his own validation waits, a drop waits, a clinic doctor still lacks his
 *    three names, two validated doctors of the name sit on one line, two different doctors match, or he is
 *    on his own list twice. A row validated only through copies is never a source.
 * 3. Validated twins share one point: photo and pin places that agree move onto the best one; a point
 *    somebody chose is never moved; points 400 m apart are two clinics and stay; only a direct twin's anchor.
 * 4. By source: the migration's guards, lock, grants and trigger; the RPC is a Customer 360 writer; copies
 *    are kept out of every piece of evidence; every validation path calls the share.
 *
 * Break direction: drop the three-word floor and the two-word case in section 1 fails; drop the
 * `two_doctors` guard and its case in section 2 fails; let a `trusted` place move and section 3 fails;
 * remove a `.neq("point_source", "line_twin")` and section 4 fails.
 */

const ROOT = new URL("../", import.meta.url);

function read(path: string): string {
  return readFileSync(new URL(path, ROOT), "utf8").replace(/\r\n/g, "\n");
}

const CAIRO = { lat: 30.05, lon: 31.23 };
/** About this many metres north of the Cairo point. */
function north(meters: number): { lat: number; lon: number } {
  return { lat: CAIRO.lat + meters / 111_320, lon: CAIRO.lon };
}

let serial = 0;
function customer(overrides: Partial<TwinCustomer>): TwinCustomer {
  serial += 1;
  return {
    id: `c${serial}`,
    seatId: "cns-ca1",
    lineCode: "cns",
    areaCode: "CA1",
    isTest: false,
    listType: "PM",
    name: "احمد صبري مشعل",
    speciality: null,
    status: "pending",
    validatedAt: null,
    validatedByHrId: null,
    pendingReview: false,
    pendingDrop: false,
    fullNameHeld: false,
    ...overrides,
  };
}

function validated(overrides: Partial<TwinCustomer>): TwinCustomer {
  return customer({ status: "active", validatedAt: "2026-11-01T08:00:00Z", validatedByHrId: "R-1", ...overrides });
}

function place(owner: TwinCustomer, overrides: Partial<TwinPlace> & { at?: { lat: number; lon: number } }): TwinPlace {
  serial += 1;
  const at = overrides.at ?? CAIRO;
  return {
    id: `p${serial}`,
    customerId: owner.id,
    seatId: owner.seatId,
    pointSource: "photo",
    lat: at.lat,
    lon: at.lon,
    accuracyMeters: 10,
    capturedAt: "2026-11-01T08:00:00Z",
    ...overrides,
  };
}

// ── 1. Who is the same doctor ────────────────────────────────────────────────────────────────────

function runMatchTests(): void {
  const twin = (left: TwinCustomer, right: TwinCustomer) => areLineTwins(left, right, twinNameWords(left.name), twinNameWords(right.name));
  const cns = customer({});
  const pedia = validated({ seatId: "pedia-ca1", lineCode: "pedia" });
  assert.equal(twin(cns, pedia), true, "one name, one area, one list, two lines: one doctor");
  assert.equal(twin(cns, validated({ seatId: "pedia-ca1", lineCode: "pedia", name: "احمد صبري مشعل حسن" })), true, "a three-word name opening a longer one is the same name");
  assert.equal(twin(cns, validated({ seatId: "pedia-ca2", lineCode: "pedia", areaCode: "CA2" })), false, "another area is somebody else");
  assert.equal(twin(cns, validated({ seatId: "cns-ca1b", lineCode: "cns" })), false, "the same line is never a twin, even on another seat");
  assert.equal(twin(cns, validated({ seatId: "pedia-ca1", lineCode: "pedia", listType: "AM" })), false, "an AM hospital is not a PM clinic");
  assert.equal(twin(customer({ listType: "Pharmacy" }), validated({ seatId: "pedia-ca1", lineCode: "pedia", listType: "Pharmacy" })), false, "a pharmacy is never validated");
  assert.equal(twin(customer({ name: "محمد احمد" }), validated({ seatId: "pedia-ca1", lineCode: "pedia", name: "محمد احمد" })), false, "two words are far too many doctors");
  assert.equal(
    twin(customer({ speciality: "Pediatrics" }), validated({ seatId: "pedia-ca1", lineCode: "pedia", speciality: "Chest" })),
    false,
    "a known speciality against it separates them",
  );
  assert.equal(twin(customer({ speciality: "اطفال" }), validated({ seatId: "pedia-ca1", lineCode: "pedia", speciality: "Pediatrics" })), true, "one speciality written two ways");
  assert.equal(twin(customer({ isTest: true }), pedia), false, "the test world never meets the real one");
}

// ── 2. A waiting row joins ───────────────────────────────────────────────────────────────────────

function runShareTests(): void {
  {
    const waiting = customer({});
    const source = validated({ seatId: "pedia-ca1", lineCode: "pedia", validatedByHrId: "R-7" });
    const own = place(source, {});
    const plan = planLineTwinShares({ customers: [waiting, source], places: [own] });
    assert.equal(plan.shares.length, 1);
    assert.deepEqual(plan.shares[0].sourcePlaceIds, [own.id]);
    assert.deepEqual(plan.shares[0].sourceCustomerIds, [source.id]);
    assert.equal(plan.shares[0].validatedByHrId, "R-7", "the validation is the source's validator's");
  }
  {
    // Three lines: the third joins from the other two, and two points 50 m apart are one door.
    const waiting = customer({});
    const pedia = validated({ seatId: "pedia-ca1", lineCode: "pedia", validatedAt: "2026-11-03T08:00:00Z" });
    const anti = validated({ seatId: "ai-ca1", lineCode: "anti_infective", validatedAt: "2026-11-02T08:00:00Z" });
    const pin = place(pedia, { pointSource: "pin", at: north(50) });
    const photo = place(anti, { pointSource: "photo" });
    const far = place(pedia, { pointSource: "photo", at: north(900) });
    const plan = planLineTwinShares({ customers: [waiting, pedia, anti], places: [pin, photo, far] });
    assert.equal(plan.shares.length, 1);
    assert.deepEqual(plan.shares[0].sourcePlaceIds, [photo.id, far.id], "the photo wins the door; the second clinic 900 m away comes too; the pin 50 m off is the same door");
    assert.deepEqual(plan.shares[0].sourceCustomerIds, [anti.id, pedia.id], "earliest validation first");
  }
  {
    const waiting = customer({});
    const source = validated({ seatId: "pedia-ca1", lineCode: "pedia" });
    const places = Array.from({ length: 7 }, (_, at) => place(source, { at: north(at * 500) }));
    const plan = planLineTwinShares({ customers: [waiting, source], places });
    assert.equal(plan.shares[0].sourcePlaceIds.length, LINE_TWIN_MAX_PLACES, "never past five places");
  }
  {
    // A row validated only through copies is never a source: a copy never breeds a copy.
    const waiting = customer({});
    const copied = validated({ seatId: "pedia-ca1", lineCode: "pedia" });
    const plan = planLineTwinShares({ customers: [waiting, copied], places: [place(copied, { pointSource: "line_twin" })] });
    assert.equal(plan.shares.length, 0);
  }
  const skipOf = (waiting: TwinCustomer, extra: TwinCustomer[] = [], extraPlaces: TwinPlace[] = []) => {
    const source = validated({ seatId: "pedia-ca1", lineCode: "pedia", name: waiting.name });
    const plan = planLineTwinShares({ customers: [waiting, source, ...extra], places: [place(source, {}), ...extraPlaces] });
    assert.equal(plan.shares.filter((share) => share.customerId === waiting.id).length, 0, "skipped, never shared");
    return plan.skipped.find((skip) => skip.customerId === waiting.id)?.reason ?? null;
  };
  assert.equal(skipOf(customer({ pendingReview: true })), "in_review", "his own validation waits for the Super Admin");
  assert.equal(skipOf(customer({ pendingDrop: true })), "drop_requested");
  assert.equal(skipOf(customer({ fullNameHeld: true })), "full_name_held");
  assert.equal(skipOf(customer({ name: "مصطفي مصطفي شلش" })), "needs_full_name", "a doubled name is asked for again, never validated");
  {
    const second = validated({ seatId: "pedia-ca1b", lineCode: "pedia", name: "احمد صبري مشعل" });
    assert.equal(skipOf(customer({}), [second], [place(second, { at: north(3000) })]), "two_on_one_line");
  }
  {
    const waiting = customer({});
    const one = validated({ seatId: "pedia-ca1", lineCode: "pedia", name: "احمد صبري مشعل حسن" });
    const two = validated({ seatId: "ai-ca1", lineCode: "anti_infective", name: "احمد صبري مشعل علي" });
    const plan = planLineTwinShares({ customers: [waiting, one, two], places: [place(one, {}), place(two, {})] });
    assert.equal(plan.shares.length, 0);
    assert.equal(plan.skipped[0]?.reason, "two_doctors", "a short name opening two different men is left alone");
  }
  {
    const first = customer({});
    const again = customer({ name: "احمد صبري مشعل" });
    const source = validated({ seatId: "pedia-ca1", lineCode: "pedia" });
    const plan = planLineTwinShares({ customers: [first, again, source], places: [place(source, {})] });
    assert.equal(plan.shares.length, 0);
    assert.deepEqual(plan.skipped.map((skip) => skip.reason), ["twice_on_this_list", "twice_on_this_list"]);
  }
  {
    // Already holding a place, or already validated: nothing to do and nothing to report.
    const holding = customer({});
    const source = validated({ seatId: "pedia-ca1", lineCode: "pedia" });
    const plan = planLineTwinShares({ customers: [holding, source], places: [place(source, {}), place(holding, { pointSource: "line_twin" })] });
    assert.deepEqual(plan, { shares: [], skipped: [] });
  }
}

// ── 3. Validated twins share one point ───────────────────────────────────────────────────────────

function runMergeTests(): void {
  {
    const cns = validated({});
    const pedia = validated({ seatId: "pedia-ca1", lineCode: "pedia" });
    const early = place(cns, { capturedAt: "2026-10-01T08:00:00Z" });
    const late = place(pedia, { at: north(60), capturedAt: "2026-11-01T08:00:00Z" });
    const moves = planLineTwinMerges({ customers: [cns, pedia], places: [early, late] });
    assert.equal(moves.length, 1);
    assert.equal(moves[0].placeId, late.id, "the later reading moves onto the earlier one");
    assert.equal(moves[0].anchorPlaceId, early.id);
    assert.ok(moves[0].distanceMeters >= 55 && moves[0].distanceMeters <= 65);
  }
  {
    const cns = validated({});
    const pedia = validated({ seatId: "pedia-ca1", lineCode: "pedia" });
    assert.deepEqual(planLineTwinMerges({ customers: [cns, pedia], places: [place(cns, {}), place(pedia, { at: north(400) })] }), [], "400 m apart is two clinics");
  }
  {
    // A point somebody chose wins, and is never itself moved.
    const cns = validated({});
    const pedia = validated({ seatId: "pedia-ca1", lineCode: "pedia" });
    const anti = validated({ seatId: "ai-ca1", lineCode: "anti_infective" });
    const chosen = place(cns, { pointSource: "moved", at: north(40) });
    const trusted = place(pedia, { pointSource: "trusted", at: north(80) });
    const photo = place(anti, { pointSource: "photo", accuracyMeters: 3 });
    const moves = planLineTwinMerges({ customers: [cns, pedia, anti], places: [chosen, trusted, photo] });
    assert.deepEqual(moves.map((move) => [move.placeId, move.anchorPlaceId]), [[photo.id, chosen.id]], "only the photo moves, onto the moved point");
  }
  {
    // A pin beside a photo: the photo is the door.
    const cns = validated({});
    const pedia = validated({ seatId: "pedia-ca1", lineCode: "pedia" });
    const pin = place(cns, { pointSource: "pin", accuracyMeters: 2, capturedAt: "2026-09-01T08:00:00Z" });
    const photo = place(pedia, { pointSource: "photo", at: north(30), accuracyMeters: 25 });
    const moves = planLineTwinMerges({ customers: [cns, pedia], places: [pin, photo] });
    assert.deepEqual(moves.map((move) => move.placeId), [pin.id]);
  }
  {
    // Same line, or a waiting row: never merged.
    const cns = validated({});
    const cnsOther = validated({ seatId: "cns-ca1b" });
    const waiting = customer({ seatId: "pedia-ca1", lineCode: "pedia" });
    const moves = planLineTwinMerges({ customers: [cns, cnsOther, waiting], places: [place(cns, {}), place(cnsOther, { at: north(50) }), place(waiting, { at: north(20) })] });
    assert.deepEqual(moves, []);
  }
  {
    const summary = lineTwinSummary([], { shares: [], skipped: [{ customerId: "x", seatId: "s", name: "n", reason: "in_review" }] });
    assert.equal(summary.skipped_in_review, 1);
  }
  assert.ok(LINE_TWIN_MOVE_REASON.length >= 10 && LINE_TWIN_MOVE_REASON.length <= 500, "the move reason fits the database's 10-500");
}

// ── 4. By source ─────────────────────────────────────────────────────────────────────────────────

function runSourceTests(): void {
  const sql = read("supabase/migrations/20261112221819_phoenix_crm_line_twin_validation.sql").replace(/--.*$/gm, "");
  assert.match(sql, /check \(point_source in \('photo', 'pin', 'moved', 'shared_place', 'trusted', 'line_twin'\)\)/);
  assert.match(sql, /perform pg_advisory_xact_lock\(hashtext\('phoenix_crm:seat:' \|\| v_seat\)\);/, "under the target seat's lock");
  assert.match(sql, /'kind', 'line_twin'/, "every copy carries where it came from");
  assert.match(sql, /photo_path[^;]*null/, "a copy never takes a photo slot");
  for (const skip of ["not_waiting", "has_place", "in_review", "drop_requested", "full_name_held", "source_gone"]) {
    assert.ok(sql.includes(`'skipped', '${skip}'`), `the RPC steps aside on ${skip}`);
  }
  assert.match(sql, /revoke execute on function public\.phoenix_crm_share_line_validation\(jsonb\) from public, anon, authenticated;/);
  assert.match(sql, /grant execute on function public\.phoenix_crm_share_line_validation\(jsonb\) to service_role;/);
  assert.match(sql, /create or replace trigger phoenix_crm_places_line_twin_follow/, "a copy follows its source");
  assert.match(read("src/lib/phoenix-crm/server/db.ts"), /"phoenix_crm_share_line_validation"/, "the RPC is a known Customer 360 writer");

  // A copy is never evidence.
  assert.match(read("src/lib/phoenix-crm/server/validation-reviews.ts"), /\.neq\("point_source", "line_twin"\)/, "Place checks never lists a copy");
  assert.equal((read("src/lib/phoenix-crm/server/place-match-groups.ts").match(/\.neq\("point_source", "line_twin"\)/g) ?? []).length >= 1, true, "Same place, several reps never reads a copy");
  assert.match(read("src/lib/phoenix-crm/server/customer-match-groups.ts"), /\.neq\("point_source", "line_twin"\)/, "Same customer, several reps never reads a copy");

  assert.match(read("src/lib/phoenix-crm/server/places-to-recheck.ts"), /\.neq\("point_source", "line_twin"\)/, "Places to recheck never offers a copy to move");

  // The silent integrity filers never judge a copy: it has no capture of its own and repeats its source's point.
  assert.equal(
    (read("src/lib/phoenix-crm/server/silent-detectors.ts").match(/\.neq\("point_source", "line_twin"\)/g) ?? []).length,
    2,
    "the coverage pass and the visit-against-photograph pass both skip a copy",
  );
  assert.match(read("src/lib/phoenix-crm/server/location-integrity.ts"), /\.neq\("point_source", "line_twin"\)/, "a copy is never a replayed point");

  // A copy follows its source: a move, a removal, a rejection and a refusal carry it.
  const placeMove = read("src/lib/phoenix-crm/server/place-move.ts");
  assert.match(placeMove, /followLineTwinCopiesQuietly\(\[moved\.placeId\], viewer\.config\.settings\)/, "a moved place's copies are measured again");
  assert.match(placeMove, /followLineTwinCopiesQuietly\(\[retired\.placeId\], viewer\.config\.settings, \{ retired: true \}\)/, "a removed place's copies go with it");
  assert.equal(
    (read("src/lib/phoenix-crm/server/validation-reviews.ts").match(/followLineTwinCopiesQuietly\(\[[a-zA-Z]+\], viewer\.config\.settings, \{ retired: true \}\)/g) ?? []).length,
    2,
    "a rejection and a refusal carry the copies",
  );

  // Every way a doctor becomes validated shares it.
  for (const path of [
    "src/lib/phoenix-crm/server/list.ts",
    "src/lib/phoenix-crm/server/validation-reviews.ts",
    "src/lib/phoenix-crm/server/signboard-holds.ts",
    "src/lib/phoenix-crm/server/trusted-point.ts",
    "src/lib/phoenix-crm/server/shared-places.ts",
  ]) {
    assert.match(read(path), /shareAcrossLinesQuietly\(/, `${path} shares a new validation across the lines`);
  }
  assert.match(read("src/lib/phoenix-crm/server/line-twins.ts"), /SIGNBOARD_SYSTEM_ACTOR/, "the system is the actor, never a person");
}

export function runPhoenixCrmLineTwinsTests(): void {
  runMatchTests();
  runShareTests();
  runMergeTests();
  runSourceTests();
}
