import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

function source(relPath: string): string {
  return readFileSync(relPath, "utf8");
}

/**
 * The full customer validation dossier reached from the "already validated" badge on the marketing
 * approver window (owner ask, 2026-09-22: an arrow to "the venue's full validation data — photos,
 * address, codes, everything"). Scope: "every approver in the chain" — but ONLY the one currently
 * holding the request.
 *
 * The whole risk of this feature is its authorization, and it is a real one: the dossier returns a
 * shop-front photo, an address, a contact mobile and the distributor codes for a customer anywhere
 * in the company. So this pins, at the source, the two ways it could go wrong and neither is caught
 * by typecheck:
 *
 *   • OVER-GRANT — reading by customer id, or with no per-request gate, would let any approver
 *     enumerate the register. The route is keyed by REQUEST id and the service authorizes through
 *     getMarketingRequestDecisionSummary, the exact gate that already guards the approver window.
 *
 *   • UNDER-GRANT — inheriting the register gate (assertValidatedCustomerRegisterAccess, Super
 *     Admin / SFE only) would refuse a legitimate approver such as a Product Manager or the CEO.
 *     The approver path must NOT use that gate.
 *
 * Follows the sibling marketing-approver-customer-history test, which pins the same "composes the
 * authorized summary rather than re-implementing the check" invariant by source. Break the gate
 * (delete the getMarketingRequestDecisionSummary call, or swap the route to a customer-id key) and
 * the matching assertion here fails.
 */
export function runMarketingApproverCustomerDossierTests() {
  const transfer = source("src/lib/marketing-requests/validated-customer-transfer.ts");

  // ── The approver dossier function, sliced from its own body ────────────────────────────────
  const fnStart = transfer.indexOf("export async function getValidatedMarketingCustomerDetailForApprover");
  assert.ok(fnStart >= 0, "the approver dossier service function must exist");
  // Its body ends where the next top-level declaration begins.
  const afterStart = transfer.indexOf("async function resolveApproverRequestCustomerId", fnStart);
  assert.ok(afterStart > fnStart, "the approver dossier function must be followed by its customer-id resolver");
  const fnBody = transfer.slice(fnStart, afterStart);

  assert.match(
    fnBody,
    /getMarketingRequestDecisionSummary\(requestId, "approve", access\)/,
    "the approver dossier authorizes through the request-holder gate, not a new check",
  );
  assert.match(
    fnBody,
    /assembleValidatedMarketingCustomerDetail\(customerId, false\)/,
    "the approver dossier is READ-ONLY: it must pass viewerCanTransfer=false, never derive it from role",
  );
  assert.doesNotMatch(
    fnBody,
    /assertValidatedCustomerRegisterAccess/,
    "the approver path must NOT inherit the Super-Admin/SFE register gate — that would refuse a legitimate approver",
  );

  // ── The register detail still gates, and both paths now share one assembler ─────────────────
  assert.match(
    transfer,
    /assertValidatedCustomerRegisterAccess\(access\);\s*\n\s*return assembleValidatedMarketingCustomerDetail\(customerId, canTransferValidatedCustomers\(access\)\);/,
    "the register detail keeps its Super-Admin/SFE gate and delegates to the shared assembler",
  );
  assert.match(
    transfer,
    /async function assembleValidatedMarketingCustomerDetail\(\s*customerId: string,\s*viewerCanTransfer: boolean,/,
    "the shared assembler takes viewerCanTransfer as an argument rather than deriving it from access",
  );

  // ── The API route delegates to the approver service, keyed by request id ────────────────────
  const route = source("app/api/marketing-requests/[id]/customer-dossier/route.ts");
  assert.match(
    route,
    /getValidatedMarketingCustomerDetailForApprover\(access, id\)/,
    "the dossier route delegates to the request-gated service",
  );
  assert.doesNotMatch(
    route,
    /getValidatedMarketingCustomerDetail\(/,
    "the route must NOT call the register (customer-id) reader — that would bypass the request gate",
  );

  // ── Both page shells reuse the inbox guard and the request-keyed endpoint ───────────────────
  const adminPage = source("app/(admin)/admin/marketing-requests/customer-dossier/[requestId]/page.tsx");
  assert.match(
    adminPage,
    /assertMarketingAdminPageAccess\(\{ approvalInbox: true \}\)/,
    "the admin dossier page reuses the marketing approval-inbox guard",
  );
  assert.match(
    adminPage,
    /\/api\/marketing-requests\/\$\{requestId\}\/customer-dossier/,
    "the admin dossier page fetches the request-keyed endpoint",
  );

  const portalPage = source("app/employee-portals/marketing-requests/customer-dossier/[requestId]/page.tsx");
  assert.match(
    portalPage,
    /assertEmployeePortalMarketingPageAccess\("inbox"\)/,
    "the portal dossier page reuses the portal marketing-inbox guard",
  );
  assert.match(
    portalPage,
    /\/api\/marketing-requests\/\$\{requestId\}\/customer-dossier/,
    "the portal dossier page fetches the request-keyed endpoint",
  );

  // ── The badge arrow now jumps to the standalone dossier page, in the right shell ────────────
  const panel = source("src/components/marketing-requests/marketing-request-approver-detail.tsx");
  assert.match(
    panel,
    /customer-dossier\/\$\{encodeURIComponent\(requestId\)\}/,
    "the marketing badge builds the dossier URL keyed by request id",
  );
  assert.match(
    panel,
    /href=\{customerDossierHref\}/,
    "the marketing badge arrow points at the dossier page, not the old in-page anchor",
  );
}
