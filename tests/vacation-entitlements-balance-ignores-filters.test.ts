import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { buildEmployeeEligibilityRows } from "../src/lib/vacation/service.ts";
import type { EmployeeDirectoryRow } from "../src/lib/employees/employee-directory.ts";
import type { VacationRequestRecord } from "../src/lib/vacation/types.ts";

/**
 * The Vacation Report's Entitlements tab reports Used Days and Balance Days per employee. Those two
 * numbers are a sum over the employee's approved paid leave inside their own balance period — so the
 * row set handed to buildEmployeeEligibilityRows decides them completely.
 *
 * It used to be handed the report's FILTERED rows, the same set the Requests tab renders. Any active
 * row filter (status, vacation type, payment status, date range, free-text search) therefore removed
 * approved days from the sum and inflated every balance: with Status = Pending selected, the whole
 * company read a full, untouched entitlement no matter how much leave had been taken. That is what
 * "the balance never decreases" looked like on screen, and the CSV export plus the summary tiles
 * (the zero-balance count) inherited it because they are built from these same rows.
 *
 * Guarded on two levels, because the arithmetic and the call site can each break alone:
 *   1. behaviour — the builder must count every approved day it is given, with filters active;
 *   2. the call site — loadVacationReportData must hand it the unfiltered, access-scoped set.
 */

// Fixed clock: hire 2023-01-10 puts "today" inside the 2026-01-10 → 2027-01-10 anniversary period,
// which carries the standard 21-day entitlement (not the accruing first-year one).
const TODAY = "2026-06-15";

function employee(
  overrides: Partial<EmployeeDirectoryRow> & Pick<EmployeeDirectoryRow, "hrId">,
): EmployeeDirectoryRow {
  return {
    departmentName: "Sales",
    displayName: overrides.fullName ?? `Employee ${overrides.hrId}`,
    employmentStatus: "active",
    fullName: overrides.fullName ?? `Employee ${overrides.hrId}`,
    hireDate: "2023-01-10",
    lineName: "CNS",
    managerHrId: "A-1",
    managerName: "Manager One",
    ...overrides,
  } as unknown as EmployeeDirectoryRow;
}

function request(
  overrides: Partial<VacationRequestRecord> &
    Pick<VacationRequestRecord, "id" | "employeeHrId" | "startDate" | "status">,
): VacationRequestRecord {
  return {
    durationDays: 1,
    endDate: overrides.startDate,
    paidDurationDays: 1,
    paymentStatus: "paid",
    vacationType: "annual",
    ...overrides,
  } as unknown as VacationRequestRecord;
}

const B1 = employee({ fullName: "Balance Person", hrId: "B-1" });
const B2 = employee({
  departmentName: "Marketing",
  fullName: "Other Department",
  hrId: "B-2",
  lineName: "Pedia",
});

const APPROVED_ANNUAL = request({ employeeHrId: "B-1", id: "r-annual", paidDurationDays: 2, startDate: "2026-03-01", status: "approved" });
const APPROVED_EMERGENCY = request({ employeeHrId: "B-1", id: "r-emergency", startDate: "2026-04-05", status: "approved", vacationType: "emergency" });
// Not approved yet — must never consume balance.
const PENDING = request({ employeeHrId: "B-1", id: "r-pending", paidDurationDays: 5, startDate: "2026-05-01", status: "pending_hr" });
// Approved but in the PREVIOUS balance period — outside the window, must not count.
const PREVIOUS_PERIOD = request({ employeeHrId: "B-1", id: "r-old", paidDurationDays: 4, startDate: "2025-12-01", status: "approved" });
// Approved and unpaid — zero paid days, so it consumes nothing.
const UNPAID = request({ employeeHrId: "B-1", id: "r-unpaid", paidDurationDays: 0, paymentStatus: "unpaid", startDate: "2026-03-20", status: "approved" });

const ALL_ROWS = [APPROVED_ANNUAL, APPROVED_EMERGENCY, PENDING, PREVIOUS_PERIOD, UNPAID];

type EligibilityFilters = Parameters<typeof buildEmployeeEligibilityRows>[0]["filters"];

function rowFor(rows: VacationRequestRecord[], filters: EligibilityFilters) {
  const built = buildEmployeeEligibilityRows({
    allScopedRows: rows,
    employees: [B1],
    filters,
    today: TODAY,
  });
  const found = built.find((row) => row.hrId === "B-1");
  assert.ok(found, "B-1 must be present in the entitlement rows");
  return found;
}

export function runVacationEntitlementsBalanceIgnoresFiltersTests() {
  // 1. THE HEADLINE. Approved paid days count even while a row filter is active — 2 annual + 1
  // emergency = 3 used, 21 - 3 = 18 left. Under the old call site the caller pre-removed these rows
  // and this read 0 used / 21 left.
  {
    const unfiltered = rowFor(ALL_ROWS, {});
    assert.equal(unfiltered.annualEntitlementDays, 21, "the 2026-01-10 period carries the standard 21 days");
    assert.equal(unfiltered.annualUsedDays, 3, "2 approved annual + 1 approved emergency paid day");
    assert.equal(unfiltered.annualBalanceDays, 18, "21 - 3");

    // The five filters that narrow ROWS ONLY — none of them is part of
    // employeeEligibilityFilterMatches, so every one of them leaves this employee listed while
    // silently changing what the old call site handed the sum. (`search` is deliberately absent:
    // it narrows the employee list as well, and is covered as a list filter below.)
    const rowNarrowingFilters: EligibilityFilters[] = [
      { status: "pending_hr" },
      { paymentStatus: "unpaid" },
      { vacationType: "sick" },
      { dateFrom: "2026-05-01" },
      { dateTo: "2026-01-31" },
    ];
    for (const filters of rowNarrowingFilters) {
      const filtered = rowFor(ALL_ROWS, filters);
      assert.equal(
        filtered.annualUsedDays,
        3,
        `used days must stay 3 with ${JSON.stringify(filters)} active — a row filter must never reach the balance sum`,
      );
      assert.equal(
        filtered.annualBalanceDays,
        18,
        `balance must stay 18 with ${JSON.stringify(filters)} active`,
      );
    }
  }

  // 2. The row set is what decides the number — the defect the fix removes, reproduced by hand.
  // Feed it only what a Status = Pending filter would have left and the balance goes back to reading
  // a full untouched entitlement. Keeps assertion 1 from being a tautology.
  {
    const asOldCallSitePassed = ALL_ROWS.filter((row) => row.status === "pending_hr");
    const wrong = rowFor(asOldCallSitePassed, { status: "pending_hr" });
    assert.equal(wrong.annualUsedDays, 0, "control: a pre-filtered row set is exactly how the balance used to read 0 used");
    assert.equal(wrong.annualBalanceDays, 21, "control: and a full 21-day balance for someone who has taken 3 days");
  }

  // 3. Neither pending, nor a prior period, nor an unpaid day may consume balance — the three row
  // shapes that legitimately contribute nothing, so a future "just sum everything" simplification is
  // caught here rather than by someone's payslip.
  {
    const only = rowFor([PENDING, PREVIOUS_PERIOD, UNPAID], {});
    assert.equal(only.annualUsedDays, 0, "pending + previous-period + unpaid rows consume nothing");
    assert.equal(only.annualBalanceDays, 21, "so the balance is the untouched entitlement");
  }

  // 4. HR ids are mixed case in this database, so the sum must canonicalise both sides — a row
  // stored lower-case belongs to the same person.
  {
    const lowercased = request({ employeeHrId: "b-1", id: "r-lower", paidDurationDays: 2, startDate: "2026-02-02", status: "approved" });
    const withLower = rowFor([APPROVED_ANNUAL, lowercased], {});
    assert.equal(withLower.annualUsedDays, 4, "a lower-cased employee_hr_id row must still count against B-1");
  }

  // 5. The fix must not have disabled filtering altogether: the EMPLOYEE list is still narrowed by
  // the department/line/manager/employee/search pickers, which is what those controls are for.
  {
    const sales = buildEmployeeEligibilityRows({
      allScopedRows: ALL_ROWS,
      employees: [B1, B2],
      filters: { department: "Sales" },
      today: TODAY,
    });
    assert.deepEqual(sales.map((row) => row.hrId), ["B-1"], "a department filter still narrows which employees are listed");

    const searched = buildEmployeeEligibilityRows({
      allScopedRows: ALL_ROWS,
      employees: [B1, B2],
      filters: { search: "Other Department" },
      today: TODAY,
    });
    assert.deepEqual(searched.map((row) => row.hrId), ["B-2"], "free-text search still narrows the employee list");

    const both = buildEmployeeEligibilityRows({
      allScopedRows: ALL_ROWS,
      employees: [B1, B2],
      filters: {},
      today: TODAY,
    });
    assert.equal(both.length, 2, "and with no filter both employees are listed");
  }

  // 6. THE CALL SITE. The behaviour above is only reached if loadVacationReportData hands the builder
  // the unfiltered, access-scoped rows. It cannot be exercised here (it needs the database), so pin
  // the wiring: an explicit no-filter re-read must exist, and the filtered sets the Requests tab
  // renders must not be what the builder receives.
  {
    const source = readFileSync(new URL("../src/lib/vacation/service.ts", import.meta.url), "utf8");
    const start = source.indexOf("async function loadVacationReportData(");
    assert.ok(start > 0, "loadVacationReportData must exist in the vacation service");
    const bodyEnd = source.indexOf("\nasync function ", start + 1);
    const body = source.slice(start, bodyEnd > 0 ? bodyEnd : undefined);

    assert.match(
      body,
      /fetchVacationReportRowsFromDatabase\(\{\s*access,\s*filters:\s*\{\}\s*,\s*visibleEmployeeHrIds\s*\}\)/,
      "loadVacationReportData must re-read the row set with NO filters for the entitlement balances",
    );

    const callStart = body.indexOf("buildEmployeeEligibilityRows({");
    assert.ok(callStart > 0, "loadVacationReportData must build the entitlement rows");
    const call = body.slice(callStart, body.indexOf("});", callStart));
    assert.match(call, /\ballScopedRows\b/, "the builder must be handed the unfiltered scoped rows");
    for (const filteredSet of ["visibleRowsWithWarnings", "filteredRows", "visibleRows"]) {
      assert.ok(
        !call.includes(filteredSet),
        `buildEmployeeEligibilityRows must not be handed ${filteredSet} — that set has the report's row filters already applied`,
      );
    }
  }
}
