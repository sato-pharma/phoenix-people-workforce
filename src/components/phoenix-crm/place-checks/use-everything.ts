"use client";

/**
 * Phoenix CRM — Place checks: the rows the page did not send, and the page never being older than a
 * decision.
 *
 * The Super Admin's page sends what the waiting lanes draw; every place in use and every older decision
 * are read on the first click that needs them (owner, 2026-11-14, "Load lists on demand";
 * `place-checks-on-demand.ts`). This hook holds that read and the three re-read rules of the page
 * (`place-check-reread.ts`), which the board mounts once.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

import { useCrmGet } from "@/components/phoenix-crm/api";
import type { PlaceCheckBoardProps, PlaceCheckView } from "@/components/phoenix-crm/place-checks/board-types";
import { hearOtherTabs, placeCheckReread } from "@/components/phoenix-crm/place-check-reread";
import { PLACE_CHECKS_EVERYTHING_ROUTE, type PlaceChecksEverything } from "@/lib/phoenix-crm/place-checks-on-demand";

/** The tabs whose rows the page does not send: the places in use, and the decisions of single clinics. */
export function viewNeedsEverything(view: PlaceCheckView): boolean {
  return view === "unconfirmed" || view === "history" || view === "bySystem";
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
  const everythingRead = useCrmGet<PlaceChecksEverything>(onDemand && wanted ? PLACE_CHECKS_EVERYTHING_ROUTE : null, "everything");
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
  useEffect(() => {
    if (readAtSeen.current === readAt) return;
    readAtSeen.current = readAt;
    // A decision re-read the page (`placeCheckReread`): what the click read is as old as the page before it.
    if (wanted) reloadEverything();
  }, [readAt, wanted, reloadEverything]);
  const everything = onDemand ? everythingRead.data : null;
  /** Whether the board holds every row: always on a manager's board, and on the Super Admin's once the click's read is in. */
  const complete = !onDemand || everything !== null;

  return { askForDeck, complete, everything, everythingRead, reloadEverything, wanted };
}
