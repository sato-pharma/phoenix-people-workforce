import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * A manager the employee directory does not carry must produce a rung that SAYS it is broken.
 *
 * THE DEFECT THIS PINS (service.ts, buildApprovalChain). When `lookup(cursor)` misses — a departed
 * or mistyped `manager_hr_id` — two things happened silently:
 *
 *   1. a rung was created bound to that raw HR_ID and labelled "Manager", indistinguishable from a
 *      healthy rung. Nobody can ever act on it: `decideDirectOrder` matches a person rung by
 *      `canonicalHrIdKey(access.hrId) === canonicalHrIdKey(step.approverHrId)`, and no session
 *      resolves to an HR_ID absent from the directory. The order sits there forever.
 *   2. `cursor` became null, so every rung ABOVE the break vanished and the request reached the CEO
 *      having skipped its management line.
 *
 * Owner decision 2026-08-12: CREATE AND FLAG. Refusing to build the chain would block a requester
 * because of somebody else's missing record; proceeding silently is what caused this. So the rung is
 * still created, but it is labelled as unresolved and logged.
 *
 * The truncation itself is NOT fixable — without that record there is no next `manager_hr_id` to
 * climb to. This test therefore pins visibility, not chain completeness.
 */
export async function runDirectOrderUnresolvedManagerRungTests() {
  const source = readFileSync(new URL("../src/lib/direct-orders/service.ts", import.meta.url), "utf8");

  const start = source.indexOf("async function buildApprovalChain(");
  assert.ok(start > -1, "buildApprovalChain must exist");
  const body = source.slice(start, source.indexOf("// ── Row mappers", start));

  // The rung must still be CREATED — failing closed here would block a requester over a record
  // they do not own. If this flips to a throw or a `break`, the owner decision has been reversed.
  assert.match(
    body,
    /approverHrId: manager\?\.hrId \?\? cursor/,
    "the rung must still be created for an unresolvable manager — refusing would block the requester",
  );

  // …and it must SAY it is broken. The old fallback was a bare "Manager", which reads as healthy.
  assert.match(
    body,
    /Unresolved manager \(\$\{cursor\}\)/,
    "an unresolvable rung must be labelled as unresolved, not as a generic \"Manager\"",
  );
  assert.doesNotMatch(
    body,
    /label: manager\?\.jobTitle\?\.trim\(\) \|\| "Manager",/,
    "the bare \"Manager\" fallback must not come back — it made a dead rung look like a live one",
  );

  // The break must be logged, or a directory repair is only ever discovered by a stalled order.
  assert.match(
    body,
    /direct_order_chain_unresolved_manager/,
    "an unresolvable manager must be logged with a searchable event label",
  );
  assert.match(
    body,
    /unresolvedManagerHrId: cursor/,
    "the log must name WHICH HR_ID could not be resolved, or the repair has nowhere to start",
  );
  assert.match(
    body,
    /requesterHrId: input\.requesterHrId/,
    "the log must name the requester too — the rungs above the break are gone, so the affected " +
      "request cannot be reconstructed from the chain alone",
  );

  // Guard the decision that was explicitly rejected: hierarchy-resolver's seat key points at the
  // DEPARTED manager (it exists for org-chart grouping), so using it here would address the rung to
  // someone who has resigned. The resignation trigger reassigns manager_hr_id upward precisely so
  // an ACTIVE person can act.
  // Checked against CODE, not prose: the comment explaining why the resolver is kept out has to
  // name it, and an assertion that cannot tell a comment from a call site is one that gets
  // "fixed" by deleting the explanation. (Same trap as the finish_draft guard in
  // direct-orders-second-review-fixes.test.ts.)
  const code = body
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");
  assert.doesNotMatch(
    code,
    /resolveReportingSeatHrId|pendingManagerReplacementForHrId/,
    "buildApprovalChain must NOT use the reporting-seat resolver — it prefers the departed " +
      "manager's HR_ID and would route approvals to a resigned person",
  );

  console.log("  direct-orders unresolved manager rung: created, labelled, logged; seat resolver kept out");
}
