"use client";

/**
 * Phoenix CRM — whether the reader of the COMPANY Place checks board decides on it.
 *
 * Owner, 19 November 2026: "in place checks make Khaled Bedair only able to recommend validation or not
 * recommend, never able to take a decision, and the recommended by him goes separately in a separate page
 * for admin decision." The Super Admin decides (`true`); the SFE Manager reads the same board and
 * recommends (`false`), so every decision control on it — Approve, Reject, Refuse, the bulk bar, the
 * polyclinic decision, the held full name, the same-place answer — is left out for him, and his own two
 * recommendation buttons are drawn in their place.
 *
 * 🔴 THE SCREEN IS NOT THE BOUNDARY. Every decision route refuses him on the server
 * (`canDecideValidationReviews`); this only stops the board offering him a button that would be refused.
 *
 * The default is `true` so the district manager's team board, the review deck and every place that draws
 * these components outside the company board keep exactly what they had.
 */

import { createContext, useContext, type ReactNode } from "react";

import { CrmPill } from "@/components/phoenix-crm/ui";

const PlaceCheckDecidesContext = createContext(true);

export function PlaceCheckDecidesProvider({ children, decides }: { children: ReactNode; decides: boolean }) {
  return <PlaceCheckDecidesContext.Provider value={decides}>{children}</PlaceCheckDecidesContext.Provider>;
}

export function usePlaceCheckDecides(): boolean {
  return useContext(PlaceCheckDecidesContext);
}

/** What a recommender reads where the decider's controls would be: who decided, or that it is still open. */
export const PLACE_CHECK_WAITING_FOR_ADMIN = "Waiting for the administrator's decision";

/**
 * Where the decision controls stand on the Super Admin's board, the SFE Manager reads this instead: still
 * waiting, or what was decided, by whom and when. Nothing on it can be pressed.
 */
export function PlaceCheckDecisionState({
  by,
  decided,
  note,
  repWasTold,
  when,
}: {
  /** Null while it waits; otherwise the word for what the Super Admin did. */
  decided: { label: string; tone: "good" | "bad" } | null;
  by?: string | null;
  when?: string | null;
  repWasTold?: string | null;
  note?: string | null;
}) {
  if (!decided) {
    return (
      <div className="min-w-0">
        <CrmPill tone="warn">{PLACE_CHECK_WAITING_FOR_ADMIN}</CrmPill>
      </div>
    );
  }
  return (
    <div className="min-w-0 space-y-1">
      <CrmPill tone={decided.tone}>{decided.label}</CrmPill>
      {by || when ? <p className="break-words text-xs text-slate-500">{[by, when].filter(Boolean).join(" · ")}</p> : null}
      {repWasTold ? <p className="break-words text-xs font-semibold text-slate-700">The rep was told: {repWasTold}</p> : null}
      {note ? <p className="break-words text-xs text-slate-600">{note}</p> : null}
    </div>
  );
}
