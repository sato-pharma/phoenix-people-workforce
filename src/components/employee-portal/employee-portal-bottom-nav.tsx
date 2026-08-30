"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Lock } from "lucide-react";

import { isNavItemLockedFor, useLockedModuleKeys } from "@/components/layout/module-lock-context";
import type { EmployeePortalNavVisibility } from "@/lib/employee-portal/navigation";
import {
  DEFAULT_BOTTOM_NAV_HREFS,
  HOME_ENTRY,
  MAX_BOTTOM_NAV_CUSTOM,
  PROFILE_ENTRY,
  type PortalNavEntry,
  entryByHref,
  visiblePortalNavEntries,
} from "./employee-portal-nav-registry";
import { useBottomNavPreference } from "./use-bottom-nav-preference";

function isActiveHref(pathname: string, href: string) {
  if (href === "/employee-portals") return pathname === href;
  return pathname === href || pathname.startsWith(`${href}/`);
}

/**
 * Mobile-only global bottom tab bar for the employee portal. Presentation only —
 * destinations are derived from the resolved navigation visibility flags (no new
 * permission lookups) and an optional per-device user preference; every page
 * keeps its own server-side guard. Hidden on lg+ where the sidebar takes over.
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
  const [selected] = useBottomNavPreference();
  // A tab a system administrator has temporarily locked keeps its place here too. On a phone this
  // bar IS the navigation — a rep who never opens the drawer would otherwise meet the lock only
  // after tapping, with no warning on the tab itself.
  const lockedModuleKeys = useLockedModuleKeys();

  const visibleHrefs = new Set(visiblePortalNavEntries(visibility).map((entry) => entry.href));

  // User-pinned shortcuts (kept only if still visible), else the role defaults.
  const pinned = selected.filter((href) => visibleHrefs.has(href));
  const middleHrefs = (pinned.length > 0
    ? pinned
    : DEFAULT_BOTTOM_NAV_HREFS.filter((href) => visibleHrefs.has(href))
  ).slice(0, MAX_BOTTOM_NAV_CUSTOM);

  const middle = middleHrefs
    .map((href) => entryByHref(href))
    .filter((entry): entry is PortalNavEntry => Boolean(entry));

  const items: PortalNavEntry[] = [HOME_ENTRY, ...middle, PROFILE_ENTRY];

  return (
    <nav
      aria-label="Employee portal"
      className="fixed inset-x-0 bottom-0 z-40 border-t border-slate-200/90 bg-white/97 shadow-[0_-12px_34px_rgba(15,23,42,0.10)] backdrop-blur-xl lg:hidden"
      style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
    >
      <ul className="mx-auto flex max-w-[640px] items-stretch justify-around px-1">
        {items.map((item) => {
          const active = isActiveHref(pathname, item.href);
          const locked = isNavItemLockedFor({ href: item.href }, lockedModuleKeys);
          const Icon = locked ? Lock : item.icon;
          return (
            <li className="flex-1" key={`${item.label}-${item.href}`}>
              <Link
                aria-current={active ? "page" : undefined}
                aria-label={locked ? `${item.label} — locked` : undefined}
                className={`mx-0.5 flex h-[60px] min-w-0 flex-col items-center justify-center gap-0.5 rounded text-phx-2xs font-black transition-colors ${
                  active
                    ? "bg-orange-50 text-orange-700 ring-1 ring-orange-100"
                    : locked
                      ? "text-amber-600 active:text-amber-700"
                      : "text-slate-500 active:text-slate-700"
                }`}
                href={item.href}
              >
                <Icon className="h-[19px] w-[19px] shrink-0" />
                <span className="whitespace-nowrap px-1 leading-tight">{item.label}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
