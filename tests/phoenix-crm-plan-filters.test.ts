import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  doctorFilterActive,
  EMPTY_DOCTOR_FILTER,
  filterPlannerCustomers,
  plannerBricks,
  plannerFilterOptions,
  plannerGrades,
  plannerSpecialities,
  specialityKey,
  type DoctorFilter,
} from "../src/lib/phoenix-crm/plan-filters.ts";
import { compareFoldedNames, foldedWordsMatch, foldSearchText } from "../src/lib/phoenix-crm/name-fold.ts";
import type { PlannerCustomer } from "../src/lib/phoenix-crm/suggestions.ts";
import { receivesInRange, windowOverlapsRange } from "../src/lib/phoenix-crm/timings.ts";
import type { PhoenixCrmGrade, PhoenixCrmDoctorListType, PhoenixCrmSeason, PhoenixCrmTiming } from "../src/lib/phoenix-crm/types.ts";

/**
 * Phoenix CRM — the doctor-list filter while planning (owner, 2026-09-25: narrow the list by brick, by
 * AM / PM, and by "receives on this day between X and Y"). The three narrowings are independent, each
 * satisfied by ANY of a customer's places. A window reads only with a weekday, and In Ramadan the
 * special timings win, falling back to the normal ones for a customer who set none.
 */

function timing(weekday: number, startMinute: number, endMinute: number | null, season: PhoenixCrmSeason = "normal"): PhoenixCrmTiming {
  return { weekday, startMinute, endMinute, season };
}

function customer(
  customerId: string,
  listType: PhoenixCrmDoctorListType,
  brick: string | null,
  timings: PhoenixCrmTiming[],
  extra: { grade?: PhoenixCrmGrade | null; speciality?: string | null } = {},
): PlannerCustomer {
  return {
    customerId,
    name: customerId,
    listType,
    grade: extra.grade ?? null,
    speciality: extra.speciality ?? null,
    visitsThisMonth: 0,
    pending: false,
    places: [{ placeId: `${customerId}-place`, label: null, address: null, lat: 0, lon: 0, brick, zone: null, timings }],
  };
}

function filter(patch: Partial<DoctorFilter>): DoctorFilter {
  return { ...EMPTY_DOCTOR_FILTER, ...patch };
}

function ids(customers: ReadonlyArray<PlannerCustomer>): string[] {
  return customers.map((customer) => customer.customerId).sort();
}

export function runPhoenixCrmPlanFiltersTests() {
  // Saturday is weekday 6, Sunday 0. doc-sat receives Saturday 14:00–16:00; acc-sun receives Sunday
  // morning; doc-ramadan receives ONLY in Ramadan, Saturday evening, with no normal Saturday window.
  const docSat = customer("doc-sat", "PM", "Nasr City", [timing(6, 840, 960)], { grade: "A", speciality: "Cardiology" });
  const accSun = customer("acc-sun", "AM", "Maadi", [timing(0, 540, 660)], { grade: "B", speciality: "Pharmacy" });
  const docRamadan = customer("doc-ramadan", "PM", "Nasr City", [timing(6, 1260, 1380, "ramadan")], { grade: "A", speciality: "Cardiology" });
  const all = [docSat, accSun, docRamadan];

  // ── AM / PM ─────────────────────────────────────────────────────────────────────────────────────
  assert.deepEqual(ids(filterPlannerCustomers(all, filter({ session: "PM" }))), ["doc-ramadan", "doc-sat"], "PM keeps only the doctors");
  assert.deepEqual(ids(filterPlannerCustomers(all, filter({ session: "AM" }))), ["acc-sun"], "AM keeps only the accounts");
  assert.equal(filterPlannerCustomers(all, EMPTY_DOCTOR_FILTER).length, 3, "no narrowing keeps everyone");

  // ── Brick ───────────────────────────────────────────────────────────────────────────────────────
  assert.deepEqual(
    plannerBricks(all),
    [
      { value: "maadi", label: "Maadi" },
      { value: "nasr city", label: "Nasr City" },
    ],
    "the brick picker lists each brick once, normalized value with its display label, sorted",
  );
  assert.deepEqual(ids(filterPlannerCustomers(all, filter({ brick: "nasr city" }))), ["doc-ramadan", "doc-sat"], "the brick filter reads the normalized value");

  // ── Day of the week ─────────────────────────────────────────────────────────────────────────────
  assert.deepEqual(ids(filterPlannerCustomers(all, filter({ weekday: 6 }))), ["doc-sat"], "Saturday, no Ramadan: only the normal-Saturday doctor");
  assert.deepEqual(ids(filterPlannerCustomers(all, filter({ weekday: 0 }))), ["acc-sun"], "Sunday: only the Sunday account");
  assert.deepEqual(
    ids(filterPlannerCustomers(all, filter({ weekday: 6, ramadan: true }))),
    ["doc-ramadan", "doc-sat"],
    "Saturday in Ramadan: the Ramadan-only doctor joins, and the normal one falls back to his normal window",
  );

  // ── Day + time window ───────────────────────────────────────────────────────────────────────────
  assert.deepEqual(
    ids(filterPlannerCustomers(all, filter({ weekday: 6, fromMinute: 900, toMinute: 960 }))),
    ["doc-sat"],
    "15:00–16:00 overlaps his 14:00–16:00 window",
  );
  assert.equal(
    filterPlannerCustomers(all, filter({ weekday: 6, fromMinute: 1000, toMinute: 1100 })).length,
    0,
    "16:40–18:20 is after his window closes, so he drops out",
  );
  assert.deepEqual(
    ids(filterPlannerCustomers(all, filter({ weekday: 6, fromMinute: 1000, toMinute: 500 }))),
    ["doc-sat"],
    "a backwards range means 'any time that day', so the Saturday doctor stays",
  );

  // ── Grade and speciality (the doctor book) ───────────────────────────────────────────────────────
  assert.deepEqual(plannerGrades(all), ["A", "B"], "the grade picker lists the grades present, in A→B→C order");
  assert.deepEqual(plannerSpecialities(all), ["Cardiology", "Pharmacy"], "the speciality picker lists each speciality once, sorted");
  assert.deepEqual(ids(filterPlannerCustomers(all, filter({ grade: "A" }))), ["doc-ramadan", "doc-sat"], "grade A keeps only the grade-A doctors");
  assert.deepEqual(ids(filterPlannerCustomers(all, filter({ speciality: "Pharmacy" }))), ["acc-sun"], "the speciality filter is an exact match");
  assert.deepEqual(
    ids(filterPlannerCustomers(all, filter({ grade: "A", speciality: "Cardiology", brick: "nasr city" }))),
    ["doc-ramadan", "doc-sat"],
    "grade, speciality and brick narrow together",
  );
  assert.equal(filterPlannerCustomers(all, filter({ grade: "C" })).length, 0, "a grade nobody has keeps no one");

  // ── Which controls light the reset ──────────────────────────────────────────────────────────────
  assert.equal(doctorFilterActive(EMPTY_DOCTOR_FILTER), false);
  assert.equal(doctorFilterActive(filter({ session: "AM" })), true);
  assert.equal(doctorFilterActive(filter({ brick: "maadi" })), true);
  assert.equal(doctorFilterActive(filter({ grade: "A" })), true);
  assert.equal(doctorFilterActive(filter({ speciality: "Cardiology" })), true);
  assert.equal(doctorFilterActive(filter({ weekday: 6 })), true);
  assert.equal(doctorFilterActive(filter({ fromMinute: 600 })), false, "a time with no weekday is inert, so it does not count as active");

  // ── The window primitive ────────────────────────────────────────────────────────────────────────
  assert.equal(windowOverlapsRange({ startMinute: 840, endMinute: 960 }, 900, 1000), true, "half-open ranges overlap");
  assert.equal(windowOverlapsRange({ startMinute: 840, endMinute: 960 }, 960, 1000), false, "touching at the end is not an overlap");
  assert.equal(windowOverlapsRange({ startMinute: 840, endMinute: null }, 890, 1000), true, "an open-ended window counts as one hour long");
  assert.equal(windowOverlapsRange({ startMinute: 840, endMinute: null }, 905, 1000), false, "and closes after that hour");
  assert.equal(receivesInRange([timing(6, 840, 960)], 6, false, 900, 1000), true, "receivesInRange reads the weekday's windows");
  assert.equal(receivesInRange([timing(6, 840, 960)], 0, false, 900, 1000), false, "and nothing on a weekday he does not receive");

  // ── 🔴 Filters are dropdowns, pickers are buttons (owner, 2026-10-01) ─────────────────────────────
  // On the first Delta (1) session reps pressed "Receives on" — a grid of day buttons, the same square
  // buttons as the Week and Day pickers — believing they were choosing the day they were planning.
  {
    const bar = readFileSync("src/components/phoenix-crm/plan-filter-bar.tsx", "utf8");
    assert.doesNotMatch(bar, /<CrmChoice\b|import \{[^}]*\bCrmChoice\b/, "the customer filter holds no button grid at all");
    assert.ok((bar.match(/<CrmSelect\b/g) ?? []).length >= 5, "Receives on, AM or PM, Grade, Brick and Speciality are all dropdowns");
    assert.match(bar, /label="Receives on"/, "the weekday filter is still there, as a dropdown");
    const board = readFileSync("src/components/phoenix-crm/plan-board.tsx", "utf8");
    const weekPanel = readFileSync("src/components/phoenix-crm/plan-week-panel.tsx", "utf8");
    assert.match(board, /<CrmChoice\s+columns=\{4\}\s+label="Week"/, "the Week picker stays a row of buttons");
    assert.match(weekPanel, /<CrmChoice\s+columns=\{3\}\s+label="Day"/, "and so does the Day picker");
  }

  // ── One spelling for a name typed two ways (owner walk, 2026-10-28) ─────────────────────────────
  // Typing مستشفى بنها found only the ى spelling, and أحمد sat about 30 rows from احمد.
  assert.equal(foldSearchText("مستشفى"), foldSearchText("مستشفي"), "a final ى and ي are one letter");
  assert.equal(foldSearchText("أحمد"), foldSearchText("احمد"), "a hamza carrier is a bare alef");
  assert.equal(foldSearchText("صيدلية"), foldSearchText("صيدليه"), "a final ة is ه");
  assert.equal(foldedWordsMatch("مستشفي بنها", ["مستشفى بنها العام"]), true, "typing مستشفي بنها finds مستشفى بنها");
  assert.equal(foldedWordsMatch("بنها مستشفى", ["مستشفي بنها"]), true, "in any order, either spelling on either side");
  assert.equal(foldedWordsMatch("طنطا", ["مستشفى بنها"]), false, "and a word that is not there is still not there");
  assert.deepEqual(["احمد علي", "بسمة", "أحمد سعيد"].sort(compareFoldedNames), ["أحمد سعيد", "احمد علي", "بسمة"], "أحمد and احمد sort side by side");

  // ── One speciality typed several ways is one choice (owner walk, 2026-10-28: Uro and Urology) ───
  assert.equal(specialityKey("Uro"), specialityKey("Urology"), "Uro is Urology");
  assert.equal(specialityKey("\u200fGP"), specialityKey("General Practitioner"), "a hidden right-to-left mark is not a second GP");
  assert.notEqual(specialityKey("GP + Pedia"), specialityKey("GP"), "a combined speciality stays apart");
  assert.equal(specialityKey("   "), null, "a blank speciality is none");
  {
    const spelt = [
      customer("u1", "PM", "Dokki", [], { speciality: "Urology" }),
      customer("u2", "PM", "Dokki", [], { speciality: "Urology" }),
      customer("u3", "PM", "Dokki", [], { speciality: "Uro" }),
      customer("g1", "PM", "Dokki", [], { speciality: "\u200fGP" }),
    ];
    assert.deepEqual(plannerSpecialities(spelt), ["GP", "Urology"], "one choice per speciality, named the way most of them spell it");
    assert.deepEqual(ids(filterPlannerCustomers(spelt, filter({ speciality: "Urology" }))), ["u1", "u2", "u3"], "and choosing it finds every spelling");
  }

  // ── A customer not validated yet is in iReports360's brick, for the brick filter too ──────────
  {
    const pending: PlannerCustomer = {
      ...customer("pending-zamalek", "PM", null, []),
      pending: true,
      places: [],
      reference: { brick: "Zamalek", area: null, address: null },
    };
    assert.deepEqual(
      plannerFilterOptions([docSat, pending]).bricks,
      [
        { value: "nasr city", label: "Brick Nasr City" },
        { value: "zamalek", label: "Brick Zamalek" },
      ],
      "the brick he is grouped under is offered",
    );
    assert.deepEqual(ids(filterPlannerCustomers([docSat, pending], filter({ brick: "zamalek" }))), ["pending-zamalek"], "and choosing it finds him");
    const dayPanel = readFileSync("src/components/phoenix-crm/plan-day-panel.tsx", "utf8");
    assert.match(
      dayPanel,
      /plannerFilterOptions\(offeredCustomers\.filter\(\(customer\) => customer\.listType === focus\)\)/,
      "the day screen offers the choices of the list on screen, never the whole list's",
    );
  }
}
