import assert from "node:assert/strict";

import {
  RETENTION_RISK_EXCLUDED_ROLE,
  planRetentionRiskRecipients,
} from "../src/lib/retention-risk/recipients.ts";

/**
 * THE CEO NEVER RECEIVES A RETENTION-RISK ALERT. Owner, 2026-09-09, asked and answered.
 *
 * He was shown that the CEO is excluded today only by circumstance — the reps-only scope (#3407)
 * stopped head-office managers being flagged, and measured on production that day all 68 active
 * Medical Representatives report to a District Sales Manager or a National Sales Manager, so no
 * manager path reaches him. He asked for it to be a rule instead. This file is that rule.
 *
 * WHAT WOULD BREAK IT, and therefore what each case pins:
 *   - the CEO becoming the direct manager of one rep, which is the manager path;
 *   - an admin adding CEO to `notification_role_policies.retention_risk_alert`, which is the
 *     audience path and is why the exclusion filters the WHOLE list rather than the manager alone;
 *   - HR ids being MIXED CASE in this database, so a plain equality check would let a stored `AA`
 *     through against a resolved `aa` and silently undo everything above.
 *
 * The last case is the one that would pass a careless review: the code reads correct and the rule
 * is simply not applied.
 */
export function runRetentionRiskRecipientExclusionTests() {
  const hr = { hrId: "HR-009", userId: "u-hr" };
  const sfe = { hrId: "A-2", userId: "u-sfe" };

  {
    const plan = planRetentionRiskRecipients({
      audience: [hr, sfe],
      managerHrId: "B-118",
      excludedHrIds: ["AA"],
    });
    assert.deepEqual(
      plan.recipients.map((one) => one.hrId),
      ["HR-009", "A-2", "B-118"],
      "the ordinary case: the standing audience plus the flagged rep's own district manager",
    );
    assert.deepEqual(plan.excluded, [], "nothing is excluded on a normal run");
  }

  {
    const plan = planRetentionRiskRecipients({
      audience: [hr, sfe],
      managerHrId: "AA",
      excludedHrIds: ["AA"],
    });
    assert.deepEqual(
      plan.recipients.map((one) => one.hrId),
      ["HR-009", "A-2"],
      "the CEO as a rep's direct line manager is dropped, and everyone else still gets it",
    );
    assert.deepEqual(plan.excluded, ["AA"], "the removal is reported so the run can warn about it");
  }

  {
    const plan = planRetentionRiskRecipients({
      audience: [hr, { hrId: "AA", userId: "u-ceo" }, sfe],
      managerHrId: "B-118",
      excludedHrIds: ["AA"],
    });
    assert.deepEqual(
      plan.recipients.map((one) => one.hrId),
      ["HR-009", "A-2", "B-118"],
      "the CEO added to the ROLE POLICY is dropped too — that is what makes this a hard exclusion",
    );
    assert.deepEqual(plan.excluded, ["AA"], "and that removal is reported rather than silent");
  }

  {
    const plan = planRetentionRiskRecipients({
      audience: [hr],
      managerHrId: "aa",
      excludedHrIds: ["AA"],
    });
    assert.deepEqual(
      plan.recipients.map((one) => one.hrId),
      ["HR-009"],
      "HR ids are mixed case here, so the match must be canonical on BOTH sides",
    );
  }

  {
    const plan = planRetentionRiskRecipients({
      audience: [hr, sfe],
      managerHrId: "A-2",
      excludedHrIds: [],
    });
    assert.deepEqual(
      plan.recipients.map((one) => one.hrId),
      ["HR-009", "A-2"],
      "a manager who is already on the standing audience is told once, not twice",
    );
  }

  {
    const plan = planRetentionRiskRecipients({
      audience: [hr, sfe],
      managerHrId: "B-118",
      excludedHrIds: [],
    });
    assert.deepEqual(
      plan.recipients.map((one) => one.hrId),
      ["HR-009", "A-2", "B-118"],
      "an empty exclusion list must not remove anybody — the resolver fails OPEN on a read error",
    );
  }

  assert.equal(
    RETENTION_RISK_EXCLUDED_ROLE,
    "CEO",
    "the exclusion names an OFFICE, not a person — hard-coding an HR id would pin whoever sits there today",
  );
}
