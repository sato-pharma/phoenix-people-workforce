import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { canCancelHeldDirectOrder } from "../src/lib/direct-orders/cancel-visibility.ts";
import { DIRECT_ORDER_REPORT_STATUS_OPTIONS } from "../src/lib/direct-orders/report-filters.ts";
import { isTerminalDirectOrderStatus, type DirectOrderStatus } from "../src/lib/direct-orders/types.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Cancelling a held direct order (deep workflow audit, finding F3).
//
// `held` had exactly two exits: the pharmacy passing validation, and the 14-day clock. A requester
// who raised the same order twice — which is what happens when the first attempt cannot find a
// valid pharmacy code, and did happen on 2026-08-04, 22 minutes apart — could not retire the
// duplicate. Doing it by hand needed raw SQL against production, which bypassed the registry
// because the registry had no word for it.
//
// The visibility predicate is PURE, so most of this file executes the real rule rather than reading
// the source for it. Only the service body is source-pinned, because that path is Supabase-bound
// end to end.
// ─────────────────────────────────────────────────────────────────────────────

/** Every status the type allows. Kept literal so a new status makes the sweeps below fail loudly. */
const ALL_STATUSES: DirectOrderStatus[] = [
  "draft",
  "pending_approval",
  "approved",
  "rejected",
  "returned",
  "reversed",
  "held",
  "expired",
  "cancelled",
];

/**
 * The predicate asks only for `{ request: { status, requesterHrId } }`, so the fixture needs no
 * cast and no invented pharmacy/geo/price payload. That narrow parameter is what lets the two pages
 * (holding a full DirectOrderApprovalDetail) and the service (holding getDirectOrderRequest's
 * `{ request, steps }`) call the same function — the first version demanded the full detail and did
 * not compile against the service at all.
 */
function detailWith(status: DirectOrderStatus, requesterHrId: string) {
  return { request: { requesterHrId, status } };
}

export function runDirectOrderCancelHeldTests() {
  // ── The rule itself, executed ────────────────────────────────────────────────────────────
  const held = detailWith("held", "HR-100");

  assert.equal(
    canCancelHeldDirectOrder({ hrId: "HR-100", role: "District Manager" }, held),
    true,
    "THE REQUESTER OF A HELD ORDER CANNOT CANCEL IT: that is the entire point of F3 — a duplicate must have an exit that is not the 14-day clock",
  );
  assert.equal(
    canCancelHeldDirectOrder({ hrId: "HR-999", role: "District Manager" }, held),
    false,
    "A NON-REQUESTER CAN CANCEL SOMEONE ELSE'S ORDER: cancelling must be narrower than viewing, or any create-holder can retire any held order in the company — the exact hole `reverse` shipped with (F5)",
  );
  assert.equal(
    canCancelHeldDirectOrder({ hrId: "HR-999", role: "Super Admin" }, held),
    true,
    "a Super Admin must be able to clean up on a requester's behalf",
  );

  // HR IDs are compared through canonicalHrIdKey, never raw. A stored id whose casing differs from
  // the session's would otherwise silently deny the requester their own order — the same casing
  // trap that broke marketing approvals, resignations and probation feedback.
  assert.equal(
    canCancelHeldDirectOrder({ hrId: "hr-100", role: "District Manager" }, detailWith("held", "HR-100")),
    true,
    "HR ID comparison must be canonical, not case-sensitive",
  );

  // ── Held-only: every other status must refuse ────────────────────────────────────────────
  for (const status of ALL_STATUSES.filter((s) => s !== "held")) {
    assert.equal(
      canCancelHeldDirectOrder({ hrId: "HR-100", role: "District Manager" }, detailWith(status, "HR-100")),
      false,
      `CANCEL IS OPEN ON "${status}": only a held order may be cancelled. Once an order is in the chain, withdrawing it is an approver's return/reject; once approved it is a reverse, because approved orders have already injected sales.`,
    );
    assert.equal(
      canCancelHeldDirectOrder({ hrId: "HR-1", role: "Super Admin" }, detailWith(status, "HR-100")),
      false,
      `even a Super Admin must not cancel a "${status}" order through this door`,
    );
  }

  assert.equal(canCancelHeldDirectOrder({ hrId: "HR-100", role: "Super Admin" }, null), false, "a missing request cannot be cancelled");
  assert.equal(
    canCancelHeldDirectOrder({ hrId: null, role: null }, held),
    false,
    "an anonymous viewer must never pass — a null hrId must not compare equal to a null requester",
  );

  // ── `cancelled` must be terminal ─────────────────────────────────────────────────────────
  assert.equal(
    isTerminalDirectOrderStatus("cancelled"),
    true,
    "cancelled must be terminal: nothing transitions out of a withdrawn request, and a non-terminal cancelled order would keep appearing in open-work counts",
  );

  // ── The service body ─────────────────────────────────────────────────────────────────────
  const service = readFileSync(new URL("../src/lib/direct-orders/service.ts", import.meta.url), "utf8");
  const start = service.indexOf("export async function cancelHeldDirectOrder");
  assert.ok(start > 0, "cancelHeldDirectOrder must exist");
  const nextExport = service.indexOf("\nexport ", start + 10);
  const block = service.slice(start, nextExport > 0 ? nextExport : undefined);

  assert.match(
    block,
    /const detail = await getDirectOrderRequest\(access, input\.requestId\);/,
    "CANCEL BYPASSES THE SCOPE GUARD: it must read through getDirectOrderRequest, which applies canViewDirectOrderRequest and returns null for out-of-scope as well as missing, so an id cannot be used to probe which requests exist",
  );
  assert.match(
    block,
    /canCancelHeldDirectOrder\(\{ hrId: access\.hrId, role: access\.role \}, detail\)/,
    "the service must call the SAME predicate the two pages call — a second copy of the rule is how the validation capture ended up visible to nobody who needed it",
  );
  assert.match(
    block,
    /assertDirectOrderWorkflowTransition\(\{[\s\S]{0,240}?actionKey: "cancel_held"/,
    "cancel must pass through the registry gate like every other declared action",
  );
  assert.match(
    block,
    /status: detail\.request\.status,/,
    "THE GATE IS BEING TOLD A CONSTANT: it must receive the row's REAL status, or the registry check only validates what the code already assumed and can never catch an anomaly (audit F6)",
  );
  assert.match(block, /if \(!reason\) badRequest\(/, "a reason is mandatory — the registry marks cancel_held requiresReason");

  // The write is guarded on `held` AND its empty result is treated as a failure. Without the second
  // half, a pharmacy validating at the same moment revives the order to pending_approval, the update
  // matches nothing, and the requester is told their duplicate was withdrawn while it actually sat
  // in an approver's queue.
  assert.match(block, /\.eq\("status", "held"\)/, "the status update must be guarded on held to close the revive/expire race");
  assert.match(
    block,
    /if \(!updated \|\| updated\.length === 0\) \{[\s\S]{0,200}?badRequest\(/,
    "A LOST RACE REPORTS SUCCESS: an update that matched no row means the order stopped being held mid-call, and that must be an error rather than a silent no-op",
  );

  // ── Reporting must not lie: cancelled is not rejected ────────────────────────────────────
  assert.doesNotMatch(
    block,
    /status: "rejected"/,
    "a withdrawn duplicate must never be written as `rejected` — that would inflate every rejection rate and per-rep counter that groups by status",
  );

  // ── Exhaustiveness: a future status cannot be added and silently rendered wrong ───────────
  const chipKeys = new Set(DIRECT_ORDER_REPORT_STATUS_OPTIONS.map((o) => o.key));
  for (const status of ALL_STATUSES) {
    assert.ok(
      chipKeys.has(status),
      `NO FILTER CHIP FOR "${status}": the report cannot be narrowed to a status it does not offer. \`held\` and \`expired\` had no chip for the whole life of the held lane, which is part of why 11 held orders worth 509,736 EGP went unnoticed.`,
    );
  }

  // The status→colour maps are Record<string, string>, so adding a status compiles clean and renders
  // with no styling. TypeScript will not catch it; this sweep is what does.
  const toneFiles = [
    "../src/components/approvals-hub/direct-order-approvals-body.tsx",
    "../src/components/direct-orders/direct-order-report-workspace.tsx",
    "../src/components/direct-orders/direct-order-submit-form.tsx",
    "../src/components/employee-portal/direct-order-portal-approvals.tsx",
    "../src/components/employee-portal/direct-order-portal-report.tsx",
    "../src/components/employee-portal/direct-order-portal-submit.tsx",
  ];
  for (const file of toneFiles) {
    const text = readFileSync(new URL(file, import.meta.url), "utf8");
    for (const status of ALL_STATUSES) {
      assert.match(
        text,
        new RegExp(`^\\s*${status}:\\s*"`, "m"),
        `"${status}" HAS NO COLOUR IN ${file}: these maps are typed Record<string, string>, so a missing status is not a type error — it renders as an unstyled pill and nobody finds out until a user reports it`,
      );
    }
  }

  // ── The migration must not repeat the outage ─────────────────────────────────────────────
  const migration = readFileSync(
    new URL("../supabase/migrations/20260805150000_direct_orders_cancel_held.sql", import.meta.url),
    "utf8",
  );
  assert.match(migration, /'cancelled'::text/, "the check constraint must permit the new status, or every cancel dies on a constraint violation");
  assert.match(migration, /'key', 'cancelled'/, "the registry must DECLARE the status");
  assert.match(migration, /'key', 'cancel_held'/, "the registry must declare the action");
  // normalizeActions() calls normalizeRequiredText on auditLog and label, and parseRoleStrict on
  // every allowedRole. Any one of them missing throws in the LOADER, which skips the whole module —
  // and a skipped direct_orders module reports as "module is missing or inactive" on EVERY
  // transition, including plain submit. That is the 2026-08-05 outage, exactly.
  for (const field of ["'auditLog'", "'label'", "'allowedRoles'", "'from'", "'to'"]) {
    assert.ok(
      migration.includes(field),
      `THE MIGRATION OMITS ${field}: the registry loader requires it, throws without it, and skips the entire direct_orders module — which stops reps from raising ANY direct order, not just cancelling one`,
    );
  }
  assert.match(
    migration,
    /raise exception 'direct_orders registry would be SKIPPED by the loader/,
    "the migration must simulate the loader and roll back rather than commit a module that will be skipped at runtime",
  );
  assert.ok(
    migration.indexOf("begin;") < migration.indexOf("alter table") &&
      migration.includes("commit;"),
    "both halves must be in ONE transaction: declaring the action without the status reproduces the outage",
  );
}
