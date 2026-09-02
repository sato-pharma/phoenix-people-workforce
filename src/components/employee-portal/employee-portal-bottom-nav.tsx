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
                {/*
                  The label WRAPS rather than running on one line, and the box it wraps inside is a
                  fixed two lines tall.

                  Both halves matter. Six tabs is the maximum (Home + MAX_BOTTOM_NAV_CUSTOM +
                  Profile) and each <li> is `flex-1` with Tailwind's default `min-width: auto`, so a
                  tab can never be laid out narrower than its own content — which means the bar's
                  real constraint is the SUM of the six tabs' floors against the viewport, not any
                  per-tab allowance. On `whitespace-nowrap` that floor was the whole label, and the
                  worst case (Direct Order | Double Visit | ROI Tracker | Deductions) summed to
                  367px: it cleared a 375px phone by 8px and overflowed a 360px one, which is the
                  most common Android width there is. Wrapping drops each floor to the longest WORD,
                  so those four fall out of the worst case entirely and the bar fits from 320px.

                  Wrapping is the owner's prescribed answer here — the golden rule is never a
                  horizontal scroll, fit by wrapping and never by shrinking type, and the ellipsis
                  ban means `truncate` was never available either.

                  The fixed `h-[25px]` is what keeps the row honest once labels wrap: without it a
                  tab whose label takes two lines is taller than its neighbours, and `justify-center`
                  then centres each tab's icon at a different height. Two lines are reserved for
                  every tab whether or not it uses them, and the text is centred inside that box, so
                  a one-line label sits within a pixel of where it always has.
                */}
                <span className="flex h-[25px] items-center justify-center px-0.5 text-center leading-tight">
                  {item.label}
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
