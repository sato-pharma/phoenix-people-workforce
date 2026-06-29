import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

function source(path: string) {
  return readFileSync(new URL(path, import.meta.url), "utf8");
}

/**
 * Approvals Hub completion guard (executive correctness):
 *
 *  #1 — Inline deep-link render now covers leave / weekly_plan / resignation (not excuse only),
 *       and the PORTAL hub page resolves deep links the same way the admin hub page does.
 *  #2 — Every workflow decision write-path funnels its actor token through the single shared
 *       resolveCanonicalActorHrId() before persisting, so a login token (e.g. "admin-HR") can
 *       never land in a decision column. Contract-renewal is the one that was still leaking.
 *  #3 — The "Approval history" tab spans the admin/system modules a person actually decided:
 *       salary batches, sales imports, marketing steps, payroll expenses.
 *
 * These are source-level invariants — they pin the wiring so a future refactor cannot silently
 * regress attribution or drop a module.
 */
export function runApprovalsHubCompletionTests() {
  const canonical = source("../src/lib/auth/canonical-actor.ts");
  const contracts = source("../src/lib/contracts/service.ts");
  const resignations = source("../src/lib/resignations/service.ts");
  const actionCenter = source("../src/lib/action-center/service.ts");
  const types = source("../src/components/action-center/types.ts");
  const portalPage = source("../app/employee-portals/approvals-hub/page.tsx");

  // ── #2: single source of truth for actor → canonical HR_ID ──────────────────
  assert.match(
    canonical,
    /export async function resolveCanonicalActorHrId/,
    "canonical-actor.ts must export the shared resolveCanonicalActorHrId",
  );
  assert.match(
    canonical,
    /app_auth_users[\s\S]*login_id/,
    "the resolver must map login_id → hr_id via app_auth_users (so admin-HR → PHX-1)",
  );

  // Contract renewal must resolve the actor before calling the RPC, and pass the RESOLVED
  // value (never the raw `actor`) as p_actor.
  assert.match(
    contracts,
    /resolveCanonicalActorHrId/,
    "contracts/service.ts must resolve the actor to a canonical HR_ID before persisting",
  );
  assert.match(
    contracts,
    /p_actor:\s*actorHrId/,
    "the contract-renewal RPC must receive the resolved actorHrId, not the raw login token",
  );
  assert.doesNotMatch(
    contracts,
    /p_actor:\s*actor\b/,
    "contracts/service.ts must not pass the raw actor token to the RPC",
  );

  // Resignations must reuse the shared resolver, not re-declare its own copy.
  assert.match(
    resignations,
    /import \{ resolveCanonicalActorHrId \} from "@\/lib\/auth\/canonical-actor"/,
    "resignations/service.ts must import the shared resolver",
  );
  assert.doesNotMatch(
    resignations,
    /async function resolveCanonicalActorHrId/,
    "resignations/service.ts must not re-declare a local resolveCanonicalActorHrId",
  );

  // ── #1: inline deep-link render for all four hub modules ────────────────────
  for (const moduleKey of ['"excuse"', '"resignation"', '"leave"', '"weekly_plan"']) {
    assert.match(
      actionCenter,
      new RegExp(`module === ${moduleKey}`),
      `getActionCenterDeepLinkItem must resolve the ${moduleKey} module inline`,
    );
  }
  assert.match(
    portalPage,
    /getActionCenterDeepLinkItem/,
    "the portal approvals-hub page must resolve deep-link items inline (parity with admin)",
  );

  // ── #3: history spans the admin/system decision modules ─────────────────────
  for (const table of [
    "salary_batches",
    "sales_import_batches",
    "marketing_request_approval_steps",
    "payroll_expenses",
  ]) {
    assert.match(
      actionCenter,
      new RegExp(`from\\("${table}"\\)`),
      `getMyApprovalHistory must query ${table} for the caller's own decisions`,
    );
  }
  for (const mod of ["salary", "sales_import", "marketing_request", "payroll_expense"]) {
    assert.match(
      types,
      new RegExp(`"${mod}"`),
      `HistoryApprovalModule must include the ${mod} module`,
    );
  }
  assert.match(
    types,
    /HISTORY_MODULE_LABELS/,
    "types.ts must export HISTORY_MODULE_LABELS covering the wider history module set",
  );
}
