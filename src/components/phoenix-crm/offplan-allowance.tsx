"use client";

/**
 * Phoenix CRM — the out-of-plan allowance, drawn (owner, 2026-10-10: two doctors a day, eight a week).
 *
 * The rep meets it on the Unplanned steps BEFORE he picks a doctor, so a full day never surprises him at
 * the save; his managers read the same two numbers beside each off-plan visit they decide. The rule, the
 * counting and the words are `offplan-cap-rules.ts`; the door that enforces it is the database trigger.
 *
 * Golden rule #1: to the rep this is an ALLOWANCE he is shown — squares filled as he uses them, what is
 * left said in one plain sentence. It names no check, reads no flag and says nothing of any approval.
 * Orange while it fills, amber the moment it is full; square edges and no scroll, like its siblings.
 */

import {
  offPlanAllowanceSentence,
  offPlanExemptionSentence,
  offPlanLeft,
  offPlanStandingFull,
  offPlanStandingLine,
  type OffPlanAllowance,
  type OffPlanStanding,
  type OffPlanTally,
} from "@/lib/phoenix-crm/offplan-cap-rules";
import { cn } from "@/lib/utils";

/** A cap this small is drawn as one square per place; a larger one as a single bar. */
const SEGMENTED_UP_TO = 12;

function OffPlanMeter({ label, tally }: { label: string; tally: OffPlanTally }) {
  const full = tally.used >= tally.cap;
  const used = Math.min(tally.used, tally.cap);
  const percent = tally.cap > 0 ? Math.round((used / tally.cap) * 100) : 0;
  return (
    <div className="min-w-0">
      <div className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-2">
        <span className="text-phx-sm font-black uppercase tracking-[0.16em] text-slate-500">{label}</span>
        <span className={cn("text-sm font-black tabular-nums", full ? "text-amber-700" : "text-slate-950")}>
          {tally.used}
          <span className="font-semibold text-slate-400"> of {tally.cap}</span>
        </span>
      </div>
      <div
        aria-label={`${label}: ${tally.used} of ${tally.cap} customers out of plan`}
        aria-valuemax={tally.cap}
        aria-valuemin={0}
        aria-valuenow={used}
        className="mt-1.5"
        role="progressbar"
      >
        {tally.cap <= SEGMENTED_UP_TO ? (
          <div className="flex min-w-0 gap-1">
            {Array.from({ length: tally.cap }, (_, index) => (
              <span
                className={cn(
                  "h-2 min-w-0 flex-1 border",
                  index < used ? (full ? "border-amber-500 bg-amber-500" : "border-orange-500 bg-orange-500") : "border-slate-200 bg-slate-100",
                )}
                key={index}
              />
            ))}
          </div>
        ) : (
          <div className="h-2 border border-slate-200 bg-slate-100">
            <div className={cn("h-full transition-[width] duration-500", full ? "bg-amber-500" : "bg-orange-500")} style={{ width: `${percent}%` }} />
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * The rep's allowance: two meters and the one sentence under them. `compact` is the reason step's
 * reminder, where the doctor is already chosen and the card should not compete with the form.
 */
export function OffPlanAllowanceCard({
  allowance,
  className,
  compact = false,
  voice = "rep",
}: {
  allowance: OffPlanAllowance;
  className?: string;
  compact?: boolean;
  voice?: "rep" | "manager";
}) {
  const full = offPlanLeft(allowance.day) === 0 || offPlanLeft(allowance.week) === 0;
  // A named exception (owner, 2026-10-17) is told to the rep as a gift, and to a manager in his own voice.
  const exemption = offPlanExemptionSentence(allowance, voice);
  // A dated window over all of the rep's out-of-plan visits (owner, 2026-10-26: a new hire's first month) has no
  // numbers to draw — the meters would read "0 of 2" beside "no limit" — so the card is that one sentence.
  if (allowance.exemptAll && exemption) {
    return (
      <section aria-label="Out-of-plan allowance" className={cn("min-w-0 border border-l-4 border-slate-200 border-l-emerald-600 bg-white px-3.5 py-3", className)}>
        <p className="break-words text-xs font-bold leading-5 text-emerald-800">{exemption}</p>
      </section>
    );
  }
  return (
    <section
      aria-label="Out-of-plan allowance"
      className={cn(
        "min-w-0 border border-l-4 bg-white px-3.5 py-3",
        full ? "border-amber-200 border-l-amber-500 bg-amber-50/40" : "border-slate-200 border-l-orange-500",
        className,
      )}
    >
      <div className={cn("grid min-w-0 gap-3", compact ? "grid-cols-2" : "grid-cols-1 sm:grid-cols-2 sm:gap-5")}>
        <OffPlanMeter label="Today" tally={allowance.day} />
        <OffPlanMeter label="This week" tally={allowance.week} />
      </div>
      <p className={cn("mt-2.5 break-words text-xs font-semibold leading-5", full ? "text-amber-900" : "text-slate-600")}>
        {offPlanAllowanceSentence(allowance, voice)}
      </p>
      {exemption ? <p className="mt-1.5 break-words text-xs font-bold leading-5 text-emerald-800">{exemption}</p> : null}
    </section>
  );
}

/** What a manager reads beside a rep's off-plan day: where the rep stood that day and that week. */
export function OffPlanStandingStrip({ className, standing }: { className?: string; standing: OffPlanStanding }) {
  const full = offPlanStandingFull(standing);
  return (
    <p
      className={cn(
        "mb-3 min-w-0 break-words border border-l-4 px-3 py-2 text-xs font-bold leading-5",
        full ? "border-amber-200 border-l-amber-500 bg-amber-50/40 text-amber-900" : "border-slate-200 border-l-orange-500 bg-white text-slate-700",
        className,
      )}
    >
      {offPlanStandingLine(standing)}
    </p>
  );
}
