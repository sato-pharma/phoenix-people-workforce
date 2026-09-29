"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { usePathname } from "next/navigation";

import {
  PORTAL_BADGE_SOURCES,
  PORTAL_COLLAPSED_SECTIONS_KEY,
  PORTAL_RECENT_PAGES_KEY,
  nextChromeScrollState,
  parseStoredStringList,
  type ChromeScrollState,
  type PortalNavBadge,
  type QueueReading,
} from "@/lib/employee-portal/portal-chrome";
import { subscribeNavBadge } from "@/lib/nav-badge-store";

// ── Per-device lists (recent pages, folded sections) ────────────────────────
// Same shape as the phone bar's pin store (use-bottom-nav-preference.ts): localStorage, a custom
// event so every surface in this tab updates together, and a cached snapshot so
// useSyncExternalStore gets a stable reference when nothing changed. Storage that throws (a private
// window, blocked site data) reads as an empty list and a write that fails is simply not kept.

const LIST_CHANGE_EVENT = "phoenix-employee-portal-chrome-list-change";
const EMPTY_LIST: readonly string[] = [];
const listCache = new Map<string, { raw: string | null; value: readonly string[] }>();

function readStoredList(key: string): readonly string[] {
  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(key);
  } catch {
    raw = null;
  }
  const cached = listCache.get(key);
  if (cached && cached.raw === raw) return cached.value;
  const value = raw ? parseStoredStringList(raw) : EMPTY_LIST;
  listCache.set(key, { raw, value });
  return value;
}

function subscribeToStoredLists(callback: () => void) {
  window.addEventListener("storage", callback);
  window.addEventListener(LIST_CHANGE_EVENT, callback);
  return () => {
    window.removeEventListener("storage", callback);
    window.removeEventListener(LIST_CHANGE_EVENT, callback);
  };
}

export function writeStoredList(key: string, list: readonly string[]) {
  try {
    window.localStorage.setItem(key, JSON.stringify(list));
  } catch {
    return;
  }
  window.dispatchEvent(new CustomEvent(LIST_CHANGE_EVENT, { detail: key }));
}

/** The current value of a stored list, outside React (the recent-page recorder reads it this way). */
export function readStoredListNow(key: string): readonly string[] {
  return readStoredList(key);
}

function useStoredList(key: string): readonly string[] {
  return useSyncExternalStore(
    subscribeToStoredLists,
    () => readStoredList(key),
    () => EMPTY_LIST,
  );
}

/** The last pages this person opened on this device, newest first. */
export function useRecentPages(): readonly string[] {
  return useStoredList(PORTAL_RECENT_PAGES_KEY);
}

/** The sidebar sections this person has folded away on this device, by title. */
export function useCollapsedSections(): readonly string[] {
  return useStoredList(PORTAL_COLLAPSED_SECTIONS_KEY);
}

/**
 * Whether this device has ever set its own section-fold preference. Until it has, the sidebar opens
 * with every section folded except My Workspace (owner, 2026-09-29); the first fold toggle writes the
 * explicit list and this turns true, so the person's own choice is honoured from then on. The server
 * snapshot is `false`, so the server's HTML and the client's first pass agree on the default.
 */
export function useCollapsePreferenceSet(): boolean {
  return useSyncExternalStore(
    subscribeToStoredLists,
    () => {
      try {
        return window.localStorage.getItem(PORTAL_COLLAPSED_SECTIONS_KEY) !== null;
      } catch {
        return false;
      }
    },
    () => false,
  );
}

// ── Online / offline ─────────────────────────────────────────────────────────

function subscribeToConnection(callback: () => void) {
  window.addEventListener("online", callback);
  window.addEventListener("offline", callback);
  return () => {
    window.removeEventListener("online", callback);
    window.removeEventListener("offline", callback);
  };
}

/**
 * Whether the browser believes it is online. The server snapshot is `true`, so the server's HTML
 * and the client's first pass agree, and the warning appears only once the browser says otherwise.
 */
export function useIsOnline(): boolean {
  return useSyncExternalStore(
    subscribeToConnection,
    () => window.navigator.onLine,
    () => true,
  );
}

// ── Screen width ─────────────────────────────────────────────────────────────

/** Tailwind's `lg` — where the sidebar appears, and where a keyboard can be assumed. */
const WIDE_SCREEN_QUERY = "(min-width: 1024px)";

function subscribeToWideScreen(callback: () => void) {
  const query = window.matchMedia(WIDE_SCREEN_QUERY);
  query.addEventListener("change", callback);
  return () => query.removeEventListener("change", callback);
}

/**
 * Whether the screen is at the sidebar's width. Below it the command bar leaves out the actions
 * that need a keyboard or the sidebar. The server snapshot is `true`; nothing the server renders
 * reads it — the command bar mounts only when opened.
 */
export function useIsWideScreen(): boolean {
  return useSyncExternalStore(
    subscribeToWideScreen,
    () => window.matchMedia(WIDE_SCREEN_QUERY).matches,
    () => true,
  );
}

// ── Reduced motion ───────────────────────────────────────────────────────────

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

function subscribeToReducedMotion(callback: () => void) {
  const query = window.matchMedia(REDUCED_MOTION_QUERY);
  query.addEventListener("change", callback);
  return () => query.removeEventListener("change", callback);
}

/**
 * Whether this person has asked their device not to animate. The visual side of that is handled in
 * CSS by `motion-reduce:` utilities and the sweep in globals.css; this hook exists for the parts CSS
 * cannot reach — chiefly the phone bar's tap buzz, since a request for no motion is the only signal
 * a browser gives for "do not move or vibrate at me". Server snapshot `false`; it is read inside an
 * event handler, so the first-paint value never matters.
 */
export function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(
    subscribeToReducedMotion,
    () => window.matchMedia(REDUCED_MOTION_QUERY).matches,
    () => false,
  );
}

// ── Hiding the phone chrome while reading ────────────────────────────────────

/** The bar a focus must land inside to force the chrome back — the phone bar's own landmark. */
const PORTAL_BOTTOM_NAV_SELECTOR = 'nav[aria-label="Employee portal"]';

/**
 * Whether the phone's bottom bar should be out of the way right now.
 *
 * The decision is the pure rule in portal-chrome.ts; this is the plumbing: a PASSIVE scroll
 * listener (so it can never delay a scroll) whose work is deferred to the next animation frame,
 * and a state write only when the answer actually changes — a scroll fires dozens of times a
 * second and re-rendering the bar on each would cost more than the bar saves.
 *
 * Two things force it back whatever the scroll said. A route change, because a new page starts
 * with its chrome. And a focus landing inside the bar, which is how a keyboard reaches it: without
 * that, Tab would move focus onto a bar translated off the bottom of the screen. The hidden bar is
 * deliberately NOT `inert` for the same reason.
 *
 * It takes no "a sheet is open" flag: the sheet locks body scroll, so no scroll event can fire
 * while one is open, and the button that opens it is hidden along with the bar, so a sheet can
 * only ever be opened from a bar that is already shown.
 */
export function useChromeHiddenOnScrollDown(): boolean {
  const [hidden, setHidden] = useState(false);
  const pathname = usePathname();

  // A new page starts with its chrome. Adjusted DURING RENDER, not in an effect: React's own
  // guidance for resetting state when a prop changes, and the only form the
  // react-hooks/set-state-in-effect rule allows. An effect would paint the new page once with the
  // old page's bar still slid away.
  const [shownFor, setShownFor] = useState(pathname);
  if (shownFor !== pathname) {
    setShownFor(pathname);
    setHidden(false);
  }

  useEffect(() => {
    let state: ChromeScrollState = { hidden: false, lastY: window.scrollY };
    let frame = 0;
    const settle = (next: boolean) => setHidden((current) => (current === next ? current : next));
    const onScroll = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        state = nextChromeScrollState(state, {
          docHeight: document.documentElement.scrollHeight,
          viewportHeight: window.innerHeight,
          y: window.scrollY,
        });
        settle(state.hidden);
      });
    };
    const onFocusIn = (event: FocusEvent) => {
      const target = event.target;
      if (target instanceof Element && target.closest(PORTAL_BOTTOM_NAV_SELECTOR)) {
        state = { hidden: false, lastY: window.scrollY };
        settle(false);
      }
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    document.addEventListener("focusin", onFocusIn);
    return () => {
      window.removeEventListener("scroll", onScroll);
      document.removeEventListener("focusin", onFocusIn);
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, [pathname]);

  return hidden;
}

// ── Live queue counts ────────────────────────────────────────────────────────

/**
 * Live readings for a set of sidebar badges, from the SAME poll the sidebar badges ride
 * (src/lib/nav-badge-store.ts): one batched request every 30 seconds for all of them, however many
 * surfaces are listening. Subscribing here adds a listener, never a request, and never a second
 * desktop alert — those fire once per queue in the store.
 */
export function useQueueReadings(navBadges: readonly PortalNavBadge[]): QueueReading[] {
  const key = navBadges.join("|");
  const [readings, setReadings] = useState<Partial<Record<PortalNavBadge, { count: number | null; overdue: boolean }>>>({});

  useEffect(() => {
    const list = key ? (key.split("|") as PortalNavBadge[]) : [];
    const unsubscribers = list.map((navBadge) =>
      subscribeNavBadge(PORTAL_BADGE_SOURCES[navBadge], (count, overdue) =>
        setReadings((current) => ({ ...current, [navBadge]: { count, overdue } })),
      ),
    );
    return () => unsubscribers.forEach((unsubscribe) => unsubscribe());
  }, [key]);

  return navBadges.map((navBadge) => ({
    count: readings[navBadge]?.count ?? null,
    navBadge,
    overdue: readings[navBadge]?.overdue ?? false,
  }));
}
