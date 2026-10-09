import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  countSharedPlaceDays,
  parseSeatedPlaceDraft,
  parseSharedPlaceDraft,
  parseSharedPlaceKind,
  SEATED_PLACE_NO_PHOTO,
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
import { reasonsFor } from "../src/lib/phoenix-crm/validation-feedback.ts";
import {
  matchesSharedPlaceFilters,
  sharedPlacePassesOutcome,
  EMPTY_VALIDATION_REVIEW_FILTERS,
} from "../src/lib/phoenix-crm/validation-review-filters.ts";
import { stripComments } from "./support/comment-strip.ts";

/**
 * Phoenix CRM — a polyclinic validated ONCE, with its doctors seated inside it (owner, 2026-10-09 in
 * chat, Arabic): validate the polyclinic once, then register each doctor's times in it, at most three
 * a day; he uploads the timetable photo at each one; the location is taken once, so there is no
 * location when seating; and the administrator reviews the schedule afterwards.
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
  assert.equal(roughShutter.ok, false, "and neither is a rough shutter reading — both halves are held to the line");

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

  const seatedNoPhoto = parseSeatedPlaceDraft({
    sharedPlaceId: "3f4a1b2c-5d6e-4f70-8a9b-0c1d2e3f4a5b",
    timings: [{ weekday: 6, start: "10:00" }],
  });
  assert.equal(seatedNoPhoto.ok === false ? seatedNoPhoto.error : null, SEATED_PLACE_NO_PHOTO, "the timetable photo is required");

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
      ["label", "photoPath", "sharedPlaceId", "timings"],
      "🔴 FOUR KEYS, NO FIX — a seated draft cannot carry a location even when the body sends one",
    );
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

  console.log("phoenix-crm shared places: OK");
}
