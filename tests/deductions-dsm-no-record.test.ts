import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

import { isEligibleForPublish } from "../src/lib/deductions/calculations.ts";
import { DEDUCTION_COLLECTORS, isDeductionCollectorKey } from "../src/lib/deductions/collect.ts";

// The DSM no-record rule reverses a documented exclusion that once cost
// 131,741.94 EGP in wrong deductions, so its guards are asserted as WIRING:
// the behaviour itself is DB-bound (roster + CRM feed + ledger) and cannot be
// unit-tested without a live client, which this repo's runner cannot host — see
// scripts/check-deductions-write-contract.ts for why. What CAN be pinned is
// that each guard is present and that the rule stayed narrow.

export async function runDeductionsDsmNoRecordTests(): Promise<void> {
  const source = readFileSync("src/lib/deductions/connectors/dsm-no-record.ts", "utf8");

  // Executable lines only. This file DOCUMENTS at length why Product Managers,
  // National Sales Managers and logsOwnCrmVisitsTitle stay out of scope — so any
  // "must not mention X" assertion run against the raw text fails on the very
  // comment that explains the safeguard. Assert against the code.
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");

  // ── The rule must stay narrow ────────────────────────────────────────────
  // eligibility.ts excludes managers from CRM no-activity because a Product
  // Manager and a National Sales Manager were charged for days they had clocked
  // in. The owner's exception is DSMs specifically — their double visits ARE
  // logged when the rep submits. Widening this to "manager" would walk straight
  // back into the incident.
  {
    assert.match(
      source,
      /district\\s\+\(sales\\s\+\)\?manager/i,
      "the roster filter must match DISTRICT sales managers specifically",
    );
    for (const outOfScope of ["product manager", "national sales manager", "regional"]) {
      assert.doesNotMatch(
        code,
        new RegExp(outOfScope, "i"),
        `${outOfScope} must never be pulled into scope — that population is what the 131,741.94 EGP incident was made of`,
      );
    }
  }

  // ── It must not widen the shared rep predicate ───────────────────────────
  // Editing logsOwnCrmVisitsTitle would silently re-scope every consumer of it.
  // This rule lives in its own file precisely so deleting the file removes it.
  {
    assert.doesNotMatch(
      code,
      /logsOwnCrmVisitsTitle/,
      "the DSM rule must NOT reach into the reps' eligibility predicate — a separate connector is what keeps the rep pipeline untouched",
    );
    const eligibility = readFileSync("src/lib/field-workforce-compliance/eligibility.ts", "utf8");
    assert.match(
      eligibility,
      /OWN_CRM_VISIT_LOGGER_TITLES = new Set<string>\(\[\s*"medical representative",\s*"medical rep",\s*"employee medical rep",\s*\]\)/,
      "the reps-only predicate must stay reps-only; the DSM exception is implemented elsewhere",
    );
  }

  // ── The four guards that keep a gap from becoming a wrong deduction ──────
  {
    assert.match(
      source,
      /employment_status", "active"/,
      "only ACTIVE managers — resigned and historical records have no records because they no longer work here",
    );
    assert.match(
      source,
      /if \(!anySignal\.has\(compact\)\) continue;/,
      "zero CRM signal for a whole month is a mapping gap, not a month of absence",
    );
    assert.match(
      source,
      /if \(manager\.hireDate && day < manager\.hireDate\) return false;/,
      "a day before the person was hired must never be charged",
    );
    assert.match(
      source,
      /if \(claimed\.has\(`\$\{compact\}:\$\{day\}`\)\) return false;/,
      "a day another category already charges must never be charged again",
    );
  }

  // ── Holidays and Fridays are not working days ────────────────────────────
  // Without this, 12 of 18 managers would have been charged for 2 July and 11
  // for 23 July — both national holidays that nobody worked.
  {
    assert.match(
      source,
      /isFieldForceWorkingDay\(day\) && !holidays\.has\(day\)/,
      "working days must exclude BOTH Friday and national holidays",
    );
    assert.match(
      source,
      /calendarReachable/,
      "an unreadable holiday calendar must refuse, not silently charge public holidays",
    );
  }

  // ── An unpriceable row must never be emitted ─────────────────────────────
  {
    assert.match(
      source,
      /if \(estimatedAmount == null\) continue;/,
      "a row with no computable amount blocks the entire month's publish",
    );
  }

  // ── NEVER auto-publish ───────────────────────────────────────────────────
  // Owner's instruction (2026-08-03). These sit in the CRM tab, which is
  // mandatory-unless-cleared — so without this the rule would publish itself.
  // The behaviour is asserted here, not just the wiring, because it is the one
  // property standing between a brand-new rule and 29,548.40 EGP going through
  // with nobody having looked at it.
  {
    const dsmRow = { category: "crm" as const, sourceSystem: "dsm_no_record" };

    assert.equal(
      isEligibleForPublish({ ...dsmRow, decision: null }),
      false,
      "a DSM no-record row with NO decision must not publish",
    );
    assert.equal(
      isEligibleForPublish({ ...dsmRow, decision: { decisionStatus: "Pending" } }),
      false,
      "Pending must not publish — this is exactly what mandatory-unless-cleared would have allowed",
    );
    assert.equal(
      isEligibleForPublish({ ...dsmRow, decision: { decisionStatus: "Needs Follow-up" } }),
      false,
      "an open question is not an approval",
    );
    assert.equal(
      isEligibleForPublish({ ...dsmRow, decision: { decisionStatus: "Disputed" } }),
      false,
      "a disputed manager day must not publish while it is disputed",
    );
    assert.equal(
      isEligibleForPublish({ ...dsmRow, decision: { decisionStatus: "Approved for Payroll" } }),
      true,
      "an explicit approval is the ONLY way a DSM no-record day publishes",
    );

    // The reps' long-standing mandatory behaviour must be untouched — the whole
    // point of keying on source system rather than category.
    assert.equal(
      isEligibleForPublish({ category: "crm", sourceSystem: "crm_visits_mirror", decision: { decisionStatus: "Pending" } }),
      true,
      "a REP's CRM no-activity day must still publish on Pending; only the DSM source is gated",
    );
    assert.equal(
      isEligibleForPublish({ category: "crm", decision: { decisionStatus: "Pending" } }),
      true,
      "a candidate with no source system recorded must keep the category's own rule",
    );
  }

  // ── Registered, and in an order its dedup can rely on ────────────────────
  {
    assert.equal(isDeductionCollectorKey("dsm_no_record"), true, "the connector must be registered to be runnable");
    const order = DEDUCTION_COLLECTORS.map((collector) => collector.key);
    assert.ok(order.indexOf("dsm_no_record") > order.indexOf("crm"), "must run after the rep pipeline it dedups against");
  }
}
