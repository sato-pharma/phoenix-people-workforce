/**
 * Expense Approvals, rebuilt 2026-11-23 — THE REVIEWER: ONE REQUEST, ONE SCROLL, THE ROW'S OWN BUTTONS.
 *
 * The audit found a reviewer that made four requests a trip, drew the old vendor's GPS check-ins
 * (which stopped on 6 Nov 2026) and was a second way to decide. Pinned here:
 *
 *   1. A visit's saved time is moved onto Cairo's wall clock BEFORE the map sees it — winter (+2)
 *      and summer (+3). The map prints wall-clock digits; the raw instant would print hours early.
 *   2. Each trip day's map: the day's visits numbered in the order they were saved, the arrival
 *      photo on the first day, the departure photo on the last (even when taken the morning after),
 *      each stop on the day it was captured, the road route on the first and last day only.
 *   3. A point with no position is listed with the reason and never put on the map; a visit with no
 *      position is counted, not numbered.
 *   4. The reviewer reads the trip with ONE request and nothing under it fetches again; the photos
 *      panel is handed the data it would otherwise fetch.
 *   5. The reviewer decides with the row's own buttons, moves on after a press, and Escape closes
 *      the zoomed photo, then the reason box, then the reviewer.
 *   6. The page mounts the desk and nothing of the screen it replaces; no desk screen file is over
 *      400 lines; nothing on the desk names a model or keeps anything in browser storage.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { cairoWallClockText, deskDayMaps, tripDayOf } from "@/lib/outstation/approvals/day-map";

import { stripComments } from "./support/comment-strip.ts";

const DESK_DIR = "src/components/outstation/approvals-desk";
const read = (file: string) => fs.readFileSync(file, "utf8");

/** Comments carry the history; the assertions below are about the code. */
const code = (file: string) => stripComments(read(file));

export function runExpenseDeskReviewerTests() {
  // 1. Cairo wall clock: winter is UTC+2, summer UTC+3.
  assert.equal(cairoWallClockText("2026-11-14T07:05:00Z"), "2026-11-14T09:05:00");
  assert.equal(cairoWallClockText("2026-07-10T07:05:00Z"), "2026-07-10T10:05:00");
  assert.equal(cairoWallClockText("2026-11-14T22:30:00Z"), "2026-11-15T00:30:00", "late evening UTC is already the next day in Cairo");
  assert.equal(cairoWallClockText(null), null);
  assert.equal(cairoWallClockText("not a date"), null);

  assert.equal(tripDayOf("2026-11-17T06:00:00Z", "2026-11-14", "2026-11-16", "2026-11-14"), "2026-11-16", "after the trip → its last day");
  assert.equal(tripDayOf("2026-11-10T06:00:00Z", "2026-11-14", "2026-11-16", "2026-11-14"), "2026-11-14", "before the trip → its first day");
  assert.equal(tripDayOf("2026-11-15T06:00:00Z", "2026-11-14", "2026-11-16", "2026-11-14"), "2026-11-15");
  assert.equal(tripDayOf(null, "2026-11-14", "2026-11-16", "2026-11-16"), "2026-11-16", "no time → the day the caller names");

  // 2 and 3. A three-day trip.
  const maps = deskDayMaps({
    dayKeys: ["2026-11-14", "2026-11-15", "2026-11-16"],
    days: [
      {
        date: "2026-11-14",
        visits: [
          { customer: "Second saved", place: "Clinic B", point: { lat: 30.2, lon: 31.2 }, savedAt: "2026-11-14T10:00:00Z" },
          { customer: "First saved", place: "Clinic A", point: { lat: 30.1, lon: 31.1 }, savedAt: "2026-11-14T08:00:00Z" },
          { customer: "No position", place: null, point: null, savedAt: "2026-11-14T09:00:00Z" },
        ],
      },
      { date: "2026-11-15", visits: [] },
    ],
    hasTripRoute: true,
    photos: [
      { capturedAt: "2026-11-14T06:30:00Z", kind: "arrival", label: "Arrival photo", latitude: 30.0, longitude: 31.0, url: "https://example.test/a.jpg" },
      // Taken the morning after the trip ended: still the LAST day's map.
      { capturedAt: "2026-11-17T05:00:00Z", kind: "departure", label: "Departure photo", latitude: 30.5, longitude: 31.5, url: "https://example.test/d.jpg" },
    ],
    stops: [
      { capturedAt: "2026-11-15T11:00:00Z", governorate: "Minya", latitude: 28.1, longitude: 30.7, stopNumber: 2 },
      { capturedAt: "2026-11-15T13:00:00Z", governorate: null, latitude: null, longitude: null, stopNumber: 3 },
    ],
  });
  assert.equal(maps.length, 3, "one map per trip day");
  const [first, middle, last] = maps;

  assert.deepEqual(first.pins, [2, 1, null], "visits are numbered in the order they were saved; no position, no number");
  assert.equal(first.unplaced, 1);
  assert.deepEqual(first.checkins.map((pin) => pin.contactName), ["First saved", "Second saved"]);
  assert.equal(first.checkins[0].checkDate, "2026-11-14T10:00:00", "08:00 UTC is 10:00 on Cairo's wall clock — and carries no offset");
  assert.ok(!/Z|[+-]\d{2}:?\d{2}$/.test(first.checkins[0].checkDate), "the map is handed wall-clock digits, never an instant");
  assert.deepEqual(first.markers.map((marker) => marker.label), ["A"], "the arrival photo is on the first day");
  assert.equal(first.markers[0].at, "2026-11-14T06:30:00Z", "a photo goes to the map as its real instant");
  assert.equal(first.tripRoute, true);

  assert.deepEqual(middle.markers.map((marker) => marker.label), ["S2"], "a stop is on the day it was captured");
  assert.deepEqual(middle.legend.map((line) => line.label), ["S2", "S3"]);
  assert.equal(middle.legend[1].point, null);
  assert.match(String(middle.legend[1].note), /not on the map/, "a stop with no position is listed, never guessed onto the map");
  assert.equal(middle.tripRoute, false, "the road route is drawn on the first and last day only");
  assert.deepEqual(middle.pins, []);

  assert.deepEqual(last.markers.map((marker) => marker.label), ["D"], "a departure photo taken the morning after is on the last day");
  assert.equal(last.legend[0].at, "2026-11-17T05:00:00Z", "its legend line keeps the real time");
  assert.equal(last.tripRoute, true);
  assert.equal(last.checkins.length, 0, "a day Phoenix CRM holds nothing for has no numbered pin");

  // A photo that was never taken, and one on file with no position.
  const [only] = deskDayMaps({
    dayKeys: ["2026-11-14"],
    days: [],
    hasTripRoute: false,
    photos: [
      { capturedAt: null, kind: "arrival", label: "Arrival photo", latitude: null, longitude: null, missingNote: "No arrival photo was taken", url: null },
      { capturedAt: "2026-11-14T15:00:00Z", kind: "departure", label: "Departure photo", latitude: null, longitude: null, url: "https://example.test/d.jpg" },
    ],
    stops: [],
  });
  assert.equal(only.hasPoints, false, "nothing with a position: no map is drawn");
  assert.equal(only.markers.length, 0);
  assert.equal(only.legend[0].note, "No arrival photo was taken");
  assert.match(String(only.legend[1].note), /No GPS position/);
  assert.deepEqual(deskDayMaps({ dayKeys: [], days: [], hasTripRoute: true, photos: [], stops: [] }), []);

  // A same-day trip draws the road route once, on its only day.
  assert.equal(deskDayMaps({ dayKeys: ["2026-11-14"], days: [], hasTripRoute: true, photos: [], stops: [] })[0].hasPoints, true);

  // 4. One request for the whole trip; nothing under it fetches again.
  const tripFile = code(path.join(DESK_DIR, "desk-trip-file.tsx"));
  assert.equal((tripFile.match(/\bfetch\(/g) ?? []).length, 1, "the reviewer makes ONE request per trip");
  assert.match(tripFile, /const ROUTE = "\/api\/admin\/outstation\/approvals";/);
  assert.match(tripFile, /fetch\(`\$\{ROUTE\}\/\$\{requestId\}`/);
  assert.match(tripFile, /<TripAttachments data=\{file\.attachments\}/, "the photos panel is handed the data — it must not fetch it again");
  assert.match(tripFile, /onChanged=\{readAgain\}/, "a stop added by the approver reads the trip again");
  for (const file of ["desk-days.tsx", "desk-day-map.tsx", "desk-reviewer.tsx"]) {
    assert.ok(!/\bfetch\(/.test(code(path.join(DESK_DIR, file))), `${file} must not fetch`);
  }
  const attachments = code("src/components/outstation/trip-attachments.tsx");
  assert.match(attachments, /const supplied = given !== undefined;/, "TripAttachments fetches only when no data was supplied");
  assert.match(tripFile, /file\.evidenceWithheld \?/, "a reader without the approver gate is told the evidence is withheld");

  // 5. The row's own buttons; move on after a press; Escape in order.
  assert.match(tripFile, /import \{ type DecisionMode, DecisionButtons, DecisionPanel, type OnPress \} from "\.\/desk-decision";/);
  assert.match(tripFile, /<DecisionButtons canDecide=\{canDecide\} claim=\{claim\} everyAction /);
  const reviewer = code(path.join(DESK_DIR, "desk-reviewer.tsx"));
  assert.match(reviewer, /aria-modal="true"/);
  assert.match(reviewer, /useDialogA11y<HTMLDivElement>\(\{ open: hydrated, onClose: close \}\)/);
  assert.match(reviewer, /if \(otherDialogOpen\(\)\) return;\s*if \(mode !== "idle"\) \{\s*setMode\("idle"\);\s*return;\s*\}\s*onClose\(\);/, "Escape: the zoomed photo, then the reason box, then the reviewer");
  assert.match(reviewer, /onPress\(decisions, claims\);\s*setMode\("idle"\);\s*const target = next \?\? previous;\s*if \(target !== null\) onGo\(target\);\s*else onClose\(\);/, "after a press the reviewer moves to the next claim, else closes");
  assert.match(reviewer, /<DeskTripFile[\s\S]*?key=\{requestId\}/, "one trip file per trip: a slow answer can never be drawn on the next claim");
  assert.match(reviewer, /<DeskUndoBar onUndo=\{undoAndReturn\} presses=\{presses\} \/>/, "Undo is inside the reviewer too");
  const decision = code(path.join(DESK_DIR, "desk-decision.tsx"));
  assert.match(decision, /<RewriteFormally /, "Rewrite formally is kept, where the reason is typed");
  const rewrite = code(path.join(DESK_DIR, "desk-rewrite.tsx"));
  assert.match(rewrite, /fetch\("\/api\/admin\/outstation\/expenses\/note-assist"/);
  assert.match(rewrite, /Restore my wording/);

  // 6. The page, the size of the files, and what the desk never does.
  const page = code("app/(admin)/admin/outstation/expense-approvals/page.tsx");
  assert.match(page, /import \{ DeskWorkspace \} from "@\/components\/outstation\/approvals-desk\/desk-workspace";/);
  assert.ok(!page.includes("expense-review"), "the page mounts nothing of the screen it replaces");
  assert.match(page, /if \(!canReviewOutstationExpenseApprovals\(access\)\) \{\s*redirect\("\/admin\/access"\);/);
  assert.match(page, /<DeskWorkspace initialSearch=\{searchText\(await searchParams\)\} \/>/, "the address's query reaches the desk, so a reload opens the same view");

  const deskFiles = fs.readdirSync(DESK_DIR).filter((file) => /\.tsx?$/.test(file));
  assert.ok(deskFiles.length >= 12, "the desk's screen files are all here");
  for (const file of deskFiles) {
    assert.ok(read(path.join(DESK_DIR, file)).split("\n").length <= 400, `${file} is over 400 lines — split it`);
    const body = code(path.join(DESK_DIR, file));
    assert.ok(!/localStorage|sessionStorage|indexedDB/.test(body), `${file} must keep nothing in browser storage`);
    assert.ok(!/\b(?:AI|GPT|OpenAI|Claude|Gemini|LLM)\b/.test(body), `${file} must not name a model on the screen`);
    assert.ok(!/rounded-(?!none)/.test(body), `${file} must not round a corner`);
    assert.ok(!/\btruncate\b|line-clamp|text-ellipsis/.test(body), `${file} must not cut text with an ellipsis`);
    assert.ok(!/overflow-x-auto|overflow-x-scroll/.test(body), `${file} must not scroll sideways`);
  }
}
