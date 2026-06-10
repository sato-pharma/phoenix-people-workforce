"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  CalendarDays,
  CircleDollarSign,
  ClipboardCheck,
  Gift,
  Home,
  LineChart,
  type LucideIcon,
  ReceiptText,
  Send,
  Trophy,
  User,
} from "lucide-react";

import type { EmployeePortalNavVisibility } from "@/lib/employee-portal/navigation";

type BottomNavItem = {
  href: string;
  icon: LucideIcon;
  label: string;
};

// Curated priority of primary portal destinations for the mobile bottom bar.
// Each entry is gated by the same visibility flag the sidebar uses, so the bar
// adapts to the signed-in role. Keep hrefs/flags in sync with
// buildEmployeePortalSections in employee-portal-layout.tsx.
const PRIMARY_CANDIDATES: Array<{
  flag: keyof EmployeePortalNavVisibility;
  href: string;
  icon: LucideIcon;
  label: string;
}> = [
  { flag: "showPlansTab", href: "/employee-portals/plans", icon: CalendarDays, label: "Plans" },
  { flag: "showMyPerformanceTab", href: "/employee-portals/sales", icon: LineChart, label: "Performance" },
  { flag: "showTeamPerformanceTab", href: "/employee-portals/team-performance", icon: Trophy, label: "Team" },
  { flag: "showMarketingRequestsTab", href: "/employee-portals/marketing-requests", icon: Send, label: "Marketing" },
  { flag: "showManagementTab", href: "/employee-portals/expense-dashboard", icon: CircleDollarSign, label: "Expenses" },
  { flag: "showMedicalRepExpensesTab", href: "/employee-portals/expenses", icon: ReceiptText, label: "Expenses" },
  { flag: "showIncentiveTab", href: "/employee-portals/incentive", icon: Gift, label: "Incentive" },
  { flag: "showMyCoachingTab", href: "/employee-portals/coaching", icon: ClipboardCheck, label: "Coaching" },
];

function isActiveHref(pathname: string, href: string) {
  if (href === "/employee-portals") return pathname === href;
  return pathname === href || pathname.startsWith(`${href}/`);
}

/**
 * Mobile-only global bottom tab bar for the employee portal. Presentation only —
 * items are derived from the already-resolved navigation visibility flags (no new
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

  // Home + up to three role-primary destinations + Profile.
  const middle = PRIMARY_CANDIDATES.filter((candidate) => visibility[candidate.flag]).slice(0, 3);
  const items: BottomNavItem[] = [
    { href: "/employee-portals", icon: Home, label: "Home" },
    ...middle.map(({ href, icon, label }) => ({ href, icon, label })),
    { href: "/employee-portals/profile", icon: User, label: "Profile" },
  ];

  return (
    <nav
      aria-label="Employee portal"
      className="fixed inset-x-0 bottom-0 z-40 border-t border-slate-200 bg-white/95 backdrop-blur lg:hidden"
      style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
    >
      <ul className="mx-auto flex max-w-[640px] items-stretch justify-around">
        {items.map((item) => {
          const Icon = item.icon;
          const active = isActiveHref(pathname, item.href);
          return (
            <li className="flex-1" key={`${item.label}-${item.href}`}>
              <Link
                aria-current={active ? "page" : undefined}
                className={`flex h-14 flex-col items-center justify-center gap-0.5 text-[10px] font-bold transition-colors ${
                  active ? "text-orange-600" : "text-slate-500 active:text-slate-700"
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
