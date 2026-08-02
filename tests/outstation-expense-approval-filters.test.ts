import assert from "node:assert/strict";
import {
  UNASSIGNED_EMPLOYEE_KEY,
  buildExpenseApprovalFilterOptions,
  countActiveExpenseApprovalFilters,
  expenseEmployeeKey,
  expenseTripMonthKey,
  expenseTripMonthLabel,
  matchesExpenseApprovalFilters,
} from "../src/lib/outstation/expense-approval-filters.ts";

const NO_FILTERS = { employee: "", month: "" };

export function runOutstationExpenseApprovalFiltersTests() {
  // --- the month a trip is filed under must be the month the queue DISPLAYS ---

  assert.equal(
    expenseTripMonthKey("2026-07-31T22:00:00.000Z"),
    "2026-08",
    "a trip that renders as 01 Aug in Africa/Cairo must filter under August — bucketing on the raw UTC month would file it under July and quietly shorten an entire month of approvals",
  );
  assert.equal(
    expenseTripMonthKey("2026-07-15T00:00:00.000Z"),
    "2026-07",
    "a plain expense_date column arrives as midnight UTC and must stay in its own month",
  );
  assert.equal(
    expenseTripMonthKey("2026-01-01T00:00:00.000Z"),
    "2026-01",
    "January must not roll back into the previous year",
  );

  // --- undated rows are never swept into whichever month is selected ---

  assert.equal(expenseTripMonthKey(""), "", "a blank date belongs to no month");
  assert.equal(expenseTripMonthKey(null), "", "a null date belongs to no month");
  assert.equal(expenseTripMonthKey(undefined), "", "a missing date belongs to no month");
  assert.equal(
    expenseTripMonthKey("not a date"),
    "",
    "an unparseable value with no month in it belongs to no month",
  );
  assert.equal(
    expenseTripMonthKey("2026-03-09"),
    "2026-03",
    "the mapper passes an unparseable date straight through, so a leading YYYY-MM is still honoured rather than dropping the row from the month list",
  );

  // --- labels are human-readable, never a raw key ---

  assert.equal(expenseTripMonthLabel("2026-07"), "July 2026", "months read as a name and a year");
  assert.equal(expenseTripMonthLabel("2026-12"), "December 2026", "the last month is not off by one");
  assert.equal(expenseTripMonthLabel("2026-01"), "January 2026", "the first month is not off by one");
  assert.equal(expenseTripMonthLabel("garbage"), "garbage", "an unknown key renders as itself, never blank");

  // --- one person is ONE option, even when their HR ID failed to map ---

  assert.equal(
    expenseEmployeeKey({ specialist: "Ahmed Sayed Ali" }),
    expenseEmployeeKey({ specialist: "ahmed  sayed   ali" }),
    "case and stray whitespace must not split one employee into two filter entries",
  );
  assert.equal(
    expenseEmployeeKey({ specialist: "Ahmed.Abdallah" }),
    expenseEmployeeKey({ specialist: "Ahmed Abdallah" }),
    "the two spellings production actually holds for one person — the Phoenix request path writes 'Ahmed.Abdallah', the Excel import writes 'Ahmed Abdallah' — must be ONE filter entry, or picking either hides half his trips",
  );
  assert.equal(
    expenseEmployeeKey({ specialist: "" }),
    UNASSIGNED_EMPLOYEE_KEY,
    "a trip with no employee name still lands in a bucket rather than vanishing from the filter",
  );

  // --- options come from the queue, so every choice has a trip behind it ---

  const records = [
    { date: "2026-06-10T00:00:00.000Z", specialist: "Mona Khaled" },
    { date: "2026-07-15T00:00:00.000Z", specialist: "Ahmed Sayed Ali" },
    // Same person, one row whose HR ID never mapped — must NOT become a second option.
    { date: "2026-07-20T00:00:00.000Z", specialist: "Ahmed  Sayed Ali " },
    { date: "2026-08-02T00:00:00.000Z", specialist: "Mona Khaled" },
    { date: "", specialist: "Mona Khaled" },
    // The handle spelling arrives first for this person; the human-written name must still win
    // the dropdown label.
    { date: "2026-06-11T00:00:00.000Z", specialist: "Nadia.Fouad" },
    { date: "2026-06-12T00:00:00.000Z", specialist: "Nadia Fouad" },
  ];
  const options = buildExpenseApprovalFilterOptions(records);

  assert.deepEqual(
    options.months.map((option) => option.value),
    ["2026-08", "2026-07", "2026-06"],
    "months are newest first (the queue is worked newest first), each appears ONCE however many trips it holds, and the undated row adds no month",
  );
  assert.deepEqual(
    options.months.map((option) => option.label),
    ["August 2026", "July 2026", "June 2026"],
    "the month dropdown shows names, not YYYY-MM keys",
  );
  assert.deepEqual(
    options.employees.map((option) => option.label),
    ["Ahmed Sayed Ali", "Mona Khaled", "Nadia Fouad"],
    "employees are alphabetical and deduplicated — the two Ahmed rows are one option (not two identical-looking ones that each hide half his trips), and the handle-spelled 'Nadia.Fouad' merges into her real name rather than sitting beside it",
  );

  // --- filtering: unset matches everything, set filters AND together ---

  const july = { employee: "", month: "2026-07" };
  assert.equal(
    records.filter((record) => matchesExpenseApprovalFilters(record, NO_FILTERS)).length,
    records.length,
    "no filter hides nothing",
  );
  assert.equal(
    records.filter((record) => matchesExpenseApprovalFilters(record, july)).length,
    2,
    "the month filter keeps only that month's trips",
  );
  assert.equal(
    matchesExpenseApprovalFilters({ date: "", specialist: "Mona Khaled" }, july),
    false,
    "an undated trip is excluded by a month filter instead of appearing under every month",
  );

  const ahmedKey = expenseEmployeeKey({ specialist: "Ahmed Sayed Ali" });
  assert.equal(
    records.filter((record) => matchesExpenseApprovalFilters(record, { employee: ahmedKey, month: "" })).length,
    2,
    "picking an employee returns BOTH of that person's trips, including the row whose HR ID never mapped",
  );
  assert.equal(
    records.filter((record) => matchesExpenseApprovalFilters(record, { employee: ahmedKey, month: "2026-07" }))
      .length,
    2,
    "month and employee narrow together",
  );
  assert.equal(
    records.filter((record) => matchesExpenseApprovalFilters(record, { employee: ahmedKey, month: "2026-06" }))
      .length,
    0,
    "a combination with no trips returns nothing rather than falling back to one filter",
  );

  // --- the Clear affordance only appears when something is actually narrowed ---

  assert.equal(countActiveExpenseApprovalFilters(NO_FILTERS), 0, "nothing selected is nothing active");
  assert.equal(countActiveExpenseApprovalFilters(july), 1, "one selection is one active filter");
  assert.equal(
    countActiveExpenseApprovalFilters({ employee: ahmedKey, month: "2026-07" }),
    2,
    "both selections count",
  );
}
