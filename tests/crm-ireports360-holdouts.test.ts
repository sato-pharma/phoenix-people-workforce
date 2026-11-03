import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  buildHoldoutsReport,
  peopleOnLeaveAllWindow,
  vendorDaysFromRows,
  type HoldoutPerson,
} from "../src/lib/crm/ireports360-holdouts.ts";

const key = (hrId: string) => hrId.trim().toLowerCase();
const person = (name: string): HoldoutPerson => ({ name, tag: null, teams: [] });
const people = new Map([["a", person("Amal")], ["b", person("Badr")], ["c", person("Cairo Manager")]]);

export function runCrmIReports360HoldoutsTests() {
  // Only a vendor row counts on this side; the door serves Phoenix rows too.
  const { days, rowsNamingNobody } = vendorDaysFromRows(
    [
      { agent_hr_id: "A", source: "ireports360", visit_date: "2026-11-01" },
      { agent_hr_id: "B", source: "phoenix", visit_date: "2026-11-01" },
      // A real double: the partner is credited.
      { agent_hr_id: "A", double_crm_id: 77, double_hr_id: "C", source: "ireports360", visit_date: "2026-11-02" },
      // A stray hr id with crm id 0 is no partner on a vendor row.
      { agent_hr_id: "A", double_crm_id: 0, double_hr_id: "B", source: "ireports360", visit_date: "2026-11-03" },
      // A departed rep's rescued row credits the partner only.
      { agent_hr_id: "B", double_crm_id: 77, double_hr_id: "C", partner_credit_only: true, source: "ireports360", visit_date: "2026-11-03" },
      { source: "ireports360", visit_date: "2026-11-04" },
    ],
    key,
  );
  assert.equal(rowsNamingNobody, 1, "a row with no HR id is counted, not lost");
  assert.deepEqual(days.filter((day) => day.key === "b"), [], "neither a Phoenix row, a stray partner nor a rescued rep credits Badr");
  assert.deepEqual(
    days.filter((day) => day.key === "c").map((day) => [day.date, day.via]),
    [["2026-11-02", "partner"], ["2026-11-03", "partner"]],
  );

  const report = buildHoldoutsReport({
    people,
    phoenixDays: [
      { date: "2026-11-01", key: "b" },
      { date: "2026-11-02", key: "b" },
      { date: "2026-11-05", key: "c" },
    ],
    rowsNamingNobody: 0,
    vendorDays: [
      { date: "2026-11-01", key: "a", via: "own" },
      { date: "2026-11-02", key: "a", via: "own" },
      // Both days also in Phoenix: Badr has moved and is not on the list.
      { date: "2026-11-01", key: "b", via: "own" },
      { date: "2026-11-02", key: "b", via: "own" },
      { date: "2026-11-05", key: "c", via: "partner" },
      { date: "2026-11-03", key: "c", via: "partner" },
      { date: "2026-11-04", key: "c", via: "partner" },
      { date: "2026-11-04", key: "c", via: "own" },
      { date: "2026-11-01", key: "stranger", via: "own" },
    ],
  });
  assert.deepEqual(report.rows.map((row) => row.name), ["Amal", "Cairo Manager"], "only iReports360 first; a person with every day in Phoenix is off the list");
  const [amal, manager] = report.rows;
  assert.equal(amal.onlyIReports360, true);
  assert.equal(amal.daysOnlyThere, 2);
  assert.equal(manager.onlyIReports360, false);
  assert.equal(manager.daysOnlyThere, 2, "the day Phoenix also holds is not only there");
  assert.equal(manager.lastDayOnlyThere, "2026-11-04");
  assert.equal(manager.daysOnSomeoneElsesRow, 1, "the 4th has a row of his own, so only the 3rd rests on a rep");
  assert.equal(report.rowsOutsideThisList, 1, "a person the directory does not hold is counted, not listed");
  assert.equal(report.personDaysOnlyThere, 4);

  // Leave covers the window except Fridays. 2026-11-06 is a Friday.
  const windowDays = ["2026-11-05", "2026-11-06", "2026-11-07"];
  const leaveDays = [{ date: "2026-11-05", key: "a" }, { date: "2026-11-07", key: "a" }, { date: "2026-11-05", key: "b" }];
  assert.deepEqual(peopleOnLeaveAllWindow({ appearing: new Set(), candidates: ["a", "b"], leaveDays, windowDays }), ["a"]);
  assert.deepEqual(peopleOnLeaveAllWindow({ appearing: new Set(["a"]), candidates: ["a"], leaveDays, windowDays }), [], "someone who recorded a day was not away all window");

  // What the screen may and may not do, pinned at the source.
  const server = readFileSync("src/lib/crm/ireports360-holdouts-server.ts", "utf8");
  assert.match(server, /scanVisitsForRangeCreditingPartners/, "the vendor side goes through the door that keeps a departed rep's partner");
  assert.doesNotMatch(server, /\.from\(|\.(insert|update|upsert|delete)\(/, "no raw table read, no write");
  assert.doesNotMatch(server, /\.catch\(/, "a failed read is never an empty list");
  const panel = readFileSync("src/components/crm/crm-ireports360-holdouts-panel.tsx", "utf8");
  assert.doesNotMatch(panel, /<button|<form|onClick|fetch\(/, "the tab offers no closing, cutover or start action");
  assert.doesNotMatch(panel, /\bready\b/i, "it says ready about nobody");
  assert.doesNotMatch(panel, /overflow-x-auto|truncate|rounded/, "fits the screen, square edges, no ellipsis");
  assert.match(panel, /Nobody appears in this window\./);
  const page = readFileSync("app/(admin)/admin/crm/page.tsx", "utf8");
  assert.ok(page.indexOf("canUseAdminCrmWorkspace(access)") < page.indexOf("loadIReports360Holdouts("), "the hub's gate comes before the read");
}
