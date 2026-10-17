import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// ─────────────────────────────────────────────────────────────────────────────
// The CRM org tree cache — src/lib/crm/org-placement-data.ts and
// src/lib/phoenix-crm/server/org.ts both cache au_v_org_tree under the "sos-reference" tag with a
// 300s TTL. Every write path that moves a seat (a hire/edit through employee-directory.ts, a
// resignation or declined offer, a probation/contract workflow, a seat transfer) already called
// invalidateExecutiveDashboardCache with one of "employees" / "vacancies" / "resignations" in its
// modules — but the function had no branch reacting to any of those, so the tag was never busted and
// the org tree only ever self-healed after its TTL. A hire or a seat move was invisible to the CRM
// sync panel's scope resolution for up to five minutes.
//
// Two fixes, pinned below:
//   1. invalidateExecutiveDashboardCache now busts "sos-reference" for the organogram-affecting
//      modules — this alone covers every write path that already called it.
//   2. transferEmployeeSeat (src/lib/employees/seat-transfer.ts) had NO invalidation call at all —
//      it now calls invalidateExecutiveDashboardCache after the RPC succeeds.
//
// The harness cannot run Next.js (next/cache is stubbed to no-ops in tests/stubs/next-cache.ts, so a
// revalidateTag call cannot be observed by spying), so this locks the SOURCE SHAPE, the same
// weaker-but-honest instrument tests/crm-brick-centroids-cache.test.ts uses for the same reason.
// ─────────────────────────────────────────────────────────────────────────────

const INVALIDATION = "../src/lib/dashboard/invalidation.ts";
const SEAT_TRANSFER = "../src/lib/employees/seat-transfer.ts";
const ORG_PLACEMENT_DATA = "../src/lib/crm/org-placement-data.ts";
const PHOENIX_CRM_ORG = "../src/lib/phoenix-crm/server/org.ts";

export function runOrgTreeCacheInvalidationTests() {
  const invalidation = readFileSync(new URL(INVALIDATION, import.meta.url), "utf8");
  const seatTransfer = readFileSync(new URL(SEAT_TRANSFER, import.meta.url), "utf8");
  const orgPlacementData = readFileSync(new URL(ORG_PLACEMENT_DATA, import.meta.url), "utf8");
  const phoenixCrmOrg = readFileSync(new URL(PHOENIX_CRM_ORG, import.meta.url), "utf8");

  // ── The org tree reads still share "sos-reference" — the tag the fix below must bust ─────────
  // If either read ever moves to its own tag, ORG_TREE_MODULES busting "sos-reference" alone would
  // silently stop covering it.
  {
    assert.match(
      orgPlacementData,
      /tags:\s*\[\s*"sos-reference"\s*\]/,
      "org-placement-data's org tree read must still be tagged sos-reference",
    );
    assert.match(
      phoenixCrmOrg,
      /tags:\s*\[\s*"sos-reference"\s*\]/,
      "phoenix-crm/server/org's org tree read must still be tagged sos-reference",
    );
  }

  // ── invalidateExecutiveDashboardCache reacts to the organogram-affecting modules ────────────
  {
    assert.match(
      invalidation,
      /ORG_TREE_MODULES[\s\S]{0,40}=\s*\[\s*"employees"\s*,\s*"vacancies"\s*,\s*"resignations"\s*\]/,
      "the org-tree module list must cover employees, vacancies and resignations — the three modules every seat-affecting write path already passes",
    );

    const fnStart = invalidation.indexOf("export function invalidateExecutiveDashboardCache(");
    const fnEnd = invalidation.indexOf("\n}\n", fnStart);
    assert.ok(fnStart > -1 && fnEnd > fnStart, "invalidateExecutiveDashboardCache must exist as a single contiguous function");
    const fnBody = invalidation.slice(fnStart, fnEnd);

    assert.match(
      fnBody,
      /uniqueModules\.some\(\(module\)\s*=>\s*ORG_TREE_MODULES\.includes\(module\)\)/,
      "the function body must branch on whether any passed module is organogram-affecting",
    );
    assert.match(
      fnBody,
      /revalidateTag\(\s*"sos-reference"\s*,\s*"max"\s*\)/,
      "the organogram branch must bust the sos-reference tag the org tree reads share",
    );

    // The whole function stays wrapped in the existing try/catch — revalidateTag throws outside a
    // request scope (a cron), and this is best-effort exactly like every other branch here.
    const tryIdx = invalidation.indexOf("try {", fnStart);
    const catchIdx = invalidation.indexOf("} catch (error) {", fnStart);
    const orgBranchIdx = fnBody.indexOf("ORG_TREE_MODULES.includes(module)");
    assert.ok(
      tryIdx > -1 && catchIdx > tryIdx && tryIdx < fnStart + orgBranchIdx && fnStart + orgBranchIdx < catchIdx,
      "the new branch must sit inside the function's existing try/catch, not bypass it",
    );
  }

  // ── transferEmployeeSeat now invalidates — the one write path that called nothing at all ──────
  {
    assert.match(
      seatTransfer,
      /import\s*\{\s*invalidateExecutiveDashboardCache\s*\}\s*from\s*"@\/lib\/dashboard\/invalidation"/,
      "seat-transfer.ts must import the shared invalidation hub",
    );

    const fnStart = seatTransfer.indexOf("export async function transferEmployeeSeat(");
    assert.ok(fnStart > -1, "transferEmployeeSeat must exist");
    const fnBody = seatTransfer.slice(fnStart);

    const rpcIdx = fnBody.indexOf('client.rpc("phx_transfer_au_seat"');
    const invalidateIdx = fnBody.indexOf("invalidateExecutiveDashboardCache(");
    const returnIdx = fnBody.indexOf("return data as SeatTransferResult;");
    assert.ok(
      rpcIdx > -1 && invalidateIdx > rpcIdx && returnIdx > invalidateIdx,
      "the invalidation call must run after the RPC succeeds and before the result is returned — never before the seat has actually moved",
    );
    assert.match(
      fnBody.slice(invalidateIdx, invalidateIdx + 120),
      /invalidateExecutiveDashboardCache\(\s*"[^"]+"\s*,\s*\[\s*"employees"\s*,\s*"vacancies"\s*\]\s*\)/,
      "the seat transfer must invalidate with the employees/vacancies modules so the shared org-tree branch fires",
    );
  }

  // ── The hub imports no tag, because every cache-busting write imports the hub (2026-10-17) ───────
  // It took two tags from closing-store-split-net.ts and company-vacation-report.ts until then, and
  // each import dragged its module's whole service graph into every route that busts a cache — a
  // dev server compiled the closing engine for a vacation write. The tags are declared here now and
  // the two modules re-export them.
  {
    const imports = invalidation.match(/^import[^;]*;/gm) ?? [];
    assert.ok(imports.length > 0, "the hub's import lines must be readable for this check to mean anything");
    for (const line of imports) {
      assert.doesNotMatch(
        line,
        /from\s+"@\/lib\/(?:sales|vacation)\//,
        `the invalidation hub must import nothing from a module's services — it is imported everywhere (${line})`,
      );
    }
    assert.match(invalidation, /export const CLOSING_STORE_SPLIT_CACHE_TAG = "closing-store-split";/);
    assert.match(invalidation, /export const COMPANY_VACATION_REPORT_CACHE_TAG = "company-vacation-report";/);
  }
}
