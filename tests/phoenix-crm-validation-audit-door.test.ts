import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { SCHEDULE_MAX_TRIES, scheduleDoorAction, scheduleUnjudged } from "../src/lib/phoenix-crm/schedule-rules.ts";
import {
  heldSignboardOutcome,
  SIGNBOARD_HELD_MAX_READS,
  SIGNBOARD_RETAKE_AWAY_FROM_PLACE,
  signboardAfterSecondReading,
  signboardHoldStillReading,
  signboardNextAttempt,
  signboardReadsRecorded,
  signboardRetakeCheckToKeep,
  signboardRetakeRequest,
  signboardUnjudged,
  type PhoenixCrmSignboardCheck,
} from "../src/lib/phoenix-crm/signboard-rules.ts";
import { stripComments } from "./support/comment-strip.ts";

/**
 * Phoenix CRM validation audit, 14 Nov 2026 — the four findings at the rep's own doors.
 *
 *   1. A signboard RETAKE filed a flag on the Super Admin's board on ONE reading, against the module's
 *      rule that two readings must agree before anybody is named there.
 *   2. The retake's refusal told the rep his own distance from the place, in metres (Golden Rule #1).
 *   3. A retaken photo inherited the OLD photo's read count, so on a held place whose reads were spent
 *      nothing ever read the new photo again while the rep was told the system was checking it.
 *   4. A timetable try was spent on a photograph the rep did not take: the building's board on file was
 *      filed as his try 1 of 3, and one photo sent twice was counted twice.
 *
 * Each block fails by itself when its fix is taken back.
 */

const ROOT = new URL("../", import.meta.url);

function code(path: string): string {
  return stripComments(readFileSync(new URL(path, ROOT), "utf8").replace(/\r\n/g, "\n"));
}

function sign(overrides: Partial<PhoenixCrmSignboardCheck>): PhoenixCrmSignboardCheck {
  return { ...signboardUnjudged("unreadable"), ...overrides };
}

const OTHER = sign({ verdict: "other_name", reason: "sign_other_name", signText: "د. محمود حسن", personNames: ["د. محمود حسن"], note: "a clear plate" });
const NO_NAME = sign({ verdict: "no_name", reason: "sign_no_name", signText: "مركز الشفاء", placeNames: ["مركز الشفاء"] });
const MATCH = sign({ verdict: "match", reason: null, signText: "د. احمد سمير", personNames: ["د. احمد سمير"] });

export async function runPhoenixCrmValidationAuditDoorTests(): Promise<void> {
  const list = code("src/lib/phoenix-crm/server/list.ts");
  const retake = list.slice(list.indexOf("export async function retakePlaceSignboard("), list.indexOf("export async function updatePlace("));
  assert.ok(retake.length > 500, "the retake door is where this test expects it");

  // ── 1 · A retake's flag needs two readings that agree ─────────────────────────────────────────────
  {
    const agreed = signboardAfterSecondReading(OTHER, { ...OTHER, signText: "دكتور محمود حسن" });
    assert.equal(agreed.verdict, "other_name", "two readings that name another person: the flag stands");
    assert.equal(agreed.signText, OTHER.signText, "and the reading already kept on the place is the evidence");

    for (const second of [MATCH, sign({}), sign({ reason: "call_failed" }), NO_NAME]) {
      const apart = signboardAfterSecondReading(OTHER, second);
      assert.equal(apart.verdict, "unjudged", `🔴 a second reading of ${second.verdict}/${second.reason} files nothing`);
      assert.equal(apart.reason, "unconfirmed", "it is kept as two readings that disagreed, which the night reads again");
      assert.equal(apart.signText, OTHER.signText, "keeping the first reading's text");
      assert.deepEqual(apart.personNames, OTHER.personNames, "and the names it read");
    }
    assert.equal(signboardAfterSecondReading(NO_NAME, NO_NAME).verdict, "no_name", "no name twice stands as read");
    assert.equal(signboardAfterSecondReading(NO_NAME, OTHER).reason, "unconfirmed", "no name once is not a verdict either");
    assert.equal(signboardAfterSecondReading(MATCH, OTHER), MATCH, "a match names nobody on the board and is never second-guessed");
    const unread = sign({});
    assert.equal(signboardAfterSecondReading(unread, OTHER), unread, "nor is a reading that judged nothing");

    const settle = retake.slice(retake.indexOf('afterResponse("phoenix-crm signboard retake: settle"'));
    const filed = settle.indexOf("await filePlaceSignboardFlag(");
    const secondRead = settle.indexOf("await readStoredPlaceSignboard(");
    assert.ok(filed > -1, "the retake still files another clear name for the Super Admin");
    assert.ok(secondRead > -1 && secondRead < filed, "🔴 the photo is read a second time BEFORE anything is filed — never on one reading");
    assert.equal(retake.split("readStoredPlaceSignboard(").length - 1, 1, "one extra read, never more");
    assert.equal(retake.indexOf("readStoredPlaceSignboard("), retake.indexOf("readStoredPlaceSignboard(", retake.indexOf("afterResponse(")), "and it runs after the reply, so the rep waits for none of it");
    assert.ok(settle.includes("const settled = signboardAfterSecondReading(kept, second);"), "the two readings are held against each other by the one rule");
    assert.ok(
      /if \(settled\.verdict !== "other_name"\) \{\s*await recordPlaceSignboard\(placeId, settled\);\s*return;\s*\}\s*await filePlaceSignboardFlag\(/.test(settle),
      "🔴 on disagreement the place is recorded unconfirmed and the door leaves without filing",
    );
  }

  // ── 2 · The retake refusal never tells the rep his distance ───────────────────────────────────────
  {
    assert.doesNotMatch(SIGNBOARD_RETAKE_AWAY_FROM_PLACE, /\d/, "🔴 no number: neither his metres nor the line");
    assert.doesNotMatch(SIGNBOARD_RETAKE_AWAY_FROM_PLACE, /\b(m|km|metres?|meters?|distance|far|away|within|radius|GPS)\b/i, "and no word that measures where he stands");
    assert.doesNotMatch(SIGNBOARD_RETAKE_AWAY_FROM_PLACE, /\bdoctors?\b|\baccounts?\b/i, "rep-facing words say customer — tests/phoenix-crm-am-pm-words.test.ts");
    assert.doesNotMatch(SIGNBOARD_RETAKE_AWAY_FROM_PLACE, /\.\.\.|…/, "never an ellipsis");
    assert.match(SIGNBOARD_RETAKE_AWAY_FROM_PLACE, /only at the customer's place/, "it says where the photo must be taken");
    assert.match(SIGNBOARD_RETAKE_AWAY_FROM_PLACE, /wait a moment for the location to settle/, "and gives the honest rep at the door his way out");

    assert.ok(
      /if \(!signboardRetakeIsAtThePlace\([^\n]*\{\s*throw validationError\(SIGNBOARD_RETAKE_AWAY_FROM_PLACE\);\s*\}/.test(retake),
      "🔴 the door raises the fixed sentence, with the same code as before: none",
    );
    for (const throwing of retake.match(/validationError\(`[^`]*`/g) ?? []) {
      assert.doesNotMatch(throwing, /\$\{[^}]*(away|accuracy|distance|meters|metres)/i, `no refusal here prints a measurement: ${throwing}`);
    }
  }

  // ── 3 · A retaken photo starts its own read count ─────────────────────────────────────────────────
  {
    const spentAndSentBack = { ...sign({ reason: "unreadable_final" }), attempts: SIGNBOARD_HELD_MAX_READS + 1, retake: signboardRetakeRequest(sign({})) };
    // What the door did before: the new photo's read counted on top of the old photo's.
    const carried = signboardNextAttempt({ ...OTHER, retake: null }, signboardReadsRecorded(spentAndSentBack));
    assert.ok(signboardReadsRecorded(carried) >= SIGNBOARD_HELD_MAX_READS, "the defect: carried forward, the new photo is past the hourly re-read");
    assert.ok(signboardNextAttempt(OTHER, 0).attempts >= SIGNBOARD_HELD_MAX_READS, "and the older rule cannot start a count at one, so the retake has its own");

    for (const read of [OTHER, NO_NAME, MATCH, sign({}), sign({ reason: "call_failed" }), { ...sign({}), attempts: 7 }]) {
      const kept = signboardRetakeCheckToKeep(read);
      assert.equal(kept.attempts, 1, `🔴 ${read.verdict}/${read.reason}: the new photo has had one read — the door's`);
      assert.equal(kept.retake, null, "and the request for a photo is answered");
      assert.ok(signboardReadsRecorded(kept) < SIGNBOARD_HELD_MAX_READS, "so the hourly re-read of held places still takes it");
    }
    const kept = signboardRetakeCheckToKeep(OTHER);
    assert.equal(signboardHoldStillReading({ isTest: false, pending: true, signboardHold: true, stored: kept }), true, "a held place reads as still being checked, which is now true");
    assert.equal(heldSignboardOutcome(OTHER, signboardReadsRecorded(kept) + 1), "done", "and after its one re-read it is the Super Admin's, exactly as a place held at the door");
    assert.equal(heldSignboardOutcome(MATCH, signboardReadsRecorded(kept) + 1), "approve", "or approved by the system when that re-read names the customer");

    // The strong reader's "unreadable" is final at once — for the NEW photo, on its own answer.
    assert.equal(signboardRetakeCheckToKeep(sign({ strongRead: true })).reason, "unreadable_final", "🔴 the strong reader's unreadable is final for this photo");
    assert.equal(signboardRetakeCheckToKeep(sign({})).reason, "unreadable", "a fallback's answer keeps the new photo its tries");
    assert.equal(signboardRetakeCheckToKeep(sign({ reason: "call_failed", strongRead: true })).reason, "call_failed", "a lost call is never final");
    assert.equal(signboardRetakeCheckToKeep(MATCH).reason, null);

    assert.ok(retake.includes("const kept = signboardRetakeCheckToKeep(check);"), "🔴 the door keeps the new photo's own count");
    assert.ok(retake.includes("signboard_check: jsonbSafe(kept),"), "and that is what is written on the place");
    assert.equal(retake.includes("signboardReadsRecorded(row.signboard_check)"), false, "never the old photo's count carried forward");
  }

  // ── 4 · A timetable try is a photograph the rep took, counted once ────────────────────────────────
  {
    const scanner = list.slice(list.indexOf("async function scanSeatedTimetable("), list.indexOf("export type ValidateResult"));
    const refusing = scanner.slice(scanner.indexOf('if (action.kind === "retake") {'), scanner.indexOf('if (action.kind === "hold") {'));
    const onFile = refusing.indexOf("if (seatedPhoto.reused) throw validationError(timetableRetakeWordsForBoardOnFile(action), SCHEDULE_RETAKE_CODE);");
    const filed = refusing.indexOf("await recordTimetableRefusal(");
    assert.ok(onFile > -1, "🔴 the building's board on file is still refused with the retake code, so the camera opens");
    assert.ok(filed > -1 && onFile < filed, "🔴 and it leaves BEFORE the refusal is filed: no row, no try, for a photograph he did not take");
    assert.ok(refusing.indexOf("throw validationError(action.message, SCHEDULE_RETAKE_CODE)") > filed, "his own photograph is still filed first, then refused");

    // The words: with the board on file not counted, the try named is his own next one.
    const wording = list.slice(list.indexOf("function timetableRetakeWordsForBoardOnFile("), list.indexOf("async function scanSeatedTimetable("));
    assert.ok(
      wording.includes("action.message.replace(/ Try \\d+ of \\d+\\.$/, ` Try ${Math.max(1, action.nextTry - 1)} of ${SCHEDULE_MAX_TRIES}.`)"),
      "the try in the sentence is one lower than the counted refusal would have said",
    );
    const unreadable = { ...scheduleUnjudged("unreadable"), legibility: "unreadable" as const, problem: "too_far" as const };
    for (const earlier of [0, 1]) {
      const action = scheduleDoorAction(unreadable, earlier);
      if (action.kind !== "retake") throw new Error("an unreadable board asks for a photograph");
      assert.match(action.message, / Try \d+ of \d+\.$/, "🔴 the sentence still ends on the try, or the rewrite above changes nothing");
      const words = action.message.replace(/ Try \d+ of \d+\.$/, ` Try ${Math.max(1, action.nextTry - 1)} of ${SCHEDULE_MAX_TRIES}.`);
      assert.ok(words.endsWith(` Try ${earlier + 1} of ${SCHEDULE_MAX_TRIES}.`), `with ${earlier} refused today his next photograph is try ${earlier + 1}`);
      assert.equal(words.split(" Try ").length - 1, 1, "and the try is said once");
    }

    // One photo sent twice is one try.
    const recorder = code("src/lib/phoenix-crm/server/refused-readings.ts");
    const record = recorder.slice(recorder.indexOf("export async function recordTimetableRefusal("), recorder.indexOf("export async function countTimetableRefusals("));
    const insert = record.indexOf(".insert({");
    const repeat = record.indexOf('.eq("photo_path", input.photoPath)');
    assert.ok(insert > -1, "the refusal is still an insert");
    assert.ok(repeat > -1 && repeat < insert, "🔴 the same photograph is looked for BEFORE a second row is written");
    const lookup = record.slice(0, insert);
    for (const key of [
      '.eq("shared_place_id", input.sharedPlaceId)',
      '.eq("rep_hr_id", input.repHrId.toUpperCase())',
      '.eq("visit_date", cairoBusinessDay(refusedAt))',
      '.in("reason", ["timetable_unreadable", "timetable_missing"])',
      '.eq("is_test", input.isTest)',
    ]) {
      assert.ok(lookup.includes(key), `a repeat is the same building, rep, Cairo visit day and world: ${key}`);
    }
    assert.ok(lookup.includes("if (already && already.id) return String(already.id);"), "the row already filed answers for the repeat, and nothing is inserted");
    assert.ok(lookup.includes("if (input.photoPath) {"), "a refusal with no photo to compare is filed as before");
    assert.doesNotMatch(record, /\bthrow\b/, "and the recorder still never throws: the rep is already being refused");
    assert.ok(record.includes("} catch (error) {"), "every error it can produce is swallowed");
  }
}
