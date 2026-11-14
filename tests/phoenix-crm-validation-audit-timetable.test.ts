import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  SCHEDULE_MAX_REREADS,
  SCHEDULE_REREAD_REASONS,
  scheduleDoorAction,
  scheduleNeedsReread,
  scheduleRereadToKeep,
  scheduleRereadsRecorded,
  scheduleUnjudged,
  VENUE_TIMETABLE_NOT_A_TIMETABLE,
  venueTimetableRefusal,
  type PhoenixCrmScheduleCheck,
} from "../src/lib/phoenix-crm/schedule-rules.ts";
import { stripComments } from "./support/comment-strip.ts";

/**
 * The polyclinic timetable, as the Phoenix CRM validation audit of 14 Nov 2026 left it.
 *
 * Three things were found on production and in the code that day:
 *
 *   1. "Photograph the timetable" stored whatever it was sent as the building's board and read it
 *      afterwards — so one picture of a wall could send every customer seated in the building out of the
 *      KPIs, while the seating door had refused that same picture since 17 Oct;
 *   2. a seating saved on a lost call (the door's own rule) was never read again — two real customers of
 *      21 Oct were still validated on a board nobody had read;
 *   3. the settle after a saved board, and after the Super Admin's move, could answer an error for a
 *      change that was already stored, and the retry was then refused.
 *
 * Every assertion here is one that goes quiet rather than red when the fix is undone.
 */

const ROOT = new URL("../", import.meta.url);

function code(path: string): string {
  return stripComments(readFileSync(new URL(path, ROOT), "utf8").replace(/\r\n/g, "\n"));
}

function functionBody(source: string, declaration: string): string {
  const start = source.indexOf(declaration);
  assert.ok(start >= 0, `${declaration} is declared`);
  const next = source.indexOf("\nexport ", start + declaration.length);
  return next < 0 ? source.slice(start) : source.slice(start, next);
}

function assertBefore(source: string, first: string, second: string, why: string): void {
  const a = source.indexOf(first);
  const b = source.indexOf(second);
  assert.ok(a >= 0, `${first} is there — ${why}`);
  assert.ok(b >= 0, `${second} is there — ${why}`);
  assert.ok(a < b, why);
}

function check(overrides: Partial<PhoenixCrmScheduleCheck>): PhoenixCrmScheduleCheck {
  return { ...scheduleUnjudged("call_failed"), ...overrides };
}

export async function runPhoenixCrmValidationAuditTimetableTests(): Promise<void> {
  // ── 1. The building's own door refuses a photograph that is not a timetable ────────────────────
  assert.equal(
    venueTimetableRefusal({ personNames: [], problem: "not_a_timetable", schedulePresent: null, scheduleText: null }),
    VENUE_TIMETABLE_NOT_A_TIMETABLE,
    "a pavement is refused before it becomes the building's board",
  );
  assert.equal(
    venueTimetableRefusal({ personNames: [], problem: null, schedulePresent: false, scheduleText: null }),
    VENUE_TIMETABLE_NOT_A_TIMETABLE,
    "and so is a photograph the reader is sure holds no timetable",
  );
  assert.equal(
    venueTimetableRefusal({ personNames: [], problem: "blurred", schedulePresent: true, scheduleText: null }),
    null,
    "a board nobody could read is still stored: the administrator reads it by eye, and unjudged never holds",
  );
  assert.equal(
    venueTimetableRefusal({ personNames: [], problem: "on_a_screen", schedulePresent: true, scheduleText: null }),
    null,
    "a timetable on a screen is still stored (owner, 2026-10-28)",
  );
  assert.equal(
    venueTimetableRefusal({ personNames: ["احمد محمود نصر"], problem: "not_a_timetable", schedulePresent: false, scheduleText: null }),
    null,
    "a reading that carries a name is never called 'no timetable', whatever else it said",
  );
  assert.equal(
    venueTimetableRefusal({ personNames: [], problem: null, schedulePresent: null, scheduleText: null }),
    null,
    "a reader that is merely unsure refuses nobody",
  );
  for (const word of ["doctor", "account"]) {
    assert.ok(!VENUE_TIMETABLE_NOT_A_TIMETABLE.toLowerCase().includes(word), `the rep's sentence never says "${word}"`);
  }

  const venue = code("src/lib/phoenix-crm/server/venue-timetable.ts");
  const add = functionBody(venue, "export async function addVenueTimetable(");
  assertBefore(add, "readScheduleBoard(", 'callPhoenixCrm<Row>("phoenix_crm_set_venue_timetable"', "the photograph is read BEFORE it is stored as the board");
  assertBefore(add, "venueTimetableRefusal(board)", 'callPhoenixCrm<Row>("phoenix_crm_set_venue_timetable"', "and refused before anything is written");
  assert.match(add, /board\.kind === "read" \? venueTimetableRefusal\(board\) : null/, "a reader that never answered refuses nobody");
  assert.match(add, /throw validationError\(refusal, SCHEDULE_RETAKE_CODE\)/, "the refusal travels under the retake code");
  assert.match(add, /settleVenueTimetable\(\{[\s\S]*?\bboard,\s*\}\)/, "the one reading is handed to the settle, so the board is still read once");
  const settle = functionBody(venue, "export async function settleVenueTimetable(");
  assert.match(settle, /input\.board \?\?\s*\(await readScheduleBoard\(/, "the settle reads only when it was handed no reading");

  // ── 3. A saved board, or a saved move, never answers an error ──────────────────────────────────
  const afterCommit = add.slice(add.indexOf('callPhoenixCrm<Row>("phoenix_crm_set_venue_timetable"'));
  assertBefore(afterCommit, "try {", "settled = await settleVenueTimetable(", "the settle after the commit runs inside a try");
  assert.match(afterCommit, /catch \(error\) \{\s*logError\(/, "and its failure is logged, not thrown");
  assert.ok(!/\n {2}throwIfError\(/.test(afterCommit), "nothing after the commit throws at the top level of the function");
  const move = code("src/lib/phoenix-crm/server/place-move.ts");
  const seat = functionBody(move, "export async function seatPlacesInVenue(");
  assert.match(seat, /try \{\s*await settleVenueTimetable\(/, "the settle after the Super Admin's move is caught too");
  assertBefore(seat, "await settleVenueTimetable(", "restampVisitLocationsQuietly(", "and the visits are measured again whatever the settle did");

  // ── 2. A lost call is read again at night, and only written ────────────────────────────────────
  assert.deepEqual([...SCHEDULE_REREAD_REASONS].sort(), ["call_failed", "no_api_key", "no_bytes"], "the three absences of an answer, and never 'unreadable'");
  assert.equal(scheduleNeedsReread(null), true, "a seated place nobody has read is read");
  assert.equal(scheduleNeedsReread(check({ reason: "call_failed" })), true, "a lost call is read again");
  assert.equal(scheduleNeedsReread(check({ reason: "no_bytes" })), true, "and so is a photo that could not be fetched");
  assert.equal(scheduleNeedsReread(check({ reason: "unreadable" })), false, "🔴 an answer of 'unreadable' is an answer: the door's tries and his eye settle it");
  assert.equal(scheduleNeedsReread(check({ reason: "held_elsewhere" })), false, "a read that was skipped on purpose stays skipped");
  assert.equal(scheduleNeedsReread(check({ reason: null, verdict: "match" })), false, "a match is never read again");
  assert.equal(scheduleNeedsReread(check({ reason: "schedule_other_name", verdict: "other_name" })), false, "nor a board that does not name him");
  assert.equal(scheduleNeedsReread(check({ rereads: SCHEDULE_MAX_REREADS })), false, "and the night stops after its last re-read");
  assert.equal(scheduleNeedsReread(check({ rereads: SCHEDULE_MAX_REREADS - 1 })), true, "but not one night sooner");

  assert.equal(scheduleRereadsRecorded(null), 0);
  assert.equal(scheduleRereadsRecorded({ rereads: "2" }), 0, "anything unrecognised is none");
  const lostAgain = scheduleRereadToKeep(check({}), check({ rereads: 1 }));
  assert.equal(lostAgain.rereads, 2, "a re-read that was lost again is still counted, or the night would read it for ever");
  const named = scheduleRereadToKeep(check({ reason: null, verdict: "match" }), check({ uploaded: true }));
  assert.equal(named.rereads, 1);
  assert.equal(named.uploaded, true, "an upload stays marked as one after it is read again");
  assert.equal(scheduleRereadToKeep(check({ reason: null, verdict: "match" }), null).uploaded, undefined, "and a live photo is never marked as one");

  // The door's own rule is untouched: a lost call still saves, and is never held or refused.
  assert.deepEqual(scheduleDoorAction(check({ reason: "call_failed" }), 0), { kind: "save" }, "the door still saves on a lost call");

  const pass = functionBody(venue, "export async function runLostTimetableRereads(");
  assert.match(pass, /if \(!hasAiApiKey\(\)\) return \{ \.\.\.result, skipped: "no_api_key" \}/, "no key: nothing is read and no re-read is spent");
  assert.ok(pass.includes('.eq("is_test", false)') && pass.includes('.eq("status", "active")'), "real, active places only");
  assert.ok(pass.includes('.not("shared_place_id", "is", null)'), "seated places only — a standalone sign is the signboard night's");
  assert.ok(pass.includes("scheduleNeedsReread(row.schedule_check ?? null)"), "the pure rule decides what is read");
  assert.ok(pass.includes("venue.timetable_exempt_at"), "a building declared to have no timetable is never read as one");
  assert.ok(pass.includes("if (!venue.schedule_photo_path) continue;"), "🔴 a building with no board has nothing to read — his own door photo is never read as a timetable");
  assert.ok(
    pass.includes("String(row.schedule_check ? row.photo_path : venue.schedule_photo_path)"),
    "a lost call is asked about the door's own photograph; a row nobody read is read against the building's board, as the settle reads it",
  );
  assert.ok(pass.includes("signboardNameIsUsable(name)"), "a name too short to match is never held against a board");
  // The backlog keeps rows the night can never read (an exempt building, no board, a short name, three
  // re-reads spent). A single first page would be those same rows every night.
  assert.ok(pass.includes('if (after) backlog = backlog.gt("id", after);'), "🔴 the night walks PAST the rows it rules out — each page starts after the last row of the one before");
  assert.ok(pass.includes("after = String(page[page.length - 1].id);"), "the walk moves on from every page, whether or not it held work");
  assert.ok(pass.includes("pageNumber < LOST_TIMETABLE_BACKLOG_MAX_PAGES && queued < limit && !backlogEnded"), "it stops at its limit of places, at the end of the backlog, or after a fixed number of pages");
  assert.ok(pass.indexOf("if (queued >= limit) {") > pass.indexOf("signboardNameIsUsable(name)"), "🔴 the limit counts places it WILL read — a row it rules out never uses one up");
  assert.ok(pass.includes("result.moreWaiting = !backlogEnded;"), "and it says so when it stopped before the end");
  assert.ok(!pass.includes("result.moreWaiting = page.length >= limit"), "never the first page alone");
  assert.equal((pass.match(/readScheduleBoard\(/g) ?? []).length, 1, "one photograph, one question, however many are seated behind it");
  assert.ok(pass.includes("recordPlaceSchedule(String(row.id), scheduleRereadToKeep(judged, row.schedule_check ?? null))"), "the answer is written on the place's own row");
  for (const forbidden of ["callPhoenixCrm", "settleVenueTimetable", "phoenix_crm_validation_reviews", "notify", "phoenix_crm_customers\")\n      .update"]) {
    assert.ok(!pass.includes(forbidden), `🔴 the night only writes the verdict — it never reaches ${forbidden}`);
  }

  const night = code("src/lib/phoenix-crm/server/photo-dupes.ts");
  const signs = night.indexOf("runPhoenixCrmSignboardSweep()");
  const timetables = night.indexOf("runLostTimetableRereads()");
  const behaviour = night.indexOf("runPhoenixCrmBehaviourSweep({ today: options.today })");
  assert.ok(signs > 0 && signs < timetables && timetables < behaviour, "the night runs it after the signboards and before the month's shape");
  assert.match(night, /return \{ photos, signboards, timetables, silent, behaviour \};/, "and reports what it read");
}
