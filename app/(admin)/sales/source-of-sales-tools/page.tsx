import Link from "next/link";
import { redirect } from "next/navigation";
import { ArrowRight, ChartNoAxesColumnIncreasing } from "lucide-react";

import { AdminPageHero } from "@/components/admin/admin-design-system";
import { sourceOfSalesPageItems } from "@/config/system-navigation";
import { canAccess, getPermissionMatrix, permissionActions, permissionResources, resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { permissionAllowed, roleAllowed, roleNotExcluded, type PermissionLookup } from "@/lib/navigation/active-path";

export const dynamic = "force-dynamic";

const SOURCE_OF_SALES_EXCLUDED_ROLES = ["Marketing Manager"] as const;

export default async function SourceOfSalesToolsPage() {
  const access = await resolveAccessContextFromPage();
  if (resolveNavigationMode(access) === "employee-portal") redirect("/employee-portals");
  // Mirrors the sidebar button's gate (excludedRoles: ["Marketing Manager"]).
  // Marketing Manager has sales:read but is excluded from every card and lacks
  // sales:import, so its hub is genuinely empty — redirect it. CEO is NOT
  // excluded: it can open the Source of Sales Dash card, so it sees a one-card
  // hub (listing CEO here previously bounced it to the employee portal).
  if (
    !(await canAccess(access, "sales", "read")) ||
    (SOURCE_OF_SALES_EXCLUDED_ROLES as readonly string[]).includes(access.role)
  ) {
    redirect("/employee-portals");
  }

  const matrix = await getPermissionMatrix();
  const permissionLookup: PermissionLookup = {};
  for (const resource of permissionResources) {
    for (const action of permissionActions) {
      const key = `${resource}:${action}` as const;
      permissionLookup[key] = matrix[access.role]?.[resource]?.includes(action) ?? false;
    }
  }
  const isSystemAdministratorWorkspace = access.scope === "system" || access.role === "Super Admin";

  const visibleTools = isSystemAdministratorWorkspace
    ? sourceOfSalesPageItems
    : sourceOfSalesPageItems.filter(
        (item) =>
          permissionAllowed(permissionLookup, item.permissions) &&
          roleAllowed(access.role, item.roles) &&
          roleNotExcluded(access.role, item.excludedRoles),
      );

  return (
    <div className="space-y-6">
      <AdminPageHero
        description="Dashboards, data entry, upload, and diagnostics for the Source of Sales pipeline."
        eyebrow="Sales"
        icon={<ChartNoAxesColumnIncreasing className="h-3.5 w-3.5" />}
        title="Source of Sales"
      />

      {visibleTools.length === 0 ? (
        <div className="border border-slate-200 bg-white p-8 text-center text-sm text-slate-500">
          No Source of Sales tools are available for your role.
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
