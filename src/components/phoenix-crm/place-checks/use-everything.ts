"use client";

/**
 * Phoenix CRM — Place checks: the rows the page did not send, and the page never being older than a
 * decision.
 *
 * The Super Admin's page sends what the waiting lanes draw; every place in use and every older decision
 * are read on the first click that needs them (owner, 2026-11-14, "Load lists on demand";
 * `place-checks-on-demand.ts`), and the figures counted over them are asked for once the board is on
 * screen (23 Nov 2026). This hook holds both reads and the three re-read rules of the page
 * (`place-check-reread.ts`), which the board mounts once.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

import { useCrmGet } from "@/components/phoenix-crm/api";
import type { PlaceCheckBoardProps, PlaceCheckView } from "@/components/phoenix-crm/place-checks/board-types";
import { hearOtherTabs, placeCheckReread } from "@/components/phoenix-crm/place-check-reread";
import {
  PLACE_CHECKS_EVERYTHING_ROUTE,
  PLACE_CHECKS_SUMMARY_ROUTE,
  type PlaceChecksEverything,
  type PlaceChecksSummary,
} from "@/lib/phoenix-crm/place-checks-on-demand";

/**
 * The tabs whose rows the page does not send: the places in use, the decisions of single clinics, and the
 * buildings that need no decision (23 Nov 2026: the page sends only the ones the lanes draw).
 */
export function viewNeedsEverything(view: PlaceCheckView): boolean {
  return view === "unconfirmed" || view === "history" || view === "bySystem" || view === "polyclinics";
}

export function usePlaceChecksEverything({
  filtering,
  onDemand,
  view,
}: {
  /** Any filter or outcome is set: the lists it narrows need every row. */
  filtering: boolean;
  onDemand: PlaceCheckBoardProps["onDemand"];
  /** The tab he chose. The tab the board opens on by itself never needs the rest. */
  view: PlaceCheckView;
}) {
  // 🔴 A DECISION'S RE-READ DIES WITH THE BOARD (17 Nov 2026): it waits for the decisions to pause, and
  // pressed just before he left, it rebuilt whatever page he had opened since.
  useEffect(() => () => placeCheckReread.cancel(), []);

  // ── The rows the page did not send (`onDemand`) ──────────────────────────────────────────────────
  // Asked for once, on the first click that needs them — Not confirmed, History, "Approved by the system",
  // any filter or outcome, a tapped count (it sets the rep), or the review — and then kept for the visit: a re-read of the page reads them
  // again behind the rows on screen (`readAt`), and clearing the filters never throws them away.
  const [deckAsked, setDeckAsked] = useState(false);
  const askForDeck = useCallback(() => setDeckAsked(true), []);
  const [wanted, setWanted] = useState(false);
  if (onDemand && !wanted && (viewNeedsEverything(view) || filtering || deckAsked)) setWanted(true);
  // 🔴 THE FIGURES ARE ASKED FOR ONCE THE BOARD IS ON SCREEN, NEVER BY THE PAGE (owner, 23 Nov 2026: "Fix
  // speed next"). The page used to count them itself, which meant reading every place in use and every
  // decision before it drew the first waiting place: 12.2 s on production. The read behind this route is
  // that wide read; it answers the figures and leaves its rows for the click (`place-checks-handoff.ts`).
  const summaryRead = useCrmGet<PlaceChecksSummary>(onDemand ? PLACE_CHECKS_SUMMARY_ROUTE : null, "summary");
  // 🔴 THE CLICK WAITS FOR THE FIGURES' READ TO END, so one wide read serves both: asked while that read is
  // still on its way, the rows' route would find nothing left for it and make the same read a second time.
  // A figures read that failed has left nothing, and the rows' route then reads for itself.
  const summarySettled = !summaryRead.loading;
  const everythingRead = useCrmGet<PlaceChecksEverything>(onDemand && wanted && summarySettled ? PLACE_CHECKS_EVERYTHING_ROUTE : null, "everything");
  const readAt = onDemand?.readAt ?? null;
  // 🔴 THE PAGE HE COMES BACK TO IS NEVER OLDER THAN HIS DECISIONS (owner, 22 Nov 2026: "I come back. I
  // found the same place that I accepted or rejected is as it is"). The board tells the re-read which page
  // it draws; the browser's copy from before a decision whose re-read died with the board reads itself again.
  const router = useRouter();
  // 🔴 AND NEVER OLDER THAN A DECISION MADE IN HIS OTHER TAB (22 Nov 2026): each tab kept its own page, so a
  // row he settled in one stood waiting in the other until it made a decision of its own. A decision in any
  // tab owes the others a read, made when that tab is shown or focused again — never at once, or two windows
  // side by side would rebuild the heaviest page once per decision.
  const shownReadAt = useRef(readAt);
  useEffect(() => {
    shownReadAt.current = readAt;
    placeCheckReread.showing(readAt, () => router.refresh());
  }, [readAt, router]);
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
  const readAtSeen = useRef(readAt);
  const reloadEverything = everythingRead.reload;
  const reloadSummary = summaryRead.reload;
  useEffect(() => {
    if (readAtSeen.current === readAt) return;
    readAtSeen.current = readAt;
    // A decision re-read the page (`placeCheckReread`): what the click read is as old as the page before it.
    // With the rows in hand the board counts for itself, so the rows are read again; without them the
    // figures are. Never both: each is the wide read.
    if (wanted) reloadEverything();
    else reloadSummary();
  }, [readAt, wanted, reloadEverything, reloadSummary]);
  const everything = onDemand ? everythingRead.data : null;
  /** Whether the board holds every row: always on a manager's board, and on the Super Admin's once the click's read is in. */
  const complete = !onDemand || everything !== null;
  /** The figures counted over every place in use, or null until their read is in (and on a manager's board). */
  const summary = onDemand ? summaryRead.data : null;
  /** Why the figures could not be counted, when their read failed and nothing stands in for it. */
  const summaryError = onDemand && summary === null ? summaryRead.error : null;
  /**
   * Why the figures on screen are older than his last decision: their re-read failed and the earlier ones
   * stay (`useCrmGet` keeps the last answer of the same route). Said, never silent.
   */
  const summaryStale = onDemand && summary !== null ? summaryRead.error : null;

  return { askForDeck, complete, everything, everythingRead, reloadEverything, reloadSummary, summary, summaryError, summaryStale, wanted };
}
