import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { stripComments } from "./support/comment-strip.ts";

import {
  groupManagerDayVisits,
  managerDayFigures,
  managerDaySummaryLine,
  managerVisitClock,
  managerVisitCustomerType,
  managerVisitLine,
  managerVisitWhereLines,
  sortManagerDayVisits,
  type ManagerDayVisit,
} from "../src/lib/phoenix-crm/manager-visit-detail.ts";
import { managerOwnVisitItem } from "../src/lib/private-calendar/manager-own-visit-items.ts";

/**
 * A district manager's visits, in full (owner, 2026-10-20): *"when a district manager does visits the visit
 * count only appears in phx calendar and private calendar — no, I want full details: name, address, brick,
 * type, AM/PM, when, single, double, every single detail, in a very premium, polished way."*
 *
 * What this pins:
 *   1. The record behind the count — name, address, brick, customer type, half, the Cairo clock, single or
 *      double — is carried by ONE shape and printed by ONE card, so the manager's day page and the private
 *      calendar can never describe a visit two ways.
 *   2. The page's figures are the calendar cell's own figures: AM · PM · Pharmacies stay apart, a ride-along
 *      whose customer is not validated is held out, and a manager's own single visit never touches a rep's.
 *   3. The manager's cell on the team calendar opens HIS page, and that page is gated by the very list the
 *      calendar draws its manager rows from.
 *   4. The detail read is opt-in on the private calendar: the company-wide pass the Daily Deductions connector
 *      adjudicates stays a count, and a failed detail read leaves the day standing.
 *   5. The house rules hold on the new screens — square edges, nothing that scrolls sideways, no ellipsis.
 */

const ROOT = new URL("../", import.meta.url);

function source(path: string): string {
  return stripComments(readFileSync(new URL(path, ROOT), "utf8"));
}

function visit(overrides: Partial<ManagerDayVisit> = {}): ManagerDayVisit {
  return {
    address: "12 Mostafa El-Nahas St, Nasr City",
    areaName: "Cairo East",
    awaitingValidation: false,
    brickName: "Nasr City 3",
    bucket: "AM",
    comment: null,
    customerName: "Dr. Hala Mansour",
    date: "2026-10-19",
    grade: "A",
    hasPin: true,
    id: "own:1",
    inVacantTerritory: false,
    kind: "single",
    kindLabel: "Single visit, alone",
    listType: null,
    loggedAt: "2026-10-19T08:42:00Z",
    loggedHalf: "AM",
    managerHrId: "B-120",
    pharmacyName: null,
    placeLabel: null,
    placeSource: "saved_place",
    planned: true,
    products: ["Lacto Advanced"],
    source: "own",
    speciality: "Cardiology",
    territoryName: null,
    withPeople: [],
    ...overrides,
  };
}

export function runPhoenixCrmManagerVisitDetailTests(): void {
  // ── 1. The record behind the count ─────────────────────────────────────────────────────────────
  {
    // Cairo, not UTC: 08:42 UTC on 19 Oct 2026 is 11:42 in Cairo (UTC+3 until the end-of-October change).
    assert.equal(managerVisitClock("2026-10-19T08:42:00Z"), "11:42 AM");
    assert.equal(managerVisitClock("2026-10-19T13:05:00Z"), "4:05 PM");
    assert.equal(managerVisitClock(null), "—", "a row that never recorded a moment prints a dash, not 12:00 AM");

    // The address is the street, the brick and the area — each once, none empty, a repeated place never doubled.
    assert.deepEqual(managerVisitWhereLines(visit()), ["12 Mostafa El-Nahas St, Nasr City", "Brick Nasr City 3", "Area Cairo East"]);
    assert.deepEqual(
      managerVisitWhereLines(visit({ address: null, areaName: "Maadi", brickName: null, placeLabel: null })),
      ["Area Maadi"],
      "a visit with only an area prints only that",
    );
    assert.deepEqual(managerVisitWhereLines(visit({ address: null, areaName: null, brickName: null })), [], "no place on file is an empty list, never a placeholder");

    assert.equal(managerVisitCustomerType(visit()), "Cardiology · Grade A");
    assert.equal(managerVisitCustomerType(visit({ listType: "Pharmacy", speciality: null, grade: null })), "Pharmacy");

    // One line for the surfaces that print text (the dispute view, the search box).
    const line = managerVisitLine(visit());
    for (const part of ["11:42 AM", "AM half", "Single visit, alone", "Planned", "Dr. Hala Mansour", "Cardiology · Grade A", "12 Mostafa El-Nahas St", "Brick Nasr City 3", "Area Cairo East"]) {
      assert.ok(line.includes(part), `the one-line version names "${part}": ${line}`);
    }
    const ride = managerVisitLine(
      visit({
        bucket: "PM",
        id: "ride:2:B-120",
        kind: "double",
        kindLabel: "Double visit",
        listType: "PM",
        source: "ride_along",
        withPeople: [{ name: "Mona Adel", role: "Medical rep" }],
      }),
    );
    assert.ok(ride.includes("PM list") && ride.includes("Double visit") && ride.includes("With Mona Adel (Medical rep)"), `a ride-along names its list, its kind and who came: ${ride}`);

    // Earliest first, and a row with no moment goes last — a day is read the way it was lived.
    const sorted = sortManagerDayVisits([
      visit({ id: "c", loggedAt: null }),
      visit({ id: "b", loggedAt: "2026-10-19T11:00:00Z" }),
      visit({ id: "a", loggedAt: "2026-10-19T07:00:00Z" }),
    ]);
    assert.deepEqual(sorted.map((entry) => entry.id), ["a", "b", "c"]);
    const grouped = groupManagerDayVisits([visit({ id: "x" }), visit({ id: "y", date: "2026-10-20" }), visit({ id: "z", managerHrId: "B-121" })]);
    assert.deepEqual([...grouped.keys()].sort(), ["B-120|2026-10-19", "B-120|2026-10-20", "B-121|2026-10-19"]);
  }

  // ── 2. The page's figures are the calendar cell's own ───────────────────────────────────────────
  {
    const figures = managerDayFigures([
      visit({ bucket: "AM", id: "own:1" }),
      visit({ bucket: "AM", id: "own:2" }),
      visit({ bucket: "PM", id: "own:3" }),
      visit({ bucket: "PM", id: "ride:1", kind: "double", kindLabel: "Double visit", listType: "PM", source: "ride_along" }),
      visit({ bucket: "AM", id: "ride:2", kind: "chain", kindLabel: "Chain visit", listType: "AM", source: "ride_along" }),
      visit({ bucket: "PM", id: "ride:3", kind: "double", kindLabel: "Double visit", listType: "Pharmacy", pharmacyName: "Seif Pharmacy", source: "ride_along" }),
      visit({ bucket: "PM", id: "ride:4", kind: "double", kindLabel: "Double visit", listType: "Pharmacy", pharmacyName: "seif pharmacy", source: "ride_along" }),
      // Not validated: real work, counted in nothing, said apart.
      visit({ awaitingValidation: true, bucket: "AM", id: "ride:5", kind: "double", kindLabel: "Double visit", listType: "AM", source: "ride_along" }),
    ]);
    assert.equal(figures.am, 3, "two own AM-half visits and one AM-list chain visit");
    assert.equal(figures.pm, 2, "one own PM-half visit and one PM-list double visit — a pharmacy is never filed among the doctors");
    assert.equal(figures.pharmacies, 1, "one pharmacy named twice in different spelling is one pharmacy");
    assert.equal(figures.awaitingValidation, 1);
    assert.equal(figures.ownSingle, 3);
    assert.equal(figures.doubles, 4, "the not-yet-scored double visit is still a double visit he made");
    assert.equal(figures.chains, 1);
    assert.equal(managerDaySummaryLine(figures), "3 own single visits · 4 double visits · 1 chain visit");
    assert.equal(managerDaySummaryLine(managerDayFigures([visit()])), "1 own single visit");
  }

  // ── 3. The private calendar's entry carries the visits, and still counts nowhere ───────────────
  {
    const day = { am: 1, date: "2026-10-19", hrId: "B-120", pm: 1, visits: 2 };
    const bare = managerOwnVisitItem(day);
    assert.equal(bare.detailLines.length, 2, "the count-only entry is exactly what it was: a kind line and a count line");
    assert.equal(bare.detailLines[1], "Visits: 2");
    assert.equal(bare.managerVisits, undefined, "no details asked, none attached");

    const full = managerOwnVisitItem(day, [visit({ id: "own:1" }), visit({ bucket: "PM", id: "own:2", customerName: "Dr. Samir Fathy", loggedAt: "2026-10-19T13:05:00Z", loggedHalf: "PM" })]);
    assert.equal(full.visitCounts, null, "his own visits count in no figure — the entry still carries no split");
    assert.equal(full.managerVisits?.length, 2);
    assert.ok(full.chipLines?.some((entry) => entry.includes("Dr. Hala Mansour") && entry.includes("Dr. Samir Fathy")), "the chip names the customers");
    assert.ok(full.detailLines.some((entry) => entry.includes("Dr. Hala Mansour") && entry.includes("Brick Nasr City 3")), "the detail lines name the customer and the brick");
    assert.equal(full.source, "field_visit", "it is still his field work to the no-activity engine");
    assert.equal(full.sourceTable, "phoenix_crm_manager_visits");
  }

  // ── 4. The wiring, read from source ─────────────────────────────────────────────────────────────
  {
    const reader = source("src/lib/phoenix-crm/server/manager-visit-details.ts");
    assert.match(reader, /\.from\("phoenix_crm_manager_visits"\)/, "his own visits are read here, in a manager-*.ts file the boundary test allows");
    assert.match(reader, /countsAsManagersDoubleVisit\(visit, hrId\)/, "a ride-along is the rule the manager report judges by");
    assert.match(reader, /\.from\("phoenix_crm_countable_visits"\)/, "and it is read from the countable view like every calendar row");

    const adapter = source("src/lib/phoenix-crm/server/manager-plan-readers.ts");
    assert.match(adapter, /loadManagerOwnVisitDetails,\s*loadManagerRideAlongDetails,\s*loadManagerVisitDetails,/, "an outside screen reads the detail through the one adapter");

    const calendarService = source("src/lib/phoenix-crm/server/team-calendar.ts");
    assert.doesNotMatch(calendarService, /phoenix_crm_manager_visits/, "the calendar service still never names the table");

    const loader = source("src/lib/phoenix-crm/server/manager-day-detail.ts");
    assert.match(loader, /managersInScope\(viewer\.org, viewer\.hrId, viewer\.basis\)/, "the page is gated by the list the calendar draws its manager rows from");
    assert.match(loader, /if \(isTest\) throw forbiddenError\(REFUSED\)/, "the calendar draws no manager row in test mode, so there is no page either");
    assert.match(loader, /if \(!\(await canAccess\(access, "phoenix_crm", "read"\)\)\) return \{ kind: "refused"/, "gate one comes first, as on the rep's day page");
    assert.match(loader, /territorySeatIds: reads/, "ride-alongs are kept only inside territories the viewer already reads");

    const tab = source("src/components/phoenix-crm/calendar-tab.tsx");
    assert.match(tab, /const page = row\.kind === "manager" \? "manager-day" : "day";/, "a manager's cell opens his own page");
    assert.match(tab, /if \(row\.kind === "manager"\) return opensTheDay\(day\);/, "and only on a day he worked");

    const page = source("app/employee-portals/field-crm/manager-day/[seatId]/[date]/page.tsx");
    assert.match(page, /loadPhoenixCrmManagerDayPage\(access,/);
    assert.match(page, /if \(access\.source === "guest"\) redirect\("\/login"\)/);

    const items = source("src/lib/private-calendar/manager-own-visit-items.ts");
    assert.match(items, /options: \{ details\?: boolean \} = \{\}/, "the detail read is opt-in");
    assert.match(items, /catch \{\s*return new Map\(\);/, "a failed detail read leaves the count-only entry standing");

    const service = source("src/lib/private-calendar/service.ts");
    assert.equal((service.match(/loadManagerOwnVisitPrivateCalendarItems\([^)]*\{ details: true \}\)/g) ?? []).length, 2, "the workspace and the dispute view name the visits");
    assert.match(service, /loadManagerOwnVisitPrivateCalendarItems\(hrIds, input\.start, input\.end\),/, "the company-wide pass the deduction connector adjudicates stays a count");

    const calendarScreen = source("src/components/employee-portal/private-calendar.tsx");
    assert.equal((calendarScreen.match(/<ManagerVisitList visits=\{item\.managerVisits\} \/>/g) ?? []).length, 2, "the day list and the timeline both draw the cards");
  }

  // ── 5. The house rules on the new screens ───────────────────────────────────────────────────────
  {
    for (const path of ["src/components/phoenix-crm/manager-visit-card.tsx", "src/components/phoenix-crm/manager-day-view.tsx"]) {
      const text = source(path);
      assert.doesNotMatch(text, /\brounded(?!-none)(?:-[a-z0-9]+)?\b/, `${path}: square edges only`);
      assert.doesNotMatch(text, /overflow-x|whitespace-nowrap|\btruncate\b|text-ellipsis|line-clamp/, `${path}: nothing scrolls sideways and nothing is cut with an ellipsis`);
      assert.doesNotMatch(text, /["'`]use client["'`]/, `${path}: pure markup, drawn the same on the server and the phone`);
    }
    const card = source("src/components/phoenix-crm/manager-visit-card.tsx");
    assert.match(card, /dir="auto"/, "an Arabic customer name keeps its own direction");
    assert.doesNotMatch(card, /\bhrId\b|managerHrId/, "a person is read by name, never by id");

    // The pure module is pure: nothing server-side, nothing framework.
    const pure = readFileSync(new URL("src/lib/phoenix-crm/manager-visit-detail.ts", ROOT), "utf8");
    assert.doesNotMatch(pure, /from "(?:@\/lib\/supabase|@\/lib\/auth|next|react)/, "the rules module stays pure for the phone and the tests");
  }

  console.log("phoenix-crm manager visit details: OK");
}
