import { strict as assert } from "node:assert";

import { selectFieldWorkforceHrIdKeys } from "../src/lib/deductions/connectors/no-records-activity.ts";
import { canonicalHrIdKey } from "../src/lib/hr-id.ts";

// crm_id is carried DELIBERATELY even though the function under test ignores it.
// The rule this replaced skipped anyone whose crm_id was set, so rows without a
// crm_id cannot tell the two rules apart — a test built from them would pass
// against the very bug it is meant to catch. Values are the real July 2026
// production mappings.
type EmployeeRow = { hr_id: string; job_title: string | null; crm_id: string | null };

// The returned Set is keyed by canonicalHrIdKey (lower-cased, alias-resolved),
// never the raw hr_id. Comparing raw ids makes every assertion fail identically
// whether the rule is right or wrong, which is indistinguishable from a real
// regression — resolve through the same function the code does.
const key = (hrId: string): string => {
  const resolved = canonicalHrIdKey(hrId);
  assert.ok(resolved, `test fixture hr_id ${hrId} must resolve to a canonical key`);
  return resolved;
};

const FIELD_WORKFORCE: EmployeeRow[] = [
  { hr_id: "B-156", job_title: "District Sales Manager", crm_id: "1454" },
  { hr_id: "A-9", job_title: "Marketing Manager", crm_id: "1193" },
  { hr_id: "A-8", job_title: "Group Product Manager", crm_id: "1185" },
  { hr_id: "B-124", job_title: "Medical Representative", crm_id: "1207" },
];

const HEAD_OFFICE: EmployeeRow[] = [
  { hr_id: "OF-0002", job_title: "Financial Advisor", crm_id: null },
  { hr_id: "B-10", job_title: "Hr Manager", crm_id: "1139" },
  { hr_id: "OF-0001", job_title: "Admin Assistant", crm_id: null },
  { hr_id: "A-13", job_title: "Office Coordinator", crm_id: "1262" },
  { hr_id: "A-3", job_title: "Qppv", crm_id: null },
];

export function runDeductionsModuleNoRecordsScopeTests() {
  const excluded = selectFieldWorkforceHrIdKeys([...FIELD_WORKFORCE, ...HEAD_OFFICE]);

  for (const row of FIELD_WORKFORCE) {
    assert.ok(
      excluded.has(key(row.hr_id)),
      `${row.job_title} must be excluded from no_records_activity — the crm connector is the sole deduction authority for the field workforce, and running both books the same absence day twice`,
    );
  }

  for (const row of HEAD_OFFICE) {
    assert.ok(
      !excluded.has(key(row.hr_id)),
      `${row.job_title} must stay IN no_records_activity — the crm connector never covers Head Office, so excluding them here would drop their only coverage`,
    );
  }

  // The previous rule tested `crm_id IS NULL` FIRST, so a MAPPED field employee
  // fell straight through and got flagged by both connectors. Selection must not
  // depend on crm_id at all. Measured cost of the old behaviour: 142 employee-days
  // across 50 employees double-claimed in July 2026.
  const mapped: EmployeeRow[] = [{ hr_id: "A-8", job_title: "Group Product Manager", crm_id: "1185" }];
  assert.ok(
    selectFieldWorkforceHrIdKeys(mapped).has(key("A-8")),
    "a field employee WITH a crm_id must still be excluded — scoping by crm_id mapping is what let 142 employee-days be claimed by crm and no_records_activity at once",
  );

  // isSfeManagerTitle exists because an SFE Manager "must never generate a payroll
  // deduction recommendation", but it was only ever wired into the FWC engine behind
  // `crm`. July 2026 carried a live no_records_activity candidate for the SFE Manager.
  const sfe: EmployeeRow[] = [{ hr_id: "A-2", job_title: "Sfe Manager", crm_id: "729" }];
  assert.ok(
    selectFieldWorkforceHrIdKeys(sfe).has(key("A-2")),
    "SFE Manager must be excluded from no_records_activity — the codebase states an SFE Manager must never generate a payroll-deduction recommendation, and this connector never called isSfeManagerTitle",
  );

  // Title matching is normalized (trim / case / collapsed whitespace), so a directory
  // row typed inconsistently must not silently re-enter deduction scope.
  const messy: EmployeeRow[] = [
    { hr_id: "B-200", job_title: "  district   sales manager  ", crm_id: "9001" },
    { hr_id: "B-201", job_title: "MEDICAL REP", crm_id: null },
  ];
  assert.equal(
    selectFieldWorkforceHrIdKeys(messy).size,
    2,
    "title matching must normalize case and whitespace — a field employee whose title is typed inconsistently would otherwise be deducted twice",
  );

  // Fails closed in the harmless direction: an unknown or blank title is not field
  // workforce, so it keeps no_records coverage rather than silently losing it.
  const unknown: EmployeeRow[] = [
    { hr_id: "X-1", job_title: null, crm_id: null },
    { hr_id: "X-2", job_title: "", crm_id: "1" },
    { hr_id: "X-3", job_title: "Some Title That Does Not Exist", crm_id: "2" },
  ];
  assert.equal(
    selectFieldWorkforceHrIdKeys(unknown).size,
    0,
    "a blank or unrecognized title is not field workforce and must keep its no_records coverage",
  );
}
