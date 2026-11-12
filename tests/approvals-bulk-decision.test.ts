// The Leave and Excuse approval inboxes let an approver tick several requests (or all) and Approve
// all / Reject all.
//
// Owner request 2026-11-12: "make me able to multi-select and approve", for the approvals inbox.
//
// WHAT MUST STAY TRUE. A bulk decision is the single decision repeated, never a second set of rules:
// every request goes through the same service its own decision page uses, one after another, so the
// turn check and the "only the assigned manager" rule apply to each. It never asks for the
// stalled-approver override, a rejection carries a written reason, one failure never stops the rest,
// and only the requests that WERE decided are un-ticked, so a failed one stays selected for a retry.
//
// Expense Approvals already had Approve N; the same day it got its twin, Reject N: one written reason
// for every ticked trip still waiting, marked on screen and committed only by Save, never written over
// the reviewer's own words or the system's "Journey check:" sentence.

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import path from "node:path";

import type { AccessContext } from "@/lib/auth/permissions";
import {
  BULK_DECISION_MAX,
  bulkDecideApprovals,
  parseBulkDecisionInput,
  type BulkDecisionDeps,
} from "@/lib/approvals-hub/bulk-decide";
import { bulkRejectionComment } from "@/components/outstation/expense-review/review-model";
import { stripComments } from "./support/comment-strip.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
const read = (relative: string) => stripComments(readFileSync(path.join(ROOT, relative), "utf8"));

export async function runApprovalsBulkDecisionTests() {
  // ── The input is read strictly ────────────────────────────────────────────
  const ok = parseBulkDecisionInput({ decision: "approve", ids: ["a", "a", " b ", "", 7], module: "leave" });
  assert.ok(ok.ok, "a plain approve over leave requests must parse");
  if (ok.ok) assert.deepEqual(ok.value.ids, ["a", "b"], "ids are trimmed, de-duplicated and non-strings dropped");

  assert.equal(parseBulkDecisionInput({ decision: "return", ids: ["a"], module: "leave" }).ok, false,
    "Return is never a bulk decision — it needs a request-specific comment");
  assert.equal(parseBulkDecisionInput({ decision: "approve", ids: ["a"], module: "outstation" }).ok, false,
    "only Leave and Excuse take a bulk decision");
  assert.equal(parseBulkDecisionInput({ decision: "reject", ids: ["a"], module: "excuse", comment: "  " }).ok, false,
    "a rejection without a reason is refused — the employees read it");
  assert.equal(parseBulkDecisionInput({ decision: "approve", ids: [], module: "excuse" }).ok, false, "nothing ticked is refused");
  const tooMany = Array.from({ length: BULK_DECISION_MAX + 1 }, (_, i) => `id-${i}`);
  assert.equal(parseBulkDecisionInput({ decision: "approve", ids: tooMany, module: "leave" }).ok, false,
    `more than ${BULK_DECISION_MAX} at once is refused`);

  // ── Each request is decided by the single-decision service, in order, and a failure never stops the rest
  const calls: string[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const deps: BulkDecisionDeps = {
    decideExcuse: async (_access, id, decision, comment) => {
      calls.push(`excuse:${id}:${decision}:${comment}`);
    },
    decideLeave: async (_access, id, decision, comment) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight -= 1;
      calls.push(`leave:${id}:${decision}:${comment}`);
      if (id === "not-your-turn") throw new Error("It is not your turn to decide this request.");
    },
  };
  const access = { hrId: "TEST", role: "Super Admin" } as unknown as AccessContext;
  const results = await bulkDecideApprovals(
    access,
    { comment: null, decision: "approve", ids: ["r1", "not-your-turn", "r3"], module: "leave" },
    deps,
  );
  assert.deepEqual(calls, ["leave:r1:approve:null", "leave:not-your-turn:approve:null", "leave:r3:approve:null"],
    "every ticked leave request goes through the leave decision service, in order");
  assert.equal(maxInFlight, 1, "requests are decided one after another, never in parallel (two decisions must not race on one balance)");
  assert.deepEqual(results.map((row) => row.ok), [true, false, true], "a refused request does not stop the ones after it");
  assert.equal(results[1].message, "It is not your turn to decide this request.", "the refusal's own words come back for that request");

  calls.length = 0;
  await bulkDecideApprovals(access, { comment: "Overlaps the audit", decision: "reject", ids: ["e1"], module: "excuse" }, deps);
  assert.deepEqual(calls, ["excuse:e1:reject:Overlaps the audit"], "an excuse goes through the excuse service with the one reason");

  // ── The default services never ask for the override ──────────────────────
  const domain = read("src/lib/approvals-hub/bulk-decide.ts");
  assert.ok(/decideVacationRequest\(/.test(domain) && /decideExcuseRequestAsManager\(/.test(domain),
    "bulk-decide.ts no longer calls the single-decision services — it would need rules of its own");
  assert.ok(!/override/.test(domain), "a bulk decision must never ask for the stalled-approver override");

  // ── The route and its registry entry ─────────────────────────────────────
  const route = read("app/api/approvals/bulk-decision/route.ts");
  assert.ok(/assertSameOriginMutation\(request\)/.test(route), "the bulk route must refuse a cross-site POST");
  assert.ok(/assertApiRateLimit\(/.test(route), "the bulk route must be rate limited");
  assert.ok(/bulkDecideApprovals\(access, parsed\.value\)/.test(route), "the route must decide through bulkDecideApprovals");
  const registry = readFileSync(path.join(ROOT, "src/lib/security/access-registry.ts"), "utf8");
  assert.ok(/pattern: "\/api\/approvals\/bulk-decision"[^\n]*csrfRequired: true/.test(registry),
    "the bulk route needs its access-registry entry, CSRF required");

  // ── The bar: asks first, un-ticks only what was decided ──────────────────
  const bar = read("src/components/approvals-hub/bulk-decision-bar.tsx");
  assert.ok(bar.includes('"/api/approvals/bulk-decision"'), "the bar must post to the bulk route");
  assert.ok(/setMode\("approve"\)/.test(bar) && /Confirm — approve/.test(bar), "Approve must ask before it writes");
  assert.ok(/decision === "reject" && !reason\.trim\(\)/.test(bar), "Reject must refuse an empty reason before posting");
  assert.ok(/filter\(\(row\) => row\.ok\)/.test(bar) && /onFinished\(decidedIds\)/.test(bar),
    "only the requests that were decided may be un-ticked");
  // The bar holds its place with nothing ticked: when it appeared on the first tick it pushed the list
  // down, and the owner's next click landed on the wrong request (2026-11-13).
  assert.ok(!/return null/.test(bar), "the bar must never vanish with nothing ticked — its arrival makes the list jump under the next click");
  assert.ok(bar.includes("No request ticked") && /disabled=\{busy \|\| count === 0\}/.test(bar),
    "with nothing ticked the bar shows its row with Approve and Reject disabled");

  // ── Only Leave and Excuse turn it on, and only on the requests awaiting the viewer ──
  const workspace = read("src/components/approvals-hub/approvals-workspace.tsx");
  assert.ok(/sections\.filter\(\(s\) => !s\.readOnly\)/.test(workspace),
    "only a section awaiting the viewer may be ticked — never 'Coming to you' or the viewer's own");
  assert.ok(read("src/components/approvals-hub/vacation-approvals-body.tsx").includes('bulkDecisionModule="leave"'), "Leave turns it on");
  assert.ok(read("src/components/approvals-hub/excuse-approvals-body.tsx").includes('bulkDecisionModule="excuse"'), "Excuse turns it on");
  assert.ok(!read("src/components/approvals-hub/plan-approvals-body.tsx").includes("bulkDecisionModule"),
    "Plans stay one at a time — their stages need decisions the bulk route does not make");

  // ── Expense Approvals: Reject N beside Approve N ─────────────────────────
  assert.equal(bulkRejectionComment("", "  Not an outstation trip "), "Not an outstation trip", "an empty comment takes the batch reason");
  assert.equal(
    bulkRejectionComment("Journey check: priced as 2 drives.", "Duplicate of an earlier claim"),
    "Duplicate of an earlier claim Journey check: priced as 2 drives.",
    "the system's Journey check sentence stays at the end, after the batch reason",
  );
  assert.equal(
    bulkRejectionComment("Called him, he agreed. Journey check: priced as 2 drives.", "Duplicate"),
    "Called him, he agreed. Journey check: priced as 2 drives.",
    "the reviewer's own words are never written over by the batch reason",
  );
  const hook = read("src/components/outstation/expense-review/use-expense-review.ts");
  const rejectStart = hook.indexOf("const rejectSelected = useCallback(");
  assert.ok(rejectStart > 0, "use-expense-review.ts: rejectSelected is gone — Expense Approvals has no Reject N");
  const rejectEnd = hook.indexOf("[bulkPlan, records, selectedVisible]", rejectStart);
  assert.ok(rejectEnd > rejectStart, "use-expense-review.ts: could not find where rejectSelected ends");
  const rejectBody = hook.slice(rejectStart, rejectEnd);
  assert.ok(rejectBody.includes("if (!text)"), "a batch rejection with no reason must mark nothing");
  assert.ok(rejectBody.includes("notPendingTripIds"), "a trip already decided must be skipped, never re-rejected");
  assert.ok(rejectBody.includes("status: REJECTED_STATUS") && rejectBody.includes("bulkRejectionComment(base.hrComment, text)"),
    "a batch rejection writes the single Reject's status, with the reason through bulkRejectionComment");
  assert.ok(!rejectBody.includes("fetch(") && !rejectBody.includes("save()"),
    "Reject N saves nothing — Save still commits, so a mis-click stays reversible");
  const expenseBar = read("src/components/outstation/expense-review/review-bulk-bar.tsx");
  assert.ok(expenseBar.includes("data-bulk-reject-confirm disabled={!reason.trim()}"),
    "the expense Reject N must not confirm without a written reason");
  assert.ok(read("src/components/outstation/expense-review/expense-review-workspace.tsx").includes("onReject={review.rejectSelected}"),
    "the expense workspace must wire Reject N to rejectSelected");
}
