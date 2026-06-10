"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { CalendarDays, Home, type LucideIcon, Plus, User } from "lucide-react";

import type { EmployeePortalNavVisibility } from "@/lib/employee-portal/navigation";

type BottomNavItem = {
  href: string;
  icon: LucideIcon;
  isActive: boolean;
  label: string;
  primary?: boolean;
};

/**
 * Mobile-only bottom tab bar for the employee portal. Presentation only — items
 * are derived from the already-resolved navigation visibility flags (no new
 * permission lookups), and every destination keeps its own server-side guard.
 * Hidden on lg+ where the sidebar takes over.
 */
export function EmployeePortalBottomNav({
  activePathOverride,
  visibility,
}: {
  activePathOverride?: string;
  visibility: EmployeePortalNavVisibility;
}) {
  const currentPathname = usePathname();
  const pathname = activePathOverride ?? currentPathname;
  const onPlans = pathname === "/employee-portals/plans" || pathname.startsWith("/employee-portals/plans/");

  const items: BottomNavItem[] = [
    {
      href: "/employee-portals",
      icon: Home,
      isActive: pathname === "/employee-portals",
      label: "Home",
    },
  ];

  if (visibility.showPlansTab) {
    items.push({
      href: "/employee-portals/plans",
      icon: CalendarDays,
      isActive: onPlans,
      label: "My Plans",
    });
    items.push({
      href: "/employee-portals/plans?new=1",
      icon: Plus,
      isActive: false,
      label: "New Plan",
      primary: true,
    });
  }

  items.push({
    href: "/employee-portals/profile",
    icon: User,
    isActive: pathname.startsWith("/employee-portals/profile"),
    label: "Profile",
  });

  return (
    <nav
      aria-label="Employee portal"
      className="fixed inset-x-0 bottom-0 z-40 border-t border-slate-200 bg-white/95 backdrop-blur lg:hidden"
      style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
    >
      <ul className="mx-auto flex max-w-[640px] items-stretch justify-around">
        {items.map((item) => {
          const Icon = item.icon;
          if (item.primary) {
            return (
              <li className="flex flex-1 justify-center" key={item.label}>
                <Link
                  aria-label={item.label}
                  className="-mt-5 flex h-14 w-14 flex-col items-center justify-center rounded-full bg-orange-600 text-white shadow-lg shadow-orange-600/30 transition-transform active:scale-95"
                  href={item.href}
                >
                  <Icon className="h-6 w-6" />
                </Link>
              </li>
            );
          }
          return (
            <li className="flex-1" key={item.label}>
              <Link
                className={`flex h-14 flex-col items-center justify-center gap-0.5 text-[10px] font-bold transition-colors ${
                  item.isActive ? "text-orange-600" : "text-slate-500 active:text-slate-700"
                }`}
                href={item.href}
              >
                <Icon className="h-5 w-5" />
                {item.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
