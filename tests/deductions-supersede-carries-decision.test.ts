import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { resolveCarriedDecision } from "../src/lib/deductions/calculations.ts";
import {
  buildDeductionsCandidateKey,
  deductionsCandidateIdentityKey,
} from "../src/lib/deductions/candidate-key.ts";

/**
 * Guards the re-collect correction path.
 *
 * THE DEFECT. `candidate_key` embeds a hash of the candidate's day set, so a re-collect whose
 * days changed produces a DIFFERENT key — a recalculated finding is indistinguishable from a
 * brand-new one. Two consequences, both measured on production 2026-08-06:
 *
 *   - `superseded_by_candidate_id` was NULL on 1,584 of 1,584 superseded rows, and 21 Super-Admin
 *     approvals worth 9,306.42 EGP were retired with no successor. HR re-entered them by hand.
 *   - Four connectors (crm, dsm_no_record, fingerprint, holiday_bridge) were insert-only, because
 *     a whole-category retraction would delete a sibling writer's rows. So a CORRECTED re-collect
 *     could only ADD a row — the wrong one stayed live beside it. That is why 14,629.01 EGP of
 *     false CRM deductions could not be retracted by re-running anything.
 *
 * The fix rests on two pure decisions, which is what these tests pin.
 */
export function runDeductionsSupersedeCarriesDecisionTests() {
  // ── 1. The identity key: stable across a changed day set ───────────────────
  {
    const base = {
      category: "crm" as const,
      employeeHrId: "B-147",
      monthKey: "2026-07",
      sourceRecordId: "no_activity_candidate:B-147:2026-07",
      sourceSystem: "crm_visits_mirror",
    };
    const before = buildDeductionsCandidateKey({ ...base, dates: ["2026-07-06", "2026-07-08"] });
    const after = buildDeductionsCandidateKey({ ...base, dates: ["2026-07-06"] });

    assert.notEqual(before, after, "a changed day set must still produce a different candidate_key");
    assert.equal(
      deductionsCandidateIdentityKey(before),
      deductionsCandidateIdentityKey(after),
      "…but the IDENTITY underneath must survive, or a correction cannot be paired with what it corrects",
    );
    assert.ok(
      !deductionsCandidateIdentityKey(before).endsWith(":"),
      "the identity must not keep a trailing separator",
    );
    // A different PERSON, or a different source, is a different identity — the pairing must not
    // be so loose that one employee's correction retires another's row.
    assert.notEqual(
      deductionsCandidateIdentityKey(before),
      deductionsCandidateIdentityKey(buildDeductionsCandidateKey({ ...base, employeeHrId: "B-169", dates: ["2026-07-06"] })),
      "two different employees must never share an identity",
    );
    assert.notEqual(
      deductionsCandidateIdentityKey(before),
      deductionsCandidateIdentityKey(buildDeductionsCandidateKey({ ...base, sourceSystem: "dsm_no_record", dates: ["2026-07-06"] })),
      "two different source systems must never share an identity",
    );
  }

  // ── 2. Pending is not a decision — there is nothing to carry ───────────────
  assert.equal(
    resolveCarriedDecision({
      previousAppliedDates: null,
      previousDates: ["2026-07-06"],
      previousReason: "",
      previousStatus: "Pending",
      replacementDates: ["2026-07-06"],
    }),
    null,
    "a Pending row carries nothing, so the caller can skip the write entirely",
  );

  // ── 3. Fewer days: the approval SURVIVES ───────────────────────────────────
  // The replacement can only ever charge less than was consented to, so re-review would be
  // pointless friction — and losing the approval here is exactly what cost 9,306.42 EGP.
  {
    const carried = resolveCarriedDecision({
      previousAppliedDates: null,
      previousDates: ["2026-07-06", "2026-07-07", "2026-07-08"],
      previousReason: "Approved for payroll after review (2026-07)",
      previousStatus: "Approved for Payroll",
      replacementDates: ["2026-07-06", "2026-07-08"],
    });
    assert.ok(carried, "a decision over a shrinking day set must be carried");
    assert.equal(carried.decisionStatus, "Approved for Payroll");
    assert.equal(carried.decisionReason, "Approved for payroll after review (2026-07)");
    assert.equal(carried.droppedToPending, false);
    assert.equal(carried.appliedDates, null, "a never-narrowed selection stays null — it charges the replacement's own days");
  }

  // ── 4. MORE days: the approval is LOST, deliberately ───────────────────────
  // An approval is consent to charge specific days, not a standing licence over whatever that
  // finding later becomes. This is the assertion that stops money being taken for a day no human
  // ever looked at.
  {
    const carried = resolveCarriedDecision({
      previousAppliedDates: null,
      previousDates: ["2026-07-06"],
      previousReason: "Approved for payroll after review (2026-07)",
      previousStatus: "Approved for Payroll",
      replacementDates: ["2026-07-06", "2026-07-09"],
    });
    assert.ok(carried, "a grown day set still writes — it resets rather than silently keeping the approval");
    assert.equal(carried.droppedToPending, true);
    assert.equal(carried.decisionStatus, "Pending", "a day the approver never saw must never publish on the old approval");
    assert.match(carried.decisionReason, /2026-07-09/, "the reason must name the day that caused the reset");
    assert.match(carried.decisionReason, /Approved for Payroll/, "…and what the earlier decision was");
  }

  // ── 5. A narrowed selection is intersected, not carried whole ──────────────
  {
    const carried = resolveCarriedDecision({
      previousAppliedDates: ["2026-07-06", "2026-07-08"],
      previousDates: ["2026-07-06", "2026-07-07", "2026-07-08"],
      previousReason: "Approved, 07-07 cleared",
      previousStatus: "Approved for Payroll",
      replacementDates: ["2026-07-06", "2026-07-07"],
    });
    assert.ok(carried);
    assert.deepEqual(
      carried.appliedDates,
      ["2026-07-06"],
      "only days the reviewer selected AND the replacement still finds may be charged",
    );
  }

  // ── 6. An emptied selection stays empty, not null ──────────────────────────
  // [] means "charge nothing" and null means "never narrowed" — conflating them turns a deliberate
  // zero into a full charge (see resolveAppliedDeductionDates).
  {
    const carried = resolveCarriedDecision({
      previousAppliedDates: ["2026-07-08"],
      previousDates: ["2026-07-06", "2026-07-08"],
      previousReason: "Approved, only 07-08 charged",
      previousStatus: "Approved for Payroll",
      replacementDates: ["2026-07-06"],
    });
    assert.ok(carried);
    assert.deepEqual(carried.appliedDates, [], "every approved day is gone, so the replacement charges nothing");
    assert.notEqual(carried.appliedDates, null, "an emptied selection must NOT degrade to null");
  }

  // ── 7. "Do Not Take Action" carries too ────────────────────────────────────
  // A clearance is as much a decision as an approval; losing it silently re-arms a charge the
  // Super Admin explicitly refused.
  {
    const carried = resolveCarriedDecision({
      previousAppliedDates: null,
      previousDates: ["2026-07-06"],
      previousReason: "Cleared on owner instruction",
      previousStatus: "Do Not Take Action",
      replacementDates: ["2026-07-06"],
    });
    assert.ok(carried);
    assert.equal(carried.decisionStatus, "Do Not Take Action", "a clearance must survive a re-collect");
    assert.equal(carried.droppedToPending, false);
  }

  // ── 8. Source-contract: the wiring that makes any of this run ──────────────
  {
    const collect = readFileSync(new URL("../src/lib/deductions/collect.ts", import.meta.url), "utf8");
    for (const source of ["crm_visits_mirror", "dsm_no_record", "fingerprint_report", "holiday_bridge"]) {
      assert.match(
        collect,
        new RegExp(`sourceSystems: \\["${source}"\\]`),
        `${source} must reconcile its own rows — insert-only is what made a corrected re-collect add a second charge`,
      );
    }
    const service = readFileSync(new URL("../src/lib/deductions/service.ts", import.meta.url), "utf8");
    assert.match(
      service,
      /replacementCandidateId,\n\s*\}\);/,
      "reconcileCandidateDrafts must pass replacementCandidateId — the parameter supersedeCandidate already accepts and writes",
    );
  }
}
