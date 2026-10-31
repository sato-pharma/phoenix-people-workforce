import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  isRaisedByViewer,
  parseRequestedOrdersScope,
  resolveEffectiveOrdersScope,
} from "../src/lib/direct-orders/orders-scope.ts";
import { describeDirectOrderStatus } from "../src/lib/direct-orders/status-labels.ts";
import { stripComments } from "./support/comment-strip.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Three things the National Sales Manager's audit (26 Oct 2026) found on the Direct Orders workspace:
//   1. the four tiles read 0 / 24 / 3 / 3 on Overview and 0 / 0 / 0 / 0 on every other tab — a
//      false zero, because the totals were only fetched for Overview;
//   2. the Orders tab opened on "Mine" and said "You have not raised a direct order yet" above 91
//      orders in the approver's scope;
//   3. "Needs Your Correction" was shown on orders other people raised.
//
// 2 and 3 are pure functions and are executed. 1 lives in a loader that needs a database, so it is
// pinned in the source, comments stripped (a comment that explains the call must not satisfy it).
// ─────────────────────────────────────────────────────────────────────────────

const read = (path: string) =>
  stripComments(readFileSync(new URL(`../${path}`, import.meta.url), "utf8").split("\r\n").join("\n"));

export function runDirectOrderWorkspaceHonestTilesTests() {
  // ── 3. The wording belongs to the person who raised the order ───────────────────────────────
  const forRaiser = describeDirectOrderStatus("returned", null, { isRequester: true });
  const forOthers = describeDirectOrderStatus("returned", null, { isRequester: false });
  const unknown = describeDirectOrderStatus("returned", null);
  assert.equal(forRaiser.label, "Needs Your Correction");
  assert.equal(forOthers.label, "Returned for correction");
  assert.equal(unknown.label, "Returned for correction", "no reader named: the neutral wording, never the personal claim");
  assert.ok(!/\byour\b|\byou\b/i.test(forOthers.label + forOthers.explanation), "a non-raiser is never told 'you'");
  assert.equal(forOthers.stage, forRaiser.stage);
  assert.equal(forOthers.tone, forRaiser.tone);
  assert.equal(describeDirectOrderStatus("held", null, { isRequester: true }).label, "Customer Verification Required");

  assert.equal(isRaisedByViewer("B-10", "b-10"), true, "stored in either case, compared by canonical key");
  assert.equal(isRaisedByViewer("b-76", "B-76"), true);
  assert.equal(isRaisedByViewer("B-76", "B-10"), false);
  assert.equal(isRaisedByViewer("", ""), false, "a blank id never matches a blank id");
  assert.equal(isRaisedByViewer(undefined, "b-10"), false);
  assert.equal(isRaisedByViewer("b-10", null), false);

  // ── 2. The default slice ─────────────────────────────────────────────────────────────────────
  assert.equal(parseRequestedOrdersScope("all"), "all");
  assert.equal(parseRequestedOrdersScope("mine"), "mine");
  assert.equal(parseRequestedOrdersScope(undefined), null);
  assert.equal(parseRequestedOrdersScope("everything"), null);

  const approverWithNone = { canSeeAllOrders: true, ownOrderCount: 0 };
  assert.equal(
    resolveEffectiveOrdersScope({ requested: null, ...approverWithNone }),
    "all",
    "a wider scope and no orders of their own lands on the whole scope",
  );
  assert.equal(
    resolveEffectiveOrdersScope({ requested: null, canSeeAllOrders: true, ownOrderCount: 3 }),
    "mine",
    "someone who raises orders still lands on their own",
  );
  assert.equal(resolveEffectiveOrdersScope({ requested: "mine", ...approverWithNone }), "mine", "an explicit choice wins");
  assert.equal(
    resolveEffectiveOrdersScope({ requested: "all", canSeeAllOrders: true, ownOrderCount: 3 }),
    "all",
  );
  assert.equal(
    resolveEffectiveOrdersScope({ requested: "all", canSeeAllOrders: false, ownOrderCount: 0 }),
    "mine",
    "an own-scope viewer has no wider set to be shown",
  );
  assert.equal(resolveEffectiveOrdersScope({ requested: null, canSeeAllOrders: false, ownOrderCount: 0 }), "mine");

  // ── 1. The loader fetches the totals on every view ───────────────────────────────────────────
  const loader = read("src/lib/direct-orders/workspace-data.ts");
  // Read inside the loader's one batch since 2026-10-31 ("fix the slowest five pages") — as a bare
  // element of it, behind no view test, so it is still read on every view.
  assert.match(
    loader,
    /^ {4}countDirectOrderWorkspaceTotals\(access, currentCairoSalesMonth\(options\.now\)\),$/m,
    "the four tiles render above every tab, so the totals are read on every view",
  );
  assert.match(loader, /^ {4}totals,$/m, "and the batch hands them back as `totals`");
  assert.ok(
    !/inProgress: 0, returned: 0, completedThisMonth: 0/.test(loader),
    "no constant-zero fallback may stand in for a count that was not read",
  );
  assert.match(loader, /const needsValidations = canDecideCustomerValidations;/, "the Needs-my-action tile counts validations on every tab too");

  // ── The pages and the component are wired to it ──────────────────────────────────────────────
  for (const page of ["app/employee-portals/direct-orders/page.tsx", "app/(admin)/admin/direct-orders/page.tsx"]) {
    const source = read(page);
    assert.match(source, /scopeFilter: parseRequestedOrdersScope\(scope\)/, `${page}: an absent ?scope= stays open for the loader`);
    assert.ok(!/scope === "all" \? "all" : "mine"/.test(source), `${page}: no forced 'mine' default`);
    assert.match(source, /viewerHrId=\{access\.hrId/, `${page}: the component is told who is reading`);
  }
  const component = read("src/components/direct-orders/workspace/direct-orders-workspace.tsx");
  assert.match(component, /viewerIsRequester=\{isRaisedByViewer\(row\.requesterHrId, viewerHrId\)\}/);
  assert.match(component, /pushParams\(\{ scope: next, page: null \}\)/, "'mine' is written to the URL, so it can be chosen when the default is 'all'");
}
