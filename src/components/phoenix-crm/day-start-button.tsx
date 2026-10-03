"use client";

/**
 * Phoenix CRM — "Show your manager you started working" (owner, 2026-10-03).
 *
 * One obvious target at the top of his day, in his own words, shown ONLY before his first AM visit
 * and only today. The rule that decides that lives in `day-start-rules.ts` and the server applies the
 * same one, so this screen can never offer a press the save would refuse.
 *
 * 🔴 THE THIRD LINE IS NOT DECORATION. His ruling the same day was that the press sends "their
 * location and their time" to the managers, so the button says so BEFORE he presses it. Every other
 * reading in this module is silent because it is a check on him; this one is a report he makes, and
 * the difference only holds while he can read it. Never quietly drop that line to tidy the button.
 */

import { useState } from "react";
import { CircleCheck, Sunrise } from "lucide-react";

import { crmPost, messageOf } from "@/components/phoenix-crm/api";
import { cairoClock } from "@/components/phoenix-crm/format";
import { useSilentFix } from "@/components/phoenix-crm/use-silent-fix";
import { CrmBlock, CrmButton, CrmNote } from "@/components/phoenix-crm/ui";
import {
  DAY_START_BUTTON_LABEL,
  DAY_START_BUTTON_NOTE,
  DAY_START_DONE_NOTE,
  DAY_START_LOCATION_NOTE,
  dayStartDoneTitle,
  minuteClock,
  NO_FIX_FOR_A_DAY_START,
  type DayStartView,
} from "@/lib/phoenix-crm/day-start-rules";

export function DayStartBlock({
  dayStart,
  onStarted,
  seatId,
  show,
  test,
}: {
  /** His start, once he has pressed it today. */
  dayStart: DayStartView | null;
  onStarted: () => void;
  seatId: string;
  /** Whether the button may be offered at all (`canStartDay`, decided by the day view). */
  show: boolean;
  test: boolean;
}) {
  const readFix = useSilentFix();
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  if (dayStart) {
    return (
      <CrmBlock>
        <CrmNote title={dayStartDoneTitle(cairoClock(dayStart.startedAt))} tone="good">
          <span className="block">{DAY_START_DONE_NOTE}</span>
          {dayStart.plannedAmMinute === null ? null : (
            <span className="mt-1 block">Your plan said {minuteClock(dayStart.plannedAmMinute)}.</span>
          )}
        </CrmNote>
      </CrmBlock>
    );
  }

  if (!show) return null;

  async function start() {
    if (saving) return;
    setSaving(true);
    setProblem(null);
    const fix = await readFix();
    if (!fix) {
      setProblem(NO_FIX_FOR_A_DAY_START);
      setSaving(false);
      return;
    }
    try {
      await crmPost("/api/phoenix-crm/day-start", { accuracyMeters: fix.accuracyMeters, lat: fix.lat, lon: fix.lon, seatId, test }, "dayStart");
      onStarted();
    } catch (error) {
      setProblem(messageOf(error));
      setSaving(false);
    }
  }

  return (
    <CrmBlock>
      {/* The one target, spanning the width: he is standing outside a clinic with the phone in one
          hand, which is the same reason Planned visit is the biggest thing on Add visit. */}
      <CrmButton
        busy={saving}
        className="w-full flex-col items-start justify-center gap-1 text-left min-h-20"
        onClick={() => void start()}
        variant="primary"
      >
        <span className="flex min-w-0 items-center gap-2">
          <Sunrise aria-hidden className="h-5 w-5 shrink-0" />
          <span className="min-w-0 break-words text-base font-black">{saving ? "Sending…" : DAY_START_BUTTON_LABEL}</span>
        </span>
        <span className="min-w-0 break-words text-xs font-semibold text-orange-50">{DAY_START_BUTTON_NOTE}</span>
      </CrmButton>
      <p className="mt-2 flex min-w-0 items-start gap-2 text-xs font-semibold text-slate-500">
        <CircleCheck aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-slate-400" />
        <span className="min-w-0 break-words">{DAY_START_LOCATION_NOTE}</span>
      </p>
      {problem ? (
        <CrmNote className="mt-3" title="Not sent" tone="bad">
          {problem}
        </CrmNote>
      ) : null}
    </CrmBlock>
  );
}
