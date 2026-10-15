import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";

import {
  countSharedPlaceDays,
  parseSeatedPlaceDraft,
  parseSharedPlaceDraft,
  parseSharedPlaceKind,
  SEATED_PLACE_NO_PHOTO,
  SEATED_PLACE_NO_SESSION,
  SEATED_PLACE_NO_VENUE,
  SHARED_PLACE_DAILY_CAP_DEFAULT,
  SHARED_PLACE_DAY_FULL_CODE,
  SHARED_PLACE_KIND_KEYS,
  SHARED_PLACE_NO_KIND,
  SHARED_PLACE_NO_NAME,
  SHARED_PLACE_NO_PHOTO,
  sharedPlanCapRefusal,
  type SharedPlaceNamed,
} from "../src/lib/phoenix-crm/shared-place-rules.ts";
import { PLACE_MAX_ACCURACY_METERS } from "../src/lib/phoenix-crm/entry-rules.ts";
import { fieldWeekStart } from "../src/lib/phoenix-crm/calendar.ts";
import { EMPTY_DOCTOR_FILTER, filterPlannerCustomers, plannerVenues } from "../src/lib/phoenix-crm/plan-filters.ts";
import { resolvePlanItems, type PlanRuleCustomer } from "../src/lib/phoenix-crm/plan-rules.ts";
import { effectiveListType, type PlannerCustomer } from "../src/lib/phoenix-crm/suggestions.ts";
import { PHOENIX_CRM_DEFAULT_SETTINGS } from "../src/lib/phoenix-crm/types.ts";
import {
  reasonsFor,
  SHARED_PLACE_REFUSED_ACTION,
  SHARED_PLACE_REFUSED_LEAD,
  sharedPlaceRefusalRepText,
  VALIDATION_REFUSAL_REASONS,
} from "../src/lib/phoenix-crm/validation-feedback.ts";
import {
  matchesSharedPlaceFilters,
  sharedPlacePassesOutcome,
  EMPTY_VALIDATION_REVIEW_FILTERS,
} from "../src/lib/phoenix-crm/validation-review-filters.ts";
import { stripComments, stripSqlComments } from "./support/comment-strip.ts";

/**
 * Phoenix CRM — a polyclinic validated ONCE, with its doctors seated inside it (owner, 2026-10-09 in
 * chat, Arabic): validate the polyclinic once, then register each doctor's times in it, at most three
 * a day; he uploads the timetable photo; the location is taken once, so there is no location when
 * seating; and the administrator reviews the schedule afterwards.
 *
 * 🔴 AND ONE TIMETABLE FOR THE WHOLE BUILDING, NOT ONE PER DOCTOR (his one amendment, 2026-10-10:
 * "ask him for only one timetable, not for every doctor"). The last block of this suite pins all four
 * halves of it: the parse that now ALLOWS a missing photo, the server that resolves it from the
 * VENUE's stored path, the single-use photo slot that no longer makes a seating idempotent and the
 * database refusal that replaced it, and the screen that stamps the BUILDING's name into the image.
 *
 * What it replaced: a signboard that names the BUILDING can never name the fifth doctor receiving
 * behind it, so each of them stayed unvalidated — and an unvalidated customer's visits save and score
 * nothing.
 *
 * Asked directly about dropping the Google check with it, he answered: "even if no uh, Google check,
 * he must validate by a live photo and location." So the venue's own gate is the live photo plus both
 * readings inside the place line, and this test pins exactly that.
 */

const MIGRATION = "supabase/migrations/20261010013001_phoenix_crm_shared_places.sql";
/** The kind list was narrowed an hour after it shipped — he took the medical tower off the chooser. */
const NARROWED = "supabase/migrations/20261010013002_phoenix_crm_shared_place_drop_medical_tower.sql";

/** A clean reading at the door: the pin and the shutter both well inside the place line. */
function atTheDoor(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    lat: 30.0444,
    lon: 31.2357,
    accuracyMeters: 12,
    shutterLat: 30.0444,
    shutterLon: 31.2357,
    shutterAccuracyMeters: 9,
    ...extra,
  };
}

const VENUE = { name: "Nile Polyclinic", kind: "polyclinic", photoPath: "crm/venues/nile.jpg" };

export function runPhoenixCrmSharedPlaceTests(): void {
  const migration = readFileSync(MIGRATION, "utf8");

  // ── The venue's own gate: a live photo, a name, a kind, and BOTH readings at the door ─────────
  //
  // THREE kinds, not the four it shipped with: he read the chooser on the rep's own screen on
  // 2026-10-09 and answered "remove medical tower option". The CHECK that is live is the NARROWED
  // one, so that is the file this compares against — the original still names the tower, and reading
  // it here would pass a screen offering a kind the database now refuses.
  const narrowed = readFileSync(NARROWED, "utf8");
  assert.deepEqual(
    [...SHARED_PLACE_KIND_KEYS],
    ["polyclinic", "medical_centre", "hospital_outpatient"],
    "the three the owner left on the chooser — scope is every shared venue, not the polyclinic alone",
  );
  for (const kind of SHARED_PLACE_KIND_KEYS) {
    assert.ok(narrowed.includes(`'${kind}'`), `the SQL CHECK holds ${kind}`);
  }
  assert.ok(
    !SHARED_PLACE_KIND_KEYS.includes("medical_tower" as never),
    "and the medical tower is not offered to a rep",
  );
  for (const guard of stripComments(narrowed).split("check (kind in (").slice(1)) {
    assert.ok(!guard.slice(0, 200).includes("medical_tower"), "nor accepted by the table's own CHECK");
  }
  assert.ok(
    !stripComments(narrowed).includes("'medical_tower'"),
    "nor by the RPC guard that writes the row — a wide guard would answer 23514 instead of bad_input",
  );
  assert.equal(parseSharedPlaceKind("clinic"), null, "nothing off the wire is trusted");

  const noPhoto = parseSharedPlaceDraft({ ...atTheDoor(), name: VENUE.name, kind: VENUE.kind });
  assert.equal(noPhoto.ok, false);
  assert.equal(noPhoto.ok === false ? noPhoto.error : null, SHARED_PLACE_NO_PHOTO, "no live photo, no venue");

  const noName = parseSharedPlaceDraft({ ...atTheDoor(), kind: VENUE.kind, photoPath: VENUE.photoPath });
  assert.equal(noName.ok === false ? noName.error : null, SHARED_PLACE_NO_NAME);

  const noKind = parseSharedPlaceDraft({ ...atTheDoor(), name: VENUE.name, photoPath: VENUE.photoPath });
  assert.equal(noKind.ok === false ? noKind.error : null, SHARED_PLACE_NO_KIND);

  const noFix = parseSharedPlaceDraft({ ...VENUE });
  assert.equal(noFix.ok, false, "🔴 a venue with no location at all is refused — his own words");

  const roughPin = parseSharedPlaceDraft({ ...atTheDoor({ accuracyMeters: PLACE_MAX_ACCURACY_METERS + 1 }), ...VENUE });
  assert.equal(roughPin.ok, false, `a pin rougher than ${PLACE_MAX_ACCURACY_METERS} m is no reading`);
  const roughShutter = parseSharedPlaceDraft({
    ...atTheDoor({ shutterAccuracyMeters: PLACE_MAX_ACCURACY_METERS + 1 }),
    ...VENUE,
  });
  assert.equal(roughShutter.ok, true, "a rough shutter reading beside a sharp pin is taken - the pin decides (owner, 2026-10-11)");

  const good = parseSharedPlaceDraft({ ...atTheDoor(), ...VENUE });
  assert.equal(good.ok, true, "a live photo, a name, a kind and two precise readings is a venue");
  if (good.ok) {
    assert.equal(good.value.kind, "polyclinic");
    assert.equal(good.value.name, VENUE.name);
    assert.ok(!Object.keys(good.value).includes("address"), "the draft names NO location field — the server resolves them");
    assert.ok(!Object.keys(good.value).includes("brickId"), "nor the brick");
  }

  // ── NO GOOGLE CHECK ON A VENUE, and the proof is that nothing can call one ────────────────────
  const service = stripComments(readFileSync("src/lib/phoenix-crm/server/shared-places.ts", "utf8"));
  assert.ok(!service.includes("google-place"), "🔴 the venue service imports no Google module at all");
  assert.ok(!/judgeGooglePlace|readGooglePlace|googleCheckApplies/.test(service), "and calls no part of that check");
  assert.ok(service.includes("readPlaceSignboard("), "the signboard IS read — it is the venue's own name on the building");
  assert.ok(
    service.includes('listType: "AM"'),
    "and judged in the PLACE-NAME mode: a building signs itself, never the people who hold clinics inside it",
  );
  assert.ok(service.includes("signboardHoldsForReview(signboard)"), "a sign that did not confirm the venue's name holds it for the administrator");
  assert.ok(service.includes("recordRefusedReading("), "a refused capture is recorded before the refusal, as everywhere else");
  assert.ok(service.includes("resolvePlaceLocation("), "one resolver, so brick_lookup keeps its pessimistic default");
  assert.ok(service.includes("territoryForValidation("), "and the rep's own territory is the gate");

  // ── ONE SEAT SEES A VENUE, AND NEVER A SHARED POOL ──────────────────────────────────────────
  //
  // The owner, 2026-10-09, asked the day the venues shipped whether a polyclinic one rep captured
  // should be offered to the other reps covering the same building: "No, every polyclinic appears
  // only to the rep validated it. No sharing."
  //
  // It is not a preference about clutter. A venue carries the CAPTURING rep's own evidence — his
  // live signboard photo, his two readings, his `created_by_hr_id` — so seating a customer on
  // another rep's capture would stand that customer's place behind a photo its own rep never took.
  // Two reps on one building each capture it, and those duplicate rows are CORRECT.
  const picker = service.slice(
    service.indexOf("export async function loadSharedPlacesFor("),
    service.indexOf("async function venueSignboard("),
  );
  assert.ok(picker.length > 0, "the venue picker's read is where this is decided");
  assert.ok(
    picker.includes('.eq("seat_id", seat.seatId)'),
    "🔒 the picker reads ONE seat's venues — his ruling: no sharing between reps",
  );
  for (const widening of ['.in("seat_id"', '.eq("line_code"', '.eq("area_code"', '.eq("region_code"', '.eq("brick_id"']) {
    assert.ok(!picker.includes(widening), `nor is it widened with ${widening} — that is the defect, not a tidy-up`);
  }

  // ── Seating: the timetable, the hours, and NO LOCATION AT ALL ────────────────────────────────
  const noVenue = parseSeatedPlaceDraft({ photoPath: "crm/timetables/a.jpg", timings: [{ weekday: 6, start: "10:00" }] });
  assert.equal(noVenue.ok === false ? noVenue.error : null, SEATED_PLACE_NO_VENUE);

  // 🔴 NO PHOTO IS NOT A REFUSAL ANY MORE (owner, 2026-10-10) — it is the ordinary shape of the
  // second, third and fourth doctor in a building whose board is already photographed.
  const seatedNoPhoto = parseSeatedPlaceDraft({
    sharedPlaceId: "3f4a1b2c-5d6e-4f70-8a9b-0c1d2e3f4a5b",
    timings: [{ weekday: 6, start: "10:00" }],
  });
  assert.equal(seatedNoPhoto.ok, true, "a seating against the board already on file sends no photo at all");
  assert.equal(
    seatedNoPhoto.ok === true ? seatedNoPhoto.value.photoPath : "not parsed",
    null,
    "and null is how it says 'the timetable this building already has' — the server resolves which one",
  );

  const seatedNoHours = parseSeatedPlaceDraft({
    sharedPlaceId: "3f4a1b2c-5d6e-4f70-8a9b-0c1d2e3f4a5b",
    photoPath: "crm/timetables/a.jpg",
    timings: [],
  });
  assert.equal(seatedNoHours.ok, false, "at least one weekday with a start time — his own rule, which parseTimings already holds");

  const seated = parseSeatedPlaceDraft({
    sharedPlaceId: "3f4a1b2c-5d6e-4f70-8a9b-0c1d2e3f4a5b",
    photoPath: "crm/timetables/a.jpg",
    timings: [{ weekday: 6, start: "10:00" }],
    // A body that still carries a fix is IGNORED, never honoured: the point is the venue's.
    lat: 29.9,
    lon: 31.9,
    accuracyMeters: 8,
  });
  assert.equal(seated.ok, true, "a venue, a timetable photo and one start time seats a customer");
  if (seated.ok) {
    assert.deepEqual(
      Object.keys(seated.value).sort(),
      ["label", "photoPath", "session", "sharedPlaceId", "timings"],
      "🔴 FIVE KEYS, NO FIX — a seated draft cannot carry a location even when the body sends one",
    );
    assert.equal(seated.value.session, null, "a build that names no session leaves it null, and the database seats him in his own list");
    assert.equal(seated.value.timings.length, 1);
    assert.equal(seated.value.timings[0].startMinute, 600);
    assert.equal(seated.value.timings[0].endMinute, null, "the end of a window stays optional, as everywhere else");
  }

  // ── The point, the brick, the area and the region are INHERITED, not re-resolved ──────────────
  assert.ok(service.includes('point_source: "shared_place"'), "a seated place says where its point came from");
  assert.ok(service.includes("...venue.location"), "and copies the venue's whole resolution — brick, area, region, zone, address");
  const list = stripComments(readFileSync("src/lib/phoenix-crm/server/list.ts", "utf8"));
  assert.ok(list.includes("seatedDraftOf(body)"), "validateCustomer reads a seating before anything else");
  assert.ok(list.includes("seatedPlacePayload(venue, seated)"), "and saves it through the one payload builder");
  assert.ok(list.includes("recordPlaceSchedule("), "the timetable read is kept on the row");
  assert.ok(list.includes("readPlaceSchedule("), "and read on the server, never on the phone");
  const places = stripComments(readFileSync("src/lib/phoenix-crm/server/place-location.ts", "utf8"));
  assert.ok(places.length > 0, "the shared resolver still exists");

  // ── ONE TIMETABLE FOR THE BUILDING, NOT ONE PER DOCTOR (owner, 2026-10-10) ───────────────────
  //
  // His words: "when he adds the doctors, the three doctors we agreed in the same polyclinic, ask him
  // for only one timetable, not for every doctor." Four things had to move together, and each half
  // below is one of them.

  // 1 ─ The server decides reuse, from the VENUE's stored path. A body cannot ask for it.
  assert.ok(service.includes("export function effectiveSeatedPhoto("), "one function decides which photo a seating is saved against");
  assert.ok(
    service.includes("if (seated.photoPath) return { path: seated.photoPath, reused: false };"),
    "a photo sent from the phone is a REPLACEMENT of the board on the wall",
  );
  assert.ok(
    service.includes("return { path: venue.schedulePhotoPath, reused: true };"),
    "🔴 and reuse resolves from the VENUE's own column — never from a flag on the body, which is why the seated draft still has exactly four keys",
  );
  assert.ok(
    service.includes("if (!venue.schedulePhotoPath) throw validationError(SEATED_PLACE_NO_PHOTO);"),
    "the refusal moved HERE, where the venue is the only thing that can answer it: the first customer in a building",
  );
  assert.ok(
    service.includes("schedule_photo_path, schedule_photo_captured_at, schedule_photo_by_hr_id"),
    "the venue read names the three new columns, or a PostgREST 42703 takes the whole select down",
  );
  assert.ok(
    service.includes("const issuedAt = photo.reused ? null : await photoSlotIssuedAt(photo.path)"),
    "🔴 no device skew on a reused board — its slot was issued on another day, possibly to another rep, so the gap measures nothing",
  );

  // 2 ─ The timetable read still runs per customer, through a door that drops ONE condition.
  assert.ok(list.includes("reusedTimetable: seatedPhoto.reused"), "the schedule read is told whether it is reading the building's own board");
  const scheduleCheck = stripComments(readFileSync("src/lib/phoenix-crm/server/schedule-check.ts", "utf8"));
  assert.ok(scheduleCheck.includes("downloadVenueTimetablePhoto({"), "and reads it through the venue door on a reuse");
  const photos = stripComments(readFileSync("src/lib/phoenix-crm/server/photos.ts", "utf8"));
  const venueDoor = photos.slice(photos.indexOf("export async function downloadVenueTimetablePhoto("));
  assert.ok(venueDoor.length > 0, "the venue door exists");
  for (const kept of ["photoPathTerritory(path)", 'storageSegment(input.seatId)', '.eq("seat_id", input.seatId)', '.eq("purpose", "place")']) {
    assert.ok(venueDoor.includes(kept), "it keeps " + kept + " — a path this seat never uploaded still never reaches the bucket");
  }
  assert.ok(
    !venueDoor.includes("issued_to_hr_id"),
    "🔴 and drops exactly one condition: the slot behind a building's board was issued to whoever photographed it, not to the rep seating the next doctor",
  );

  // 3 ─ What makes a seating idempotent now that no slot is consumed.
  const oneTimetableSql = stripSqlComments(
    readFileSync("supabase/migrations/20261010190000_phoenix_crm_one_timetable_for_a_polyclinic.sql", "utf8"),
  );
  assert.ok(oneTimetableSql.includes("add column if not exists schedule_photo_path text"), "the venue keeps the building's timetable");
  // Sliced to the statement rather than matched over the file: the predicate has to sit on THIS
  // index, and a `where shared_place_id is null` anywhere else in the migration would satisfy a
  // whole-file assertion while the index stayed unconditional.
  const photoUidx = oneTimetableSql.slice(oneTimetableSql.indexOf("create unique index if not exists phoenix_crm_places_photo_uidx"));
  assert.ok(
    photoUidx.slice(0, photoUidx.indexOf(";")).includes("where shared_place_id is null"),
    "🔴 the one-photo-one-place index is PARTIAL — it still binds every place captured at its own door, and seated rows share the building's board",
  );
  assert.ok(
    oneTimetableSql.includes("drop index if exists public.phoenix_crm_places_photo_uidx;"),
    "and the unconditional index it replaces is dropped in the SAME transaction, so no save ever meets neither",
  );
  assert.ok(oneTimetableSql.includes("where s.id = v_shared for update"), "the venue's row is LOCKED, which serialises two saves in one building");
  assert.ok(
    oneTimetableSql.includes("raise exception 'phoenix_crm:already_seated'"),
    "🔴 and one customer sits in one building once — the refusal that replaced the single-use photo slot's idempotence",
  );
  assert.ok(oneTimetableSql.includes("v_photo = v_venue.schedule_photo_path"), "reuse is recognised by comparing the path against the stored one");
  assert.ok(oneTimetableSql.includes("where pl.shared_place_id is not null"), "and every venue already seated in is backfilled from its earliest seating");
  const dbRefusals = stripComments(readFileSync("src/lib/phoenix-crm/server/db.ts", "utf8"));
  assert.ok(dbRefusals.includes("already_seated: {"), "the refusal carries a sentence the rep can act on");
  const screens = stripComments(readFileSync("src/components/phoenix-crm/list-screens.tsx", "utf8"));
  assert.equal(
    screens.split("MAY_HAVE_SAVED.has(code) && photo ? await lookUpPhoto(").length - 1,
    2,
    "🔴 both save paths skip the photo lookup when nothing was captured: a reused board belongs to every doctor behind that door, so it would find the FIRST one and report this save as successful",
  );

  // 4 ─ The screen asks once per building, and stamps the BUILDING's name into the image.
  const seatedScreen = stripComments(readFileSync("src/components/phoenix-crm/shared-place-screens.tsx", "utf8"));
  assert.ok(
    seatedScreen.includes("title={`Phoenix CRM ${SHARED_PLACE_TITLE.toLowerCase()}: ${chosen.name}`}"),
    "🔴 the stamp burned into the timetable photo is the BUILDING's name — the old customer stamp is what made one image per doctor unavoidable",
  );
  assert.ok(!seatedScreen.includes("photoBlockedReason"), "so the 'write the customer's name first' gate is gone with it");
  assert.ok(seatedScreen.includes("SEATED_PLACE_PHOTO_REPLACE"), "and the only way back to the camera is the board on the wall having changed");
  assert.ok(
    seatedScreen.includes("draft.replacingTimetable || !draft.timetableOnFile"),
    "the phone asks for a photo of the FIRST customer in a building, and of a rep who said the board changed — nobody else",
  );
  assert.equal(
    SEATED_PLACE_NO_PHOTO,
    "Take a live photo of the timetable on the wall.",
    "and that sentence is about the BUILDING's board now, not about this customer's own hours",
  );

  // ── A HELD VENUE IS CHOOSABLE (owner, 2026-10-14: "make him able to choose him even if the system is
  // still checking") — it used to be greyed out for good, because nothing released a held venue by
  // itself, and the rep's Save answered "Choose the polyclinic or centre this customer receives in." ──
  const heldSeating = stripComments(readFileSync("src/lib/phoenix-crm/server/shared-places.ts", "utf8"));
  const forSeating = heldSeating.slice(
    heldSeating.indexOf("export async function sharedPlaceForSeating("),
    heldSeating.indexOf("export type EffectiveSeatedPhoto"),
  );
  assert.ok(forSeating.includes('row.status === "retired"'), "a removed venue is still refused");
  assert.ok(!forSeating.includes('"held"'), "🔴 and a HELD one is not: the server no longer refuses a seating in a venue being checked");
  const heldInsertPlace = readFileSync("supabase/migrations/20261014151354_phoenix_crm_insert_place_seats_in_a_held_venue.sql", "utf8")
    .replace(/--[^\n]*/g, "");
  assert.ok(heldInsertPlace.includes("phoenix_crm:shared_place_retired"), "the database still refuses a removed venue under its lock");
  assert.ok(heldInsertPlace.includes("phoenix_crm:already_seated"), "and keeps one customer in one building once");
  assert.ok(!heldInsertPlace.includes("shared_place_held"), "🔴 but no longer raises shared_place_held on a seating");
  assert.ok(!seatedScreen.includes('venue.status !== "active"'), "🔴 the picker does not grey a venue out for being held");
  assert.ok(
    !seatedScreen.includes("if (!held) onChange("),
    "🔴 and a building the rep has just captured is CHOSEN even while held, or Save asks him to choose one",
  );

  // ── A CUSTOMER SEATED IN A HELD VENUE WAITS FOR ITS APPROVAL (owner, 2026-10-14: the visits appear, but
  // "are not counted in KPIs until the admin confirm the polyclinic and the doctors in it") ──
  // Every KPI reads customer_validated, so the whole mechanism is: leave him PENDING when the venue is held,
  // and let ONLY the venue's approval (or the Super Admin's own click) make him active.
  const waitSql = stripSqlComments(
    readFileSync("supabase/migrations/20261014200147_phoenix_crm_held_venue_customers_wait_for_approval.sql", "utf8"),
  );
  const functionBody = (name: string): string => {
    const start = waitSql.indexOf(`create or replace function public.${name}(`);
    assert.ok(start >= 0, `${name} is recreated by the migration`);
    return waitSql.slice(start, waitSql.indexOf("$$;", waitSql.indexOf("$$", start) + 2));
  };
  const validateFn = functionBody("phoenix_crm_validate_customer");
  assert.ok(
    validateFn.includes("select (s.status = 'held') into v_venue_held"),
    "🔴 the seating door asks whether the building is HELD, under the seat's lock that the venue's decision also takes",
  );
  assert.ok(
    validateFn.includes("v_validate_now := v_hold is null and not v_venue_held;"),
    "and a held venue stops the customer being validated exactly as a Google or signboard hold does",
  );
  assert.equal(validateFn.split("v_validate_now").length - 1 >= 7, true, "every status write of the three modes reads that one flag");
  assert.ok(
    !validateFn.includes("if v_hold is null then") && !validateFn.includes("when v_hold is null then"),
    "🔴 and none of them still reads v_hold alone, which would validate a customer a held venue is holding out",
  );
  assert.ok(
    validateFn.includes("v_event := 'customer_pending'") && validateFn.includes("'why', 'venue_held'"),
    "the event says pending and why, never customer_validated for a customer no KPI counts",
  );

  const decideFn = functionBody("phoenix_crm_decide_shared_place");
  // Single-line anchors only — a `\n` here is red on a CRLF working tree and green on CI.
  const approveBranch = decideFn.slice(decideFn.indexOf("if v_decision = 'approve' then"), decideFn.indexOf("set status = 'retired', decided_at"));
  assert.ok(approveBranch.length > 400, "the approve branch was found, so the assertions below read it and not an empty string");
  assert.ok(approveBranch.includes("c.status = 'pending'") && approveBranch.includes("'shared_place_approved'"), "🔴 APPROVING the building confirms the pending customers seated in it");
  assert.ok(approveBranch.includes("v_venue.schedule_photo_path is null"), "except a building with no timetable on file");
  assert.ok(approveBranch.includes("'other_name', 'no_schedule'"), "or a timetable that was read as another name or no schedule");
  assert.ok(
    approveBranch.includes("r.customer_id = v_seated.customer_id and r.status = 'pending'"),
    "or a customer whose own location is waiting on a validation review — that row is the Super Admin's own click",
  );
  assert.ok(!approveBranch.includes("'unjudged'"), "🔴 and `unjudged` never holds: it is not among the reasons to stay pending");
  assert.ok(decideFn.includes("'shared_place_rejected'"), "a REJECTION still retires the venue and reopens every customer in it");

  const settleFn = functionBody("phoenix_crm_settle_venue_timetable");
  assert.ok(
    settleFn.includes("v_verdict = 'match' and v_row.customer_status = 'pending' and v_venue.status = 'active'"),
    "🔴 a board that names a customer does NOT release him while his building is still held",
  );

  // The rep's screens: no grey, no "being checked" wording, and a pending seated customer is never "Validated".
  const noteFn = seatedScreen.slice(seatedScreen.indexOf("export function seatedNote("), seatedScreen.indexOf("function CaptureVenue("));
  assert.ok(!/checking/i.test(noteFn.replace(/audience/g, "")), "🔴 the rep's venue row never says the building is being checked (golden rule #1)");
  assert.ok(noteFn.includes('audience === "admin" && venue.status === "held"'), "only the Super Admin's own move screen is told which buildings wait for him");
  assert.ok(!seatedScreen.includes("Saved. The system is checking it"), "and neither does the note after a rep captures a building");
  const listScreensSrc = stripComments(readFileSync("src/components/phoenix-crm/list-screens.tsx", "utf8"));
  assert.ok(
    listScreensSrc.includes('result.status === "pending"') && listScreensSrc.includes('"venue_pending"'),
    "🔴 a seated customer left pending by a held venue is told 'Saved', never 'Validated'",
  );
  const listPlaceSrc = stripComments(readFileSync("src/lib/phoenix-crm/server/list.ts", "utf8"));
  assert.ok(listPlaceSrc.includes('mapped.venueHeld = venueHeld.get(venueId) === true'), "the customer page is told whether the building is held");
  const blindSrc = stripComments(readFileSync("src/lib/phoenix-crm/server/blind-payloads.ts", "utf8"));
  assert.ok(blindSrc.includes("venueHeld: place.venueHeld"), "and the rep keeps that flag — it measures nothing about him");
  const customerSrc = stripComments(readFileSync("src/components/phoenix-crm/list-customer.tsx", "utf8"));
  assert.ok(
    customerSrc.includes("seatedPending && !seatedVenueHeld && (view.canEdit || view.canValidateReference)"),
    "🔴 no 'Photograph the timetable' button for a held building: set_venue_timetable refuses it and he already brought the board",
  );

  // ── THREE A DAY, and the cap is a SETTING read live on every path ─────────────────────────────
  assert.equal(SHARED_PLACE_DAILY_CAP_DEFAULT, 3, "his number — and only the default");
  assert.ok(migration.includes("shared_place_daily_cap integer not null default 3"), "the settings column");
  assert.ok(migration.includes("shared_place_daily_cap >= 1 and shared_place_daily_cap <= 20"), "bounded, like the PM and AM caps");
  assert.ok(migration.includes("select s.shared_place_daily_cap into v_cap"), "🔴 the trigger READS the setting rather than hard-coding 3");
  assert.ok(migration.includes(`raise exception '${SHARED_PLACE_DAY_FULL_CODE}'`), "and refuses the fourth visit of a day with the one code");
  assert.ok(migration.includes("create or replace trigger phoenix_crm_visits_shared_place_cap"), "at the door, on the visit itself");

  const counted = countSharedPlaceDays([
    { planDate: "2026-10-11", sharedPlaceId: "venue-a" },
    { planDate: "2026-10-11", sharedPlaceId: "venue-a" },
    { planDate: "2026-10-11", sharedPlaceId: "venue-b" },
    { planDate: "2026-10-12", sharedPlaceId: "venue-a" },
    // A customer with his own clinic is never part of a venue's day.
    { planDate: "2026-10-11", sharedPlaceId: null },
  ]);
  assert.equal(counted.get("2026-10-11")?.get("venue-a"), 2);
  assert.equal(counted.get("2026-10-11")?.get("venue-b"), 1);
  assert.equal(counted.get("2026-10-12")?.get("venue-a"), 1);

  const venues = new Map<string, SharedPlaceNamed>([
    ["venue-a", { sharedPlaceId: "venue-a", name: "Nile Polyclinic", kind: "polyclinic" }],
  ]);
  const items = [
    { planDate: "2026-10-12", sharedPlaceId: "venue-a" },
    { planDate: "2026-10-11", sharedPlaceId: "venue-a" },
    { planDate: "2026-10-11", sharedPlaceId: "venue-a" },
    { planDate: "2026-10-11", sharedPlaceId: "venue-a" },
    { planDate: "2026-10-11", sharedPlaceId: "venue-a" },
  ];
  const dayLabel = (iso: string) => (iso === "2026-10-11" ? "Sat 11 Oct" : "Sun 12 Oct");
  assert.equal(sharedPlanCapRefusal({ items: items.slice(0, 4), venues, cap: 3, dayLabel }), null, "three on one day is allowed");
  const refusal = sharedPlanCapRefusal({ items, venues, cap: 3, dayLabel });
  assert.equal(
    refusal,
    "Nile Polyclinic has 4 visits on Sat 11 Oct. One polyclinic holds 3 visits a day at most.",
    "it names the venue, the count and the cap — and nothing about any check on him",
  );
  const onSend = sharedPlanCapRefusal({ items, venues, cap: 3, dayLabel, forSend: true });
  assert.ok(onSend?.endsWith("Take one off that day, save, then send."), "the send says what to do about it");
  assert.equal(
    sharedPlanCapRefusal({ items, venues, cap: 3, dayLabel, onlyDays: ["2026-10-12"] }),
    null,
    "a send of one day never refuses on another day's rows",
  );
  // The day named is the EARLIEST offending one, never whichever the Map happened to hold first.
  assert.ok(refusal?.includes("Sat 11 Oct"));

  // 🔴 `planCapRefusal` IS PINNED TO EXACTLY TWO COMPARISONS (phoenix-crm-plan-cap-on-send.test.ts),
  // so the venue cap is its own function and had to be wired separately in all three places.
  const planRules = stripComments(readFileSync("src/lib/phoenix-crm/plan-rules.ts", "utf8"));
  assert.ok(planRules.includes("sharedPlanCapRefusal("), "the save path");
  const plans = stripComments(readFileSync("src/lib/phoenix-crm/server/plans.ts", "utf8"));
  assert.ok(plans.includes("sharedPlanCapRefusal("), "the send path");
  // `db.ts`'s REFUSALS table is keyed by the code WITHOUT the `phoenix_crm:` prefix the exception
  // carries, so the two spellings are asserted where each one actually lives.
  assert.equal(SHARED_PLACE_DAY_FULL_CODE, "phoenix_crm:shared_place_day_full");
  const db = stripComments(readFileSync("src/lib/phoenix-crm/server/db.ts", "utf8"));
  assert.ok(db.includes("shared_place_day_full: { status: 409"), "the door's exception becomes a 409 the rep can read");
  assert.ok(db.includes("SHARED_PLACE_DAY_FULL_TEXT"), "worded once, in the rules module");
  // 🔴 AND IT IS DELIBERATELY NOT A SETTLED OUTBOX CODE. `OUTBOX_SETTLED_CODES` is mirrored, and
  // `tests/phoenix-crm-mobile-mirrors.test.ts` compares the two copies code for code: a code only one
  // side knows is the exact drift that test exists to catch, and one side dropping a visit the other
  // keeps is the worst shape of it. A capped visit therefore retries and ages out at
  // `OUTBOX_MAX_AGE_HOURS`, the keep-too-long direction that list already prefers for
  // `phoenix_crm_conflict`. The rep is still told at the door: the live save answers 409 with the
  // cap's own sentence, above.
  const outbox = stripComments(readFileSync("src/lib/phoenix-crm/outbox-rules.ts", "utf8"));
  const settled = /OUTBOX_SETTLED_CODES: readonly string\[\] = \[([\s\S]*?)\]/.exec(outbox);
  assert.ok(settled, "OUTBOX_SETTLED_CODES is still a literal array");
  assert.ok(
    !settled[1].includes("shared_place_day_full"),
    "the cap is NOT a settled outbox code — the two copies of that list must stay identical",
  );
  assert.ok(
    // Read uncommented, deliberately: the reason IS the comment.
    readFileSync("src/lib/phoenix-crm/outbox-rules.ts", "utf8").includes("Deliberately NOT here either, for the same reason: `phoenix_crm_shared_place_day_full`"),
    "and the list says why it is absent, so nobody adds it back as an oversight",
  );

  // ── Rejecting a venue takes everybody seated in it back to To validate ────────────────────────
  const decide = migration.slice(migration.indexOf("create or replace function public.phoenix_crm_decide_shared_place"));
  assert.ok(decide.includes("set reopened_at = now()"), "🔴 each customer is stamped, so he is first in his rep's list again");
  assert.ok(decide.includes("'retired'"), "the venue and its places are retired");
  assert.ok(decide.includes("phoenix_crm_places"), "the seated places, not only the venue");

  // ── The administrator's board ─────────────────────────────────────────────────────────────────
  const board = stripComments(readFileSync("src/components/phoenix-crm/validation-reviews-board.tsx", "utf8"));
  assert.ok(board.includes("<SharedPlaceList"), "the Polyclinics section is on the place-checks page");
  assert.ok(board.includes("filteredSharedPlaces.length"), "and its heading count is the FILTERED count, like every other section");
  const page = stripComments(readFileSync("app/(admin)/admin/field-crm/validation-reviews/page.tsx", "utf8"));
  assert.ok(page.includes("loadSharedPlaceBoard(viewer)"), "loaded beside the other three reads");
  assert.ok(page.includes("sharedPlaces: sharedRead.capped"), "and a capped read says so rather than under-reporting");

  const venueList = readFileSync("src/components/phoenix-crm/shared-place-list.tsx", "utf8");
  assert.ok(venueList.indexOf("<CrmCardsOnPhone") < venueList.indexOf("<CrmTable"), "phone cards first, then the table");
  assert.doesNotMatch(
    stripComments(venueList),
    /\brounded-(?!none\b)|\boverflow-x-auto\b|\btruncate\b|\bmin-w-\[/,
    "square, no sideways scroll, no ellipsis, no min-width in a scroller",
  );
  assert.ok(venueList.includes("<RefusalReasonField"), "a rejection picks from the closed list");
  assert.ok(venueList.includes("/api/phoenix-crm/validation-reviews/shared-place"), "and posts to the venue's own decide route");

  // The filters reach a venue by rep, line, region, area and text — and the LIST filter does not.
  const row = {
    name: "Nile Polyclinic",
    repName: "Hassan Adel",
    line: "CNS",
    region: "Cairo",
    territory: "Cairo 1",
    address: null,
    brickName: null,
    areaName: "Qalubeya",
    status: "active" as const,
    decidedAtText: null,
  };
  assert.equal(matchesSharedPlaceFilters(row, { ...EMPTY_VALIDATION_REVIEW_FILTERS, rep: "Hassan Adel" }), true);
  assert.equal(matchesSharedPlaceFilters(row, { ...EMPTY_VALIDATION_REVIEW_FILTERS, rep: "Somebody Else" }), false);
  assert.equal(matchesSharedPlaceFilters(row, { ...EMPTY_VALIDATION_REVIEW_FILTERS, area: "Qalubeya" }), true);
  assert.equal(matchesSharedPlaceFilters(row, { ...EMPTY_VALIDATION_REVIEW_FILTERS, text: "nile" }), true, "the free text searches the venue's own name");
  assert.equal(
    matchesSharedPlaceFilters(row, { ...EMPTY_VALIDATION_REVIEW_FILTERS, list: "AM" }),
    true,
    "🔴 the LIST filter does not reach a venue: it is on nobody's list, so narrowing to AM must not empty the section",
  );
  assert.equal(sharedPlacePassesOutcome(row, "all"), true);
  assert.equal(sharedPlacePassesOutcome(row, "pending"), false, "an active venue is not waiting");
  assert.equal(sharedPlacePassesOutcome({ ...row, status: "held" }, "pending"), true, "a held one is");
  assert.equal(sharedPlacePassesOutcome(row, "rejected"), false, "a rejected venue is retired and never read");
  assert.equal(sharedPlacePassesOutcome(row, "unseen"), true, "nobody has decided this one");
  assert.equal(sharedPlacePassesOutcome({ ...row, decidedAtText: "9 Oct 2026, 14:00" }, "unseen"), false);

  // ── The two new refusal reasons, and the one that must never be offered on a timetable ───────
  const scheduleKeys = reasonsFor("schedule").map((reason) => reason.key);
  assert.ok(scheduleKeys.includes("schedule_other_name") && scheduleKeys.includes("schedule_missing"), "the seventh and the eighth");
  assert.ok(!scheduleKeys.includes("photo_of_paper"), "a timetable IS paper — that reason would be wrong by construction");

  // ── The new table's four boundary lines (the boundary test sweeps them all; this is the venue's) ─
  for (const line of [
    "alter table public.phoenix_crm_shared_places enable row level security",
    "create policy phoenix_crm_shared_places_service_role",
    "revoke all on table public.phoenix_crm_shared_places from public, anon, authenticated",
    "grant all on table public.phoenix_crm_shared_places to service_role",
  ]) {
    assert.ok(migration.includes(line), `the migration carries: ${line}`);
  }


  // ── A REJECTED VENUE MUST SPEAK, AND IN ITS OWN WORDS ─────────────────────────────────────────
  //
  // Owner, 2026-10-09, after he watched a venue rejected on the board: "fix the polyclinic rejection
  // so the rep is told the reason". Two separate holes were behind it, both measured on staging that
  // night with one rejected venue and the two customers seated in it:
  //
  //   1. `decideSharedPlace` never raised a notice at all. Its own paragraph said the reopened
  //      customers get `phoenix_crm.validation_not_confirmed`; the call was simply absent, so the
  //      venue retired, both places retired, both customers went back to To validate — in SILENCE.
  //   2. the board's "Waiting to be captured again" read "A rep" and "No reason was chosen — refused
  //      before the reason list existed." for both, while `no_signboard` sat on the venue: it looked
  //      the reason up on a `phoenix_crm_validation_reviews` row, which a VENUE refusal never writes.
  const venueReasons = reasonsFor("signboard");
  const A_PERSON_OR_DECISION = /\b(admin|super admin|manager|reviewer|rejected|refused by|approved|sfe|owner|he |she |they )/i;
  for (const reason of venueReasons) {
    const told = sharedPlaceRefusalRepText(reason.key);
    assert.ok(told, `a venue refused for "${reason.key}" has a sentence of its own`);
    // 🔴 The CLAUSE, not the whole sentence: wrapping a customer's own-door sentence in the venue's
    // lead and action would differ from `reason.rep` as a string while still being that sentence.
    const clause = String(told).slice(SHARED_PLACE_REFUSED_LEAD.length, String(told).length - SHARED_PLACE_REFUSED_ACTION.length).trim();
    assert.ok(clause.length > 0, `"${reason.key}" says what is wrong, between the lead and the action`);
    assert.ok(
      !reason.rep.includes(clause),
      `🔴 "${reason.key}" is NOT the sentence about this customer's own capture, forwarded — it is about the VENUE's photo`,
    );
    assert.doesNotMatch(
      String(told),
      /own entrance|customer's own|this customer's entrance/i,
      "🔴 a customer seated in a polyclinic HAS no door of his own — never send a rep to photograph one",
    );
    assert.ok(String(told).startsWith(SHARED_PLACE_REFUSED_LEAD), "it says which photo is meant first");
    assert.ok(String(told).endsWith(SHARED_PLACE_REFUSED_ACTION), "and ends in the one action that clears it");
    assert.doesNotMatch(String(told), A_PERSON_OR_DECISION, `"${reason.key}" names no person and no decision`);
  }
  for (const reason of VALIDATION_REFUSAL_REASONS) {
    if ((reason.kinds as readonly string[]).includes("signboard")) continue;
    assert.equal(
      sharedPlaceRefusalRepText(reason.key),
      null,
      `"${reason.key}" is a TIMETABLE reason — a venue refusal is never offered it, so it says nothing here`,
    );
  }
  assert.equal(sharedPlaceRefusalRepText(null), null, "no reason, no sentence — the caller falls back to the system's own");
  assert.equal(sharedPlaceRefusalRepText("<script>"), null, "and nothing off the wire is trusted");

  // The call that was missing, and the two things it must carry.
  const venueServer = stripComments(readFileSync("src/lib/phoenix-crm/server/shared-places.ts", "utf8"));
  assert.ok(
    venueServer.includes("await tellSeatedRepsValidateAgain(viewer, result, reopened);"),
    "🔴 the rejection TELLS the reps — a venue that reopens customers in silence is the defect this pins",
  );
  assert.ok(venueServer.includes('via: "shared_place"'), "and it is told in the venue's wording, not a customer's");
  assert.ok(
    venueServer.includes("reviewId: sharedPlaceId"),
    "the venue stands in for the review row it does not have, so one refusal raises one notice for ever",
  );
  const notices = stripComments(readFileSync("src/lib/phoenix-crm/server/notifications.ts", "utf8"));
  assert.ok(
    notices.includes('notice.via === "shared_place" ? sharedPlaceRefusalRepText(notice.reason)'),
    "the notice picks the venue's sentence over the six about a customer's own capture",
  );

  // And what the board reads where no review row exists.
  const reviewsServer = stripComments(readFileSync("src/lib/phoenix-crm/server/validation-reviews.ts", "utf8"));
  assert.ok(
    reviewsServer.includes("loadSharedPlaceRefusalsForCustomers("),
    "🔴 the waiting list asks the VENUE for the reason and the rep when the customer has no refused review of his own",
  );
  assert.ok(reviewsServer.includes("sharedPlaceName: venue?.sharedPlaceName ?? null"), "and names the venue beside the reason");
  assert.ok(
    venueServer.includes('.eq("status", "retired").not("shared_place_id", "is", null)'),
    "the join is the customer's RETIRED seated place → the venue behind it",
  );
  assert.ok(
    venueServer.includes('if (!venue || venue.status !== "retired") continue;'),
    "an ACTIVE venue reopened nobody — a seating retired on its own carries a review row of its own",
  );
  const waiting = readFileSync("src/components/phoenix-crm/reopened-customer-list.tsx", "utf8");
  assert.ok(waiting.includes("row.sharedPlaceName"), "and the board says the reason is about the polyclinic's photo");

  // ── AM or PM at the building (owner, 2026-10-10) ──────────────────────────────────────────────
  const seatedBody = {
    sharedPlaceId: "3f4a1b2c-5d6e-4f70-8a9b-0c1d2e3f4a5b",
    photoPath: "crm/timetables/a.jpg",
    timings: [{ weekday: 6, start: "10:00" }],
  };
  const asAm = parseSeatedPlaceDraft({ ...seatedBody, session: "am" });
  assert.equal(asAm.ok ? asAm.value.session : null, "AM", "AM is read in either case");
  const asPm = parseSeatedPlaceDraft({ ...seatedBody, session: "PM" });
  assert.equal(asPm.ok ? asPm.value.session : null, "PM");
  const asPharmacy = parseSeatedPlaceDraft({ ...seatedBody, session: "PHARMACY" });
  assert.equal(asPharmacy.ok === false ? asPharmacy.error : null, SEATED_PLACE_NO_SESSION, "a seating is AM or PM, nothing else");

  const WEEK = fieldWeekStart("2026-09-21");
  const THURSDAY = "2026-09-24";
  const SUNDAY = "2026-09-20";
  const CUSTOMER = "11111111-1111-4111-8111-111111111111";
  const SEATED_PLACE = "22222222-2222-4222-8222-222222222222";
  const OWN_PLACE = "33333333-3333-4333-8333-333333333333";
  const open = [0, 1, 2, 3, 4, 6].map((weekday) => ({ weekday, startMinute: 9 * 60, endMinute: 17 * 60, season: "normal" as const }));
  const ruleCustomers = (session: "AM" | "PM" | null) =>
    new Map<string, PlanRuleCustomer>([
      [
        CUSTOMER,
        {
          customerId: CUSTOMER,
          name: "Dr Karim Fouad",
          listType: "PM",
          pending: false,
          places: [
            { placeId: SEATED_PLACE, timings: open, sharedPlaceId: "venue-a", session },
            { placeId: OWN_PLACE, timings: open, sharedPlaceId: null },
          ],
        },
      ],
    ]);
  const plan = (day: string, placeId: string, session: "AM" | "PM" | null) =>
    resolvePlanItems({
      weekStart: WEEK,
      items: [{ planDate: day, customerId: CUSTOMER, placeId, exceptionType: null, exceptionNote: null }],
      customers: ruleCustomers(session),
      settings: PHOENIX_CRM_DEFAULT_SETTINGS,
      isRamadan: () => false,
    });

  // A PM customer seated as AM is planned on a Thursday morning, filed AM — the day that holds AM only.
  const seatedAm = plan(THURSDAY, SEATED_PLACE, "AM");
  assert.ok(seatedAm.ok, `a customer seated as AM can be planned on a morning: ${seatedAm.ok ? "" : seatedAm.error}`);
  assert.equal(seatedAm.ok ? seatedAm.value[0].listType : null, "AM", "the item is filed in the SEATING's session");
  // His other place has no session, so it keeps the customer's own PM list and a morning refuses it.
  const ownOnMorning = plan(THURSDAY, OWN_PLACE, "AM");
  assert.equal(ownOnMorning.ok, false, "a clinic of his own still follows his list");
  assert.match(ownOnMorning.ok ? "" : ownOnMorning.error, /morning/);
  // A seating that names no session (an older row) behaves exactly as before.
  const legacy = plan(SUNDAY, SEATED_PLACE, null);
  assert.equal(legacy.ok ? legacy.value[0].listType : null, "PM", "no session on the place: the customer's own list");

  // The planner shows him under the session of his seating, and the building filter narrows to it.
  const named = (id: string, listType: "AM" | "PM", session: "AM" | "PM" | null, venue: string | null): PlannerCustomer => ({
    customerId: id,
    name: id,
    listType: effectiveListType(listType, [{ session }]),
    grade: null,
    speciality: null,
    visitsThisMonth: 0,
    pending: false,
    places: [{ placeId: `${id}-place`, label: null, address: null, lat: 0, lon: 0, brick: null, zone: null, timings: [], sharedPlaceId: venue, sharedPlaceName: venue ? "Nile Polyclinic" : null, session }],
  });
  assert.equal(effectiveListType("PM", [{ session: "AM" }]), "AM");
  assert.equal(effectiveListType("PM", [{ session: null }]), "PM", "a place with no session leaves his list alone");
  assert.equal(effectiveListType("PM", []), "PM");
  const building = [named("seated-am", "PM", "AM", "venue-a"), named("seated-pm", "PM", "PM", "venue-a"), named("own-clinic", "PM", null, null)];
  assert.deepEqual(plannerVenues(building), [{ value: "venue-a", label: "Nile Polyclinic" }], "one entry per building, by name");
  const inBuildingAm = filterPlannerCustomers(building, { ...EMPTY_DOCTOR_FILTER, session: "AM", venue: "venue-a" }).map((customer) => customer.customerId);
  assert.deepEqual(inBuildingAm, ["seated-am"], "AM at that building shows only its AM customers");
  const inBuildingPm = filterPlannerCustomers(building, { ...EMPTY_DOCTOR_FILTER, session: "PM", venue: "venue-a" }).map((customer) => customer.customerId);
  assert.deepEqual(inBuildingPm, ["seated-pm"], "and PM only its PM customers — never both for one customer");

  // The migration files the session on the seating, the plan item and the visit.
  const sessionMigration = readFileSync("supabase/migrations/20261010180118_phoenix_crm_seating_session.sql", "utf8");
  assert.ok(sessionMigration.includes("add column if not exists session text"), "the seating carries the session");
  assert.ok(sessionMigration.includes("check (shared_place_id is null or session is not null)"), "a seated place always has one");
  assert.ok(sessionMigration.includes("v_list_type := coalesce("), "a visit counts in its seating's session, which every AM and PM board reads");

  // ── The picker read its own envelope twice, and was EMPTY for ever ───────────────────────────
  //
  // 🔴 `crmGet(url, key)` RETURNS `body[key]` — THE VALUE, NEVER THE ENVELOPE. So a hook typed
  // `useCrmGet<{ sharedPlaces: … }>(…, "sharedPlaces")` whose answer is read as `data?.sharedPlaces`
  // asks an ARRAY for a property it has never carried: undefined, `?? []`, and an empty picker on
  // every phone. The compiler cannot see it — `request()` ends in `body[key] as T`, so the generic
  // is an assertion and not a check — and the screen then says "No polyclinic or centre is on this
  // territory yet", which reads exactly like a territory that has none.
  //
  // It cost Sherif Medhat two field days (production, 2026-10-12). With no venue in the picker
  // `chosen` stays null, so the AM/PM step and the timetable camera are never rendered and
  // "Save the customer" refuses with SEATED_PLACE_NO_SESSION — a question that is not on the screen.
  // His touch trail holds nine taps on Save against that one alert; he photographed the same
  // building 11 times believing each save had been lost, and nobody in the company was seated in a
  // polyclinic for two days.
  //
  // So the sweep is over EVERY useCrmGet in the module, not only the three venue screens: the
  // generic may never be an object wrapping the key the hook has already unwrapped.
  const crmComponents = "src/components/phoenix-crm";
  let hooksChecked = 0;
  for (const file of readdirSync(crmComponents).filter((name) => name.endsWith(".tsx") || name.endsWith(".ts"))) {
    const code = stripComments(readFileSync(`${crmComponents}/${file}`, "utf8"));
    for (const line of code.split("\n")) {
      const opened = line.indexOf("useCrmGet<");
      if (opened < 0) continue;
      const closed = line.indexOf(">(", opened);
      const quoted = line.slice(closed).split('"');
      if (closed < 0 || quoted.length < 3) continue;
      const generic = line.slice(opened + "useCrmGet<".length, closed).trim();
      const key = quoted[quoted.length - 2];
      hooksChecked += 1;
      const wrappedIn = generic.startsWith("{") ? generic.slice(1).split(":")[0].trim().replace("?", "") : null;
      assert.notEqual(
        wrappedIn,
        key,
        `${file}: useCrmGet already unwraps the envelope — type it as the value, never as { ${key}: … }: ${line.trim()}`,
      );
    }
  }
  assert.ok(hooksChecked >= 30, `the useCrmGet sweep read ${hooksChecked} hooks — it must see the whole module`);

  // And the three screens that read the venues read the value itself.
  for (const screen of ["shared-place-screens", "seat-in-venue-screen", "venue-timetable-screen"]) {
    const code = stripComments(readFileSync(`${crmComponents}/${screen}.tsx`, "utf8"));
    assert.ok(
      code.includes(`useCrmGet<SharedPlaceChoice[]>(crmUrl("/api/phoenix-crm/shared-places"`),
      `${screen}: the venues hook is typed as the array the route answers with`,
    );
    assert.ok(!code.includes("data?.sharedPlaces"), `${screen}: nothing reads .sharedPlaces off the unwrapped array`);
  }
  // The route it reads: one key, one value, and the key is the one the hook is given.
  const venuesRoute = stripComments(readFileSync("app/api/phoenix-crm/shared-places/route.ts", "utf8"));
  assert.ok(venuesRoute.includes("NextResponse.json({ sharedPlaces, success: true })"), "the GET answers { sharedPlaces, success }");


  // ── Approving a polyclinic AFTER rejecting it (owner, 2026-10-15) ─────────────────────────────
  // A rejected PLACE could always be taken back; a rejected VENUE could not, by anybody — and it is
  // the heaviest decision on the page, retiring the building, its seated places and sending every
  // doctor in it back to To validate. Production held 35 retired venues with no way back the day
  // this was written, and the board could not even draw one.
  const restoreSql = stripSqlComments(
    readFileSync("supabase/migrations/20261015220318_phoenix_crm_restore_shared_place.sql", "utf8"),
  );
  assert.match(
    restoreSql,
    /create or replace function public\.phoenix_crm_restore_shared_place\(p jsonb\)/,
    "the undo of a venue rejection is one function of its own",
  );
  assert.ok(
    restoreSql.includes("if v_venue.status <> 'retired' or v_venue.retired_at is null then")
      && restoreSql.includes("raise exception 'phoenix_crm:shared_place_not_retired';"),
    "🔴 only a REJECTED venue comes back, and only while it is still in the state the rejection left it in",
  );
  assert.ok(
    restoreSql.includes("and pl.retired_at = v_retired_at"),
    "🔴 WHICH places come back is decided by `retired_at`, not by the seating — a bare shared_place_id + retired would "
      + "also resurrect a place retired earlier for its own reason",
  );
  for (const hold of [
    "if v_venue.schedule_photo_path is null",
    "(v_seated.schedule_check ->> 'verdict') in ('other_name', 'no_schedule')",
    "where r.customer_id = v_seated.customer_id and r.status = 'pending'",
  ]) {
    assert.ok(
      restoreSql.includes(hold),
      `the restore keeps the approve branch's hold verbatim, never widened: ${hold}`,
    );
  }
  assert.ok(
    restoreSql.includes("set reopened_at = null") && restoreSql.includes("where c.status = 'active'"),
    "the capture-again stamp is cleared for whoever is back in use and KEPT for whoever is still pending",
  );
  for (const event of ["'shared_place_restored'", "'place_restored'", "'customer_validated'"]) {
    assert.ok(restoreSql.includes(event), `the history is written, not inferred: ${event}`);
  }
  assert.doesNotMatch(
    restoreSql,
    /insert\s+into\s+supabase_migrations/i,
    "🔴 and it writes NO ledger row — `assertMigrationHygiene` refuses one, and the row is written only after `pg_proc` proves the function landed",
  );

  // The service, the route and the registry.
  assert.ok(
    venueServer.includes('callPhoenixCrm<Row>("phoenix_crm_restore_shared_place"'),
    "the service calls the function and never writes the venue row itself",
  );
  const restoreGate = venueServer.slice(venueServer.indexOf("export async function restoreSharedPlace"));
  assert.ok(
    restoreGate.includes("if (!canDecideSharedPlaces(viewer)) throw forbiddenError("),
    "🔴 the Super Admin ALONE brings a venue back — the same gate that rejected it",
  );
  const restoreRoute = stripComments(readFileSync("app/api/phoenix-crm/validation-reviews/shared-place/restore/route.ts", "utf8"));
  assert.ok(restoreRoute.includes("export async function POST(request: Request)"), "the route answers POST");
  assert.ok(!/export async function (GET|PUT|PATCH|DELETE)\b/.test(restoreRoute), "and nothing else");
  assert.ok(restoreRoute.includes("assertSameOriginMutation(request)"), "a mutation is same-origin only");
  assert.ok(
    restoreRoute.includes('await assertPermission(access, "phoenix_crm", "update")'),
    "and the server-side permission is the security boundary, never the screen",
  );
  const registry = readFileSync("src/lib/security/access-registry.ts", "utf8");
  assert.ok(
    registry.includes('pattern: "/api/phoenix-crm/validation-reviews/shared-place/restore"'),
    "the route is declared in the access registry — an undeclared one fails its own guard",
  );

  // The board has to SHOW a rejected venue before anybody can take the rejection back.
  assert.ok(
    venueServer.includes("`status.in.(active,held),and(status.eq.retired,retired_at.gte.${restorableSince()})`"),
    "🔴 the board reads rejected venues too, bounded to the ones still reversible — `status.in.(active,held)` alone is "
      + "why a rejection had no undo on the screen at all",
  );
  assert.ok(
    venueServer.includes('restorable: row.status === "retired" && text(row.retired_at) !== null'),
    "and each row says whether it can be brought back, the mirror of a review row's own flag",
  );
  assert.ok(
    venueList.includes("function RestoreVenue(") && venueList.includes("if (row.restorable) {"),
    "a rejected venue's row offers the one control it can take — never approve or reject beside it",
  );
  assert.equal(
    (venueList.match(/takes: \(row\) => !row\.restorable/g) ?? []).length,
    2,
    "approve and reject take only the rows they can still decide",
  );
  assert.ok(
    venueList.includes('key: "restore"') && venueList.includes("takes: (row) => row.restorable"),
    "and several rejections are taken back together, through the same bulk bar as every other answer",
  );
  assert.ok(
    dbRefusals.includes("shared_place_not_retired:"),
    "the refusal has words an admin can act on, not a code",
  );
  console.log("phoenix-crm shared places: OK");
}
