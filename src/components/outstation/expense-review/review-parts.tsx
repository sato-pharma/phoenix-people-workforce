"use client";

import { AlertTriangle, MessageSquareText } from "lucide-react";

import { CrmPill } from "@/components/phoenix-crm/ui";
import { formatCurrencyValue, formatNumberValue } from "@/lib/i18n/format";
import { cn } from "@/lib/utils";

import { type Decision, type LoadedRecord, decisionStateLabel, distanceFlag } from "./review-model";

/**
 * The small parts every screen of Expense review draws the same way: money, the distance flag, the
 * employee's own note, the same-trip flag and the decision pill. Presentation only — every rule they
 * show is read from review-model.ts or its domain module.
 */

export function egp(value: number) {
  return formatCurrencyValue(Number.isFinite(value) ? value : 0);
}

export const DISTANCE_TONE_CLASS: Record<"fail" | "none" | "warn", string> = {
  fail: "bg-rose-100 font-black text-rose-700 ring-1 ring-inset ring-rose-300",
  none: "text-slate-700",
  warn: "bg-amber-100 font-bold text-amber-800",
};

/** "184 km", flagged against the outstation distance floor; a dash when no distance is stored. */
export function DistanceChip({ km, withLabel = false }: { km: number; withLabel?: boolean }) {
  if (!km) return <span className="text-slate-400">—</span>;
  const flag = distanceFlag(km);
  return (
    <span
      className={cn("inline-flex max-w-full flex-wrap items-center gap-1 px-1.5 py-0.5 tabular-nums", DISTANCE_TONE_CLASS[flag.tone])}
      title={flag.label || undefined}
    >
      {flag.tone === "fail" ? <AlertTriangle aria-hidden className="h-3 w-3 shrink-0" /> : null}
      <span className="whitespace-nowrap">{formatNumberValue(km)} km</span>
      {withLabel && flag.label ? <span className="text-phx-2xs font-bold">· {flag.label}</span> : null}
    </span>
  );
}

/** Tone for the nearest-brick match: mirrors the "High / Good / Review / Weak" prefixes brick-geo returns. */
export function capturedLocationConfidenceTone(confidence: string): "bad" | "good" | "neutral" | "warn" {
  if (confidence.startsWith("High") || confidence.startsWith("Good")) return "good";
  if (confidence.startsWith("Review")) return "warn";
  if (confidence.startsWith("Weak")) return "bad";
  return "neutral";
}

/**
 * The employee's own note on the claim, in their words and their script — `dir="auto"` so an Arabic
 * note reads right to left — wrapped in full, never cut. Nothing when they wrote none. Printed ONCE,
 * on the trip under review, never on a list row (owner, 2026-11-07: "comment already written in the
 * right panel, remove from here").
 */
export function EmployeeNote({ note, wide = false }: { note?: string | null; wide?: boolean }) {
  if (!note) return null;
  return (
    <div className="min-w-0">
      <p className="text-phx-2xs font-black uppercase tracking-[0.12em] text-slate-400">Employee&apos;s note</p>
      <p className={cn("mt-1 flex items-start gap-1.5 font-semibold text-slate-900", wide ? "text-sm" : "text-xs")}>
        <MessageSquareText aria-hidden className="mt-0.5 h-3.5 w-3.5 shrink-0 text-orange-500" />
        <span className="min-w-0 whitespace-pre-wrap break-words" dir="auto">
          {note}
        </span>
      </p>
    </div>
  );
}

/** "Same trip as OUTSTATION-292" — flat, square, amber; a signal to look, never a decision. */
export function DuplicateTripFlag({ copies, wide = false }: { copies?: string[]; wide?: boolean }) {
  if (!copies || copies.length === 0) return null;
  return (
    <p
      className={cn(
        "inline-flex max-w-full items-start gap-1 border border-amber-300 bg-amber-50 px-1.5 py-0.5 font-bold text-amber-800",
        wide ? "text-phx-xs" : "text-phx-2xs",
      )}
      data-duplicate-flag
    >
      <AlertTriangle aria-hidden className="mt-px h-3 w-3 shrink-0" />
      <span className="min-w-0 break-words">
        Same trip as {copies.join(", ")}
        {wide ? " — same employee, same day, same destination" : ""}
      </span>
    </p>
  );
}

/** The decision as one pill — Waiting, Approved, Approved · adjusted, Rejected, Before July — and "unsaved". */
export function DecisionPill({ decision, record, unsaved = false }: { decision: Decision; record: LoadedRecord; unsaved?: boolean }) {
  const state = decisionStateLabel(decision, record);
  return (
    <span className="inline-flex max-w-full flex-wrap items-center gap-1">
      <CrmPill tone={state.tone}>{state.label}</CrmPill>
      {unsaved ? <CrmPill tone="warn">Unsaved</CrmPill> : null}
    </span>
  );
}

/** Claimed, or "approved of claimed" once the amount was changed — tabular, right-aligned by the caller. */
export function MoneyFigure({ approved, claimed, size = "sm" }: { approved: number; claimed: number; size?: "lg" | "sm" }) {
  const adjusted = Math.abs(approved - claimed) >= 0.5;
  return (
    <span className="block min-w-0">
      <span className={cn("block font-black tabular-nums text-slate-950", size === "lg" ? "text-2xl leading-tight" : "text-sm")}>{egp(approved)}</span>
      {adjusted ? (
        <span className="block text-phx-2xs font-bold tabular-nums text-orange-700">
          claimed <span className="line-through">{egp(claimed)}</span> · {egp(claimed - approved)} less
        </span>
      ) : null}
    </span>
  );
}
