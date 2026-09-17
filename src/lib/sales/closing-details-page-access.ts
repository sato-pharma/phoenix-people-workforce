import type { PhoenixRole } from "@/lib/auth/permissions";

// Who may open /admin/analytics/monthly-closing/details — the export-only Monthly Closing page.
//
// It is the one page the Sales Analytics module left behind. The owner retired that module on
// 2026-09-17 ("drop and retire the sales analytics module"); this page stayed at its address because
// it is the Finance Manager's Monthly Closing row, and ruling 11 already said the module and that
// role's export "were never the same thing" (see the row's note in system-navigation.ts). The role
// set is the module's former admin core tier, unchanged, so nobody gained or lost this page.
//
// The Finance Manager is the reason it exists (owner, 2026-08-10/11): it renders the Export XLSX
// button without the upload/publish workspace, which needs sales:import — the one action he must
// never hold. He holds sales:read + sales:export and a COMPANY sales scope, so the page answers with
// real company-wide rows. The rows themselves are scoped per caller by
// /api/sales/monthly-closing/details; this set only gates entry.
const CLOSING_DETAILS_PAGE_ROLES: ReadonlySet<PhoenixRole> = new Set<PhoenixRole>([
  "Super Admin",
  "CEO",
  "SFE Manager",
  "Finance Manager",
]);

export function canOpenClosingDetailsPage(role: PhoenixRole): boolean {
  return CLOSING_DETAILS_PAGE_ROLES.has(role);
}
