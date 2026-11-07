import { Suspense, type ReactNode } from "react";
import { redirect } from "next/navigation";
import { headers } from "next/headers";

import { adminShellBackgroundClassName } from "@/components/admin/admin-design-tokens";
import {
  buildPermissionLookup,
  getPermissionMatrix,
  usesHrNamespace,
  type AccessContext,
  type NavigationMode,
} from "@/lib/auth/permissions";
import { displayTitleForAccount } from "@/lib/auth/account-job-titles";
import { resolveLandingPathForRole } from "@/lib/auth/landing";
import { isPageFencedForRole } from "@/lib/auth/seat-page-fences";
import { resolveAccessContextFromPage, resolveViewerIdentityFromPage } from "@/lib/auth/server";
import { formatHrIdForDisplay } from "@/lib/hr-id";
import { layoutOwnerKey } from "@/lib/navigation/personal-layout";
import { loadEffectiveLayout } from "@/lib/navigation/personal-layout-store";
import { resolveModuleLocksForAccess } from "@/lib/auth/module-locks";
import { navigationHomePathByMode } from "@/config/system-navigation";
import { resolveLockedModuleForPath } from "@/lib/navigation/module-catalog";
import { ModuleLockProvider } from "@/components/layout/module-lock-context";
import { ModuleLockedNotice } from "@/components/layout/module-locked-notice";
import { ChromeHeightProbe } from "@/components/layout/chrome-height-probe";
import { CommandPalette } from "@/components/layout/command-palette";
import { DocumentTitleSync } from "@/components/layout/document-title-sync";
import { HorizontalNavProvider, LowerNavRow, UpperNavRow } from "@/components/layout/horizontal-nav-rows";
import { RouteTransitionProvider } from "@/components/layout/route-transition-provider";
import { Sidebar } from "@/components/layout/sidebar";
import { Topbar } from "@/components/layout/topbar";
import { SeatViewBanner } from "@/components/layout/seat-view-banner";
import { SessionSecurityGuard } from "@/components/auth/session-security-guard";
import { OneSignalProvider } from "@/components/notifications/onesignal-provider";
import { VisitOutboxRunner } from "@/components/phoenix-crm/visit-outbox-runner";
import { resolvePushIdentity } from "@/lib/notifications/push-identity";
import { personalMailboxConnected } from "@/lib/personal-mailbox/service";
import { usesAdminChrome } from "@/lib/navigation/active-path";
import { resolveShellNavigationMode } from "@/lib/navigation/shell-mode";
import { PATH_HEADER, SHELL_HEADER, hrNamespaceRedirectTarget } from "@/lib/navigation/shell-headers";

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
    // 🔴 Null when the address is ALREADY under /hr, and that null is the circuit breaker: this
    // block's whole job is to ADD the prefix, so a path already inside the namespace needs nothing.
    // The one time the header above went missing on an `/hr` address — the dev server re-running
    // proxy.ts on its own rewrite, fixed in proxy.ts in this same change — redirecting anyway made
    // every `/hr` page 307 to ITSELF until the browser gave up (measured six hops deep on both HR
    // seats, 2026-10-12). The comment above says a guessed target is how a redirect loop starts;
    // this is what makes that true rather than merely hoped for, and it turns the worst case into a
    // page rendered under the wrong chrome, which is visible and recoverable.
    const hrTarget = requestedPath ? hrNamespaceRedirectTarget(requestedPath) : null;
    if (hrTarget) {
      redirect(hrTarget);
    }
  }

  // ── Per-seat page fences ──────────────────────────────────────────────────────────────────
  // A page the owner left out of a seat that one of its keys would otherwise open
  // (src/lib/auth/seat-page-fences.ts — the Talent Acquisition seat today). The sidebar never
  // offers it; this is what stops a typed address, a bookmark or a notification link. Sent to the
  // seat's own landing page.
  //
  // 🔴 That landing page being outside the seat's own fence is what makes this terminate, and until
  // 2026-10-12 nothing here checked it — the invariant lived in an assertion in
  // tests/hr-resourcing-seat.test.ts. So fencing a seat's landing page, or opening a seat whose
  // landing page sits behind a fence, would have sent every address to a fenced page that this very
  // block fences again: an infinite redirect with no circuit breaker. Checked here now, in the code
  // that depends on it, and a seat that somehow has nowhere to go renders the page rather than
  // looping.
  const fencedPath = requestHeaders.get(PATH_HEADER);
  if (fencedPath && isPageFencedForRole(access.role, fencedPath)) {
    const landing = resolveLandingPathForRole(access.role);
    if (!isPageFencedForRole(access.role, landing)) {
      redirect(landing);
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
  //
  // 🔴 ASKED BESIDE THE TOPBAR'S IDENTITY, NOT BEFORE IT (Phoenix CRM performance audit, 2026-10-16).
  // Neither needs the other's answer, and both were awaited one after the other on every admin page
  // render — two Atlantic round trips where one will do. The layout read still never throws, so
  // running it alongside changes nothing about what renders when either is slow or missing.
  // The mailbox connection and the push identity ride the same wave (1 Nov 2026): the shell's HTML
  // carries both, so the envelope and the OneSignal provider ask the server for neither on a page view.
  const [{ layout: personalLayout }, viewer, mailboxConnected, pushHrId] = await Promise.all([
    loadEffectiveLayout(layoutOwnerKey(access)),
    showTopbar
      ? resolveViewerIdentityFromPage(access)
      : Promise.resolve({
          displayName: access.loginId || formatHrIdForDisplay(access.hrId) || "User",
          initials: "US",
          roleLabel: displayTitleForAccount(access.hrId, access.role),
        }),
    personalMailboxConnected(access),
    resolvePushIdentity(access),
  ]);
  // The `/hr` namespace decides the shell, and it decides it HERE rather than in the route-group
  // layout so that EVERY AppShell render honours it — including the handful of dual-mode pages
  // (/payslips, /leave-management, /marketing-requests/[id]) that sit outside the (admin) group and
  // mount their own shell. The header is written by middleware, which strips any inbound copy
  // first, so it cannot be forged. It selects CHROME only: every page behind it still asserts its
  // own permission server-side, so being wrong here shows the right page under the wrong nav.
  //
  // The rule itself lives in resolveShellNavigationMode so a PAGE that needs the mode it is being
  // rendered under can ask the same question. A page that instead asks resolveNavigationMode alone
  // gets "admin" for an HR seat — that function answers about the person and never returns "hr" —
  // and then renders the admin catalogue under HR chrome, which looks like a working page.
  const resolvedNavigationMode: NavigationMode = resolveShellNavigationMode(
    access,
    requestHeaders.get(SHELL_HEADER),
    navigationMode,
  );

  const permissionLookup = buildPermissionLookup(matrix, access.role);

  const isAdminMode = usesAdminChrome(resolvedNavigationMode);

  // ── Temporary module locks ─────────────────────────────────────────────────────────────────
  // The sidebar keeps showing a locked module — carrying a padlock — because hiding it would look
  // like the module was taken away for good, which is a different and more alarming message than
  // the one the administrator chose to send. Opening it lands here, on the lock notice, instead of
  // on the page.
  //
  // This is CHROME, exactly like the shell selection above: the page behind it still refuses a
  // locked module on its own (`canAccess` consults the same locks). Being wrong here shows a plain
  // "Forbidden" rather than the friendly sentence — never access that should not exist.
  const activeLocks = await resolveModuleLocksForAccess(access);
  const lockedModuleKeys = Array.from(new Set(activeLocks.map((lock) => lock.moduleKey)));
  // The address the BROWSER asked for. Absent only when the proxy did not run, in which case there
  // is nothing to match and the page renders normally — and then refuses itself.
  const requestedPath = requestHeaders.get(PATH_HEADER) ?? "";
  const lockedModuleForPage = lockedModuleKeys.length
    ? resolveLockedModuleForPath(requestedPath, lockedModuleKeys)
    : null;
  const pageLock = lockedModuleForPage
    ? activeLocks.find((lock) => lock.moduleKey === lockedModuleForPage) ?? null
    : null;

  return (
    <RouteTransitionProvider>
      <ModuleLockProvider lockedModuleKeys={lockedModuleKeys}>
      <div className={`min-h-screen text-phx-ink ${isAdminMode ? `admin-shell ${adminShellBackgroundClassName}` : "bg-phx-paper"}`}>
        <SessionSecurityGuard />
        <OneSignalProvider pushHrId={pushHrId} />
        <VisitOutboxRunner ownerHrId={pushHrId} />
        {/* Suspense because DocumentTitleSync reads useSearchParams. Names the tab on
            in-app navigation only — the FIRST paint is named by generateMetadata in
            app/(admin)/layout.tsx, through the same resolver. */}
        <Suspense fallback={null}>
          <DocumentTitleSync mode={resolvedNavigationMode} role={access.role} />
        </Suspense>
        <CommandPalette
          currentRole={access.role}
          navigationMode={resolvedNavigationMode}
          permissionLookup={permissionLookup}
        />
        <div className="flex min-h-screen">
          <Sidebar
            currentRole={access.role}
            navigationMode={resolvedNavigationMode}
            permissionLookup={permissionLookup}
            personalLayout={personalLayout}
          />
          <div className="flex min-w-0 flex-1 flex-col">
            {/* FROZEN CHROME. The Topbar and both navigation rows travel as ONE sticky block, so
                the rows stay put while the page scrolls and land in the same place on every page.
                It has to be a single container: two stickies at top-0 do not stack, they slide to
                the same offset and overlap, and stacking them by hand would mean hard-coding the
                Topbar's rendered height, which changes with the viewport. Wrapping avoids that
                arithmetic entirely. Zone 2 reaches all 243 pages from here and zone 3 sits directly
                under it — zone 3 no longer has an in-page copy, because a row rendered inside a
                page's hero cannot be frozen at all: sticky is bounded by its containing block, so
                such a row unpins the moment the hero scrolls away. Both rows render nothing until
                the viewer has put a tab in them, which is every account until somebody arranges
                one, and the Topbar keeps rendering either way. */}
            <HorizontalNavProvider
              currentRole={access.role}
              navigationMode={resolvedNavigationMode}
              permissionLookup={permissionLookup}
              personalLayout={personalLayout}
            >
              <div className="phx-navrow-scope flex min-w-0 flex-1 flex-col">
                <div className="sticky top-0 z-30">
                  {/* Publishes this block's height as --phx-chrome-h, for a page that pins something
                      under it (the Expense Approvals rail). Renders nothing visible. */}
                  <ChromeHeightProbe />
                  {/* VIEW AS SEAT (src/lib/auth/seat-view.ts): on every page of a view, above the
                      seat's own chrome, so a read-only view is never taken for the real seat. */}
                  {access.seatView ? (
                    <SeatViewBanner
                      expiresAt={access.seatView.expiresAt}
                      personName={access.seatView.personName}
                      seatTitle={displayTitleForAccount(access.hrId, access.role)}
                    />
                  ) : null}
                  {showTopbar && (
                    <Topbar
                      currentRole={access.role}
                      mailboxConnected={mailboxConnected}
                      navigationMode={resolvedNavigationMode}
                      permissionLookup={permissionLookup}
                      personalLayout={personalLayout}
                      scope={access.scope}
                      source={access.source}
                      viewer={viewer}
                    />
                  )}
                  {/* NO "MY PAGES" STRIP. Removed 2026-09-03 at the owner's instruction — he named
                      the band by its own tab labels and said "remove this nav bar". It was
                      `HrMyPagesStrip`, added 2026-09-01 at his own earlier instruction to put the
                      two HR seats' personal pages (payslip, incentive, deductions, vacation,
                      excuses, fingerprint, plans, probation, contact HR) in a strip under the
                      identity banner on every page she opens. That identity banner is itself gone
                      now (same day, same instruction, on HrCommandCenter and AdminPageHero), so the
                      strip was the only piece of that pairing left standing.

                      THIS WAS THE TWO HR SEATS' ONLY DOOR to those twelve pages. Every other admin-
                      shell role reaches its own personal pages through `PersonalWorkspaceTabs`
                      inside `WorkspaceFrame` (src/components/workspace/admin-shell-employee-pages.tsx)
                      — deliberately zeroed for `usesHrNamespace` roles so the two lists could never
                      stack (see tests/workspace-single-hero.test.ts). Removing this strip and not
                      restoring that list leaves HR Advisory and HR Operations with no in-app link to
                      their own payslip, leave balance, or excuses — those pages still work at their
                      direct URL, they are just no longer offered anywhere. Flagged to the owner in
                      chat when this was cut; if he wants a door back, it wants a smaller one, not a
                      restore of the black strip.

                      `HrMyPagesStrip` itself (src/components/hr/hr-my-pages-strip.tsx) is left in
                      place, unrendered — tests/workspace-single-hero.test.ts reads its source for
                      the `usesHrNamespace` guard directly, and `toHrNamespacePath`/`PATH_HEADER`
                      below are still imported for the redirect a few lines up in this file. */}
                  <UpperNavRow />
                  <LowerNavRow />
                </div>
                <main className="phx-zoom-surface min-w-0 flex-1 px-3 py-4 sm:px-4 sm:py-5 lg:px-4 lg:py-6 xl:px-5">
                  <div
                    className={`w-full ${
                      contentWidth !== "full"
                        ? "mx-auto phx-shell-cap-admin"
                        : "max-w-none"
                    }`}
                  >
                    {lockedModuleForPage ? (
                      <ModuleLockedNotice
                        homeHref={navigationHomePathByMode[resolvedNavigationMode]}
                        lock={pageLock}
                        moduleKey={lockedModuleForPage}
                      />
                    ) : (
                      children
                    )}
                  </div>
                </main>
              </div>
            </HorizontalNavProvider>
          </div>
        </div>
      </div>
      </ModuleLockProvider>
    </RouteTransitionProvider>
  );
}
