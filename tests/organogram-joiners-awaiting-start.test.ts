import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  buildSeatTreeRows,
  drawJoinersAwaitingStart,
  type AuTreeRow,
  type JoinerAwaitingStart,
} from "../src/lib/reports/organogram-au-source.ts";
import { stripComments } from "./support/comment-strip.ts";

// Regression: 2026-11-03, the owner: "people accepted the job offer are not appearing in organogram".
//
// A seat's date follows the letter since that morning, and the seat tree reads only spans that have
// begun, so Hagar Abu Zeid, Mariam Wagdy and Salma Sabry (all starting 8 Nov) read as bare vacancies.

function seat(overrides: Partial<AuTreeRow> & Pick<AuTreeRow, "seat_id" | "seat_tier">): AuTreeRow {
  return {
    area_code: "CA4",
    area_name: "Cairo 4",
    is_other_pseudo_dm: false,
    is_vacant: !overrides.occupant_hr_id,
    line_code: "PD",
    line_id: 2,
    line_name: "Pedia",
    occupant_hr_id: null,
    parent_seat_id: null,
    region_code: null,
    region_name: "Cairo",
    ...overrides,
  };
}

const NAMES: Record<string, string> = {
  "DM-1": "Zahraa Hamdy",
  "HOLDER": "Still Seated",
  "PD-0036": "Hagar Abu Zeid",
  "PD-0037": "Mariam Wagdy",
};

function rowsOf(tree: AuTreeRow[]) {
  return buildSeatTreeRows(tree, {
    asOfMonth: null,
    displayNameFor: (hrId) => (hrId ? (NAMES[hrId] ?? hrId) : "Vacant"),
    hireDateFor: (hrId) => (hrId === "PD-0036" ? "2026-11-08" : null),
    offerOutBySeat: new Map(),
    workFieldsFor: () => ({}) as ReturnType<Parameters<typeof buildSeatTreeRows>[1]["workFieldsFor"]>,
  }).rows;
}

const TREE: AuTreeRow[] = [
  seat({ occupant_hr_id: "DM-1", seat_id: "SEAT-DM", seat_tier: "DM" }),
  seat({ parent_seat_id: "SEAT-DM", seat_id: "SEAT-REP-CA4", seat_tier: "REP" }),
  seat({ parent_seat_id: "SEAT-DM", seat_id: "SEAT-REP-CA5", seat_tier: "REP" }),
  seat({ occupant_hr_id: "HOLDER", parent_seat_id: "SEAT-DM", seat_id: "SEAT-REP-CA6", seat_tier: "REP" }),
];

const JOINER: JoinerAwaitingStart = {
  effective_from: "2026-11-08",
  occupant_hr_id: "PD-0036",
  seat_id: "SEAT-REP-CA4",
};

export function runOrganogramJoinersAwaitingStartTests() {
  // 1. The joiner is a person on the seat, named, under the seat's manager, with the day they start.
  const rows = rowsOf(drawJoinersAwaitingStart(TREE, [JOINER]));
  const hagar = rows.find((row) => row.seatId === "SEAT-REP-CA4");
  assert.equal(hagar?.type, "employee", "RED the joiner is drawn as a vacancy");
  assert.equal(hagar?.displayName, "Hagar Abu Zeid");
  assert.equal(hagar?.hrId, "PD-0036");
  assert.equal(hagar?.managerHrId, "DM-1");
  assert.equal(hagar?.startsOn, "2026-11-08", "RED the chart cannot say the day they start");

  // 2. Nobody else moves: an empty seat stays vacant, and someone already started has no start day.
  assert.equal(rows.find((row) => row.seatId === "SEAT-REP-CA5")?.type, "vacancy");
  assert.equal(rows.find((row) => row.seatId === "SEAT-DM")?.startsOn, null);

  // 3. A seat somebody still sits in keeps them.
  const seated = rowsOf(drawJoinersAwaitingStart(TREE, [{ ...JOINER, seat_id: "SEAT-REP-CA6" }]));
  assert.equal(seated.find((row) => row.seatId === "SEAT-REP-CA6")?.displayName, "Still Seated");

  // 4. A person the tree already draws is never drawn a second time.
  const twice = drawJoinersAwaitingStart(TREE, [{ ...JOINER, occupant_hr_id: "holder", seat_id: "SEAT-REP-CA5" }]);
  assert.equal(twice.find((s) => s.seat_id === "SEAT-REP-CA5")?.occupant_hr_id, null, "RED one person drawn on two seats");

  // 5. No joiners is the same tree, and the tree handed in is never changed.
  assert.equal(drawJoinersAwaitingStart(TREE, []), TREE);
  assert.equal(TREE[1].occupant_hr_id, null, "RED the seat tree was written to");

  // 6. Only the live chart asks, only for spans still open and still ahead, and through the seat history.
  const source = stripComments(readFileSync("src/lib/reports/organogram-au-source.ts", "utf8"));
  const read = source.slice(source.indexOf("const joinerLoad"), source.indexOf("const { data: treeData, error } = asOfMonth"));
  assert.match(read, /const joinerLoad = asOfMonth\s*\? null/, "RED a past month's picture would draw today's joiners");
  assert.match(read, /\.from\("au_v_seat_occupancy_all"\)/);
  assert.match(read, /\.is\("effective_to", null\)/, "RED someone who declined before their start would still be drawn");
  assert.match(read, /\.gt\("effective_from", todayInCairo\(\)\)/);
  assert.match(source, /const tree = drawJoinersAwaitingStart\(/, "RED the live chart no longer draws them");

  // 7. The tile says it in words, on both places a person's date prints.
  const chart = readFileSync("src/components/organogram/org-chart.tsx", "utf8");
  assert.match(chart, /`Starts \$\{formatHireDate\(row\.startsOn\)\}`/, "RED a manager's line says Joined for a day still to come");
  assert.match(chart, /Starts \{formatHireDate\(row\.startsOn\)\}/, "RED the tile has no start day");
}
