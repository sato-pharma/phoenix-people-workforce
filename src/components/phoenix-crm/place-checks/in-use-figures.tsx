"use client";

/**
 * Phoenix CRM — Place checks: the figures counted over every place in use, and what the board says while
 * they are being counted.
 *
 * 🔴 THE PAGE NO LONGER COUNTS THEM (owner, 23 Nov 2026: "Fix speed next"). "Validated, in use" and "Never
 * looked at" on the Figures tab, the scorecard, and the numbers on Not confirmed, History and "Approved by
 * the system" are counted over every place in use and every decision, which the page used to read before
 * it drew the first waiting place (12.2 s on production). The board asks for them once it is on screen
 * (`use-everything.ts`), and hands the two cards their figures through this context, because the cards are
 * drawn by the page inside a tab the page hands in (`slots`).
 *
 * 🔴 A FIGURE THAT IS NOT IN YET IS NEVER A ZERO. A card says it is being counted, or that it could not be
 * counted; the notice with the button that asks again is the board's own, above the tabs.
 */

import { createContext, useContext, type ReactNode } from "react";
import { EyeOff, MapPinCheck } from "lucide-react";

import { AdminCallout, AdminStatCard } from "@/components/admin/admin-design-system";
import { CrmButton } from "@/components/phoenix-crm/ui";

export type PlaceChecksInUseFigureState = {
  /** Null until the figures' read, or the rows themselves, are in. */
  figures: { inUse: number; unseen: number } | null;
  /** The figures' read failed and nothing stands in for it. */
  failed: boolean;
};

const InUseFigures = createContext<PlaceChecksInUseFigureState | null>(null);

export function PlaceChecksInUseFiguresProvider({ children, value }: { children: ReactNode; value: PlaceChecksInUseFigureState }) {
  return <InUseFigures.Provider value={value}>{children}</InUseFigures.Provider>;
}

/** What a card shows in place of a number it does not hold. */
export function figureOrWord(state: PlaceChecksInUseFigureState | null, pick: (figures: { inUse: number; unseen: number }) => number): number | string {
  if (state?.figures) return pick(state.figures);
  return state?.failed ? "Not counted" : "Counting";
}

/** The Figures tab's two cards counted over every place in use. Drawn by the page, filled by the board. */
export function PlaceChecksInUseFigures() {
  const state = useContext(InUseFigures);
  const waiting = !state?.figures;
  // One short line, about as long as the line that replaces it, so the card keeps its height when the number lands.
  const why = state?.failed ? "Could not be read. Try again above." : "Counting every place in use.";
  return (
    <>
      <AdminStatCard
        icon={<MapPinCheck className="h-5 w-5" />}
        label="Validated, in use"
        value={figureOrWord(state, (figures) => figures.inUse)}
        description={waiting ? why : "Every place still in use"}
        tone="blue"
        size="compact"
      />
      <AdminStatCard
        icon={<EyeOff className="h-5 w-5" />}
        label="Never looked at"
        value={figureOrWord(state, (figures) => figures.unseen)}
        description={waiting ? why : "In use, and no review of any kind yet"}
        tone="violet"
        size="compact"
      />
    </>
  );
}

/**
 * What the board says when the figures' read failed: which numbers are missing, why, and the one button
 * that asks again. While the read is merely on its way the board says nothing: the tabs show no count.
 * `stale`: the numbers are on screen, but from before his last decision, because counting them again failed.
 */
export function FiguresNotCounted({ error, onRetry, stale = false }: { error: string; onRetry: () => void; stale?: boolean }) {
  return (
    <AdminCallout tone="warning">
      <span className="flex min-w-0 flex-wrap items-center gap-3">
        <span className="min-w-0 flex-1 basis-60 break-words">
          The numbers on Not confirmed and History, the scorecard and the filter lists could not be counted{stale ? " again" : ""}:{" "}
          {error.trim().replace(/([^.!?])$/, "$1.")} {stale ? "They stand as they were before your last decision. " : ""}The places waiting for you below are
          complete.
        </span>
        <CrmButton onClick={onRetry} size="sm">
          Try again
        </CrmButton>
      </span>
    </AdminCallout>
  );
}

/** The scorecard tab before its figures are in: a sentence, never an empty tab and never a zero. */
export function ScorecardBeingCounted() {
  return (
    <p className="break-words border-l-4 border-slate-300 bg-white px-4 py-3 text-sm font-semibold text-slate-700" role="status">
      Each rep&apos;s places are being counted. The scorecard appears here by itself once every place in use is read.
    </p>
  );
}
