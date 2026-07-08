import Link from "next/link";
import { redirect } from "next/navigation";

import { adminNavigationSections } from "@/config/system-navigation";
import {
  getPermissionMatrix,
  permissionActions,
  permissionResources,
  resolveNavigationMode,
} from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import {
  permissionAllowed,
  roleAllowed,
  roleNotExcluded,
  type PermissionLookup,
} from "@/lib/navigation/active-path";

export const dynamic = "force-dynamic";

const ACCENT = "#0F172A";

export default async function AttendanceManagementHubPage() {
  const access = await resolveAccessContextFromPage();
  if (resolveNavigationMode(access) === "employee-portal") {
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

  const section = adminNavigationSections.find((s) => s.id === "attendance-management");
  const items = (section?.items ?? []).filter(
    (item) =>
      permissionAllowed(permissionLookup, item.permissions) &&
      roleAllowed(access.role, item.roles) &&
      roleNotExcluded(access.role, item.excludedRoles),
  );

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-6">
      <div className="flex items-center gap-3 border-b border-border pb-5">
        <div className="h-12 w-1 shrink-0" style={{ backgroundColor: ACCENT }} />
        <div>
          <p className="mb-0.5 text-[10px] font-bold uppercase tracking-widest" style={{ color: ACCENT }}>
            HR Operations
          </p>
          <h1 className="text-2xl font-bold leading-tight text-foreground">Attendance Management</h1>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Every attendance report, review queue, and policy control in one place.
          </p>
        </div>
      </div>

      {items.length === 0 ? (
        <div className="border border-amber-200 bg-amber-50 px-5 py-4">
          <p className="text-sm font-black text-amber-900">No attendance modules available</p>
          <p className="mt-1 text-xs font-medium text-amber-800">
            Your role does not currently have access to any attendance management module.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {items.map((item) => (
            <Link
              className="group flex items-center gap-3 border border-border bg-card p-4 transition-all hover:border-orange-300 hover:shadow-md"
              href={item.href}
              key={item.href}
              style={{ borderTopColor: ACCENT, borderTopWidth: 3 }}
            >
              <item.icon aria-hidden="true" className="h-5 w-5 shrink-0" style={{ color: ACCENT }} />
              <span className="font-semibold text-foreground transition-colors group-hover:text-orange-600">
                {item.label}
              </span>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
