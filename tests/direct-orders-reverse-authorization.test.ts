import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// ─────────────────────────────────────────────────────────────────────────────
// Reversing an approved direct order (audit C6.2, findings F4 and F5).
//
// Reverse retires an order's Source-of-Sales injection — it removes booked sales. It was also the
// ONE declared registry action with no registry gate, and the only mutation that read its target
// through a raw service-role query instead of the module's read choke point.
//
// Together those two gaps meant: any holder of `direct_orders:create` — which includes Medical Rep
// and Financial Advisor, neither of whom the registry lists for `reverse` — could reverse ANY
// approved direct order in the company given its id. No requester check, no chain membership, no
// area. Nothing failed; the reversal simply appeared in senior approvers' queues looking legitimate.
//
// Source-inspection rather than execution: the path is Supabase-bound end to end, so the honest
// guard is to pin the two lines that closed it.
// ─────────────────────────────────────────────────────────────────────────────

export function runDirectOrderReverseAuthorizationTests() {
  const source = readFileSync(new URL("../src/lib/direct-orders/service.ts", import.meta.url), "utf8");
  const start = source.indexOf("export async function reverseDirectOrder");
  assert.ok(start > 0, "reverseDirectOrder must exist");
  // Bound the slice at the next export so these assertions cannot accidentally be satisfied by a
  // different function further down the file.
  const nextExport = source.indexOf("\nexport ", start + 10);
  const block = source.slice(start, nextExport > 0 ? nextExport : undefined);

  // ── THE HEADLINE: the scope guard must not be bypassed ──────────────────────────────────
  assert.match(
    block,
    /const found = await getDirectOrderRequest\(access, input\.requestId\);/,
    "REVERSE BYPASSES THE SCOPE GUARD: it must read through getDirectOrderRequest, which applies canViewDirectOrderRequest. A raw admin query lets any create-holder reverse any approved order in the company by id.",
  );
  assert.doesNotMatch(
    block,
    /from\("direct_order_requests"\)\s*\.select\("\*"\)\s*\.eq\("id", input\.requestId\)/,
    "reverse must not re-introduce a raw service-role read of its target — that is exactly how it escaped the scope guard",
  );

  // ── The registry must gate it, like every other declared action ──────────────────────────
  assert.match(
    block,
    /assertDirectOrderWorkflowTransition\(\{[\s\S]{0,220}?actionKey: "reverse"/,
    "REVERSE IS UNGATED: without the registry call its allowed roles are whatever direct_orders:create grants — including Medical Rep and Financial Advisor, which the registry does not list for this action",
  );
  assert.match(
    block,
    /status: original\.status,/,
    "the gate must be given the row's REAL status, not a literal — a constant can never detect a status anomaly (audit finding F6)",
  );

  // ── Preconditions that must survive any refactor ─────────────────────────────────────────
  assert.match(block, /if \(!reason\) badRequest\(/, "a reason is mandatory — the registry marks reverse requiresReason");
  assert.match(
    block,
    /if \(original\.status !== "approved"\)/,
    "only an approved order may be reversed",
  );
  assert.match(
    block,
    /if \(original\.reversedByRequestId\)/,
    "a second reversal must be refused while one is already in progress",
  );

  // ── The guard it now depends on must still be the real one ───────────────────────────────
  assert.match(
    source,
    /async function canViewDirectOrderRequest\(/,
    "canViewDirectOrderRequest must exist — it is the rule reverse now inherits",
  );
  assert.match(
    source,
    /if \(!\(await canViewDirectOrderRequest\(access, request, steps\)\)\) return null;/,
    "getDirectOrderRequest must still apply the scope guard; if that is ever removed, reverse silently loses its protection again",
  );
}
