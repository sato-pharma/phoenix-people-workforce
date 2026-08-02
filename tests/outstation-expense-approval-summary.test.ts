import assert from "node:assert/strict";
import {
  buildExpenseApprovalEmployeeSummary,
  totalExpenseApprovalSummary,
} from "../src/lib/outstation/expense-approval-summary.ts";
import { expenseEmployeeKey } from "../src/lib/outstation/expense-approval-filters.ts";

type Row = Parameters<typeof buildExpenseApprovalEmployeeSummary>[0][number];

function trip(overrides: Partial<Row>): Row {
  return {
    amWorkload: 0,
    approvedAmount: 1000,
    claimedTotal: 1000,
    date: "2026-06-15T00:00:00.000Z",
    destination: "Alexandria",
    km: 0,
    pmWorkload: 0,
    specialist: "Mona Khaled",
    state: "pending",
    tripId: "TRIP-1",
    ...overrides,
  };
}

export function runOutstationExpenseApprovalSummaryTests() {
  const rows: Row[] = [
    trip({ state: "approved", approvedAmount: 800, claimedTotal: 1000, tripId: "M-1" }),
    trip({ state: "rejected", approvedAmount: 1000, claimedTotal: 1000, tripId: "M-2" }),
    trip({ state: "pending", approvedAmount: 500, claimedTotal: 500, tripId: "M-3" }),
    trip({ specialist: "Ahmed Sayed", state: "approved", approvedAmount: 300, claimedTotal: 300, tripId: "A-1" }),
  ];

  const summaries = buildExpenseApprovalEmployeeSummary(rows);

  // --- one row per person, and every trip lands in exactly one bucket ---

  assert.equal(summaries.length, 2, "two people in, two summary rows out");

  const mona = summaries.find((summary) => summary.employeeLabel === "Mona Khaled");
  assert.ok(mona, "the summary must be findable by the name the UI shows");
  assert.equal(mona.totalCount, 3, "all three of Mona's trips are counted");
  assert.equal(
    mona.approvedCount + mona.rejectedCount + mona.pendingCount,
    mona.totalCount,
    "approved + rejected + pending must equal the total, or the row silently loses a trip",
  );
  assert.equal(mona.approvedCount, 1, "one approved");
  assert.equal(mona.rejectedCount, 1, "one rejected");
  assert.equal(mona.pendingCount, 1, "one still undecided");

  // --- the money each column reports is the money that column actually means ---

  assert.equal(
    mona.approvedValue,
    800,
    "approved value is HR's approved figure (800), NOT the 1,000 that was claimed — this is the number that gets paid",
  );
  assert.equal(
    mona.rejectedValue,
    1000,
    "rejected value is what was CLAIMED, because the point of that column is the money not being paid out",
  );
  assert.equal(mona.pendingValue, 500, "pending value is what the undecided trip would currently pay");
  assert.equal(
    mona.claimedTotal,
    2500,
    "claimed total is the raw sum of every claim regardless of decision, so the original ask survives a reduction",
  );

  // --- expanding a row shows that person's trips, newest first, and nobody else's ---

  assert.deepEqual(
    mona.trips.map((row) => row.tripId),
    ["M-1", "M-2", "M-3"],
    "an expanded row carries exactly that employee's trips",
  );
  assert.ok(
    mona.trips.every((row) => row.specialist === "Mona Khaled"),
    "no other employee's trip may leak into an expanded row",
  );

  // The expanded row shows distance and declared workload, so those must survive the roll-up
  // rather than being dropped on the way through it.
  const detailed = buildExpenseApprovalEmployeeSummary([
    trip({ amWorkload: 6, km: 518, pmWorkload: 9, tripId: "detail" }),
  ]);
  assert.deepEqual(
    {
      am: detailed[0].trips[0].amWorkload,
      km: detailed[0].trips[0].km,
      pm: detailed[0].trips[0].pmWorkload,
    },
    { am: 6, km: 518, pm: 9 },
    "distance and declared AM/PM workload reach the expanded row intact — the reviewer is reading these to judge whether the trip was real",
  );
  assert.equal(
    detailed[0].trips[0].amWorkload,
    6,
    "AM and PM must not be swapped: 6 declared in the morning is not the same claim as 9",
  );

  const dated = buildExpenseApprovalEmployeeSummary([
    trip({ date: "2026-01-05T00:00:00.000Z", tripId: "old" }),
    trip({ date: "2026-07-05T00:00:00.000Z", tripId: "new" }),
    trip({ date: "", tripId: "undated" }),
  ]);
  assert.deepEqual(
    dated[0].trips.map((row) => row.tripId),
    ["new", "old", "undated"],
    "trips inside an expanded row are newest first, matching the queue; an undated trip sinks rather than throwing",
  );

  // --- ordering surfaces the outstanding work ---

  assert.deepEqual(
    summaries.map((summary) => summary.employeeLabel),
    ["Mona Khaled", "Ahmed Sayed"],
    "whoever still owes the most decisions sorts first — the reason to open this tab is to find where the work sits, not to read an alphabet",
  );

  // --- grouping matches the Employee FILTER exactly, so the two views agree on who exists ---

  const split = buildExpenseApprovalEmployeeSummary([
    trip({ specialist: "Ahmed.Abdallah", tripId: "handle" }),
    trip({ specialist: "Ahmed Abdallah", tripId: "real" }),
  ]);
  assert.equal(
    split.length,
    1,
    "the two spellings production holds for one person collapse to ONE summary row, exactly as they collapse to one filter option",
  );
  assert.equal(
    split[0].employeeLabel,
    "Ahmed Abdallah",
    "the human-written name wins the label even though the handle spelling was seen first",
  );
  assert.equal(
    split[0].employeeKey,
    expenseEmployeeKey({ specialist: "Ahmed Abdallah" }),
    "the summary key IS the filter key — if these ever diverge, picking a name in the filter would show a different set than the summary row claims",
  );

  // --- an empty queue summarises to nothing rather than throwing ---

  assert.deepEqual(buildExpenseApprovalEmployeeSummary([]), [], "no trips means no rows");

  // --- the header line must foot to the rows underneath it ---

  const totals = totalExpenseApprovalSummary(summaries);
  assert.equal(totals.employeeCount, 2, "the header counts the people shown");
  assert.equal(totals.approvedCount, 2, "the header's approved count is the sum of the rows'");
  assert.equal(totals.rejectedCount, 1, "the header's rejected count is the sum of the rows'");
  assert.equal(totals.pendingCount, 1, "the header's pending count is the sum of the rows'");
  assert.equal(
    totals.approvedValue,
    1100,
    "the header's approved money is 800 + 300 — a header that does not foot to its own rows is worse than no header",
  );
  assert.deepEqual(
    totalExpenseApprovalSummary([]),
    { approvedCount: 0, approvedValue: 0, employeeCount: 0, pendingCount: 0, rejectedCount: 0 },
    "an empty summary totals to zeroes, not NaN",
  );
}
