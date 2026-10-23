import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { buildEmployeeEligibilityRows, requestableAnnualLeaveDays } from "../src/lib/vacation/service.ts";
import type { EmployeeDirectoryRow } from "../src/lib/employees/employee-directory.ts";
import type { VacationRequestRecord } from "../src/lib/vacation/types.ts";

/**
 * The Medical Rep portal home tile ("Your record" → "Annual leave balance") read
 * `leaveEntitlementDays` — the raw yearly grant from getVacationBalancePeriod — which never
 * subtracted a single already-approved day. A rep who had taken 10 of 21 days still saw 21, while
 * the Vacation Report's own Entitlements tab, built from buildEmployeeEligibilityRows, correctly
 * showed 11 left for the same person. The call also passed no employeeHrId, so the one employee
 * whose balance resets on the calendar year (see usesCalendarYearVacationReset) could never get
 * that reset on the home tile either.
 *
 * The fix: getEmployeeAnnualLeaveBalanceDays (vacation/service.ts) computes the figure through
 * buildEmployeeEligibilityRows — the SAME entitlement-row math the report reduces to — never a
 * second copy of the subtraction, and the portal home tile now renders that field
 * (leaveDaysRemaining), labelled "Annual leave left", instead of the raw entitlement.
 *
 * getEmployeeAnnualLeaveBalanceDays itself talks to the database (employee directory + vacation
 * request rows) and cannot be exercised here without one — so this file:
 *   1. reproduces the headline behaviour ("taken days reduce the figure") against
 *      buildEmployeeEligibilityRows directly, the exact function the fix routes through;
 *   2. pins that getEmployeeAnnualLeaveBalanceDays returns that function's OWN balance field
 *      rather than the entitlement field, and reuses the builder rather than re-deriving the sum;
 *   3. pins that the Medical Rep tile renders the new field under the new label, and that the
 *      portal snapshot passes employeeHrId into the balance-period calculation.
 */

const TODAY = "2026-06-15";

function employee(overrides: Partial<EmployeeDirectoryRow> & Pick<EmployeeDirectoryRow, "hrId">): EmployeeDirectoryRow {
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
  overrides: Partial<VacationRequestRecord> & Pick<VacationRequestRecord, "id" | "employeeHrId" | "startDate" | "status">,
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

function functionBody(source: string, signature: string): string {
  const start = source.indexOf(signature);
  assert.ok(start > 0, `${signature} must exist`);
  const nextFn = source.indexOf("\nasync function ", start + 1);
  const nextExported = source.indexOf("\nexport async function ", start + 1);
  const nextExportedPlain = source.indexOf("\nexport function ", start + 1);
  const candidates = [nextFn, nextExported, nextExportedPlain].filter((index) => index > 0);
  return source.slice(start, candidates.length > 0 ? Math.min(...candidates) : undefined);
}

export function runPortalHomeAnnualLeaveLeftTests() {
  // 1. THE HEADLINE, reproduced against the exact function the fix routes through: taking 10 days
  // must bring a 21-day entitlement down to 11 left — not stay pinned at the raw grant.
  {
    const rep = employee({ hrId: "MR-1" });
    const takenTen = request({ employeeHrId: "MR-1", id: "r-taken", paidDurationDays: 10, startDate: "2026-02-01", status: "approved" });

    const untouched = buildEmployeeEligibilityRows({ allScopedRows: [], employees: [rep], filters: {}, today: TODAY });
    assert.equal(untouched[0]?.annualEntitlementDays, 21, "the 2026-01-10 anniversary period carries the standard 21 days");
    assert.equal(untouched[0]?.annualUsedDays, 0, "nothing taken yet");
    assert.equal(untouched[0]?.annualBalanceDays, 21, "so the full entitlement is left");

    const afterTaking = buildEmployeeEligibilityRows({ allScopedRows: [takenTen], employees: [rep], filters: {}, today: TODAY });
    assert.equal(afterTaking[0]?.annualUsedDays, 10, "10 approved paid days used");
    assert.equal(afterTaking[0]?.annualBalanceDays, 11, "21 - 10 left — this is the number a rep must see, never 21");
    assert.notEqual(
      afterTaking[0]?.annualBalanceDays,
      afterTaking[0]?.annualEntitlementDays,
      "balance and entitlement must diverge once a day has been taken — a tile reading the entitlement instead would not notice",
    );
  }

  // 2. THE WIRING. getEmployeeAnnualLeaveBalanceDays must hand back buildEmployeeEligibilityRows'
  // own annualBalanceDays — never annualEntitlementDays — and must reuse the builder rather than
  // re-summing approved days itself.
  {
    const source = readFileSync(new URL("../src/lib/vacation/service.ts", import.meta.url), "utf8");
    const body = functionBody(source, "export async function getEmployeeAnnualLeaveBalanceDays(");

    assert.match(body, /buildEmployeeEligibilityRows\(\{/, "must call the report's own entitlement-row builder, not a second copy of the math");
    assert.ok(
      body.includes("return eligibilityRow ? requestableAnnualLeaveDays(eligibilityRow) : null;"),
      "must return the row's REQUESTABLE balance — entitlement minus used, and 0 while the six-month block applies — never the raw entitlement",
    );
    assert.ok(!body.includes("annualEntitlementDays"), "must never fall back to the raw entitlement field");
    assert.match(body, /hrIdsMatch\(row\.employeeHrId, employee\.hrId\)/, "must narrow the fetched rows to the requested employee before summing");

    // 2b. THE FIGURE ITSELF, behaviourally rather than by matching source. A joiner inside their
    // first six months HAS an accrued balance, and the Vacation Report's Balance column shows it so
    // that a deduction charged against it is visible to HR (tests/deductions-leave-balance.test.ts
    // section 7). The rep still cannot request a paid day: this tile links straight to the request
    // screen, which prices it unpaid, so the tile must read 0 rather than offer days that vanish one
    // click later.
    const joiner = employee({ hrId: "MR-2", hireDate: "2026-04-01" });
    const [joinerRow] = buildEmployeeEligibilityRows({ allScopedRows: [], employees: [joiner], filters: {}, today: TODAY });
    assert.equal(joinerRow?.eligibilityStatus, "first_six_months");
    assert.equal(joinerRow?.eligibleForAnnualPaidLeave, false);
    assert.ok((joinerRow?.annualBalanceDays ?? 0) > 0, "the report row must carry the accrued balance — that is the report's own fix");
    assert.equal(requestableAnnualLeaveDays(joinerRow!), 0, "but the tile must not promise a day the request flow refuses");

    // And nothing about this tile changes for an eligible employee: the two figures are one number.
    const [eligibleRow] = buildEmployeeEligibilityRows({ allScopedRows: [], employees: [employee({ hrId: "MR-3" })], filters: {}, today: TODAY });
    assert.equal(requestableAnnualLeaveDays(eligibleRow!), eligibleRow?.annualBalanceDays);
    assert.equal(requestableAnnualLeaveDays(eligibleRow!), 21);
  }

  // 3. THE HOME TILE. The Medical Rep command center must render the new balance field under the
  // new label — reverting either half silently brings the old bug back.
  {
    const source = readFileSync(new URL("../src/components/employee-portal/portal-command-center.tsx", import.meta.url), "utf8");
    const start = source.indexOf("function MedicalRepCommandCenter(");
    assert.ok(start > 0, "MedicalRepCommandCenter must exist");
    // The tile lives in the rep's streamed "Your record" card since 2026-10-23, which sits after the
    // centre itself, so the range runs to the next role's layout rather than to the next function.
    const nextFn = source.indexOf("\nfunction StandardCommandCenter(", start + 1);
    const body = source.slice(start, nextFn > 0 ? nextFn : undefined);

    assert.match(body, /leaveDaysRemaining/, "the Medical Rep dashboard must read leaveDaysRemaining");
    assert.ok(!body.includes("leaveEntitlementDays"), "the Medical Rep dashboard must not fall back to the raw entitlement field");
    assert.match(body, /label="Annual leave left"/, 'the tile must be labelled "Annual leave left", not "Annual leave balance"');
    assert.match(
      body,
      /value=\{leaveDaysRemaining != null \? `\$\{leaveDaysRemaining\} days` : "Not recorded"\}/,
      "the tile's value must come from leaveDaysRemaining",
    );
  }

  // 4. THE YEAR RESET. getPortalHomeSnapshot must pass employeeHrId into getVacationBalancePeriod
  // so the per-employee calendar-year reset (usesCalendarYearVacationReset) can ever apply on the
  // home page, exactly as the Vacation Report and the request page already do.
  {
    const source = readFileSync(new URL("../src/lib/employee-portal/home-snapshot.ts", import.meta.url), "utf8");
    assert.match(
      source,
      /getVacationBalancePeriod\(\{\s*employeeHrId:\s*hrId,\s*hireDate:\s*shell\.hrContract\.hireDate,\s*referenceDate:\s*today\s*\}\)/,
      "getVacationBalancePeriod must be called with employeeHrId",
    );
    assert.match(
      source,
      /getEmployeeAnnualLeaveBalanceDays\(hrId\)/,
      "getPortalHomeSnapshot must compute leaveDaysRemaining via getEmployeeAnnualLeaveBalanceDays",
    );
  }
}
