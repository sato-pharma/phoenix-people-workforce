"use client";

import { Bell, ChevronDown, LogOut, Mail, Menu, Search, UserCog } from "lucide-react";
import Link from "next/link";
import { useState } from "react";

import { PhoenixLogo } from "@/components/brand/phoenix-logo";
import { MobileSidebar } from "@/components/layout/sidebar";
import { type NavigationMode } from "@/lib/auth/permissions";
import type { PermissionLookup } from "@/components/layout/sidebar";
import { ThemeToggle } from "@/components/layout/theme-toggle";
import { Input } from "@/components/ui/input";

function getInitials(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return name.slice(0, 2).toUpperCase();
}

export function Topbar({
  currentUser,
  navigationMode = "admin",
  permissionLookup = {},
}: {
  currentUser?: { name: string; loginId: string; role: string };
  navigationMode?: NavigationMode;
  permissionLookup?: PermissionLookup;
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
      <header className="sticky top-0 z-20 flex min-h-16 items-center gap-2 border-b border-[#E2E8F0] bg-white/95 px-3 py-2 backdrop-blur sm:min-h-20 sm:gap-4 sm:px-6">
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

        <div className="relative hidden max-w-xl flex-1 md:block">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[#64748B]" />
          <Input
            aria-label="Search"
            className="bg-[#F8FAFC] pl-9 border-[#E2E8F0]"
            placeholder="Search employees, reports, pages..."
          />
        </div>

        <div className="ml-auto flex shrink-0 items-center gap-1.5 sm:gap-3">
          <ThemeToggle />
          <button className="hidden h-10 w-10 items-center justify-center rounded-lg text-[#64748B] hover:bg-[#F8FAFC] hover:text-[#0F172A] sm:inline-flex">
            <Bell className="h-5 w-5" />
          </button>
          <button className="hidden h-10 w-10 items-center justify-center rounded-lg text-[#64748B] hover:bg-[#F8FAFC] hover:text-[#0F172A] sm:inline-flex">
            <Mail className="h-5 w-5" />
          </button>
          <div className="relative">
            <button
              className="flex items-center gap-2 rounded-full border border-[#E2E8F0] bg-white py-1 pl-1 pr-2 sm:gap-3 sm:pr-3 hover:bg-[#F8FAFC]"
              onClick={() => setUserMenuOpen(!userMenuOpen)}
              type="button"
            >
              <div className="flex h-9 w-9 items-center justify-center rounded-full bg-[#F97316]/15 text-xs font-black text-[#F97316] ring-[#F97316]/20 ring-1">
                {getInitials(currentUser?.name ?? "U")}
              </div>
              <div className="hidden text-left sm:block">
                <p className="text-sm font-semibold text-[#0F172A]">{currentUser?.name ?? "User"}</p>
                <p className="text-xs text-[#64748B]">{currentUser?.role ?? "User"}</p>
              </div>
              <ChevronDown className="hidden h-4 w-4 text-[#64748B] sm:block" />
            </button>

            {userMenuOpen && (
              <div className="absolute right-0 top-full mt-2 w-48 rounded-lg border border-[#E2E8F0] bg-white shadow-lg">
                <Link
                  className="flex w-full items-center gap-2 px-4 py-2 text-sm text-[#0F172A] hover:bg-[#F8FAFC]"
                  href="/admin/profile"
                  onClick={() => setUserMenuOpen(false)}
                >
                  <UserCog className="h-4 w-4" />
                  My Profile
                </Link>
                <div className="mx-3 h-px bg-[#E2E8F0]" />
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
      </header>
    </>
  );
}
