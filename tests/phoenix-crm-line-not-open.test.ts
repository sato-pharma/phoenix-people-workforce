import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { stripComments } from "./support/comment-strip.ts";

import { phoenixCrmHasSomethingToSay } from "../src/lib/phoenix-crm/server/page.ts";
import type { PhoenixCrmViewer } from "../src/lib/phoenix-crm/server/access.ts";
import type { OrgSeat } from "../src/lib/phoenix-crm/scope.ts";

/**
 * Phoenix CRM — a line that has not opened SAYS SO, instead of the module vanishing.
 *
 * ## The hour this cost, 2026-09-26
 *
 * The owner opened a District Manager's account — Amgad Ibrahim, CNS Upper Egypt, seven reps beneath
 * him — and Phoenix CRM was not in the sidebar. Nothing was broken. CNS was simply not open on the
 * environment he was looking at, and `scopeTerritories` is already filtered to open lines, so a
 * manager whose whole district is waiting came out of `phoenixCrmEntryAvailable` looking exactly like
 * a stranger with no seat at all: no row, no page, and not one word anywhere saying why.
 *
 * The sentence already existed — `lineOpeningText`, "Phoenix CRM opens for CNS on 18 September 2026"
 * — and was only ever raised as an API refusal, on a page he could not reach.
 *
 * ## Why this is allowed under Golden Rule #1
 *
 * The rule says the rep is never told about a CHECK. This is not a check: it is his own ACCESS, and
 * a date. Nothing here judges anybody, and the wording names a line and a day and nothing else.
 *
 * ## The half that must not move
 *
 * A person the organogram places nowhere still gets nothing. A closed line must not become a door
 * for someone who holds no seat — that would be a wider module, not a kinder one.
 */

const SEAT_OPEN: OrgSeat = {
  seatId: "SEAT-CNS-REP-1",
  parentSeatId: "SEAT-CNS-DM-UE",
  tier: "REP",
  path: ["SEAT-CNS-DM-UE", "SEAT-CNS-REP-1"],
  occupantHrId: "B-900",
  lineCode: "cns",
  lineName: "CNS",
  areaName: "Upper Egypt",
  regionName: "Upper Egypt",
  seatLabel: "CNS Upper Egypt rep",
};

function viewerWith(patch: Partial<PhoenixCrmViewer>): PhoenixCrmViewer {
  return {
    isSuperAdmin: false,
    ownTerritories: [],
    scopeTerritories: [],
    waitingTerritories: [],
    waitingScopeTerritories: [],
    managerSeats: [],
    ...patch,
  } as unknown as PhoenixCrmViewer;
}

function source(path: string): string {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

export function runPhoenixCrmLineNotOpenTests(): void {
  // ── The door opens for everyone the module has something to say to ──────────────────────────────
  {
    assert.equal(phoenixCrmHasSomethingToSay(viewerWith({ isSuperAdmin: true })), true, "the Super Admin always has the module");
    assert.equal(phoenixCrmHasSomethingToSay(viewerWith({ ownTerritories: [SEAT_OPEN] })), true, "a rep with an open territory");
    assert.equal(phoenixCrmHasSomethingToSay(viewerWith({ scopeTerritories: [SEAT_OPEN] })), true, "a manager with an open territory beneath him");

    // The rep whose own line has not opened was already covered.
    assert.equal(phoenixCrmHasSomethingToSay(viewerWith({ waitingTerritories: [SEAT_OPEN] })), true, "a rep waiting for his line reads the date");

    // 🔴 THE FIX. A manager whose district is entirely on an unopened line. Before 2026-09-26 this
    // was false, and that is the whole incident: he saw nothing at all and was told nothing.
    assert.equal(
      phoenixCrmHasSomethingToSay(viewerWith({ waitingScopeTerritories: [SEAT_OPEN] })),
      true,
      "a manager whose whole district is waiting must reach the page that names the date",
    );
  }

  // ── And stays shut for someone the organogram places nowhere ────────────────────────────────────
  {
    assert.equal(
      phoenixCrmHasSomethingToSay(viewerWith({})),
      false,
      "a closed line must not open the module for someone holding no seat at all",
    );
  }

  // ── The two halves are resolved in one place ────────────────────────────────────────────────────
  {
    const page = stripComments(source("src/lib/phoenix-crm/server/sidebar-entries.ts"));
    assert.ok(
      /const crm = phoenixCrmHasSomethingToSay\(viewer\);/.test(page),
      "phoenixCrmSidebarEntries (which phoenixCrmEntryAvailable reads) must delegate to the predicate rather than re-testing the lengths itself — two copies of this rule is how the manager was lost",
    );

    // The viewer must actually carry the waiting scope, or the predicate is reading an absent field.
    const access = stripComments(source("src/lib/phoenix-crm/server/access.ts"));
    assert.ok(access.includes("waitingScopeTerritories"), "the viewer must carry the territories beneath him that are waiting");
    assert.ok(
      /waitingScopeTerritories: isSuperAdmin \? \[\] : scope\.filter\(\(seat\) => !isOpen\(seat\)\)/.test(access),
      "waitingScopeTerritories is the unopened half of the SAME scope, so the two sets can never disagree",
    );
  }

  // ── The overview hands the date to a manager, not only to a rep ─────────────────────────────────
  {
    const overview = stripComments(source("src/lib/phoenix-crm/server/overview.ts"));
    assert.ok(
      overview.includes("viewer.waitingScopeTerritories"),
      "the overview's `waiting` list must include the territories beneath him, or the manager reads an empty page",
    );
    assert.ok(overview.includes("dedupeSeats"), "an acting DM holds a rep seat that is also in his own scope — the list is deduped");
    assert.ok(overview.includes("lineOpeningText"), "the sentence is the module's own, naming the line and the date");
  }

  // ── The sentence says a line and a date, and nothing about anybody's conduct ────────────────────
  {
    const access = source("src/lib/phoenix-crm/server/access.ts");
    const start = access.indexOf("export function lineOpeningText");
    assert.notEqual(start, -1, "lineOpeningText is still there");
    const body = access.slice(start, start + 600);
    for (const word of [/\bflag/i, /\bintegrity\b/i, /\bcheck(ed|ing)?\b/i, /\bsuspic/i]) {
      assert.equal(word.test(body), false, `the opening sentence must not read as a judgement: ${word}`);
    }
  }

  console.log("phoenix-crm line not open: OK");
}
