import Link from "next/link";
import { redirect } from "next/navigation";
import { ArrowRight, Database } from "lucide-react";

import { AdminPageHero } from "@/components/admin/admin-design-system";
import { crmPageItems } from "@/config/system-navigation";
import { buildPermissionLookup, canAccess, getPermissionMatrix, resolveNavigationMode } from "@/lib/auth/permissions";
import { guardSeatPage } from "@/lib/auth/seat-page-guard";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { canUseAdminCrmWorkspace } from "@/lib/crm/admin-access";
import { navigationItemVisible } from "@/lib/navigation/active-path";

export const dynamic = "force-dynamic";

/**
 * The CRM hub: the workspace, the integrity checks, double-visit analytics and Field Workforce
 * Compliance behind one sidebar button.
 *
 * The gate is deliberately the UNION of what its cards need, not the intersection — Field
 * Workforce Compliance is gated on hr_calendar and double-visit analytics on
 * double_visit_analytics, so requiring the CRM workspace grant alone would hide the hub from
 * roles that hold one of the other two.
 */
export default async function CrmToolsPage() {
  const access = await resolveAccessContextFromPage();
  guardSeatPage(access, "/admin/crm-tools");
  if (resolveNavigationMode(access) === "employee-portal") redirect("/employee-portals");

  if (
    !(
      canUseAdminCrmWorkspace(access) ||
      (await canAccess(access, "crm_visits", "read")) ||
      (await canAccess(access, "double_visit_analytics", "read")) ||
      (await canAccess(access, "hr_calendar", "read"))
    )
  ) {
    redirect("/employee-portals");
  }

  const matrix = await getPermissionMatrix();
  const permissionLookup = buildPermissionLookup(matrix, access.role);

  const visibleTools = crmPageItems.filter((item) =>
    navigationItemVisible(item, permissionLookup, access.role),
  );

  return (
    <div className="space-y-6">
      <AdminPageHero
        description="Visits, GPS check-ins, contacts, data integrity, double-visit intelligence and field workforce compliance — in one place."
        eyebrow="Field Operations"
        icon={<Database className="h-3.5 w-3.5" />}
        title="CRM"
      />

      {visibleTools.length === 0 ? (
        <div className="border border-slate-200 bg-white p-8 text-center text-sm text-slate-500">
          No CRM tools are available for your role.
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {visibleTools.map((tool) => {
            const Icon = tool.icon;
            return (
              <Link
                className="group relative flex flex-col overflow-hidden border border-slate-200 bg-white p-5 shadow-[0_4px_16px_rgba(15,23,42,0.07)] transition duration-200 hover:-translate-y-1 hover:border-orange-300/70 hover:shadow-[0_16px_38px_rgba(15,23,42,0.13)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500 focus-visible:ring-offset-2"
                href={tool.href}
                key={tool.href}
              >
                <span
                  aria-hidden="true"
                  className="absolute inset-x-0 top-0 h-1 bg-gradient-to-r from-orange-500 via-orange-400 to-amber-300 opacity-70 transition-opacity duration-200 group-hover:opacity-100"
                />
                <div className="flex items-start gap-3">
                  <span className="flex h-11 w-11 shrink-0 items-center justify-center bg-gradient-to-br from-orange-100 to-orange-50 text-orange-700 ring-1 ring-orange-200/70">
                    <Icon aria-hidden="true" className="h-5 w-5" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <h3 className="text-sm font-bold tracking-[-0.01em] text-slate-950">{tool.label}</h3>
                    <p className="mt-1.5 text-xs leading-5 text-slate-500">{tool.description}</p>
                  </div>
                </div>
                <div className="mt-4 inline-flex items-center gap-1 text-xs font-bold text-orange-700">
                  Open
                  <ArrowRight aria-hidden="true" className="h-3.5 w-3.5 transition-transform duration-200 group-hover:translate-x-0.5" />
                </div>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
