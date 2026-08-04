import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import type { EmployeeDirectoryRow } from "@/lib/employees/employee-directory";
import { buildMarketingApproverChain } from "@/lib/marketing-requests/service";
import type { MarketingRequestApprovalStep } from "@/lib/marketing-requests/types";

function source(relPath: string): string {
  return readFileSync(relPath, "utf8");
}

// The builder reads only these fields; a partial row is enough for the unit.
function step(partial: Partial<MarketingRequestApprovalStep>): MarketingRequestApprovalStep {
  return {
    assignedHrId: null,
    decisionAt: null,
    decisionByHrId: null,
    decisionNote: null,
    id: "step",
    isCc: false,
    sequence: 1,
    status: "pending",
    stepName: "Step",
    ...partial,
  } as unknown as MarketingRequestApprovalStep;
}

function directory(): EmployeeDirectoryRow[] {
  return [
    { hrId: "B-122", displayName: "Amr Mohamed Naguib Elsabey" },
    { hrId: "A-2", displayName: "Khaled Mohamed Ali Bedair" },
    { hrId: "A-9", displayName: "Hossam Mohamed Reda AboElftouh" },
    { hrId: "AA", displayName: "Anwar Gaweesh" },
  ] as unknown as EmployeeDirectoryRow[];
}

/**
 * The approval history carried on the marketing inbox row.
 *
 * `decision_note` and `decision_at` have been written by every approver since the chain existed
 * and were surfaced nowhere: the decision screen rendered the chain as a bare breadcrumb of step
 * names. The CEO signs LAST (ceo_approval, sequence 4 of 4), so he was the one person asked to
 * commit real money on the strength of three approvals whose reasons and timing he could not see.
 *
 * These rules are what make the history trustworthy rather than decorative.
 */
export function runMarketingApproverChainHistoryTests() {
  const rows = directory();

  const chain = buildMarketingApproverChain(
    [
      // Deliberately out of order — the source query has no ORDER BY.
      step({
        decisionAt: "2026-08-04T10:30:00Z",
        decisionByHrId: "A-9",
        decisionNote: "  Brand fit approved for Q3 push.  ",
        id: "s3",
        sequence: 3,
        status: "approved",
        stepName: "Marketing Review",
      }),
      step({ assignedHrId: "AA", id: "s4", sequence: 4, status: "current", stepName: "CEO Approval" }),
      step({
        decisionAt: "2026-08-03T11:46:00Z",
        decisionByHrId: "B-122",
        id: "s1",
        sequence: 1,
        status: "approved",
        stepName: "Manager Approval",
      }),
      step({
        decisionAt: "2026-08-04T10:27:00Z",
        decisionByHrId: "A-2",
        decisionNote: "Customer validated, evidence photo on file.",
        id: "s2",
        sequence: 2,
        status: "approved",
        stepName: "SFE Validation",
      }),
      // A CC advisory row must never appear as a rung of the decision chain.
      step({ decisionByHrId: "A-9", id: "cc1", isCc: true, sequence: 3, status: "approved", stepName: "PM Comment" }),
    ],
    rows,
    "s4",
  );

  // ── Ordered by sequence, CC excluded ────────────────────────────────────────────────────────
  assert.deepEqual(
    chain.map((rung) => rung.stepName),
    ["Manager Approval", "SFE Validation", "Marketing Review", "CEO Approval"],
    "the chain renders in sequence order regardless of the row order the query returns",
  );
  assert.equal(
    chain.some((rung) => rung.stepName === "PM Comment"),
    false,
    "a CC advisory comment is not a rung — showing it would read as a fourth approval that never happened",
  );

  // ── The viewer's own rung is marked, and only that one ──────────────────────────────────────
  assert.deepEqual(
    chain.filter((rung) => rung.isMine).map((rung) => rung.stepName),
    ["CEO Approval"],
    "exactly the viewer's own rung is marked as theirs",
  );
  assert.equal(chain[3].isCurrent, true, "the CEO rung is the one currently waiting");

  // ── Names credit whoever DECIDED, not whoever currently holds the step ──────────────────────
  assert.equal(chain[0].approverName, "Amr Mohamed Naguib Elsabey", "rung 1 names its decider");
  assert.equal(chain[2].approverName, "Hossam Mohamed Reda AboElftouh", "rung 3 names its decider");
  // The CEO rung has no decision yet, so it falls back to the assignee.
  assert.equal(chain[3].approverName, "Anwar Gaweesh", "an undecided rung names its assignee");

  // A re-assigned step must still credit the person who actually approved it.
  const reassigned = buildMarketingApproverChain(
    [step({ assignedHrId: "AA", decisionByHrId: "A-2", id: "x", sequence: 1, status: "approved", stepName: "SFE Validation" })],
    rows,
    null,
  );
  assert.equal(
    reassigned[0].approverName,
    "Khaled Mohamed Ali Bedair",
    "a step re-assigned after its decision still credits the approver who decided it, never the new holder",
  );

  // ── Notes are carried verbatim, trimmed, and absence is distinguishable from blankness ──────
  assert.equal(chain[2].decisionNote, "Brand fit approved for Q3 push.", "the note is carried and trimmed");
  assert.equal(chain[1].decisionNote, "Customer validated, evidence photo on file.");
  assert.equal(chain[0].decisionNote, null, "an approval left without a comment is null, not an empty string");
  assert.equal(
    buildMarketingApproverChain([step({ decisionNote: "   ", id: "w", status: "approved" })], rows, null)[0].decisionNote,
    null,
    "a whitespace-only note is null — it must render as 'No comment left', never as an empty quote",
  );

  // ── Decision times survive as ISO for the UI to render in Cairo ─────────────────────────────
  assert.equal(chain[0].decisionAt, "2026-08-03T11:46:00Z");
  assert.equal(chain[3].decisionAt, null, "a rung that has not decided has no decision time");

  // ── Wiring: the row actually carries it, and the UI actually renders it ─────────────────────
  const serviceSource = source("src/lib/marketing-requests/service.ts");
  assert.match(
    serviceSource,
    /approvalHistory: buildMarketingApproverChain\(/,
    "the inbox row must be built from the shared chain builder, not a second inline copy",
  );
  const inboxSource = source("src/components/employee-portal/marketing-request-inbox.tsx");
  assert.match(
    inboxSource,
    /<ApprovalHistory rungs=\{row\.approvalHistory\}/,
    "the inbox row must render the approval history — carrying it to the client and not showing it is the bug",
  );
  assert.match(
    inboxSource,
    /timeZone: PHOENIX_BUSINESS_TIME_ZONE/,
    "decision times render in Africa/Cairo, never raw UTC",
  );
  assert.match(
    inboxSource,
    /No comment left/,
    "a silent approval is stated explicitly rather than rendering an empty space",
  );
}
