import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { marketingRequestStatusLabel } from "../src/lib/marketing-requests/request-status-label.ts";

/**
 * Pins the one case that matters: a request the CEO has approved must stop calling itself "pending
 * approval" while it waits for Finance to execute. Two live requests read that way on 19 Aug 2026
 * and were taken to be stuck behind an approver who did not exist.
 */
export function runMarketingRequestStatusLabelTests() {
  assert.equal(
    marketingRequestStatusLabel({ currentStepCode: "finance_execution", status: "pending_approval" }),
    "approved · with finance",
    "every approval is in once the request reaches Finance Execution — it must not read as pending approval",
  );

  // Still genuinely waiting on an approver.
  assert.equal(
    marketingRequestStatusLabel({ currentStepCode: "ceo_approval", status: "pending_approval" }),
    "pending approval",
    "a request still on an approval rung keeps saying so",
  );
  assert.equal(
    marketingRequestStatusLabel({ currentStepCode: "sfe_validation", status: "pending_approval" }),
    "pending approval",
    "the relabel is scoped to the execution rung, not to any rung that happens to be current",
  );
  assert.equal(
    marketingRequestStatusLabel({ currentStepCode: null, status: "pending_approval" }),
    "pending approval",
    "an unknown current rung must fall back to the stored status, never to the friendlier claim",
  );

  // Terminal statuses are never rewritten, whatever rung the rows happen to carry.
  assert.equal(
    marketingRequestStatusLabel({ currentStepCode: "finance_execution", status: "rejected" }),
    "rejected",
    "a rejected request is never relabelled as approved, even if a finance rung is still marked current",
  );
  assert.equal(
    marketingRequestStatusLabel({ currentStepCode: "finance_execution", status: "returned" }),
    "returned",
    "a returned request is never relabelled as approved",
  );
  assert.equal(
    marketingRequestStatusLabel({ currentStepCode: null, status: "active" }),
    "active",
    "an executed request keeps its own status",
  );
  assert.equal(
    marketingRequestStatusLabel({ currentStepCode: null, status: "pending_validation" }),
    "pending validation",
    "other stored statuses are only underscore-stripped, not reinterpreted",
  );

  // The label is only useful if the case file renders it instead of the raw status.
  const caseFileSource = readFileSync(
    "src/components/marketing-requests/marketing-request-case-file.tsx",
    "utf8",
  );
  assert.ok(
    caseFileSource.includes("{header.statusLabel}"),
    "the case file status chip must render the computed label",
  );
  assert.ok(
    !caseFileSource.includes("{header.status.replace(/_/g, \" \")}"),
    "the raw status must not be rendered as the chip — that is the string that misled the owner",
  );

  const serviceSource = readFileSync("src/lib/marketing-requests/case-file-service.ts", "utf8");
  assert.ok(
    serviceSource.includes("statusLabel: marketingRequestStatusLabel({"),
    "the case file service must compute the label server-side, so every viewer sees the same words",
  );
}
