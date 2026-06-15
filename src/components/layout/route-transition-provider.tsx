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

  useEffect(() => {
    document.documentElement.setAttribute("data-route-transition-ready", "true");
    return () => {
      document.documentElement.removeAttribute("data-route-transition-ready");
    };
  }, []);

  function clearPendingSoon() {
    if (timeoutRef.current) window.clearTimeout(timeoutRef.current);
    timeoutRef.current = window.setTimeout(() => setPending(false), 180);
  }

  function startTransition(href?: string) {
    if (href) {
      const normalized = normalizeInternalHref(href);
      const current = `${window.location.pathname}${window.location.search}`;
      if (!normalized || normalized === current) return;
    }

    setPending(true);
    if (timeoutRef.current) window.clearTimeout(timeoutRef.current);
    timeoutRef.current = window.setTimeout(() => setPending(false), 9000);
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
      {children}
    </RouteTransitionContext.Provider>
  );
}
