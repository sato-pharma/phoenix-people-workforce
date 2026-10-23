"use client";

import { useLayoutEffect, useRef } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Lock } from "lucide-react";

import { isNavItemLockedFor, useLockedModuleKeys } from "@/components/layout/module-lock-context";
import { ApprovalNavBadge } from "@/components/layout/nav-badge";
import type { EmployeePortalNavVisibility } from "@/lib/employee-portal/navigation";
import { tapHaptic } from "@/lib/employee-portal/haptics";
import { homeTabWaitingBadges, type PortalNavBadge } from "@/lib/employee-portal/portal-chrome";
import { resolveDeepestActiveHref } from "@/lib/navigation/active-path";
import { useChromeHiddenOnScrollDown, usePrefersReducedMotion } from "./portal-chrome-hooks";
import { PortalBottomNavQuickActions } from "./portal-bottom-nav-widgets";
import { PortalAvatar, PortalPendingCount } from "./portal-chrome-widgets";
import {
  HOME_ENTRY,
  MAX_BOTTOM_NAV_CUSTOM,
  PROFILE_ENTRY,
  type PortalNavEntry,
  defaultBottomNavHrefs,
  entryByHref,
  visiblePortalNavEntries,
} from "./employee-portal-nav-registry";
import { useBottomNavPreference } from "./use-bottom-nav-preference";

/**
 * The portal root is lit on its own page only — every portal path starts with it. Same set the
 * sidebar passes (EXACT_ONLY_PORTAL_HREFS in employee-portal-layout.tsx).
 */
const EXACT_ONLY_BOTTOM_NAV_HREFS = new Set(["/employee-portals"]);

/**
 * Mobile-only global bottom tab bar for the employee portal. Presentation only —
 * destinations are derived from the resolved navigation visibility flags (no new
 * permission lookups) and an optional per-device user preference; every page
 * keeps its own server-side guard. Hidden on lg+ where the sidebar takes over.
 */
export function EmployeePortalBottomNav({
  activePathOverride,
  fullName,
  photoSrc,
  visibility,
}: {
  activePathOverride?: string;
  /** The signed-in person's name — the Profile tab falls back to their initials. */
  fullName: string;
  /** Their uploaded photo, else the bundled one, else null for initials. */
  photoSrc: string | null;
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
    : defaultBottomNavHrefs(visibility).filter((href) => visibleHrefs.has(href))
  ).slice(0, MAX_BOTTOM_NAV_CUSTOM);

  const middle = middleHrefs
    .map((href) => entryByHref(href))
    .filter((entry): entry is PortalNavEntry => Boolean(entry));

  const items: PortalNavEntry[] = [HOME_ENTRY, ...middle, PROFILE_ENTRY];

  const reducedMotion = usePrefersReducedMotion();
  // Out of the way while reading, back the instant the finger goes the other way (owner,
  // 2026-09-29). The page's bottom reservation deliberately does NOT shrink with it: a reserve that
  // moved would reflow the whole page on every change of direction, and the promise that the last
  // row is reachable has to hold at the moment the bar comes back.
  const chromeHidden = useChromeHiddenOnScrollDown();
  const listRef = useRef<HTMLUListElement>(null);
  const markerRef = useRef<HTMLLIElement>(null);

  // The sliding marker, transposed from the sidebar's (employee-portal-layout.tsx): ONE orange bar
  // that glides sideways to the lit tab, rather than a bar drawn under each one. Placed by writing
  // its style directly — a DOM measurement, not React state, so there is no render loop and no
  // setState inside an effect. It lands without animating the first time, so a page load does not
  // show it flying in from the left edge. Reduced motion turns the glide off in CSS.
  //
  // `top-0`, not `bottom-0`: at the foot of the bar the home-indicator inset would eat it on a
  // phone that has one.
  // A resize re-places it too. The sidebar's marker can get away without that because its rows keep
  // their height whatever the window does; these six tabs share the viewport's width, so every tab's
  // offsetLeft moves when the phone rotates — and a resize alone renders nothing, so with no listener
  // the bar sat at 320px with a marker still measured for 375px (seen in the running app).
  useLayoutEffect(() => {
    const list = listRef.current;
    const marker = markerRef.current;
    if (!list || !marker) return;
    const place = () => {
      const tab = list.querySelector<HTMLElement>('[data-active-tab="true"]');
      if (!tab) {
        marker.style.opacity = "0";
        return;
      }
      const firstPlacement = marker.dataset.placed !== "true";
      if (firstPlacement) marker.style.transition = "none";
      marker.style.width = `${tab.offsetWidth}px`;
      marker.style.transform = `translateX(${tab.offsetLeft}px)`;
      marker.style.opacity = "1";
      if (firstPlacement) {
        void marker.offsetHeight;
        marker.style.transition = "";
        marker.dataset.placed = "true";
      }
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("orientationchange", place);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("orientationchange", place);
    };
  });

  // Home speaks for every queue this viewer owns that has no tab of its own (owner, 2026-09-29).
  // Derived from the registry rather than the sidebar's section objects, which this component has
  // never had. Subscribing costs no extra request: PortalPendingCount rides the same batched
  // 30-second badge poll the tab badges above already ride.
  const homeWaitingBadges = homeTabWaitingBadges(
    visiblePortalNavEntries(visibility).flatMap((entry) => (entry.navBadge ? [entry.navBadge as PortalNavBadge] : [])),
    items.flatMap((item) => (item.navBadge ? [item.navBadge as PortalNavBadge] : [])),
  );
  // ONE lit tab — the deepest matching href, as the sidebar does. A plain prefix test lit two tabs
  // at once whenever a parent and its child were both on the bar: a District Manager's default bar
  // carries Plans (/plans) AND Planning (/plans/calendar), so on the calendar both were highlighted
  // and the bar could not say which page he was on. Same for Marketing + Inbox, Awareness + its
  // inbox, and the Training Manager's Overview over every one of his own pages.
  const activeHref = resolveDeepestActiveHref(
    pathname,
    items.map((item) => item.href),
    EXACT_ONLY_BOTTOM_NAV_HREFS,
  );

  return (
    <>
    {/* The thumb-zone action button. Rendered from here, not the layout, so it inherits this
        component's own two guards for free: the layout drops the whole bar in focus mode, and being
        inside `.employee-portal-shell` its corners are squared by the shell's own CSS. */}
    <PortalBottomNavQuickActions chromeHidden={chromeHidden} visibility={visibility} />
    <nav
      aria-label="Employee portal"
      className={`fixed inset-x-0 bottom-0 z-40 border-t border-slate-200/90 bg-white/97 shadow-[0_-12px_34px_rgba(15,23,42,0.10)] backdrop-blur-xl transition-transform duration-200 ease-out motion-reduce:transition-none lg:hidden ${
        chromeHidden ? "translate-y-full" : ""
      }`}
      style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
    >
      <ul className="relative mx-auto flex max-w-[640px] items-stretch justify-around px-1" ref={listRef}>
        {/* An <li>, not a <span>: a <ul> may only contain list items, and being out of flow
            (`absolute`) it takes no width from the six real tabs. */}
        <li
          aria-hidden="true"
          className="pointer-events-none absolute left-0 top-0 z-10 h-[3px] bg-[#F05A1A] opacity-0 shadow-[0_0_14px_rgba(240,90,26,0.85)] transition-[transform,width,opacity] duration-300 ease-out motion-reduce:transition-none"
          ref={markerRef}
        />
        {items.map((item) => {
          const active = item.href === activeHref;
          const locked = isNavItemLockedFor({ href: item.href }, lockedModuleKeys);
          const Icon = locked ? Lock : item.icon;
          return (
            <li className="flex-1" data-active-tab={active ? "true" : undefined} key={`${item.label}-${item.href}`}>
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
                // At the PRESS, not the tap: feedback that waits for the click arrives after the
                // finger has already left, which reads as lag rather than confirmation. Touch only —
                // a mouse or a stylus gets nothing, and reduced motion silences it (haptics.ts).
                onPointerDown={(event) => {
                  if (event.pointerType === "touch") tapHaptic(reducedMotion);
                }}
                // On screen the tab prefetches down to the page's loading.tsx only, never the full
                // page on touch (next.config.ts, beside `staleTimes`, explains why).
              >
                {/*
                  The pending-count badge, as the COMPACT dot on the icon rather than the count
                  pill the sidebar uses.

                  On a phone this bar IS the navigation, so a queue with nothing on its tab is a
                  queue nobody is told about — the failure the sidebar badges already prevent, on
                  the surface where it costs most. Owner, 2026-09-07.

                  The dot, never the pill: six tabs share a 375px bar and every label is already
                  wrapped to fit it (see the note below), so a pill would take its width out of the
                  label — and the golden rule forbids both shrinking the type and truncating it.
                  The dot is absolutely positioned, so it adds nothing to any tab's layout floor
                  and the bar's width arithmetic is untouched.

                  `relative` on this wrapper is what the dot anchors to; it is sized to the icon so
                  the dot sits on the glyph's corner rather than the tab's. The badge rings itself
                  in white, which is this bar (`bg-white/97`) — the first compact badge the portal
                  has ever rendered on a light surface, and the reason ApprovalNavBadge's `dark`
                  prop is left at its default here rather than passed.

                  A LOCKED tab keeps its badge, exactly as the sidebar row does: the count is still
                  true, and the lock icon is already the tab's own message.

                  `showCount` (owner, 2026-09-29): the badge shows the NUMBER here, not a bare dot.
                  That reverses his 2026-09-07 ruling for this one surface, and he confirmed it
                  knowing so — the reason he gave then was that a count "would take its width out of
                  the label", and this badge is absolutely positioned, so it spends none. It stays
                  the COMPACT badge; the sidebar's in-flow pill is still banned here, and the test
                  that enforces that reads this file's raw text, so do not name the pill's prop in a
                  comment.
                */}
                <span className="relative flex h-[19px] w-[19px] shrink-0 items-center justify-center">
                  {/* The Profile tab wears the person's own face (owner, 2026-09-29), matching the
                      avatar in the top bar. Same 19px box as every other tab's glyph, so the bar's
                      height and the width model are untouched. A LOCKED Profile keeps the padlock —
                      the lock is the tab's message and it outranks the decoration. */}
                  {item.href === PROFILE_ENTRY.href && !locked ? (
                    <PortalAvatar fullName={fullName} photoSrc={photoSrc} size="h-[19px] w-[19px]" />
                  ) : (
                    <Icon className="h-[19px] w-[19px] shrink-0" />
                  )}
                  <ApprovalNavBadge compact navBadge={item.navBadge} showCount />
                  {item.href === HOME_ENTRY.href && homeWaitingBadges.length > 0 ? (
                    <PortalPendingCount navBadges={homeWaitingBadges} tone="menu" />
                  ) : null}
                </span>
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

                  The fixed `h-[26px]` is what keeps the row honest once labels wrap: without it a
                  tab whose label takes two lines is taller than its neighbours, and `justify-center`
                  then centres each tab's icon at a different height. Two lines are reserved for
                  every tab whether or not it uses them, and the text is centred inside that box, so
                  a one-line label sits within a pixel of where it always has.

                  26px, not the 25px two line-boxes suggest: the line box is 12.5px but a wrapped
                  label measures scrollHeight 26 against clientHeight 25 in Chromium, so 25 clipped
                  the second line by a pixel. Measured in the running app, not derived.
                */}
                <span className="flex h-[26px] items-center justify-center px-0.5 text-center leading-tight">
                  {item.label}
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
    </>
  );
}
