import type { ReactNode } from "react";
import { redirect } from "next/navigation";

import { adminShellBackgroundClassName } from "@/components/admin/admin-design-tokens";
import {
  getPermissionMatrix,
  permissionActions,
  permissionResources,
  resolveNavigationMode,
  type AccessContext,
  type NavigationMode,
} from "@/lib/auth/permissions";
import { resolveAccessContextFromPage, resolveViewerIdentityFromPage } from "@/lib/auth/server";
import { formatHrIdForDisplay } from "@/lib/hr-id";
import { CommandPalette } from "@/components/layout/command-palette";
import { RouteTransitionProvider } from "@/components/layout/route-transition-provider";
import { Sidebar } from "@/components/layout/sidebar";
import { Topbar } from "@/components/layout/topbar";
import { SessionSecurityGuard } from "@/components/auth/session-security-guard";
import type { PermissionLookup } from "@/components/layout/sidebar";

export async function AppShell({
  accessContext,
  children,
  contentWidth = "default",
  showTopbar = true,
  navigationMode,
}: {
  accessContext?: AccessContext;
  children?: ReactNode;
  contentWidth?: "default" | "full";
  showTopbar?: boolean;
  navigationMode?: NavigationMode;
}) {
  const [access, matrix] = await Promise.all([
    accessContext ? Promise.resolve(accessContext) : resolveAccessContextFromPage(),
    getPermissionMatrix(),
  ]);
  if (!access.loginId && !access.hrId) {
    redirect("/login");
  }

  const viewer = showTopbar
    ? await resolveViewerIdentityFromPage(access)
    : {
        displayName: access.loginId || formatHrIdForDisplay(access.hrId) || "User",
        initials: "US",
        roleLabel: access.role,
      };
  const resolvedNavigationMode = navigationMode ?? resolveNavigationMode(access);

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
    <RouteTransitionProvider>
      <div className={`min-h-screen text-[#0F172A] ${isAdminMode ? `admin-shell ${adminShellBackgroundClassName}` : "bg-[#F8FAFC]"}`}>
        <SessionSecurityGuard />
        <CommandPalette
          currentRole={access.role}
          navigationMode={resolvedNavigationMode}
          permissionLookup={permissionLookup}
        />
        <div className="flex min-h-screen">
          <Sidebar currentRole={access.role} navigationMode={resolvedNavigationMode} permissionLookup={permissionLookup} />
          <div className="flex min-w-0 flex-1 flex-col">
            {showTopbar && (
              <Topbar
                currentRole={access.role}
                navigationMode={resolvedNavigationMode}
                permissionLookup={permissionLookup}
                scope={access.scope}
                source={access.source}
                viewer={viewer}
              />
            )}
            <main className="min-w-0 flex-1 px-3 py-4 sm:px-4 sm:py-5 lg:px-6 lg:py-6 xl:px-8">
              <div
                className={`w-full ${
                  contentWidth !== "full"
                    ? "mx-auto max-w-[1480px]"
                    : "max-w-none"
                }`}
              >
                {children}
              </div>
            </main>
          </div>
        </div>
      </div>
    </RouteTransitionProvider>
  );
}
