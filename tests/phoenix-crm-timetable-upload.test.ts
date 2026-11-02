import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { adviseOnHeldRow, adviseOnTimetable } from "../src/lib/phoenix-crm/place-check-advice.ts";
import { uploadedPhotoCanvasSize } from "../src/lib/phoenix-crm/place-photo-size.ts";
import {
  scheduleDoorAction,
  scheduleHoldRecord,
  scheduleUnjudged,
  scheduleUploadAllowed,
  type PhoenixCrmScheduleCheck,
} from "../src/lib/phoenix-crm/schedule-rules.ts";
import { parseSeatedPlaceDraft } from "../src/lib/phoenix-crm/shared-place-rules.ts";
import { stampBandFraction } from "../src/lib/phoenix-crm/signboard-rules.ts";
import { stripComments } from "./support/comment-strip.ts";

/**
 * The polyclinic timetable's LAST TRY MAY BE AN UPLOAD (owner, 2026-11-02: "make after 2 failed live
 * capture try the third i am able to upload and when upload the same location and timestamp as capture
 * also are put"; asked what a file naming the customer does, he chose "Validate it"; asked which photos,
 * he chose the timetable only).
 *
 * Each pin here would break silently: the camera-only rule protects every other capture, a file taken as
 * a pass on a lost call would be a validation nobody read, and a stamp over the picture's foot would cut
 * away the very names the rep uploaded it to show.
 */

function code(path: string): string {
  return stripComments(readFileSync(path, "utf8").replace(/\r\n/g, "\n"));
}

function filesUnder(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry);
    return statSync(path).isDirectory() ? filesUnder(path) : [path];
  });
}

function check(overrides: Partial<PhoenixCrmScheduleCheck>): PhoenixCrmScheduleCheck {
  return { ...scheduleUnjudged("unreadable"), ...overrides };
}

const UPLOADED = { uploaded: true };
const VENUE = { lat: 30, lon: 31, name: "Alma", sharedPlaceId: "venue-1" };

export function runPhoenixCrmTimetableUploadTests() {
  // ── 1 · When it opens: two refused photographs, on the server's count ─────────────────────────────
  assert.deepEqual([0, 1, 2, 3, Number.NaN].map(scheduleUploadAllowed), [false, false, true, true, false], "the third try and after, never sooner");

  const list = code("src/lib/phoenix-crm/server/list.ts");
  const scanner = list.slice(list.indexOf("async function scanSeatedTimetable("), list.indexOf("export type ValidateResult"));
  const gate = scanner.indexOf("if (!scheduleUploadAllowed(refused)) throw validationError(SCHEDULE_UPLOAD_TOO_EARLY, SCHEDULE_RETAKE_CODE)");
  assert.ok(gate > -1, "🔴 a phone that claims an upload before two refusals is refused and sent back to the camera");
  assert.ok(gate < scanner.indexOf("readPlaceSchedule("), "before the board is read, so a refused claim pays for no reading");
  assert.ok(scanner.includes("const uploaded = input.uploaded && !seatedPhoto.reused;"), "a board reused from file was not uploaded by this phone");
  assert.equal(list.split("uploaded: seated.photoUploaded,").length - 1, 2, "both seating paths hand the claim to the one scanner");

  const places = code("src/lib/phoenix-crm/server/shared-places.ts");
  const picker = places.slice(places.indexOf("export async function loadSharedPlacesFor("), places.indexOf("async function venueSignboard("));
  assert.ok(picker.includes("countTimetableRefusalsByVenue({ sharedPlaceIds: ids, repHrId: viewer.hrId, isTest })"), "the picker tells the phone THIS rep's count for each building");
  const recorder = code("src/lib/phoenix-crm/server/refused-readings.ts");
  const byVenue = recorder.slice(recorder.indexOf("export async function countTimetableRefusalsByVenue("), recorder.indexOf("export type SignboardRefusalInput"));
  for (const key of ['.eq("rep_hr_id", input.repHrId.toUpperCase())', '.eq("visit_date", cairoBusinessDay(', '.in("reason", ["timetable_unreadable", "timetable_missing"])', '.eq("is_test", input.isTest)']) {
    assert.ok(byVenue.includes(key), `the picker's count keys on what the door's count keys on: ${key}`);
  }

  // ── 2 · What the door does with a file ────────────────────────────────────────────────────────────
  assert.deepEqual(scheduleDoorAction(check({ verdict: "match", reason: null, legibility: "clear", ...UPLOADED }), 2), { kind: "save" }, "his choice: a file that names the customer validates");
  const unread = scheduleDoorAction(check({ reason: "call_failed", ...UPLOADED }), 2);
  assert.ok(unread.kind === "hold" && unread.heldBecause === "timetable_unreadable", "🔴 a file nobody read is held, never saved as if it passed");
  for (const reason of ["no_api_key", "no_bytes", "call_failed"] as const) {
    assert.deepEqual(scheduleDoorAction(check({ reason }), 2), { kind: "save" }, `a LIVE photo on ${reason} still saves, so a dead key stops nobody`);
    assert.equal(scheduleDoorAction(check({ reason, ...UPLOADED }), 2).kind, "hold", `an upload on ${reason} does not`);
  }
  const held = scheduleDoorAction(check({ reason: "unreadable", legibility: "unreadable", ...UPLOADED }), 2);
  assert.ok(held.kind === "hold" && held.heldBecause === "timetable_unreadable", "an unreadable file is the third failure: held, never a fourth try");
  const notOnIt = scheduleDoorAction(check({ verdict: "other_name", reason: "schedule_other_name", legibility: "clear", ...UPLOADED }), 2);
  assert.ok(notOnIt.kind === "hold" && notOnIt.heldBecause === "name_not_on_timetable", "a clear file without the name is held like a clear wall without it");
  const screen = scheduleDoorAction(check({ verdict: "no_schedule", reason: "schedule_missing", problem: "on_a_screen", ...UPLOADED }), 2);
  assert.ok(screen.kind === "hold" && screen.heldBecause === "timetable_on_a_screen", "his 2026-10-28 ruling stands: a picture of a screen is held for him");

  // ── 3 · The stamp goes under the picture, and the reader's crop takes only the stamp ──────────────
  for (const [width, height] of [[4000, 3000], [3000, 4000], [1920, 1080], [1080, 2400], [1280, 720], [720, 1280], [1920, 400], [800, 800], [640, 480], [300, 300]] as const) {
    const canvas = uploadedPhotoCanvasSize(width, height);
    const kept = Math.round(canvas.height * (1 - stampBandFraction(canvas.width, canvas.height)));
    assert.ok(kept >= canvas.imageHeight, `${width} x ${height}: the crop keeps ${kept} of the picture's ${canvas.imageHeight} rows, so no name at its foot is cut away`);
    assert.ok(canvas.height > canvas.imageHeight, `${width} x ${height}: there is room for the stamp under the picture`);
    assert.ok(Math.max(canvas.width, canvas.imageHeight) <= 1920, `${width} x ${height}: stored at the framed capture's size`);
  }

  const camera = code("src/components/phoenix-crm/live-photo-capture.tsx");
  const stamping = camera.slice(camera.indexOf("async function stampChosenFile("));
  assert.ok(stamping.includes("context.drawImage(image, 0, 0, size.width, size.imageHeight);"), "the file is drawn whole, above the stamp's room");
  assert.ok(stamping.includes("buildEvidenceStampLines({ capturedAt: stampedAt, locationCapturedAt: reading.at, locationLines: stamp.lines, title })"), "his words: the same location and timestamp as a capture, from the same helper");
  assert.ok(stamping.includes("drawStamp(context, canvas, "), "drawn by the same hand");
  assert.ok(stamping.includes("await readShutterFix()"), "read now, not taken from the file");
  assert.ok(stamping.indexOf("await readShutterFix()") < stamping.indexOf("stopLocation();\n    const freshReading"), "and before the watch stops, or the read would be empty");
  assert.ok(stamping.includes("laterReadingOverrules(running, freshReading, since)"), "a cold first reading never stamps a file either");
  assert.ok(/if \(!reading\) \{\s*stoppedWith\("Your location was not found/.test(stamping), "🔴 no reading, no photo: a file with no place on it never leaves the phone");
  assert.ok(stamping.includes("uploaded: true,"), "the file is marked, because its stamp cannot tell it from a capture");

  // ── 4 · The timetable's last try is the ONLY gallery door ─────────────────────────────────────────
  const offering = filesUnder("src").concat(filesUnder("app")).filter((path) => /\.tsx?$/.test(path) && readFileSync(path, "utf8").includes("uploadOffer="));
  assert.deepEqual(offering.map((path) => path.replace(/\\/g, "/")), ["src/components/phoenix-crm/shared-place-screens.tsx"], "his choice: the timetable only, so a signboard and a visit stay camera-only");
  const screens = code("src/components/phoenix-crm/shared-place-screens.tsx");
  assert.equal(screens.split("uploadOffer=").length - 1, 1, "one camera on that screen offers it");
  const offered = screens.indexOf("uploadOffer={scheduleUploadAllowed(chosen.timetableRefusedToday ?? 0) ? { note: SCHEDULE_UPLOAD_NOTE } : undefined}");
  assert.ok(offered > screens.indexOf("· Timetable photo"), "on the timetable's camera, not the building's signboard");
  assert.ok(screens.includes("photoUploaded: photo?.uploaded === true,"), "the save says so");
  assert.ok(screens.includes("if (value.timetableRetakes > 0) reloadVenues();"), "🔴 a refusal re-reads the count, or the third try would never see the button");
  assert.ok(code("src/components/phoenix-crm/list-screens.tsx").includes("timetableRetakes: current.timetableRetakes + 1"), "and the refusal is what moves it");
  assert.ok(/uploadOffer \? \(/.test(camera), "the file input is drawn only on offer");
  const input = camera.slice(camera.indexOf('accept="image/*"') - 20, camera.indexOf('type="file"'));
  assert.equal(input.includes("capture="), false, "no capture attribute, or the phone would open its camera instead of its files");

  // ── 5 · The body cannot claim an upload of nothing ────────────────────────────────────────────────
  const body = { sharedPlaceId: "11111111-1111-4111-8111-111111111111", timings: [{ weekday: 6, start: "10:00" }] };
  const withFile = parseSeatedPlaceDraft({ ...body, photoPath: "crm/timetables/a.jpg", photoUploaded: true });
  assert.ok(withFile.ok && withFile.value.photoUploaded === true, "a photo and the claim");
  const live = parseSeatedPlaceDraft({ ...body, photoPath: "crm/timetables/a.jpg" });
  assert.ok(live.ok && live.value.photoUploaded === false, "a capture says nothing and is read as live");
  const noFile = parseSeatedPlaceDraft({ ...body, photoPath: null, photoUploaded: true });
  assert.ok(noFile.ok && noFile.value.photoUploaded === false, "the claim without a photo means nothing");
  const loose = parseSeatedPlaceDraft({ ...body, photoPath: "crm/timetables/a.jpg", photoUploaded: "yes" });
  assert.ok(loose.ok && loose.value.photoUploaded === false, "only a real true");

  // ── 6 · Place checks is told, and only the deciders read it ───────────────────────────────────────
  const sentence = "This photo was uploaded from the phone, after two live photos could not be read.";
  const named = adviseOnTimetable({ verdict: "match", scheduleText: null, hoursRead: "10-2", uploaded: true });
  assert.equal(named.kind, "approve", "it names the customer, so the advice is still approve");
  assert.ok(named.reason.endsWith(sentence), "and says how the photo came");
  assert.equal(adviseOnTimetable({ verdict: "match", scheduleText: null, hoursRead: "10-2" }).reason.includes("uploaded"), false, "a capture never says it");
  const absent = adviseOnTimetable({ verdict: "other_name", scheduleText: "x", hoursRead: null, uploaded: true });
  assert.equal(absent.refusal, "schedule_other_name", "the mark changes no other part of the advice");
  const heldRow = adviseOnHeldRow({
    evidence: { checkReason: "call_failed", heldBecause: "timetable_unreadable", legibility: null, problem: null, signboard: null, uploaded: true },
    hoursRead: null,
    nearestListingMeters: null,
    photoKind: "schedule",
    reason: null,
    signText: null,
  });
  assert.ok(heldRow.reason.endsWith(sentence), "a held upload says it on the queue too");
  assert.equal(scheduleHoldRecord(check(UPLOADED), VENUE, { heldBecause: "timetable_unreadable", tries: 3 }).uploaded, true, "the review row keeps it");
  assert.equal(scheduleHoldRecord(check({}), VENUE).uploaded, false, "and a capture's says not");

  const reviews = code("src/lib/phoenix-crm/server/validation-reviews.ts");
  assert.ok(reviews.includes("uploaded: schedule && google.uploaded === true,"), "the queue reads it off the review row");
  assert.ok(reviews.includes("uploaded: check.uploaded === true,"), "and a validated place off its own reading");
  assert.ok(code("src/lib/phoenix-crm/shared-place-groups.ts").includes("...(row.evidence.uploaded ? { uploaded: true } : {}),"), "the building's board carries it");
  const reader = code("src/lib/phoenix-crm/server/schedule-check.ts");
  assert.ok(reader.includes("uploaded: check.uploaded === true,"), "🔴 a stored reading keeps the mark, or the next customer on the same board loses it");
  assert.ok(reader.includes("return board.uploaded ? { ...judged, uploaded: true } : judged;"), "and hands it to everybody judged against that reading");
}
