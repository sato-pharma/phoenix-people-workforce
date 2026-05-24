"use client";

import { ChevronDown, LogOut, Menu, Search, UserCog } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";

import { PhoenixLogo } from "@/components/brand/phoenix-logo";
import { InAppNotificationsBell } from "@/components/layout/in-app-notifications-bell";
import { InternalMessagesMenu } from "@/components/layout/internal-messages-menu";
import { MobileSidebar } from "@/components/layout/sidebar";
import { type NavigationMode, type PhoenixRole } from "@/lib/auth/permissions";
import type { PermissionLookup } from "@/components/layout/sidebar";
import type { ViewerIdentity } from "@/lib/auth/server";
import { Input } from "@/components/ui/input";

export function Topbar({
  navigationMode = "admin",
  permissionLookup = {},
  viewer,
  currentRole,
}: {
  currentRole?: PhoenixRole;
  navigationMode?: NavigationMode;
  permissionLookup?: PermissionLookup;
  viewer: ViewerIdentity;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const [mobileSearchOpen, setMobileSearchOpen] = useState(false);
  const userMenuRef = useRef<HTMLDivElement>(null);
  const mobileSearchRef = useRef<HTMLInputElement>(null);
  const isAdminMode = navigationMode === "admin";
  const profileHref = isAdminMode ? "/admin/profile" : "/employee-portals/profile";
  const handleLogout = async () => {
    try {
      await fetch("/api/auth/logout", { method: "POST" });
      window.location.href = "/login";
    } catch (error) {
      console.error("Logout failed:", error);
    }
  };

  useEffect(() => {
    function handlePointerDown(event: PointerEvent) {
      if (
        userMenuOpen &&
        userMenuRef.current &&
        !userMenuRef.current.contains(event.target as Node)
      ) {
        setUserMenuOpen(false);
      }
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setUserMenuOpen(false);
        setMobileSearchOpen(false);
      }
    }

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [userMenuOpen]);

  useEffect(() => {
    if (mobileSearchOpen) {
      mobileSearchRef.current?.focus();
    }
  }, [mobileSearchOpen]);

  return (
    <>
      <MobileSidebar
        navigationMode={navigationMode}
        currentRole={currentRole}
        onClose={() => setMenuOpen(false)}
        open={menuOpen}
        permissionLookup={permissionLookup}
      />
      <header className={`sticky top-0 z-40 border-b px-3 py-3 shadow-[0_10px_28px_rgba(15,23,42,0.08)] backdrop-blur-xl sm:px-6 ${
        isAdminMode
          ? "border-[#1a1a1a] bg-[#000000]/96"
          : "border-[#E2E8F0]/80 bg-white/92"
      }`}>
        <div className="mx-auto flex min-h-14 w-full max-w-[1480px] flex-wrap items-center gap-2 sm:min-h-16 sm:gap-4">
        <button
          aria-label="Open menu"
          className={`inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-lg lg:hidden ${
            isAdminMode
              ? "text-[#D4DDE8] hover:bg-[#1a1a1a] hover:text-[#F8B56B]"
              : "text-[#64748B] hover:bg-[#F8FAFC] hover:text-[#0F172A]"
          }`}
          onClick={() => setMenuOpen(true)}
          type="button"
        >
          <Menu className="h-5 w-5" />
        </button>

        <div className="min-w-0 lg:hidden">
          <PhoenixLogo compact />
        </div>

        <div className="relative hidden flex-1 md:block md:max-w-[280px] xl:max-w-xl">
          <Search className={`pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 ${isAdminMode ? "text-[#F8B56B]" : "text-[#64748B]"}`} />
          <Input
            aria-label="Search"
            className={`h-12 rounded-2xl pl-9 ${
              isAdminMode
                ? "border-[#333333] bg-[#0B0B0B] text-[#F8FAFC] shadow-[inset_0_1px_0_rgba(255,255,255,0.04)] placeholder:text-[#64748B] focus:border-[#F97316]"
                : "border-[#E2E8F0] bg-[#FCFDFE] shadow-[inset_0_1px_0_rgba(255,255,255,0.55)]"
            }`}
            placeholder="Search employees, reports, pages..."
          />
        </div>

        <div className="ml-auto flex shrink-0 items-center gap-1.5 sm:gap-3">
          <button
            aria-expanded={mobileSearchOpen}
            aria-label="Open search"
            className={`inline-flex h-10 w-10 items-center justify-center rounded-lg md:hidden ${
            isAdminMode ? "text-[#D4DDE8] hover:bg-[#1a1a1a] hover:text-[#F8B56B]" : "text-[#64748B] hover:bg-[#F8FAFC] hover:text-[#0F172A]"
          }`}
            onClick={() => setMobileSearchOpen((open) => !open)}
            type="button"
          >
            <Search className="h-5 w-5" />
          </button>
          <InAppNotificationsBell isAdminMode={isAdminMode} />
          <InternalMessagesMenu isAdminMode={isAdminMode} />
          <div className="relative" ref={userMenuRef}>
            <button
              aria-expanded={userMenuOpen}
              aria-haspopup="menu"
              className={`flex max-w-[calc(100vw-7rem)] items-center gap-2 rounded-full border py-1 pl-1 pr-2 sm:max-w-none sm:gap-3 sm:pr-3 ${
                isAdminMode
                  ? "border-[#333333] bg-[#0B0B0B] shadow-[0_10px_30px_rgba(0,0,0,0.24)] hover:bg-[#111111]"
                  : "border-[#E2E8F0] bg-white/95 shadow-[0_10px_30px_rgba(15,23,42,0.06)] hover:bg-[#FCFDFE]"
              }`}
              onClick={() => setUserMenuOpen((open) => !open)}
              type="button"
            >
              <div className="flex h-9 w-9 items-center justify-center rounded-full bg-[#F97316]/15 text-xs font-black text-[#F97316] ring-[#F97316]/20 ring-1">
                {viewer.initials}
              </div>
              <div className="hidden text-left sm:block">
                <p className={`text-sm font-semibold ${isAdminMode ? "text-white" : "text-[#0F172A]"}`}>{viewer.displayName}</p>
                <p className={`text-xs ${isAdminMode ? "text-[#94A3B8]" : "text-[#64748B]"}`}>{viewer.roleLabel}</p>
              </div>
              <ChevronDown className={`hidden h-4 w-4 sm:block ${isAdminMode ? "text-[#F8B56B]" : "text-[#64748B]"}`} />
            </button>

            {userMenuOpen && (
              <div className={`absolute right-0 top-full z-50 mt-2 w-64 overflow-hidden rounded-2xl border shadow-[0_22px_50px_rgba(0,0,0,0.22)] ${
                isAdminMode ? "border-[#333333] bg-[#050505]" : "border-[#E2E8F0] bg-white"
              }`} role="menu">
                <Link
                  className={`flex w-full items-center gap-2 px-4 py-2 text-sm ${
                    isAdminMode ? "text-[#D4DDE8] hover:bg-[#1a1a1a] hover:text-[#F8B56B]" : "text-[#0F172A] hover:bg-[#F8FAFC]"
                  }`}
                  href={profileHref}
                  onClick={() => setUserMenuOpen(false)}
                  role="menuitem"
                >
                  <UserCog className="h-4 w-4" />
                  My Profile
                </Link>
                <div className={`px-4 py-2 text-xs ${isAdminMode ? "text-[#94A3B8]" : "text-[#64748B]"}`}>
                  <p className="font-semibold">{viewer.roleLabel}</p>
                  <p className="mt-0.5 truncate">{viewer.displayName}</p>
                </div>
                <div className={`mx-3 h-px ${isAdminMode ? "bg-[#333333]" : "bg-[#E2E8F0]"}`} />
                <button
                  className={`flex w-full items-center gap-2 px-4 py-2 text-sm ${
                    isAdminMode ? "text-[#D4DDE8] hover:bg-[#1a1a1a] hover:text-[#F8B56B]" : "text-[#0F172A] hover:bg-[#F8FAFC]"
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
        {mobileSearchOpen ? (
          <div className="mx-auto mt-2 w-full max-w-[1480px] md:hidden">
            <div className="relative">
              <Search className={`pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 ${isAdminMode ? "text-[#F8B56B]" : "text-[#64748B]"}`} />
              <input
                ref={mobileSearchRef}
                aria-label="Search"
                className={`h-11 w-full rounded-2xl border px-3 pl-9 text-sm font-semibold outline-none transition focus:ring-2 focus:ring-[#F97316]/25 ${
                  isAdminMode
                    ? "border-[#333333] bg-[#0B0B0B] text-[#F8FAFC] placeholder:text-[#64748B] focus:border-[#F97316]"
                    : "border-[#E2E8F0] bg-white text-[#0F172A] placeholder:text-[#94A3B8] focus:border-[#F97316]"
                }`}
                onKeyDown={(event) => {
                  if (event.key === "Escape") setMobileSearchOpen(false);
                }}
                placeholder="Search employees, reports, pages..."
                type="search"
              />
            </div>
          </div>
        ) : null}
      </header>
    </>
  );
}
