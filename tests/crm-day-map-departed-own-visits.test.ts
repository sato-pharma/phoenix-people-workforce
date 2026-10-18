import assert from "node:assert/strict";

import {
  fetchDayMapVisits,
  scanCompanyVisitsByEmployee,
  type DayMapVisitReaders,
} from "../src/lib/attendance/crm-day-maps.ts";
import {
  departedAgentsAmong,
  selectOwnVisitsThroughLastWorkingDate,
  type DepartedCrmAgent,
} from "../src/lib/crm/reads.ts";

/**
 * A LEAVER IS STILL JUDGED ON THEIR OWN CRM VISITS, THROUGH THEIR LAST WORKING DAY.
 *
 * Found 2026-10-18 while building the Field Absence Calendar. The live tier of the CRM departed-agent
 * exclusion keys on employment STATUS, never on a date, and recording a resignation sets that status
 * at once. So a rep serving notice (status `resigned`, last working day still ahead) loses every
 * visit they logged, on every day of the period, the minute HR records it. Measured on production
 * the same day: Hana Abdelaziz Samir Abdelaziz (last working day 31 Oct, recorded 18 Oct) read 0 of
 * her 14 October visit days, and Georgette Hany Awad Aiad (17 Oct) 0 of 13.
 *
 * The money path that reads those visits for a leaver is the CRM day map. The fingerprint report
 * keeps a resigned or terminated person in scope up to the last working day, and a CRM field visit is
 * what cancels that day's fingerprint charge — so the leaver lost the cancel. The fix gives the reader
 * judging that person their own rows back (`ownRowsOfDeparted`), through the last working day only,
 * and leaves every live board's exclusion exactly as it was.
 */

type Row = Awaited<ReturnType<DayMapVisitReaders["asAgent"]>>[number];

function visit(id: string, overrides: Partial<Row>): Row {
  return {
    agent_hr_id: null,
    comment: null,
    customer_name: "Dr Test",
    double2_hr_id: null,
    double_hr_id: null,
    id,
    visit_date: "2026-10-05",
    visit_type: 0,
    visit_type_description: null,
    ...overrides,
  };
}

function readers(parts: Partial<DayMapVisitReaders>): DayMapVisitReaders {
  const none = async () => [] as Row[];
  return { asAgent: none, asDouble: none, companyWindow: none, ownRowsOfDeparted: none, ...parts };
}

const LEAVER = "B-110";
const MANAGER = "B-50";

export async function runCrmDayMapDepartedOwnVisitsTests() {
  // ── 1. The rule in the door: own rows, through the last working day, departed people only ─────

  const departed: DepartedCrmAgent[] = [
    { hrId: "B-110", lastWorkingDate: "2026-10-31" },
    { hrId: "B-182", lastWorkingDate: "2026-10-17" },
    { hrId: "B-9", lastWorkingDate: null },
  ];

  assert.deepEqual(
    departedAgentsAmong(departed, ["b-110", "B-50", "B-182"]).map((agent) => agent.hrId),
    ["B-110", "B-182"],
    "only the departed people among the ones being judged get their own rows back — matched on the canonical HR id, so casing never decides",
  );
  assert.deepEqual(departedAgentsAmong(departed, []), [], "nobody being judged — nobody gets rows back");
  assert.deepEqual(departedAgentsAmong([], ["B-110"]), [], "nobody departed — nothing to put back");

  const own = selectOwnVisitsThroughLastWorkingDate(
    [
      visit("a", { agent_hr_id: "B-182", visit_date: "2026-10-05" }),
      visit("b", { agent_hr_id: "B-182", visit_date: "2026-10-17" }),
      // The day after her last working day: the slot is handed to the replacement hired into her area
      // and line, so a row dated after it is the successor's work, never hers.
      visit("c", { agent_hr_id: "B-182", visit_date: "2026-10-18" }),
      // Somebody else's row on the same read is not this person's own.
      visit("d", { agent_hr_id: "B-77", visit_date: "2026-10-05" }),
      // No last working day recorded: the sync attributed the row to them by date, so it stays.
      visit("e", { agent_hr_id: "b-9", visit_date: "2026-12-01" }),
      visit("f", { agent_hr_id: null, visit_date: "2026-10-05" }),
    ],
    departed,
  );
  assert.deepEqual(
    own.map((row) => row.id),
    ["a", "b", "e"],
    "a departed person keeps the rows they logged on or before their last working day — the last day itself included — and nothing logged after it, and nobody else's",
  );

  // ── 2. The bounded read (the per-employee day report): the leaver's own visit reaches the map ──

  const ownVisit = visit("v1", { agent_hr_id: LEAVER, visit_date: "2026-10-05" });
  const bounded = await scanCompanyVisitsByEmployee(
    { dateFromIso: "2026-10-01", dateToIso: "2026-10-31", employeeHrIds: [LEAVER] },
    readers({
      // The plain agent read hides her row: her status is `resigned`, so the exclusion drops it.
      asAgent: async () => [],
      ownRowsOfDeparted: async (_from, _to, wantedIds) => (wantedIds.includes(LEAVER) ? [ownVisit] : []),
    }),
  );
  assert.equal(
    bounded.get(LEAVER)?.get("2026-10-05")?.length,
    1,
    "a rep serving notice who logged a real visit on 5 October must have that day in the CRM day map — it is the field-visit cancel on her fingerprint charge",
  );

  // ── 3. The company read (the fingerprint report): own row wins over the anonymised copy ────────

  const wanted = Array.from({ length: 45 }, (_unused, index) => `B-${200 + index}`).concat(LEAVER, MANAGER);
  // The partner door returns her double visit with her manager, anonymised on the agent side.
  const rescuedCopy = visit("v2", { agent_hr_id: null, double_hr_id: MANAGER, visit_date: "2026-10-06" });
  const ownCopy = visit("v2", { agent_hr_id: LEAVER, double_hr_id: MANAGER, visit_date: "2026-10-06" });
  const someoneElse = visit("v3", { agent_hr_id: "B-201", visit_date: "2026-10-06" });
  const company = await scanCompanyVisitsByEmployee(
    { dateFromIso: "2026-10-01", dateToIso: "2026-10-31", employeeHrIds: wanted },
    readers({
      companyWindow: async () => [rescuedCopy, someoneElse],
      ownRowsOfDeparted: async () => [ownCopy],
    }),
  );
  assert.equal(
    company.get(LEAVER)?.get("2026-10-06")?.length,
    1,
    "over 40 people the fingerprint report scans the company window, and the leaver's own row must still credit her — the anonymised partner copy alone credits only the manager",
  );
  assert.equal(
    company.get(MANAGER)?.get("2026-10-06")?.length,
    1,
    "the manager riding along keeps his day, once — the two copies of one visit are merged by id, never counted twice",
  );
  assert.equal(company.get("B-201")?.get("2026-10-06")?.length, 1, "everyone else's rows are untouched");

  // ── 4. Nobody departed: the company read comes back exactly as the door returned it ───────────

  const doorRows = [visit("z", { agent_hr_id: "B-201" }), visit("y", { agent_hr_id: "B-202" })];
  const unchanged = await fetchDayMapVisits(
    "2026-10-01",
    "2026-10-31",
    wanted,
    readers({ companyWindow: async () => doorRows }),
  );
  assert.equal(unchanged, doorRows, "with no departed person being judged the company scan is returned as it came, order included");
}
