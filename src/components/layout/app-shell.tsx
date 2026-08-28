import type { ReactNode } from "react";
import { redirect } from "next/navigation";
import { headers } from "next/headers";

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
import { loadPersonalLayout } from "@/lib/navigation/personal-layout-store";
import { CommandPalette } from "@/components/layout/command-palette";
import { DocumentTitleSync } from "@/components/layout/document-title-sync";
import { RouteTransitionProvider } from "@/components/layout/route-transition-provider";
import { Sidebar } from "@/components/layout/sidebar";
import { Topbar } from "@/components/layout/topbar";
import { SessionSecurityGuard } from "@/components/auth/session-security-guard";
import { OneSignalProvider } from "@/components/notifications/onesignal-provider";
import type { PermissionLookup } from "@/components/layout/sidebar";
import { usesAdminChrome } from "@/lib/navigation/active-path";
import { SHELL_HEADER } from "@/lib/navigation/shell-headers";

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

  // This viewer's own sidebar arrangement. Never throws and returns null on any problem — a
  // missing table (before the migration is applied), an unreadable row, a layout written by a
  // future version — and null means the sidebar renders exactly as the code defines it. A cosmetic
  // preference must never be able to break navigation for someone trying to do their job.
  const personalLayout = await loadPersonalLayout(access.hrId);

  const viewer = showTopbar
    ? await resolveViewerIdentityFromPage(access)
    : {
        displayName: access.loginId || formatHrIdForDisplay(access.hrId) || "User",
        initials: "US",
        roleLabel: access.role,
      };
  // The `/hr` namespace decides the shell, and it decides it HERE rather than in the route-group
  // layout so that EVERY AppShell render honours it — including the handful of dual-mode pages
  // (/payslips, /leave-management, /marketing-requests/[id]) that sit outside the (admin) group and
  // mount their own shell. The header is written by middleware, which strips any inbound copy
  // first, so it cannot be forged. It selects CHROME only: every page behind it still asserts its
  // own permission server-side, so being wrong here shows the right page under the wrong nav.
  const resolvedNavigationMode: NavigationMode =
    (await headers()).get(SHELL_HEADER) === "hr" ? "hr" : navigationMode ?? resolveNavigationMode(access);
  const isSystemAdministratorWorkspace = access.scope === "system" || access.role === "Super Admin";

  const permissionLookup: PermissionLookup = {};
  for (const resource of permissionResources) {
    for (const action of permissionActions) {
      const key = `${resource}:${action}` as const;
      const allowed = matrix[access.role]?.[resource]?.includes(action) ?? false;
      permissionLookup[key] = allowed;
    }
  }

  const isAdminMode = usesAdminChrome(resolvedNavigationMode);

  return (
    <RouteTransitionProvider>
      <div className={`min-h-screen text-[#0F172A] ${isAdminMode ? `admin-shell ${adminShellBackgroundClassName}` : "bg-[#F8FAFC]"}`}>
        <SessionSecurityGuard />
        <OneSignalProvider />
        <DocumentTitleSync mode={resolvedNavigationMode} />
        <CommandPalette
          currentRole={access.role}
          isSystemAdministratorWorkspace={isSystemAdministratorWorkspace}
          navigationMode={resolvedNavigationMode}
          permissionLookup={permissionLookup}
        />
        <div className="flex min-h-screen">
          <Sidebar
            currentRole={access.role}
            isSystemAdministratorWorkspace={isSystemAdministratorWorkspace}
            navigationMode={resolvedNavigationMode}
            permissionLookup={permissionLookup}
            personalLayout={personalLayout}
          />
          <div className="flex min-w-0 flex-1 flex-col">
            {showTopbar && (
              <Topbar
                currentRole={access.role}
                navigationMode={resolvedNavigationMode}
                permissionLookup={permissionLookup}
                personalLayout={personalLayout}
                scope={access.scope}
                source={access.source}
                viewer={viewer}
              />
            )}
            <main className="min-w-0 flex-1 px-3 py-4 sm:px-4 sm:py-5 lg:px-6 lg:py-6 xl:px-8">
              <div
                className={`w-full ${
                  contentWidth !== "full"
                    ? "mx-auto max-w-[1760px]"
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
