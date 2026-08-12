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

/**
 * THE WAY OUT (task #90 / Priority 7, 2026-08-12).
 *
 * Flagging the break was half the job. A rung that says it is broken and that nobody can act on is
 * a better-documented dead end — the order still sits at `pending_approval` until a requester
 * complains. This half is the desk that finds them and the action that frees them.
 *
 * The assertions below are about the difference between a REPAIR and an OVERRIDE, because that is
 * the only thing here that could go quietly wrong. A desk that re-addresses a stuck rung is a
 * safety valve; the same desk without its broken-rung guard is a way to route around any approver
 * who keeps saying no, and nothing about the UI would look different.
 */
export async function runDirectOrderApprovalExceptionTests() {
  const service = readFileSync(new URL("../src/lib/direct-orders/service.ts", import.meta.url), "utf8");

  const start = service.indexOf("export async function repairDirectOrderApprovalRung(");
  assert.ok(start > -1, "repairDirectOrderApprovalRung must exist");
  const nextDecl = /\n(?:export )?(?:async )?function \w+/g;
  nextDecl.lastIndex = start + 1;
  const repair = service.slice(start, nextDecl.exec(service)?.index ?? service.length);

  // ── THE GUARD THAT MAKES THIS A REPAIR ─────────────────────────────────────
  //
  // Without it the desk re-addresses ANY pending rung, which is choosing somebody else's approver —
  // the approval chain itself. Pinned on the refusal, not on the presence of a lookup, because a
  // lookup whose result is ignored reads identically at a glance.
  assert.match(
    repair,
    /if \(lookup\(currentApproverHrId\)\) \{[\s\S]*?badRequest\(/,
    "A RUNG WHOSE APPROVER STILL RESOLVES MUST BE REFUSED. Without this the desk is a way to move " +
      "an approval off anyone inconvenient, and it would look exactly the same on screen.",
  );

  // Nobody approves their own order — and a repair path is precisely where that slips in unnoticed,
  // because the person doing the repair is not the person who benefits.
  assert.match(
    repair,
    /canonicalHrIdKey\(nextApprover\.hrId\) === canonicalHrIdKey\(request\.requesterHrId\)/,
    "the requester must never be installed as their own approver",
  );

  // Re-addressing to another missing record would recreate the exact fault being repaired.
  assert.match(
    repair,
    /const nextApprover = lookup\(input\.newApproverHrId\);[\s\S]*?if \(!nextApprover\)/,
    "the new approver must resolve in the directory, or the repair rebuilds the dead end",
  );

  // ── THE ORDER MUST NOT MOVE ────────────────────────────────────────────────
  //
  // This is the whole design: keep every approval the chain demanded, change only who it is
  // addressed to. An update touching `status`, or an insert/delete of a step, would be an override
  // wearing a repair's name.
  assert.match(
    repair,
    /expectedNextStatus: "pending_approval"/,
    "the registry transition must assert the status does not change",
  );
  assert.doesNotMatch(
    repair,
    /from\("direct_order_requests"\)\s*\n?\s*\.update\(/,
    "the REQUEST row must not be updated at all — re-addressing a rung moves nothing",
  );
  assert.doesNotMatch(
    repair,
    /from\("direct_order_approval_steps"\)\s*\n?\s*\.(insert|delete)\(/,
    "no rung may be added or removed: the order still owes the same approvals to the same seats",
  );

  // Compare-and-swap on BOTH the status and the broken HR_ID. Either changing underneath means
  // somebody else acted, and a silent overwrite would erase their decision.
  assert.match(
    repair,
    /\.eq\("status", "pending"\)\s*\n\s*\.eq\("approver_hr_id", currentApproverHrId\)/,
    "the update must be a compare-and-swap on the status AND the HR_ID it is replacing",
  );
  assert.match(
    repair,
    /if \(\(updated \?\? \[\]\)\.length === 0\)/,
    "a compare-and-swap that matched nothing must be an error — an unchecked guard is not a guard " +
      "(the same omission the held-revive path was fixed for)",
  );

  // Recorded three ways, because each answers a different question later: the audit log says WHO,
  // the event says WHAT the reader of this order should know, the notification says it to the two
  // people whose day it changes.
  assert.match(repair, /writeRequiredAuditLog\(/, "the repair must be audited");
  assert.match(repair, /eventType: "approval_rung_repaired"/, "the order's own history must record it");
  assert.match(repair, /notifyDirectOrder\(/, "the new approver and the requester must be told");
  assert.match(
    repair,
    /if \(!reason\) badRequest\(/,
    "a reason is required — the registry declares requiresReason, and the next reader needs the why",
  );

  // Super Admin only, and by the SAME helper the read side uses, so the desk and its action cannot
  // drift apart.
  assert.match(repair, /assertApprovalExceptionDeskAccess\(access\)/, "the repair must be Super Admin only");

  // ── THE UNION, THE DB ROW AND THE CALL SITE MUST LAND TOGETHER ─────────────
  //
  // Audit finding F2: a key declared in only two of the three is how this module's governance layer
  // ended up not covering its own most important flow. The 2026-08-05 outage was the other half of
  // the same lesson.
  const workflow = readFileSync(new URL("../src/lib/direct-orders/workflow.ts", import.meta.url), "utf8");
  assert.match(workflow, /\| "repair_approval_rung"/, "the action key must be in the union");
  assert.match(repair, /actionKey: "repair_approval_rung"/, "the call site must name the key");

  const migration = readFileSync(
    new URL("../supabase/migrations/20260812140000_direct_orders_repair_approval_rung.sql", import.meta.url),
    "utf8",
  );
  assert.match(migration, /'key', 'repair_approval_rung'/, "the registry row must declare the action");
  assert.match(
    migration,
    /'from', jsonb_build_array\('pending_approval'\)[\s\S]*?'to', 'pending_approval'/,
    "the declared transition must be pending_approval -> pending_approval: this action moves nothing",
  );
  assert.match(
    migration,
    /'allowedRoles', jsonb_build_array\('Super Admin'\)/,
    "the registry must agree with the service: Super Admin alone",
  );
  assert.match(migration, /'requiresReason', true/, "the registry must require a reason");
  assert.match(
    migration,
    /registry would be SKIPPED by the loader/,
    "the loader simulation must run before commit — an action naming an undeclared status kills the " +
      "WHOLE module at runtime, which is what took direct orders down on 2026-08-05",
  );
  assert.match(
    migration,
    /raise exception 'repair_approval_rung was not added/,
    "an `update ... where not exists` that matched nothing is silent, and a silently-absent action " +
      "is exactly the bug shape this module keeps re-learning",
  );

  // ── The desk finds them without a scope filter, and only while they matter ──
  const listStart = service.indexOf("export async function listDirectOrderApprovalExceptions(");
  assert.ok(listStart > -1, "listDirectOrderApprovalExceptions must exist");
  nextDecl.lastIndex = listStart + 1;
  const list = service.slice(listStart, nextDecl.exec(service)?.index ?? service.length);

  assert.match(list, /assertApprovalExceptionDeskAccess\(access\)/, "the desk read must be Super Admin only");
  assert.match(
    list,
    /\.eq\("status", "pending_approval"\)/,
    "only IN-FLIGHT orders: a pending step survives on a rejected order, and listing those would be " +
      "a queue of work nobody needs to do",
  );
  assert.match(
    list,
    /\.not\("approver_hr_id", "is", null\)/,
    "role rungs cannot strand an order — they resolve to whoever holds the post today",
  );
  assert.doesNotMatch(
    list,
    /resolveDirectOrderReportScope|resolveVisibleRequesterHrIds/,
    "deliberately UNSCOPED: this is a system-integrity desk, and a District Manager's departed " +
      "manager is exactly the record a System Admin has to be able to see",
  );

  // The suggestion is a suggestion. The directory is what was wrong, so an admin confirms a name
  // rather than the system quietly repairing its own bad data with more of its own data.
  const deskSource = readFileSync(
    new URL("../src/components/direct-orders/approval-exceptions-desk.tsx", import.meta.url),
    "utf8",
  );
  assert.match(
    deskSource,
    /row\.suggestedApproverHrId \?\? ""/,
    "the suggested approver must be PRE-FILLED so the common case is fast",
  );
  assert.match(
    deskSource,
    /check before\s*\n?\s*confirming|check before confirming/,
    "and presented as something to check, not as an answer",
  );

  // The link and the gate must agree, or the desk is an invitation to a 403.
  const nav = readFileSync(new URL("../src/config/system-navigation.ts", import.meta.url), "utf8");
  const navEntry = nav.slice(
    nav.indexOf('href: "/admin/direct-orders/approval-exceptions"'),
    nav.indexOf('href: "/admin/direct-orders/cleanup"'),
  );
  assert.match(
    navEntry,
    /roles: \["Super Admin"\]/,
    "the nav entry must be Super-Admin-only, matching the service — a wider link only leads to a 403",
  );

  console.log("  direct-orders approval exceptions: a healthy rung is refused, the order never moves");
  console.log("  direct-orders approval exceptions: union + registry row + call site land together");
}
