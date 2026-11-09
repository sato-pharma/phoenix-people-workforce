"use client";

/**
 * "Back" — the way back to the page a rep was pressed on, as the FIRST thing on that rep's page (owner, 2026-11-09:
 * "when I press on a rep I need a back button to be able to return back to the previous page"). It goes back in the
 * browser's own history, so it returns to the exact screen, filters and scroll he came from. Opened from a link, a
 * bookmark or a new tab there is no page of ours behind it, so it opens `fallbackHref` instead — always an address
 * inside the app, never one read from the URL.
 *
 * The same orange bar as "Back to all reps" (`reps-list-chrome.tsx`), so the two read as one control.
 */

import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import { previousEntryIsThisApp } from "@/lib/navigation/back-to-previous";

type NavigationLike = { currentEntry?: { index: number } | null; entries?: () => Array<{ url: string | null }> };

function canGoBackInApp(): boolean {
  const navigation = (window as unknown as { navigation?: NavigationLike }).navigation;
  const hasNavigationApi = Boolean(navigation?.currentEntry && typeof navigation.entries === "function");
  const index = navigation?.currentEntry?.index ?? 0;
  const previousUrl = hasNavigationApi && index > 0 ? (navigation?.entries?.()[index - 1]?.url ?? null) : null;
  return previousEntryIsThisApp({ hasNavigationApi, historyLength: window.history.length, origin: window.location.origin, previousUrl });
}

export function BackToPreviousPage({ fallbackHref }: { fallbackHref: string }) {
  const router = useRouter();
  return (
    <div className="mb-3 border border-slate-200 bg-white px-5 py-3">
      <Link
        className="inline-flex items-center gap-2 border border-orange-500 bg-orange-50 px-3 py-2 text-phx-xs font-black uppercase tracking-[0.12em] text-orange-800 transition-colors hover:bg-orange-100"
        href={fallbackHref}
        onClick={(event) => {
          if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
          if (!canGoBackInApp()) return;
          event.preventDefault();
          router.back();
        }}
      >
        <ArrowLeft aria-hidden className="h-4 w-4 shrink-0" />
        Back
      </Link>
    </div>
  );
}
