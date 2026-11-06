"use client";

import { AlertTriangle, MessageSquareText } from "lucide-react";

import { formatCurrencyValue } from "@/lib/i18n/format";
import {
  OFFICIAL_OUTSTATION_MINIMUM_DISTANCE_KM,
  TOLERANCE_OUTSTATION_MINIMUM_DISTANCE_KM,
  classifyOutstationExpenseEligibility,
} from "@/lib/outstation/classification";
import type { ExpenseTripRecord } from "@/lib/payroll/types";

/**
 * What the parts of Expense Approvals share: the row and decision shapes the workspace holds in
 * state, the one money formatter, the distance flag and the two small flags a trip can wear.
 * Presentation only — every rule here is read from its domain module.
 */

export type LoadedRecord = ExpenseTripRecord & {
  approvedAmount?: number | null;
  hrApproved?: boolean;
  hrComment?: string;
  reportId?: string | null;
  sourceFileName?: string;
};

export type Decision = { approvedAmount: number; hrApproved: boolean; hrComment: string; status: string };

export function egp(value: number) {
  return formatCurrencyValue(Number.isFinite(value) ? value : 0);
}

// The admin shell zeroes every border-radius (globals.css RULE 1 — the deliberately "shredded"
// look), so these are written square at source: what you read here is what renders.
export const PANEL_CLASS = "border border-slate-200 bg-white shadow-sm";

export const DISTANCE_TONE_CLASS: Record<"fail" | "none" | "warn", string> = {
  fail: "bg-rose-100 font-black text-rose-700 ring-1 ring-inset ring-rose-300",
  none: "text-slate-700",
  warn: "bg-amber-100 font-bold text-amber-800",
};

/**
 * How a trip's distance reads against the outstation distance floor.
 *
 * Driven by the shared classifier rather than a literal `< 58`, so the highlight always tracks the
 * SAME rule the rest of the module enforces (60 km official, 58 km tolerance) — move the policy
 * constants and this moves with them instead of quietly disagreeing.
 *
 * It reads the built-in policy defaults, not a per-rule row from `outstation_policy`, because this
 * page never loads the policy table. If a custom rule ever moves the floor, that policy has to be
 * threaded in here or the highlight would flag against the wrong number.
 */
export function distanceFlag(km: number): { label: string; tone: "fail" | "none" | "warn" } {
  if (!Number.isFinite(km) || km <= 0) return { label: "", tone: "none" };

  const { classification } = classifyOutstationExpenseEligibility({
    actualDistanceKm: km,
    policy: {
      officialMinimumDistanceKm: OFFICIAL_OUTSTATION_MINIMUM_DISTANCE_KM,
      toleranceMinimumDistanceKm: TOLERANCE_OUTSTATION_MINIMUM_DISTANCE_KM,
    },
  });

  if (classification === "not_eligible") {
    return {
      label: `Under the ${TOLERANCE_OUTSTATION_MINIMUM_DISTANCE_KM} km outstation floor`,
      tone: "fail",
    };
  }
  if (classification === "tolerance_eligible") {
    return {
      label: `Within tolerance but under the official ${OFFICIAL_OUTSTATION_MINIMUM_DISTANCE_KM} km`,
      tone: "warn",
    };
  }
  return { label: "", tone: "none" };
}

/** Tone for the nearest-brick match badge — mirrors the "High/Good/Review/Weak" prefixes
 * brickMatchConfidence() actually returns (see @/lib/crm/brick-geo), so a wording change
 * there degrades to the neutral tone instead of silently going stale here. */
export function capturedLocationConfidenceTone(confidence: string): "success" | "warning" | "danger" | "neutral" {
  if (confidence.startsWith("High") || confidence.startsWith("Good")) return "success";
  if (confidence.startsWith("Review")) return "warning";
  if (confidence.startsWith("Weak")) return "danger";
  return "neutral";
}

/**
 * The employee's own note on the claim (`employeeNote`), in their words and their script — `dir="auto"`
 * so an Arabic note reads right to left — and wrapped in full, never cut. Nothing when they wrote none.
 */
export function EmployeeNote({ note, wide = false }: { note?: string | null; wide?: boolean }) {
  if (!note) return null;
  if (!wide) {
    return (
      <p className="mt-1 flex items-start gap-1 text-phx-xs text-slate-600">
        <MessageSquareText aria-hidden className="mt-0.5 h-3 w-3 shrink-0 text-slate-400" />
        <span className="sr-only">Employee&apos;s note: </span>
        <span className="min-w-0 whitespace-pre-wrap break-words" dir="auto">{note}</span>
      </p>
    );
  }
  return (
    <>
      <p className="text-phx-2xs font-black uppercase tracking-[0.12em] text-slate-400">Employee&apos;s note</p>
      <p className="mt-1 flex items-start gap-1.5 text-sm font-semibold text-slate-900">
        <MessageSquareText aria-hidden className="mt-0.5 h-3.5 w-3.5 shrink-0 text-orange-500" />
        <span className="min-w-0 whitespace-pre-wrap break-words" dir="auto">{note}</span>
      </p>
    </>
  );
}

/** "Same trip as OUTSTATION-292" — flat, square, amber; never a decision. */
export function DuplicateTripFlag({ copies, wide = false }: { copies?: string[]; wide?: boolean }) {
  if (!copies || copies.length === 0) return null;
  return (
    <p
      className={`mt-1 inline-flex items-start gap-1 border border-amber-300 bg-amber-50 px-1.5 py-0.5 font-bold text-amber-800 ${
        wide ? "text-phx-xs" : "text-phx-2xs"
      }`}
    >
      <AlertTriangle className="mt-px h-3 w-3 shrink-0" />
      <span className="break-words">
        Same trip as {copies.join(", ")}
        {wide ? " — same employee, same day, same destination" : ""}
      </span>
    </p>
  );
}
