"use client";

import {
  createContext,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { usePathname, useSearchParams } from "next/navigation";

import { ActivityTracker } from "@/components/activity/activity-tracker";
import { hardNavigate } from "@/lib/navigation/browser-navigation";
import {
  ROUTE_STALL_DEADLINE_MS,
  ROUTE_STALL_DISMISS_LABEL,
  ROUTE_STALL_MESSAGE,
  ROUTE_STALL_RETRY_LABEL,
  routeStallRetry,
} from "@/lib/navigation/route-stall";

export const ROUTE_TRANSITION_EVENT = "phoenix:route-transition";

type RouteTransitionContextValue = {
  pending: boolean;
  startTransition: (href?: string) => void;
};

const RouteTransitionContext = createContext<RouteTransitionContextValue>({
  pending: false,
  startTransition: () => {},
});

function normalizeInternalHref(href: string) {
  try {
    const url = new URL(href, window.location.href);
    if (url.origin !== window.location.origin) return null;
    return `${url.pathname}${url.search}`;
  } catch {
    return null;
  }
}

function isModifiedClick(event: MouseEvent | ReactMouseEvent) {
  return event.metaKey || event.ctrlKey || event.shiftKey || event.altKey;
}

export function announceRouteTransition(href?: string) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(ROUTE_TRANSITION_EVENT, { detail: { href } }));
}

export function useRouteTransition() {
  return useContext(RouteTransitionContext);
}

export function RouteTransitionProvider({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const routeKey = `${pathname}?${searchParams.toString()}`;
  const previousRouteKey = useRef(routeKey);
  const timeoutRef = useRef<number | null>(null);
  const [pending, setPending] = useState(false);
  // Where the navigation now in flight was going, so a retry can go there rather than reload the
  // page the rep already left. Null for a back/forward, which Phoenix did not start.
  const wantedHrefRef = useRef<string | null>(null);
  // Where the rep was when it started, so the deadline can tell "the page never came" from "the
  // page came by some route this provider did not re-render for".
  const fromUrlRef = useRef<string | null>(null);
  // Whether this transition is one a navigation was really attempted for. A document click is a
  // GUESS — the listener runs in the capture phase, so an anchor whose own handler is about to
  // call preventDefault and open a panel instead looks identical to a link at that moment.
  const eligibleRef = useRef(false);
  // Counts intents, so a prevented click that then announced a real route (every portal rail link
  // does exactly that) is not mistaken for one that navigated nowhere.
  const intentSeqRef = useRef(0);
  // Set only by the deadline below, which the route arriving cancels — so it means "nine seconds
  // and the page never came", never "the page was slow".
  const [stalledHref, setStalledHref] = useState<string | null>(null);
  const [stalled, setStalled] = useState(false);

  useEffect(() => {
    document.documentElement.setAttribute("data-route-transition-ready", "true");
    return () => {
      document.documentElement.removeAttribute("data-route-transition-ready");
    };
  }, []);

  function clearPendingSoon() {
    if (timeoutRef.current) window.clearTimeout(timeoutRef.current);
    timeoutRef.current = window.setTimeout(() => setPending(false), 180);
    // The page arrived, so there is nothing to retry — whether the notice was showing or the
    // navigation simply took longer than the deadline and then landed on its own.
    wantedHrefRef.current = null;
    setStalled(false);
    setStalledHref(null);
  }

  function startTransition(href?: string) {
    let wanted: string | null = null;
    if (href) {
      const normalized = normalizeInternalHref(href);
      const current = `${window.location.pathname}${window.location.search}`;
      if (!normalized || normalized === current) return;
      wanted = normalized;
    }

    wantedHrefRef.current = wanted;
    fromUrlRef.current = `${window.location.pathname}${window.location.search}`;
    eligibleRef.current = true;
    intentSeqRef.current += 1;
    setStalled(false);
    setStalledHref(null);
    setPending(true);
    if (timeoutRef.current) window.clearTimeout(timeoutRef.current);
    timeoutRef.current = window.setTimeout(() => {
      setPending(false);
      // Nine seconds without the route key changing: the router's own fetch died, silently, and
      // taking the progress bar away is all that used to happen here.
      if (!eligibleRef.current) return;
      const now = `${window.location.pathname}${window.location.search}`;
      if (fromUrlRef.current !== null && fromUrlRef.current !== now) return;
      setStalledHref(wantedHrefRef.current);
      setStalled(true);
    }, ROUTE_STALL_DEADLINE_MS);
  }

  function retryStalledNavigation() {
    const retry = routeStallRetry(stalledHref);
    setStalled(false);
    setStalledHref(null);
    if (retry.kind === "navigate") hardNavigate(retry.href);
    else window.location.reload();
  }

  useEffect(() => {
    if (previousRouteKey.current !== routeKey) {
      previousRouteKey.current = routeKey;
      clearPendingSoon();
    }
  }, [routeKey]);

  useEffect(() => {
    function onRouteIntent(event: Event) {
      const detail = event instanceof CustomEvent ? event.detail as { href?: string } : undefined;
      startTransition(detail?.href);
    }

    function onDocumentClick(event: MouseEvent) {
      if (event.defaultPrevented || event.button !== 0 || isModifiedClick(event)) return;
      const target = event.target instanceof Element ? event.target : null;
      const anchor = target?.closest<HTMLAnchorElement>("a[href]");
      if (!anchor || anchor.target || anchor.hasAttribute("download")) return;
      startTransition(anchor.href);
      // The progress bar still appears at once, as it always has. But this listener is in the
      // CAPTURE phase, so `defaultPrevented` above is answered before the anchor's own handler has
      // had its turn: a control that looks like a link and opens a panel instead would otherwise
      // grow a "this page did not open" notice nine seconds later. Read it again once the event is
      // done — and leave the transition eligible when something announced a real route meanwhile,
      // which is what every portal rail link does after preventing its own default.
      const seqAtClick = intentSeqRef.current;
      window.setTimeout(() => {
        if (event.defaultPrevented && intentSeqRef.current === seqAtClick) eligibleRef.current = false;
      }, 0);
    }

    function onPopState() {
      startTransition();
    }

    window.addEventListener(ROUTE_TRANSITION_EVENT, onRouteIntent);
    window.addEventListener("popstate", onPopState);
    document.addEventListener("click", onDocumentClick, true);
    return () => {
      window.removeEventListener(ROUTE_TRANSITION_EVENT, onRouteIntent);
      window.removeEventListener("popstate", onPopState);
      document.removeEventListener("click", onDocumentClick, true);
      if (timeoutRef.current) window.clearTimeout(timeoutRef.current);
    };
  }, []);

  useEffect(() => {
    document.documentElement.toggleAttribute("data-route-transition-pending", pending);
  }, [pending]);

  const value = useMemo(() => ({ pending, startTransition }), [pending]);

  return (
    <RouteTransitionContext.Provider value={value}>
      <ActivityTracker />
      {pending ? (
        <div aria-hidden="true" className="phoenix-route-transition-indicator">
          <div className="phoenix-route-transition-bar" />
        </div>
      ) : null}
      {stalled ? (
        <div
          className="fixed inset-x-0 top-0 z-[91] flex min-w-0 flex-wrap items-center gap-2 border-b border-slate-900 bg-slate-900 px-3 py-2 text-sm font-semibold leading-6 text-white sm:px-4"
          role="alert"
        >
          <span className="min-w-0 flex-1 break-words">{ROUTE_STALL_MESSAGE}</span>
          <button
            className="min-h-[36px] shrink-0 rounded-none border border-orange-500 bg-orange-600 px-3 py-1.5 text-sm font-black text-white hover:bg-orange-500"
            onClick={retryStalledNavigation}
            type="button"
          >
            {ROUTE_STALL_RETRY_LABEL}
          </button>
          <button
            aria-label={ROUTE_STALL_DISMISS_LABEL}
            className="min-h-[36px] shrink-0 rounded-none border border-slate-600 px-3 py-1.5 text-sm font-bold text-slate-200 hover:bg-slate-800"
            onClick={() => {
              setStalled(false);
              setStalledHref(null);
            }}
            type="button"
          >
            {ROUTE_STALL_DISMISS_LABEL}
          </button>
        </div>
      ) : null}
      {children}
    </RouteTransitionContext.Provider>
  );
}
