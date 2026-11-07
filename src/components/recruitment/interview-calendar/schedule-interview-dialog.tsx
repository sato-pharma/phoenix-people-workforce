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
// BOOKING SENDS NOTHING. It writes the calendar and (for Zoom) makes the meeting on Phoenix's own Zoom
// account. The invitation goes only when the person presses send on the panel that follows — to the
// candidate and the interviewer, each by WhatsApp or e-mail (invitation-panel.tsx).

import { CalendarCheck2, Building2, Loader2, Video, X } from "lucide-react";
import { usePathname } from "next/navigation";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { useHydrated } from "@/hooks/use-hydrated";
import { Action, ActionLink } from "@/components/recruitment/workstation/workstation-look";
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
  LONG_DURATION_CHOICES,
  addDays,
  cairoDateKey,
  cairoMinutesOfDay,
  formatDayLong,
  formatDuration,
  formatTimeOfDay,
  formatTimeRange,
  isBookableDay,
  DAY_END_MINUTES,
  isBookableWindow,
  slotStarts,
  weekStartFor,
} from "@/lib/recruitment/interview-calendar-week";
import { MR_ROUND_LABELS } from "@/lib/recruitment/mr-hiring/vocabulary";
import { cn } from "@/lib/utils";

import { calendarApi, type CalendarApi } from "./calendar-api";
import { useTopmostEscape } from "./calendar-dialog";
import { InvitationPanel } from "./invitation-panel";
import { InterviewerPicker, type ChosenInterviewer } from "./interviewer-picker";
import { InterviewLocationField } from "./location-field";
import { OrgFields } from "./org-fields";
import { TimeOfDayInput } from "./time-of-day-input";
import { PanelPicker } from "./panel-picker";
import { MonthPicker, cursorFor, type MonthCursor } from "./month-picker";
import {
  phxFieldClassName,
  phxLabelClassName,
  phxSelectClassName,
  phxTextareaClassName,
} from "@/components/ui/form-tokens";
import { adminPanelHeaderClassName, adminRecessedDepthClassName } from "@/components/admin/admin-design-tokens";

/** The person: a Recruitment candidate, or (id null) someone from outside kept on the calendar only. */
export type ScheduleCandidate = { id: string | null; name: string; jobTitle?: string | null };

/** The first day an interview can still go on: today if it is a working day with time left, else the next one. */
function firstBookableDay(todayKey: string, nowMinutes: number): string {
  let key = todayKey;
  // Any time of day is bookable, so today counts until the last half hour before midnight.
  if (!isBookableDay(key) || nowMinutes >= DAY_END_MINUTES - 30) key = addDays(key, 1);
  while (!isBookableDay(key)) key = addDays(key, 1);
  return key;
}

function overlaps(aStart: number, aDuration: number, bStart: number, bDuration: number): boolean {
  return aStart < bStart + bDuration && bStart < aStart + aDuration;
}

export function ScheduleInterviewDialog({
  api: givenApi,
  candidate,
  existing,
  timeOnly = false,
  onClose,
  onSaved,
  zoomConnected,
}: {
  /** The calendar's requests, carrying a copy link when the calendar was opened from one. */
  api?: CalendarApi;
  candidate: ScheduleCandidate;
  /** Set to move an interview already on the calendar; absent to book a new one. */
  existing?: InterviewBooking | null;
  /**
   * Day/time/place only — no interviewer, panel or area/line. Used when the person moving the interview
   * is the DISTRICT MANAGER WHO REQUESTED it (owner, 2026-10-04): those fields are HR's, and the server
   * refuses a requester who sends them, so the dialog must not send them at all.
   */
  timeOnly?: boolean;
  onClose: () => void;
  onSaved?: (booking: InterviewBooking) => void;
  zoomConnected: boolean;
}) {
  const pathname = usePathname();
  const dialogRef = useDialogA11y({ onClose, open: true });
  const mounted = useHydrated();
  const [ownApi] = useState(() => calendarApi(null));
  const api = givenApi ?? ownApi;

  // Escape closes THIS pop-up only. It is often opened over a CV preview, which listens for Escape on
  // the document; answering first, on the window, and stopping the key there keeps the CV open
  // underneath. Closing both at once would also leave the page unable to scroll: each dialog puts
  // back the scroll lock it found, and unmounted together the outer one restores first. The shared
  // stack also lets a pop-up opened over THIS one take Escape first.
  useTopmostEscape(onClose);

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
  const [interviewer, setInterviewer] = useState<ChosenInterviewer | null>(
    existing?.interviewerHrId ? { hrId: existing.interviewerHrId, name: existing.interviewerName ?? existing.interviewerHrId } : null,
  );
  const [panel, setPanel] = useState<ChosenInterviewer[]>((existing?.panelists ?? []).map((member) => ({ hrId: member.hrId, name: member.name })));
  const [area, setArea] = useState(existing?.area ?? "");
  const [line, setLine] = useState(existing?.line ?? "");
  const [jobTitle, setJobTitle] = useState(existing?.jobTitle ?? "");
  const [location, setLocation] = useState(existing?.location ?? "");

  // Choosing the interviewer auto-fills the area & line from their own seat; both stay editable.
  function chooseInterviewer(person: ChosenInterviewer | null) {
    setInterviewer(person);
    if (person?.area || person?.line) {
      setArea(person.area ?? "");
      setLine(person.line ?? "");
    }
  }

  // The chosen day's answer, with the day it answered. Whether it is still reading is derived from
  // that, during render — so a day clicked a moment ago never shows the previous day's holders.
  const [dayAnswer, setDayAnswer] = useState<{ bookings: InterviewBooking[]; dateKey: string } | null>(null);
  const dayLoading = dayAnswer === null || dayAnswer.dateKey !== dateKey;
  const dayBookings = useMemo(() => (dayAnswer && dayAnswer.dateKey === dateKey ? dayAnswer.bookings : []), [dayAnswer, dateKey]);
  const [upcoming, setUpcoming] = useState<InterviewBooking[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<InterviewBooking | null>(null);

  // Who already holds the chosen day.
  useEffect(() => {
    let live = true;
    api
      .get(`/bookings?day=${encodeURIComponent(dateKey)}`)
      .then((data) => {
        if (live) setDayAnswer({ bookings: Array.isArray(data.bookings) ? (data.bookings as InterviewBooking[]) : [], dateKey });
      })
      .catch(() => {
        if (live) setDayAnswer({ bookings: [], dateKey });
      });
    return () => {
      live = false;
    };
  }, [api, dateKey]);

  // What this candidate already has booked, so a second interview is never booked by accident.
  useEffect(() => {
    if (existing || !candidate.id) return;
    let live = true;
    api
      .get(`/bookings?candidateId=${encodeURIComponent(candidate.id)}`)
      .then((data) => {
        if (live) setUpcoming(Array.isArray(data.bookings) ? (data.bookings as InterviewBooking[]) : []);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [api, candidate.id, existing]);

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
  // server will refuse. Done in the press itself, never in an effect after it.
  function chooseDuration(minutes: number) {
    setDurationMinutes(minutes);
    if (startMinutes !== null && !isBookableWindow(startMinutes, minutes)) setStartMinutes(null);
  }

  const ready = startMinutes !== null && platform !== null && !saving;

  async function save() {
    if (startMinutes === null || platform === null) return;
    setSaving(true);
    setError(null);
    try {
      // A requester (timeOnly) sends day/time/place only — the interviewer, panel and area/line are
      // HR's, and the server rejects a requester who sends them.
      // The place is part of "where", so a requester may set it too; a Zoom interview has none.
      const place = platform === "in_office" ? location.trim() || null : null;
      const body = timeOnly
        ? { dateKey, durationMinutes, location: place, notes: notes.trim(), platform, startMinutes }
        : { dateKey, durationMinutes, interviewerHrId: interviewer?.hrId ?? null, panelistHrIds: panel.map((member) => member.hrId), area: area.trim() || null, line: line.trim() || null, jobTitle: jobTitle.trim() || null, location: place, notes: notes.trim(), platform, startMinutes };
      const data = existing
        ? await api.patch(`/bookings/${encodeURIComponent(existing.id)}`, body)
        : await api.post(`/bookings`, { ...body, candidateId: candidate.id });
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
        className="flex max-h-[94vh] w-full max-w-[820px] flex-col border border-slate-200 bg-white shadow-[0_24px_60px_rgba(15,23,42,0.32)]"
        ref={dialogRef}
        role="dialog"
      >
        <header className={`flex items-start justify-between gap-3 px-4 py-3.5 text-white sm:px-5 ${adminPanelHeaderClassName}`}>
          <div className="min-w-0">
            <p className="flex items-center gap-1.5 text-[11px] font-black uppercase tracking-[0.12em] text-orange-300">
              <span aria-hidden className="inline-block h-2.5 w-[3px] bg-orange-500" />
              {title}
            </p>
            <h2 className="mt-1 break-words text-[17px] font-bold leading-snug tracking-tight text-white" id="schedule-interview-title">
              {candidate.name}
            </h2>
            {candidate.jobTitle ? <p className="mt-0.5 break-words text-[12px] leading-5 text-slate-300">Applied for {candidate.jobTitle}</p> : null}
          </div>
          <button
            aria-label="Close"
            className="inline-flex h-8 w-8 shrink-0 items-center justify-center border border-white/15 text-slate-300 transition-colors hover:border-white/40 hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-400"
            onClick={onClose}
            type="button"
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        {saved ? (
          <div className="flex min-h-0 flex-col gap-4 overflow-y-auto px-4 py-6 sm:px-5">
            <div className="flex items-start gap-3 border border-emerald-200 border-l-[3px] border-l-emerald-600 bg-emerald-50 px-4 py-3">
              <CalendarCheck2 className="mt-0.5 h-5 w-5 shrink-0 text-emerald-700" />
              <div className="min-w-0">
                <p className="text-[14px] font-bold text-slate-900">{existing ? "Interview moved" : "Interview booked"}</p>
                <p className="mt-0.5 text-[13px] tabular-nums text-slate-700">
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
                {saved.interviewerName ? <p className="mt-1 text-[12px] text-slate-600">Interviewer: {saved.interviewerName}</p> : null}
              </div>
            </div>
            <InvitationPanel api={api} bookingId={saved.id} />
            <div className="flex flex-wrap justify-end gap-2">
              <Action onClick={onClose} size="md" tone="quiet">
                Done
              </Action>
              {givenApi ? null : (
                <ActionLink
                  className="px-3 py-2 text-[13px]"
                  href={interviewCalendarHref({ base, open: saved.id, weekStart: weekStartFor(saved.dateKey) })}
                  tone="primary"
                >
                  Open the calendar
                </ActionLink>
              )}
            </div>
          </div>
        ) : (
          <>
            <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 sm:px-5">
              {existing?.sessionId ? (
                <p className="mb-4 border border-amber-200 border-l-[3px] border-l-amber-500 bg-amber-50 px-3 py-2 text-[12px] leading-5 text-slate-700">
                  This interview is a slot in {existing.sessionTitle ?? "an interview session"}. Moving it takes it out of the session: it
                  becomes an interview of its own{existing.platform === "zoom" ? ", with its own Zoom meeting" : ""}. To give it another slot
                  instead, cancel it and book the free slot from the session.
                </p>
              ) : null}
              {upcoming.length > 0 ? (
                <div className="mb-4 border border-amber-200 border-l-[3px] border-l-amber-500 bg-amber-50 px-3 py-2 text-[12px] text-slate-700">
                  <p className="font-bold text-slate-900">Already on the calendar</p>
                  <ul className="mt-0.5 tabular-nums">
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
                  <p className="mt-2 text-[13px] font-bold text-slate-900">{formatDayLong(dateKey)}</p>
                  <p className="text-[11px] text-slate-500">Any day of the week, 9:00 AM to 5:00 PM (Cairo).</p>
                </section>

                <section aria-label="Time">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <StepLabel number={2}>Time</StepLabel>
                    <div className="flex flex-wrap items-center gap-1.5">
                    <div aria-label="How long" className="flex border border-slate-200 shadow-[0_1px_2px_rgba(15,23,42,0.06)]" role="group">
                      {DURATION_CHOICES.map((minutes) => (
                        <button
                          aria-pressed={durationMinutes === minutes}
                          className={cn(
                            "px-2.5 py-1 text-[12px] font-bold tabular-nums transition-colors",
                            durationMinutes === minutes ? "bg-slate-900 text-white shadow-[inset_0_-2px_0_#f97316]" : "bg-white text-slate-600 hover:bg-slate-50 hover:text-slate-900",
                          )}
                          key={minutes}
                          onClick={() => chooseDuration(minutes)}
                          type="button"
                        >
                          {minutes} min
                        </button>
                      ))}
                    </div>
                    <select
                      aria-label="Longer"
                      className={phxSelectClassName}
                      onChange={(event) => {
                        const minutes = Number(event.target.value);
                        if (minutes > 0) chooseDuration(minutes);
                      }}
                      value={(LONG_DURATION_CHOICES as readonly number[]).includes(durationMinutes) ? durationMinutes : 0}
                    >
                      <option value={0}>Longer…</option>
                      {LONG_DURATION_CHOICES.map((minutes) => (
                        <option key={minutes} value={minutes}>
                          {formatDuration(minutes)}
                        </option>
                      ))}
                    </select>
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
                              ? "border-orange-600 bg-orange-600 text-white shadow-[0_2px_6px_rgba(234,88,12,0.35)]"
                              : disabled
                                ? "cursor-not-allowed border-slate-100 bg-slate-50 text-slate-300"
                                : holders.length > 0
                                  ? "border-amber-300 bg-amber-50 text-slate-800 shadow-[0_1px_2px_rgba(15,23,42,0.06)] hover:border-amber-500"
                                  : "border-slate-200 bg-white text-slate-800 shadow-[0_1px_2px_rgba(15,23,42,0.06)] hover:border-orange-400 hover:text-orange-700",
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
                  <label className="mt-2 flex flex-wrap items-center gap-2">
                    <span className={phxLabelClassName}>Another time</span>
                    <TimeOfDayInput
                      ariaLabel="Another time"
                      className={cn(phxFieldClassName, "w-auto")}
                      onChange={(minutes) => setStartMinutes(minutes !== null && isBookableWindow(minutes, durationMinutes) ? minutes : null)}
                      value={startMinutes}
                    />
                  </label>
                  <p className="mt-1.5 min-h-[16px] text-[11px] tabular-nums text-slate-500" aria-live="polite">
                    {dayLoading
                      ? "Reading the day…"
                      : startMinutes !== null
                        ? `${formatTimeRange(startMinutes, durationMinutes)} (${formatDuration(durationMinutes)})`
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
                    <div className="mt-2">
                      <InterviewLocationField location={location} onLocation={setLocation} platform={platform} />
                    </div>
                    {existing?.interviewRound ? (
                      <p className="mt-2 text-[11px] text-slate-600">
                        Medical Rep round: <span className="font-semibold text-slate-800">{MR_ROUND_LABELS[existing.interviewRound]}</span>
                      </p>
                    ) : null}
                  </div>

                  {timeOnly ? (
                    existing?.interviewerName ? (
                      <p className="mt-4 border-l-[3px] border-l-slate-300 bg-slate-50 px-3 py-2 text-[12px] leading-5 text-slate-600">
                        Interviewer: <span className="font-semibold text-slate-800">{existing.interviewerName}</span>. The interviewer, panel
                        and area are set by HR.
                      </p>
                    ) : null
                  ) : (
                    <div className="mt-4">
                      <StepLabel number={4}>Interviewer (optional)</StepLabel>
                      <InterviewerPicker api={api} onChange={chooseInterviewer} value={interviewer} />
                      <p className="mt-1 text-[11px] text-slate-500">Choosing the interviewer fills in the area & line below — you can change them.</p>
                      <div className="mt-3">
                        <OrgFields api={api} area={area} jobTitle={jobTitle} line={line} onArea={setArea} onJobTitle={setJobTitle} onLine={setLine} />
                      </div>
                      <div className="mt-3">
                        <p className={phxLabelClassName}>Panel (optional)</p>
                        <PanelPicker api={api} excludeHrId={interviewer?.hrId ?? null} onChange={setPanel} value={panel} />
                        <p className="mt-1 text-[11px] text-slate-500">Everyone added also sees this interview on their own calendar; the interviewer above records how it went.</p>
                      </div>
                    </div>
                  )}

                  <label className="mt-4 block">
                    <span className={phxLabelClassName}>Note (optional)</span>
                    <textarea
                      className={`${phxTextareaClassName} block`}
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

            <footer className={`flex flex-col gap-2 border-t border-slate-200 bg-slate-50 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-5 ${adminRecessedDepthClassName}`}>
              <p className="min-w-0 break-words text-[12px] tabular-nums text-slate-600" role={error ? "alert" : undefined}>
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
    <p className="mb-2 flex items-center gap-2 text-[12px] font-black uppercase tracking-[0.08em] text-slate-800">
      <span className="inline-flex h-5 w-5 items-center justify-center bg-orange-600 text-[11px] font-black tabular-nums text-white shadow-[0_1px_3px_rgba(234,88,12,0.4)]">
        {number}
      </span>
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
        selected
          ? "border-orange-600 bg-orange-50 text-orange-800 shadow-[inset_0_0_0_1px_#ea580c]"
          : "border-slate-200 bg-white text-slate-800 shadow-[0_1px_2px_rgba(15,23,42,0.06)] hover:border-orange-300",
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
