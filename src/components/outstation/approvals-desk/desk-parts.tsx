"use client";

import { ArrowRight, ShieldCheck } from "lucide-react";

import { CrmPill, type PillTone } from "@/components/phoenix-crm/ui";
import { formatCurrencyValue, formatDateValue, formatNumberValue } from "@/lib/i18n/format";
import { tripDayCount, waitLabel } from "@/lib/outstation/approvals/desk-view";
import { TRIP_STANDING_LABEL, TRIP_STANDING_MEANING, type TripStanding } from "@/lib/outstation/approvals/standing";
import type { DeskClaim } from "@/lib/outstation/approvals/types";
import { displayPlace } from "@/lib/outstation/place-label";

/**
 * The small parts every screen of the Expense Approvals desk draws the same way: money, the trip in
 * one line, what the system found, where a decided trip stands. Presentation only — every figure and
 * every sentence is read from the claim the server sent.
 */

/** "EGP 500", "EGP 402.30" — piastres only when the figure has them. */
export function egp(value: number): string {
  const safe = Number.isFinite(value) ? value : 0;
  return formatCurrencyValue(safe, null, { maximumFractionDigits: 2, minimumFractionDigits: Number.isInteger(safe) ? 0 : 2 });
}

/** How the trip was travelled, in the words Submit Expense asks it in. */
export function travelLabel(transportation: string): string {
  const key = transportation.trim().toLowerCase();
  if (key === "car") return "Fuel";
  if (key === "train" || key === "ticket_journey") return "Ticket";
  if (key === "no_ticket") return "No ticket";
  if (key === "bus") return "Bus";
  if (key === "other") return "Other transport";
  // A value this list does not know draws nothing; a stored code is never printed.
  return "";
}

/**
 * What the opened trip says beside a visit whose position needs a second look, or null. Phoenix CRM
 * stores `ok`, `far`, `weak_gps` and `no_place` (`VisitLocationFlag`). `ok` needs no note, and
 * `no_place` is about the customer having no saved place, not about this visit, so neither draws a
 * pill. A value this list does not know draws nothing; the stored code is never printed.
 */
export function visitLocationNote(flag: string | null | undefined): string | null {
  const key = String(flag ?? "").trim().toLowerCase();
  if (key === "far") return "Far from the saved place";
  if (key === "weak_gps") return "Weak GPS reading";
  return null;
}

/** Added to a dense button drawn on a phone card: 44px tall under `md`, dense from `md` up. */
export const PHONE_TARGET = "max-md:min-h-11";

export const STANDING_TONE: Record<TripStanding, PillTone> = {
  approved_held: "warn",
  approved_missed: "warn",
  approved_queued: "good",
  in_payroll: "info",
  rejected: "bad",
  waiting: "orange",
};

export const STANDING_RAIL: Record<TripStanding, string> = {
  approved_held: "border-l-amber-400",
  approved_missed: "border-l-amber-600",
  approved_queued: "border-l-emerald-500",
  in_payroll: "border-l-sky-500",
  rejected: "border-l-rose-500",
  waiting: "border-l-orange-400",
};

export function StandingPill({ standing }: { standing: TripStanding }) {
  return (
    <span title={TRIP_STANDING_MEANING[standing]}>
      <CrmPill tone={STANDING_TONE[standing]}>{TRIP_STANDING_LABEL[standing]}</CrmPill>
    </span>
  );
}

/** The trip's dates — with its length when it ran over more than one day. */
export function tripDates(claim: Pick<DeskClaim, "tripEnd" | "tripStart">): string {
  const days = tripDayCount(claim);
  const start = formatDateValue(claim.tripStart, null, { weekday: "short", year: undefined });
  if (days <= 1) return start;
  return `${start} → ${formatDateValue(claim.tripEnd, null, { weekday: "short", year: undefined })} · ${formatNumberValue(days)} days`;
}

/** Dates, then the route in words. Wraps; never cut. */
export function TripLine({ claim }: { claim: DeskClaim }) {
  const travel = travelLabel(claim.transportation);
  return (
    <>
      <span className="block text-xs font-semibold text-slate-600">
        {tripDates(claim)}
        {travel ? <span className="text-slate-400"> · {travel}</span> : null}
      </span>
      <span className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-1 text-xs text-slate-500">
        <bdi className="min-w-0 break-words" dir="auto">
          {displayPlace(claim.from)}
        </bdi>
        <ArrowRight aria-hidden className="h-3 w-3 shrink-0 text-slate-400" />
        <bdi className="min-w-0 break-words font-semibold text-slate-700" dir="auto">
          {displayPlace(claim.to)}
        </bdi>
      </span>
    </>
  );
}

/**
 * What the system found. A Ready claim says so in one pill. A "Your call" claim wears the ONE
 * sentence that put it there, then the name of every other check that failed or could not be made.
 * A claim whose approval would be held out of payroll says that before the press, not after.
 */
export function FoundCell({ claim }: { claim: DeskClaim }) {
  const others = claim.verdict.checks.filter((check) => check.answer !== "pass" && check.sentence !== claim.verdict.reason);
  return (
    <div className="flex min-w-0 flex-col items-start gap-1" data-found>
      {claim.verdict.lane === "ready" ? (
        <CrmPill tone="good">
          <ShieldCheck aria-hidden className="h-3 w-3" /> Every check passed
        </CrmPill>
      ) : (
        <p className="min-w-0 break-words text-sm font-bold leading-5 text-slate-900" data-found-reason>
          {claim.verdict.reason}
        </p>
      )}
      {others.length > 0 ? (
        <div className="flex min-w-0 flex-wrap gap-1">
          {others.map((check) => (
            <span key={check.key} title={check.sentence}>
              <CrmPill tone={check.answer === "fail" ? "bad" : "warn"}>{check.answer === "fail" ? check.label : `Not checked: ${check.label}`}</CrmPill>
            </span>
          ))}
        </div>
      ) : null}
      {claim.holdReason ? (
        <p className="min-w-0 break-words text-xs font-semibold leading-5 text-amber-800" data-hold-reason>
          Approving it holds it out of payroll for now: {claim.holdReason}
        </p>
      ) : null}
    </div>
  );
}

/** The claim, and under it what it would pay when that differs: the idle-day cut, or the amount he typed. */
export function MoneyCell({ claim }: { claim: DeskClaim }) {
  const waiting = claim.standing === "waiting";
  const cut = waiting && claim.preCut && !claim.holdReason ? claim.preCut : null;
  const reduced = !waiting && claim.standing !== "rejected" && claim.approvedAmount !== null && Math.abs(claim.approvedAmount - claim.total) > 0.5;
  return (
    <span className="block min-w-0 tabular-nums">
      <span className="block break-words text-sm font-black text-slate-950">{egp(claim.total)}</span>
      {cut ? (
        <span className="block break-words text-xs font-bold text-orange-700" title={cut.reason}>
          {egp(cut.payable)} without the {cut.label.charAt(0).toLowerCase() + cut.label.slice(1)}
        </span>
      ) : null}
      {reduced ? <span className="block break-words text-xs font-bold text-violet-700">Pays {egp(claim.payable)}</span> : null}
      {claim.standing === "rejected" ? <span className="block text-xs font-bold text-rose-700">Pays nothing</span> : null}
    </span>
  );
}

/** "9 days" in orange once it is over a week. */
export function WaitFigure({ days }: { days: number }) {
  return (
    <span className={days > 7 ? "text-sm font-black text-orange-700" : "text-sm font-bold text-slate-600"} data-days-waiting={Math.floor(days)}>
      {waitLabel(days)}
    </span>
  );
}
