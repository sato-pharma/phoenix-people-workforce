import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { stripComments } from "./support/comment-strip.ts";

import {
  groupManagerDayVisits,
  managerDayFigures,
  managerDaySummaryLine,
  managerVisitAreaLines,
  managerVisitHalfLabel,
  managerVisitClock,
  managerVisitCustomerType,
  managerVisitLine,
  managerVisitWhereLines,
  sortManagerDayVisits,
  type ManagerDayVisit,
} from "../src/lib/phoenix-crm/manager-visit-detail.ts";
import { phoenixCrmDayPath } from "../src/lib/phoenix-crm/modules.ts";
import { buildPlanVsActual, planCustomerKey, type ManagerDayPlan } from "../src/lib/phoenix-crm/manager-day-plan.ts";
import {
  managerVisitPlaceNote,
  managerVisitTerritoryLine,
  planActualRowWords,
  planActualSaysNoPlan,
  VISIT_PLANNED_LABEL,
  VISIT_UNPLANNED_LABEL,
  visitsOnlyRows,
} from "../src/lib/phoenix-crm/manager-visit-table.ts";
import { ownVisitBucket } from "../src/lib/phoenix-crm/server/manager-plan-readers.ts";
import { managerOwnVisitItem } from "../src/lib/private-calendar/manager-own-visit-items.ts";
import type { PrivateCalendarItem } from "../src/lib/private-calendar/logic.ts";
import { attachVisitDetails } from "../src/lib/private-calendar/visit-detail-items.ts";
import { managerOwnVisitValues } from "../src/lib/phoenix-crm/visit-report-own-visits.ts";

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
 *   6. The day is a PLAN-AGAINST-ACTUAL table (owner, 2026-10-20): each planned customer is set beside the visit
 *      that answers it, matched by customer key and by the right source; a visit nobody planned is its own row;
 *      a week that was never sent is not judged.
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

    // 🔴 HIS OWN VISIT COUNTS BY HIS CUSTOMER'S LIST, AND A PHARMACY IS COUNTED APART (owner, 2026-10-23: "if a manager
    //    himself added a visit to a pharmacy, it should be count, but in a different color, and separate"). Only a
    //    customer of Manager's own list — which carries no list — falls back to the half he logged it in.
    const own = managerDayFigures([
      visit({ bucket: "AM", id: "own:1", listType: "Pharmacy", pharmacyName: "El Ezaby" }),
      visit({ bucket: "AM", id: "own:2", listType: "PM" }),
      visit({ bucket: "PM", id: "own:3", listType: null }),
    ]);
    assert.equal(own.pharmacies, 1, "his own pharmacy visit is a pharmacy, whatever the hour");
    assert.equal(own.am, 0, "never filed in the morning half it was logged in");
    assert.equal(own.pm, 2, "a PM-list customer at 10 am is PM, and his own-list customer keeps his half");
    assert.equal(own.ownSingle, 3, "and all three are still his own single visits");
    assert.equal(ownVisitBucket("Pharmacy", "AM"), "Pharmacies");
    assert.equal(ownVisitBucket("PM", "AM"), "PM", "a rep customer's list wins over the half");
    assert.equal(ownVisitBucket("AM", "PM"), "AM");
    assert.equal(ownVisitBucket(null, "PM"), "PM", "a customer of his own list falls back to the half");
    assert.equal(ownVisitBucket("Other", "AM"), "AM", "an unknown list is never a pharmacy");
  }

  // ── 3. The private calendar's entry carries the visits, and counts in his own figures ─────────
  {
    const day = { am: 1, date: "2026-10-19", hrId: "B-120", pm: 1, visits: 2 };
    const bare = managerOwnVisitItem(day);
    assert.deepEqual(bare.detailLines, [], "the count-only entry has no detail line: its kind is the chip's first line and its count is the title (said once)");
    assert.equal(bare.managerVisits, undefined, "no details asked, none attached");

    const full = managerOwnVisitItem(day, [visit({ id: "own:1" }), visit({ bucket: "PM", id: "own:2", customerName: "Dr. Samir Fathy", loggedAt: "2026-10-19T13:05:00Z", loggedHalf: "PM" })]);
    assert.equal(full.visitCounts, null, "a day read with no split carries none");
    const split = { am: 1, pharmacies: 1, pm: 0 };
    assert.deepEqual(managerOwnVisitItem({ ...day, split }).visitCounts, split, "his own visits count in his own figures, pharmacies apart (owner, 2026-10-23)");
    assert.equal(full.managerVisits?.length, 2);
    assert.ok(full.chipLines?.some((entry) => entry.includes("Dr. Hala Mansour") && entry.includes("Brick Nasr City 3")), "the chip lists a visit with its name and its brick");
    assert.ok(full.chipLines?.some((entry) => entry.includes("Dr. Hala Mansour") && entry.includes("Area Cairo East")), "the chip names the brick AND the area");
    assert.ok(!full.chipLines?.some((entry) => entry.includes("12 Mostafa El-Nahas St")), "the calendar itself never prints the street address — that is the details' (owner, 2026-10-20)");
    assert.ok(full.detailLines.some((entry) => entry.includes("12 Mostafa El-Nahas St")), "the details still print the address");
    assert.deepEqual(managerVisitAreaLines(visit()), ["Brick Nasr City 3", "Area Cairo East"], "the calendar's place is the brick then the area, no street");
    assert.equal(managerVisitHalfLabel(visit()), "AM half", "his own visit is counted in a half");
    assert.equal(managerVisitHalfLabel(visit({ listType: "Pharmacy", source: "ride_along" })), "Pharmacy", "a pharmacy is its own word, never inside a half");
    assert.ok(full.chipLines?.some((entry) => entry.includes("Dr. Samir Fathy")), "and the next visit on a line of its own");
    assert.ok(!full.chipLines?.some((entry) => entry.includes("Dr. Hala Mansour") && entry.includes("Dr. Samir Fathy")), "never two customers squeezed onto one line");
    assert.ok(!full.chipLines?.some((entry) => /\+\d+ more/.test(entry)) && !/\+\d+ more/.test(full.title), "and never shortened to '+N more'");
    assert.ok(full.detailLines.some((entry) => entry.includes("Dr. Hala Mansour") && entry.includes("Brick Nasr City 3")), "the detail lines name the customer and the brick");
    assert.equal(full.source, "field_visit", "it is still his field work to the no-activity engine");
    assert.equal(full.sourceTable, "phoenix_crm_manager_visits");
  }

  // ── 4. The wiring, read from source ─────────────────────────────────────────────────────────────
  {
    // The CRM field-visit chip lists every customer on a line of its own too, never "A, B, C +4 more".
    const fieldVisits = source("src/lib/private-calendar/field-visits.ts");
    assert.doesNotMatch(fieldVisits, /\+\$\{[^}]*\} more/, "no customer list is cut to three and counted");
    assert.match(fieldVisits, /\.\.\.customerList,/, "the chip carries one line per customer");
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
    assert.match(tab, /row\.kind === "manager" \? "manager" : "rep"/, "a manager's cell asks for the manager's page");
    assert.equal(
      phoenixCrmDayPath("portal", "manager", "SEAT-1", "2026-10-13", false),
      "/employee-portals/field-crm/manager-day/SEAT-1/2026-10-13",
      "a manager's cell opens his own page",
    );
    // The admin calendar opens the admin day (owner, 2026-10-24: "Admin tab plus a map").
    assert.equal(
      phoenixCrmDayPath("admin", "manager", "SEAT-1", "2026-10-13", true),
      "/admin/field-crm/manager-day/SEAT-1/2026-10-13?test=1",
      "in the shell the calendar was read in",
    );
    assert.match(
      tab,
      /if \(row\.kind === "manager"\) return opensTheDay\(day\) \|\| \(entryThrough !== null && opensForMissedRecords\(day\.day, entryThrough\)\);/,
      "and only on a day he worked — except for the Super Admin, whose `entryThrough` alone is set (2026-10-24: he enters what a manager missed)",
    );

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
    assert.equal(
      (calendarScreen.match(/<ManagerPlanActual plan=\{item\.managerPlan \?\? null\} planUnread=\{item\.managerPlanUnread === true\} visits=\{item\.managerVisits\} visitsOnly \/>/g) ?? []).length,
      2,
      "the day list and the timeline both draw the plan-against-actual table — the visits alone when the entry carries no plan",
    );
    // The polish pass on the screen itself (owner, 2026-10-20: "premium polish, full polish").
    // Owner, 2026-10-23: the month cell is a SUMMARY — counts and tags, no customer — and a visit is read in full in the table
    // under the grid. (It used to draw a block per visit, `ManagerVisitChipRows`; see private-calendar-day-tile.test.ts.)
    assert.doesNotMatch(calendarScreen, /ManagerVisitChipRows/, "a month cell no longer lists a manager's visits one by one");
    assert.match(calendarScreen, /<VisitDayTile item=\{item\} key=\{item\.id\} tile=\{tile\} viewMode=\{viewMode\} \/>/, "a visit entry is drawn as a tile of counts and tags");
    assert.match(calendarScreen, /item\.managerVisits && item\.managerVisits\.length > 0 \? "lg:col-span-full" : ""/, "a day that carries a table takes the whole row of the timeline");
    assert.match(calendarScreen, /shownWeeks = useMemo\(\(\) => weeks\.filter\(\(week\) => week\.some\(\(day\) => day\.inMonth\)\)/, "a week with no day of the month is not drawn");
    assert.match(calendarScreen, /\{shownWeeks\.flatMap\(\(week\) => week\)/, "the grid draws the shown weeks");
    // The day slot draws what was recorded, of every type, and never the plan (owner, 2026-10-20).
    assert.match(calendarScreen, /function isRecordedEntry\(item: PrivateCalendarItem\) \{\s*\n\s*return privateCalendarItemKind\(item\) !== "plan";/, "a recorded entry is every type but the plan");
    assert.match(calendarScreen, /const dayItems = \(date \? itemsByDay\.get\(date\) \?\? \[\] : \[\]\)\.filter\(isRecordedEntry\);/, "the day slot never draws a plan");
    assert.match(calendarScreen, /sortTimelineItems\(withoutPlanDrawnByATable\(selectedItems\)\)/, "the detail shows the table once, not the table and the plan's own cards");
    assert.match(calendarScreen, /sortTimelineItems\(withoutPlanDrawnByATable\(itemsByDay\.get\(date\) \?\? \[\]\)\)/, "the list view does the same");
    assert.match(calendarScreen, /presentKinds\.filter\(\(kind\) => kind !== "plan"\)\.map\(\(kind\) => \{/, "the colour key names the recorded kinds the day slot draws, never the plan");
    assert.match(calendarScreen, /max-w-\[45%\] shrink-0 break-words bg-phx-paper/,"a status word never breaks in the corner of an entry");
    assert.match(calendarScreen, /employeeOptionLabel\(employee, showHrIds\)/, "names, never codes, on the employee surface");
    assert.match(calendarScreen, /aria-label=\{\s*\n\s*date\s*\n/, "a day cell says its date and what it holds to a screen reader");
    assert.doesNotMatch(calendarScreen, /font-mono text-phx-xs font-semibold text-slate-500/, "a date is a date, not a code in a monospace face");
    assert.match(items, /plans\.plans\.get\(`\$\{personKey\(day\.hrId\)\}\|\$\{day\.date\}`\)/, "the entry carries the plan of its own day");
    assert.match(items, /return \{ plans: new Map\(\), unread: true \}/, "a plan that fails to load is flagged on the entry and never takes the day away");
  }

  // ── 5. The house rules on the new screens ───────────────────────────────────────────────────────
  {
    for (const path of ["src/components/phoenix-crm/manager-plan-actual-table.tsx", "src/components/phoenix-crm/manager-day-view.tsx"]) {
      const text = source(path);
      assert.doesNotMatch(text, /\brounded(?!-none)(?:-[a-z0-9]+)?\b/, `${path}: square edges only`);
      assert.doesNotMatch(text, /overflow-x|whitespace-nowrap|\btruncate\b|text-ellipsis|line-clamp/, `${path}: nothing scrolls sideways and nothing is cut with an ellipsis`);
      assert.doesNotMatch(text, /["'`]use client["'`]/, `${path}: pure markup, drawn the same on the server and the phone`);
    }
    const card = source("src/components/phoenix-crm/manager-plan-actual-table.tsx");
    assert.match(card, /dir="auto"/, "an Arabic customer name keeps its own direction");
    assert.doesNotMatch(card, /\bhrId\b|managerHrId/, "a person is read by name, never by id");

    // The pure module is pure: nothing server-side, nothing framework.
    const pure = readFileSync(new URL("src/lib/phoenix-crm/manager-visit-detail.ts", ROOT), "utf8");
    assert.doesNotMatch(pure, /from "(?:@\/lib\/supabase|@\/lib\/auth|next|react)/, "the rules module stays pure for the phone and the tests");
  }

  // ── 6. Plan against actual ──────────────────────────────────────────────────────────────────────
  {
    assert.equal(planCustomerKey("abc", "m1"), "c:abc", "a customer on a rep's list wins");
    assert.equal(planCustomerKey(null, "m1"), "m:m1");
    assert.equal(planCustomerKey("", " "), null);

    const customer = (name: string, key: string, outcome: "done" | "not_done" | "open", label: string) => ({
      flagLabel: null,
      key,
      name,
      outcome,
      outcomeLabel: label,
      own: key.startsWith("m:"),
      place: null,
    });
    const plan: ManagerDayPlan = {
      halves: [
        {
          customers: [customer("Dr. Ola Fahmy", "c:ola", "done", "Done"), customer("Dr. Nabil Saad", "c:nabil", "not_done", "Not done")],
          half: "AM",
          kind: "with_rep",
          kindLabel: "With a rep",
          note: "Cover the new brick",
          title: "With Ahmed Ali",
        },
        {
          customers: [customer("Dr. Hala Mansour", "m:hala", "done", "Done")],
          half: "PM",
          kind: "single_visit",
          kindLabel: "Single visit",
          note: null,
          title: "Single visit · Nasr City",
        },
        { customers: [], half: "PM", kind: "admin", kindLabel: "Admin", note: null, title: "Training" },
      ],
      sent: true,
      statusLine: "Approved",
    };
    const ride = visit({ bucket: "AM", customerKey: "c:ola", customerName: "Dr. Ola Fahmy", id: "ride:1", kind: "double", kindLabel: "Double visit", source: "ride_along" });
    const own = visit({ bucket: "PM", customerKey: "m:hala", id: "own:1" });
    const extra = visit({ bucket: "AM", customerKey: "c:zed", customerName: "Dr. Zed Kamel", id: "own:9", loggedAt: "2026-10-19T09:10:00Z", planned: false });
    const wrongSource = visit({ bucket: "AM", customerKey: "c:nabil", customerName: "Dr. Nabil Saad", id: "own:5" });

    const { rows, summary } = buildPlanVsActual(plan, [extra, wrongSource, ride, own]);
    const answer = (name: string) => rows.find((row) => row.plan?.customerName === name || row.actual?.customerName === name);
    assert.equal(answer("Dr. Ola Fahmy")?.actual?.id, "ride:1", "the rep's visit on the planned customer answers the with-a-rep row");
    assert.equal(answer("Dr. Ola Fahmy")?.outcomeLabel, "Done");
    assert.equal(rows.find((row) => row.plan?.customerName === "Dr. Nabil Saad")?.actual, null, "his own single visit never answers a with-a-rep row");
    assert.equal(rows.find((row) => row.plan?.customerName === "Dr. Nabil Saad")?.outcome, "not_done", "the verdict is the report's, not this file's");
    assert.equal(rows.find((row) => row.plan?.customerName === "Dr. Hala Mansour")?.actual?.id, "own:1", "matched by the manager's own customer key");
    assert.equal(rows.find((row) => row.plan?.kind === "admin")?.outcome, "not_checkable", "an admin half-day is shown, never judged");
    assert.deepEqual(
      rows.filter((row) => row.outcome === "unplanned").map((row) => row.actual?.id).sort(),
      ["own:5", "own:9"],
      "a visit nobody planned is a row of its own, the wrong-source one included",
    );
    assert.deepEqual(summary, { done: 2, notDone: 1, open: 0, planned: 3, unplanned: 2 }, "the strip counts the day's customers, not the half-days");
    assert.deepEqual(rows.map((row) => row.half), ["AM", "AM", "AM", "AM", "PM", "PM"].slice(0, rows.length), "AM before PM");

    const unsent = buildPlanVsActual({ ...plan, sent: false }, [ride, own]);
    assert.ok(unsent.rows.every((row) => row.outcome === "no_plan" && row.plan === null), "a week that was never sent is not judged");
    assert.equal(unsent.summary.planned, 0);
    const unread = buildPlanVsActual(null, [ride]);
    assert.equal(unread.rows[0]?.outcomeLabel, "No plan sent", "a plan that could not be read judges nothing");

    const table = source("src/components/phoenix-crm/manager-plan-actual-table.tsx");
    // ONE table, four columns, in the owner's order (2026-10-20): the plan, the actual status (matching or not), the area and
    // brick of the actual, then the address and the time.
    const headers = [...table.matchAll(/<th className=\{TH_CLASS\}>([^<]+)<\/th>/g)].map((match) => match[1]);
    assert.deepEqual(headers.slice(0, 4), ["Plan", "Actual status", "Area · Brick", "Address · Time"], "one table: plan, actual status, area and brick, address and time — in that order");
    // The visits alone (an entry with no manager plan, 2026-10-29) drop the Plan column and keep the rest in the same order.
    assert.deepEqual(headers.slice(4), ["Visit", "Area · Brick", "Address · Time"], "the visits-only table: the visit with its own Planned or Unplanned, then where and when");
    assert.match(table, /<CrmTable columns=\{\["20%", "36%", "17%", "27%"\]\} desktopOnly=\{false\}>/, "the module's one table primitive (fixed layout, colgroup), four named widths that fill the panel — and shown by the container query, never the viewport");
    assert.doesNotMatch(table, /colSpan/, "the rest of a visit's record sits in its own status cell — never a fifth column, never a spanning row (owner, 2026-10-28)");
    assert.match(source("src/lib/phoenix-crm/manager-visit-table.ts"), /done: "Matches the plan\.",/, "a planned customer that was visited reads as matching the plan");
    assert.doesNotMatch(table, /<table\b/, "no raw <table> in the module: the fits-the-screen golden rule");
    assert.match(table, /@min-\[720px\]:hidden/, "cards when the PANEL is narrow — the private calendar day sits in a narrow column on a wide screen");
    assert.match(table, /@container/, "the switch is the container's width, not the viewport's");
    const dayView = source("src/components/phoenix-crm/manager-day-view.tsx");
    assert.match(dayView, /buildPlanVsActual\(view\.plan, visits\)/, "the page sets the plan beside the visits");
    const loader = source("src/lib/phoenix-crm/server/manager-day-detail.ts");
    assert.match(loader, /computeManagerReports\(viewer, \[subject\.hrId\], fieldWeekStart\(date\)/, "the plan is the weekly report's own read");
    assert.match(loader, /planUnread = true/, "a failed plan read is said, never shown as no plan");
    for (const path of ["src/components/phoenix-crm/manager-plan-actual-table.tsx", "src/lib/phoenix-crm/manager-day-plan.ts", "src/lib/phoenix-crm/manager-visit-table.ts"]) {
      const text = source(path);
      assert.doesNotMatch(text, /\brounded(?!-none)(?:-[a-z0-9]+)?\b/, `${path}: square edges only`);
      assert.doesNotMatch(text, /overflow-x|whitespace-nowrap|\btruncate\b|text-ellipsis|line-clamp/, `${path}: nothing scrolls sideways and nothing is cut`);
      assert.doesNotMatch(text, /["'`]use client["'`]/, `${path}: pure`);
      assert.doesNotMatch(text, /from "(?:@\/lib\/supabase|@\/lib\/auth|next)/, `${path}: nothing server-side`);
    }
  }

  everyonesVisitsInFull();
  ownVisitWithHerManager();
  everyFactSaidOnce();

  console.log("phoenix-crm manager visit details: OK");
}

/**
 * 🔴 HER OWN VISIT ON A WITH MY MANAGER HALF-DAY IS A VISIT WITH THAT MANAGER, NEVER "SINGLE VISIT, ALONE" (owner,
 * 2026-10-27: "she submitted but it appeared as single visit, it should count with her manager"). The visit is logged
 * in her own table against the half-day (`plan_slot_id`); the reader names the manager from that half-day's
 * `senior_visit`, the figures count it apart from her alone ones, and the plan-against-actual table matches it to the
 * customer she planned on that half — a single-visit half never takes it, and a With my manager half never takes an
 * alone visit.
 */
function ownVisitWithHerManager(): void {
  const withMagdy = visit({
    bucket: "PM",
    customerKey: "c:khaled",
    customerName: "Dr. Khaled Youssef",
    id: "own:w1",
    kind: "with_senior",
    kindLabel: "Visit with a manager",
    withPeople: [{ hrId: "AI-0008", name: "Magdy El Senosey", role: "National sales manager" }],
  });

  const figures = managerDayFigures([withMagdy, visit({ id: "own:alone" })]);
  assert.equal(figures.ownWithSenior, 1, "the visit with her manager is counted as one");
  assert.equal(figures.ownSingle, 1, "and never among the visits she made alone");
  assert.equal(managerDaySummaryLine(figures), "1 own single visit · 1 visit with a manager");
  assert.match(managerVisitLine(withMagdy), /Visit with a manager .*With Magdy El Senosey \(National sales manager\)/, "the line names who she went with");
  assert.doesNotMatch(managerVisitLine(withMagdy), /Single visit, alone/);

  const customer = { flagLabel: null, key: "c:khaled", name: "Dr. Khaled Youssef", outcome: "done" as const, outcomeLabel: "Done", own: false, place: null };
  const half = (kind: "with_senior" | "single_visit") => ({ customers: [customer], half: "PM" as const, kind, kindLabel: kind, note: null, title: kind });
  const answered = buildPlanVsActual({ halves: [half("with_senior")], sent: true, statusLine: "Approved" }, [withMagdy]);
  assert.equal(answered.rows.find((row) => row.plan?.kind === "with_senior")?.actual?.id, "own:w1", "her visit answers the customer she planned with her manager");
  assert.equal(answered.summary.unplanned, 0, "and is never a second, unplanned row");
  const alone = buildPlanVsActual({ halves: [half("with_senior")], sent: true, statusLine: "Approved" }, [visit({ customerKey: "c:khaled", id: "own:a1" })]);
  assert.equal(alone.rows.find((row) => row.plan?.kind === "with_senior")?.actual, null, "a visit she made alone never answers a With my manager half");
  const single = buildPlanVsActual({ halves: [half("single_visit")], sent: true, statusLine: "Approved" }, [withMagdy]);
  assert.equal(single.rows.find((row) => row.plan?.kind === "single_visit")?.actual, null, "and a visit with her manager never answers a single-visit half");

  assert.equal(managerOwnVisitValues(withMagdy, "Weam").visitType, "Manager's own visit · with Magdy El Senosey", "the Visit Report row names him, and stays her own row");
  assert.equal(managerOwnVisitValues(visit(), "Weam").visitType, "Manager's own visit");

  const loader = stripComments(source("src/lib/phoenix-crm/server/manager-visit-details.ts"));
  assert.match(loader, /const OWN_COLUMNS =\s*"[^"]*\bplan_slot_id";/, "the reader reads the half-day each visit was logged on");
  assert.match(loader, /\.from\("phoenix_crm_manager_plan_slots"\)\.select\("id, kind, senior_visit"\)\.in\("id", part\)\.eq\("kind", "with_senior"\)/, "and that half-day's manager, With my manager halves only");
  assert.match(loader, /kind: senior \? "with_senior" : "single",/, "a visit on such a half is a visit with that manager");
  const today = stripComments(source("src/lib/phoenix-crm/server/manager-visits.ts"));
  assert.match(today, /withSenior: seniorOfSlot\.has\(row\.slotId\) \?/, "the My single visits list names the manager on that half's customers");
  assert.match(source("src/components/phoenix-crm/manager-single-visits.tsx"), /\{customer\.withSenior \? <CrmPill tone="info">/, "and shows it on the card");
}

function item(overrides: Partial<PrivateCalendarItem>): PrivateCalendarItem {
  return {
    approvalImpact: null,
    description: null,
    detailLines: [],
    employeeDepartmentName: null,
    employeeHrId: "B-300",
    employeeJobTitle: null,
    employeeLineName: null,
    employeeName: null,
    endDate: "2026-10-19",
    exceptionFlags: [],
    id: "x",
    managerName: null,
    severity: "success",
    source: "field_visit",
    sourceLabel: "",
    sourceRecordId: null,
    sourceSystem: "",
    sourceTable: null,
    startDate: "2026-10-19",
    status: "performed",
    time: null,
    title: "",
    ...overrides,
  };
}

/**
 * ── 7. Everyone's visits, exactly as Mina Farouk's (owner, 2026-10-21) ────────────────────────────────────────────
 * "make everyone's visits appear in details in private calendar and phoenix crm calendar exactly as mina farouk".
 * A rep's own visit is the same record (`source: "rep"`), drawn by the same table, and on the private calendar it
 * hangs on the ONE entry of his day that already counts it — never a new entry, never two.
 */
function everyonesVisitsInFull(): void {
  const repVisit = (overrides: Partial<ManagerDayVisit> = {}) =>
    visit({ bucket: "AM", id: "rep:1", listType: "AM", managerHrId: "B-300", source: "rep", ...overrides });

  // The record reads as a rep's: his customer's list, never "his half"; a pharmacy is its own word.
  assert.equal(managerVisitHalfLabel(repVisit()), "AM list");
  assert.equal(managerVisitHalfLabel(repVisit({ listType: "Pharmacy" })), "Pharmacy");

  // His figures: a single visit is counted as one, a double as a double, AM · PM · Pharmacies apart.
  const figures = managerDayFigures([
    repVisit({ id: "rep:1" }),
    repVisit({ bucket: "PM", id: "rep:2", listType: "PM" }),
    repVisit({ bucket: "PM", id: "rep:3", kind: "double", kindLabel: "Double visit", listType: "PM", withPeople: [{ name: "Mina Farouk", role: "Manager" }] }),
    repVisit({ bucket: "Pharmacy", id: "rep:4", listType: "Pharmacy", pharmacyName: "Seif Pharmacy" }),
  ]);
  assert.equal(figures.am, 1);
  assert.equal(figures.pm, 2, "a pharmacy is never filed among the doctors");
  assert.equal(figures.pharmacies, 1, "a rep's pharmacy call is counted apart, as on his cell");
  assert.equal(figures.singles, 3, "his own single visits are counted as his");
  assert.equal(figures.doubles, 1);
  assert.equal(figures.ownSingle, 0, "a rep's visit is never a manager's own single visit");

  // The plan column: the visit answers for itself — never "No plan sent" about a rep.
  const { rows } = buildPlanVsActual(null, [repVisit({ id: "rep:1" }), repVisit({ id: "rep:2", planned: false })]);
  assert.deepEqual(
    rows.map((row) => [row.actual?.id, row.outcome, row.outcomeLabel]),
    [
      ["rep:1", "done", "On the plan"],
      ["rep:2", "unplanned", "Not on the plan"],
    ],
  );
  const table = source("src/components/phoenix-crm/manager-plan-actual-table.tsx");
  // What HIS week said is said once — the status chip — never again in the plan column or in a sentence under it.
  assert.deepEqual(
    rows.map((row) => [planActualRowWords(row).verdict, planActualRowWords(row).sentence]),
    [
      ["On the plan", null],
      ["Not on the plan", null],
    ],
  );
  assert.match(table, /if \(!row\.plan\) return <HalfChip half=\{row\.half\} \/>;/, "a row nobody planned holds its half in the plan column, and nothing more");

  // A ride-along or a rep's day carries no manager plan: its visits are drawn ALONE, each Planned or Unplanned by its
  // own flag — the very flag the month tile counts. Owner, 2026-10-29: 6 Oct's tile said "7 planned · 1 unplanned"
  // while the table under it said "No sent plan covers this day" and called none of them planned.
  {
    const ownFlag = visitsOnlyRows([
      visit({ bucket: "PM", id: "v:pm", listType: "PM", planned: false }),
      visit({ bucket: "AM", id: "v:am", planned: true }),
    ]);
    assert.deepEqual(
      ownFlag.map((row) => [row.half, row.outcomeLabel, row.plan]),
      [["AM", VISIT_PLANNED_LABEL, null], ["PM", VISIT_UNPLANNED_LABEL, null]],
      "AM before PM, each visit's own Planned or Unplanned, no plan column to judge against",
    );
    assert.deepEqual([VISIT_PLANNED_LABEL, VISIT_UNPLANNED_LABEL], ["Planned", "Unplanned"], "Phoenix CRM's own words");
    assert.match(table, /if \(visitsOnly && !plan && !planUnread\) \{/, "only an entry with no plan — and no plan that failed to load — draws the visits alone");
    assert.match(table, /\{visit && !visitsOnly \? <Chip className=\{KIND_STYLES\[visit\.kind\]\}>/, "the visits-only rows print no kind chip — the entry's own headline already says it");
  }

  // The private calendar: the visits hang on the entry that already counts them.
  const door = item({
    activityKind: "single_regular",
    chipLines: ["Single · Regular", "AM 1 · PM 1", "AM · Dr. Hala Mansour · Cardiology", "PM · Dr. Samir Fathy"],
    detailLines: ["Kind: Single · Regular", "Visits: AM 1 · PM 1 · Pharmacies 0", "Customer 1: AM · Dr. Hala Mansour · Cardiology"],
    id: "field-visit-B-300|2026-10-19|single_regular",
  });
  const received = item({
    activityKind: "double_regular",
    chipLines: ["Double · Regular", "With Mina Farouk", "PM 1", "Cairo East"],
    detailLines: ["Kind: Double · Regular"],
    id: "double-visit-received-double_regular-B-300-2026-10-19",
    source: "double_visit",
    status: "received",
  });
  const performed = item({
    activityKind: "double_regular",
    chipLines: ["Double · Regular", "With Rami Adel", "PM 1", "Cairo East"],
    employeeHrId: "B-116",
    id: "double-visit-performed-double_regular-B-116-2026-10-19",
    source: "double_visit",
    status: "performed",
  });
  const untouched = item({ id: "attendance-B-300-2026-10-19", source: "attendance" });
  const single = repVisit({ id: "rep:1" });
  const double = repVisit({ bucket: "PM", id: "rep:2", kind: "double", kindLabel: "Double visit", listType: "PM" });
  const ride = visit({ bucket: "PM", id: "ride:2:B-116", kind: "double", kindLabel: "Double visit", listType: "PM", managerHrId: "B-116", source: "ride_along" });
  const ownOfAManager = visit({ id: "own:7", managerHrId: "B-116" });
  const elsewhere = repVisit({ date: "2026-10-20", id: "rep:9" });

  const out = attachVisitDetails([door, received, performed, untouched], [single, double, ride, ownOfAManager, elsewhere, single]);
  assert.equal(out.length, 4, "no entry is ever added or taken away — coverage is the loaders', never a detail read's");
  const [doorOut, receivedOut, performedOut, untouchedOut] = out;
  assert.deepEqual(doorOut.managerVisits?.map((entry) => entry.id), ["rep:1"], "his single visit sits on his single entry, once");
  assert.deepEqual(receivedOut.managerVisits?.map((entry) => entry.id), ["rep:2"], "his double visit on the double entry");
  assert.deepEqual(performedOut.managerVisits?.map((entry) => entry.id), ["ride:2:B-116"], "the manager's ride-along on HIS performed entry");
  assert.equal(untouchedOut, untouched, "an entry that gains nothing is the same object");
  assert.deepEqual(doorOut.chipLines?.slice(0, 2), ["Single · Regular", "AM 1 · PM 1"], "the entry's own head stays");
  assert.ok(!doorOut.chipLines?.some((line) => line === "PM · Dr. Samir Fathy"), "the door's short customer list gives way to the full record");
  assert.ok(doorOut.chipLines?.some((line) => line.includes("Dr. Hala Mansour") && line.includes("Brick Nasr City 3")), "the chip names the customer and the brick");
  assert.ok(!doorOut.chipLines?.some((line) => line.includes("12 Mostafa El-Nahas St")), "and never the street — that is the details'");
  assert.ok(doorOut.detailLines.some((line) => line.includes("12 Mostafa El-Nahas St")), "the details print the address");
  assert.ok(!doorOut.detailLines.some((line) => line.startsWith("Customer 1:")), "the old customer line is not printed twice");
  assert.deepEqual(receivedOut.chipLines?.slice(0, 4), received.chipLines, "a double entry keeps every line it had, the visits under it");
  assert.equal(doorOut.chipLines?.length, 2 + 1, "the cell draws the visits as the LAST managerVisits.length lines");

  // A team not started: the Phoenix entry carries the whole day, and the iReports360 entry beside it is left alone.
  const evidence = item({
    activityKind: "single_regular",
    chipLines: ["Single · Regular", "Phoenix CRM: 2 visits"],
    detailLines: ["Kind: Single · Regular", "Visits: 2"],
    id: "phoenix-work-B-300|2026-10-19",
  });
  const [doorBeside, evidenceOut] = attachVisitDetails([door, evidence], [single, double]);
  assert.equal(doorBeside, door, "his iReports360 list keeps its own customers");
  assert.deepEqual(evidenceOut.managerVisits?.map((entry) => entry.id), ["rep:1", "rep:2"], "the Phoenix entry lists every Phoenix visit of the day in full");
  assert.deepEqual(attachVisitDetails([untouched], [single]), [untouched], "a visit with no entry to sit on is never given one");

  // A manager's own entry keeps its own visits and takes his ride-alongs beside them, in time order.
  const managerItem = managerOwnVisitItem({ am: 1, date: "2026-10-19", hrId: "B-116", pm: 0, visits: 1 }, [visit({ id: "own:7", managerHrId: "B-116" })]);
  const [managerOut] = attachVisitDetails([managerItem], [ride]);
  assert.deepEqual(managerOut.managerVisits?.map((entry) => entry.id), ["own:7", "ride:2:B-116"]);
  assert.equal(managerOut.chipLines?.length, (managerItem.chipLines?.length ?? 0) + 1, "his head lines stay, one line per visit after them");

  // The wiring.
  const service = source("src/lib/private-calendar/service.ts");
  assert.equal((service.match(/loadPrivateCalendarVisitDetails\(/g) ?? []).length, 2, "the workspace and the dispute view read every visit in full");
  assert.equal((service.match(/attachVisitDetails\(/g) ?? []).length, 2, "and hang it on the entries they already built");
  const reader = source("src/lib/phoenix-crm/server/manager-visit-details.ts");
  assert.match(reader, /export async function loadRepVisitDetails\(/);
  assert.match(reader, /const record = countableVisitRecord\(row, rep, "rep", facts, input\.territoryNameOf\);/, "one mapping for a rep's visit and a ride-along");
  const dayLoader = source("src/lib/phoenix-crm/server/day-detail.ts");
  assert.match(dayLoader, /visitsInFull = await loadRepVisitDetails\(\{/, "the rep's Phoenix CRM day page reads the same records");
  assert.match(dayLoader, /visitsInFullUnread = true;/, "and says so when it cannot");
  const dayView = source("src/components/phoenix-crm/day-detail-view.tsx");
  assert.match(dayView, /<ManagerPlanActual plan=\{null\} planUnread=\{false\} visits=\{view\.visitsInFull\} \/>/, "drawn as the same table Mina's day page draws");
  const calendarScreen = source("src/components/employee-portal/private-calendar.tsx");
  assert.match(calendarScreen, /\(item\.managerPlan \|\| item\.managerPlanUnread\) && item\.employeeHrId/, "only a table that draws a plan hides the plan's own entries");
}

/**
 * Every fact said once (owner, 2026-10-28, on a district manager's day with no sent plan: four double visits with one
 * rep, each saying "no plan" four times, its half twice, its customer's type twice, its area twice, "a location was
 * captured" on every row, and its detail line drawn as a second row under it).
 */
function everyFactSaidOnce(): void {
  const ride = visit({
    areaName: "Menoufia 2",
    brickName: "Menouf",
    customerKey: "c:menouf",
    customerName: "Menouf General Hospital",
    id: "ride:aya:1",
    kind: "double",
    kindLabel: "Double visit",
    listType: "AM",
    placeLabel: "Hospital",
    source: "ride_along",
    speciality: "Hospital",
    territoryName: "Menoufia 2 · Anti Infective",
    withPeople: [{ name: "Aya Ibrahim", role: "Medical rep" }],
  });

  // The day he sent: no plan at all, so nothing is judged — and that is said ONCE, above the table.
  const day = buildPlanVsActual(null, [ride, { ...ride, id: "ride:aya:2" }]);
  const [row] = day.rows;
  const words = planActualRowWords(row);
  assert.equal(row.outcome, "no_plan");
  assert.equal(words.verdict, null, "no 'No plan sent' chip on the row — the note above the table says it once");
  assert.equal(words.sentence, null, "and no 'No sent plan' sentence under it");
  assert.equal(words.listChip, null, "'AM list' is never printed on a row its AM chip already says");
  assert.equal(words.placeNote, null, "'Hospital' is never printed under 'Hospital · Grade A'");
  assert.equal(words.territoryLine, "Line Anti Infective", "the territory's area is the area line's own — only its line is new");
  assert.equal(words.locationNote, null, "a captured pin is what the address shows, never a line of its own");
  assert.deepEqual(words.withPeople.map((person) => person.name), ["Aya Ibrahim"], "who came along is said");
  assert.equal(words.customerName, "Menouf General Hospital", "the customer seen is named");
  assert.equal(planActualSaysNoPlan(null, false, day.rows), true, "a day with no plan at all still says so — once");
  assert.equal(planActualSaysNoPlan(null, true, day.rows), false, "a plan that failed to load has its own warning, never 'no plan'");
  assert.equal(planActualSaysNoPlan({ sent: false }, false, []), true, "a week drawn and not sent");
  assert.equal(planActualSaysNoPlan({ sent: true }, false, day.rows), false);
  const repDay = buildPlanVsActual(null, [visit({ id: "rep:1", listType: "AM", source: "rep" })]);
  assert.equal(planActualSaysNoPlan(null, false, repDay.rows), false, "a rep's day answers from his own week");
  assert.equal(planActualRowWords(repDay.rows[0]).withNobody, null, "never 'Alone' under 'Single visit, alone'");

  // Each word only where it adds something.
  assert.equal(managerVisitPlaceNote(visit({ placeLabel: "Al Salam Clinic" })), "Al Salam Clinic", "a place label the row has not said is kept");
  assert.equal(planActualRowWords(day.rows[0]).withNobody, null);
  assert.equal(planActualRowWords(buildPlanVsActual(null, [visit({ hasPin: false })]).rows[0]).locationNote, "No location captured.", "a missing pin is said");
  assert.equal(managerVisitTerritoryLine(visit({ areaName: "Cairo East", territoryName: "Cairo East 2 · Pedia" })), "Territory Cairo East 2 · Pedia", "a territory elsewhere is named in full");
  assert.equal(managerVisitTerritoryLine(visit({ areaName: "Maadi", territoryName: "Maadi" })), null, "a territory that IS the area is not said twice");
  const pharmacy = visit({ bucket: "Pharmacy", id: "ride:ph", kind: "double", kindLabel: "Double visit", listType: "Pharmacy", loggedHalf: "PM", source: "ride_along" });
  assert.equal(planActualRowWords(buildPlanVsActual(null, [pharmacy]).rows[0]).listChip, "Pharmacy", "a pharmacy is its own word on a PM row");
  const alone = visit({ id: "ride:none", kind: "double", kindLabel: "Double visit", source: "ride_along", withPeople: [] });
  assert.equal(planActualRowWords(buildPlanVsActual(null, [alone]).rows[0]).withNobody, "No one else named.", "a double visit naming nobody says so");

  // A sent week: the plan column names the customer and the rep, so the status column does not name them again.
  const customer = (name: string, key: string) => ({ flagLabel: null, key, name, outcome: "done" as const, outcomeLabel: "Done", own: false, place: null });
  const plan: ManagerDayPlan = {
    halves: [
      { customers: [customer("Menouf General Hospital", "c:menouf")], half: "AM", kind: "with_rep", kindLabel: "With a rep", note: null, title: "With Aya Ibrahim" },
      { customers: [], half: "PM", kind: "admin", kindLabel: "Admin", note: null, title: "Training" },
      { customers: [], half: "PM", kind: "with_rep", kindLabel: "With a rep", note: null, title: "With Mina Farouk" },
    ],
    sent: true,
    statusLine: "Approved",
  };
  const extra = visit({ customerKey: "m:other", customerName: "Dr. Zed Kamel", id: "own:9", loggedAt: "2026-10-19T09:10:00Z", planned: false });
  const sent = buildPlanVsActual(plan, [ride, extra]);
  const planned = planActualRowWords(sent.rows.find((entry) => entry.actual?.id === "ride:aya:1")!);
  assert.equal(planned.verdict, "Done");
  assert.equal(planned.sentence, "Matches the plan.");
  assert.equal(planned.customerName, null, "the planned customer is named once, in the plan column");
  assert.deepEqual(planned.withPeople, [], "'With Aya Ibrahim' is the plan's own title — never printed again under it");
  assert.equal(planned.withNobody, null);
  const admin = planActualRowWords(sent.rows.find((entry) => entry.plan?.kind === "admin")!);
  assert.equal(admin.verdict, null, "an Admin half-day is not called 'Admin' twice");
  assert.equal(admin.sentence, "Nothing to check for this half-day.");
  const unticked = planActualRowWords(sent.rows.find((entry) => entry.plan?.title === "With Mina Farouk")!);
  assert.deepEqual([unticked.verdict, unticked.sentence], ["Nothing ticked", null], "'Nothing ticked' is not followed by 'nothing to check'");
  const unplanned = planActualRowWords(sent.rows.find((entry) => entry.outcome === "unplanned")!);
  assert.deepEqual([unplanned.verdict, unplanned.sentence], ["Not on the plan", null], "a visit nobody planned says so once");

  // The markup prints those words and none of the old repeats.
  const table = source("src/components/phoenix-crm/manager-plan-actual-table.tsx");
  assert.match(table, /const words = planActualRowWords\(row\);/, "which words a row prints is the rule's, never the markup's");
  assert.match(table, /planActualSaysNoPlan\(plan, planUnread, rows\) \? \(/, "the no-plan note is the day's, shown once");
  for (const repeat of ["No sent plan to match against", "No sent plan covers this day.", "Nobody put this visit on the week", "A location was captured", '"Alone."', "More about the visit", "No customer ticked.", "managerVisitHalfLabel"]) {
    assert.ok(!table.includes(repeat), `the table no longer prints "${repeat}"`);
  }
}
