"use client";

import { useEffect, useRef } from "react";

/**
 * Publishes the frozen chrome's rendered height as `--phx-chrome-h` on <html>, so a page can pin
 * something UNDER the top bar (Expense Approvals' trip rail, owner 2026-11-07) without hard-coding
 * a height that changes with the viewport, the seat-view banner and the navigation rows.
 *
 * It measures its own parent — the `sticky top-0` block in the app shell — and renders nothing
 * visible. CSS that reads the variable must keep a fallback (`var(--phx-chrome-h, 104px)`) for the
 * first paint, and must divide by `--phx-scale-applied` when it sits inside the zoomed <main>: the
 * chrome is outside the zoom, so its height is in real pixels.
 */
export function ChromeHeightProbe() {
  const ref = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const chrome = ref.current?.parentElement;
    if (!chrome || typeof ResizeObserver === "undefined") return;
    const root = document.documentElement;
    const publish = () => root.style.setProperty("--phx-chrome-h", `${Math.round(chrome.getBoundingClientRect().height)}px`);
    publish();
    const observer = new ResizeObserver(publish);
    observer.observe(chrome);
    return () => {
      observer.disconnect();
      root.style.removeProperty("--phx-chrome-h");
    };
  }, []);

  return <span aria-hidden className="hidden" ref={ref} />;
}
