"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef } from "react";

import { hearOtherTabs, placeCheckReread } from "@/components/phoenix-crm/place-check-reread";

/**
 * Phoenix CRM — the Place checks board's three re-read rules, for a page that decides with its controls
 * but is not the board.
 *
 * 🔴 SFE RECOMMENDATIONS NEVER COMES BACK OLDER THAN THE DECISIONS MADE ON IT (owner, 23 Nov 2026, the Place
 * checks audit, after "I come back. I found the same place that I accepted or rejected is as it is"). The
 * page decides with the board's own controls, so every decision asked `placeCheckReread` for a re-read —
 * but it mounted none of the board's rules: the re-read outlived the page and rebuilt whatever page he
 * opened next, and coming back drew the browser's copy from before his decisions, every row still waiting.
 *
 * `readAt` is the server's own stamp of the read this page draws (a new one on every build). It draws
 * nothing.
 */
export function PlaceCheckPageRead({ readAt }: { readAt: string }) {
  const router = useRouter();
  // The re-read dies with the page, as it does with the board.
  useEffect(() => () => placeCheckReread.cancel(), []);
  // A decision is owed until a page read after it is on screen.
  const shownReadAt = useRef(readAt);
  useEffect(() => {
    shownReadAt.current = readAt;
    placeCheckReread.showing(readAt, () => router.refresh());
  }, [readAt, router]);
  // And never older than a decision made in his other tab: read when the tab is shown or focused again.
  useEffect(() => {
    const back = () => {
      if (document.visibilityState === "visible") placeCheckReread.shownAgain(shownReadAt.current, () => router.refresh());
    };
    const stopHearing = hearOtherTabs(() => placeCheckReread.owe());
    document.addEventListener("visibilitychange", back);
    window.addEventListener("focus", back);
    return () => {
      stopHearing();
      document.removeEventListener("visibilitychange", back);
      window.removeEventListener("focus", back);
    };
  }, [router]);
  return null;
}
