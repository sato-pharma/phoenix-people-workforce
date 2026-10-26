import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import type { ManagerDayVisit } from "../src/lib/phoenix-crm/manager-visit-detail.ts";
import { privateCalendarDayTile, privateCalendarPlanText } from "../src/lib/private-calendar/day-tile.ts";
import type { PrivateCalendarItem } from "../src/lib/private-calendar/logic.ts";
import { stripComments } from "./support/comment-strip.ts";

/**
 * The private calendar's day tile is a SUMMARY (owner, 2026-10-23): *"in the calendar tile itself show the count of the
 * AM and the count of PM and the count of pharmacies, and if it is a double or single visit … the area … don't mention
 * names … regular or campaign, planned or unplanned … if double, the medical rep, the brick … when I press on the day,
 * the details appear down."*
 *
 *   1. a visit entry makes a tile of the kind, the category, the three figures apart, who it was made with, the brick
 *      and the area — every one read from a STRUCTURED field, never parsed out of the text lines;
 *   2. planned / unplanned is said only where a Phoenix visit says it, and a mix is counted;
 *   3. only a visit entry makes a tile — attendance, vacation and the rest keep their own chip;
 *   4. the grid draws no customer and no per-visit row in the tile, and the page wears the square-edge look.
 */
function entry(overrides: Partial<PrivateCalendarItem> = {}): PrivateCalendarItem {
  return {
    activityKind: "double_regular",
    approvalImpact: null,
    chipLines: ["Double · Regular", "With Mina Farouk", "AM 2 · PM 1 · Pharmacies 1", "Nasr City", "AM · Dr. Hala Mansour · Cardiology"],
    description: null,
    detailLines: [],
    employeeDepartmentName: null,
    employeeHrId: "B-120",
    employeeJobTitle: null,
    employeeLineName: null,
    employeeName: "Sara Adel",
    endDate: "2026-10-19",
    exceptionFlags: [],
    id: "double-visit-performed-double_regular-b120-2026-10-19",
    managerName: null,
    severity: "success",
    source: "double_visit",
    sourceLabel: "Double visits through the CRM read door",
    sourceRecordId: null,
    sourceSystem: "Double Visit Analytics",
    sourceTable: null,
    startDate: "2026-10-19",
    status: "performed",
    time: null,
    title: "Double · Regular: 4 visits",
    visitCounts: { am: 2, pm: 1, pharmacies: 1 },
    ...overrides,
  };
}

function phoenixVisit(overrides: Partial<ManagerDayVisit> = {}): ManagerDayVisit {
  return {
    address: "12 Mostafa El-Nahas St",
    areaName: "Cairo East",
    awaitingValidation: false,
    brickName: "Nasr City 3",
    bucket: "AM",
    comment: null,
    customerName: "Dr. Hala Mansour",
    date: "2026-10-19",
    grade: "A",
    hasPin: false,
    id: "rep:1",
    inVacantTerritory: false,
    kind: "double",
    kindLabel: "Double visit",
    listType: "AM",
    loggedAt: "2026-10-19T08:42:00Z",
    loggedHalf: "AM",
    managerHrId: "B-120",
    pharmacyName: null,
    placeLabel: null,
    placeSource: "saved_place",
    planned: true,
    products: [],
    source: "rep",
    speciality: "Cardiology",
    territoryName: null,
    withPeople: [{ name: "Mina Farouk", role: "District Manager" }],
    ...overrides,
  };
}

export function runPrivateCalendarDayTileTests(): void {
  // ── ONE PERSON IS NAMED ONCE, WHATEVER SPELLING EACH SOURCE CARRIES (audit, 2026-10-26) ─────────────────────────
  // The visit mirror names a rep by her full name and the Phoenix visit by her nickname; a text-only dedupe printed
  // "WITH Hana Abdelaziz Samir Abdelaziz, Hana Abdelaziz". Same HR id → one name, the Phoenix visit's.
  {
    const tile = privateCalendarDayTile(
      entry({
        tileWith: ["Hana Abdelaziz Samir Abdelaziz"],
        tileWithPeople: [{ hrId: "B-110", name: "Hana Abdelaziz Samir Abdelaziz" }],
        managerVisits: [phoenixVisit({ withPeople: [{ hrId: "b110", name: "Hana Abdelaziz", role: "Medical rep" }] })],
      }),
    );
    assert.deepEqual(tile?.withNames, ["Hana Abdelaziz"], "one person, one name — matched on the HR id in any spelling");

    const two = privateCalendarDayTile(
      entry({
        tileWithPeople: [{ hrId: "B-110", name: "Hana Abdelaziz Samir Abdelaziz" }],
        managerVisits: [phoenixVisit({ withPeople: [{ hrId: "B-94", name: "Taha Mohamed", role: "Manager" }] })],
      }),
    );
    assert.deepEqual(two?.withNames, ["Hana Abdelaziz Samir Abdelaziz", "Taha Mohamed"], "two people stay two");

    const legacy = privateCalendarDayTile(
      entry({
        tileWith: ["Mina Farouk"],
        managerVisits: [phoenixVisit({ withPeople: [{ name: "mina farouk", role: "District Manager" }] })],
      }),
    );
    assert.deepEqual(legacy?.withNames?.length, 1, "with no HR id on either side, the same text is still one person");
  }

  // ── 1. A visit entry is a summary read from structured fields ────────────────────────────────────────────────
  {
    const tile = privateCalendarDayTile(entry({ tileAreas: ["Nasr City"], tileWith: ["Mina Farouk"] }));
    assert.ok(tile, "a double visit entry makes a tile");
    assert.equal(tile.companion, "double");
    assert.equal(tile.category, "regular");
    assert.deepEqual(tile.split, { am: 2, pm: 1, pharmacies: 1 }, "AM, PM and Pharmacies stay apart — a pharmacy is never inside PM");
    assert.equal(tile.total, 4);
    assert.deepEqual(tile.withNames, ["Mina Farouk"]);
    assert.deepEqual(tile.areas, ["Nasr City"]);
    assert.deepEqual(tile.bricks, []);
    assert.equal(tile.plan, null, "no Phoenix visit, so the plan state is not claimed");
    assert.equal(privateCalendarPlanText(tile.plan), null);

    // The chip's own text lines are NOT the source: with the structured lists removed the tile names nobody, whatever the lines say.
    const bare = privateCalendarDayTile(entry());
    assert.deepEqual(bare?.withNames, [], "never parsed back out of chipLines");
    assert.deepEqual(bare?.areas, []);

    // The employee's own area is the last resort.
    assert.deepEqual(privateCalendarDayTile(entry({ employeeAreaName: "Giza" }))?.areas, ["Giza"]);
    assert.deepEqual(privateCalendarDayTile(entry({ employeeAreaName: "Giza", tileAreas: ["Nasr City"] }))?.areas, ["Nasr City"], "the entry's own area beats the employee's");
  }

  // ── 2. Campaign, chain, single — and planned / unplanned only where a Phoenix visit says it ──────────────────
  {
    assert.equal(privateCalendarDayTile(entry({ activityKind: "single_campaign" }))?.category, "campaign");
    assert.equal(privateCalendarDayTile(entry({ activityKind: "chain_regular" }))?.companion, "chain");

    const visits = [
      phoenixVisit({ id: "rep:1", planned: true }),
      phoenixVisit({
        id: "rep:2",
        planned: true,
        brickName: "Heliopolis 1",
        withPeople: [{ name: "Mina Farouk", role: "District Manager" }, { name: "Nour Samy", role: "Product Manager" }],
      }),
      phoenixVisit({ id: "rep:3", planned: false }),
    ];
    const tile = privateCalendarDayTile(entry({ managerVisits: visits, tileAreas: ["Somewhere else"] }));
    assert.deepEqual(tile?.plan, { planned: 2, unplanned: 1 });
    assert.equal(privateCalendarPlanText(tile?.plan ?? null), "2 planned · 1 unplanned");
    assert.deepEqual(tile?.bricks, ["Nasr City 3", "Heliopolis 1"], "each brick once, in the order met");
    assert.deepEqual(tile?.areas, ["Cairo East"], "the visits' own area beats the entry's");
    assert.deepEqual(tile?.withNames, ["Mina Farouk", "Nour Samy"], "each person once");

    assert.equal(privateCalendarPlanText({ planned: 3, unplanned: 0 }), "Planned");
    assert.equal(privateCalendarPlanText({ planned: 0, unplanned: 2 }), "Unplanned");
    assert.equal(privateCalendarPlanText({ planned: 0, unplanned: 0 }), null);
  }

  // ── 3. Only a visit entry makes a tile ───────────────────────────────────────────────────────────────────────
  {
    for (const activityKind of ["attendance", "vacation", "excuse", "holiday", "plan", "other_crm"] as const) {
      assert.equal(privateCalendarDayTile(entry({ activityKind, visitCounts: null })), null, `${activityKind} keeps its own chip`);
    }
    assert.equal(privateCalendarDayTile(entry({ visitCounts: null })), null, "a visit entry with no count and no visit has nothing to summarise");
    // A pharmacy a manager visited on his own is the third figure, never a half; a doctor on his own list keeps the half it was planned in.
    const own = privateCalendarDayTile(
      entry({
        activityKind: "single_regular",
        managerVisits: [
          phoenixVisit({ id: "own:1", source: "own", kind: "single", bucket: "AM", listType: "Pharmacy", withPeople: [] }),
          phoenixVisit({ id: "own:2", source: "own", kind: "single", bucket: "PM", listType: null, withPeople: [] }),
          phoenixVisit({ id: "own:3", source: "own", kind: "single", bucket: "AM", listType: "AM", awaitingValidation: true, withPeople: [] }),
        ],
        visitCounts: null,
      }),
    );
    assert.deepEqual(own?.split, { am: 0, pm: 1, pharmacies: 1 }, "a pharmacy is apart, a not-yet-validated customer counts in nothing");
  }

  // ── 4. The grid draws no customer in the tile, and the page keeps the house look ─────────────────────────────
  {
    const page = stripComments(readFileSync("src/components/employee-portal/private-calendar.tsx", "utf8"));
    assert.match(page, /function VisitDayTile\(/, "a visit entry has its own tile");
    assert.match(page, /privateCalendarDayTile\(item\)/, "the grid asks the pure builder");
    assert.doesNotMatch(page, /ManagerVisitChipRows/, "the per-visit rows left the tile for the Daily Timeline table");
    assert.doesNotMatch(page, /managerVisitClock|managerVisitCustomerType|managerVisitHalfLabel/, "no per-visit clock, customer or list in the grid");
    assert.match(page, /baseLines\.slice\(0, 2\)/, "a visit entry with no tile prints its kind and counts only — never the customers");
    assert.match(page, /<ManagerPlanActual /, "the visits are still read in full in the Daily Timeline");
    assert.match(page, /bg-violet-600 text-white/, "the pharmacy figure wears the violet of the Phoenix CRM calendar");
    assert.doesNotMatch(page, /rounded-(?:sm|md|lg|xl|full)\b/, "square edges");
    assert.doesNotMatch(page, /\bshadow-(?:sm|md|lg|xl)\b/, "depth comes from the house ladder, never a bare Tailwind shadow");
    assert.match(page, /const panelClass = `overflow-hidden border border-slate-200 bg-white \$\{adminPanelDepthClassName\}`;/, "a panel wears the house panel depth");
    assert.match(page, /\[adminPanelHeaderClassName, "px-5 py-5"\]/, "the dark band is the house token, not a hand-rolled slate-950 with a rule of its own");
    assert.match(page, /whitespace-nowrap font-black uppercase tracking-\[0\.08em\]/, "a figure's label keeps its word whole in a ~90px day column; the number wraps under it instead");

    const tileSource = stripComments(readFileSync("src/lib/private-calendar/day-tile.ts", "utf8"));
    assert.doesNotMatch(tileSource, /chipLines/, "the tile never reads the text lines");

    const doubles = stripComments(readFileSync("src/lib/double-visit-analytics/service.ts", "utf8"));
    assert.match(doubles, /tileWith: companions\.map\(nullableText\)/, "the double-visit loader hands over who the visit was made with as a list");
    const decorate = stripComments(readFileSync("src/lib/private-calendar/service.ts", "utf8"));
    assert.match(decorate, /employeeAreaName: areaByHrId\.get/, "the employee's own area rides on every entry");
  }
}
