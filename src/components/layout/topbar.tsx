"use client";

import { Bell, ChevronDown, LogOut, Mail, Menu, Search } from "lucide-react";
import { useState } from "react";

import { PhoenixLogo } from "@/components/brand/phoenix-logo";
import { MobileSidebar } from "@/components/layout/sidebar";
import { type NavigationMode } from "@/lib/auth/permissions";
import type { PermissionLookup } from "@/components/layout/sidebar";
import type { ViewerIdentity } from "@/lib/auth/server";
import { ThemeToggle } from "@/components/layout/theme-toggle";
import { Input } from "@/components/ui/input";

export function Topbar({
  navigationMode = "admin",
  permissionLookup = {},
  viewer,
}: {
  navigationMode?: NavigationMode;
  permissionLookup?: PermissionLookup;
  viewer: ViewerIdentity;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const handleLogout = async () => {
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
        onClose={() => setMenuOpen(false)}
        open={menuOpen}
        permissionLookup={permissionLookup}
      />
      <header className="sticky top-0 z-20 border-b border-[#E2E8F0]/80 bg-white/82 px-3 py-3 backdrop-blur-xl sm:px-6">
        <div className="mx-auto flex min-h-14 w-full max-w-[1480px] items-center gap-2 sm:min-h-16 sm:gap-4">
        <button
          aria-label="Open menu"
          className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-[#64748B] hover:bg-[#F8FAFC] hover:text-[#0F172A] lg:hidden"
          onClick={() => setMenuOpen(true)}
          type="button"
        >
          <Menu className="h-5 w-5" />
        </button>

        <div className="min-w-0 lg:hidden">
          <PhoenixLogo compact />
        </div>

        <div className="relative hidden flex-1 md:block md:max-w-[280px] xl:max-w-xl">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[#64748B]" />
          <Input
            aria-label="Search"
            className="h-12 rounded-2xl border-[#E2E8F0] bg-[#FCFDFE] pl-9 shadow-[inset_0_1px_0_rgba(255,255,255,0.55)]"
            placeholder="Search employees, reports, pages..."
          />
        </div>

        <div className="ml-auto flex shrink-0 items-center gap-1.5 sm:gap-3">
          <button className="inline-flex h-10 w-10 items-center justify-center rounded-lg text-[#64748B] hover:bg-[#F8FAFC] hover:text-[#0F172A] md:hidden">
            <Search className="h-5 w-5" />
          </button>
          <ThemeToggle />
          <button aria-label="Notifications" className="hidden h-10 w-10 items-center justify-center rounded-lg text-[#64748B] hover:bg-[#F8FAFC] hover:text-[#0F172A] sm:inline-flex" type="button">
            <Bell className="h-5 w-5" />
          </button>
          <button aria-label="Messages" className="hidden h-10 w-10 items-center justify-center rounded-lg text-[#64748B] hover:bg-[#F8FAFC] hover:text-[#0F172A] xl:inline-flex" type="button">
            <Mail className="h-5 w-5" />
          </button>
          <div className="relative">
            <button
              className="flex max-w-[calc(100vw-7rem)] items-center gap-2 rounded-full border border-[#E2E8F0] bg-white/95 py-1 pl-1 pr-2 shadow-[0_10px_30px_rgba(15,23,42,0.06)] sm:max-w-none sm:gap-3 sm:pr-3 hover:bg-[#FCFDFE]"
              onClick={() => setUserMenuOpen(!userMenuOpen)}
              type="button"
            >
              <div className="flex h-9 w-9 items-center justify-center rounded-full bg-[#F97316]/15 text-xs font-black text-[#F97316] ring-[#F97316]/20 ring-1">
                {viewer.initials}
              </div>
              <div className="hidden text-left sm:block">
                <p className="text-sm font-semibold text-[#0F172A]">{viewer.displayName}</p>
                <p className="text-xs text-[#64748B]">{viewer.roleLabel}</p>
              </div>
              <ChevronDown className="hidden h-4 w-4 text-[#64748B] sm:block" />
            </button>

            {userMenuOpen && (
              <div className="absolute right-0 top-full mt-2 w-48 rounded-lg border border-[#E2E8F0] bg-white shadow-lg">
                <button
                  className="flex w-full items-center gap-2 px-4 py-2 text-sm text-[#0F172A] hover:bg-[#F8FAFC]"
                  onClick={handleLogout}
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
