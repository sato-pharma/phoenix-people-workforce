import type { ReactNode } from "react";

import { adminShellBackgroundClassName } from "@/components/admin/admin-design-system";
import {
  getPermissionMatrix,
  permissionActions,
  permissionResources,
  resolveNavigationMode,
  type NavigationMode,
} from "@/lib/auth/permissions";
import { resolveAccessContextFromPage, resolveViewerIdentityFromPage } from "@/lib/auth/server";
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
  const viewer = await resolveViewerIdentityFromPage();
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

  const isAdminMode = resolvedNavigationMode === "admin";

  return (
    <div className={`min-h-screen text-[#0F172A] ${isAdminMode ? adminShellBackgroundClassName : "bg-[#F8FAFC]"}`}>
      <div className="flex min-h-screen">
        <Sidebar navigationMode={resolvedNavigationMode} permissionLookup={permissionLookup} />
        <div className="flex min-w-0 flex-1 flex-col">
          {showTopbar && (
            <Topbar
              navigationMode={resolvedNavigationMode}
              permissionLookup={permissionLookup}
              viewer={viewer}
            />
          )}
          <main className="min-w-0 flex-1 px-3 py-4 sm:px-4 sm:py-5 lg:px-6 lg:py-6 xl:px-8">
            <div className={`w-full ${isAdminMode ? "mx-auto max-w-[1480px]" : "max-w-none"}`}>{children}</div>
          </main>
        </div>
      </div>
    </div>
  );
}
