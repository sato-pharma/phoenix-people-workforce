import assert from "node:assert/strict";

import { createAccessContext } from "../src/lib/auth/permissions.ts";
import { buildBulkImportPreview, generateBulkUploadTemplate } from "../src/lib/marketing-requests/bulk-import.ts";
import { getMarketingRequestDirectTracking } from "../src/lib/marketing-requests/direct-tracking.ts";

// Denial-path guards for three marketing endpoints that were reachable by callers who should
// never have reached them. Every assertion below exercises the REAL service function; each gate
// throws before any Supabase call, so these run without a database.
//
// Why these three:
//   * buildBulkImportPreview took no AccessContext at all — the route's only check was "not a
//     guest", so any authenticated user of ANY role could POST a crafted sheet and read back live
//     marketing master data resolved per row, including product factoryPrice.
//   * generateBulkUploadTemplate was likewise gated only on "not a guest", while its page is
//     Super-Admin-only.
//   * getMarketingRequestDirectTracking used `access` solely for a cosmetic canManage flag, and
//     resolveAccessContext() returns a guest context rather than throwing — so an UNAUTHENTICATED
//     caller got a real answer for a real request id and a distinguishable 404 for a fake one.

/** Roles that are definitively not system administrators. */
const NON_SUPER_ADMIN_ROLES = [
  "Employee",
  "Medical Rep",
  "District Manager",
  "Regional Manager",
  "National Sales Manager",
  "Product Manager",
  "Marketing Manager",
  "Finance Manager",
  "Training Manager",
  "Talent Acquisition",
  "Manager",
] as const;

/** Roles in neither marketingCreatorRoles nor companyMarketingRoles. "Employee" is what a guest
 *  (unauthenticated) context carries, so it stands in for the anonymous caller. */
const NON_MARKETING_ROLES = ["Employee", "Training Manager", "Talent Acquisition", "Manager"] as const;

const SOME_REQUEST_ID = "00000000-0000-0000-0000-000000000001";

async function testBulkImportPreviewRequiresSuperAdmin() {
  for (const role of NON_SUPER_ADMIN_ROLES) {
    const access = createAccessContext({ hrId: "TEST-1", role });
    await assert.rejects(
      () => buildBulkImportPreview([], access),
      /Forbidden|Super Admin/i,
      `${role} must not be able to preview a bulk marketing import`,
    );
  }
}

async function testBulkUploadTemplateRequiresSuperAdmin() {
  for (const role of NON_SUPER_ADMIN_ROLES) {
    const access = createAccessContext({ hrId: "TEST-1", role });
    await assert.rejects(
      () => generateBulkUploadTemplate(access),
      /Forbidden|Super Admin/i,
      `${role} must not be able to download the bulk upload template`,
    );
  }
}

async function testDirectTrackingReadRequiresMarketingAccess() {
  for (const role of NON_MARKETING_ROLES) {
    const access = createAccessContext({ hrId: "TEST-1", role });
    await assert.rejects(
      () => getMarketingRequestDirectTracking(access, SOME_REQUEST_ID),
      /Forbidden/i,
      `${role} must not be able to read a campaign's direct-tracking state`,
    );
  }
}

export async function runMarketingAccessGatesTests() {
  await testBulkImportPreviewRequiresSuperAdmin();
  await testBulkUploadTemplateRequiresSuperAdmin();
  await testDirectTrackingReadRequiresMarketingAccess();
}
