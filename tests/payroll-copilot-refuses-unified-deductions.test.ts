import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * Guards the door between the two deduction systems.
 *
 * THE DEFECT. Two deduction systems shipped side by side with table names one letter apart:
 * `deductions_candidates`/`deductions_decisions` (the Deductions module HR actually decides in) and
 * `deduction_candidates`/`deduction_decisions` (the older governance flow). The Payroll Copilot's
 * sheet generation reads the SECOND. Measured on production 2026-08-06 for 2026-07, one
 * "Generate the sheet" click would have written ~224,216.71 EGP of CRM deductions across 54
 * employees off legacy rows nobody approved, against the 28,233.87 EGP HR actually approved in the
 * module. `startRun` refuses once a salary batch exists for the period — but no July batch exists,
 * so nothing refused.
 *
 * These are SOURCE-CONTRACT assertions (the technique tests/crm-portal-scope.test.ts uses): the
 * guard needs Supabase and a live run to execute, so the load-bearing wiring is pinned by asserting
 * the source. That is precisely the regression at risk here — someone deleting a one-line call.
 */
export function runPayrollCopilotUnifiedDeductionsGuardTests() {
  const copilot = readFileSync(new URL("../src/lib/payroll/copilot/service.ts", import.meta.url), "utf8");

  // 1. The guard is called, and its message becomes the refusal.
  assert.match(
    copilot,
    /describeUnifiedDeductionsConflict\(\{/,
    "materializeRun must ask the Deductions module whether it owns this month",
  );
  assert.match(
    copilot,
    /if \(unifiedDeductionsConflict\) \{\s*throw new CopilotError\(unifiedDeductionsConflict, 409\);/,
    "a conflict must REFUSE with 409, never warn-and-continue",
  );

  // 2. Ordering: the guard must run before the expensive draft assembly, so the cheapest exit wins
  //    and no partial work is done for a run that cannot legally produce a sheet.
  {
    const guardAt = copilot.indexOf("describeUnifiedDeductionsConflict({");
    const assembleAt = copilot.indexOf("await assembleDraft(period");
    assert.ok(guardAt > 0, "the guard call must exist");
    assert.ok(assembleAt > 0, "assembleDraft must still be called");
    assert.ok(guardAt < assembleAt, "the guard must run BEFORE assembleDraft");
  }

  // 3. The guard's own rule: live candidates in the unified module mean it owns the month.
  {
    const service = readFileSync(new URL("../src/lib/deductions/service.ts", import.meta.url), "utf8");
    assert.match(
      service,
      /export async function describeUnifiedDeductionsConflict/,
      "the rule belongs to the deductions domain, not to a payroll module",
    );
    assert.match(
      service,
      /if \(liveCandidates === 0\) return null;/,
      "no live candidates means nothing to conflict with — the guard must not block an untouched month",
    );
  }

  // 4. THE DELIBERATE NON-APPLICATION, pinned so a future "let's be consistent" change cannot
  //    silently deadlock payroll. Automated Payroll's own publish path reads the unified module
  //    through loadConfirmedDeductions and never reads deductions_publications at all — production
  //    has run with deductions_publications = 0 rows the entire time. Gating it on "a publication
  //    exists" would therefore refuse every payroll run forever, because publishing deductions has
  //    never been a prerequisite for paying anyone.
  {
    const runService = readFileSync(
      new URL("../src/lib/automated-payroll/run-service.ts", import.meta.url),
      "utf8",
    );
    assert.doesNotMatch(
      runService,
      /describeUnifiedDeductionsConflict/,
      "Automated Payroll reads the unified module correctly and must NOT be gated on this gu" +
        "ard — doing so would permanently block payroll, since a deductions publication is not a " +
        "prerequisite for paying anyone",
    );
    const bridge = readFileSync(
      new URL("../src/lib/automated-payroll/deductions-source.ts", import.meta.url),
      "utf8",
    );
    assert.doesNotMatch(
      bridge,
      /deductions_publications/,
      "the payroll bridge reads candidates + decisions, never the publication snapshot — if that " +
        "changes, revisit the guard's scope",
    );
  }
}
