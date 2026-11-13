import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  currentlyAcceptedDeductionRefs,
  selectAcceptedDeductionCorrections,
  type AcceptedDeductionDecisionRow,
} from "../src/lib/dispute-center/accepted-deduction-days.ts";
import {
  deductionOpenForDispute,
  isUndecidedDeductionStatus,
  unpublishedDisputeLine,
  type UnpublishedDisputeCandidate,
} from "../src/lib/deductions/dispute-open.ts";
import { groupDeductionCommentThreads } from "../src/lib/deductions/portal.ts";
import { buildAcceptedCorrectionItems } from "../src/lib/private-calendar/logic.ts";
import type { DeductionsComment } from "../src/lib/deductions/types.ts";

/**
 * Owner, 2026-11-13: "make the employee able to dispute in the deduction module, and if approved the
 * dispute fix his deduction and calendar, and if rejected then deduct".
 *
 *   1. Every deduction but a cleared one can be disputed (deductionOpenForDispute) — before, only a
 *      line pushed to the payslip could, so an approved-but-unpushed one (charged all the same) and an
 *      undecided one were beyond reach.
 *   2. Such a dispute reaches the HR Disputes inbox with a line built from the candidate; an undecided
 *      one is marked pending and charges 0.00; a cleared one stays out.
 *   3. REJECT on an undecided deduction approves it for payroll (decideDeductionDispute) — leaving it
 *      Pending would charge nothing.
 *   4. ACCEPT puts a ✓ Verified entry on each of the deduction's days on the Private Calendar, only
 *      while the dispute stands accepted AND the module still says Do Not Take Action.
 */

const read = (path: string) => readFileSync(path, "utf8").replace(/\r\n/g, "\n");

function candidate(over: Partial<UnpublishedDisputeCandidate> = {}): UnpublishedDisputeCandidate {
  return {
    category: "crm",
    created_at: "2026-11-02T08:00:00Z",
    dates: ["2026-10-12", "2026-10-13"],
    employee_hr_id: "B-204",
    employee_hr_id_compact: "b204",
    employee_name: "Dina Fadel",
    estimated_amount: 900,
    id: "cand-1",
    month_key: "2026-10",
    raw_value: 2,
    reason: "No CRM activity",
    unit: "days",
    ...over,
  };
}

function comment(candidateId: string, createdAt: string): DeductionsComment {
  return {
    authorHrId: "B-204",
    authorLoginId: "B-204",
    authorRole: "Medical Rep",
    body: "I was in the field.",
    candidateId,
    createdAt,
    id: `c-${candidateId}-${createdAt}`,
  };
}

export async function runDeductionDisputeOutcomeTests(): Promise<void> {
  // 1. WHO MAY DISPUTE.
  {
    assert.equal(deductionOpenForDispute({ decisionStatus: null, hasPublishedLine: false }), true, "undecided");
    assert.equal(deductionOpenForDispute({ decisionStatus: "Pending", hasPublishedLine: false }), true);
    assert.equal(deductionOpenForDispute({ decisionStatus: "Approved for Payroll", hasPublishedLine: false }), true, "approved, not pushed");
    assert.equal(deductionOpenForDispute({ decisionStatus: "Do Not Take Action", hasPublishedLine: false }), false, "cleared");
    assert.equal(
      deductionOpenForDispute({ decisionStatus: "Do Not Take Action", hasPublishedLine: true }),
      true,
      "a published line keeps its conversation whatever its decision says now",
    );
    for (const status of [null, "", "Pending", "Needs Follow-up", "Disputed"]) {
      assert.equal(isUndecidedDeductionStatus(status), true, `${status} is undecided`);
    }
    for (const status of ["Approved for Payroll", "Do Not Take Action"]) {
      assert.equal(isUndecidedDeductionStatus(status), false, `${status} is decided`);
    }
    const comments = read("src/lib/deductions/comments.ts");
    assert.match(comments, /deductionOpenForDispute\(\{ decisionStatus, hasPublishedLine \}\)/, "the server gate asks the same rule");
    assert.doesNotMatch(comments, /await assertCandidatePublished\(/, "the published-only gate is gone from both sides");
  }

  // 2. THE HR INBOX CARRIES DISPUTES WITH NO PUSHED LINE.
  {
    const pending = unpublishedDisputeLine({ candidate: candidate(), decision: null, payrollColumn: "crm" });
    assert.ok(pending);
    assert.equal(pending.pending, true);
    assert.equal(pending.line.appliedAmount, 0, "an undecided deduction charges nothing yet");
    assert.equal(pending.line.employeeName, "Dina Fadel");

    const approved = unpublishedDisputeLine({
      candidate: candidate(),
      decision: { decision_status: "Approved for Payroll" },
      payrollColumn: "crm",
    });
    assert.ok(approved);
    assert.equal(approved.pending, false);
    assert.equal(approved.line.appliedAmount, 900, "approved and never narrowed charges the whole detection");
    assert.equal(approved.line.appliedDeductionValue, 2);

    const narrowed = unpublishedDisputeLine({
      candidate: candidate(),
      decision: { applied_amount: 450, applied_value: 1, decision_status: "Approved for Payroll" },
      payrollColumn: "crm",
    });
    assert.equal(narrowed?.line.appliedAmount, 450, "a narrowed approval charges its own figure");

    assert.equal(
      unpublishedDisputeLine({ candidate: candidate(), decision: { decision_status: "Do Not Take Action" }, payrollColumn: "crm" }),
      null,
      "a cleared deduction stays out of the inbox",
    );

    const threads = groupDeductionCommentThreads(
      [comment("cand-1", "2026-11-03T10:00:00Z"), comment("cand-x", "2026-11-03T09:00:00Z")],
      new Map(),
      new Map([["cand-1", pending]]),
    );
    assert.equal(threads.length, 1, "an undecided dispute is listed; one with neither a line nor an open candidate is not");
    assert.equal(threads[0].candidateId, "cand-1");
    assert.equal(threads[0].pending, true);
  }

  // 3. REJECT ON AN UNDECIDED DEDUCTION DEDUCTS IT.
  {
    const body = read("src/lib/dispute-center/deduction.ts");
    const branch = body.slice(body.indexOf("} else if (undecided) {"), body.indexOf("// REJECT — \"the deduction stands\"."));
    assert.ok(branch.length > 0, "the undecided reject branch exists");
    assert.match(branch, /decisionStatus: "Approved for Payroll"/, "a rejected undecided dispute is approved for payroll");
    assert.match(branch, /pushDeduction\(/, "and put on the employee's payslip view");
    assert.match(body, /const ceiling = undecided \? num\(candidate\.raw_value\) : before\.value;/, "reduce works on an undecided one");
  }

  // 4. AN ACCEPTED DISPUTE FIXES THE CALENDAR.
  {
    const events = [
      { case_ref: "acc", created_at: "2026-11-05T10:00:00Z", details: { outcome: "accept" }, event_type: "decided" },
      { case_ref: "rej", created_at: "2026-11-05T10:00:00Z", details: { outcome: "reject" }, event_type: "decided" },
      { case_ref: "red", created_at: "2026-11-05T10:00:00Z", details: { outcome: "reduce" }, event_type: "decided" },
      { case_ref: "reo", created_at: "2026-11-05T10:00:00Z", details: { outcome: "accept" }, event_type: "decided" },
      { case_ref: "reo", created_at: "2026-11-06T10:00:00Z", details: {}, event_type: "reopened" },
      { case_ref: "again", created_at: "2026-11-05T10:00:00Z", details: { outcome: "accept" }, event_type: "decided" },
      { case_ref: "again", created_at: "2026-11-07T10:00:00Z", details: { outcome: "reject" }, event_type: "decided" },
    ];
    const accepted = currentlyAcceptedDeductionRefs(events);
    assert.deepEqual([...accepted].sort(), ["acc"], "only a dispute whose newest decision is an accept, not reopened since");

    const decisions = new Map<string, AcceptedDeductionDecisionRow>([
      ["acc", { candidate_id: "acc", decision_status: "Do Not Take Action" }],
      ["back", { candidate_id: "back", decision_status: "Approved for Payroll" }],
    ]);
    const corrections = selectAcceptedDeductionCorrections({
      acceptedRefs: new Set(["acc", "back"]),
      candidates: [
        { category: "crm", dates: ["2026-10-12", "2026-10-13", "2026-09-30"], employee_hr_id: "B-204", employee_name: "Dina Fadel", id: "acc" },
        { category: "crm", dates: ["2026-10-14"], employee_hr_id: "B-204", employee_name: "Dina Fadel", id: "back" },
      ],
      categoryLabel: () => "CRM",
      decisions,
      scopeHrIds: ["b-204"],
      window: { end: "2026-10-31", start: "2026-10-01" },
    });
    assert.deepEqual(
      corrections.map((row) => row.disputeDate),
      ["2026-10-12", "2026-10-13"],
      "every day inside the window, and none from a deduction HR put back",
    );
    assert.ok(corrections.every((row) => row.status === "accepted" && row.itemSource === null && row.origin === "deduction_dispute"));
    assert.equal(
      selectAcceptedDeductionCorrections({
        acceptedRefs: new Set(["acc"]),
        candidates: [{ category: "crm", dates: ["2026-10-12"], employee_hr_id: "B-204", employee_name: null, id: "acc" }],
        categoryLabel: () => "CRM",
        decisions,
        scopeHrIds: ["B-999"],
        window: { end: "2026-10-31", start: "2026-10-01" },
      }).length,
      0,
      "only the people in the calendar's scope",
    );

    const items = buildAcceptedCorrectionItems(corrections);
    assert.equal(items.length, 2, "one verified entry per day");
    assert.equal(items[0].source, "correction");
    assert.match(items[0].detailLines.join(" "), /an accepted deduction dispute/, "the day says where its verification came from");

    const service = read("src/lib/private-calendar/service.ts");
    assert.match(
      service,
      /buildAcceptedCorrectionItems\(\[\.\.\.employeeDisputes, \.\.\.deductionCorrections\]\)/,
      "the calendar feeds accepted deduction disputes into the same verified entries",
    );
  }
}
