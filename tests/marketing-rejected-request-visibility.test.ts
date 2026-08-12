import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import type { EmployeeDirectoryRow } from "@/lib/employees/employee-directory";
import { buildMarketingRejectionSummary } from "@/lib/marketing-requests/service";
import type { MarketingRequestApprovalStep } from "@/lib/marketing-requests/types";

// ─────────────────────────────────────────────────────────────────────────────
// A requester must be able to see their own REJECTED request.
//
// getMarketingRequestDraftWorkspace issued four status-scoped reads of marketing_requests —
// 'draft', approvedMarketingRequestStatuses, 'returned' and 'pending_approval'. 'rejected' was in
// none of them, so a refused request appeared in NO list on the workspace, not even to the person
// who raised it. Measured on production 2026-08-12: MKT-REQ-20260811-FF5B0719 was submitted by A-9
// at 14:12 Cairo and refused at 14:23 with the note "no request for conviban". A-9 could not reach
// the request, or that sentence, from any screen.
//
// The rejection note is the only place the "why" of a refusal is written down anywhere in the
// module — there is no history table — so losing sight of it loses the reason permanently.
// ─────────────────────────────────────────────────────────────────────────────

function source(path: string) {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

function step(overrides: Partial<MarketingRequestApprovalStep>): MarketingRequestApprovalStep {
  return {
    allowReject: true,
    allowReturn: true,
    assignedHrId: "AA",
    assignedRole: "CEO",
    createdAt: "2026-08-11T11:12:09.817Z",
    decisionAt: null,
    decisionByHrId: null,
    decisionLabels: null,
    decisionNote: null,
    executedAt: null,
    id: "step-1",
    isCc: false,
    requestId: "req-1",
    sequence: 1,
    status: "pending",
    stepCode: "manager_chain",
    stepKind: "role",
    stepName: "CEO Approval",
    terminalStatus: null,
    updatedAt: "2026-08-11T11:12:09.817Z",
    workflowStepId: 6,
    ...overrides,
  };
}

const employees = [
  { displayName: "Omar Gawish", hrId: "AA", jobTitle: "CEO" },
  { displayName: "Mona Said", hrId: "A-2", jobTitle: "SFE Manager" },
] as unknown as EmployeeDirectoryRow[];

export async function runMarketingRejectedRequestVisibilityTests() {
  const serviceSource = source("src/lib/marketing-requests/service.ts");
  const draftsSource = source("src/components/employee-portal/marketing-request-drafts.tsx");

  /* ---------------------------------------------------------------------- */
  /* The headline: the workspace must actually READ rejected requests        */
  /* ---------------------------------------------------------------------- */

  assert.match(
    serviceSource,
    /\.eq\("status",\s*"rejected"\)/,
    "a requester must be able to see their own rejected request — the workspace has to query the rejected status, and for a long time it was the one requester-reachable status it never read",
  );
  assert.match(
    serviceSource,
    /rejectionByRequestId/,
    "the workspace must expose why each request was rejected, not merely that it was",
  );

  // The rejected list must be scoped exactly like `returned` — own requests for company-wide
  // roles, hierarchy subtree otherwise. A wider scope would leak other people's refusals.
  assert.match(
    serviceSource,
    /const rejected = narrowToOwnRequests\(/,
    "rejected must be narrowed like returned — never broader",
  );
  assert.match(
    serviceSource,
    /rejectedResult\.data[\s\S]{0,200}?passesHierarchyCheck[\s\S]{0,120}?passesProductFilter/,
    "rejected rows must pass BOTH the hierarchy check and the product-code filter, like every other list",
  );

  /* ---------------------------------------------------------------------- */
  /* The reason must reach the screen without a click                        */
  /* ---------------------------------------------------------------------- */

  assert.match(
    draftsSource,
    /workspace\.rejected\.map/,
    "the tracking view must render the rejected list",
  );
  assert.match(
    draftsSource,
    /rejection\.reason/,
    "the rejection reason must be rendered inline — needing a click to reach it is the failure this card exists to end",
  );
  assert.match(
    draftsSource,
    /No reason was recorded/,
    "a missing reason must say so; a blank line and 'nobody wrote a reason' must not look the same",
  );

  /* ---------------------------------------------------------------------- */
  /* buildMarketingRejectionSummary — behaviour                              */
  /* ---------------------------------------------------------------------- */

  // It reads the rung that actually said no, not the last rung in the chain. On the live example
  // the refusal is at sequence 1 while four later rungs are still 'pending', so a last-step
  // fallback would name Finance Execution as the decider of a request it never saw.
  const liveShape = [
    step({ decisionAt: "2026-08-11T11:23:19.799Z", decisionByHrId: "AA", decisionNote: "no request for conviban", id: "s1", sequence: 1, status: "rejected" }),
    step({ assignedHrId: "A-2", assignedRole: "SFE Manager", id: "s2", sequence: 2, status: "pending", stepCode: "sfe_validation", stepName: "SFE Validation" }),
    step({ assignedHrId: "B-185", assignedRole: "Finance Manager", id: "s5", sequence: 5, status: "pending", stepCode: "finance_execution", stepName: "Finance Execution" }),
  ];
  const rejection = buildMarketingRejectionSummary(liveShape, employees);
  assert.ok(rejection, "a chain holding a rejected rung must produce a rejection summary");
  assert.equal(rejection.stepName, "CEO Approval", "the summary must name the rung that rejected, not the last rung in the chain");
  assert.equal(rejection.sequence, 1, "the summary must report the rejecting rung's own sequence");
  assert.equal(rejection.reason, "no request for conviban", "the rejection note must survive to the summary verbatim");
  assert.equal(rejection.decidedByName, "Omar Gawish", "the summary must name the human who decided, not their HR_ID");

  // Cairo, never raw UTC (standing rule). 11:23 UTC is 14:23 in Cairo.
  assert.ok(rejection.decidedAtLabel, "the summary must carry a display-ready timestamp");
  assert.match(
    rejection.decidedAtLabel,
    /14:23/,
    "the decision time must be rendered in Africa/Cairo, never raw UTC — 11:23Z is 14:23 in Cairo",
  );

  // Credit the decider over the addressee: a rung decided by a stand-in must not be attributed
  // to the person it happened to be addressed to.
  const standIn = buildMarketingRejectionSummary(
    [step({ assignedHrId: "A-2", decisionAt: "2026-08-11T11:23:19.799Z", decisionByHrId: "AA", decisionNote: "no", status: "rejected" })],
    employees,
  );
  assert.equal(standIn?.decidedByName, "Omar Gawish", "decisionByHrId must win over assignedHrId — credit who decided, not who it was addressed to");

  // A blank note is null, never "". "No reason recorded" and an empty string must not render alike.
  const blank = buildMarketingRejectionSummary(
    [step({ decisionAt: "2026-08-11T11:23:19.799Z", decisionByHrId: "AA", decisionNote: "   ", status: "rejected" })],
    employees,
  );
  assert.equal(blank?.reason, null, "a whitespace-only note must normalise to null, never to an empty string");

  // A CC/advisory row is not an approval and is not a refusal either.
  const ccOnly = buildMarketingRejectionSummary(
    [step({ decisionAt: "2026-08-11T11:23:19.799Z", decisionByHrId: "AA", decisionNote: "not keen", isCc: true, status: "rejected" })],
    employees,
  );
  assert.equal(ccOnly, null, "a CC reviewer's row must never be read as the refusal — an advisory comment is not a rejection");

  // No rejected rung at all → null, so the UI can say "details unavailable" rather than invent one.
  assert.equal(
    buildMarketingRejectionSummary([step({ status: "approved" })], employees),
    null,
    "a chain with no rejected rung must produce no rejection summary",
  );

  /* ---------------------------------------------------------------------- */
  /* A rejected request must NOT be given a "currently with" progress strip  */
  /* ---------------------------------------------------------------------- */

  assert.match(
    serviceSource,
    /rejectedRequestIds\.has\(requestId\)[\s\S]{0,220}?continue;/,
    "a rejected request must be skipped by the step-progress builder — nobody is holding it, and the last-step fallback would name an approver who never saw it",
  );
}
