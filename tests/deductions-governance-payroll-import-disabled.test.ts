// verified failing at 28b4be32 (pre-fix: the flag file did not exist and both
// entry points wrote salary_records unconditionally)
//
// The Deductions Governance payroll import writes
// salary_records.crm / finger_print / unpaid_vacations strictly ADD-ON-TOP.
// payroll-handoff.ts's own type doc states the hazard: the RPC blocks re-running
// the same finalized summary twice, "but it cannot see whether a DIFFERENT path
// (e.g. Automated Payroll's own live pull of the same deduction_candidates/
// decisions data) already baked an equivalent amount into this row — since
// import is strictly add-on-top, that would double the deduction."
//
// While the unified Deductions module is being cut over, BOTH systems compute
// the same money for the same month. A second live writer into those three
// columns would not error — it would silently pay twice. So this path stays
// closed, and these assertions exist to make reopening it a deliberate act that
// has to delete a test, not a one-character edit nobody notices.

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

import {
  DEDUCTIONS_GOVERNANCE_PAYROLL_IMPORT_DISABLED_MESSAGE,
  DEDUCTIONS_GOVERNANCE_PAYROLL_IMPORT_ENABLED,
} from "../src/lib/deductions-governance/feature-flags.ts";

export function runDeductionsGovernancePayrollImportDisabledTests() {
  // 1. The flag itself.
  assert.equal(
    DEDUCTIONS_GOVERNANCE_PAYROLL_IMPORT_ENABLED,
    false,
    "the legacy governance payroll import must stay OFF: it is add-on-top and cannot see what Automated Payroll already wrote to the same salary_records row",
  );

  // 2. The refusal has to tell the reader where to go instead. A bare "disabled"
  //    sends HR hunting; naming the replacement is the difference between a
  //    dead end and a redirect.
  assert.match(
    DEDUCTIONS_GOVERNANCE_PAYROLL_IMPORT_DISABLED_MESSAGE,
    /\/admin\/deductions/,
    "the disabled message must name the module that replaced this path",
  );

  // 3. BOTH entry points gate independently. confirm() calls preview()
  //    internally, so gating preview alone would close both today — but a later
  //    refactor that drops that call would silently reopen the write path.
  //    Wiring assertions: a unit test cannot reach these without a database.
  const handoff = readFileSync("src/lib/deductions-governance/payroll-handoff.ts", "utf8");

  // "Before doing any work" has a real edge, and it is not 600 bytes: it is the function's first
  // `await`. Bounding on it says what the assertion means, cannot be outgrown by a longer comment
  // above the check, and is TIGHTER than the byte window was (~250 bytes here, not 600).
  const prelude = (name: string) => {
    const start = handoff.indexOf(`export async function ${name}`);
    const rest = handoff.slice(start + 1);
    const body = rest.slice(0, rest.search(/^(?:export )?(?:async )?function |^(?:export )?(?:const|type|interface|class) /m) + 1 || rest.length);
    const firstAwait = body.indexOf("await ");
    return firstAwait >= 0 ? body.slice(0, firstAwait) : body;
  };

  assert.match(
    prelude("previewDeductionsPayrollImport"),
    /if \(!DEDUCTIONS_GOVERNANCE_PAYROLL_IMPORT_ENABLED\)/,
    "previewDeductionsPayrollImport must check the flag before doing any work",
  );

  assert.match(
    prelude("confirmDeductionsPayrollImport"),
    /if \(!DEDUCTIONS_GOVERNANCE_PAYROLL_IMPORT_ENABLED\)/,
    "confirmDeductionsPayrollImport is the one that WRITES salary_records — it must gate on its own, not rely on preview()",
  );

  // 4. The UI must not offer a button that the server will refuse. Discovering
  //    a closed path by clicking it and reading an error is a worse experience
  //    than the button not being there.
  const workspace = readFileSync("src/components/deductions-governance/deductions-governance-workspace.tsx", "utf8");
  assert.match(
    workspace,
    /DEDUCTIONS_GOVERNANCE_PAYROLL_IMPORT_ENABLED \? \(/,
    "the Payroll Preview / Confirm Import buttons must be gated on the same flag",
  );
  assert.equal(
    (workspace.match(/DEDUCTIONS_GOVERNANCE_PAYROLL_IMPORT_ENABLED \? \(/g) ?? []).length,
    2,
    "both buttons must be gated — Preview and Confirm Import",
  );

  // 5. The unified module must never grow its own writer. Its service header
  //    states "NEVER writes salary_records/salary_batches"; this pins that claim
  //    so the cutover cannot quietly turn it into a second one.
  const deductionsService = readFileSync("src/lib/deductions/service.ts", "utf8");
  assert.match(
    deductionsService,
    /NEVER writes salary_records/,
    "the Deductions module must keep its no-salary_records contract in force",
  );
}
