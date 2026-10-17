import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { placeCheckScorecard, problemsOf, standingOfPlaceInUse, type RepScore } from "../src/lib/phoenix-crm/place-check-scorecard.ts";
import { stripComments } from "./support/comment-strip.ts";

/**
 * Phoenix CRM — Place checks, each rep's captures on one line (owner, 2026-10-17: "eyeball the check
 * places full module all tabs and tell me is this a report that really shows me data? or it's a bunch of
 * chaos"). The board drew every row and summed nothing, so a rep who sent thirty photographs of a
 * pavement read exactly like one who sent thirty clear signboards.
 *
 * What would break silently:
 * - a place counted in two columns, or in none, so the line no longer adds up to its own Places figure;
 * - a place both waiting and in use counted twice;
 * - a new count added to a line and left out of the total;
 * - the worst rep sorted anywhere but first;
 * - the manager's board saying a decision is "waiting for you".
 */

const ROOT = new URL("../", import.meta.url);

function read(path: string): string {
  return stripComments(readFileSync(new URL(path, ROOT), "utf8").replace(/\r\n/g, "\n"));
}

type InUse = Parameters<typeof standingOfPlaceInUse>[0];

function sign(verdict: string, reason: string | null = null): InUse {
  return {
    placeId: `p-${verdict}-${reason ?? "none"}`,
    repName: "Rep",
    reviewed: false,
    photoKind: "signboard",
    signboard: { verdict: verdict as "match", reason, signText: null },
    schedule: null,
  };
}

function timetable(verdict: string | null, reason: string | null = null): InUse {
  return {
    placeId: `t-${verdict}-${reason ?? "none"}`,
    repName: "Rep",
    reviewed: false,
    photoKind: "schedule",
    signboard: null,
    schedule: verdict === null ? null : { verdict: verdict as "match", scheduleText: null, hoursRead: null, reason },
  };
}

function checkStanding(): void {
  // A person looked and it is still in use: he approved it, whatever the reader said.
  assert.equal(standingOfPlaceInUse({ ...sign("other_name"), reviewed: true }), "confirmed", "an approval outranks the reading");

  // The sign, for a clinic.
  assert.equal(standingOfPlaceInUse(sign("match")), "confirmed");
  assert.equal(standingOfPlaceInUse(sign("other_name")), "anotherName");
  assert.equal(standingOfPlaceInUse(sign("no_name")), "wrongPhoto", "no sign in the frame is a photograph of something else");
  for (const reason of ["unreadable", "unreadable_final", "unconfirmed"]) {
    assert.equal(standingOfPlaceInUse(sign("unjudged", reason)), "notReadable", `an unjudged sign for ${reason} is a photo that could not be read`);
  }
  for (const reason of ["name_unusable", "call_failed", null]) {
    assert.equal(standingOfPlaceInUse(sign("unjudged", reason)), "notRead", `an unjudged sign for ${String(reason)} had nothing read, not a bad photo`);
  }
  assert.equal(standingOfPlaceInUse({ ...sign("match"), signboard: null }), "notRead", "a sign never read is not read");

  // 🔴 THE TIMETABLE, for a customer seated in a polyclinic — never his building's sign.
  assert.equal(standingOfPlaceInUse(timetable("match")), "confirmed");
  assert.equal(standingOfPlaceInUse(timetable("other_name")), "anotherName");
  assert.equal(standingOfPlaceInUse(timetable("no_schedule")), "wrongPhoto", "no timetable in the frame is the street, the floor or a door");
  assert.equal(standingOfPlaceInUse(timetable("unjudged", "unreadable")), "notReadable");
  assert.equal(standingOfPlaceInUse(timetable("unjudged", "call_failed")), "notRead", "a lost call says nothing about the photograph");
  assert.equal(standingOfPlaceInUse(timetable(null)), "notRead");
  assert.equal(
    standingOfPlaceInUse({ ...timetable(null), signboard: { verdict: "match", reason: null, signText: null } }),
    "notRead",
    "a seated customer is judged on the timetable alone, never on a signboard reading",
  );
}

function score(reps: RepScore[], name: string): RepScore {
  const found = reps.find((rep) => rep.repName === name);
  assert.ok(found, `${name} has a line`);
  return found;
}

function columnsAddUp(rep: RepScore): void {
  const sum = rep.confirmed + rep.notReadable + rep.wrongPhoto + rep.anotherName + rep.notRead + rep.waiting;
  assert.equal(sum, rep.places, `🔴 ${rep.repName}'s six standings add up to their places — every place in exactly one column`);
}

function checkScorecard(): void {
  const at = (placeId: string, repName: string, row: InUse): InUse => ({ ...row, placeId, repName });
  const { reps, total } = placeCheckScorecard({
    waiting: [
      { placeId: "a1", repName: "Amira", photoKind: "signboard" },
      // The same place twice in the queue is one place.
      { placeId: "a1", repName: "Amira", photoKind: "signboard" },
      { placeId: "h1", repName: "Hassan", photoKind: "schedule" },
    ],
    inUse: [
      // 🔴 A place with a decision open is counted there, never again among the places in use.
      at("a1", "Amira", sign("match")),
      at("a2", "Amira", sign("match")),
      at("a3", "Amira", sign("match")),
      at("a4", "Amira", sign("unjudged", "unreadable")),
      at("h2", "Hassan", timetable("no_schedule")),
      at("h2", "Hassan", timetable("no_schedule")),
      at("h3", "Hassan", timetable("unjudged", "unreadable")),
      at("h4", "Hassan", timetable("match")),
      at("m1", "Mona", sign("match")),
      at("m2", "Mona", sign("match")),
      at("s1", "Sara", sign("match")),
      at("s2", "Sara", sign("match")),
    ],
    reopened: [{ repName: "Hassan" }, { repName: "Zeinab" }],
  });

  const amira = score(reps, "Amira");
  assert.equal(amira.places, 4, "a1 waiting, a2-a4 in use — a1 never twice");
  assert.equal(amira.waiting, 1);
  assert.equal(amira.confirmed, 2);
  assert.equal(amira.notReadable, 1);
  columnsAddUp(amira);

  const hassan = score(reps, "Hassan");
  assert.equal(hassan.places, 4, "h1 waiting, and h2 counted once though it came twice");
  assert.equal(hassan.wrongPhoto, 1);
  assert.equal(hassan.notReadable, 1);
  assert.equal(hassan.confirmed, 1);
  assert.equal(hassan.sentBack, 1, "a customer sent back sits beside the sum");
  assert.equal(hassan.seated, 4, "every one of his places is a seating, the waiting one included");
  assert.equal(hassan.seatedOnTimetable, 1, "and the timetable names one of them");
  columnsAddUp(hassan);

  const zeinab = score(reps, "Zeinab");
  assert.equal(zeinab.places, 0, "a rep with only a customer sent back still has a line");
  assert.equal(zeinab.sentBack, 1);
  columnsAddUp(zeinab);

  // 🔴 WORST FIRST, by SHARE: Zeinab's only customer was sent back (1 of 1), Hassan's three of five went
  // wrong, Amira's one of four; Mona and Sara have nothing wrong and fall back to the name.
  assert.deepEqual(
    reps.map((rep) => rep.repName),
    ["Zeinab", "Hassan", "Amira", "Mona", "Sara"],
    "the larger share of bad photographs comes first, then the count, then the name",
  );
  assert.equal(problemsOf(hassan), 3, "a problem is unreadable, wrong photo, another name or sent back");

  // 🔴 THE TOTAL READS EVERY COUNT, so a count added to a line later cannot be left out of it silently.
  for (const key of Object.keys(total) as Array<keyof RepScore>) {
    if (key === "repName") continue;
    const sum = reps.reduce((running, rep) => running + rep[key], 0);
    assert.equal(total[key], sum, `the total's ${key} is the sum of every rep's`);
  }
  assert.equal(total.repName, "Every rep");
  columnsAddUp(total);

  const empty = placeCheckScorecard({ waiting: [], inUse: [], reopened: [] });
  assert.deepEqual(empty.reps, [], "nothing captured is no line at all");
  assert.equal(empty.total.places, 0);
}

function checkScreen(): void {
  const screen = read("src/components/phoenix-crm/place-check-scorecard.tsx");
  assert.ok(screen.indexOf("<CrmCardsOnPhone") > -1 && screen.indexOf("<CrmCardsOnPhone") < screen.indexOf("<CrmTable"), "phone cards first, then the table");
  assert.ok(screen.includes('["Rep", ...TABLE_GROUPS.map((group) => group.label)].map('), "the header row is mapped from the same groups the rows draw");
  assert.ok(screen.includes('const widths = ["18%", ...TABLE_GROUPS.map((group) => group.width)];'), "one width per column");
  // 🔴 Nine counts at 9% split CONFIRMED and TIMETABLE mid-word at laptop widths, so the table MERGES —
  // and a merge must drop nothing: every count the cards show sits in exactly one desktop group.
  const groupBlock = screen.slice(screen.indexOf("const TABLE_GROUPS"), screen.indexOf("];", screen.indexOf("const TABLE_GROUPS")));
  const groupWidths = [...groupBlock.matchAll(/width: "(\d+)%"/g)].map((match) => Number(match[1]));
  assert.equal(18 + groupWidths.reduce((sum, width) => sum + width, 0), 100, "the rep column and the groups fill the table exactly");
  assert.ok(groupWidths.length <= 5, "at most six columns, so no header word has to split");
  const grouped = [...groupBlock.matchAll(/keys: \[([^\]]*)\]/g)].flatMap((match) => [...match[1].matchAll(/"(\w+)"/g)].map((key) => key[1]));
  const cardKeys = [...screen.slice(screen.indexOf("function columnsFor"), screen.indexOf("function valueOf")).matchAll(/key: "(\w+)"/g)]
    .map((match) => match[1])
    .filter((key) => key !== "places");
  assert.deepEqual([...grouped].sort(), [...cardKeys].sort(), "every count but the place count (under the name) is in exactly one group");
  assert.ok(screen.includes("placesText(score.places)") && screen.includes("placesText(total.places)"), "the place count sits under each name");
  // The phone draws the table's "Every rep" line too: the same rows, never fewer facts.
  const cards = screen.slice(screen.indexOf("<CrmCardsOnPhone>"), screen.indexOf("</CrmCardsOnPhone>"));
  assert.ok(cards.includes("<ScoreFacts columns={columns} score={total} />"), "the phone cards end on the Every rep total");
  assert.ok(screen.includes('mode === "team" ? "Being checked" : "Waiting for you"'), "🔴 a manager's line never says a decision waits on him");
  assert.ok(screen.includes("const FIRST_REPS = 10;") && screen.includes("Show every rep"), "ten reps, then the rest on request");
  assert.doesNotMatch(screen, /\brounded-(?!none\b)|\boverflow-x-auto\b|\btruncate\b|…/, "square, no sideways scroll, no ellipsis");
  assert.doesNotMatch(screen, /"[^"]*\b(doctors?|accounts?)\b[^"]*"/i, "no banned word in a screen string");

  // The board narrows every tab through its own Rep filter — the scorecard keeps no filter of its own.
  const board = read("src/components/phoenix-crm/validation-reviews-board.tsx");
  assert.ok(board.includes('onPickRep={(rep) => set("rep", rep)}'), "tapping a rep sets the board's own Rep filter");
  assert.ok(board.includes("pickedRep={filters.rep}"), "and the picked rep is read back from it");
  assert.ok(!/useState[^\n]*pickedRep/.test(screen), "the scorecard holds no rep of its own");
}

export async function runPhoenixCrmPlaceCheckScorecardTests() {
  checkStanding();
  checkScorecard();
  checkScreen();
}
