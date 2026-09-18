"use client";

// The Schedule interview pop-up — the one the owner asked for on 2026-09-18, reachable from any CV:
// "a pop-up appears with … a date picker. I choose the date then I choose the time. Then I choose the
// platform. Either in office or Zoom."
//
// Three decisions, in that order, and nothing else asked of him: a day on a month grid (Sunday to
// Thursday, never a day gone), a half-hour on the 9-to-5 grid the calendar itself draws, and where.
// How long defaults to half an hour; a note is optional. The same pop-up moves an interview — it
// opens on that interview's own day, time and place.
//
// A TAKEN SLOT IS SHOWN, NOT REFUSED. Two interviews in one half-hour are sometimes a mistake and
// sometimes a panel; the person booking knows which. So every time on the chosen day says who holds
// it already, and the choice stays theirs.
//
// NOTHING IS SENT TO THE CANDIDATE. The owner chose "calendar only": booking writes the calendar and
// (for Zoom) makes the meeting on Phoenix's own Zoom account. No email, no WhatsApp.

import { CalendarCheck2, Building2, Loader2, Video, X } from "lucide-react";
import { usePathname } from "next/navigation";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { Action, ActionLink } from "@/components/recruitment/workstation/workstation-look";
import { getJson, patchJson, postJson } from "@/components/recruitment/recruitment-fetch";
import { useDialogA11y } from "@/components/ui/use-dialog-a11y";
import {
  PLATFORM_LABEL,
  interviewCalendarBaseFor,
  interviewCalendarHref,
  zoomStatusSentence,
  type InterviewBooking,
  type InterviewPlatform,
} from "@/lib/recruitment/interview-calendar-types";
import {
  DEFAULT_DURATION_MINUTES,
  DURATION_CHOICES,
  addDays,
  cairoDateKey,
  cairoMinutesOfDay,
  formatDayLong,
  formatTimeOfDay,
  formatTimeRange,
  isBookableDay,
  isBookableWindow,
  slotStarts,
  weekStartFor,
} from "@/lib/recruitment/interview-calendar-week";
import { cn } from "@/lib/utils";

import { MonthPicker, cursorFor, type MonthCursor } from "./month-picker";

export type ScheduleCandidate = { id: string; name: string; jobTitle?: string | null };

const API = "/api/recruitment/interview-calendar";

/** The first day an interview can still go on: today if it is a working day with time left, else the next one. */
function firstBookableDay(todayKey: string, nowMinutes: number): string {
  let key = todayKey;
  const starts = slotStarts();
  const lastStart = starts[starts.length - 1] ?? 0;
  if (!isBookableDay(key) || nowMinutes >= lastStart) key = addDays(key, 1);
  while (!isBookableDay(key)) key = addDays(key, 1);
  return key;
}

function overlaps(aStart: number, aDuration: number, bStart: number, bDuration: number): boolean {
  return aStart < bStart + bDuration && bStart < aStart + aDuration;
}

export function ScheduleInterviewDialog({
  candidate,
  existing,
  onClose,
  onSaved,
  zoomConnected,
}: {
  candidate: ScheduleCandidate;
  /** Set to move an interview already on the calendar; absent to book a new one. */
  existing?: InterviewBooking | null;
  onClose: () => void;
  onSaved?: (booking: InterviewBooking) => void;
  zoomConnected: boolean;
}) {
  const pathname = usePathname();
  const dialogRef = useDialogA11y({ onClose, open: true });
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  // Escape closes THIS pop-up only. It is often opened over a CV preview, which listens for Escape on
  // the document; answering first, on the window, and stopping the key there keeps the CV open
  // underneath. Closing both at once would also leave the page unable to scroll: each dialog puts
  // back the scroll lock it found, and unmounted together the outer one restores first.
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      onCloseRef.current();
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  // "Now" is read once, when the pop-up opens: a clock ticking under the chips would disable the
  // one the person is reaching for.
  const [now] = useState(() => new Date());
  const todayKey = cairoDateKey(now);
  const nowMinutes = cairoMinutesOfDay(now);

  const [dateKey, setDateKey] = useState<string>(() => existing?.dateKey ?? firstBookableDay(todayKey, nowMinutes));
  const [cursor, setCursor] = useState<MonthCursor>(() => cursorFor(existing?.dateKey ?? firstBookableDay(todayKey, nowMinutes)));
  const [startMinutes, setStartMinutes] = useState<number | null>(existing?.startMinutes ?? null);
  const [durationMinutes, setDurationMinutes] = useState<number>(existing?.durationMinutes ?? DEFAULT_DURATION_MINUTES);
  const [platform, setPlatform] = useState<InterviewPlatform | null>(existing?.platform ?? null);
  const [notes, setNotes] = useState(existing?.notes ?? "");

  const [dayBookings, setDayBookings] = useState<InterviewBooking[]>([]);
  const [dayLoading, setDayLoading] = useState(false);
  const [upcoming, setUpcoming] = useState<InterviewBooking[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<InterviewBooking | null>(null);

  // Who already holds the chosen day.
  useEffect(() => {
    let live = true;
    setDayLoading(true);
    getJson(`${API}/bookings?day=${encodeURIComponent(dateKey)}`)
      .then((data) => {
        if (live) setDayBookings(Array.isArray(data.bookings) ? (data.bookings as InterviewBooking[]) : []);
      })
      .catch(() => {
        if (live) setDayBookings([]);
      })
      .finally(() => {
        if (live) setDayLoading(false);
      });
    return () => {
      live = false;
    };
  }, [dateKey]);

  // What this candidate already has booked, so a second interview is never booked by accident.
  useEffect(() => {
    if (existing) return;
    let live = true;
    getJson(`${API}/bookings?candidateId=${encodeURIComponent(candidate.id)}`)
      .then((data) => {
        if (live) setUpcoming(Array.isArray(data.bookings) ? (data.bookings as InterviewBooking[]) : []);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [candidate.id, existing]);

  const others = useMemo(() => dayBookings.filter((booking) => booking.id !== existing?.id), [dayBookings, existing?.id]);

  function chipState(minutes: number): { disabled: boolean; holders: string[] } {
    const fits = isBookableWindow(minutes, durationMinutes);
    const gone = dateKey < todayKey || (dateKey === todayKey && minutes <= nowMinutes);
    const holders = others
      .filter((booking) => overlaps(minutes, durationMinutes, booking.startMinutes, booking.durationMinutes))
      .map((booking) => booking.candidateName);
    return { disabled: !fits || gone, holders };
  }

  // A duration change can push the chosen time past 5:00 PM; drop it rather than book something the
  // server will refuse.
  useEffect(() => {
    if (startMinutes !== null && !isBookableWindow(startMinutes, durationMinutes)) setStartMinutes(null);
  }, [durationMinutes, startMinutes]);

  const ready = startMinutes !== null && platform !== null && !saving;

  async function save() {
    if (startMinutes === null || platform === null) return;
    setSaving(true);
    setError(null);
    try {
      const body = { dateKey, durationMinutes, notes: notes.trim(), platform, startMinutes };
      const data = existing
        ? await patchJson(`${API}/bookings/${existing.id}`, body)
        : await postJson(`${API}/bookings`, { ...body, candidateId: candidate.id });
      const booking = data.booking as InterviewBooking;
      setSaved(booking);
      onSaved?.(booking);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The interview could not be saved.");
    } finally {
      setSaving(false);
    }
  }

  const title = existing ? "Move interview" : "Schedule interview";
  const base = interviewCalendarBaseFor(pathname);

  const body = (
    <div
      className="fixed inset-0 z-[210] flex items-end justify-center bg-slate-900/45 sm:items-center sm:p-4"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        aria-labelledby="schedule-interview-title"
        aria-modal="true"
        className="flex max-h-[94vh] w-full max-w-[820px] flex-col border border-slate-200 bg-white shadow-[0_24px_60px_rgba(15,23,42,0.28)]"
        ref={dialogRef}
        role="dialog"
      >
        <header className="flex items-start justify-between gap-3 border-b border-slate-200 px-4 py-3 sm:px-5">
          <div className="min-w-0">
            <p className="text-[11px] font-bold uppercase tracking-[0.08em] text-orange-700">{title}</p>
            <h2 className="mt-0.5 break-words text-[17px] font-bold text-slate-900" id="schedule-interview-title">
              {candidate.name}
            </h2>
            {candidate.jobTitle ? <p className="text-[12px] text-slate-500">Applied for {candidate.jobTitle}</p> : null}
          </div>
          <button
            aria-label="Close"
            className="inline-flex h-8 w-8 shrink-0 items-center justify-center border border-transparent text-slate-500 hover:border-slate-200 hover:text-slate-900"
            onClick={onClose}
            type="button"
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        {saved ? (
          <div className="flex flex-col gap-4 px-4 py-6 sm:px-5">
            <div className="flex items-start gap-3 border-l-[3px] border-l-emerald-600 bg-emerald-50 px-4 py-3">
              <CalendarCheck2 className="mt-0.5 h-5 w-5 shrink-0 text-emerald-700" />
              <div className="min-w-0">
                <p className="text-[14px] font-bold text-slate-900">{existing ? "Interview moved" : "Interview booked"}</p>
                <p className="mt-0.5 text-[13px] text-slate-700">
                  {formatDayLong(saved.dateKey)} · {formatTimeRange(saved.startMinutes, saved.durationMinutes)} ·{" "}
                  {PLATFORM_LABEL[saved.platform]}
                </p>
                {zoomStatusSentence(saved.zoomStatus, saved.zoomError) ? (
                  <p className="mt-1 text-[12px] text-slate-600">{zoomStatusSentence(saved.zoomStatus, saved.zoomError)}</p>
                ) : null}
                {saved.zoomJoinUrl ? (
                  <a className="mt-1 block break-all text-[12px] font-semibold text-orange-700 underline" href={saved.zoomJoinUrl} rel="noreferrer" target="_blank">
                    {saved.zoomJoinUrl}
                  </a>
                ) : null}
                <p className="mt-1 text-[12px] text-slate-500">Nothing was sent to the candidate.</p>
              </div>
            </div>
            <div className="flex flex-wrap justify-end gap-2">
              <Action onClick={onClose} size="md" tone="quiet">
                Done
              </Action>
              <ActionLink
                className="px-3 py-2 text-[13px]"
                href={interviewCalendarHref({ base, open: saved.id, weekStart: weekStartFor(saved.dateKey) })}
                tone="primary"
              >
                Open the calendar
              </ActionLink>
            </div>
          </div>
        ) : (
          <>
            <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 sm:px-5">
              {upcoming.length > 0 ? (
                <div className="mb-4 border-l-[3px] border-l-amber-500 bg-amber-50 px-3 py-2 text-[12px] text-slate-700">
                  <p className="font-bold text-slate-900">Already on the calendar</p>
                  <ul className="mt-0.5">
                    {upcoming.map((booking) => (
                      <li key={booking.id}>
                        {formatDayLong(booking.dateKey)} · {formatTimeRange(booking.startMinutes, booking.durationMinutes)} ·{" "}
                        {PLATFORM_LABEL[booking.platform]}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}

              <div className="grid gap-5 md:grid-cols-[minmax(0,17rem)_minmax(0,1fr)]">
                <section aria-label="Date">
                  <StepLabel number={1}>Date</StepLabel>
                  <MonthPicker
                    cursor={cursor}
                    onCursor={setCursor}
                    onSelect={(key) => {
                      setDateKey(key);
                      setStartMinutes(null);
                    }}
                    selected={dateKey}
                    todayKey={todayKey}
                  />
                  <p className="mt-2 text-[12px] font-semibold text-slate-700">{formatDayLong(dateKey)}</p>
                  <p className="text-[11px] text-slate-500">Sunday to Thursday, 9:00 AM to 5:00 PM (Cairo).</p>
                </section>

                <section aria-label="Time">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <StepLabel number={2}>Time</StepLabel>
                    <div aria-label="How long" className="flex border border-slate-200" role="group">
                      {DURATION_CHOICES.map((minutes) => (
                        <button
                          aria-pressed={durationMinutes === minutes}
                          className={cn(
                            "px-2.5 py-1 text-[12px] font-bold",
                            durationMinutes === minutes ? "bg-slate-900 text-white" : "bg-white text-slate-600 hover:bg-slate-50",
                          )}
                          key={minutes}
                          onClick={() => setDurationMinutes(minutes)}
                          type="button"
                        >
                          {minutes} min
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="mt-2 grid grid-cols-2 gap-1.5 sm:grid-cols-4">
                    {slotStarts().map((minutes) => {
                      const { disabled, holders } = chipState(minutes);
                      const selected = startMinutes === minutes;
                      return (
                        <button
                          aria-pressed={selected}
                          className={cn(
                            "flex min-h-[44px] flex-col items-start justify-center border px-2 py-1 text-left transition-colors",
                            selected
                              ? "border-orange-600 bg-orange-600 text-white"
                              : disabled
                                ? "cursor-not-allowed border-slate-100 bg-slate-50 text-slate-300"
                                : holders.length > 0
                                  ? "border-amber-300 bg-amber-50 text-slate-800 hover:border-amber-500"
                                  : "border-slate-200 bg-white text-slate-800 hover:border-orange-400 hover:text-orange-700",
                          )}
                          disabled={disabled}
                          key={minutes}
                          onClick={() => setStartMinutes(minutes)}
                          type="button"
                        >
                          <span className="text-[13px] font-bold tabular-nums">{formatTimeOfDay(minutes)}</span>
                          {holders.length > 0 && !disabled ? (
                            <span className={cn("break-words text-[10px] leading-tight", selected ? "text-orange-50" : "text-amber-800")}>
                              {holders.join(", ")}
                            </span>
                          ) : null}
                        </button>
                      );
                    })}
                  </div>
                  <p className="mt-1.5 min-h-[16px] text-[11px] text-slate-500" aria-live="polite">
                    {dayLoading
                      ? "Reading the day…"
                      : startMinutes !== null
                        ? `${formatTimeRange(startMinutes, durationMinutes)}`
                        : others.length > 0
                          ? "A time with a name on it is already taken by that interview. You can still share it."
                          : "The whole day is free."}
                  </p>

                  <div className="mt-4">
                    <StepLabel number={3}>Where</StepLabel>
                    <div className="grid grid-cols-2 gap-2">
                      <PlatformCard
                        icon={<Building2 className="h-5 w-5" />}
                        label={PLATFORM_LABEL.in_office}
                        onSelect={() => setPlatform("in_office")}
                        selected={platform === "in_office"}
                        sub="At the office"
                      />
                      <PlatformCard
                        icon={<Video className="h-5 w-5" />}
                        label={PLATFORM_LABEL.zoom}
                        onSelect={() => setPlatform("zoom")}
                        selected={platform === "zoom"}
                        sub={zoomConnected ? "Phoenix makes the meeting" : "Zoom is not connected yet"}
                      />
                    </div>
                    {platform === "zoom" && !zoomConnected ? (
                      <p className="mt-1.5 text-[11px] text-amber-800">
                        The interview is booked as Zoom; its meeting link is made once Zoom is connected to Phoenix.
                      </p>
                    ) : null}
                  </div>

                  <label className="mt-4 block">
                    <span className="text-[12px] font-bold text-slate-700">Note (optional)</span>
                    <textarea
                      className="mt-1 block w-full border border-slate-200 px-2 py-1.5 text-[13px] text-slate-800 focus:border-orange-500 focus:outline-none"
                      maxLength={2000}
                      onChange={(event) => setNotes(event.target.value)}
                      placeholder="Who interviews, what to bring, anything the panel should know"
                      rows={2}
                      value={notes}
                    />
                  </label>
                </section>
              </div>
            </div>

            <footer className="flex flex-col gap-2 border-t border-slate-200 bg-slate-50 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-5">
              <p className="min-w-0 text-[12px] text-slate-600" role={error ? "alert" : undefined}>
                {error ? (
                  <span className="font-semibold text-red-700">{error}</span>
                ) : startMinutes !== null && platform ? (
                  <>
                    <span className="font-bold text-slate-900">{formatDayLong(dateKey)}</span> ·{" "}
                    {formatTimeRange(startMinutes, durationMinutes)} · {PLATFORM_LABEL[platform]}
                  </>
                ) : (
                  "Choose a date, a time and where."
                )}
              </p>
              <div className="flex shrink-0 justify-end gap-2">
                <Action onClick={onClose} size="md" tone="quiet">
                  Cancel
                </Action>
                <Action disabled={!ready} onClick={() => void save()} size="md" tone="primary">
                  {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <CalendarCheck2 className="h-4 w-4" />}
                  {existing ? "Move interview" : "Book interview"}
                </Action>
              </div>
            </footer>
          </>
        )}
      </div>
    </div>
  );

  return mounted ? createPortal(body, document.body) : null;
}

function StepLabel({ children, number }: { children: ReactNode; number: number }) {
  return (
    <p className="mb-2 flex items-center gap-2 text-[12px] font-bold uppercase tracking-[0.06em] text-slate-700">
      <span className="inline-flex h-5 w-5 items-center justify-center bg-slate-900 text-[11px] text-white">{number}</span>
      {children}
    </p>
  );
}

function PlatformCard({
  icon,
  label,
  onSelect,
  selected,
  sub,
}: {
  icon: ReactNode;
  label: string;
  onSelect: () => void;
  selected: boolean;
  sub: string;
}) {
  return (
    <button
      aria-pressed={selected}
      className={cn(
        "flex items-center gap-2.5 border px-3 py-2.5 text-left transition-colors",
        selected ? "border-orange-600 bg-orange-50 text-orange-800" : "border-slate-200 bg-white text-slate-800 hover:border-orange-300",
      )}
      onClick={onSelect}
      type="button"
    >
      <span className={cn("shrink-0", selected ? "text-orange-600" : "text-slate-400")}>{icon}</span>
      <span className="min-w-0">
        <span className="block text-[13px] font-bold">{label}</span>
        <span className="block text-[11px] text-slate-500">{sub}</span>
      </span>
    </button>
  );
}
