import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// ─────────────────────────────────────────────────────────────────────────────
// Every Direct Orders page refuses the same way, in both shells.
//
// FOUND BY THE PHASE E ROLE SWEEP, 2026-08-11. Six of the eight direct-order
// pages had no page-level permission check. A role holding no `direct_orders`
// grant — Employee, Medical Rep, Training Manager, Marketing Manager, Talent
// Acquisition, Manager — reached the portal workspace and was served **HTTP 200
// carrying an error boundary**, whose visible text was
// `Forbidden: Medical Rep cannot read direct_orders`.
//
// WHAT THIS TEST IS NOT. It is not the security boundary. The services are, and
// they held: the sweep confirmed those responses carried zero workspace markers,
// zero DOP- order codes and leaked nothing, because `assertPermission` inside
// `getDirectOrderWorkspaceData` refused before any read. This test protects the
// SHAPE of the refusal — a user must not be shown an internal error string, at a
// 200, on a page they should never have landed on.
//
// It also protects against the fix rotting into six copies. The admin workspace
// carried this check inline; pasting it into the other seven would have rebuilt
// in miniature the duplication the 2026-08-10 consolidation removed, and a gate
// living in eight places is a gate that will eventually disagree with itself.
// ─────────────────────────────────────────────────────────────────────────────

/** Every route that renders Direct Orders data, in both shells. */
const PAGES = [
  ["admin workspace", "../app/(admin)/admin/direct-orders/page.tsx"],
  ["admin new order", "../app/(admin)/admin/direct-orders/new/page.tsx"],
  ["admin report", "../app/(admin)/admin/direct-orders/(desks)/report/page.tsx"],
  ["admin order detail", "../app/(admin)/admin/direct-orders/[id]/page.tsx"],
  ["portal workspace", "../app/employee-portals/direct-orders/page.tsx"],
  ["portal new order", "../app/employee-portals/direct-orders/new/page.tsx"],
  ["portal report", "../app/employee-portals/direct-orders/report/page.tsx"],
  ["portal order detail", "../app/employee-portals/direct-orders/[id]/page.tsx"],
] as const;

function read(rel: string) {
  return readFileSync(new URL(rel, import.meta.url), "utf8");
}

export function runDirectOrderPageAccessTests() {
  for (const [label, path] of PAGES) {
    const source = read(path);

    assert.match(
      source,
      /import \{ assertDirectOrdersPageAccess \} from "@\/lib\/direct-orders\/page-access";/,
      `${label} does not import the shared gate — the portal workspace shipped without one and served a raw "Forbidden: … cannot read direct_orders" to every role with no grant`,
    );
    assert.match(
      source,
      /await assertDirectOrdersPageAccess\(access\);/,
      `${label} imports the gate but never calls it`,
    );

    // The gate must run BEFORE any direct-order data is loaded. A check that
    // happens after the service call refuses nothing — the throw already
    // happened, which is exactly the failure this replaces.
    const gateAt = source.indexOf("await assertDirectOrdersPageAccess(access)");
    for (const loader of [
      "loadDirectOrderWorkspaceView",
      "getDirectOrderApprovalDetail",
      "getDirectOrderReport",
      "listMyDirectOrders",
      "listDirectOrderProductOptions",
    ]) {
      const callAt = source.indexOf(`await ${loader}(`);
      if (callAt === -1) continue;
      assert.ok(
        gateAt < callAt,
        `${label} calls ${loader} BEFORE the gate — the service throws first and the user gets the internal error this gate exists to replace`,
      );
    }
  }

  // ── The gate itself ────────────────────────────────────────────────────────
  const helper = read("../src/lib/direct-orders/page-access.ts");
  assert.match(
    helper,
    /canAccess\(access, "direct_orders", "read"\)/,
    "the gate must ask the permission matrix, not a role list — a hand-written list of allowed roles is a second copy of the matrix and will drift from it",
  );
  assert.match(
    helper,
    /resolveLandingPathForRole\(access\.role\)/,
    "refusal must send the caller to THEIR OWN landing page: a Medical Rep bounced to a fixed shell root is only redirected again",
  );

  // One definition, not eight. If a page grows its own inline canAccess for
  // direct_orders again, the gate has started to fork.
  for (const [label, path] of PAGES) {
    assert.doesNotMatch(
      read(path),
      /canAccess\(access, "direct_orders", "read"\)/,
      `${label} has grown its own inline direct_orders:read check — use the shared gate, or the eight pages will drift apart exactly as the four component twins did`,
    );
  }
}
