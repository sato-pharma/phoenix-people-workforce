import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describeLifecycleStage } from "@/lib/marketing-requests/case-file-service";
import { marketingRequestStatusLabel } from "@/lib/marketing-requests/request-status-label";
import { roiLifecycleStage } from "@/lib/marketing-requests/roi-live-stages";

// The finance hold shipped with an API route and NO caller.
//
// `finance_hold` appeared in six components and in every one of them it was a status LABEL being
// displayed; nothing anywhere posted to the endpoint. The first real hold in production had to be
// placed by running the domain code by hand. A capability with no control is indistinguishable
// from one that does not work — which is exactly what the underlying actor bug turned out to be.
//
// These pin the reader-facing half: that a held request says so truthfully, that its reason is
// reachable, and that the control exists and is gated.

const COMPONENT = join(process.cwd(), "src/components/marketing-requests/marketing-request-case-file.tsx");
const CONTROL = join(process.cwd(), "src/components/marketing-requests/marketing-finance-hold-control.tsx");
const SERVICE = join(process.cwd(), "src/lib/marketing-requests/case-file-service.ts");

export function runMarketingFinanceHoldUiTests() {
  // ── The status no longer reads as a queue ──────────────────────────────────
  //
  // It fell through to `status.replace("_", " ")` → "finance hold", which reads like somewhere a
  // request is waiting rather than a decision someone took.
  const heldLabel = marketingRequestStatusLabel({ currentStepCode: null, status: "finance_hold" });
  assert.ok(
    heldLabel.includes("held"),
    `a held request must say it was held, got "${heldLabel}"`,
  );
  assert.notEqual(heldLabel, "finance hold", "the bare de-underscored fall-through is what this replaces");

  // The other statuses must be untouched — this is a money module's shared label function.
  assert.equal(
    marketingRequestStatusLabel({ currentStepCode: "finance_execution", status: "pending_approval" }),
    "approved · with finance",
    "the Finance Execution label predates this and must not move",
  );
  assert.equal(
    marketingRequestStatusLabel({ currentStepCode: null, status: "pending_approval" }),
    "pending approval",
    "an ordinary pending request still de-underscores",
  );

  // ── The sentence no longer contradicts the truth ───────────────────────────
  //
  // `finance_hold` files under the `awaiting_approval` STAGE, and the generic sentence for that
  // stage said "Awaiting a decision. Nothing is committed until the chain finishes." on a request
  // whose chain HAD finished and whose money IS committed.
  const heldSentence = describeLifecycleStage({
    currentStepName: null,
    payDate: null,
    salesDataAsOf: null,
    stage: "awaiting_approval",
    status: "finance_hold",
    windowEnd: null,
  });
  assert.ok(
    !heldSentence.includes("Nothing is committed"),
    `a held request's money IS committed — got "${heldSentence}"`,
  );
  assert.ok(
    !heldSentence.includes("Awaiting a decision"),
    "a held request is not waiting on an approver, and saying so sends the reader hunting for one",
  );
  assert.ok(heldSentence.includes("froze") || heldSentence.includes("frozen"), "it must say it was frozen");

  // The other awaiting statuses keep their own sentences — the branch must be narrow.
  for (const [status, fragment] of [["draft", "Still a draft"], ["returned", "Returned to the requester"]] as const) {
    const sentence = describeLifecycleStage({
      currentStepName: null,
      payDate: null,
      salesDataAsOf: null,
      stage: "awaiting_approval",
      status,
      windowEnd: null,
    });
    assert.ok(sentence.includes(fragment), `"${status}" must keep its own sentence, got "${sentence}"`);
  }

  // ── The STAGE itself must not have moved ───────────────────────────────────
  //
  // This is the load-bearing one. The stage decides whether money counts as committed in the ROI
  // pipeline; a held request must stay OUT of the committed bucket. Fixing the prose by moving the
  // status between stages would silently restate company spend on every ROI screen.
  assert.equal(
    roiLifecycleStage({ dataCoverage: "no_validated_data", payDate: "2026-08-11", status: "finance_hold" }, "2026-08"),
    "awaiting_approval",
    "the hold must stay in awaiting_approval — the fix is the sentence, never the stage",
  );

  const service = readFileSync(SERVICE, "utf8");
  const component = readFileSync(COMPONENT, "utf8");
  const control = readFileSync(CONTROL, "utf8");

  // ── The reason is actually read ────────────────────────────────────────────
  //
  // It lives in `marketing_request_finance_requirements.notes` — a different table from
  // `marketing_requests`, which is why no screen showed it. The panel is worthless without it.
  assert.ok(
    service.includes("marketing_request_finance_requirements"),
    "the case file must read the table that stores the hold, or the reason stays invisible",
  );
  assert.ok(service.includes("notes"), "the reason column is `notes`");
  assert.ok(component.includes("hold.reason"), "the panel must render the recorded reason");

  // ── The control exists, and posts the right thing ──────────────────────────
  assert.ok(
    control.includes("/api/marketing-requests/finance-hold"),
    "the control must call the finance-hold route — an endpoint with no caller is what this fixes",
  );
  for (const action of ['"release"', '"hold"']) {
    assert.ok(control.includes(action), `the control must be able to ${action}`);
  }
  assert.ok(
    component.includes("MarketingFinanceHoldControl"),
    "the Case File must actually render the control",
  );

  // Both halves reachable: releasing a held request, and placing a hold on one that is not.
  assert.ok(component.includes("canPlaceHold"), "a Super Admin must be able to PLACE a hold, not only release one");

  // ── A reason is required in both directions ────────────────────────────────
  //
  // The server writes reason-before-status precisely so a timeout cannot leave a frozen request
  // with no recorded why. That ordering is pointless if the UI can submit an empty reason.
  assert.ok(
    control.includes("reason.trim()") && control.includes("setError"),
    "the control must refuse an empty reason rather than freezing money with no record",
  );

  // ── The affordance is gated, and gated on the SERVER ───────────────────────
  //
  // A component re-listing which statuses may be frozen would be a second copy of a money rule —
  // this module has already paid for exactly that, with two definitions of "overdue".
  assert.ok(
    service.includes("canPlaceMarketingRequestOnFinanceHold"),
    "the placeable check must come from the domain predicate, not a list re-typed in a component",
  );
  assert.ok(
    !component.includes("marketingFinanceHoldableStatuses"),
    "the component must not re-list the holdable statuses",
  );
  assert.ok(
    component.includes("viewer.can.manageFinanceHold"),
    "the control must be gated on the viewer capability",
  );
}
