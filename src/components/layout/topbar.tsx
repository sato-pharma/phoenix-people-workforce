"use client";

import { Briefcase, ChevronDown, LayoutGrid, LogOut, Menu, Search, UserCog } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { useRef, useState } from "react";

import { CalculatorWidget } from "@/components/layout/calculator-widget";
import { COMMAND_PALETTE_EVENT } from "@/components/layout/command-palette";
import { DisplayScaleControl } from "@/components/layout/display-scale-control";
import { InAppNotificationsBell } from "@/components/layout/in-app-notifications-bell";
import { InternalMessagesMenu } from "@/components/layout/internal-messages-menu";
import { MobileSidebar } from "@/components/layout/sidebar";
import type { PersonalNavigationLayout } from "@/lib/navigation/personal-layout";
import { systemAssets, systemUiText } from "@/config/system-settings";
import { signOutAndLeave } from "@/lib/auth/sign-out-client";
import { scopeForRole, type AccessContext, type NavigationMode, type PhoenixRole } from "@/lib/auth/permissions";
import type { PermissionLookup } from "@/components/layout/sidebar";
import type { ViewerIdentity } from "@/lib/auth/server";
import { usesAdminChrome } from "@/lib/navigation/active-path";
import { useDismissOnOutsideInteraction } from "@/hooks/use-dismiss-on-outside-interaction";
import { personalWorkspaceEntryHref } from "@/lib/workspace/personal-workspace-nav";

export function Topbar({
  navigationMode = "admin",
  permissionLookup = {},
  viewer,
  currentRole,
  personalLayout = null,
  scope,
}: {
  currentRole?: PhoenixRole;
  navigationMode?: NavigationMode;
  permissionLookup?: PermissionLookup;
  /** This viewer's own saved arrangement, resolved server-side in AppShell and handed to the
   *  mobile drawer so the two sidebars never disagree about where a page lives. */
  personalLayout?: PersonalNavigationLayout | null;
  scope?: AccessContext["scope"];
  source?: AccessContext["source"];
  viewer: ViewerIdentity;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const userMenuRef = useRef<HTMLDivElement>(null);
  useDismissOnOutsideInteraction(userMenuRef, userMenuOpen, setUserMenuOpen);
  const isAdminMode = usesAdminChrome(navigationMode);
  const profileHref = isAdminMode ? "/admin/profile" : "/employee-portals/profile";
  // The door to this person's own workspace — payslip, incentive, deductions, vacation balance,
  // expenses, calendar. Fifteen working pages that until 2026-08-30 had almost no way in: two had
  // a sidebar row and the other thirteen were reachable only by typing the URL.
  //
  // ADMIN CHROME ONLY. Portal roles have the employee portal itself for all of this, and its own
  // navigation already covers it; `/workspace/*` exists precisely because admin-shell roles do not
  // get that portal. Nothing on the portal side of this component changes.
  //
  // Null means "do not offer it", which is the honest answer for the CEO: he is not in
  // `adminShellEmployeeRoles`, so every one of those pages would redirect him straight back out.
  //
  // `scope` is declared optional on this component while AccessContext's is not, so it is defaulted
  // through the same function the auth layer itself uses (`scopeForRole`, which resolveAccessContext
  // calls) rather than to a guessed literal. AppShell does pass it; this is the type being honest
  // about a prop that could be omitted, not a second source of truth.
  const workspaceHref =
    isAdminMode && currentRole
      ? personalWorkspaceEntryHref(
          { role: currentRole, scope: scope ?? scopeForRole(currentRole) },
          permissionLookup,
        )
      : null;
  // Leaves only once the server has signed this browser out; says so otherwise (sign-out-client.ts).
  const handleLogout = async () => {
    await signOutAndLeave();
  };

  return (
    <>
      <MobileSidebar
        navigationMode={navigationMode}
        currentRole={currentRole}
        onClose={() => setMenuOpen(false)}
        open={menuOpen}
        permissionLookup={permissionLookup}
        personalLayout={personalLayout}
      />
      {/* Not sticky itself. AppShell — the only place this renders — wraps it together with both
          navigation rows in one sticky container, so the whole chrome freezes as a unit. Restoring
          a `sticky top-0` here would put a second sticky at the same offset inside the first, which
          buys nothing and adds a stacking context the row dropdowns then have to escape.

          `relative z-40` is load-bearing, and NOT decoration. `backdrop-blur-xl` below already makes
          this header a stacking context, so every panel anchored inside it — notifications, messages,
          the command palette — is SEALED IN: their `z-30` ranks them against each other and against
          nothing else. The header then competed with the nav rows as one atomic box at "z-index 0, DOM
          order", and it is the EARLIER sibling, so the nav rows painted straight over the open panels.
          MEASURED 2026-09-02 at 375px: the "Organogram" nav link rendered at [42,93,110,111], inside
          the open notifications panel's [12,64,363,620], legible on top of it. The fix cannot go on the
          panels — no z-index escapes a sealed context — so it goes here, on the box that does compete.
          Nav-row dropdowns are unaffected: they open BELOW this band, so they never overlap it.

          It cannot leak outward either, which is what makes 40 safe to pick. AppShell's wrapper is
          `sticky top-0 z-30`, and sticky WITH a z-index is itself a stacking context — so this 40
          ranks only against the chrome's own children and the whole topbar still presents as 30 to
          everything outside. The two surfaces that must keep covering it both still do: the mobile
          drawer (`fixed inset-0 z-50`, rendered just above and higher inside this same context) and
          the sidebar (`z-40`, OUTSIDE it, so it beats the chrome's 30 whatever this says). */}
      <header className={`relative z-40 px-3 py-2 backdrop-blur-xl sm:px-6 ${
        isAdminMode
          ? "border-b border-[#1a1a1a] bg-[#000000]"
          : "border-b border-phx-line/80 bg-white/82"
      }`}>
        <div className="mx-auto flex min-h-12 w-full max-w-[1760px] items-center gap-2 sm:gap-4">
        <button
          aria-label="Open menu"
          className={`inline-flex h-9 w-9 shrink-0 items-center justify-center rounded lg:hidden ${
            isAdminMode
              ? "text-[#D4DDE8] hover:bg-[#1a1a1a] hover:text-[#F8B56B]"
              : "text-phx-ink-soft hover:bg-phx-paper hover:text-phx-ink"
          }`}
          onClick={() => setMenuOpen(true)}
          type="button"
        >
          <Menu className="h-5 w-5" />
        </button>

        <button
          aria-label="Open command palette"
          className={`relative hidden h-10 flex-1 items-center gap-2 rounded border pl-9 pr-2 text-left text-sm md:flex md:max-w-[280px] xl:max-w-xl ${
            isAdminMode
              ? "border-[#333333] bg-[#0B0B0B] text-phx-ink-soft shadow-[inset_0_1px_0_rgba(255,255,255,0.04)] hover:border-phx-accent"
              : "border-phx-line bg-[#FCFDFE] text-phx-ink-soft shadow-[inset_0_1px_0_rgba(255,255,255,0.55)] hover:border-phx-accent-line"
          }`}
          onClick={() => window.dispatchEvent(new Event(COMMAND_PALETTE_EVENT))}
          type="button"
        >
          <Search className={`pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 ${isAdminMode ? "text-[#F8B56B]" : "text-phx-ink-soft"}`} />
          {/* Never `truncate`: from md to xl this box is narrower than the placeholder, which then
              ended in an ellipsis. It wraps instead, and `leading-tight` keeps two lines inside h-10. */}
          <span className="leading-tight">{systemUiText.globalSearchPlaceholder}</span>
          <kbd className={`ml-auto hidden shrink-0 items-center gap-0.5 border px-1.5 py-0.5 text-phx-2xs font-semibold sm:flex ${
            isAdminMode ? "border-[#333333] bg-[#111111] text-phx-ink-faint" : "border-phx-line bg-white text-phx-ink-soft"
          }`}>
            ⌘K
          </kbd>
        </button>

        <div className="ml-auto flex shrink-0 items-center gap-1.5 sm:gap-3">
          <button
            aria-label="Open command palette"
            className={`inline-flex h-9 w-9 items-center justify-center rounded md:hidden ${
              isAdminMode ? "text-[#D4DDE8] hover:bg-[#1a1a1a] hover:text-[#F8B56B]" : "text-phx-ink-soft hover:bg-phx-paper hover:text-phx-ink"
            }`}
            onClick={() => window.dispatchEvent(new Event(COMMAND_PALETTE_EVENT))}
            type="button"
          >
            <Search className="h-5 w-5" />
          </button>
          {/* Admin chrome only, which is where the owner asked for it. The panel it opens is a
              portal, not a dropdown — see calculator-widget.tsx for why that matters here. */}
          {isAdminMode ? <CalculatorWidget isAdminMode={isAdminMode} /> : null}
          <DisplayScaleControl isAdminMode={isAdminMode} />
          <InAppNotificationsBell isAdminMode={isAdminMode} />
          <InternalMessagesMenu isAdminMode={isAdminMode} />
          <div className="relative" ref={userMenuRef}>
            <button
              aria-expanded={userMenuOpen}
              aria-haspopup="menu"
              className={`flex max-w-[calc(100vw-7rem)] items-center gap-2 rounded border py-1 pl-1 pr-2 sm:max-w-none sm:gap-3 sm:pr-3 ${
                isAdminMode
                  ? "border-[#333333] bg-[#0B0B0B] shadow-[0_10px_30px_rgba(0,0,0,0.24)] hover:bg-[#111111]"
                  : "border-phx-line bg-white/95 shadow-[0_10px_30px_rgba(15,23,42,0.06)] hover:bg-[#FCFDFE]"
              }`}
              onClick={() => setUserMenuOpen(!userMenuOpen)}
              type="button"
            >
              <Image
                alt="Phoenix"
                className="h-9 w-9 shrink-0 rounded object-cover"
                height={36}
                src={systemAssets.adminRailMark}
                width={36}
              />
              <div className="hidden text-left sm:block">
                <p className={`text-sm font-semibold ${isAdminMode ? "text-white" : "text-phx-ink"}`}>{viewer.displayName}</p>
                <p className={`text-xs ${isAdminMode ? "text-phx-ink-faint" : "text-phx-ink-soft"}`}>{viewer.roleLabel}</p>
              </div>
              <ChevronDown className={`hidden h-4 w-4 sm:block ${isAdminMode ? "text-[#F8B56B]" : "text-phx-ink-soft"}`} />
            </button>

            {userMenuOpen && (
              <div className={`absolute right-0 top-full z-30 mt-1.5 w-56 overflow-hidden rounded border shadow-lg ${
                isAdminMode ? "border-[#333333] bg-[#050505]" : "border-phx-line bg-white"
              }`} role="menu">
                {workspaceHref ? (
                  <Link
                    className={`flex w-full items-center gap-2 px-4 py-2 text-sm ${
                      isAdminMode ? "text-[#D4DDE8] hover:bg-[#1a1a1a] hover:text-[#F8B56B]" : "text-phx-ink hover:bg-phx-paper"
                    }`}
                    href={workspaceHref}
                    onClick={() => setUserMenuOpen(false)}
                    role="menuitem"
                  >
                    <Briefcase className="h-4 w-4" />
                    My Workspace
                  </Link>
                ) : null}
                <Link
                  className={`flex w-full items-center gap-2 px-4 py-2 text-sm ${
                    isAdminMode ? "text-[#D4DDE8] hover:bg-[#1a1a1a] hover:text-[#F8B56B]" : "text-phx-ink hover:bg-phx-paper"
                  }`}
                  href={profileHref}
                  onClick={() => setUserMenuOpen(false)}
                  role="menuitem"
                >
                  <UserCog className="h-4 w-4" />
                  My Profile
                </Link>
                {/* The way back to an emptied nav row. An empty row now renders nothing (owner,
                    2026-09-03), and the row’s own "+" panel is what used to offer the way back, so
                    it disappeared along with the row.

                    Every admin-chrome role can empty one: that panel offers remove as well as add,
                    and it is gated on `carriesNavRows` (horizontal-nav-rows.tsx, `canAdd`), not on
                    being a Super Admin. The only other door — Admin Tools → Navigation Layout —
                    sits in a Super-Admin-only hub, so everyone else was left able to empty a row
                    and unable to restore it. This is that door, on a surface those roles all have.

                    It grants NOTHING. The page gates on `source === "guest"` alone, and builds its
                    catalogue from the caller’s own permitted sections, so two people opening it see
                    different lists and no arrangement can emit an href the viewer could not already
                    reach.

                    Admin chrome only, and that is a LIMIT, not a choice: `carriesNavRows` also
                    covers the portal, but app/(admin)/layout.tsx redirects every portal-mode viewer
                    out of this whole route group, so /admin/sidebar-layout is unreachable to them
                    and a link here would only bounce them home. A portal viewer who empties a row
                    still has no way back. Closing that needs a portal twin of the editor and a
                    mode-aware catalogue — the page hardcodes getNavigationSections("admin") — which
                    is a bigger change than this one and is deliberately not smuggled in here. */}
                {isAdminMode ? (
                  <Link
                    className="flex w-full items-center gap-2 px-4 py-2 text-sm text-[#D4DDE8] hover:bg-[#1a1a1a] hover:text-[#F8B56B]"
                    href="/admin/sidebar-layout"
                    onClick={() => setUserMenuOpen(false)}
                    role="menuitem"
                  >
                    <LayoutGrid className="h-4 w-4" />
                    Navigation Layout
                  </Link>
                ) : null}
                {/* Identity, for the screens that need it. The BUTTON above already prints both
                    lines, but only from `sm:` up — below that it shows the avatar alone, so on a
                    phone this block is the only place the signed-in name appears. Hiding it on
                    desktop removes the repetition without costing anything on mobile.

                    Admin chrome only: the portal shell keeps exactly what it has today. */}
                <div className={`px-4 py-2 text-xs ${isAdminMode ? "text-phx-ink-faint sm:hidden" : "text-phx-ink-soft"}`}>
                  <p className="font-semibold">{viewer.roleLabel}</p>
                  <p className="mt-0.5 whitespace-nowrap">{viewer.displayName}</p>
                </div>
                <div className={`mx-3 h-px ${isAdminMode ? "bg-[#333333]" : "bg-phx-line"}`} />
                <button
                  className={`flex w-full items-center gap-2 px-4 py-2 text-sm ${
                    isAdminMode ? "text-[#D4DDE8] hover:bg-[#1a1a1a] hover:text-[#F8B56B]" : "text-phx-ink hover:bg-phx-paper"
                  }`}
                  onClick={handleLogout}
                  role="menuitem"
                  type="button"
                >
                  <LogOut className="h-4 w-4" />
                  Logout
                </button>
              </div>
            )}
          </div>
        </div>
        </div>
      </header>
    </>
  );
}
