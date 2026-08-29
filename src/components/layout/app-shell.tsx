import type { ReactNode } from "react";
import { redirect } from "next/navigation";
import { headers } from "next/headers";

import { adminShellBackgroundClassName } from "@/components/admin/admin-design-tokens";
import {
  getPermissionMatrix,
  permissionActions,
  permissionResources,
  resolveNavigationMode,
  usesHrNamespace,
  type AccessContext,
  type NavigationMode,
} from "@/lib/auth/permissions";
import { resolveAccessContextFromPage, resolveViewerIdentityFromPage } from "@/lib/auth/server";
import { formatHrIdForDisplay } from "@/lib/hr-id";
import { layoutOwnerKey } from "@/lib/navigation/personal-layout";
import { loadEffectiveLayout } from "@/lib/navigation/personal-layout-store";
import { CommandPalette } from "@/components/layout/command-palette";
import { DocumentTitleSync } from "@/components/layout/document-title-sync";
import { HorizontalNavProvider, LowerNavRow, UpperNavRow } from "@/components/layout/horizontal-nav-rows";
import { RouteTransitionProvider } from "@/components/layout/route-transition-provider";
import { Sidebar } from "@/components/layout/sidebar";
import { Topbar } from "@/components/layout/topbar";
import { SessionSecurityGuard } from "@/components/auth/session-security-guard";
import { OneSignalProvider } from "@/components/notifications/onesignal-provider";
import type { PermissionLookup } from "@/components/layout/sidebar";
import { usesAdminChrome } from "@/lib/navigation/active-path";
import { PATH_HEADER, SHELL_HEADER, toHrNamespacePath } from "@/lib/navigation/shell-headers";

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

  const requestHeaders = await headers();

  // ── The /hr namespace ──────────────────────────────────────────────────────────────────────
  // An HR seat that arrives on a BARE address is sent to the same page under /hr. This lives in
  // AppShell rather than in app/(admin)/layout.tsx so that it also covers the pages that sit
  // OUTSIDE that route group and mount their own shell — /payslips, /leave-management,
  // /marketing-requests/[id]. That is not a hypothetical gap: production notification links point
  // at those addresses (123 rows for /payslips alone), and from the route-group layout an HR seat
  // following one would have landed on the right page wearing the ADMIN sidebar.
  //
  // It also catches every notification link already sitting on a phone, every bookmark, and every
  // in-page `<Link href="/admin/…">` written before the namespace existed, so no href anywhere in
  // the app has to learn about the prefix.
  //
  // The reverse is deliberately NOT enforced: a non-HR role opening an /hr address gets the HR
  // chrome rather than a bounce, so the owner can inspect exactly what these seats see. That is
  // safe because the shell is chrome — every page behind it re-asserts its own grant server-side.
  if (requestHeaders.get(SHELL_HEADER) !== "hr" && usesHrNamespace(access.role)) {
    // Written by proxy.ts on every matched request. Absent only if the proxy did not run, in which
    // case there is no path to redirect TO — fall through to the admin shell rather than guess,
    // because a guessed target here is how a redirect loop starts.
    const requestedPath = requestHeaders.get(PATH_HEADER);
    if (requestedPath) {
      redirect(toHrNamespacePath(requestedPath));
    }
  }

  // What this viewer's navigation renders from: their own saved arrangement if they have one,
  // otherwise the company default, otherwise nothing. ONE database round trip for both — this is on
  // every admin page render and every call from here crosses the Atlantic, so a sequential fallback
  // would tax exactly the people who have arranged nothing, i.e. almost everyone.
  //
  // Never throws and returns null on any problem — a missing table (before the migration is
  // applied), an unreadable row, a layout written by a future version — and null means the sidebar
  // renders exactly as the code defines it. A cosmetic preference must never be able to break
  // navigation for someone trying to do their job.
  const { layout: personalLayout } = await loadEffectiveLayout(layoutOwnerKey(access));

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
    requestHeaders.get(SHELL_HEADER) === "hr" ? "hr" : navigationMode ?? resolveNavigationMode(access);
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
      <div className={`min-h-screen text-phx-ink ${isAdminMode ? `admin-shell ${adminShellBackgroundClassName}` : "bg-phx-paper"}`}>
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
            {/* The two horizontal navigation rows. Zone 2 sits here, above every page title, and
                reaches all 243 pages from this one place. Zone 3 belongs BELOW the page title, so
                the copy rendered here is the fallback for pages with no shared title surface — the
                `.phx-navrow-scope:has(.phx-navrow--inpage)` rule in app/globals.css hides it the
                moment a page places the row itself. Both render nothing until the viewer has put a
                tab in them, which is every account until somebody arranges one. */}
            <HorizontalNavProvider
              currentRole={access.role}
              isSystemAdministratorWorkspace={isSystemAdministratorWorkspace}
              navigationMode={resolvedNavigationMode}
              permissionLookup={permissionLookup}
              personalLayout={personalLayout}
            >
              <div className="phx-navrow-scope flex min-w-0 flex-1 flex-col">
                <UpperNavRow />
                <LowerNavRow placement="fallback" />
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
            </HorizontalNavProvider>
          </div>
        </div>
      </div>
    </RouteTransitionProvider>
  );
}
