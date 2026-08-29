"use client";

import { ChevronDown, LogOut, Menu, Search, UserCog } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { useRef, useState } from "react";

import { CalculatorWidget } from "@/components/layout/calculator-widget";
import { COMMAND_PALETTE_EVENT } from "@/components/layout/command-palette";
import { InAppNotificationsBell } from "@/components/layout/in-app-notifications-bell";
import { InternalMessagesMenu } from "@/components/layout/internal-messages-menu";
import { MobileSidebar } from "@/components/layout/sidebar";
import type { PersonalNavigationLayout } from "@/lib/navigation/personal-layout";
import { systemAssets, systemUiText } from "@/config/system-settings";
import { logoutOneSignal } from "@/lib/notifications/onesignal-client";
import { type AccessContext, type NavigationMode, type PhoenixRole } from "@/lib/auth/permissions";
import type { PermissionLookup } from "@/components/layout/sidebar";
import type { ViewerIdentity } from "@/lib/auth/server";
import { usesAdminChrome } from "@/lib/navigation/active-path";
import { useDismissOnOutsideInteraction } from "@/hooks/use-dismiss-on-outside-interaction";

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
  const handleLogout = async () => {
    // Unbind this browser from the signed-out user's OneSignal identity first — best
    // effort, never blocks sign-out — so a shared device doesn't keep receiving their
    // pushes after someone else signs in.
    logoutOneSignal();
    try {
      await fetch("/api/auth/logout", { method: "POST" });
      window.location.href = "/login";
    } catch (error) {
      console.error("Logout failed:", error);
    }
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
          buys nothing and adds a stacking context the row dropdowns then have to escape. */}
      <header className={`px-3 py-3 backdrop-blur-xl sm:px-6 ${
        isAdminMode
          ? "border-b border-[#1a1a1a] bg-[#000000]"
          : "border-b border-phx-line/80 bg-white/82"
      }`}>
        <div className="mx-auto flex min-h-14 w-full max-w-[1760px] items-center gap-2 sm:min-h-16 sm:gap-4">
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
          <span className="truncate">{systemUiText.globalSearchPlaceholder}</span>
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
                <div className={`px-4 py-2 text-xs ${isAdminMode ? "text-phx-ink-faint" : "text-phx-ink-soft"}`}>
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
