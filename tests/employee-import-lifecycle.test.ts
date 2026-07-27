import { strict as assert } from "node:assert";

import {
  activeImportEmployeeStatuses,
  isActiveImportEmployee,
  normalizeEmploymentStatus,
} from "../src/lib/imports/employee-lifecycle.ts";

export function runEmployeeImportLifecycleTests() {
  // Active employees are import-active regardless of case / whitespace / missing status.
  assert.equal(isActiveImportEmployee({ employment_status: "active" }), true);
  assert.equal(isActiveImportEmployee({ employment_status: "on_leave" }), true);
  assert.equal(isActiveImportEmployee({ employment_status: "ACTIVE" }), true);
  assert.equal(isActiveImportEmployee({ employment_status: "  On_Leave  " }), true);
  assert.equal(isActiveImportEmployee({ employment_status: null }), true);
  assert.equal(isActiveImportEmployee({ employment_status: undefined }), true);
  assert.equal(isActiveImportEmployee({}), true);

  // The core regression this module exists to prevent: the CEO and other executives/advisors are
  // active but payroll_eligible=false, and some active employees are organogram_visible=false.
  // They MUST remain import-active — treating them as terminal is the false positive that blocked
  // them from the master import with "belongs to an inactive, hidden, resigned, or
  // payroll-ineligible employee and cannot be reactivated by import".
  const ceoRow = { employment_status: "active", payroll_eligible: false, organogram_visible: true };
  const hiddenActiveRow = { employment_status: "active", payroll_eligible: true, organogram_visible: false };
  const payrollAndHiddenRow = { employment_status: "on_leave", payroll_eligible: false, organogram_visible: false };
  assert.equal(isActiveImportEmployee(ceoRow), true);
  assert.equal(isActiveImportEmployee(hiddenActiveRow), true);
  assert.equal(isActiveImportEmployee(payrollAndHiddenRow), true);

  // Genuine terminal lifecycle states stay protected (excluded from import-active), so a stale
  // master file can never resurrect a resigned/terminated/archived employee.
  for (const status of [
    "resigned",
    "terminated",
    "historical_payroll_record",
    "system_placeholder",
    "some_unknown_future_terminal_state",
  ]) {
    assert.equal(isActiveImportEmployee({ employment_status: status }), false, status);
  }

  // Even a terminal employee that is (nonsensically) still payroll_eligible=true stays protected —
  // classification keys on status ONLY, in both directions.
  const resignedButFlaggedRow = { employment_status: "resigned", payroll_eligible: true, organogram_visible: true };
  assert.equal(isActiveImportEmployee(resignedButFlaggedRow), false);

  // Canonical active-status set + normalizer contract.
  assert.equal(activeImportEmployeeStatuses.has("active"), true);
  assert.equal(activeImportEmployeeStatuses.has("on_leave"), true);
  assert.equal(activeImportEmployeeStatuses.has("resigned"), false);
  assert.equal(normalizeEmploymentStatus("  Active "), "active");
  assert.equal(normalizeEmploymentStatus(null), "active");
  assert.equal(normalizeEmploymentStatus(""), "active");
}
