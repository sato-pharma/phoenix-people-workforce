import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { stripComments } from "./support/comment-strip.ts";

import type { OrgSeat } from "../src/lib/phoenix-crm/scope.ts";
import { districtManagerDayOn, type DistrictManagerWeek } from "../src/lib/phoenix-crm/server/manager-dm-day.ts";
import type { ManagerSlotCustomerRow, ManagerSlotRow } from "../src/lib/phoenix-crm/server/manager-plan-rows.ts";

/**
 * The district manager's own day, shown on a regional, national or product manager's "With a district manager"
 * half-day (owner, 2026-11-08: "they must see this district manager plan is planning what today — with a rep, a
 * single, double, area — and see the doctors also").
 */

function slot(overrides: Partial<ManagerSlotRow>): ManagerSlotRow {
  return {
    slotId: "s1",
    planId: "p1",
    date: "2026-11-15",
    half: "AM",
    kind: "with_rep",
    repSeatId: null,
    repHrId: null,
    activityType: null,
    areaSeatId: null,
    areaCode: null,
    areaName: null,
    scopeDmSeatId: null,
    scopeLineCode: null,
    scopeRegionCode: null,
    dmVisit: null,
    seniorVisit: null,
    note: null,
    ...overrides,
  };
}

function doctor(slotId: string, name: string, overrides: Partial<ManagerSlotCustomerRow> = {}): ManagerSlotCustomerRow {
  return {
    slotId,
    customerId: `c-${name}`,
    managerCustomerId: null,
    sourceSeatId: null,
    listType: "PM",
    name,
    grade: "A",
    potentialGrade: null,
    speciality: "Pediatrics",
    gone: false,
    ...overrides,
  };
}

const repSeat: Pick<OrgSeat, "areaName" | "regionName" | "lineName" | "seatLabel" | "seatId"> = {
  seatId: "rep-seat",
  areaName: "Nasr City",
  regionName: "Cairo",
  lineName: "Pedia",
  seatLabel: null,
};

export async function runPhoenixCrmManagerPlanDmDayTests(): Promise<void> {
  const week: DistrictManagerWeek = {
    dmSeatId: "dm-seat",
    dmName: "Nermeen Adel",
    status: "submitted",
    statusLabel: "Waiting for approval",
    slots: [
      slot({ slotId: "pm", half: "PM", kind: "single_visit", areaName: "Heliopolis" }),
      slot({ slotId: "am", half: "AM", kind: "with_rep", repSeatId: "rep-seat", repHrId: "B-200" }),
      slot({ slotId: "other-day", date: "2026-11-16", kind: "admin", activityType: "training" }),
    ],
    customersBySlot: new Map([
      ["am", [doctor("am", "Dr Zeinab"), doctor("am", "Dr Ahmed", { grade: null, speciality: null })]],
      ["pm", [doctor("pm", "Dr Old", { gone: true })]],
    ]),
    names: new Map([["B-200", "Ahmed Ali"]]),
  };
  const seatOf = (seatId: string) => (seatId === "rep-seat" ? repSeat : undefined);

  const day = districtManagerDayOn(week, "2026-11-15", seatOf);
  assert.equal(day.dmName, "Nermeen Adel", "the panel names the district manager");
  assert.equal(day.sent, true, "a submitted week reads as sent");
  assert.deepEqual(
    day.halves.map((half) => half.half),
    ["AM", "PM"],
    "only that date's halves, AM first — another day's half never shows",
  );
  const [am, pm] = day.halves;
  assert.equal(am.kindLabel, "Double visit", "a half with a rep is a double visit");
  assert.equal(am.repName, "Ahmed Ali", "the double visit names the rep");
  assert.equal(am.areaName, "Nasr City", "the double visit names the rep's area");
  assert.deepEqual(
    am.customers.map((entry) => entry.name),
    ["Dr Ahmed", "Dr Zeinab"],
    "the doctors he ticked, by name",
  );
  assert.equal(pm.kindLabel, "Single visit", "a single visit says so");
  assert.equal(pm.areaName, "Heliopolis", "the single visit names its area");
  assert.equal(pm.customers[0]?.gone, true, "a doctor no longer on the list is marked, not hidden");

  const draft = districtManagerDayOn({ ...week, status: "draft", statusLabel: "Draft" }, "2026-11-15", seatOf);
  assert.equal(draft.sent, false, "a draft week is shown, and marked not sent");
  const nothing = districtManagerDayOn({ ...week, status: null, statusLabel: "Not started", slots: [] }, "2026-11-15", seatOf);
  assert.deepEqual(nothing.halves, [], "a week not started shows no halves");
  assert.equal(nothing.sent, false, "and is not sent");

  const admin = districtManagerDayOn(week, "2026-11-16", seatOf);
  assert.equal(admin.halves[0]?.kindLabel, "Admin", "an Admin half says Admin");

  // The board reads the district manager's week for a senior manager only, and the With a district manager half
  // shows it; a read that fails is said on the board.
  const plans = stripComments(readFileSync(join(process.cwd(), "src/lib/phoenix-crm/server/manager-plans.ts"), "utf8"));
  assert.match(plans, /writer\.kind === "dm" \|\| writer\.kind === "tm" \? \[\] : \[chosen\?\.dmSeatId/, "a district manager's and the Training Manager's board read no other week");
  assert.match(plans, /view\.districtManagerPlanUnread = true/, "a failed read is said, never shown as nothing planned");
  assert.match(plans, /districtManagerDays = dmWeeks\.map\(\(week\) => districtManagerDayOn\(week, date, seatOf\)\)/, "every day carries the district manager's day");
  const board = stripComments(readFileSync(join(process.cwd(), "src/components/phoenix-crm/manager-plan-board.tsx"), "utf8"));
  assert.match(board, /<WithDmPart canEdit=\{canEdit\} day=\{day\}/, "the With a district manager half gets the day");
  assert.match(board, /day\.districtManagerDays\.find\(\(entry\) => entry\.dmSeatId === dmSeatId\)/, "it shows the picked district manager's day");
}
