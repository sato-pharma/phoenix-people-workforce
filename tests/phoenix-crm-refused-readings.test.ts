import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import {
  PLACE_MAX_ACCURACY_METERS,
  VISIT_MAX_ACCURACY_METERS,
  parsePlaceDraft,
  parseVisitDraft,
  refusedReadingOf,
} from "../src/lib/phoenix-crm/entry-rules.ts";
import { parseBlockedPermissionReport } from "../src/lib/phoenix-crm/refused-readings-rules.ts";
import { stripComments, stripSqlComments } from "./support/comment-strip.ts";

// ─────────────────────────────────────────────────────────────────────────────
// A REFUSED Phoenix CRM capture now leaves its reading behind (owner, 2026-10-03: "record the refused
// readings so the next refusal is traceable").
//
// What it cost not to have it. On Sat 3 Oct 2026 one rep's phone was on Android's APPROXIMATE
// location and reported 30.4684684684685, 31.1899555209043 at exactly 2,000 m — the corner of a 2 km
// privacy square, identical to thirteen decimals across four Benha hospitals, two IP addresses and
// both capture mechanisms. The 100 m place line shipped at 11:24 Cairo, fourteen minutes after her
// last successful save, and from 16:12 to 18:47 she was refused eighteen times. Every one of those
// eighteen readings was DISCARDED: `phoenix_crm_location_integrity` is filed only after a save
// succeeds, no place or visit row is created, and the upload slot keeps only the fact that a slot was
// asked for. Her 2,000 m is knowable at all only because four captures were ACCEPTED that morning,
// before the line existed — and reconstructing it took the slots, the bytes in `storage.objects` and
// an off-line model of Android's grid.
//
// Two rules this must not break:
//   · THE REP LEARNS NOTHING NEW (Golden Rule #1). No message, screen or figure changes, and the
//     recorder is void and never throws — his refusal is identical with or without it.
//   · THE RECORD AND THE REFUSAL CANNOT DISAGREE. `refusedReadingOf` asks the DOORS' own predicates,
//     so a capture the doors accept records nothing and a capture they refuse records something.
// ─────────────────────────────────────────────────────────────────────────────

const CLINIC = { lat: 30.4657861755584, lon: 31.1863753029889 };
/** Android's 2 km blur, as this rep's phone actually reported it. */
const BLURRED = { lat: 30.4684684684685, lon: 31.1899555209043 };
const TIMINGS = [{ weekday: 6, start: "17:00", end: "21:00" }];
const DOCTOR = "0b6f7a52-3c1d-4e8f-9a2b-5c6d7e8f9a0b";

function placeBody(pin: number | null, photo: number | null | "none", at = CLINIC) {
  return {
    lat: at.lat,
    lon: at.lon,
    accuracyMeters: pin,
    photoPath: "seat/place.jpg",
    timings: TIMINGS,
    ...(photo === "none" ? {} : { shutterLat: at.lat, shutterLon: at.lon, shutterAccuracyMeters: photo }),
  };
}

/**
 * Every source file under one directory.
 *
 * `node_modules`, dot-directories and sibling worktrees are skipped — a recursive walk that does not
 * skip them pays this repo's ~346k path entries and takes tens of seconds.
 */
function walkSource(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry.startsWith(".") || entry.startsWith("_wt-")) continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walkSource(full, out);
    else if (full.endsWith(".ts") || full.endsWith(".tsx")) out.push(full);
  }
  return out;
}

function visitBody(accuracyMeters: number | null, extra: Record<string, unknown> = {}) {
  return {
    customerId: DOCTOR,
    kind: "single",
    products: ["Royanoxicam"],
    comment: "Discussed the new concentration.",
    lat: CLINIC.lat,
    lon: CLINIC.lon,
    accuracyMeters,
    ...extra,
  };
}

export function runPhoenixCrmRefusedReadingsTests() {
  // ── 1. The real refusal, recorded ─────────────────────────────────────────────
  // Her actual capture: both readings on the blur grid at 2,000 m.
  const hers = placeBody(2000, 2000, BLURRED);
  assert.equal(parsePlaceDraft(hers).ok, false, "a 2,000 m place is refused — the premise of everything below");
  const recorded = refusedReadingOf(hers, "place");
  assert.ok(recorded, "and its reading is recorded, which is the whole point");
  assert.equal(recorded.reason, "rough");
  assert.equal(recorded.accuracyMeters, 2000, "the number she could not read off her own screen");
  assert.equal(recorded.photoAccuracyMeters, 2000);
  assert.equal(recorded.lat, BLURRED.lat, "to every decimal — the grid proof lives in the last ones");
  assert.equal(recorded.lon, BLURRED.lon);
  assert.equal(recorded.maxAccuracyMeters, PLACE_MAX_ACCURACY_METERS, "the line it missed travels with the reading");

  // ── 2. A capture the doors ACCEPT records nothing ─────────────────────────────
  // The one state that must never produce a row: this table is evidence about refusals.
  for (const [pin, photo] of [
    [null, null],
    [12, 18],
    [PLACE_MAX_ACCURACY_METERS, PLACE_MAX_ACCURACY_METERS],
    [40, "none"],
  ] as const) {
    const body = placeBody(pin, photo);
    assert.equal(parsePlaceDraft(body).ok, true, `a place at ${String(pin)}/${String(photo)} is accepted`);
    assert.equal(refusedReadingOf(body, "place"), null, `so nothing is recorded about it (${String(pin)}/${String(photo)})`);
  }
  for (const accuracy of [null, 12, VISIT_MAX_ACCURACY_METERS]) {
    const body = visitBody(accuracy);
    assert.equal(parseVisitDraft(body).ok, true, `a visit at ${String(accuracy)} is accepted`);
    assert.equal(refusedReadingOf(body, "visit"), null, `so nothing is recorded about it (${String(accuracy)})`);
  }

  // ── 3. A refusal about something ELSE records nothing ─────────────────────────
  // A missing comment is not a location problem, and a table holding every mistyped form is a table
  // nobody reads. Each body below has a PERFECTLY GOOD reading and is still refused.
  for (const [what, body] of [
    ["no comment", visitBody(12, { comment: "   " })],
    ["no products", visitBody(12, { products: [] })],
    ["no customer", visitBody(12, { customerId: "not-a-uuid" })],
  ] as const) {
    assert.equal(parseVisitDraft(body).ok, false, `${what} is refused`);
    assert.equal(refusedReadingOf(body, "visit"), null, `${what} is not a refused READING, so nothing is filed`);
  }
  const noPhoto = { ...placeBody(12, 18), photoPath: "" };
  assert.equal(parsePlaceDraft(noPhoto).ok, false, "a place with no photo is refused");
  assert.equal(refusedReadingOf(noPhoto, "place"), null, "and files nothing: its location was fine");

  // ── 4. No usable coordinate at all ────────────────────────────────────────────
  // Permission off, or no position yet. There is no pin to store — but the accuracy the phone
  // claimed, its clock and the shutter's own pair may each still be readable, and each is worth
  // having: "the phone sent nothing at 16:12" is itself the answer to a support call.
  const blank = refusedReadingOf(
    {
      photoPath: "seat/place.jpg",
      timings: TIMINGS,
      accuracyMeters: 2000,
      deviceCapturedAt: "2026-10-03T15:12:00.000Z",
      deviceMocked: false,
      shutterLat: BLURRED.lat,
      shutterLon: BLURRED.lon,
      shutterAccuracyMeters: 2000,
    },
    "place",
  );
  assert.ok(blank, "a capture with no coordinate is still recorded");
  assert.equal(blank.reason, "no_fix");
  assert.equal(blank.lat, null, "there is no pin to store, and none is invented");
  assert.equal(blank.lon, null);
  assert.equal(blank.accuracyMeters, 2000, "the radius it claimed is kept — it is the only number there is");
  assert.equal(blank.photoAccuracyMeters, 2000, "and the shutter's own, read independently of the pin");
  assert.equal(blank.photoLat, BLURRED.lat);
  assert.equal(blank.deviceMocked, false, "false is a real answer; null would mean 'not asked'");
  assert.equal(blank.deviceCapturedAt, "2026-10-03T15:12:00.000Z");
  // 🔴 Number(null) is 0, which is finite: a missing reading once became a fix at 0°N 0°E and read as
  // impossible travel from the Gulf of Guinea. A blank is a blank here too.
  const empty = refusedReadingOf({ lat: "", lon: "", accuracyMeters: "" }, "visit");
  assert.ok(empty, "an empty body is a refusal with no reading");
  assert.equal(empty.reason, "no_fix");
  assert.deepEqual([empty.lat, empty.lon, empty.accuracyMeters], [null, null, null], "nothing is coerced to 0");

  // ── 5. Each door's own line, and only its own ─────────────────────────────────
  // A place is judged on the PIN alone since 2026-10-11 (owner, "A"); a visit on the pin, as the doors judge it.
  const roughPhotoOnly = placeBody(40, 2000);
  assert.equal(parsePlaceDraft(roughPhotoOnly).ok, true, "a sharp pin validates beside a blurred photo reading");
  assert.equal(refusedReadingOf(roughPhotoOnly, "place"), null, "so nothing is recorded about it");
  const roughPin = placeBody(2000, 40);
  assert.equal(parsePlaceDraft(roughPin).ok, false, "a rough pin is still refused");
  const pinCase = refusedReadingOf(roughPin, "place");
  assert.ok(pinCase, "and the record keeps both numbers");
  assert.equal(pinCase.accuracyMeters, 2000);
  assert.equal(pinCase.photoAccuracyMeters, 40);

  for (const accuracy of [VISIT_MAX_ACCURACY_METERS + 1, 1414, 2000]) {
    const body = visitBody(accuracy);
    assert.equal(parseVisitDraft(body).ok, false, `a visit at ${accuracy} m is refused`);
    const row = refusedReadingOf(body, "visit");
    assert.ok(row, `and recorded (${accuracy} m)`);
    assert.equal(row.accuracyMeters, accuracy);
    assert.equal(row.maxAccuracyMeters, VISIT_MAX_ACCURACY_METERS, "the visit's line, never the place's");
  }
  // A reading between the two lines is a REFUSED place and an ACCEPTED visit — the one case where the
  // subject argument decides the answer, and a swap would file a row about a visit nobody refused.
  const between = Math.round((PLACE_MAX_ACCURACY_METERS + VISIT_MAX_ACCURACY_METERS) / 2);
  assert.ok(refusedReadingOf(placeBody(between, "none"), "place"), `${between} m is a refused place`);
  assert.equal(refusedReadingOf(visitBody(between), "visit"), null, `${between} m is an accepted visit`);

  // ── 6. It restates no threshold ───────────────────────────────────────────────
  // The place's line is nine days old and has moved once. A classifier carrying its own copy could
  // disagree with the door that refused the capture, which is worse than having no record at all.
  const rules = stripComments(readFileSync("src/lib/phoenix-crm/entry-rules.ts", "utf8"));
  const classifier = /export function refusedReadingOf\(([\s\S]*?)\n}/.exec(rules);
  assert.ok(classifier, "refusedReadingOf is still in entry-rules.ts");
  assert.match(classifier[1], /placeReadingsPrecise\(fix\.value\)/, "a place is judged by the door's own predicate");
  assert.match(classifier[1], /withinAccuracy\(fix\.value\.accuracyMeters, VISIT_MAX_ACCURACY_METERS\)/, "and a visit by the door's own");
  // No comparison against a literal above zero. `accuracy >= 0` is allowed and is not a threshold —
  // it rejects a negative radius, which is nonsense from any phone; `> 100` or `> 500` would be a
  // second copy of a line that has already moved once.
  assert.doesNotMatch(classifier[1], /[<>]=?\s*[1-9]/, "it compares against no threshold of its own");
  for (const line of [String(PLACE_MAX_ACCURACY_METERS), String(VISIT_MAX_ACCURACY_METERS)]) {
    assert.ok(!new RegExp(`\\b${line}\\b`).test(classifier[1]), `and never spells ${line} out`);
  }

  // ── 7. The recorder cannot cost a rep his work ────────────────────────────────
  const recorder = readFileSync("src/lib/phoenix-crm/server/refused-readings.ts", "utf8");
  assert.match(recorder, /export async function recordRefusedReading\([\s\S]*?\): Promise<void> \{\n  try \{/, "it opens in a try and returns void — there is nothing for a caller to fail on");
  assert.match(recorder, /\} catch \(error\) \{/, "and every error it can produce is swallowed");
  const recorderCode = stripComments(recorder);
  assert.doesNotMatch(recorderCode, /\bthrow\b/, "it never throws: the rep is already being refused");
  assert.doesNotMatch(recorderCode, /validationError|forbiddenError/, "and it can change no refusal the rep reads");
  assert.ok(recorderCode.includes('.from("phoenix_crm_refused_readings")'), "it writes the module's own table");
  assert.ok(recorderCode.includes(".insert({"), "an INSERT, never an upsert — eighteen refusals are eighteen rows");
  assert.doesNotMatch(recorderCode, /\.(?:upsert|update|delete)\(/, "nothing here replaces or removes a refusal already filed");
  assert.ok(recorderCode.includes("visit_date: cairoBusinessDay(refusedAt)"), "the Cairo visit day, which ends at 02:00 — never the database's UTC day");

  // ── 8. Every door that refuses a reading files it, and files it BEFORE throwing ──
  // Awaited, unlike judgeCapture: a refusal is rare, the rep is waiting for his message anyway, and the
  // row is in before he can try again. A bare unawaited promise would have nobody to log its failure.
  // (The serverless reason first given here retired with the move to one long-lived Node process —
  // re-checked 2026-10-16.)
  for (const [file, doors] of [
    ["src/lib/phoenix-crm/server/list.ts", 2],
    ["src/lib/phoenix-crm/server/visits.ts", 1],
  ] as const) {
    const source = stripComments(readFileSync(file, "utf8"));
    // Indentation-agnostic since 2026-10-09: both of list.ts's doors sit one block deeper now (the
    // parse moved inside `if (!seated)`, because a customer seated in a shared place sends no
    // location to refuse). What is pinned is unchanged — the awaited call, then the throw, nothing
    // between them.
    const calls = [...source.matchAll(/await recordRefusedReading\(\{([\s\S]*?)\n\s*\}\);\n\s*throw validationError\(/g)];
    assert.equal(calls.length, doors, `${file}: all ${doors} refusing door(s) file the reading, awaited, before throwing`);
    for (const call of calls) {
      assert.match(call[1], /\n\s+subjectKind: "(?:place|visit)",/, `${file}: each call names which door refused it`);
      assert.match(call[1], /\n\s+repHrId: viewer\.hrId,/, `${file}: and whose phone it was`);
      assert.match(call[1], /\n\s+isTest,/, `${file}: a test-world refusal is filed as one`);
    }
    // The import may name the module's other entry points beside it (the off-listing refusal and its
    // count, added 2026-10-05); what this pins is that the WRITE comes from the shared module.
    assert.match(
      source,
      /import \{[^}]*\brecordRefusedReading\b[^}]*\} from "@\/lib\/phoenix-crm\/server\/refused-readings";/,
      `${file}: it is the shared recorder, never a second copy of the write`,
    );
    assert.equal(
      (source.match(/recordRefusedReading\(/g) ?? []).length,
      doors,
      `${file}: exactly ${doors} call(s) — an unawaited one anywhere else would be a write nobody waits for or logs`,
    );
  }

  // ── 9. Nothing a rep can open reads it ────────────────────────────────────────
  // The table is service-role only in SQL (tests/phoenix-crm-boundary.test.ts holds its four lock
  // statements); this is the other half — no rep-facing screen, payload or report names it. The ONE
  // reader is the SFE's board (server/refused-readings-board.ts), pinned by
  // tests/phoenix-crm-refused-readings-board.test.ts to the Super Admin and the SFE Manager.
  const migration = readFileSync("supabase/migrations/20261003211500_phoenix_crm_refused_readings.sql", "utf8");
  assert.match(migration, /create table if not exists public\.phoenix_crm_refused_readings \(/, "the table is created here");
  assert.match(migration, /drop table if exists public\.phoenix_crm_refused_readings;/, "with its rollback stated");
  // Stripped, because the comment explaining the absence necessarily names the thing that is absent.
  assert.doesNotMatch(
    stripSqlComments(migration),
    /\bunique\b/i,
    "and it is deliberately unkeyed — a constraint on any column here would collapse the retry history that IS the evidence",
  );

  // ── 10. A REFUSED CAPTURE KEEPS ITS PHOTO ─────────────────────────────────────
  // Owner, 2026-10-03: "save the photo when a validation is refused."
  //
  // Until 20261003224941 the refusal kept the photo's two COORDINATES and threw away the picture.
  // The JPEG was already in the bucket — the browser PUTs it to its slot before the save is even
  // attempted — but nothing pointed at it, so the one piece of evidence a PERSON can look at was
  // reachable only by hand-joining unused slots to storage.objects. That is precisely how both of
  // 3 October's incidents had to be reconstructed, hours after the reps were blocked.
  //
  // 🔴 NOTHING IS UPLOADED OR COPIED. This is a pointer being kept, not a file saved twice.
  assert.equal(recorded.photoPath, "seat/place.jpg", "her refused capture now carries the path of the photo she actually took");

  const noPhotoPath = refusedReadingOf({ ...placeBody(2000, 2000, BLURRED), photoPath: undefined }, "place");
  assert.ok(noPhotoPath, "a body with no path is still recorded — the reading matters with or without the picture");
  assert.equal(noPhotoPath.photoPath, null, "and the path is null rather than an empty string, so a query can ask `is not null`");
  assert.equal(
    refusedReadingOf({ ...placeBody(2000, 2000, BLURRED), photoPath: "   " }, "place")?.photoPath,
    null,
    "whitespace is no path either",
  );

  // The no-fix branch is a SEPARATE return in the classifier, and it is the one a rep with location
  // switched off actually hits — a photo taken and no coordinate at all is exactly the case where the
  // picture is the only evidence there is.
  const noFix = refusedReadingOf({ ...placeBody(null, "none"), lat: null, lon: null }, "place");
  assert.ok(noFix, "a capture with no usable coordinate is recorded");
  assert.equal(noFix.reason, "no_fix");
  assert.equal(noFix.photoPath, "seat/place.jpg", "🔴 and it keeps its photo too — both branches, or the branch that needs it most is the one that loses it");

  // A visit refused with no photo at all. Null here is correct and is not a lost path.
  const visitNoPhoto = refusedReadingOf(visitBody(900), "visit");
  assert.ok(visitNoPhoto, "a rough visit is recorded");
  assert.equal(visitNoPhoto.photoPath, null, "a visit with no photo has no path, which is not a gap");
  assert.equal(
    refusedReadingOf(visitBody(900, { photoPath: "seat/visit.jpg" }), "visit")?.photoPath,
    "seat/visit.jpg",
    "and a visit that DID carry one keeps it — the place door is not the only one that refuses",
  );

  // The bound, so a broken or hostile body cannot widen the column.
  assert.equal(
    refusedReadingOf({ ...placeBody(2000, 2000, BLURRED), photoPath: "x".repeat(400) }, "place")?.photoPath?.length,
    200,
    "a path is bounded at 200 characters, the same bound parseVisitDraft uses",
  );

  // The writer must actually SEND it. A classifier that resolves the path while the insert drops it
  // is the exact shape that makes a green suite prove nothing.
  assert.ok(recorderCode.includes("photo_path: reading.photoPath"), "the recorder writes the path onto the row");

  const photoColumn = readFileSync("supabase/migrations/20261003224941_phoenix_crm_refused_reading_photo.sql", "utf8");
  const photoSql = stripSqlComments(photoColumn);
  assert.match(photoSql.trim(), /^begin;/, "the column migration runs in one transaction");
  assert.match(photoSql.trim(), /commit;$/, "and commits at the very end");
  assert.match(photoSql, /add column if not exists photo_path text;/, "one nullable text column");
  // Scoped to the ALTER itself. The whole file legitimately contains "is not null" — the partial
  // index's predicate — and a file-wide check would read that as the column being NOT NULL.
  const alterStatement = /alter table public\.phoenix_crm_refused_readings[\s\S]*?;/.exec(photoSql);
  assert.ok(alterStatement, "the ALTER statement is still there to measure");
  assert.doesNotMatch(alterStatement[0], /\bnot null\b/i, "never NOT NULL — the rows already filed have no photo to backfill, and it would rewrite the table");
  assert.doesNotMatch(alterStatement[0], /\bdefault\b/i, "and no default, so this stays a metadata-only change that cannot block the writer mid-field-day");
  assert.equal((photoSql.match(/\balter table\b/gi) ?? []).length, 1, "and it alters one table, once");
  assert.doesNotMatch(photoSql, /create (?:or replace )?(?:function|view)|create table/i, "it adds no function, no view and no table");
  assert.match(photoColumn, /alter table public\.phoenix_crm_refused_readings drop column if exists photo_path;/, "with its rollback stated");
  // Deliberately NOT in tests/phoenix-crm-boundary.test.ts's LATER_MIGRATIONS: that list refuses an
  // entry that adds no function and no table, and this adds a column only — the same reason
  // 20261003174346 and 20261002205435 are absent from it.
  assert.doesNotMatch(
    readFileSync("tests/phoenix-crm-boundary.test.ts", "utf8"),
    /20261003224941/,
    "and it stays out of the boundary scan, which refuses a column-only migration by design",
  );

  // ── 11. 🔴 NOTHING IS EVER LOST — THE BYTES THE PATH POINTS AT ARE NEVER DELETED ──
  // Owner, 2026-10-03: "keep it in the database, do not lose anything."
  //
  // A path on a row is worth nothing if something can remove what it points at, and the reason it is
  // safe today is only that NO deleter exists: eleven other buckets in this app call
  // `storage.from(...).remove(...)`, and the Phoenix CRM photo bucket is called by none of them.
  // That is a fact nobody wrote down, so a future cleanup job could take the objects and leave this
  // column pointing at nothing — a silent loss, and exactly the failure the owner ruled against.
  //
  // So it is pinned here. If this assertion ever goes red, the fix is NOT to delete it: it is to make
  // the new sweep exempt every path named in `phoenix_crm_refused_readings.photo_path` and every slot
  // whose row it belongs to, and only then to narrow this check to that sweep by name.
  const BUCKET_NAMES = ["PHOENIX_CRM_PHOTO_BUCKET", '"phoenix-crm-photos"', "phoenix_crm_photo_uploads"];
  const deleters: string[] = [];
  for (const dir of ["src", "app", "scripts"]) {
    for (const file of walkSource(dir)) {
      const body = stripComments(readFileSync(file, "utf8"));
      if (!BUCKET_NAMES.some((name) => body.includes(name))) continue;
      for (const match of body.matchAll(/\.(remove|delete)\(|delete\s+from\s+public\.phoenix_crm_photo_uploads/gi)) {
        deleters.push(`${file.split(path.sep).join("/")}: ${match[0]}`);
      }
    }
  }
  assert.deepEqual(
    deleters,
    [],
    "🔴 something now deletes a Phoenix CRM photo or its upload slot, so a refusal's photo_path can start " +
      `pointing at nothing:\n  ${deleters.join("\n  ")}\n\n` +
      "The owner's rule is that a refused capture loses nothing. Exempt the paths named in " +
      "phoenix_crm_refused_readings.photo_path (and their slot rows) from that sweep before narrowing this check.",
  );

  // And the one statement a migration must never carry for the same reason.
  for (const file of readdirSync("supabase/migrations")) {
    if (!file.endsWith(".sql")) continue;
    const body = stripSqlComments(readFileSync(path.join("supabase", "migrations", file), "utf8"));
    assert.doesNotMatch(
      body,
      /delete\s+from\s+public\.phoenix_crm_photo_uploads|drop\s+table\s+(?:if\s+exists\s+)?public\.phoenix_crm_photo_uploads/i,
      `${file} removes photo upload slots — the refused captures' pictures are reached through them`,
    );
  }

  // ── 12. 🔴 A PERMISSION THE BROWSER BLOCKED IS FILED TOO — THE ONE REFUSAL THE SERVER NEVER SEES ──
  // Owner, 2026-10-13: "record a browser-blocked permission so it reaches the refused-readings board."
  //
  // Everything above this section begins with a reading that ARRIVED. When the browser blocks
  // location or the camera there is no reading, no request and no door — so there was no row, and the
  // board that exists to find a stuck rep could not see the commonest way to be stuck. Norhan Gamal's
  // iPhone answered PERMISSION_DENIED five times across 10 and 12 October 2026; this table held ZERO
  // rows for her seat, and the only trace anywhere was the touch trail (since retired), which kept the message only
  // if the rep happens to press it (42 location and 30 camera messages, four reps, 4-12 October).
  //
  // The two rules at the top of this file still hold, and the third is INVERTED on purpose: the rep
  // learns nothing new, nothing can cost him his work, and this one write is NOT awaited by the
  // browser — it has no request of its own to ride, so the browser posts it fire-and-forget. Since
  // 2026-10-16 (Phoenix CRM performance audit) the route does not wait for the insert either: the 204
  // goes first and the insert runs in an after-response task, pinned below.

  // The report off the wire: bounded, total, and it never says whose phone it was.
  assert.deepEqual(
    parseBlockedPermissionReport({ permission: "camera", subjectKind: "place", seatId: " seat-1 ", test: true }),
    { permission: "camera", subjectKind: "place", seatId: "seat-1", test: true },
    "a well-formed report parses, trimmed",
  );
  assert.equal(parseBlockedPermissionReport({ permission: "camera", subjectKind: "place" })?.test, false, "the test flag defaults to false rather than to whatever the body felt like");
  assert.equal(parseBlockedPermissionReport({ permission: "camera", subjectKind: "place" })?.seatId, null, "and a missing seat is null, never an empty string");
  assert.equal(parseBlockedPermissionReport({ permission: "microphone", subjectKind: "place" }), null, "a permission a capture cannot need is not a report");
  assert.equal(parseBlockedPermissionReport({ permission: "camera", subjectKind: "elsewhere" }), null, "nor a subject the table's own CHECK would refuse");
  assert.equal(parseBlockedPermissionReport({ permission: "camera" }), null, "nor one with no subject at all");
  assert.equal(parseBlockedPermissionReport(null), null);
  assert.equal(parseBlockedPermissionReport("camera"), null, "and a string is not a body");
  assert.equal(
    parseBlockedPermissionReport({ permission: "camera", subjectKind: "visit", seatId: "s".repeat(400) })?.seatId?.length,
    120,
    "the seat is bounded at 120 characters, so a hostile body cannot widen the column",
  );
  for (const key of ["repHrId", "rep_hr_id", "hrId"]) {
    const report = parseBlockedPermissionReport({ permission: "camera", subjectKind: "place", [key]: "B-999" }) as Record<string, unknown> | null;
    assert.ok(report && !(key in report), `🔴 a body can never name ${key} — the rep is the SESSION's, or this board is one anybody could write anybody onto`);
  }

  // The writer: the same shape as the two recorders above, and no reading at all.
  const blockedWriter = /export async function recordBlockedPermission\([\s\S]*?\n\}/.exec(recorder);
  assert.ok(blockedWriter, "the writer lives beside the other two, in the module's one server file");
  const blockedCode = stripComments(blockedWriter[0]);
  assert.match(blockedWriter[0], /export async function recordBlockedPermission\([\s\S]*?\): Promise<void> \{\n  try \{/, "it opens in a try and returns void");
  assert.doesNotMatch(blockedCode, /\bthrow\b/, "it never throws: the rep is already reading his message");
  assert.ok(blockedCode.includes('reason: "blocked"'), "the row says the browser blocked it");
  assert.ok(blockedCode.includes("blocked_permission: input.permission"), "and names WHICH permission — the column the pairing CHECK requires");
  assert.ok(blockedCode.includes("customer_id: null"), "🔴 and no customer: the same switch blocks every customer, so a row tied to one would read as a problem with that place");
  assert.ok(blockedCode.includes("rep_hr_id: input.repHrId.toUpperCase()"), "HR ids are mixed case in this database");
  assert.ok(blockedCode.includes("visit_date: cairoBusinessDay(refusedAt)"), "the Cairo visit day, which ends at 02:00");
  for (const reading of ["lat:", "lon:", "accuracy_meters:", "photo_path:", "device_captured_at:", "device_mocked:"]) {
    assert.ok(!blockedCode.includes(reading), `no ${reading} — there was no reading, and a 0 would read as a rep standing exactly on the pin`);
  }
  assert.doesNotMatch(blockedCode, /\.(?:upsert|update|delete)\(/, "it only ever inserts");
  const blockedAfterAt = blockedCode.indexOf('afterResponse("phoenix_crm_blocked_permission", async () => {');
  const blockedInsertAt = blockedCode.indexOf('.from("phoenix_crm_refused_readings").insert(row)');
  assert.ok(blockedAfterAt > 0 && blockedInsertAt > blockedAfterAt, "the insert runs after the 204, inside the after-response task");
  assert.ok(blockedCode.indexOf("visit_date: cairoBusinessDay(refusedAt)") < blockedAfterAt, "and the row is stamped when the report ARRIVED, before the task is handed off");

  // The route: always 204, the rep from the session, the body only able to ADD the test flag.
  const blockedRoute = stripComments(readFileSync("app/api/phoenix-crm/refused-readings/route.ts", "utf8"));
  assert.ok(blockedRoute.includes("assertSameOriginMutation(request)"), "CSRF first, before anything is read");
  assert.ok(blockedRoute.includes('assertPermission(access, "phoenix_crm", "read")'), "and the module's own read permission — the gate every Phoenix CRM read asks for");
  assert.ok(blockedRoute.includes("personKey(access.hrId)"), "🔴 the rep comes from the SESSION");
  assert.doesNotMatch(blockedRoute, /repHrId: report\.|report\.repHrId/, "and never from the body");
  assert.ok(blockedRoute.includes("Boolean(access.testPersona) || report.test"), "a test persona's blocked camera is a test row whatever the browser says");
  assert.ok(blockedRoute.includes("await request.text()"), "the body is read as TEXT, so a beacon from a closing page is readable too");
  assert.equal(
    (blockedRoute.match(/new NextResponse\(null, \{ status: 204 \}\)/g) ?? []).length,
    4,
    "🔴 every exit is a bare 204 — no count, no id, no error, nothing a rep could read to learn this table exists",
  );
  assert.doesNotMatch(blockedRoute, /NextResponse\.json|phoenixCrmFailure/, "and nothing here ever answers with a readable body");
  assert.match(
    readFileSync("src/lib/security/access-registry.ts", "utf8"),
    /pattern: "\/api\/phoenix-crm\/refused-readings", permission: \{ resource: "phoenix_crm", action: "read" \}, guard: "assert-permission", csrfRequired: true/,
    "the route is in the access registry, with its guard and its CSRF requirement stated there as well",
  );

  // The two screens that raise these messages now report them — AFTER the message, never awaited.
  const reporter = stripComments(readFileSync("src/components/phoenix-crm/report-blocked-permission.ts", "utf8"));
  assert.ok(reporter.includes('"/api/phoenix-crm/refused-readings"'), "the reporter posts to the module's own route");
  assert.ok(reporter.includes("keepalive: true"), "with keepalive — the commonest moment to be blocked is the moment a rep gives up and leaves the screen");
  assert.doesNotMatch(reporter, /\bawait\b|\basync\b/, "🔴 nothing is awaited: a rep must never wait on evidence");
  assert.doesNotMatch(reporter, /setError|setBusy|setState|throw /, "and it touches no message and no state of the screen that called it");
  assert.equal((reporter.match(/catch/g) ?? []).length, 2, "both the call and the failed request are swallowed");

  for (const [file, permissions] of [
    ["src/components/phoenix-crm/capture-location.tsx", ["location"]],
    ["src/components/phoenix-crm/live-photo-capture.tsx", ["location", "camera"]],
  ] as const) {
    const screen = readFileSync(file, "utf8");
    const code = stripComments(screen);
    for (const permission of permissions) {
      assert.match(
        code,
        new RegExp(`reportBlockedPermission\\(\\{ permission: "${permission}"`),
        `${file}: a blocked ${permission} is reported`,
      );
    }
    assert.equal(
      (code.match(/reportBlockedPermission\(/g) ?? []).length,
      permissions.length,
      `${file}: exactly ${permissions.length} report(s) — one per permission this screen can be blocked on`,
    );
    assert.doesNotMatch(code, /await reportBlockedPermission|reportBlockedPermission\([\s\S]{0,200}?\)\.then/, `${file}: never awaited and never chained`);
    // 🔴 THE REP LEARNS NOTHING NEW (golden rule #1). The message is set first and is byte-for-byte
    // the one that was on the glass before any of this existed — the report comes after it.
    const order = /setError\([\s\S]*?reportBlockedPermission\(/.test(code);
    assert.ok(order, `${file}: the message is set BEFORE the report, so nothing the rep reads waits on a row`);
    assert.match(screen, /Allow (?:location|the camera) for this site in its settings/, `${file}: and that message still says exactly what it said`);
    assert.ok(screen.includes("BROWSER_PLACEHOLDER"), `${file}: still naming his own browser, which is what made it findable`);
  }

  // The migration that makes the row possible at all.
  const blockedMigration = readFileSync("supabase/migrations/20261013163001_refused_readings_blocked_permission.sql", "utf8");
  const blockedSql = stripSqlComments(blockedMigration);
  assert.match(blockedSql.trim(), /^begin;/, "it runs in one transaction");
  assert.match(blockedSql.trim(), /commit;$/, "and commits at the very end");
  assert.match(blockedSql, /add column if not exists blocked_permission text;/, "one nullable text column");
  const blockedAlter = /alter table public\.phoenix_crm_refused_readings\s+add column[\s\S]*?;/.exec(blockedSql);
  assert.ok(blockedAlter, "the ALTER that adds it is still there to measure");
  assert.doesNotMatch(blockedAlter[0], /\bnot null\b/i, "never NOT NULL — every row already filed is a server refusal with no permission to backfill");
  assert.doesNotMatch(blockedAlter[0], /\bdefault\b/i, "and no default, so it stays a metadata-only change that cannot block the writer mid-field-day");
  assert.match(blockedSql, /check \(reason = any \(array\['no_fix'::text, 'rough'::text, 'off_listing'::text, 'blocked'::text\]\)\)/, "the reason CHECK is widened to four, in one place");
  // 🔴 THE PAIRING CHECK NEEDS `is not null` EXPLICITLY. `blocked_permission = any (array[...])`
  // against a null evaluates to NULL, and a CHECK refuses only FALSE — so without it a 'blocked' row
  // naming no permission is ACCEPTED. Measured on staging 2026-10-13, before the guard existed: it
  // inserted cleanly, which is the one state the board cannot print.
  assert.match(
    blockedSql,
    /when reason = 'blocked' then blocked_permission is not null\s*\n?\s*and blocked_permission = any \(array\['location'::text, 'camera'::text\]\)/,
    "🔴 the pairing CHECK asks `is not null` FIRST — a null would otherwise satisfy it and a 'blocked' row with no permission would be stored",
  );
  assert.match(blockedSql, /else blocked_permission is null/, "and no other reason may carry a permission");
  assert.match(blockedMigration, /drop column blocked_permission;/, "with its rollback stated");
  assert.doesNotMatch(blockedSql, /create (?:or replace )?(?:function|view)|create table|drop table|truncate/i, "it adds no function, no view and no table, and removes nothing");
}
