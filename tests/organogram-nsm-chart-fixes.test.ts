import assert from "node:assert/strict";

import { buildSeatTreeRows, type AuTreeRow } from "../src/lib/reports/organogram-au-source.ts";
import {
  buildOrganogramChartCounts,
  countLaneSeats,
  countRegionOpenSeats,
  describeOrganogramCounts,
} from "../src/lib/reports/organogram-counts.ts";
import { calculateOrganogramStructureKpis } from "../src/lib/reports/organogram-safety.ts";
import { buildOrganogramLanes, rowKey, type OrganogramRow } from "../src/lib/reports/organogram-view-model.ts";

// Regression: 2026-10-26, the National Sales Manager's Pedia chart.
//
// 1. A seat in handover is listed twice by the seat tree — the leaver still on it until her last day
//    and her successor. Every row of the seat took the seat's LAST occupant as its HR id, so Hana
//    Abdelaziz (leaving) was drawn as PD-0029, Aya Mamdouh's id; the two cards then shared one row key
//    and one was deduplicated away. Each row must carry its own occupant.
// 2. The chart's figures disagreed — "37 employees" over "32 / 47", "6 lanes" over "4 lanes", and a
//    lane of five empty seats read "5 team members". Seats are counted once each (a seat in handover
//    is ONE filled seat), and the header, the KPI cards and the lanes read one count.

function seat(overrides: Partial<AuTreeRow> & Pick<AuTreeRow, "seat_id" | "seat_tier">): AuTreeRow {
  return {
    area_code: null,
    area_name: null,
    is_other_pseudo_dm: false,
    is_vacant: !overrides.occupant_hr_id,
    line_code: "PD",
    line_id: 3,
    line_name: "Pedia",
    occupant_hr_id: null,
    parent_seat_id: null,
    region_code: null,
    region_name: "Giza",
    ...overrides,
  };
}

const NAMES: Record<string, string> = {
  "A-12": "Ali Mohamed",
  "B-110": "Hana Abdelaziz Samir Abdelaziz",
  "DM-1": "Giza District Manager",
  "DM-3": "Delta District Manager",
  "PD-0029": "Aya Mamdouh",
  "PD-0040": "Delta Rep",
  "RM-1": "Delta Regional Manager",
};

function treeRows(tree: AuTreeRow[]): OrganogramRow[] {
  const { rows } = buildSeatTreeRows(tree, {
    asOfMonth: null,
    displayNameFor: (hrId) => (hrId ? (NAMES[hrId] ?? hrId) : "Open Vacancy"),
    hireDateFor: () => null,
    offerOutBySeat: new Map(),
    workFieldsFor: () => ({}) as ReturnType<Parameters<typeof buildSeatTreeRows>[1]["workFieldsFor"]>,
  });
  return rows as OrganogramRow[];
}

const PEDIA_TREE: AuTreeRow[] = [
  seat({ occupant_hr_id: "A-12", seat_id: "SEAT-PED-NSM", seat_tier: "NSM" }),
  // A district lane straight under the NSM, with the handover seat and one empty seat.
  seat({ occupant_hr_id: "DM-1", parent_seat_id: "SEAT-PED-NSM", seat_id: "SEAT-PED-DM-GZ", seat_tier: "DM" }),
  // The leaver is read FIRST and her successor LAST — the order that gave Hana Aya's id.
  seat({ occupant_hr_id: "B-110", parent_seat_id: "SEAT-PED-DM-GZ", seat_id: "SEAT-PED-REP-GZ4", seat_tier: "REP" }),
  seat({ occupant_hr_id: "PD-0029", parent_seat_id: "SEAT-PED-DM-GZ", seat_id: "SEAT-PED-REP-GZ4", seat_tier: "REP" }),
  seat({ parent_seat_id: "SEAT-PED-DM-GZ", seat_id: "SEAT-PED-REP-GZ5", seat_tier: "REP" }),
  // A district lane whose manager is filled and every team seat empty (the lane that read
  // "5 team members · 5 vacant").
  seat({ occupant_hr_id: "DM-2", parent_seat_id: "SEAT-PED-NSM", seat_id: "SEAT-PED-DM-MN", seat_tier: "DM" }),
  seat({ parent_seat_id: "SEAT-PED-DM-MN", seat_id: "SEAT-PED-REP-MN1", seat_tier: "REP" }),
  seat({ parent_seat_id: "SEAT-PED-DM-MN", seat_id: "SEAT-PED-REP-MN2", seat_tier: "REP" }),
  seat({ parent_seat_id: "SEAT-PED-DM-MN", seat_id: "SEAT-PED-REP-MN3", seat_tier: "REP" }),
  // A Regional Manager with one district lane under him — one filled seat, one empty.
  seat({ occupant_hr_id: "RM-1", parent_seat_id: "SEAT-PED-NSM", seat_id: "SEAT-PED-RSM-DL", seat_tier: "RSM" }),
  seat({ occupant_hr_id: "DM-3", parent_seat_id: "SEAT-PED-RSM-DL", seat_id: "SEAT-PED-DM-DL", seat_tier: "DM" }),
  seat({ occupant_hr_id: "PD-0040", parent_seat_id: "SEAT-PED-DM-DL", seat_id: "SEAT-PED-REP-DL1", seat_tier: "REP" }),
  seat({ parent_seat_id: "SEAT-PED-DM-DL", seat_id: "SEAT-PED-REP-DL2", seat_tier: "REP" }),
];

function findLane(lanes: ReturnType<typeof buildOrganogramLanes>, dmHrId: string) {
  for (const group of lanes.groups) {
    if (group.dsm?.hrId === dmHrId) return group;
    for (const child of group.childLanes ?? []) {
      if (child.dsm?.hrId === dmHrId) return child;
    }
  }
  return null;
}

export function runOrganogramNsmChartFixesTests() {
  const rows = treeRows(PEDIA_TREE);

  // ── 1. Each card is its own person ─────────────────────────────────
  const handover = rows.filter((row) => row.seatId === "SEAT-PED-REP-GZ4");
  assert.deepEqual(
    handover.map((row) => [row.hrId, row.displayName]),
    [
      ["B-110", "Hana Abdelaziz Samir Abdelaziz"],
      ["PD-0029", "Aya Mamdouh"],
    ],
    "both people on a seat in handover keep their OWN HR id — the leaver is never drawn with her successor's",
  );
  assert.equal(
    new Set(handover.map((row) => rowKey(row))).size,
    2,
    "the leaver and her successor are two cards, never one deduplicated away",
  );
  assert.ok(
    handover.every((row) => row.managerHrId === "DM-1"),
    "both hang off the district manager who holds the parent seat",
  );

  const lanes = buildOrganogramLanes(rows);
  const giza = findLane(lanes, "DM-1");
  assert.ok(giza, "the Giza district lane is drawn");
  assert.deepEqual(
    giza.members.filter((member) => member.seatId === "SEAT-PED-REP-GZ4").map((member) => member.hrId).sort(),
    ["B-110", "PD-0029"],
    "both handover cards reach the lane",
  );

  // ── 2. One count, seats counted once ───────────────────────────────
  const kpis = calculateOrganogramStructureKpis(rows);
  assert.deepEqual(
    { filled: kpis.medicalRep.actual, open: kpis.medicalRep.vacant, total: kpis.medicalRep.total },
    { filled: 2, open: 5, total: 7 },
    "seven rep seats: the handover seat is ONE filled seat, not two",
  );
  assert.deepEqual(
    { filled: kpis.total.actual, open: kpis.total.vacant, total: kpis.total.total },
    { filled: 7, open: 5, total: 12 },
    "twelve sales seats in all (NSM, RSM, three DMs, seven reps)",
  );

  assert.deepEqual(
    countLaneSeats(giza),
    { filled: 1, managerVacant: false, seats: 2, vacant: 1 },
    "the Giza lane has two team seats — the handover seat counts once, as filled",
  );
  const shorouk = findLane(lanes, "DM-2");
  assert.ok(shorouk, "the all-empty district lane is drawn");
  assert.deepEqual(
    countLaneSeats(shorouk),
    { filled: 0, managerVacant: false, seats: 3, vacant: 3 },
    "a lane of three empty seats says 0 of 3 filled, never '3 team members'",
  );
  const region = lanes.groups.find((group) => group.rsm?.hrId === "RM-1");
  assert.ok(region, "the Regional Manager's group is drawn");
  assert.equal(countRegionOpenSeats(region.childLanes ?? []), 1, "the region's one empty rep seat");

  const counts = buildOrganogramChartCounts(rows, lanes.groups);
  assert.deepEqual(
    counts.seats,
    { filled: kpis.total.actual, inHandover: 1, open: kpis.total.vacant, total: kpis.total.total },
    "the header's seat figures ARE the KPI cards' figures",
  );
  assert.deepEqual(
    counts.people,
    { onSalesSeats: 8, outsideSalesSeats: 0, shown: 8 },
    "eight people drawn on seven filled seats — the handover seat shows two",
  );
  assert.deepEqual(
    counts.lanes,
    { direct: 2, district: 3, other: 0, regionalManagers: 1, underRegional: 1 },
    "the district lanes add up: two under the NSM plus one under the Regional Manager",
  );
  assert.equal(
    describeOrganogramCounts(counts),
    "7 of 12 sales seats filled, 5 open. 8 people shown: 1 seat is in handover and shows both the leaver and the successor.",
    "the sentence under the chart reconciles people shown with seats filled",
  );
}
