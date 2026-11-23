/**
 * Expense Approvals, rebuilt 2026-11-23 — WHAT THE PAGE LOADS, pinned.
 *
 * The page it replaces read every trip ever filed (694 rows, `select("*")`, route polylines
 * included) to draw the 64 that waited. The rebuilt page reads what waits, on the columns it
 * draws, and history only on a press.
 *
 *   1. A duplicate is named in words — "the approved claim of 22 Oct" — never by a code; a rejected
 *      claim is no copy; another employee's claim is never a copy.
 *   2. Whose visit a Phoenix CRM row is: the rep, the manager, the senior, the product manager, or
 *      a later companion — the rule most likely to drift.
 *   3. The history search box cannot write filter syntax.
 *   4. The reads themselves: no `select("*")`, scope applied in the query AND in memory, history
 *      never read with the queue, and field evidence that could not be read is said, not zero.
 *   5. (2026-11-23) Two trips of one person on one day name the shared day; the odometer chain finds
 *      the last reading before a car trip and the driving paid since it.
 */
import assert from "node:assert/strict";
import fs from "node:fs";

import type { ClaimRow } from "@/lib/outstation/approvals/claim-row";
import { MEETING_ACTIVITY_KEYS, pointOf, visitPeople } from "@/lib/outstation/approvals/field-evidence";
import { HISTORY_PAGE_SIZE, historyFilterOf, historySearchTerm } from "@/lib/outstation/approvals/history";
import { findDuplicates, findOdometerChains } from "@/lib/outstation/approvals/queue";
import { isDayActivity } from "@/lib/phoenix-crm/day-activities";
import { managerOwnVisitUuid } from "@/lib/phoenix-crm/server/manager-visit-details";

const trip = (id: number, over: ClaimRow = {}): ClaimRow => ({
  captured_latitude: 27.1809,
  captured_longitude: 31.1837,
  employee_hr_id: "PD-0015",
  expense_type: "traveling",
  id,
  status: "submitted",
  to_area: "Asyut 2",
  to_city: "Asyut",
  trip_end_date: "2026-10-22",
  trip_start_date: "2026-10-22",
  ...over,
});

const code = (source: string) => source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");

export function runExpenseDeskQueueTests() {
  // 1. Duplicates, in words.
  const found = findDuplicates([trip(293)], [trip(292, { status: "accepted_by_admin" })]);
  assert.deepEqual(found.get(293), { days: [], related: [292], tickets: [], trips: ["the approved claim of 22 Oct"] }, "a copy is not named twice as a shared day");
  assert.equal(findDuplicates([trip(293)], [trip(292, { status: "rejected_by_admin" })]).size, 0, "a rejected claim is no copy");
  assert.equal(findDuplicates([trip(293)], [trip(292, { employee_hr_id: "PD-0099", status: "accepted_by_admin" })]).size, 0, "another employee's claim is never a copy");
  assert.equal(findDuplicates([trip(293)], [trip(292, { status: "accepted_by_admin", trip_end_date: "2026-10-23", trip_start_date: "2026-10-23" })]).size, 0);
  // Two waiting copies name each other, as waiting.
  const pair = findDuplicates([trip(293), trip(294)], []);
  assert.deepEqual(pair.get(293)?.trips, ["the waiting claim of 22 Oct"]);
  assert.deepEqual(pair.get(294)?.related, [293]);
  // The same ticket photo on another day's claim (amounts repeat only on overlapping days; a photo repeats on any).
  const ticket = { ticket_attachment_metadata: [{ name: "1-IMG_1649.jpg", size: 48211 }] };
  const repeated = findDuplicates(
    [trip(301, { ...ticket, trip_end_date: "2026-10-24", trip_start_date: "2026-10-24" })],
    [trip(300, { ...ticket, status: "accepted_by_admin" })],
  );
  assert.deepEqual(repeated.get(301)?.tickets, ["the approved claim of 22 Oct"]);
  assert.deepEqual(repeated.get(301)?.trips, []);
  // A meeting or other cost is not a trip, so it is no duplicate trip.
  assert.equal(findDuplicates([trip(310, { expense_type: "meeting" })], [trip(292, { status: "accepted_by_admin" })]).size, 0);

  // 5. A shared trip day (owner, 2026-11-23): the trip inside another trip, flagged on the desk.
  const sohag = { captured_latitude: 26.5591, captured_longitude: 31.6957, to_area: "Sohag 1", to_city: "Sohag" };
  const inside = (over: ClaimRow = {}) =>
    findDuplicates(
      [trip(402, { ...sohag, trip_end_date: "2026-10-23", trip_start_date: "2026-10-22" })],
      [trip(401, { status: "accepted_by_admin", trip_end_date: "2026-10-22", trip_start_date: "2026-10-21", ...over })],
    ).get(402);
  assert.deepEqual(inside(), { days: ["22 Oct with the approved claim of 21 Oct"], related: [401], tickets: [], trips: [] }, "HEADLINE: the shared day, in words");
  assert.equal(inside({ status: "rejected_by_admin" }), undefined, "a rejected trip pays no day");
  assert.equal(inside({ employee_hr_id: "PD-0099" }), undefined, "another employee's trip shares nothing");
  assert.equal(inside({ expense_type: "meeting" }), undefined, "a meeting cost is not a trip");
  assert.equal(inside({ trip_end_date: "2026-10-21" }), undefined, "the day before is not a shared day");
  const long = findDuplicates(
    [trip(402, { ...sohag, trip_end_date: "2026-10-24", trip_start_date: "2026-10-21" })],
    [trip(401, { status: "submitted", trip_end_date: "2026-10-23", trip_start_date: "2026-10-22" })],
  ).get(402);
  assert.deepEqual(long?.days, ["22 Oct and 23 Oct with the waiting claim of 22 Oct"]);

  // 5. The odometer chain: the last reading before a car trip, and the driving paid since it.
  const reading = (km: number) => ({ odometer: { km, readAt: "T", status: "read", tripKm: null } });
  const car = (id: number, date: string, oneWay: number | null, over: ClaimRow = {}): ClaimRow =>
    trip(id, { distance_from_residence_km: oneWay, transportation_type: "car", trip_end_date: date, trip_start_date: date, ...over });
  const sally = findOdometerChains(
    [car(163, "2026-11-11", 180, { car_evidence_metadata: reading(52612) })],
    [car(162, "2026-11-10", 180, { arrival_odometer: reading(52600).odometer, departure_odometer: reading(52605).odometer, status: "accepted_by_admin" })],
  );
  assert.deepEqual(
    sally.get(163),
    { anchor: { date: "2026-11-10", km: 52605 }, paidKmSinceAnchor: 360 },
    "HEADLINE: the departure reading of the trip before, and its way back plus this trip's way out",
  );
  // A trip in between with no reading is driven both ways; the anchor is the one before it.
  const between = findOdometerChains(
    [car(163, "2026-11-11", 180)],
    [car(161, "2026-11-08", 50, { arrival_odometer: reading(52000).odometer, departure_odometer: null }), car(162, "2026-11-10", 100)],
  );
  assert.deepEqual(between.get(163), { anchor: { date: "2026-11-08", km: 52000 }, paidKmSinceAnchor: 430 });
  assert.deepEqual(
    findOdometerChains([car(163, "2026-11-11", 180)], [car(161, "2026-11-08", 50, { car_evidence_metadata: reading(52000) }), car(162, "2026-11-10", null)]).get(163),
    { anchor: { date: "2026-11-08", km: 52000 }, paidKmSinceAnchor: null },
    "a distance unknown on the way makes the paid driving unknown, never zero",
  );
  // What is never an anchor: a rejected trip, another employee's, a train trip, a later trip.
  const skipped = findOdometerChains(
    [car(163, "2026-11-11", 180)],
    [
      car(158, "2026-11-01", 40, { car_evidence_metadata: reading(51000) }),
      car(159, "2026-11-05", 40, { car_evidence_metadata: reading(51500), status: "rejected_by_admin" }),
      car(160, "2026-11-06", 40, { car_evidence_metadata: reading(51600), employee_hr_id: "PD-0099" }),
      car(161, "2026-11-07", 40, { car_evidence_metadata: reading(51700), transportation_type: "train" }),
      car(164, "2026-11-12", 40, { car_evidence_metadata: reading(53000) }),
    ],
  );
  assert.deepEqual(skipped.get(163)?.anchor, { date: "2026-11-01", km: 51000 });
  assert.deepEqual(findOdometerChains([car(163, "2026-11-11", 180)], []).get(163), { anchor: null, paidKmSinceAnchor: null }, "a first car trip has no anchor");
  assert.equal(findOdometerChains([trip(170)], []).size, 0, "only a car trip is chained");

  // 2. Whose visit a row is.
  assert.deepEqual(
    visitPeople({ manager_hr_id: "PD-0015", product_manager_hr_id: null, rep_hr_id: "pd-0101 ", senior_hr_id: "" }).sort(),
    ["PD-0015", "PD-0101"],
  );
  assert.deepEqual(visitPeople({ companion: [{ hr_id: "PD-0200" }], rep_hr_id: "PD-0101" }).sort(), ["PD-0101", "PD-0200"]);
  assert.deepEqual(visitPeople({ companion: { hr_id: "PD-0200" }, rep_hr_id: "PD-0200" }), ["PD-0200"], "one person on a visit twice is one person");
  assert.deepEqual(visitPeople({}), []);
  assert.deepEqual(pointOf("27.18", 31.18), { lat: 27.18, lon: 31.18 });
  assert.equal(pointOf(0, 0), null, "the old 0,0 marker is no position");
  assert.equal(pointOf(27.18, null), null);
  assert.deepEqual(
    [...MEETING_ACTIVITY_KEYS].sort(),
    ["conference", "group_meeting", "meeting", "training"],
    "a recorded meeting is Meeting, Group meeting, Training or Conference (owner, 23 Nov 2026: \"Count them as meetings\")",
  );
  assert.ok(MEETING_ACTIVITY_KEYS.has("training") && MEETING_ACTIVITY_KEYS.has("conference"), "a training or conference day is a worked trip day, never idle");
  for (const away of ["travel", "admin_work", "health_day", "sales_day", "interviews", "rtd"]) {
    assert.ok(!MEETING_ACTIVITY_KEYS.has(away), `${away} is not a meeting — only Training and Conference were widened`);
  }
  for (const key of MEETING_ACTIVITY_KEYS) assert.ok(isDayActivity(key), `${key} is a real Phoenix CRM day activity key, not a typo`);

  // 3. The history search box.
  assert.equal(historySearchTerm("  Hossam   Adel "), "Hossam Adel");
  assert.equal(historySearchTerm("PD-0015"), "PD-0015");
  assert.equal(historySearchTerm("حسام عادل"), "حسام عادل");
  assert.equal(historySearchTerm("x%,status.eq.submitted)"), "x status eq submitted", "nothing a filter could read as syntax survives");
  assert.equal(historySearchTerm(null), "");
  assert.equal(historySearchTerm("a".repeat(200)).length, 60);
  assert.equal(historyFilterOf("rejected"), "rejected");
  assert.equal(historyFilterOf("anything"), "all");
  assert.equal(HISTORY_PAGE_SIZE, 50);

  // 4. The reads.
  const queue = code(fs.readFileSync("src/lib/outstation/approvals/queue.ts", "utf8"));
  const history = code(fs.readFileSync("src/lib/outstation/approvals/history.ts", "utf8"));
  const evidence = code(fs.readFileSync("src/lib/outstation/approvals/field-evidence.ts", "utf8"));
  for (const [name, source] of [["queue.ts", queue], ["history.ts", history], ["field-evidence.ts", evidence]] as const) {
    assert.ok(!/select\(\s*["'`]\*["'`]/.test(source), `${name} never reads select("*")`);
    assert.ok(!/\.(insert|update|upsert|delete|rpc)\(/.test(source), `${name} is read-only`);
  }
  assert.ok(queue.includes("applyEmployeeHrIdInFilter(") && queue.includes("keepExpenseRowsInScope("), "scope is applied in the query and again in memory");
  assert.ok(history.includes("applyEmployeeHrIdInFilter(") && history.includes("keepExpenseRowsInScope("));
  assert.ok(!queue.includes("history"), "the queue never reads history: it loads on a press");
  assert.ok(queue.includes("OUTSTATION_UNDECIDED_STATUSES"), "what waits is the one shared list of undecided statuses");

  // 🔴 The newest paid payout month reaches every place a decided trip's standing is read: the tiles,
  // the claims re-read after a press, and History. Without it a trip its own payroll missed reads
  // "next payroll" (12 of them on 23 Nov 2026).
  assert.ok(queue.includes('.or("imported_payroll_batch_id.not.is.null,imported_to_payroll_at.not.is.null")'), "the newest paid month is read from rows that carry a paid stamp");
  assert.ok(queue.includes("if (error) throw error;\n  return newestPayout("), "a failed read throws; it is never guessed");
  assert.equal(queue.split("readLastPaidPayout(supabase)").length - 1, 2, "HEADLINE: the page load and the after-press re-read both read it");
  assert.ok(queue.includes("const standing = standingOfRow(row, stored, lastPaidPayout);"), "HEADLINE: the tiles count a decided trip with it");
  assert.ok(queue.includes("buildDeskClaim({ context: { lastPaidPayout, today }, ledger: ledgerOf(row), now, row })"), "a claim re-read after a press is told it");
  assert.ok(history.includes("readLastPaidPayout(supabase)") && history.includes("buildDeskClaim({ context: { lastPaidPayout, today },"), "and so is every row of History");
  assert.ok(evidence.includes('unavailable: ["Phoenix CRM field work"]'), "a failed Phoenix CRM read names itself and gives no reading");

  // 🔴 A manager's own visit is asked for by its stored id. Its screen id is `own:<uuid>`; sent to the
  // uuid column, the database refused the positions read for the WHOLE page: no manager's own visit
  // and no place pin carried a position, the page said "visit positions could not be read" on every
  // load of the live desk (23 Nov 2026), and the catch kept no trace of why.
  assert.ok(
    evidence.includes("loadManagerVisitFixes(ownVisits.map((visit) => managerOwnVisitUuid(visit.id)))"),
    "HEADLINE: the positions of a manager's own visits are read by the bare uuid, never the own: label",
  );
  assert.ok(evidence.includes("ownFixes.get(managerOwnVisitUuid(visit.id))"), "HEADLINE: and looked up by the same uuid the read answers with");
  assert.equal(managerOwnVisitUuid("own:50e1f915-2b7c-4841-a208-147980dffbaf"), "50e1f915-2b7c-4841-a208-147980dffbaf", "the label gives its uuid");
  assert.equal(evidence.split('event: "expense_desk_evidence_failed"').length - 1, 2, "HEADLINE: both evidence reads record why they failed; neither swallows it");
  assert.ok(!/} catch {/.test(evidence), "no bare catch is left in the evidence loader");
  assert.ok(evidence.includes('.eq("is_test", false)') && evidence.includes('.is("archived_at", null)'), "test visits and archived copies are never field work");
}
