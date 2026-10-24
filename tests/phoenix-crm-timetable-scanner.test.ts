import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  judgeSchedule,
  SCHEDULE_HELD_TEXT,
  SCHEDULE_MAX_TRIES,
  SCHEDULE_RETAKE_CODE,
  scheduleDoorAction,
  scheduleHeldText,
  scheduleHoldRecord,
  scheduleUnjudged,
  type PhoenixCrmScheduleCheck,
} from "../src/lib/phoenix-crm/schedule-rules.ts";
import { stripComments, stripSqlComments } from "./support/comment-strip.ts";

/**
 * The polyclinic timetable SCANNER (owner, 2026-10-17, in chat).
 *
 * His words: the timetable photo must be read on the spot "like a scanner" — never accepted and called
 * unreadable afterwards ("I already did the validation") — and must not block the rep endlessly: "3
 * tries then held to confirmation by admin". A readable board that does not carry the name: "save but
 * hold to me and tell the rep that the dr name is not in the timetable so held for admin approval".
 *
 * Measured that morning on production: 0 of 70 seated customers passed the read; 45 unreadable photos
 * had been let through as if they matched, and 22 showed a street, a pavement or a floor.
 *
 * Every rule here is one that would break silently: a scanner that refuses on a lost model call stops
 * the field the day the key lapses, and one that never reaches the third-try hold blocks a rep for ever.
 */

const ROOT = new URL("../", import.meta.url);

function read(path: string): string {
  return readFileSync(new URL(path, ROOT), "utf8").replace(/\r\n/g, "\n");
}

function check(overrides: Partial<PhoenixCrmScheduleCheck>): PhoenixCrmScheduleCheck {
  return { ...scheduleUnjudged("unreadable"), ...overrides };
}

const MATCH = check({ verdict: "match", reason: null, legibility: "clear" });
const OTHER = check({ verdict: "other_name", reason: "schedule_other_name", legibility: "clear", personNames: ["سارة احمد"] });
const MISSING = check({ verdict: "no_schedule", reason: "schedule_missing", problem: "not_a_timetable" });
const UNREADABLE = check({ verdict: "unjudged", reason: "unreadable", legibility: "unreadable", problem: "too_far" });

export function runPhoenixCrmTimetableScannerTests() {
  // ── 1 · The door's ruling, every verdict × every try ─────────────────────────────────────────────
  assert.equal(SCHEDULE_MAX_TRIES, 3, "his number: three photographs, then the seating is held");
  for (const tries of [0, 1, 2, 5]) {
    assert.deepEqual(scheduleDoorAction(MATCH, tries), { kind: "save" }, `a board that names him saves, try ${tries + 1}`);
    const other = scheduleDoorAction(OTHER, tries);
    assert.equal(other.kind, "hold", "a READABLE board without his name is saved and HELD at once — never a retake (his ruling)");
    assert.equal(other.kind === "hold" && other.heldBecause, "name_not_on_timetable");
  }

  for (const [label, reading, reason] of [
    ["no timetable in the photo", MISSING, "timetable_missing"],
    ["a timetable that cannot be read", UNREADABLE, "timetable_unreadable"],
  ] as const) {
    const first = scheduleDoorAction(reading, 0);
    assert.equal(first.kind, "retake", `${label}: the first photograph is refused at the door, not accepted`);
    assert.ok(first.kind === "retake" && first.reason === reason, `${label}: counted under ${reason}`);
    assert.ok(first.kind === "retake" && /Try 2 of 3\.$/.test(first.message), `${label}: the rep is told which try comes next`);
    const second = scheduleDoorAction(reading, 1);
    assert.ok(second.kind === "retake" && /Try 3 of 3\.$/.test(second.message), `${label}: the second refusal says try 3 of 3`);
    const third = scheduleDoorAction(reading, 2);
    assert.equal(third.kind, "hold", `🔴 ${label}: the THIRD failure is saved and held — never a fourth refusal, never accepted`);
    assert.ok(third.kind === "hold" && third.heldBecause === reason && third.tries === 3, `${label}: held as ${reason}, on try 3`);
    assert.equal(scheduleDoorAction(reading, 9).kind, "hold", `${label}: a rep past his tries today is held at once, not asked a fourth time`);
  }

  // 🔴 ONLY A READER THAT ANSWERED MAY ASK FOR A RETAKE. The key has run dry silently twice; refusing
  // on the absence of an answer would stop every seating in the field that day.
  for (const reason of ["no_api_key", "call_failed", "no_bytes", "held_elsewhere"] as const) {
    for (const tries of [0, 2]) {
      assert.deepEqual(scheduleDoorAction(scheduleUnjudged(reason), tries), { kind: "save" }, `${reason} saves as before — never refused, never held`);
    }
  }
  assert.equal(scheduleDoorAction(UNREADABLE, Number.NaN).kind, "retake", "a count the door could not read is zero tries, never a hold");

  // The words he reads say what to fix, and never the word the module bans.
  const advice = [MISSING, UNREADABLE, check({ problem: "blurred" }), check({ problem: "glare" }), check({ problem: "cut_off" }), check({ personNames: ["x"] })].map(
    (reading) => {
      const action = scheduleDoorAction(reading, 0);
      assert.equal(action.kind, "retake");
      return action.kind === "retake" ? action.message : "";
    },
  );
  assert.equal(new Set(advice).size, advice.length, "each problem gets its own advice");
  assert.match(advice[0]!, /does not show the building's timetable/, "a street or a floor is told plainly it is not the timetable");
  for (const text of [...advice, ...Object.values(SCHEDULE_HELD_TEXT)]) {
    assert.doesNotMatch(text, /\bdoctors?\b|\baccounts?\b/i, "rep-facing words say customer — tests/phoenix-crm-am-pm-words.test.ts");
  }
  assert.equal(scheduleHeldText("name_not_on_timetable"), "The customer's name is not on the timetable, so it is held for admin approval.", "his sentence");
  assert.equal(scheduleHeldText("nonsense"), null);
  assert.equal(scheduleHeldText(null), null, "no reason, no sentence — every other hold still reads as the system checking");

  // ── 2 · "Not on it" is said only of a board the reader could see all of ───────────────────────────
  const base = { customerName: "سارة محمود", schedulePresent: true, scheduleText: "د/ احمد علي", personNames: ["احمد علي"], hoursRead: null, note: null, croppedFraction: 0.18 };
  assert.equal(judgeSchedule({ ...base, legibility: "clear" }).verdict, "other_name", "a clear board without him: other_name");
  assert.equal(judgeSchedule({ ...base }).verdict, "other_name", "an older caller that never said keeps the old verdict");
  const partial = judgeSchedule({ ...base, legibility: "partial" });
  assert.equal(partial.verdict, "unjudged", "🔴 a board read only in part may have hidden exactly his name: a photo to retake, not a customer to hold");
  assert.equal(partial.reason, "unreadable");
  assert.equal(judgeSchedule({ ...base, personNames: ["سارة محمود"], scheduleText: "سارة محمود", legibility: "partial" }).verdict, "match", "a reading that names him matches however much else was legible");
  const street = judgeSchedule({ ...base, schedulePresent: null, scheduleText: null, personNames: [], problem: "not_a_timetable" });
  assert.equal(street.verdict, "no_schedule", "the reader's own 'not a timetable' with nothing read is no_schedule");
  assert.equal(judgeSchedule({ ...base, schedulePresent: null, scheduleText: null, personNames: [] }).verdict, "unjudged", "an unsure reader with nothing read is unreadable, not missing");
  // 🔴 A TIMETABLE PHOTOGRAPHED OFF A SCREEN IS REFUSED AT THE DOOR, HIS NAME ON IT OR NOT (owner, 2026-10-19).
  const offAScreen = judgeSchedule({ ...base, personNames: ["سارة محمود"], scheduleText: "سارة محمود", legibility: "clear", problem: "on_a_screen" });
  assert.equal(offAScreen.verdict, "no_schedule", "🔴 a Facebook post on a laptop with the customer's name on it is still not the building's wall");
  assert.equal(offAScreen.reason, "schedule_missing");
  const screenDoor = scheduleDoorAction(offAScreen, 0);
  assert.equal(screenDoor.kind, "retake", "the rep is asked for the wall, and it counts as a try");
  assert.ok(screenDoor.kind === "retake" && screenDoor.reason === "timetable_missing");
  assert.ok(screenDoor.kind === "retake" && /phone or computer screen/.test(screenDoor.message) && /building's own wall/.test(screenDoor.message), "and told why in words");
  assert.equal(scheduleDoorAction(offAScreen, 2).kind, "hold", "the third screen photo holds like any third missing timetable");

  // 🔴 A BOARD THAT WRITES FIRST NAMES ONLY NAMES HIM WHEN NOBODY ELSE ON IT SHARES THAT NAME (owner,
  // 2026-10-24, "Count it if unique"). The two boards are the real readings of Ali Mohamed Shehata's held
  // seatings that day, partial and cut off as the reader said.
  const romani = ["سوزى", "سعد", "بيتر رمزى", "ماريو", "فريد", "مريم عوني", "شيرى", "رامى", "مايكل", "الفونس", "ايفون", "يوسف", "ماريان"];
  const romaniBoard = { ...base, scheduleText: "سوزى 3-11", personNames: romani, legibility: "partial" as const, problem: "cut_off" as const };
  assert.equal(judgeSchedule({ ...romaniBoard, customerName: "سوزي الغطاس" }).verdict, "match", "سوزى on the board is سوزي الغطاس, ى and ي one letter");
  assert.equal(judgeSchedule({ ...romaniBoard, customerName: "ماريان اسحاق" }).verdict, "match", "ماريان alone on the board");
  const nour = ["د/ أحمد الحامولي", "د/ أحمد فتحى", "د/ حسن محمد", "د/ كمال غنيم", "د/ محمد صلاح", "د/ صلاح", "د/ خالد نبيل", "د/ خالد"];
  const nourBoard = { ...base, scheduleText: "جدول العيادات", personNames: nour, legibility: "partial" as const };
  assert.equal(judgeSchedule({ ...nourBoard, customerName: "صلاح عبدالفتاح" }).verdict, "match", "د/ صلاح alone, and محمد صلاح is another man's given name, not his");
  assert.equal(
    judgeSchedule({ ...nourBoard, customerName: "خالد عبدالله" }).verdict,
    "unjudged",
    "🔴 د/ خالد and د/ خالد نبيل share the given name: which خالد is not known, so it stays held",
  );
  assert.equal(judgeSchedule({ ...nourBoard, customerName: "حسن علي" }).verdict, "unjudged", "حسن محمد is a FULL name on the board, never a first-name-only entry for every حسن");
  assert.equal(judgeSchedule({ ...romaniBoard, customerName: "مينا جرجس" }).verdict, "unjudged", "a given name nowhere on the board is no match");
  assert.equal(judgeSchedule({ ...romaniBoard, personNames: [], customerName: "سوزي الغطاس" }).verdict, "unjudged", "nothing transcribed names nobody");
  assert.equal(judgeSchedule({ ...romaniBoard, customerName: "" }).verdict, "unjudged", "an empty customer name matches nothing");
  assert.equal(
    judgeSchedule({ ...romaniBoard, customerName: "سوزي الغطاس", legibility: "clear", problem: "on_a_screen" }).verdict,
    "no_schedule",
    "the screen refusal still comes first",
  );

  // The hold record carries the try and the reason for the queue.
  const record = scheduleHoldRecord({ ...UNREADABLE, tries: 3 }, { sharedPlaceId: "v1", name: "Polyclinic", lat: 30, lon: 31 }, { heldBecause: "timetable_unreadable", tries: 3 });
  assert.equal(record.verdict, "schedule");
  assert.equal(record.heldBecause, "timetable_unreadable");
  assert.equal(record.tries, 3);
  assert.equal(record.legibility, "unreadable");
  assert.deepEqual(record.listings, [], "the queue's listing key stays an empty list");

  // ── 3 · Both seating paths ask the SAME scanner, and a retake writes nothing ──────────────────────
  const list = stripComments(read("src/lib/phoenix-crm/server/list.ts"));
  assert.equal(list.split("await scanSeatedTimetable({").length - 1, 2, "Validate and Add another clinic both go through the one scanner");
  const scanner = list.slice(list.indexOf("async function scanSeatedTimetable("), list.indexOf("export type ValidateResult"));
  assert.ok(scanner.includes("readPlaceSchedule("), "it reads the board through the one reader");
  assert.ok(scanner.includes("scheduleDoorAction(check, earlierTries)"), "and asks the pure ruling");
  assert.ok(scanner.includes("countTimetableRefusals("), "with this rep's refused photos of this building today");
  const filed = scanner.indexOf("await recordTimetableRefusal(");
  const thrown = scanner.indexOf("throw validationError(action.message, SCHEDULE_RETAKE_CODE)");
  assert.ok(filed > -1 && thrown > filed, "🔴 the refusal is FILED before the save is refused — or the third try could never be reached");
  assert.equal(list.includes("scheduleHoldsForReview("), false, "the old silent gate is gone from the door");
  for (const fn of ["export async function validateCustomer(", "export async function addPlace("]) {
    const body = list.slice(list.indexOf(fn), list.indexOf("\n}\n", list.indexOf(fn)));
    assert.ok(body.indexOf("scanSeatedTimetable(") > -1, `${fn} scans the timetable`);
    assert.ok(body.indexOf("scanSeatedTimetable(") < body.indexOf("callPhoenixCrm<Row>("), `${fn} scans BEFORE anything is written`);
    assert.ok(body.includes("heldBecause: result.held === true ? heldBecause : null"), `${fn} tells the rep why only when the save really was held`);
  }
  assert.ok(SCHEDULE_RETAKE_CODE.startsWith("phoenix_crm_photo_"), "the code rides the screen's existing photo-refused prefix");

  // The rep's screen opens the camera on a retake, even when the refused board was the one on file.
  const screen = stripComments(read("src/components/phoenix-crm/list-screens.tsx"));
  assert.equal(screen.split('door === "shared" && code === SCHEDULE_RETAKE_CODE').length - 1, 2, "both seating screens handle the retake");
  assert.ok(screen.includes("replacingTimetable: true"), "and switch to photographing the board again");
  assert.ok(screen.includes("scheduleHeldText(saved.heldBecause)"), "the saved screen prints his hold sentence");

  // ── 4 · The reader: no hidden retry, and one reading per photograph ────────────────────────────────
  const reader = stripComments(read("src/lib/phoenix-crm/server/schedule-check.ts"));
  assert.ok(reader.includes("maxRetries: 0"), "🔴 no SDK retry inside the rep's 8 seconds");
  // 🔴 Claude first, by name (2026-10-19): asked second, it got what a dead OpenAI account left of the
  // 8 seconds, under the unnamed Haiku fallback, and the 11:34 read timed out with the board never read.
  assert.ok(reader.includes('preferProvider: "anthropic"'), "🔴 Claude reads the timetable FIRST, with the whole 8 seconds");
  assert.ok(
    reader.includes("anthropicModel: options.anthropicModel ?? PHOENIX_CRM_SCHEDULE_CLAUDE_MODEL"),
    "🔴 and the Claude model is NAMED — unnamed, gpt-5.4-mini maps to Haiku, which was slower AND read fewer boards",
  );
  assert.match(
    reader,
    /export const PHOENIX_CRM_SCHEDULE_CLAUDE_MODEL = "claude-sonnet-5-5";/,
    "the measured reader: Sonnet, p95 5.5 s on the 54 production boards against Haiku's 8.7 s",
  );
  assert.ok(reader.includes("legibility:") && reader.includes("problem:"), "the reader says how well it read and what is wrong");
  const board = reader.slice(reader.indexOf("export async function readScheduleBoard("), reader.indexOf("export async function readScheduleBytes("));
  assert.ok(board.indexOf("storedBoardReading(") > -1, "a reused board is judged against the reading already stored");
  assert.ok(board.indexOf("storedBoardReading(") < board.indexOf("downloadVenueTimetablePhoto({"), "before anything is downloaded or sent to the model");
  const stored = reader.slice(reader.indexOf("async function storedBoardReading("));
  assert.ok(stored.includes('legibility !== "clear" && legibility !== "partial"'), "only a reading that could SEE the board is reused — an unreadable one is read again");

  // ── 5 · The counter's table ────────────────────────────────────────────────────────────────────────
  const sql = stripSqlComments(read("supabase/migrations/20261017193000_phoenix_crm_timetable_refusals.sql"));
  assert.match(sql, /'timetable_unreadable'::text,\s*'timetable_missing'::text/, "the reason CHECK takes both timetable reasons");
  assert.ok(sql.includes("add column if not exists shared_place_id uuid"), "the building is a column of its own");
  assert.ok(sql.includes("or shared_place_id is null"), "and no other reason may carry one");
  assert.ok(sql.includes("(shared_place_id, rep_hr_id, visit_date)"), "the count is indexed by building, rep and day");
  const recorder = stripComments(read("src/lib/phoenix-crm/server/refused-readings.ts"));
  const count = recorder.slice(recorder.indexOf("export async function countTimetableRefusals("));
  for (const key of ['.eq("shared_place_id"', '.eq("rep_hr_id", input.repHrId.toUpperCase())', '.eq("visit_date", cairoBusinessDay(', '.eq("is_test"']) {
    assert.ok(count.includes(key), `the count is per building, rep, Cairo day and world: ${key}`);
  }
}
