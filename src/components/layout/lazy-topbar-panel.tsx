"use client";

import { Loader2, RefreshCw } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * The topbar's click-to-open panels load their own code the first time they are needed, never with
 * the page (19 Nov 2026). The notifications list, the messages panel with "My email", and the
 * calculator were mounted with the topbar on every signed-in page, so every page view downloaded
 * and parsed all four before anyone clicked. What must show at once stays with the page: each
 * trigger button, the bell's and the envelope's unread counts, and the background checks behind
 * them. Only the panel body is a separate chunk.
 *
 * Three rules keep a panel feeling instant and never breaking the page:
 *
 *  1. IDLE PRELOAD. Each trigger asks for its panel's chunk once the page has gone idle
 *     (`preloadWhenIdle`), and again on hover or focus. The first click almost always finds the
 *     code already there, and it is fetched while the build that served the page is still live.
 *  2. A LOADING FRAME, NOT A BLANK. The panel's frame opens at once and holds `TopbarPanelLoading`
 *     until its body arrives.
 *  3. A FAILED LOAD STAYS INSIDE THE PANEL. A tab left open across a deploy asks for a chunk the new
 *     build no longer serves. Thrown, that would reach the page's error boundary and replace the
 *     page, taking a half-typed form with it. Each loader catches it and shows
 *     `TopbarPanelLoadFailed`, which offers a reload and leaves the page alone.
 */

/** How long a quiet page waits before fetching the panels anyway, in browsers with no idle callback. */
const IDLE_FALLBACK_MS = 2_500;
/** The latest an idle callback may wait before it runs regardless. */
const IDLE_TIMEOUT_MS = 6_000;

/** Runs `load` once the browser is idle after the page has loaded; the return value cancels it. */
export function preloadWhenIdle(load: () => unknown): () => void {
  if (typeof window === "undefined") return () => {};
  const run = () => {
    try {
      void Promise.resolve(load()).catch(() => undefined);
    } catch {
      // A preload is only a head start: the click loads it again and handles any failure itself.
    }
  };
  if (typeof window.requestIdleCallback === "function") {
    const handle = window.requestIdleCallback(run, { timeout: IDLE_TIMEOUT_MS });
    return () => window.cancelIdleCallback(handle);
  }
  const handle = window.setTimeout(run, IDLE_FALLBACK_MS);
  return () => window.clearTimeout(handle);
}

/** Starts fetching a panel's chunk; safe to call any number of times (the bundler fetches it once). */
export function preloadPanel(load: () => Promise<unknown>): void {
  void load().catch(() => undefined);
}

/**
 * What a panel's frame holds for the moment before its body arrives. `next/dynamic` hands a loading
 * component no props, so it cannot know the admin bar from the portal: the mid-tone ink and the
 * accent spinner read on both the black admin panel and the white portal one.
 */
export function TopbarPanelLoading() {
  return (
    <div aria-busy="true" aria-live="polite" className="flex items-center justify-center gap-2 px-4 py-8 text-xs font-bold text-phx-ink-soft">
      <Loader2 className="h-4 w-4 animate-spin text-phx-accent" />
      Loading
    </div>
  );
}

export function TopbarPanelLoadFailed({ isAdminMode }: { isAdminMode: boolean }) {
  return (
    <div className="px-4 py-6 text-center">
      <p className={cn("text-sm font-bold", isAdminMode ? "text-white" : "text-phx-ink")}>This panel could not open.</p>
      <p className={cn("mt-1 text-xs", isAdminMode ? "text-phx-ink-faint" : "text-phx-ink-soft")}>
        Phoenix may have been updated since this page opened. Reload the page, then open it again.
      </p>
      <button
        className={cn(
          "mt-3 inline-flex items-center gap-1.5 rounded border px-3 py-1.5 text-xs font-bold transition",
          isAdminMode ? "border-[#333333] text-[#F8B56B] hover:bg-[#111111]" : "border-phx-line text-phx-accent-press hover:bg-phx-accent-soft",
        )}
        onClick={() => window.location.reload()}
        type="button"
      >
        <RefreshCw className="h-3.5 w-3.5" />
        Reload
      </button>
    </div>
  );
}
