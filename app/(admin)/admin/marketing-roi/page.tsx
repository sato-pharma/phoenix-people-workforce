import Link from "next/link";
import { redirect } from "next/navigation";
import { ArrowRight, Megaphone } from "lucide-react";

import { AdminPageHero } from "@/components/admin/admin-design-system";
import { marketingRoiPageItems } from "@/config/system-navigation";
import { buildPermissionLookup, getPermissionMatrix, resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { permissionAllowed, roleAllowed, roleNotExcluded } from "@/lib/navigation/active-path";

export const dynamic = "force-dynamic";

// MUST stay in step with the sidebar button's own `roles` list (the `workspace-marketing-requests`
// section in src/config/system-navigation.ts). Finance Manager and Financial Advisor were added to
// that list so the admin-shell finance roles had a route to ROI Tracker at all, but this gate was
// never updated to match — so the button rendered for them and then redirected them straight back
// out to /overview. Fixed 2026-08-10 while activating the Finance Manager account.
const MARKETING_ROI_ROLES = [
  "Super Admin",
  "CEO",
  "SFE Manager",
  "District Manager",
  "Finance Manager",
  "Financial Advisor",
] as const;

export default async function MarketingRoiPage() {
  const access = await resolveAccessContextFromPage();
  if (resolveNavigationMode(access) === "employee-portal") redirect("/employee-portals");
  // Every card here is role-gated only (no permissions field) — match the sidebar
  // button's own gate directly.
  if (!(MARKETING_ROI_ROLES as readonly string[]).includes(access.role)) {
    redirect("/employee-portals");
  }

  const matrix = await getPermissionMatrix();
  const permissionLookup = buildPermissionLookup(matrix, access.role);
  const isSystemAdministratorWorkspace = access.scope === "system" || access.role === "Super Admin";

  const visibleTools = isSystemAdministratorWorkspace
    ? marketingRoiPageItems
    : marketingRoiPageItems.filter(
        (item) =>
          permissionAllowed(permissionLookup, item.permissions) &&
          roleAllowed(access.role, item.roles) &&
          roleNotExcluded(access.role, item.excludedRoles),
      );

  return (
    <div className="space-y-6">
      <AdminPageHero
        description="Marketing ROI dashboards, reports, coverage, and the marketing request workflow — in one place."
        eyebrow="Marketing Operations"
        icon={<Megaphone className="h-3.5 w-3.5" />}
        title="Marketing & ROI"
      />

      {visibleTools.length === 0 ? (
        <div className="border border-slate-200 bg-white p-8 text-center text-sm text-slate-500">
          No marketing or ROI tools are available for your role.
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
