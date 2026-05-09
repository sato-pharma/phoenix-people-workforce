import type { ReactNode } from "react";

import {
  getPermissionMatrix,
  permissionActions,
  permissionResources,
  resolveNavigationMode,
  type NavigationMode,
} from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { Sidebar } from "@/components/layout/sidebar";
import { Topbar } from "@/components/layout/topbar";
import type { PermissionLookup } from "@/components/layout/sidebar";

export async function AppShell({
  children,
  showTopbar = true,
  navigationMode,
}: {
  children?: ReactNode;
  showTopbar?: boolean;
  navigationMode?: NavigationMode;
}) {
  const access = await resolveAccessContextFromPage();
  const resolvedNavigationMode = navigationMode ?? resolveNavigationMode(access);
  const matrix = await getPermissionMatrix();

  const permissionLookup: PermissionLookup = {};
  for (const resource of permissionResources) {
    for (const action of permissionActions) {
      const key = `${resource}:${action}` as const;
      const allowed = matrix[access.role]?.[resource]?.includes(action) ?? false;
      permissionLookup[key] = allowed;
    }
  }

  return (
    <div className="min-h-screen bg-[#F8FAFC] text-[#0F172A]">
      <div className="flex min-h-screen">
        <Sidebar navigationMode={resolvedNavigationMode} permissionLookup={permissionLookup} />
        <div className="flex min-w-0 flex-1 flex-col">
          {showTopbar && (
            <Topbar
              navigationMode={resolvedNavigationMode}
              permissionLookup={permissionLookup}
            />
          )}
          <main className="min-w-0 flex-1 px-3 py-4 sm:px-4 sm:py-5 lg:px-5 lg:py-6 xl:px-6">
            <div className="w-full max-w-none">{children}</div>
          </main>
        </div>
      </div>
    </div>
  );
}
