import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  BRICK_READING_LABEL,
  buildBrickWork,
  buildDvFocus,
  buildMissedClassA,
  dvPatternSentence,
  isClassADoctor,
  listBucketOf,
  normaliseGrade,
} from "@/lib/business-review/field-link";
import {
  REVIEW_METRICS,
  defaultSelectionFor,
  metricsForLevel,
  needsFieldLink,
  type ReviewMetricId,
} from "@/lib/business-review/pack/metrics";
import { buildSalesReviewPack, type PackInput } from "@/lib/business-review/pack/model";

import { stripComments } from "./support/comment-strip.ts";
import {
  MANAGER,
  OTHER_REP,
  REP,
  SEAT,
  TEAM,
  fixtureBrickSales,
  fixtureContacts,
  fixtureFacts,
  fixtureRides,
  fixtureVisits,
} from "./support/business-review-field-link-fixture.ts";

/**
 * The Business Review's WORK AGAINST RESULTS sections — owner, 2026-10-01.
 *
 * "Every brick contains how many class A doctors and I visit how many, versus this area or brick
 * sales … if a DM over-focused some MRs in double visits and forgot others … link them together to
 * do a real professional business review yet simple to understand … a medical rep's BR must show
 * all data but simple and easy for him to understand."
 *
 * What is pinned here, and why each one matters:
 *
 *   1. The three kinds stay apart (AM · PM · Pharmacies golden rule) and "class A doctors" means the
 *      PM list at grade A — a pharmacy is never a doctor, whatever grade the CRM gives it.
 *   2. Every brick reading fires where it should, a customer held by two reps is ONE customer, and a
 *      visit to a customer off the list still counts as work in his brick.
 *   3. The class A to-do list: only unvisited grade-A doctors and accounts, never a pharmacy, never
 *      twice, the best-selling brick first.
 *   4. The owner's own double-visit example — "always goes with 3, never or rarely with the other
 *      2" — reads never / rarely / most, and a rep who worked no field day is never "forgotten".
 *   5. A medical rep's pack opens on plain sentences, reads in his own voice, never shows him a
 *      manager's cost of an awareness activity, and never prints an HR id.
 *   6. A manager's pack carries the double-visit table per rep and month, and the team at a glance.
 *   7. The route reads the linked facts for the viewer's OWN scope, and the loader reads the
 *      register, the CRM door and the ROI engine — never a second opinion of its own.
 */

const slice = (sales: number, target: number, graded = sales) => ({
  ach: target !== 0 ? Math.round((graded / target) * 10000) / 100 : null,
  graded,
  sales,
  target,
});

const area = (code: string, repHrIds: string[], over: Record<string, unknown> = {}): PackInput["areas"][number] =>
  ({
    allProducts: slice(104000, 130000),
    area: `Area ${code}`,
    areaCode: code,
    byMonth: { "2026-07": slice(50000, 65000), "2026-08": slice(54000, 65000) },
    customersTotal: 30,
    dm: "Manager One",
    dmSeatId: SEAT,
    doubleVisits: 6,
    marketingCommitted: 5000,
    marketingRequests: 1,
    outstationApproved: 700,
    outstationClaimed: 800,
    products: {},
    repHrIds,
    vacant: false,
    visitsByMonth: { "2026-07": 200, "2026-08": 200 },
    ...over,
  }) as unknown as PackInput["areas"][number];

const person = (hrId: string, name: string, role = "Medical Rep", over: Record<string, unknown> = {}): PackInput["people"][number] =>
  ({
    activeMonths: 2,
    areaCode: "CA1",
    avgPerActiveMonth: 200,
    campaignVisits: 0,
    customers: 30,
    customersAm: 2,
    customersByMonth: { "2026-07": 20, "2026-08": 25 },
    customersPharmacy: 5,
    customersPm: 23,
    dmSeatId: SEAT,
    employmentStatus: "active",
    fieldVisits: 400,
    hireDate: null,
    hrId,
    jobTitle: role,
    lastWorkingDate: null,
    marketingRequests: 1,
    name,
    outstationClaimed: 800,
    regularVisits: 380,
    repsCoached: 0,
    ridesLed: 0,
    role,
    visitSplit: { am: 80, pharmacies: 80, pm: 240 },
    ...over,
  }) as unknown as PackInput["people"][number];

function repInput(selection: readonly ReviewMetricId[] = defaultSelectionFor("rep")): PackInput {
  return {
    areas: [area("CA1", [REP])],
    brickSales: fixtureBrickSales(),
    concentration: null,
    coverageNote: "Every figure covers Jul – Aug 2026.",
    dms: [],
    fieldLink: fixtureFacts(),
    generatedAt: "2026-10-01T09:00:00.000Z",
    months: ["2026-07", "2026-08"],
    people: [person(REP, "Rep One")],
    selection,
    subject: { level: "rep", line: "pedia", title: "Rep One", windowLabel: "Jul – Aug 2026" },
    visitsAvailable: true,
  };
}

function districtInput(level: "district" | "line" | "company" = "district"): PackInput {
  const multi = level === "company";
  return {
    areas: [
      area("CA1", [REP, "REP-3"], multi ? { lineLabel: "Pedia" } : {}),
      area("CA2", ["REP-4", "REP-5", "REP-6", "REP-7"], multi ? { lineLabel: "Pedia" } : {}),
    ],
    brickSales: fixtureBrickSales(),
    concentration: null,
    coverageNote: "Every figure covers Jul – Aug 2026.",
    dms: [],
    fieldLink: fixtureFacts({ repHrIds: [...TEAM] }),
    generatedAt: "2026-10-01T09:00:00.000Z",
    months: ["2026-07", "2026-08"],
    people: [
      person(REP, "Rep One"),
      person("REP-3", "Rep Three"),
      person("REP-4", "Rep Four", "Medical Rep", { areaCode: "CA2" }),
      person("REP-5", "Rep Five", "Medical Rep", { areaCode: "CA2", employmentStatus: "Resigned", lastWorkingDate: "2026-08-31" }),
      person("REP-6", "Rep Six", "Medical Rep", { areaCode: "CA2" }),
      person(MANAGER, "Manager One", "District Manager", { ridesLed: 18 }),
    ],
    selection: metricsForLevel(level).map((m) => m.id),
    subject: { level, line: multi ? null : "pedia", title: "Manager One", windowLabel: "Jul – Aug 2026" },
    visitsAvailable: true,
  };
}

const allCells = (input: PackInput) =>
  buildSalesReviewPack(input).sections.flatMap((section) => [
    section.title,
    section.note,
    ...section.columns,
    ...section.rows.flat().map((cell) => String(cell ?? "")),
  ]);

export function runBusinessReviewFieldLinkTests() {
  // ------------------------------------------------------------------ 1. the three kinds stay apart
  {
    assert.equal(listBucketOf("Pharmacy", "Pharmacy"), "Pharmacies");
    assert.equal(listBucketOf("PM", "pharmacy"), "Pharmacies", "a pharmacy speciality is a pharmacy on ANY list");
    assert.equal(listBucketOf("AM", "Hospital"), "AM");
    assert.equal(listBucketOf("PM", "Pediatrics"), "PM");
    assert.equal(normaliseGrade("A+"), "A", "A+ reads as A, the contact register's own fold");
    assert.equal(normaliseGrade(" b "), "B");
    assert.equal(normaliseGrade(null), "");
    const pharmacyA = fixtureContacts().find((c) => c.bucket === "Pharmacies");
    assert.ok(pharmacyA && pharmacyA.grade === "A");
    assert.equal(isClassADoctor(pharmacyA), false, "a grade-A PHARMACY is never a class A doctor");
    const accountA = fixtureContacts().find((c) => c.bucket === "AM");
    assert.ok(accountA);
    assert.equal(isClassADoctor(accountA), false, "only the PM list may be called doctors");
  }

  // ------------------------------------------------------------------ 2. bricks: sales beside the work
  {
    const work = buildBrickWork({
      brickNames: fixtureFacts().brickNames,
      contacts: fixtureContacts(),
      sales: fixtureBrickSales(),
      visitsByContact: fixtureVisits(),
    });
    assert.deepEqual(
      work.rows.map((row) => row.brickId),
      ["B1", "B2", "B3", "B5", "B4"],
      "money first — the brick that pays for the territory is where the review starts",
    );
    const by = new Map(work.rows.map((row) => [row.brickId, row]));
    assert.equal(by.get("B1")?.reading, "money-little-work", "67% of the sales on 6% of the visits");
    assert.equal(by.get("B2")?.reading, "balanced");
    assert.equal(by.get("B3")?.reading, "class-a-missed", "2 of 10 class A doctors reached");
    assert.equal(by.get("B5")?.reading, "no-list", "money with nobody on the list is itself a finding");
    assert.equal(by.get("B4")?.reading, "work-little-money", "43% of the visits, nothing sold");
    assert.equal(by.get("B1")?.directSales, 5000, "the direct-order part of a brick is the closing's own direct rows");
    assert.deepEqual(by.get("B2")?.reach.classA, { listed: 4, reached: 4 }, "a doctor on two reps' lists is ONE doctor");
    assert.deepEqual(by.get("B1")?.reach.pharmacies, { listed: 1, reached: 1 }, "pharmacies apart");
    assert.deepEqual(by.get("B1")?.visits, { am: 0, pharmacies: 1, pm: 5 }, "AM · PM · Pharmacies apart, never merged");
    assert.equal(
      (by.get("B3")?.visits.pm ?? 0),
      32,
      "a customer OFF the list who sits in the brick still counts as work there (2 listed + 30 off-list)",
    );
    assert.deepEqual(work.total.reach.classA, { listed: 29, reached: 14 });
    assert.equal(work.total.visits.pm + work.total.visits.am + work.total.visits.pharmacies, 94, "every visit, placed or not");
    assert.equal(work.total.sales, 104000);

    // NAMES, NEVER CODES (owner, 2026-10-01: "NEVER SHOW CODES ALWAYS SHOW NAMES"). A brick the master
    // has no name for reads in words — never "B9" — and so does a rep the directory cannot name.
    const unnamed = buildBrickWork({
      brickNames: {},
      contacts: [{ ...fixtureContacts()[0], brickId: "B9" }],
      sales: [{ brickId: "B9", brickName: "B9", channel: "distributor", value: 100 }],
      visitsByContact: {},
    });
    assert.equal(unnamed.rows[0].brickName, "Brick not named", "a missing name is said in words, never as the code");
    const nameless = buildDvFocus({
      months: ["2026-07"],
      names: {},
      repDays: [{ fieldDays: 3, fieldVisits: 30, period: "2026-07", repHrId: "REP-9", split: { am: 0, pharmacies: 0, pm: 30 } }],
      rides: [],
      ridesOutside: [],
      teams: [{ dmSeatId: SEAT, managerHrId: MANAGER, managerName: "Manager One", repHrIds: ["REP-9"] }],
    });
    assert.equal(nameless[0].reps[0].name, "Unnamed employee", "an unnamed rep is never printed as his HR id");

    // A big brick whose class A doctors are covered is NOT "big sales, few visits", however small its
    // share of the visits — the Mahalla case measured on production 2026-10-01 (39% of the sales, all
    // 45 class A doctors reached). Its small neighbour that soaked up the visits still reads as such.
    const covered = buildBrickWork({
      brickNames: {},
      contacts: [
        ...Array.from({ length: 10 }, (_, i) => ({ ...fixtureContacts()[0], brickId: "X", contactId: 7000 + i })),
        ...Array.from({ length: 5 }, (_, i) => ({ ...fixtureContacts()[0], brickId: "Y", contactId: 7100 + i })),
      ],
      sales: [
        { brickId: "X", brickName: "Big City", channel: "wholesaler", value: 90000 },
        { brickId: "Y", brickName: "Small Town", channel: "distributor", value: 10000 },
      ],
      visitsByContact: Object.fromEntries([
        ...Array.from({ length: 10 }, (_, i) => [String(7000 + i), { brickId: "X", lastVisit: null, split: { am: 0, pharmacies: 0, pm: 4 }, visits: 4 }]),
        ...Array.from({ length: 5 }, (_, i) => [String(7100 + i), { brickId: "Y", lastVisit: null, split: { am: 0, pharmacies: 0, pm: 12 }, visits: 12 }]),
      ]),
    });
    const covers = new Map(covered.rows.map((row) => [row.brickName, row.reading]));
    assert.equal(covers.get("Big City"), "balanced", "90% of the sales, 40% of the visits, every class A doctor reached");
    assert.equal(covers.get("Small Town"), "work-little-money", "60% of the visits for 10% of the sales");
    for (const reading of Object.keys(BRICK_READING_LABEL)) {
      assert.ok(!/…/.test(BRICK_READING_LABEL[reading as keyof typeof BRICK_READING_LABEL]), "no ellipsis in a label");
    }
  }

  // ------------------------------------------------------------------ 3. the class A to-do list
  {
    const work = buildBrickWork({
      brickNames: fixtureFacts().brickNames,
      contacts: fixtureContacts(),
      sales: fixtureBrickSales(),
      visitsByContact: fixtureVisits(),
    });
    const missed = buildMissedClassA({
      brickNames: fixtureFacts().brickNames,
      brickOrder: work.rows.map((row) => row.brickId),
      contacts: fixtureContacts(),
      visitsByContact: fixtureVisits(),
    });
    assert.equal(missed.length, 16, "7 in Brick One, the class A account in Brick Two, 8 in Brick Three");
    assert.ok(missed.every((row) => row.bucket !== "Pharmacies"), "he asked about doctors — a pharmacy is never on it");
    assert.deepEqual(
      [...new Set(missed.map((row) => row.brickId))],
      ["B1", "B2", "B3"],
      "the brick that sells most comes first",
    );
    assert.equal(missed[0].name, "Doctor 1005");
    assert.equal(missed.find((row) => row.brickId === "B2")?.bucket, "AM", "a class A account is listed as an account");
    assert.equal(new Set(missed.map((row) => row.name)).size, missed.length, "never twice");
  }

  // ------------------------------------------------------------------ 4. the owner's double-visit example
  {
    const { rides, repDays } = fixtureRides();
    const [manager] = buildDvFocus({
      months: ["2026-07", "2026-08"],
      names: fixtureFacts().names,
      repDays,
      rides,
      ridesOutside: [{ days: 2, managerHrId: MANAGER, period: "2026-08" }],
      teams: [{ dmSeatId: SEAT, managerHrId: MANAGER, managerName: "Manager One", repHrIds: [...TEAM, MANAGER] }],
    });
    assert.ok(manager);
    const status = Object.fromEntries(manager.reps.map((rep) => [rep.repHrId, rep.status]));
    assert.equal(status[REP], "most", "6 ride days against a fair share of 3.6");
    assert.equal(status["REP-3"], "most");
    assert.equal(status["REP-4"], "fair", "5 against 3.6 is within one and a half times");
    assert.equal(status["REP-5"], "rarely", "1 day against 3.6 — under half");
    assert.equal(status["REP-6"], "never", "worked both months, never ridden");
    assert.equal(status["REP-7"], "not-working", "no field day in the period is never 'forgotten'");
    assert.equal(manager.teamSize, 6, "the manager is never his own team member");
    assert.equal(manager.teamRideDays, 18);
    assert.equal(manager.outsideRideDays, 2);
    assert.equal(
      manager.reps.find((rep) => rep.repHrId === REP)?.fairDays.toFixed(1),
      "3.6",
      "fair share is month by month over the reps working that month: 10/5 + 8/5",
    );
    assert.equal(dvPatternSentence(manager), "2 reps get most of the rides; 1 never ridden; 1 rarely ridden.");
  }

  // ------------------------------------------------------------------ 5. a medical rep's pack, in his own voice
  {
    const pack = buildSalesReviewPack(repInput());
    const metrics = pack.sections.map((section) => section.metric);
    assert.equal(metrics[0], "review-summary", "the rep reads his period in sentences before he reads a table");
    const summary = pack.sections[0];
    assert.equal(summary.title, "Your period in one page");
    const said = new Map(summary.rows.map((row) => [String(row[0]), String(row[1])]));
    assert.match(said.get("Sales") ?? "", /^Your area sold EGP 104,000 against a target of EGP 130,000: 80\.0% achievement\.$/);
    assert.match(said.get("Class A doctors") ?? "", /You reached 14 of 29 class A doctors on your list \(48%\)/);
    assert.match(said.get("Class A doctors") ?? "", /15 were not visited/);
    assert.match(said.get("Biggest brick") ?? "", /^67% of the sales came from Brick One; you reached 5 of 12/);
    assert.match(said.get("Money without the visits") ?? "", /^The brick Brick One brought 67% of the sales but got 6% of the visits/);
    // A cell is laid out by its first strong character, so a sentence opening on an Arabic brick name
    // is set right-to-left and its full stop jumps to the front (measured on the first real pack).
    // Every summary sentence therefore opens in English or a figure — never on a name.
    const arabic = buildSalesReviewPack({
      ...repInput(["review-summary"]),
      brickSales: fixtureBrickSales().map((row) => ({ ...row, brickName: row.brickId === "B1" ? "بركة السبع" : row.brickName })),
    }).sections[0];
    for (const row of arabic.rows) {
      const firstStrong = /[A-Za-z\u0600-\u06FF]/.exec(String(row[1]))?.[0] ?? "";
      assert.ok(!/[\u0600-\u06FF]/.test(firstStrong), `a summary sentence must not open on Arabic: ${row[1]}`);
    }
    assert.match(said.get("Double visits") ?? "", /on 6 days — your district manager on 6 days of them/);
    assert.match(said.get("Field work") ?? "", /AM 80 · PM 240 · Pharmacies 80/, "the golden rule, in the sentence too");
    assert.match(said.get("Direct orders") ?? "", /1 direct order booked .*EGP 5,000; 1 more is approved and not booked yet/);

    for (const id of ["brick-work", "class-a-missed", "direct-orders", "requests-return", "awareness", "cost-to-serve"] as const) {
      assert.ok(metrics.includes(id), `a medical rep's pack must carry ${id} — his own territory answers it`);
    }
    assert.ok(!metrics.includes("dv-focus"), "a rep is never shown how his manager splits his days across colleagues");
    assert.ok(!metrics.includes("team-scorecard"), "nor his colleagues' rows");

    const bricks = pack.sections.find((s) => s.metric === "brick-work");
    assert.ok(bricks);
    assert.equal(bricks.title, "Your bricks: doctors, visits and sales");
    const readings = bricks.rows.map((row) => row[row.length - 1]);
    for (const label of Object.values(BRICK_READING_LABEL)) {
      assert.ok(readings.includes(label), `every reading appears in the fixture: ${label}`);
    }
    assert.ok(bricks.columns.every((c) => !c.includes("/")), "no slash-joined columns");

    const missed = pack.sections.find((s) => s.metric === "class-a-missed");
    assert.ok(missed);
    assert.ok(!missed.columns.includes("Rep"), "his own list needs no rep column");
    assert.equal(missed.rows[0][0], "Brick One");

    // A doctor missed in the period and seen AFTER it says so, rather than printing a later date
    // under "not visited" (measured on the first real pack, 2026-10-01: "5 Sept" in an August review).
    const later = buildSalesReviewPack({
      ...repInput(["class-a-missed"]),
      fieldLink: fixtureFacts({
        contacts: fixtureContacts().map((c) => (c.contactId === 3008 ? { ...c, lastVisitedOn: "2026-09-05" } : c)),
      }),
    }).sections.find((s) => s.metric === "class-a-missed");
    const laterRow = later?.rows.find((row) => row[1] === "Doctor 3008");
    assert.match(String(laterRow?.[4]), /^Visited after the period, on 5 Sept? 2026$/);
    assert.equal(later?.rows.find((row) => row[1] === "Doctor 3009")?.[4], "2 May 2026", "a visit before the period is just its date");

    // The bricks add up to less than the area when the closing spreads wholesale across a city — said
    // with both figures, so a rep adding the column is not left wondering where the rest went.
    const short = buildSalesReviewPack({
      ...repInput(["brick-work"]),
      areas: [area("CA1", [REP], { allProducts: slice(150000, 160000) })],
    }).sections.find((s) => s.metric === "brick-work");
    assert.match(short?.note ?? "", /The bricks add up to EGP 104,000 of your area's EGP 150,000/);
    assert.match(short?.note ?? "", /the rest is store sales the Monthly Closing spreads across a city/, "in the owner's word: stores");
    assert.ok(!/wholesale/i.test(short?.note ?? ""), "never wholesale (owner, 2026-10-02)");

    // Nobody claimed a trip → no cost table of zeros per field day.
    const noTrips = buildSalesReviewPack({
      ...repInput(["cost-to-serve"]),
      people: [person(REP, "Rep One", "Medical Rep", { outstationClaimed: 0 })],
    });
    assert.ok(!noTrips.sections.some((s) => s.metric === "cost-to-serve"), "a zero per field day is not a saving");

    const awareness = pack.sections.find((s) => s.metric === "awareness");
    assert.ok(awareness);
    assert.ok(!awareness.columns.includes("Cost"), "what an awareness activity costs is the managers' page, not the rep's");

    // Maturity is the wording, never the data: the pre-existing sections read in his voice too.
    const achievement = pack.sections.find((s) => s.metric === "achievement");
    assert.equal(achievement?.title, "Your area's sales");
    const visits = pack.sections.find((s) => s.metric === "visits-split");
    assert.equal(visits?.title, "Your visits");
    assert.match(visits?.note ?? "", /never counted among the PM doctors/, "the golden rule survives the plain wording");

    const cells = allCells(repInput());
    assert.ok(!cells.some((cell) => /\bREP-\d|\bDM-\d|\bSEAT-/.test(cell)), "names, never HR ids or seat ids");
    assert.ok(!cells.some((cell) => /…/.test(cell)), "never truncated with an ellipsis");
  }

  // ------------------------------------------------------------------ 6. a district manager's pack
  {
    const pack = buildSalesReviewPack(districtInput("district"));
    const dv = pack.sections.find((s) => s.metric === "dv-focus");
    assert.ok(dv, "the district pack carries the double-visit focus");
    assert.equal(dv.title, "Double visits by rep — Manager One", "one line, named for the manager");
    assert.deepEqual(dv.columns.slice(0, 3), ["Rep", "Jul", "Aug"], "ride days month by month");
    assert.equal(dv.chart?.unit, "count", "ride days belong to one rep and add up");
    const readingOf = (name: string) => dv.rows.find((row) => String(row[0]).startsWith(name))?.[dv.columns.length - 1];
    assert.equal(readingOf("Rep Six"), "Never ridden");
    assert.equal(readingOf("Rep Five"), "Rarely ridden");
    assert.equal(readingOf("Rep One"), "Gets most of the rides");
    assert.ok(
      dv.rows.some((row) => String(row[0]) === "Rep Five (left 31 Aug 2026)"),
      "a leaver keeps his row and his red mark",
    );
    assert.match(dv.note, /never or rarely/, "the owner's rule travels with the table");

    const team = pack.sections.find((s) => s.metric === "team-scorecard");
    assert.ok(team);
    assert.ok(team.columns.includes("Area achievement"), "the achievement is the AREA's, and the column says so");
    assert.match(team.note, /never per rep/);

    const missed = pack.sections.find((s) => s.metric === "class-a-missed");
    assert.ok(missed?.columns.includes("Rep"), "a district list names whose doctor it is");

    const summary = pack.sections.find((s) => s.metric === "review-summary");
    const said = new Map((summary?.rows ?? []).map((row) => [String(row[0]), String(row[1])]));
    assert.equal(
      said.get("Double visits"),
      "The district manager rode 18 days with the team; 2 reps took most of the rides, 1 rep was never ridden, 1 rep was rarely ridden.",
      "only what happened is named — never a list of zeros",
    );
    assert.ok(!(summary?.rows ?? []).some((row) => /\(left/.test(String(row[1]))), "a leaver's name is never put inside a sentence");
  }

  // ------------------------------------------------------------------ 7. a line or company pack
  {
    const pack = buildSalesReviewPack(districtInput("company"));
    const dvTables = pack.sections.filter((s) => s.metric === "dv-focus");
    assert.equal(dvTables.length, 2, "one row per manager, then only the reps left out or favoured");
    assert.equal(dvTables[0].title, "Double visits: who gets the managers' days");
    assert.ok(dvTables[1].rows.every((row) => row[row.length - 1] !== "Fair share"), "the second table lists only the exceptions");
    assert.ok(!pack.sections.some((s) => s.metric === "brick-work"), "a company is not read brick by brick");
    const orders = pack.sections.find((s) => s.metric === "direct-orders");
    assert.ok(orders);
    assert.ok(orders.columns.includes("Approved, not booked yet"), "an unbooked order is shown, and counted in no month");
    const cost = pack.sections.find((s) => s.metric === "cost-to-serve");
    assert.ok(cost?.columns.includes("Spend per EGP 1,000 sold"));
  }

  // ------------------------------------------------------------------ 8. nothing read, nothing drawn
  {
    const unread = buildSalesReviewPack({ ...repInput(), brickSales: null, fieldLink: null });
    for (const id of ["brick-work", "class-a-missed", "direct-orders", "requests-return", "awareness", "cost-to-serve"] as const) {
      assert.ok(!unread.sections.some((s) => s.metric === id), `${id} ticked but never read is dropped, never zeroed`);
    }
    assert.ok(unread.sections.some((s) => s.metric === "review-summary"), "the summary still says what the sales say");
  }

  // ------------------------------------------------------------------ 9. the catalogue marks the extra read
  {
    const linked = REVIEW_METRICS.filter((m) => m.needsFieldLink).map((m) => m.id).sort();
    assert.deepEqual(linked, [
      "area-work",
      "awareness",
      "brick-work",
      "class-a-missed",
      "cost-to-serve",
      "direct-orders",
      "dv-focus",
      "requests-return",
      "review-summary",
      "team-scorecard",
    ]);
    assert.equal(needsFieldLink(["achievement", "visits-split"]), false, "the ordinary pack pays for no CRM list read");
    assert.equal(needsFieldLink(["dv-focus"]), true);
    assert.ok(!metricsForLevel("rep").some((m) => m.id === "dv-focus"), "never offered to a rep");
    assert.ok(!metricsForLevel("company").some((m) => m.id === "brick-work"), "never offered above district");
  }

  // ------------------------------------------------------------------ 10. the reads are the viewer's own
  {
    const route = stripComments(readFileSync("app/api/business-review/pack/route.ts", "utf8")).replace(/\s+/g, " ");
    assert.match(route, /loadFieldLinkFacts\(/, "the route reads the linked facts");
    assert.match(
      route,
      /packRepHrIds = scope\.kind === "rep" \? \[scope\.hrId\]/,
      "a medical rep's read names HIM alone — never a colleague's list",
    );
    assert.ok(!/ownRequestsOf/.test(route), "a rep's requests are every request on his patch, whoever raised them (owner, 2026-10-01)");
    assert.match(route, /keptAreas\.has\(`\$\{line\}:/, "brick sales are cut by line AND area — an area is not per line");

    const loader = stripComments(readFileSync("src/lib/business-review/sources/field-link.ts", "utf8"));
    assert.match(loader, /from\("crm_contact_assignments"\)/, "the list is the dated contact register");
    assert.match(loader, /from\("crm_contacts"\)/, "the register still names each contact and keeps his old brick as the fallback");
    // WHERE A CONTACT IS comes from Phoenix CRM first (owner, 2026-10-31): the Reps List's one door, on
    // the listed doctors AND on every visited contact, the register's iReports360 brick only behind it.
    assert.match(loader, /import \{ loadContactPlacements \} from "@\/lib\/crm\/reps-list"/, "the brick comes through the one door");
    assert.match(loader, /info\.brickId = placements\.get\(id\)\?\.brickId \?\? info\.brickId/, "a listed doctor sits in Phoenix's brick first");
    assert.match(loader, /out\.set\(id, placements\.get\(id\)\?\.brickId \?\? brickId\)/, "a visited contact sits in Phoenix's brick first");
    assert.ok(!/ireports360_contacts/.test(loader), "never the raw list scrape, which keeps no history");
    assert.match(loader, /includeResignedAgents: true/, "a leaver's past months keep the visits they had");
    assert.match(loader, /collapseDuplicateVisitSubmissions/, "a re-save is not a second visit");
    assert.match(loader, /CATCH_ALL_CONTACT_CRM_ID/, "the catch-all slot is nobody's doctor");
    assert.match(loader, /isCrmDoubleVisitRow/, "a ride is Double Visit Analytics' own predicate");
    assert.match(loader, /\.eq\("status", "approved"\)/, "only approved direct orders");
    assert.match(loader, /reversal_of_request_id", null\)/);
    assert.match(loader, /duplicate_of_request_id", null\)/);
    assert.match(loader, /loadActuals\(/, "a request's return is the ROI engine's own matching");
    assert.match(loader, /RESTRICTED_PRODUCT_CODES/, "with the confidential products masked");
    assert.ok(!/phoenix_crm_visits/.test(loader), "Phoenix CRM runs beside the vendor feed; adding the two counts one call twice");

    // NAMES, NEVER CODES (owner, 2026-10-01). The closing hands the direct-order book's customers over
    // with an EMPTY name and a "DOP-…" code, and the biggest-customers table printed the code.
    const detail = stripComments(readFileSync("src/lib/business-review/sources/closing-detail.ts", "utf8"));
    assert.match(detail, /from\("direct_order_pharmacies"\)/, "a direct-order customer is named from the pharmacy register");
    assert.ok(!/clientName: row\.clientName \|\| row\.clientCode/.test(detail), "a customer is never labelled with its code");
    assert.ok(!/row\.brickId \|\| "No brick recorded"/.test(detail), "nor a brick with its id");
  }

  // Fixture sanity: the other rep's copy of a doctor is in the fixture, so block 2 really tests the union.
  assert.ok(fixtureContacts().some((c) => c.repHrId === OTHER_REP));
}
