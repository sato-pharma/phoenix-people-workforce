import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import ExcelJS from "exceljs";

import { stripComments } from "./support/comment-strip.ts";

import { cairoDayOf } from "../src/components/phoenix-crm/format.ts";

import { permissionMatrix, type PhoenixRole } from "../src/lib/auth/permissions.ts";
import {
  buildCapacityBoard,
  capacityMonthsOffered,
  capacityVerdictText,
  gradeTargetsText,
  listCapacity,
  listNeed,
  medianOf,
  monthFieldDays,
  perDayFigures,
  resolveCapacityMonth,
  type CapacityCustomer,
  type CapacityTerritoryInput,
} from "../src/lib/phoenix-crm/capacity-board.ts";
import { buildCustomerTimeline, type TimelineVisit } from "../src/lib/phoenix-crm/customer-timeline.ts";
import {
  buildFieldHeard,
  HEARD_BASIS_TEXT,
  HEARD_NOTES_PER_PRODUCT,
  HEARD_OBJECTIONS,
  heardProductScope,
  heardTallyText,
  raisedObjection,
  type HeardVisit,
} from "../src/lib/phoenix-crm/field-heard.ts";
import { buildMissingStock } from "../src/lib/phoenix-crm/missing-stock.ts";
import { SECTION_TITLES } from "../src/lib/phoenix-crm/report-guide.ts";
import { buildSamplesReport, type SamplesTerritory, type SamplesVisit } from "../src/lib/phoenix-crm/samples-report.ts";
import { buildOrgIndex, heldManagerSeats, ownTerritories, territoriesInScope, type OrgSeat } from "../src/lib/phoenix-crm/scope.ts";
import { PHOENIX_CRM_DEFAULT_SETTINGS } from "../src/lib/phoenix-crm/types.ts";
import { readsFieldHeardByProduct, readsOwnRideAlongs, readsTeamReports, type PhoenixCrmViewer } from "../src/lib/phoenix-crm/server/access.ts";
import { TIMELINE_VISIT_COLUMNS, TIMELINE_VISITS_MAX } from "../src/lib/phoenix-crm/server/customer-timeline.ts";
import {
  fieldHeardAudience,
  insightTerritories,
  latestStockAnswers,
  stockChasesOf,
  type CapacityBoardView,
  type FieldHeardView,
  type MissingStockView,
  type SamplesReportView,
} from "../src/lib/phoenix-crm/server/insight-reports.ts";
import { groupCustomerPharmacies, type PharmacyFeedback } from "../src/lib/phoenix-crm/server/list.ts";
import { phoenixCrmHasSomethingToSay } from "../src/lib/phoenix-crm/server/page.ts";
import { buildPhoenixCrmReportsWorkbook, packSections, type ReportsPackInput } from "../src/lib/phoenix-crm/server/reports-workbook.ts";
import { findAccessRegistryEntry } from "../src/lib/security/access-registry.ts";

/**
 * Phoenix CRM — the five reports the owner picked on 2026-10-02, and the ruling he gave the same day.
 *
 *   1. Grade against capacity — what each territory's LIST asks of a month, by grade, against what the
 *      month's field days hold. List size, never coverage, and the carried-over grades are SAID.
 *   2. What the field heard — the products discussed and the customers' objections, by product,
 *      speciality and area, AM and PM apart. Counts only: never a "no objection" figure, never a rate,
 *      never a row per rep. And (his ruling) the product and marketing managers read it too, for their
 *      OWN products, company-wide, with no area.
 *   3. Missing stock — each pharmacy's LATEST answer for each product, through the customer card's own
 *      grouping, with no limit and no sales figure.
 *   4. Samples by month — what was handed over. A record, never a stock balance.
 *   5. The customer's timeline — his past visits, newest first, with no location, distance or flag.
 *
 * Real visits were zero on the day these shipped (the first team logs on 3 October), so every rule
 * here is proved on fixtures, and every screen is pinned to say something when there is nothing.
 */

function raw(path: string): string {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

function source(path: string): string {
  return stripComments(raw(path));
}

/** Every key anywhere in a value, so a field that should never exist cannot hide one level down. */
function keysOf(value: unknown, into: Set<string> = new Set()): Set<string> {
  if (Array.isArray(value)) {
    for (const entry of value) keysOf(entry, into);
  } else if (value && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) {
      into.add(key);
      keysOf(entry, into);
    }
  }
  return into;
}

function refusedWith(run: () => unknown, message: RegExp, label: string): void {
  assert.throws(
    run,
    (error: unknown) => {
      const failure = error as { status?: number; message?: string };
      return failure.status === 403 && message.test(String(failure.message));
    },
    label,
  );
}

/** AM added to PM (or the other way round) in code: `x.am + y.pm`, `fieldDays.AM + fieldDays.PM`. */
const AM_PM_SUM = /\.am\s*\+\s*[\w.?]*\.pm\b|\.pm\s*\+\s*[\w.?]*\.am\b|\.AM\s*\+\s*[\w.?]*\.PM\b|\.PM\s*\+\s*[\w.?]*\.AM\b/;

// ── 1 · Grade against capacity ─────────────────────────────────────────────────────────────────────

function customers(count: number, listType: "AM" | "PM", grade: "A" | "B" | "C" | null, validated: boolean): CapacityCustomer[] {
  return Array.from({ length: count }, () => ({ listType, grade, validated }));
}

/** Four territories' lists, read by the capacity board and by its workbook sheet. */
const CAPACITY_TERRITORIES: CapacityTerritoryInput[] = [
  {
    seatId: "S4",
    territoryName: "Damietta",
    lineName: "Pedia",
    repName: null,
    customers: [],
    listSource: "reference",
  },
  {
    seatId: "S3",
    territoryName: "Aswan",
    lineName: "Pedia",
    repName: "Third Rep",
    customers: [...customers(10, "PM", "C", false), ...customers(3, "AM", "B", false)],
    listSource: "phoenix",
  },
  {
    seatId: "S1",
    territoryName: "Giza 1",
    lineName: "Pedia",
    repName: "First Rep",
    customers: [...customers(110, "PM", "A", false), ...customers(1, "PM", null, false), ...customers(2, "AM", "A", true)],
    listSource: "phoenix",
  },
  {
    seatId: "S2",
    territoryName: "Alex 1",
    lineName: "Pedia",
    repName: "Second Rep",
    customers: [...customers(60, "PM", "A", true), ...customers(40, "PM", "B", true), ...customers(40, "PM", "C", true)],
    listSource: "phoenix",
  },
];

function runCapacityTests(): void {
  const settings = PHOENIX_CRM_DEFAULT_SETTINGS;

  // The months: this one and the next — never a past month read against today's list.
  assert.deepEqual(capacityMonthsOffered("2026-10-02"), ["2026-10", "2026-11"]);
  assert.deepEqual(capacityMonthsOffered("2026-12-31"), ["2026-12", "2027-01"], "December offers January of the next year");
  const october = resolveCapacityMonth({ month: undefined, cairoToday: "2026-10-02" });
  assert.deepEqual(october, { ok: true, value: { month: "2026-10", monthStart: "2026-10-01", monthEnd: "2026-10-31" } });
  assert.deepEqual(resolveCapacityMonth({ month: "2026-09", cairoToday: "2026-10-02" }), {
    ok: false,
    error: "This board reads this month or the next one.",
  });
  assert.deepEqual(resolveCapacityMonth({ month: "2026-13", cairoToday: "2026-10-02" }), { ok: false, error: "Choose a valid month." });

  // October 2026: Thursday the 1st, five Fridays, five Thursdays, 21 Saturday-to-Wednesday days — and
  // the company calendar's holiday on THURSDAY 8 October takes a morning only.
  const holidays = new Map([["2026-10-08", "Armed Forces Day"]]);
  assert.deepEqual(monthFieldDays("2026-10", holidays), { AM: 25, PM: 21, holidays: [{ day: "2026-10-08", name: "Armed Forces Day" }] });
  assert.deepEqual(monthFieldDays("2026-10", new Map()), { AM: 26, PM: 21, holidays: [] }, "Thursday holds AM only, Friday holds nothing");
  assert.deepEqual(monthFieldDays("2026-10", new Map([["2026-10-09", "A Friday"]])), { AM: 26, PM: 21, holidays: [] }, "a holiday on a Friday takes nothing");
  assert.deepEqual(
    monthFieldDays("2026-10", new Map([["2026-10-04", "A Sunday"]])),
    { AM: 25, PM: 20, holidays: [{ day: "2026-10-04", name: "A Sunday" }] },
    "a holiday on a full field day takes both halves",
  );

  // The per-day figures are READ — the call rate and the plan's cap — never typed here.
  assert.deepEqual(perDayFigures(settings, "PM"), { target: 10, cap: 15 });
  assert.deepEqual(perDayFigures(settings, "AM"), { target: 2, cap: 5 });
  assert.deepEqual(perDayFigures({ ...settings, callRatePmTarget: 12, pmDailyCap: 18 }, "PM"), { target: 12, cap: 18 }, "a change in Settings is a change on the board");

  // What a list asks for: each customer's grade number, AM and PM apart.
  const list = [
    ...customers(1, "PM", "A", true),
    ...customers(1, "PM", "A", false),
    ...customers(1, "PM", "B", false),
    ...customers(1, "PM", "C", false),
    ...customers(1, "PM", null, false),
    ...customers(1, "AM", "A", true),
    ...customers(1, "AM", "B", false),
  ];
  assert.deepEqual(listNeed(list, "PM", settings), {
    customers: 5,
    validated: 1,
    notValidated: 4,
    grades: { A: 2, B: 1, C: 1 },
    noGrade: 1,
    noNumber: 0,
    required: 9,
    gradeAShare: 40,
  });
  assert.deepEqual(listNeed(list, "AM", settings), {
    customers: 2,
    validated: 1,
    notValidated: 1,
    grades: { A: 1, B: 1, C: 0 },
    noGrade: 0,
    noNumber: 1,
    required: 1,
    gradeAShare: 50,
  });

  // The verdicts, against 21 PM days at 10 a day (210) and at the cap of 15 (315).
  const need = (count: number) => listNeed(customers(count, "PM", "A", false), "PM", settings);
  const pmPerDay = perDayFigures(settings, "PM");
  assert.equal(listCapacity(need(70), 21, pmPerDay).verdict, "fits", "210 visits fit ten a day exactly");
  const overTarget = listCapacity(need(100), 21, pmPerDay);
  assert.deepEqual(
    [overTarget.verdict, overTarget.required, overTarget.atTarget, overTarget.atCap, overTarget.perDayNeeded, overTarget.beyondTarget, overTarget.beyondCap],
    ["over_target", 300, 210, 315, 14.3, 90, 0],
  );
  const overCap = listCapacity(need(110), 21, pmPerDay);
  assert.deepEqual([overCap.verdict, overCap.perDayNeeded, overCap.beyondTarget, overCap.beyondCap], ["over_cap", 15.7, 120, 15]);
  assert.equal(listCapacity(need(0), 21, pmPerDay).verdict, "no_list");
  const noDays = listCapacity(need(5), 0, pmPerDay);
  assert.deepEqual([noDays.verdict, noDays.perDayNeeded], ["no_days", null], "never a divide by zero");

  assert.equal(medianOf([]), null);
  assert.equal(medianOf([330, 10, 300]), 300);
  assert.equal(medianOf([2, 0]), 1, "an even count is interpolated, as percentile_cont(0.5) is");

  // The board: the tightest first, every territory kept, AM and PM never one figure.
  const territories = CAPACITY_TERRITORIES;
  const board = buildCapacityBoard(territories, { AM: 25, PM: 21 }, settings);
  assert.deepEqual(
    board.rows.map((row) => [row.territoryName, row.pm.verdict, row.pm.required, row.am.verdict, row.am.required]),
    [
      ["Giza 1", "over_cap", 330, "fits", 2],
      ["Alex 1", "over_target", 300, "no_list", 0],
      ["Aswan", "fits", 10, "fits", 0],
      ["Damietta", "no_list", 0, "no_list", 0],
    ],
  );
  assert.equal(board.rows[3]?.listSource, "reference", "a list never opened in Phoenix is read from iReports360, and says so");
  assert.deepEqual(board.summary, {
    territories: 4,
    withList: 3,
    pmOverTarget: 2,
    pmOverCap: 1,
    amOverTarget: 0,
    amOverCap: 0,
    pmMedianRequired: 300,
    amMedianRequired: 1,
    pmGradeAShare: { min: 0, max: 99.1 },
    notValidated: { AM: 3, PM: 121 },
  });
  for (const row of board.rows) {
    assert.deepEqual(Object.keys(row).sort(), ["am", "lineName", "listSource", "pm", "repName", "seatId", "territoryName"], "AM and PM, and nothing combining them");
  }
  // One wording for the verdict — the screen's pill and the workbook's column alike — and it is about
  // the LIST's size against the month, never about the rep.
  assert.deepEqual(
    board.rows.map((row) => [capacityVerdictText(row.pm, "PM"), capacityVerdictText(row.am, "AM")]),
    [
      ["PM over 15 a day", "AM fits 2 a day"],
      ["PM over 10 a day", "No AM list"],
      ["PM fits 10 a day", "AM fits 2 a day"],
      ["No PM list", "No AM list"],
    ],
  );
  assert.equal(gradeTargetsText(settings.gradeTargets, "PM"), "PM A 3 · B 2 · C 1");
  assert.equal(gradeTargetsText(settings.gradeTargets, "AM"), "AM A 1 · B no number · C no number");
  // The same lists against other numbers in Settings: the board follows Settings.
  const lighter = buildCapacityBoard(territories, { AM: 25, PM: 21 }, { ...settings, gradeTargets: { PM: { A: 2, B: 1, C: 1 }, AM: { A: 1, B: null, C: null } } });
  assert.equal(lighter.rows.find((row) => row.seatId === "S1")?.pm.required, 220, "grade A at two a month asks 220 of the same list");

  // The rule module names no number of its own: grade targets, call rates and caps all come from Settings.
  const rules = source("src/lib/phoenix-crm/capacity-board.ts");
  assert.doesNotMatch(rules, /\b15\b|PM:\s*\{|A:\s*3\b/, "capacity-board.ts types no cap and no grade table");
  for (const read of [/settings\.callRatePmTarget/, /settings\.pmDailyCap/, /settings\.callRateAmTarget/, /settings\.amDailyCap/, /gradeTarget\(settings, listType, customer\.grade\)/]) {
    assert.match(rules, read, `capacity-board.ts reads ${read.source} from Settings`);
  }
  assert.match(raw("src/lib/phoenix-crm/capacity-board.ts"), /LIST SIZE AGAINST CAPACITY — NOT ACHIEVED COVERAGE/);
}

// ── 2 · What the field heard ───────────────────────────────────────────────────────────────────────

const HEARD: HeardVisit[] = [
  {
    visitDate: "2026-10-03",
    listType: "PM",
    products: ["Saginko", "Royafloxacin"],
    objection: "price",
    objectionNote: "Too expensive for his patients",
    speciality: "Pediatrics",
    area: "Giza 1",
  },
  { visitDate: "2026-10-04", listType: "AM", products: ["Saginko"], objection: "none", objectionNote: null, speciality: "Pediatrics", area: "Giza 1" },
  { visitDate: "2026-10-05", listType: "PM", products: ["Saginko", " Saginko "], objection: null, objectionNote: null, speciality: null, area: "Alex 1" },
  {
    visitDate: "2026-10-06",
    listType: "PM",
    products: ["Guamusin"],
    objection: "competitor",
    objectionNote: "Prescribes a rival syrup",
    speciality: "ENT",
    area: "Alex 1",
  },
  { visitDate: "2026-10-07", listType: "AM", products: ["Royafloxacin"], objection: "bogus", objectionNote: "never read", speciality: " pediatrics ", area: "Giza 1" },
];

const HEARD_KEYS = [
  "am",
  "area",
  "byArea",
  "byObjection",
  "byProduct",
  "bySpeciality",
  "key",
  "label",
  "listType",
  "name",
  "note",
  "notes",
  "objectionLabel",
  "objections",
  "pm",
  "products",
  "speciality",
  "totals",
  "visitDate",
  "visits",
];

function runFieldHeardTests(): void {
  // "No objection" is the customer's answer and never a count; an unknown key is no answer at all.
  assert.deepEqual(
    HEARD_OBJECTIONS.map((entry) => entry.key),
    ["price", "efficacy", "safety", "competitor", "formulary", "no_time"],
    "the six objections in the form's own order, and not 'none'",
  );
  assert.equal(raisedObjection("none"), null, "'No objection' is the customer's answer, never an objection counted");
  assert.equal(raisedObjection("bogus"), null, "an unknown key is no answer");
  assert.equal(raisedObjection(null), null, "no answer is no answer");
  assert.equal(raisedObjection("price"), "price");

  const team = buildFieldHeard(HEARD, { products: null, withArea: true });
  assert.deepEqual(team.totals, {
    visits: { am: 2, pm: 3 },
    objections: { am: 0, pm: 2 },
    byObjection: [
      { key: "price", label: "Price", am: 0, pm: 1 },
      { key: "competitor", label: "Prescribes a competitor", am: 0, pm: 1 },
    ],
  });
  assert.deepEqual(
    team.byProduct.map((row) => [row.label, row.visits, row.objections, row.notes.length, row.products.length]),
    [
      ["Saginko", { am: 1, pm: 2 }, { am: 0, pm: 1 }, 1, 0],
      ["Royafloxacin", { am: 1, pm: 1 }, { am: 0, pm: 1 }, 1, 0],
      ["Guamusin", { am: 0, pm: 1 }, { am: 0, pm: 1 }, 1, 0],
    ],
    "a product discussed twice on one visit counts once; an objection counts against every product discussed on its visit",
  );
  assert.deepEqual(team.byProduct[0]?.notes, [
    {
      visitDate: "2026-10-03",
      listType: "PM",
      objectionLabel: "Price",
      note: "Too expensive for his patients",
      speciality: "Pediatrics",
      area: "Giza 1",
    },
  ]);
  assert.deepEqual(
    team.bySpeciality.map((row) => [row.label, row.visits, row.products.map((product) => [product.name, product.am, product.pm]), row.notes.length]),
    [
      [
        "Pediatrics",
        { am: 2, pm: 1 },
        [
          ["Royafloxacin", 1, 1],
          ["Saginko", 1, 1],
        ],
        0,
      ],
      ["ENT", { am: 0, pm: 1 }, [["Guamusin", 0, 1]], 0],
      ["No speciality recorded", { am: 0, pm: 1 }, [["Saginko", 0, 1]], 0],
    ],
    "one speciality however it is spelt, PM first then AM, and the notes stay on the product grain",
  );
  assert.deepEqual(
    team.byArea?.map((row) => [row.label, row.visits, row.objections]),
    [
      ["Alex 1", { am: 0, pm: 2 }, { am: 0, pm: 1 }],
      ["Giza 1", { am: 2, pm: 1 }, { am: 0, pm: 1 }],
    ],
  );

  // 🔴 NEVER A "NO OBJECTION" FIGURE, NEVER A RATE, NEVER A REP. The whole output, every level down.
  for (const result of [team, buildFieldHeard(HEARD, { products: new Set(["Saginko"]), withArea: false })]) {
    for (const key of keysOf(result)) assert.ok(HEARD_KEYS.includes(key), `What the field heard grew a field it must not have: ${key}`);
    const text = JSON.stringify(result);
    assert.doesNotMatch(text, /"none"|No objection|never read/, "'No objection' and an unanswered visit's note never reach the report");
  }

  // A product or marketing manager: his products only, company-wide, and never an area.
  const own = buildFieldHeard(HEARD, { products: new Set(["Saginko"]), withArea: false });
  assert.equal(own.byArea, null, "no area grain for the product and marketing managers");
  assert.deepEqual(own.totals.visits, { am: 1, pm: 2 }, "a visit that discussed none of his products is not his");
  assert.deepEqual(
    own.byProduct.map((row) => row.label),
    ["Saginko"],
  );
  assert.equal(own.byProduct[0]?.notes[0]?.area, null, "a note carries no area for him");
  assert.deepEqual(
    own.bySpeciality.find((row) => row.label === "Pediatrics")?.products.map((product) => product.name),
    ["Saginko"],
    "somebody else's product discussed on the same visit is left out of his rows",
  );

  // What was said: newest first, and capped.
  const many: HeardVisit[] = Array.from({ length: 25 }, (_, index): HeardVisit => ({
    visitDate: `2026-10-${String(index + 1).padStart(2, "0")}`,
    listType: "PM",
    products: ["Saginko"],
    objection: "price",
    objectionNote: `note ${index + 1}`,
    speciality: null,
    area: null,
  }));
  const capped = buildFieldHeard(many, { products: null, withArea: true }).byProduct[0];
  assert.equal(HEARD_NOTES_PER_PRODUCT, 20);
  assert.equal(capped?.notes.length, 20);
  assert.deepEqual([capped?.notes[0]?.visitDate, capped?.notes[19]?.visitDate], ["2026-10-25", "2026-10-06"]);
  assert.equal(buildFieldHeard(many, { products: null, withArea: true, notesPerProduct: 3 }).byProduct[0]?.notes.length, 3);

  // One wording for a pair, on the screen and in the workbook: only the halves that happened, never one figure.
  assert.equal(heardTallyText({ am: 0, pm: 5 }), "5 PM");
  assert.equal(heardTallyText({ am: 1, pm: 3 }), "1 AM · 3 PM");
  assert.equal(heardTallyText({ am: 1234, pm: 0 }), "1,234 AM");
  assert.equal(heardTallyText({ am: 0, pm: 0 }), "—");
  assert.equal(HEARD_BASIS_TEXT.assigned, "from your own product list");

  // An empty period: zeros and empty grains, never an error.
  const empty = buildFieldHeard([], { products: null, withArea: true });
  assert.deepEqual(empty, { byProduct: [], bySpeciality: [], byArea: [], totals: { visits: { am: 0, pm: 0 }, objections: { am: 0, pm: 0 }, byObjection: [] } });

  // Whose products: exactly what the sales side says. His own list wins, and an empty list reads
  // nothing; with no list, the products of the lines his sales scope is bounded to; with no line bound
  // at all, every product.
  assert.deepEqual(heardProductScope({ assignedFamilies: ["Saginko", " "], lineFamilies: ["Guamusin"] }), {
    families: new Set(["Saginko"]),
    basis: "assigned",
  });
  assert.deepEqual(heardProductScope({ assignedFamilies: ["Saginko"], lineFamilies: null }), { families: new Set(["Saginko"]), basis: "assigned" });
  assert.deepEqual(heardProductScope({ assignedFamilies: [], lineFamilies: ["Guamusin"] }), { families: new Set(), basis: "none" });
  assert.deepEqual(heardProductScope({ assignedFamilies: null, lineFamilies: ["Guamusin", "Ivyronc"] }), {
    families: new Set(["Guamusin", "Ivyronc"]),
    basis: "line",
  });
  assert.deepEqual(heardProductScope({ assignedFamilies: null, lineFamilies: [] }), { families: new Set(), basis: "none" });
  assert.deepEqual(heardProductScope({ assignedFamilies: null, lineFamilies: null }), { families: null, basis: "every" });

  // The customer's objection is never turned into the Super Admin's behaviour check.
  for (const path of ["src/lib/phoenix-crm/field-heard.ts", "src/lib/phoenix-crm/server/insight-reports.ts", "src/components/phoenix-crm/insight-reports.tsx"]) {
    assert.doesNotMatch(source(path), /behaviour-integrity|never_a_negative/, `${path} must not reach the behaviour check`);
  }
}

// ── 3 · Missing stock ──────────────────────────────────────────────────────────────────────────────

const STOCK_ROWS: Array<Record<string, unknown>> = [
  {
    id: "visit-1",
    seat_id: "S1",
    customer_id: "c-1",
    list_type: "PM",
    visit_date: "2026-10-03",
    captured_at: "2026-10-03T08:00:00.000Z",
    pharmacy_name: "El Shifa",
    product_availability: { "Saginko 120": "missing", "Royafloxacin 500": "has" },
    next_step: "pharmacy_stock",
    next_step_on: "2026-10-08",
  },
  {
    id: "visit-2",
    seat_id: "S1",
    customer_id: "c-2",
    list_type: "PM",
    visit_date: "2026-10-05",
    captured_at: "2026-10-05T08:00:00.000Z",
    pharmacy_name: " el shifa ",
    product_availability: { "Saginko 120": "has" },
    next_step: "follow_up",
    next_step_on: null,
  },
  {
    id: "visit-3",
    seat_id: "S1",
    customer_id: "c-3",
    list_type: "AM",
    visit_date: "2026-10-04",
    captured_at: "2026-10-04T08:00:00.000Z",
    pharmacy_name: "Nour",
    product_availability: { "Saginko 120": "missing", junk: "maybe" },
    next_step: "pharmacy_stock",
    next_step_on: null,
  },
  {
    id: "visit-4",
    seat_id: "S1",
    customer_id: "c-4",
    list_type: "PM",
    visit_date: "2026-10-06",
    captured_at: "2026-10-06T08:00:00.000Z",
    pharmacy_name: null,
    product_availability: { "Saginko 120": "missing" },
    next_step: null,
    next_step_on: null,
  },
  {
    id: "visit-5",
    seat_id: "S2",
    customer_id: "c-5",
    list_type: "PM",
    visit_date: "2026-10-06",
    captured_at: "2026-10-06T09:00:00.000Z",
    pharmacy_name: "Nour",
    product_availability: { "Saginko 120": "missing" },
    next_step: null,
    next_step_on: null,
  },
];

const TERRITORY_NAMES: Record<string, string> = { S1: "Giza 1 · Pedia", S2: "Alex 1 · Pedia" };

function runMissingStockTests(): void {
  // Each pharmacy's LATEST answer per product and territory — the customer card's own grouping.
  const answers = latestStockAnswers(STOCK_ROWS);
  const byKey = (entry: { seatId: string; product: string; pharmacyKey: string }) => `${entry.seatId}|${entry.product}|${entry.pharmacyKey}`;
  assert.deepEqual(
    [...answers].sort((left, right) => byKey(left).localeCompare(byKey(right))),
    [
      {
        seatId: "S1",
        product: "Royafloxacin 500",
        pharmacy: "El Shifa",
        pharmacyKey: "el shifa",
        answer: "has",
        lastReportedAt: "2026-10-03T08:00:00.000Z",
        reports: 1,
      },
      {
        seatId: "S1",
        product: "Saginko 120",
        pharmacy: "el shifa",
        pharmacyKey: "el shifa",
        answer: "has",
        lastReportedAt: "2026-10-05T08:00:00.000Z",
        reports: 2,
      },
      { seatId: "S1", product: "Saginko 120", pharmacy: "Nour", pharmacyKey: "nour", answer: "missing", lastReportedAt: "2026-10-04T08:00:00.000Z", reports: 1 },
      { seatId: "S2", product: "Saginko 120", pharmacy: "Nour", pharmacyKey: "nour", answer: "missing", lastReportedAt: "2026-10-06T09:00:00.000Z", reports: 1 },
    ],
    "the later 'has' at El Shifa replaces its earlier 'missing'; a visit naming no pharmacy answers nothing; a junk answer is dropped",
  );

  const chases = stockChasesOf(
    STOCK_ROWS,
    new Map([
      ["c-1", "Amal Fathy"],
      ["c-3", "Hany Saleh"],
    ]),
  );
  assert.deepEqual(chases, [
    {
      visitId: "visit-1",
      seatId: "S1",
      visitDate: "2026-10-03",
      dueOn: "2026-10-08",
      pharmacy: "El Shifa",
      pharmacyKey: "el shifa",
      customerName: "Amal Fathy",
      listType: "PM",
    },
    { visitId: "visit-3", seatId: "S1", visitDate: "2026-10-04", dueOn: null, pharmacy: "Nour", pharmacyKey: "nour", customerName: "Hany Saleh", listType: "AM" },
  ]);
  // Two chases can share a territory, a day, a customer and a pharmacy — so a row is keyed on its own
  // visit's id, never on what it shows.
  const twice = stockChasesOf([STOCK_ROWS[0], { ...STOCK_ROWS[0], id: "visit-1b" }], new Map([["c-1", "Amal Fathy"]]));
  assert.deepEqual(
    twice.map((chase) => chase.visitId),
    ["visit-1", "visit-1b"],
  );

  const board = buildMissingStock(answers, chases, (seatId) => TERRITORY_NAMES[seatId] ?? "Territory");
  assert.deepEqual(
    board.products.map((product) => [product.product, product.missing.map((entry) => [entry.territoryName, entry.pharmacy, entry.chasePromised]), product.inStock]),
    [
      [
        "Saginko 120",
        [
          ["Alex 1 · Pedia", "Nour", false],
          ["Giza 1 · Pedia", "Nour", true],
        ],
        1,
      ],
      ["Royafloxacin 500", [], 1],
    ],
    "the most pharmacies short first, the latest answer first, and a promised chase marked on its own pharmacy only",
  );
  assert.deepEqual(board.summary, { pharmacies: 3, gaps: 2, productsShort: 1, chases: 2 }, "a pharmacy is counted once per territory, as a pharmacy");
  assert.deepEqual(
    board.chases.map((chase) => [chase.dueOn, chase.customerName, chase.territoryName]),
    [
      ["2026-10-08", "Amal Fathy", "Giza 1 · Pedia"],
      [null, "Hany Saleh", "Giza 1 · Pedia"],
    ],
    "the soonest first, a chase with no day last",
  );

  // 🔴 NO LIMIT. The card keeps a customer's 50 most recent pharmacies; the board must not drop the 51st.
  const sixty = Array.from({ length: 60 }, (_, index) => ({
    seat_id: "S1",
    customer_id: `c-${index}`,
    list_type: "PM",
    visit_date: "2026-10-03",
    captured_at: `2026-10-03T08:${String(index).padStart(2, "0")}:00.000Z`,
    pharmacy_name: `Pharmacy ${index + 1}`,
    product_availability: { "Saginko 120": "missing" },
    next_step: null,
    next_step_on: null,
  }));
  const sameFeedback: PharmacyFeedback[] = sixty.map((row): PharmacyFeedback => ({
    customerId: "one key",
    pharmacyName: String(row.pharmacy_name),
    productAvailability: { "Saginko 120": "missing" },
    capturedAt: String(row.captured_at),
  }));
  assert.equal(groupCustomerPharmacies(sameFeedback).get("one key")?.length, 50, "the customer's card keeps its 50");
  assert.equal(latestStockAnswers(sixty).length, 60, "the board keeps every one");
  assert.equal(buildMissingStock(latestStockAnswers(sixty), [], () => "Giza 1").products[0]?.missing.length, 60);

  // Nothing at all: an empty board, not an error.
  assert.deepEqual(buildMissingStock([], [], () => "x"), { products: [], chases: [], summary: { pharmacies: 0, gaps: 0, productsShort: 0, chases: 0 } });

  // What was on the shelf, never a sales figure.
  assert.doesNotMatch(
    source("src/lib/phoenix-crm/missing-stock.ts"),
    /\b(price|prices|closing|sales|units|target|targets|value)\b/i,
    "missing-stock.ts reads no sales figure",
  );
  const loader = source("src/lib/phoenix-crm/server/insight-reports.ts");
  const stockLoader = loader.slice(loader.indexOf("export function latestStockAnswers"), loader.indexOf("export type SamplesReportView"));
  assert.ok(stockLoader.length > 0, "the stock loader was found");
  assert.doesNotMatch(stockLoader, /phx_|closing|monthly_targets|factory_price|source_of_sales/, "the stock board reads no sales source");
  assert.match(stockLoader, /groupCustomerPharmacies\(feedback, Number\.POSITIVE_INFINITY\)/, "the card's own grouping, with no limit");
}

// ── 4 · Samples by month ───────────────────────────────────────────────────────────────────────────

const SAMPLE_VISITS: SamplesVisit[] = [
  { seatId: "S1", listType: "PM", samples: { "Saginko 120": 3, "material:pen": 2 } },
  { seatId: "S1", listType: "AM", samples: { "Saginko 120": 1 } },
  { seatId: "S1", listType: "PM", samples: { "Saginko 120": "2", "material:bogus": 5, "": 4, Royafloxacin: 0, Guamusin: -1, Ivyronc: "abc" } },
  { seatId: "S2", listType: "PM", samples: { "material:giveaway": 1, "material:block_note": 4, Royafloxacin: 2.4 } },
  { seatId: "S3", listType: "PM", samples: { "Saginko 120": 50 } },
  { seatId: "S1", listType: "PM", samples: {} },
  { seatId: "S1", listType: "PM", samples: null },
];

const SAMPLE_TERRITORIES: SamplesTerritory[] = [
  { seatId: "S1", territoryName: "Giza 1", lineName: "Pedia", repName: "First Rep" },
  { seatId: "S2", territoryName: "Alex 1", lineName: "Pedia", repName: "Second Rep" },
  { seatId: "S4", territoryName: "Aswan", lineName: "Pedia", repName: null },
];

function runSamplesTests(): void {
  const report = buildSamplesReport(SAMPLE_VISITS, SAMPLE_TERRITORIES);
  assert.deepEqual(report.items, [
    { key: "Royafloxacin", label: "Royafloxacin", kind: "sample", am: 0, pm: 2 },
    { key: "Saginko 120", label: "Saginko 120", kind: "sample", am: 1, pm: 5 },
    { key: "material:pen", label: "Pen", kind: "material", am: 0, pm: 2 },
    { key: "material:block_note", label: "Block note", kind: "material", am: 0, pm: 4 },
    { key: "material:giveaway", label: "Giveaway", kind: "material", am: 0, pm: 1 },
  ]);
  assert.deepEqual(report.visits, { am: 1, pm: 3 }, "a visit that left nothing is not a visit that left something; a territory not chosen is never counted");
  assert.deepEqual(
    report.territories.map((row) => [row.territoryName, row.visits, row.items.map((item) => [item.label, item.am, item.pm])]),
    [
      [
        "Alex 1",
        { am: 0, pm: 1 },
        [
          ["Royafloxacin", 0, 2],
          ["Block note", 0, 4],
          ["Giveaway", 0, 1],
        ],
      ],
      ["Aswan", { am: 0, pm: 0 }, []],
      [
        "Giza 1",
        { am: 1, pm: 2 },
        [
          ["Saginko 120", 1, 5],
          ["Pen", 0, 2],
        ],
      ],
    ],
    "every chosen territory stays on, the one that left nothing included",
  );

  // 🔴 UNITS OF DIFFERENT PRODUCTS ARE NEVER ADDED. A quantity is summed within its own item only (the
  // five Saginko 120 above are one product's); across items the report counts VISITS — a visit that
  // left samples, a visit that left materials — which add up honestly.
  assert.deepEqual(report.visitsWithSamples, { am: 1, pm: 3 }, "visits that left a free sample, AM and PM apart — never a sum of packs");
  assert.deepEqual(report.visitsWithMaterials, { am: 0, pm: 2 }, "visits that left a material, AM and PM apart — never a sum of pens and pads");
  assert.deepEqual(
    report.territories.map((row) => [row.territoryName, row.visitsWithSamples, row.visitsWithMaterials]),
    [
      ["Alex 1", { am: 0, pm: 1 }, { am: 0, pm: 1 }],
      ["Aswan", { am: 0, pm: 0 }, { am: 0, pm: 0 }],
      ["Giza 1", { am: 1, pm: 2 }, { am: 0, pm: 1 }],
    ],
    "a visit that left both is counted in both, territory by territory",
  );
  assert.deepEqual(
    Object.keys(report).sort(),
    ["items", "territories", "visits", "visitsWithMaterials", "visitsWithSamples"],
    "no field sums the units of different items",
  );

  // 🔴 A RECORD, NEVER A STOCK: no balance, nothing subtracted, nothing issued set beside it.
  assert.deepEqual([...keysOf(report.items)].sort(), ["am", "key", "kind", "label", "pm"]);
  const rules = source("src/lib/phoenix-crm/samples-report.ts");
  assert.doesNotMatch(rules, /balance|issued|allocat|remaining|stock|-=/i, "samples-report.ts holds no stock arithmetic");
  assert.match(rules, /parseSamplesGiven\(visit\.samples\)/, "the visit form's own parser drops the junk");

  const empty = buildSamplesReport([], [{ seatId: "S1", territoryName: "Giza 1", lineName: null, repName: null }]);
  assert.deepEqual(empty.items, []);
  assert.deepEqual(empty.territories.map((row) => row.visits), [{ am: 0, pm: 0 }]);
  assert.deepEqual([empty.visitsWithSamples, empty.visitsWithMaterials], [{ am: 0, pm: 0 }, { am: 0, pm: 0 }]);
}

// ── 5 · The customer's timeline ────────────────────────────────────────────────────────────────────

function runTimelineTests(): void {
  const visit = (patch: Partial<TimelineVisit>): TimelineVisit => ({
    visitId: "v-1",
    visitDate: "2026-10-03",
    capturedAt: "2026-10-03T07:00:00.000Z",
    listType: "PM",
    products: [" Saginko ", ""],
    objection: "price",
    objectionNote: " Too expensive ",
    comment: " Will try a sample ",
    // The write-up he came back and added, and when he last changed it (owner, 2026-10-15). The door
    // comment above stays exactly as he wrote it at the door.
    detailComment: null,
    detailEditedAt: null,
    nextStep: "pharmacy_stock",
    nextStepOn: "2026-10-08",
    enteredByAdmin: false,
    isUnplanned: false,
    unplannedKind: null,
    ...patch,
  });
  const entries = buildCustomerTimeline([
    visit({ detailComment: "  Shelf was empty; he asked for the trial data  ", detailEditedAt: "2026-10-06T16:30:00.000Z" }),
    visit({
      visitId: "v-2",
      visitDate: "2026-10-05",
      capturedAt: "2026-10-05T06:00:00.000Z",
      listType: "AM",
      objection: "none",
      objectionNote: "should not show",
      nextStep: "none",
      nextStepOn: "2026-10-09",
      enteredByAdmin: true,
      isUnplanned: true,
      unplannedKind: "out_of_list",
    }),
    visit({
      visitId: "v-3",
      visitDate: "2026-10-05",
      capturedAt: "2026-10-05T09:00:00.000Z",
      objection: "bogus",
      objectionNote: "should not show",
      comment: "   ",
      nextStep: null,
      nextStepOn: null,
      isUnplanned: true,
      unplannedKind: null,
    }),
  ]);
  assert.deepEqual(entries, [
    {
      visitId: "v-3",
      visitDate: "2026-10-05",
      listType: "PM",
      products: ["Saginko"],
      objectionLabel: null,
      objectionNote: null,
      comment: null,
      detailComment: null,
      detailEditedAt: null,
      nextStepLabel: null,
      nextStepOn: null,
      enteredByAdmin: false,
      offPlanLabel: "Out of plan",
    },
    {
      visitId: "v-2",
      visitDate: "2026-10-05",
      listType: "AM",
      products: ["Saginko"],
      objectionLabel: "No objection",
      objectionNote: null,
      comment: "Will try a sample",
      detailComment: null,
      detailEditedAt: null,
      nextStepLabel: "Nothing to follow",
      nextStepOn: null,
      enteredByAdmin: true,
      offPlanLabel: "Out of list",
    },
    {
      visitId: "v-1",
      visitDate: "2026-10-03",
      listType: "PM",
      products: ["Saginko"],
      objectionLabel: "Price",
      objectionNote: "Too expensive",
      comment: "Will try a sample",
      // The write-up he added afterwards travels beside the door comment, trimmed, and the stamp
      // behind the "Edited · <date and time>" line comes with it (owner, 2026-10-15).
      detailComment: "Shelf was empty; he asked for the trial data",
      detailEditedAt: "2026-10-06T16:30:00.000Z",
      nextStepLabel: "Chase the pharmacy stock",
      nextStepOn: "2026-10-08",
      enteredByAdmin: false,
      offPlanLabel: null,
    },
  ]);
  assert.deepEqual(buildCustomerTimeline([]), [], "a customer nobody has visited yet has an empty timeline");

  // 🔴 NO LOCATION, NO DISTANCE, NO FLAG — not in the read, not in the entry, not on the screen.
  for (const column of TIMELINE_VISIT_COLUMNS.split(",").map((name) => name.trim())) {
    assert.doesNotMatch(
      column,
      /^(lat|lon|accuracy_meters|distance_meters|location_flag|device_skew_minutes|place_id|photo_|voice_note_|dwell_seconds|form_open_seconds|capture_source|offline_seconds|time_anchor_id|synced_at)/,
      `the timeline reads ${column}, which is a measurement and never the rep's to see`,
    );
  }
  assert.equal(TIMELINE_VISITS_MAX, 100);
  const loader = source("src/lib/phoenix-crm/server/customer-timeline.ts");
  assert.match(loader, /territoryForRead\(viewer, raw\.seatId, readTestFlag\(raw\.test\)\)/, "read through the list's own seat gate");
  assert.equal([...loader.matchAll(/\.select\(/g)].length, 2, "two reads: the customer and his visits");
  assert.match(loader, /\.from\("phoenix_crm_visits"\)\s*\.select\(TIMELINE_VISIT_COLUMNS\)/);
  // 2026-10-16 performance audit: asked for together, and the customer check still decides first.
  assert.match(loader, /const \[customer, visits\] = await Promise\.all\(\[/, "the check and the visits travel together");
  assert.ok(
    loader.indexOf("throwIfError(customer.error);") >= 0 &&
      loader.indexOf("throwIfError(customer.error);") < loader.indexOf('throw notFoundError("This customer is not on this territory') &&
      loader.indexOf('throw notFoundError("This customer is not on this territory') < loader.indexOf("throwIfError(visits.error);") &&
      loader.indexOf("throwIfError(visits.error);") < loader.indexOf("buildCustomerTimeline("),
    "a customer who is not here is refused before anything about his visits is looked at",
  );

  const screen = source("src/components/phoenix-crm/customer-timeline.tsx");
  assert.doesNotMatch(screen, /distance|accuracy|location|flag|formatDistance|\blat\b|\blon\b/i, "the timeline screen shows no check of any kind");
  assert.match(screen, /crmUrl\("\/api\/phoenix-crm\/list\/timeline"/);
  assert.match(screen, /No visit saved here yet/, "an empty timeline says so");
  assert.match(source("src/components/phoenix-crm/list-customer.tsx"), /<CustomerTimeline\b/, "the customer's page carries it");

  const route = source("app/api/phoenix-crm/list/timeline/route.ts");
  assert.match(route, /export async function GET\(/);
  assert.doesNotMatch(route, /export async function (POST|PUT|PATCH|DELETE)\(/, "read only");
  assert.ok(
    route.indexOf('assertPermission(access, "phoenix_crm", "read")') !== -1 &&
      route.indexOf('assertPermission(access, "phoenix_crm", "read")') < route.indexOf("loadCustomerTimeline("),
    "the permission is asserted before anything is read",
  );
  const entry = findAccessRegistryEntry("/api/phoenix-crm/list/timeline", "GET");
  assert.equal(entry?.pattern, "/api/phoenix-crm/list/timeline", "the route has its own registry entry");
  assert.deepEqual(entry?.permission, { resource: "phoenix_crm", action: "read" });
}

// ── 6 · Who reads what — the scope matrix ──────────────────────────────────────────────────────────

const CEO: OrgSeat = {
  seatId: "SEAT-CEO",
  parentSeatId: null,
  tier: "CEO",
  path: ["SEAT-CEO"],
  occupantHrId: "C-1",
  lineCode: null,
  lineName: null,
  areaName: null,
  regionName: null,
  seatLabel: "CEO",
};

function under(parent: OrgSeat, patch: Partial<OrgSeat> & Pick<OrgSeat, "seatId" | "tier" | "occupantHrId">): OrgSeat {
  return { ...parent, parentSeatId: parent.seatId, path: [...parent.path, patch.seatId], areaName: null, regionName: null, seatLabel: null, ...patch };
}

const PED_NSM = under(CEO, { seatId: "SEAT-PED-NSM", tier: "NSM", occupantHrId: "N-1", lineCode: "pedia", lineName: "Pedia" });
const PED_DM_1 = under(PED_NSM, { seatId: "SEAT-PED-DM-1", tier: "DM", occupantHrId: "D-1" });
const PED_REP_1 = under(PED_DM_1, { seatId: "SEAT-PED-REP-1", tier: "REP", occupantHrId: "R-1", areaName: "Giza 1" });
const PED_REP_2 = under(PED_DM_1, { seatId: "SEAT-PED-REP-2", tier: "REP", occupantHrId: "R-2", areaName: "Giza 2" });
const PED_DM_2 = under(PED_NSM, { seatId: "SEAT-PED-DM-2", tier: "DM", occupantHrId: "D-2" });
const PED_REP_3 = under(PED_DM_2, { seatId: "SEAT-PED-REP-3", tier: "REP", occupantHrId: "R-3", areaName: "Alex 1" });
const CNS_NSM = under(CEO, { seatId: "SEAT-CNS-NSM", tier: "NSM", occupantHrId: "N-2", lineCode: "cns", lineName: "CNS" });
const CNS_DM = under(CNS_NSM, { seatId: "SEAT-CNS-DM-1", tier: "DM", occupantHrId: "D-3" });
const CNS_REP = under(CNS_DM, { seatId: "SEAT-CNS-REP-1", tier: "REP", occupantHrId: "R-4", areaName: "Cairo 1" });
// A line that has not opened.
const AIF_DM = under(CEO, { seatId: "SEAT-AIF-DM-1", tier: "DM", occupantHrId: "D-4", lineCode: "anti_infective", lineName: "Anti Infective" });
const AIF_REP = under(AIF_DM, { seatId: "SEAT-AIF-REP-1", tier: "REP", occupantHrId: "R-5", areaName: "Delta 1" });

const ORG = buildOrgIndex([CEO, PED_NSM, PED_DM_1, PED_REP_1, PED_REP_2, PED_DM_2, PED_REP_3, CNS_NSM, CNS_DM, CNS_REP, AIF_DM, AIF_REP]);
const OPEN_LINES = new Set(["pedia", "cns"]);
const COMPANY_ROLES = new Set(["Super Admin", "CEO", "SFE Manager"]);

/** A viewer built the way resolvePhoenixCrmViewer builds one, from the organogram above. */
function viewerFor(hrId: string, role: string, patch: Partial<PhoenixCrmViewer> = {}): PhoenixCrmViewer {
  const isSuperAdmin = role === "Super Admin";
  const basis = COMPANY_ROLES.has(role) ? "all" : "tree";
  const isOpen = (seat: OrgSeat) => Boolean(seat.lineCode && OPEN_LINES.has(seat.lineCode));
  const scope = territoriesInScope(ORG, hrId, basis);
  const held = ownTerritories(ORG, hrId);
  return {
    hrId,
    role,
    isSuperAdmin,
    isSfeManager: role === "SFE Manager",
    isTestPersona: false,
    basis,
    canCreate: false,
    canApprove: false,
    canUpdate: false,
    org: ORG,
    config: { settings: PHOENIX_CRM_DEFAULT_SETTINGS, lineRollout: [] },
    cairoToday: "2026-10-02",
    visitDay: "2026-10-02",
    openLines: OPEN_LINES,
    ownTerritories: held.filter(isOpen),
    waitingTerritories: held.filter((seat) => !isOpen(seat)),
    scopeTerritories: isSuperAdmin ? scope : scope.filter(isOpen),
    waitingScopeTerritories: isSuperAdmin ? [] : scope.filter((seat) => !isOpen(seat)),
    managerSeats: heldManagerSeats(ORG, hrId),
    ...patch,
  } as unknown as PhoenixCrmViewer;
}

const ids = (seats: ReadonlyArray<OrgSeat>) => seats.map((seat) => seat.seatId);
const MANAGERS_ONLY = /district managers, national sales managers, SFE and the Super Admin/;
const HEARD_ONLY = /What the field heard is for/;

function runScopeTests(): void {
  // A medical rep: refused all four boards, whatever he sends — here, and not only by a hidden chip.
  const rep = viewerFor("R-1", "Medical Rep");
  assert.equal(readsTeamReports(rep), false);
  refusedWith(() => insightTerritories(rep, {}), MANAGERS_ONLY, "a rep is refused the manager boards");
  refusedWith(() => insightTerritories(rep, { seatId: "SEAT-PED-REP-1" }), MANAGERS_ONLY, "even for his own territory");
  refusedWith(() => fieldHeardAudience(rep, {}), HEARD_ONLY, "a rep is refused What the field heard");

  // A district manager: his own team, and nothing beside it.
  const dm = viewerFor("D-1", "District Manager");
  assert.deepEqual(ids(insightTerritories(dm, {}).seats), ["SEAT-PED-REP-1", "SEAT-PED-REP-2"]);
  assert.deepEqual(ids(insightTerritories(dm, { seatId: "SEAT-PED-REP-2" }).seats), ["SEAT-PED-REP-2"]);
  refusedWith(() => insightTerritories(dm, { seatId: "SEAT-PED-REP-3" }), /outside your scope/, "another district manager's territory is refused");
  refusedWith(() => insightTerritories(dm, { lineCode: "cns" }), /outside your scope/, "another line is refused");
  const dmHeard = fieldHeardAudience(dm, { seatId: "SEAT-PED-REP-1" });
  assert.equal(dmHeard.audience, "team");
  assert.deepEqual(ids(dmHeard.seats), ["SEAT-PED-REP-1", "SEAT-PED-REP-2"], "What the field heard ignores one territory — one territory is one rep");
  assert.equal(insightTerritories(dm, { includeTest: "true" }).includeTest, false, "only the Super Admin includes test entries");

  // A national sales manager: his own line, never another.
  assert.deepEqual(ids(insightTerritories(viewerFor("N-1", "National Sales Manager"), {}).seats), ["SEAT-PED-REP-1", "SEAT-PED-REP-2", "SEAT-PED-REP-3"]);
  assert.deepEqual(ids(insightTerritories(viewerFor("N-2", "National Sales Manager"), {}).seats), ["SEAT-CNS-REP-1"]);

  // A district manager whose line has not opened reads an empty board, and is not refused.
  assert.deepEqual(ids(insightTerritories(viewerFor("D-4", "District Manager"), {}).seats), []);

  // SFE and the CEO: every open line. The Super Admin: every territory — on the field force's own
  // entries, since his test mode was retired on 2026-10-03 (owner: "they test in the phoenix crm is
  // now irrelavent u can fully retiree it"). This line used to pin the opposite.
  const openTerritories = ["SEAT-CNS-REP-1", "SEAT-PED-REP-1", "SEAT-PED-REP-2", "SEAT-PED-REP-3"];
  assert.deepEqual(ids(insightTerritories(viewerFor("S-1", "SFE Manager"), {}).seats), openTerritories);
  assert.deepEqual(ids(insightTerritories(viewerFor("C-1", "CEO"), {}).seats), openTerritories);
  const superAdmin = viewerFor("B-10", "Super Admin");
  assert.deepEqual(ids(insightTerritories(superAdmin, {}).seats), ["SEAT-AIF-REP-1", ...openTerritories]);
  assert.equal(
    insightTerritories(superAdmin, { includeTest: "true" }).includeTest,
    false,
    "the flag is read and DROPPED — a bookmark carrying includeTest=true answers with the real entries, not a 403",
  );
  assert.deepEqual(ids(insightTerritories(superAdmin, { lineCode: "cns" }).seats), ["SEAT-CNS-REP-1"]);

  // The product and marketing managers (owner, 2026-10-02): What the field heard ONLY, company-wide
  // over every open line, whatever line or territory they send — and refused the other four boards.
  for (const [hrId, role] of [
    ["A-10", "Product Manager"],
    ["A-8", "Group Product Manager"],
    ["A-9", "Marketing Manager"],
  ] as const) {
    const viewer = viewerFor(hrId, role);
    assert.equal(readsFieldHeardByProduct(viewer), true, `${role} reads What the field heard`);
    assert.equal(readsTeamReports(viewer), false, `${role} is not a manager of the field`);
    refusedWith(() => insightTerritories(viewer, {}), MANAGERS_ONLY, `${role} is refused the four sales-side boards`);
    const heard = fieldHeardAudience(viewer, { seatId: "SEAT-PED-REP-1", lineCode: "pedia" });
    assert.equal(heard.audience, "products");
    assert.deepEqual(ids(heard.seats), openTerritories, `${role} reads company-wide, over the open lines`);
    assert.equal(phoenixCrmHasSomethingToSay(viewer), true, `${role} has the one report to open`);
  }
  for (const role of ["Medical Rep", "District Manager", "Training Manager", "Super Admin", "HR Operations"]) {
    assert.equal(readsFieldHeardByProduct({ role: role as PhoenixRole }), false, `${role} is not a product or marketing manager`);
  }
  refusedWith(() => fieldHeardAudience(viewerFor("T-1", "Training Manager"), {}), HEARD_ONLY, "a seatless reader without the ruling is refused");
  assert.equal(phoenixCrmHasSomethingToSay(viewerFor("E-1", "Employee")), false, "nobody else gains the module");

  // The permission itself: READ, and nothing else, for exactly those three roles.
  for (const role of ["Product Manager", "Group Product Manager", "Marketing Manager"] as const) {
    assert.deepEqual([...(permissionMatrix[role].phoenix_crm ?? [])], ["read"], `${role} holds phoenix_crm read and nothing more`);
  }

  // The door and the tab: the module is not "closed" for them, and its Reports tab is their door.
  const overview = source("src/lib/phoenix-crm/server/overview.ts");
  assert.match(overview, /if \(readsFieldHeardByProduct\(viewer\)\) return null;/);
  assert.match(overview, /reports: hasScope \|\| readsFieldHeardByProduct\(viewer\),/);
  assert.match(source("src/lib/phoenix-crm/server/reports.ts"), /audience: !readsTeamReports\(viewer\) && readsFieldHeardByProduct\(viewer\) \? "products" : "field"/);
  const tab = source("src/components/phoenix-crm/reports-tab.tsx");
  assert.match(tab, /const productsAudience = view\?\.audience === "products";/);
  // `offer(...)` builds each option's label and note from the report guide (2026-10-03) — before
  // that, every section was spelled out inline here.
  assert.match(tab, /productsAudience\s*\?\s*\[\s*\{ \.\.\.offer\("heard"\)/, "a product or marketing manager is offered What the field heard");
  // 🔴 AND, SINCE 2026-10-07, THE VISITS HE WAS ON (owner: the visits Nada Abdullah filed with Ahmed
  // SharafEldeen "are not appearing in his data"). It is the SAME section a manager reads, scoped on
  // the server to his own row — so the chip must be offered to him or the report has no door.
  assert.match(tab, /\{ \.\.\.offer\("managers"\), note: "The visits you were on" \}/, "the double visitor is offered the visits he was on");
  assert.match(
    source("src/lib/phoenix-crm/server/reports.ts"),
    /hasManagers: managersInScope\(viewer\.org, viewer\.hrId, viewer\.basis\)\.length > 0 \|\| readsOwnRideAlongs\(viewer\),/,
    "and the scope says he has one row to show, himself",
  );
  for (const [hrId, role] of [
    ["A-10", "Product Manager"],
    ["A-8", "Group Product Manager"],
    ["A-9", "Marketing Manager"],
  ] as const) {
    assert.equal(readsOwnRideAlongs(viewerFor(hrId, role)), true, `${role} reads the visits he was on`);
  }
  for (const role of ["Medical Rep", "District Manager", "Training Manager", "Super Admin", "HR Operations"]) {
    assert.equal(readsOwnRideAlongs(viewerFor("X-1", role)), false, `${role} does not read a one-row board about himself`);
  }
  // 🔴 THE TEAM'S GATE IS ASKED FIRST: a product manager who ALSO held a manager seat reads the whole
  // board as a manager, never the one-row version — otherwise the wider report would be taken away
  // from him by a role he holds beside it.
  assert.equal(readsOwnRideAlongs(viewerFor("D-1", "District Manager")), false);
  assert.equal(readsOwnRideAlongs(viewerFor("A-10", "Product Manager", { managerSeats: heldManagerSeats(ORG, "D-1") })), false, "a seat beats the ruling");

  // The service gates every board before it reads anything.
  const service = source("src/lib/phoenix-crm/server/insight-reports.ts");
  for (const name of ["loadCapacityBoard", "loadMissingStockReport", "loadSamplesReport"]) {
    const start = service.indexOf(`export async function ${name}(`);
    assert.ok(start !== -1, `${name} exists`);
    const body = service.slice(start, service.indexOf("\n}\n", start));
    assert.match(body.split("\n")[1] ?? "", /insightTerritories\(viewer, raw\)/, `${name} gates on its first line`);
  }
  const heardLoader = service.slice(service.indexOf("export async function loadFieldHeardReport("));
  assert.match(heardLoader.split("\n")[1] ?? "", /fieldHeardAudience\(viewer, raw\)/, "What the field heard gates on its first line");
  assert.match(heardLoader, /buildFieldHeard\(visits, \{ products: scope\.families, withArea: false \}\)/, "the product audience never reads the area");
  assert.match(heardLoader, /resolveSalesAccessScope\(viewer\.access\)/, "his products are what the sales side says they are, never a second rule");
  assert.match(heardLoader, /salesScope\.allowedProductCodes/, "his own product list first");
  assert.match(heardLoader, /salesScope\.allowedLineNames/, "then the lines his sales scope is bounded to");

  // 🔴 NO `customer_validated` FILTER — and the reason is written down, so it is never "fixed".
  assert.doesNotMatch(service, /customer_validated/, "these boards measure nobody, so they do not filter on validation");
  assert.match(raw("src/lib/phoenix-crm/server/insight-reports.ts"), /NO `customer_validated` FILTER — THESE BOARDS MEASURE NOBODY/);
  assert.doesNotMatch(service, /\.from\("phoenix_crm_visits"\)/, "the boards read the countable visits, never every saved one");
  assert.match(service, /\.from\("phoenix_crm_countable_visits"\)/);

  // The route serves the four, each through its own loader.
  const route = source("app/api/phoenix-crm/reports/route.ts");
  for (const [section, loader] of [
    ["capacity", "loadCapacityBoard"],
    ["heard", "loadFieldHeardReport"],
    ["stock", "loadMissingStockReport"],
    ["samples", "loadSamplesReport"],
  ] as const) {
    assert.match(route, new RegExp(`section === "${section}"\\) report = await ${loader}\\(viewer, filters\\)`));
  }
}

// ── 7 · The screens ────────────────────────────────────────────────────────────────────────────────

function runScreenTests(): void {
  const screen = source("src/components/phoenix-crm/insight-reports.tsx");
  assert.doesNotMatch(screen, /No objection/, "the screen never shows a 'No objection' figure");
  assert.doesNotMatch(screen, /objectionRate|noObjection|NoObjection|Rate\s*[:=(]/, "no rate of any kind on the insight boards");
  for (const path of [
    "src/components/phoenix-crm/insight-reports.tsx",
    "src/components/phoenix-crm/customer-timeline.tsx",
    "src/lib/phoenix-crm/capacity-board.ts",
    "src/lib/phoenix-crm/field-heard.ts",
    "src/lib/phoenix-crm/missing-stock.ts",
    "src/lib/phoenix-crm/samples-report.ts",
    "src/lib/phoenix-crm/customer-timeline.ts",
    "src/lib/phoenix-crm/server/insight-reports.ts",
  ]) {
    assert.doesNotMatch(source(path), AM_PM_SUM, `${path} adds AM and PM together`);
  }
  // Every board says something when there is nothing — real visits were zero the day they shipped.
  for (const title of [
    "No territories to weigh",
    "Nothing heard yet",
    "No products to read",
    "No pharmacy answered yet",
    "Nothing reported missing",
    "Nothing recorded as left in",
  ]) {
    assert.ok(screen.includes(title), `the empty state "${title}" is on the screen`);
  }
  assert.match(screen, /The size of each list, not its coverage/, "the capacity board says what it is not");

  // R1 — an instant is printed as its CAIRO day and time, never sliced to its UTC date: an evening visit
  // in Cairo is already the next day there.
  assert.equal(cairoDayOf("2026-10-04T22:30:00.000Z"), "2026-10-05", "the Cairo day of an instant is not its UTC date");
  assert.match(screen, /last said \$\{cairoStamp\(entry\.lastReportedAt\)\}/, "missing stock prints the Cairo day and time, as the customer's own card does");
  for (const path of [
    "src/components/phoenix-crm/insight-reports.tsx",
    "src/components/phoenix-crm/customer-timeline.tsx",
    "src/lib/phoenix-crm/customer-timeline.ts",
    "src/lib/phoenix-crm/missing-stock.ts",
    "src/lib/phoenix-crm/server/customer-timeline.ts",
    "src/lib/phoenix-crm/server/insight-reports.ts",
    "src/lib/phoenix-crm/server/reports-workbook.ts",
  ]) {
    assert.doesNotMatch(source(path), /(?:At|_at)\)?\.slice\(0, 10\)/, `${path} slices an instant to its UTC date`);
  }

  // O2 — no tile adds up the units of different products; the tiles count VISITS.
  assert.doesNotMatch(screen, /kindTotal|\.reduce\([^;]*?item\.(?:am|pm)/, "no tile adds up units of different products");
  assert.match(screen, /report\.visitsWithSamples\.am, report\.visitsWithSamples\.pm/, "a tile counts the visits that left samples");
  assert.match(screen, /report\.visitsWithMaterials\.am, report\.visitsWithMaterials\.pm/, "and one the visits that left materials");

  // O9 — a chase row is keyed on its visit, never on what it shows.
  assert.match(screen, /keyOf=\{\(chase\) => chase\.visitId\}/, "each chase row is keyed on its own visit");

  // O3 — the header says what the capacity pills judge: the list, never the rep.
  const header = raw("src/components/phoenix-crm/insight-reports.tsx");
  assert.match(header, /judge the LIST/, "the screen's own account says the pills are about the list's size");
  assert.doesNotMatch(header, /nothing names a rep beside a judgement/, "and no longer claims the rows carry no name");
  assert.match(screen, /not validated yet is counted here with the grade iReports360 carried over/, "and says the carried-over grades are used");

  // The detector above is alive.
  assert.match("const both = row.am + row.pm;", AM_PM_SUM);
  assert.match("fieldDays.AM + fieldDays.PM", AM_PM_SUM);
  assert.doesNotMatch("sum.am + item.am", AM_PM_SUM);
}

// ── 8 · "Export all sections" — the four boards in the workbook ───────────────────────────────────

const PERIOD = { from: "2026-10-01", to: "2026-10-07" };

function insightPack(patch: Partial<ReportsPackInput>): ReportsPackInput {
  return {
    viewerName: "Omar Gawish",
    periodText: "2026-10-01 to 2026-10-07",
    scopeText: "4 territories in scope",
    includeTest: false,
    generatedAtIso: "2026-10-02T06:00:00.000Z",
    visits: null,
    plan: null,
    dailyPlan: null,
    coverage: null,
    frequency: null,
    tracking: null,
    calendar: null,
    managers: null,
    locations: null,
    exceptions: null,
    adoption: null,
    bricks: null,
    capacity: null,
    heard: null,
    stock: null,
    samples: null,
    ...patch,
  };
}

/** Every sheet's cells as text, read back out of the REAL workbook, never the input. */
async function cellsOf(input: ReportsPackInput): Promise<Map<string, string[][]>> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load((await buildPhoenixCrmReportsWorkbook(input)) as unknown as ArrayBuffer);
  const sheets = new Map<string, string[][]>();
  for (const sheet of workbook.worksheets) {
    const rows: string[][] = [];
    sheet.eachRow((row) => {
      const cells: string[] = [];
      row.eachCell({ includeEmpty: true }, (cell) => cells.push(String(cell.value ?? "")));
      rows.push(cells);
    });
    sheets.set(sheet.name, rows);
  }
  return sheets;
}

async function runWorkbookTests(): Promise<void> {
  const settings = PHOENIX_CRM_DEFAULT_SETTINGS;
  const board = buildCapacityBoard(CAPACITY_TERRITORIES, { AM: 25, PM: 21 }, settings);
  const capacity: CapacityBoardView = {
    month: { month: "2026-10", monthStart: "2026-10-01", monthEnd: "2026-10-31" },
    monthsOffered: ["2026-10", "2026-11"],
    includeTest: false,
    fieldDays: { AM: 25, PM: 21, holidays: [{ day: "2026-10-08", name: "Armed Forces Day" }] },
    perDay: { AM: perDayFigures(settings, "AM"), PM: perDayFigures(settings, "PM") },
    gradeTargets: settings.gradeTargets,
    rows: board.rows,
    summary: board.summary,
  };
  const heardTeam: FieldHeardView = {
    ...buildFieldHeard(HEARD, { products: null, withArea: true }),
    period: PERIOD,
    includeTest: false,
    audience: "team",
    products: null,
  };
  const heardOwn: FieldHeardView = {
    ...buildFieldHeard(HEARD, { products: new Set(["Saginko"]), withArea: false }),
    period: PERIOD,
    includeTest: false,
    audience: "products",
    products: { names: ["Saginko"], basis: "assigned" },
  };
  const stock: MissingStockView = {
    ...buildMissingStock(latestStockAnswers(STOCK_ROWS), stockChasesOf(STOCK_ROWS, new Map([["c-1", "Amal Fathy"]])), (seatId) => TERRITORY_NAMES[seatId] ?? "Territory"),
    period: PERIOD,
    includeTest: false,
  };
  const samples: SamplesReportView = {
    ...buildSamplesReport(SAMPLE_VISITS, SAMPLE_TERRITORIES),
    month: { month: "2026-10", monthStart: "2026-10-01", monthEnd: "2026-10-31", inProgress: true },
    includeTest: false,
  };
  const insight = [SECTION_TITLES.capacity, SECTION_TITLES.heard, SECTION_TITLES.stock, SECTION_TITLES.samples];

  // A manager's pack holds the four, after the sections already there, exactly as the cover promises.
  const managerPack = insightPack({ capacity, heard: heardTeam, samples, stock });
  const managerSheets = await cellsOf(managerPack);
  assert.deepEqual([...managerSheets.keys()], ["Cover", ...insight], "the four boards are in a manager's workbook, in the screen's order");
  assert.deepEqual(packSections(managerPack), insight, "and the cover promises exactly those tabs");

  // A rep's pack holds none of them — absent, never an empty tab announcing a board he may not read.
  assert.deepEqual([...(await cellsOf(insightPack({}))).keys()], ["Cover"]);

  // AM and PM apart in every one of the four: as many AM columns as PM ones, and never one joining them.
  for (const name of insight) {
    const headers = managerSheets.get(name)?.[1] ?? [];
    const am = headers.filter((header) => /\bAM\b/.test(header)).length;
    const pm = headers.filter((header) => /\bPM\b/.test(header)).length;
    assert.equal(am, pm, `${name}: AM and PM have the same number of columns`);
    for (const header of headers) assert.doesNotMatch(header, /AM\s*[/+]\s*PM|AM and PM/i, `${name}: "${header}" joins AM and PM`);
  }

  const text = (name: string) => (managerSheets.get(name) ?? []).flat().join(" | ");
  // Grade against capacity: the screen's verdict words, and its caveat travelling with the figures.
  assert.ok(text(SECTION_TITLES.capacity).includes("PM over 15 a day"), "the capacity sheet carries the screen's verdict");
  assert.ok(text(SECTION_TITLES.capacity).includes("The size of each list, not its coverage"), "and its caveat");
  assert.ok(text(SECTION_TITLES.capacity).includes("iReports360"), "and says which list was read from iReports360");
  // What the field heard: counts only, no rate, and never a "no objection" figure.
  assert.ok(text(SECTION_TITLES.heard).includes("Counts only: no rate"), "the heard sheet carries its footnote");
  assert.doesNotMatch(text(SECTION_TITLES.heard), /No objection|never read/, "and never prints a no-objection answer or an unanswered visit's note");
  assert.ok(text(SECTION_TITLES.heard).includes("By area"), "the team's sheet reads by area too");
  // Missing stock: a shelf, never a sales figure or a stock balance — and the instant in CAIRO time.
  assert.ok(text(SECTION_TITLES.stock).includes("never a sales figure and never a stock balance"), "the stock sheet carries its footnote");
  assert.ok(text(SECTION_TITLES.stock).includes("2026-10-06 12:00"), "the last answer is printed in Cairo time (09:00 UTC is 12:00 in Cairo)");
  assert.equal(text(SECTION_TITLES.stock).includes("2026-10-06 09:00"), false, "never in UTC");
  // Samples: no total row — units of different products are never added — and no stock balance.
  const samplesRows = managerSheets.get(SECTION_TITLES.samples) ?? [];
  assert.equal(samplesRows.some((cells) => /^(All|Total)\b/i.test(cells[0] ?? "")), false, "the samples sheet carries no total row");
  assert.ok(text(SECTION_TITLES.samples).includes("Units of different products are never added together"), "and says why");
  assert.ok(text(SECTION_TITLES.samples).includes("never a stock: no balance"), "and that it is no stock");
  assert.ok(text(SECTION_TITLES.samples).includes("AM visits that left samples"), "territories are read in VISITS that left samples");

  // A product or marketing manager: his own products, company-wide, and nothing else — no area grain,
  // no area column, and no other sheet at all.
  const ownSheets = await cellsOf(insightPack({ heard: heardOwn }));
  assert.deepEqual([...ownSheets.keys()], ["Cover", SECTION_TITLES.heard], "his pack is the one report");
  const own = (ownSheets.get(SECTION_TITLES.heard) ?? []).flat();
  assert.ok(own.join(" | ").includes("Your products, company-wide: Saginko — from your own product list."), "it names his products and where they came from");
  assert.equal(own.includes("By area"), false, "no area grain for him");
  assert.equal(own.includes("Area"), false, "and no area column on what was said");

  // The route: the four behind the same predicate as the screen, and a product manager's pack is his one report.
  const route = source("app/api/phoenix-crm/reports/export/route.ts");
  assert.match(route, /managerSections \? loadCapacityBoard\(viewer, capacityFilters\) : Promise\.resolve\(null\)/);
  for (const loader of ["loadFieldHeardReport", "loadMissingStockReport", "loadSamplesReport"]) {
    assert.match(route, new RegExp(`managerSections \\? ${loader}\\(viewer, filters\\) : Promise\\.resolve\\(null\\)`), `${loader} is never even called for a viewer who may not read it`);
  }
  assert.match(route, /if \(!managerSections && readsFieldHeardByProduct\(viewer\)\) \{/, "a product or marketing manager takes his own path");
  assert.match(route, /\.\.\.NO_SECTIONS,[\s\S]{0,120}\bheard: ownHeard,/, "and his pack is every section absent but what the field heard");
  assert.match(route, /capacityMonthsOffered\(viewer\.cairoToday\)\.includes\(capacityMonth\)/, "a month the capacity board does not offer reads this month, never fails the pack");
  const tab = source("src/components/phoenix-crm/reports-tab.tsx");
  assert.match(tab, /\{productsAudience \? null : \(\s*<CrmButton busy=\{exporting\}/, "the export button stays hidden from a product or marketing manager");
  assert.match(tab, /capacityMonth: capacityMonthChosen,/, "the tab sends the capacity board's own month with the export");
}

export async function runPhoenixCrmInsightReportsTests(): Promise<void> {
  runCapacityTests();
  runFieldHeardTests();
  runMissingStockTests();
  runSamplesTests();
  runTimelineTests();
  runScopeTests();
  runScreenTests();
  await runWorkbookTests();
}
