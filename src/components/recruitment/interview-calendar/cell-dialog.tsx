"use client";

// Pressing an empty cell of the calendar — the owner, 2026-09-18: "make the cells under the day and
// beside timing pressable. I can either schedule from interviews on system or … upload … a CV …
// from system or outside the system, both applicable."
//
// Two things start here, on the day and time pressed:
//   One interview      a Phoenix candidate or someone from outside, 30 minutes up to the whole day.
//   Interview session  one meeting for a block of the day ("day 20 from 11 a.m. to 3 p.m."), cut
//                      into slots of 15, 30, 45 or 60 minutes; people are added to the slots now or
//                      later, and every slot shares the session's one Zoom link.
//
// NOTHING IS SENT to anyone booked. Zoom makes the meeting on Phoenix's own account; the invitation
// is there to copy or to send on WhatsApp by hand.

import { Building2, CalendarCheck2, Loader2, Users, Video } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { Action } from "@/components/recruitment/workstation/workstation-look";
import {
  PLATFORM_LABEL,
  sessionSlotStarts,
  zoomStatusSentence,
  type InterviewBooking,
  type InterviewPlatform,
  type InterviewSession,
} from "@/lib/recruitment/interview-calendar-types";
import {
  DEFAULT_SESSION_SLOT_MINUTES,
  DURATION_CHOICES,
  LONG_DURATION_CHOICES,
  SESSION_SLOT_CHOICES,
  DAY_END_MINUTES,
  MAX_DURATION_MINUTES,
  formatDayLong,
  formatDuration,
  formatTimeOfDay,
  formatTimeRange,
} from "@/lib/recruitment/interview-calendar-week";
import { cn } from "@/lib/utils";

import { type CalendarApi, reasonText } from "./calendar-api";
import { CalendarDialog, ErrorLine, NoteLine, Segmented } from "./calendar-dialog";
import { InterviewerPicker, type ChosenInterviewer } from "./interviewer-picker";
import { InterviewLocationField } from "./location-field";
import { OrgFields } from "./org-fields";
import { PanelPicker } from "./panel-picker";
import { TimeOfDayInput } from "./time-of-day-input";
import { PersonPicker, initialPersonChoice, personLabel, personProblem, submitBooking, type PersonChoice } from "./person-picker";
import {
  phxFieldClassName,
  phxLabelClassName,
  phxSelectClassName,
  phxTextareaClassName,
} from "@/components/ui/form-tokens";
import { adminRecessedDepthClassName } from "@/components/admin/admin-design-tokens";

const QUARTER = 15;
const SHORTEST = 30;

/** Every quarter hour after `start` a session may end at: half an hour on, up to midnight or eight hours on. */
export function endChoices(start: number): number[] {
  const ends: number[] = [];
  const last = Math.min(DAY_END_MINUTES, start + MAX_DURATION_MINUTES);
  for (let at = start + SHORTEST; at <= last; at += QUARTER) ends.push(at);
  return ends;
}

/** The latest a booking may start: half an hour before midnight. Any minute before it is free. */
export const LATEST_START = DAY_END_MINUTES - SHORTEST;

function fits(start: number, minutes: number): boolean {
  return start + minutes <= DAY_END_MINUTES;
}

const selectClass  = phxSelectClassName;

export function PlatformChoice({
  onChange,
  value,
  zoomConnected,
}: {
  onChange: (platform: InterviewPlatform) => void;
  value: InterviewPlatform | null;
  zoomConnected: boolean;
}) {
  const options: Array<{ platform: InterviewPlatform; sub: string }> = [
    { platform: "in_office", sub: "At the office" },
    { platform: "zoom", sub: zoomConnected ? "Phoenix makes the meeting" : "Zoom is not connected yet" },
  ];
  return (
    <div className="grid grid-cols-2 gap-2">
      {options.map((option) => {
        const selected = value === option.platform;
        return (
          <button
            aria-pressed={selected}
            className={cn(
              "flex items-center gap-2.5 border px-3 py-2.5 text-left transition-colors",
              selected
                ? "border-orange-600 bg-orange-50 text-orange-800 shadow-[inset_0_0_0_1px_#ea580c]"
                : "border-slate-200 bg-white text-slate-800 shadow-[0_1px_2px_rgba(15,23,42,0.06)] hover:border-orange-300",
            )}
            key={option.platform}
            onClick={() => onChange(option.platform)}
            type="button"
          >
            <span className={cn("shrink-0", selected ? "text-orange-600" : "text-slate-400")}>
              {option.platform === "zoom" ? <Video className="h-5 w-5" /> : <Building2 className="h-5 w-5" />}
            </span>
            <span className="min-w-0">
              <span className="block text-[13px] font-bold">{PLATFORM_LABEL[option.platform]}</span>
              <span className="block text-[11px] text-slate-500">{option.sub}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

function FieldLabel({ children }: { children: string }) {
  return <span className={phxLabelClassName}>{children}</span>;
}

type Done =
  | { kind: "booking"; booking: InterviewBooking; notice: string | null }
  | { kind: "session"; session: InterviewSession };

export function CellDialog({
  api,
  canAdd,
  canSearch,
  dateKey,
  initialStart,
  onBooked,
  onClose,
  onOpenBooking,
  onOpenSession,
  onSessionCreated,
  zoomConnected,
}: {
  api: CalendarApi;
  canAdd: boolean;
  canSearch: boolean;
  dateKey: string;
  initialStart: number;
  onBooked: (booking: InterviewBooking) => void;
  onClose: () => void;
  onOpenBooking: (id: string) => void;
  onOpenSession: (id: string) => void;
  onSessionCreated: (session: InterviewSession) => void;
  zoomConnected: boolean;
}) {
  const firstStart = Math.min(Math.max(initialStart, 0), LATEST_START);

  const [mode, setMode] = useState<"interview" | "session">("interview");
  const [person, setPerson] = useState<PersonChoice>(() => initialPersonChoice(canSearch, canAdd));
  const [start, setStart] = useState(firstStart);
  const [duration, setDuration] = useState(30);
  const [platform, setPlatform] = useState<InterviewPlatform | null>(null);
  const [interviewer, setInterviewer] = useState<ChosenInterviewer | null>(null);
  const [panel, setPanel] = useState<ChosenInterviewer[]>([]);
  const [area, setArea] = useState("");
  const [line, setLine] = useState("");
  const [jobTitle, setJobTitle] = useState("");
  const [location, setLocation] = useState("");
  const [notes, setNotes] = useState("");
  const [title, setTitle] = useState("");
  const [end, setEnd] = useState(() => Math.min(firstStart + 4 * 60, DAY_END_MINUTES));
  const [slot, setSlot] = useState<number>(DEFAULT_SESSION_SLOT_MINUTES);
  const [sessionPlatform, setSessionPlatform] = useState<InterviewPlatform>("zoom");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<Done | null>(null);
  const [day, setDay] = useState<{ bookings: InterviewBooking[]; sessions: InterviewSession[] } | null>(null);

  // What is already on the day, so a clash is seen before it is made — shown, never refused.
  useEffect(() => {
    let live = true;
    api
      .get(`/bookings?day=${encodeURIComponent(dateKey)}`)
      .then((data) => {
        if (!live) return;
        setDay({
          bookings: Array.isArray(data.bookings) ? (data.bookings as InterviewBooking[]) : [],
          sessions: Array.isArray(data.sessions) ? (data.sessions as InterviewSession[]) : [],
        });
      })
      .catch(() => {
        if (live) setDay({ bookings: [], sessions: [] });
      });
    return () => {
      live = false;
    };
  }, [api, dateKey]);

  const sessionMinutes = end - start;
  const slots = useMemo(() => sessionSlotStarts({ durationMinutes: sessionMinutes, slotMinutes: slot, startMinutes: start }), [sessionMinutes, slot, start]);
  const leftover = sessionMinutes - slots.length * slot;

  function chooseStart(next: number | null) {
    if (next === null || next > LATEST_START) return;
    setStart(next);
    if (!fits(next, duration)) setDuration(SHORTEST);
    if (end < next + SHORTEST || end > next + MAX_DURATION_MINUTES) setEnd(Math.min(next + 4 * 60, DAY_END_MINUTES));
  }

  // Choosing the interviewer auto-fills the area & line from their own seat; both stay editable.
  function chooseInterviewer(person: ChosenInterviewer | null) {
    setInterviewer(person);
    if (person?.area || person?.line) {
      setArea(person.area ?? "");
      setLine(person.line ?? "");
    }
  }

  const onTheDay = useMemo(() => {
    if (!day) return [];
    const lines: Array<{ key: string; start: number; text: string }> = [];
    for (const session of day.sessions) {
      lines.push({
        key: `s-${session.id}`,
        start: session.startMinutes,
        text: `${formatTimeRange(session.startMinutes, session.durationMinutes)} · ${session.title ?? "Interview session"}`,
      });
    }
    for (const booking of day.bookings) {
      if (booking.sessionId) continue;
      lines.push({ key: `b-${booking.id}`, start: booking.startMinutes, text: `${formatTimeRange(booking.startMinutes, booking.durationMinutes)} · ${booking.candidateName}` });
    }
    return lines.sort((a, b) => a.start - b.start);
  }, [day]);

  // A time already gone is booked like any other — HR records an interview held before it was put on
  // the calendar (owner, 8 Nov 2026: "don't block anything to me").
  const interviewProblem = personProblem(person) ?? (platform === null ? "Choose In office or Zoom." : null);
  const sessionProblem = slots.length === 0 ? "The session is shorter than one slot." : null;

  async function book() {
    if (interviewProblem || platform === null) return;
    setBusy(true);
    setError(null);
    try {
      const data = await submitBooking(api, person, {
        dateKey,
        durationMinutes: duration,
        interviewerHrId: interviewer?.hrId ?? null,
        panelistHrIds: panel.map((member) => member.hrId),
        area: area.trim() || null,
        line: line.trim() || null,
        jobTitle: jobTitle.trim() || null,
        location: platform === "in_office" ? location.trim() || null : null,
        notes: notes.trim(),
        platform,
        startMinutes: start,
      });
      const booking = data.booking as InterviewBooking;
      onBooked(booking);
      setDone({ booking, kind: "booking", notice: typeof data.notice === "string" ? data.notice : null });
    } catch (reason) {
      setError(reasonText(reason, "The interview could not be booked."));
    } finally {
      setBusy(false);
    }
  }

  async function createSession() {
    if (sessionProblem) return;
    setBusy(true);
    setError(null);
    try {
      const data = await api.post("/sessions", {
        dateKey,
        durationMinutes: sessionMinutes,
        notes: notes.trim(),
        platform: sessionPlatform,
        slotMinutes: slot,
        startMinutes: start,
        title: title.trim(),
      });
      const session = data.session as InterviewSession;
      onSessionCreated(session);
      setDone({ kind: "session", session });
    } catch (reason) {
      setError(reasonText(reason, "The session could not be made."));
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    const booking = done.kind === "booking" ? done.booking : null;
    const session = done.kind === "session" ? done.session : null;
    const zoomLine = booking ? zoomStatusSentence(booking.zoomStatus, booking.zoomError) : session ? zoomStatusSentence(session.zoomStatus, session.zoomError) : null;
    const joinUrl = booking?.zoomJoinUrl ?? session?.zoomJoinUrl ?? null;
    return (
      <CalendarDialog eyebrow={formatDayLong(dateKey)} onClose={onClose} title={booking ? "Interview booked" : "Interview session made"} width="sm">
        <div className="flex flex-col gap-4">
          <div className="flex items-start gap-3 border border-emerald-200 border-l-[3px] border-l-emerald-600 bg-emerald-50 px-4 py-3">
            <CalendarCheck2 className="mt-0.5 h-5 w-5 shrink-0 text-emerald-700" />
            <div className="min-w-0 text-[13px] text-slate-700">
              {booking ? (
                <>
                  <p className="break-words text-[14px] font-bold text-slate-900">{booking.candidateName}</p>
                  <p className="tabular-nums">
                    {formatTimeRange(booking.startMinutes, booking.durationMinutes)} · {formatDuration(booking.durationMinutes)} · {PLATFORM_LABEL[booking.platform]}
                  </p>
                  {booking.interviewerName ? <p className="mt-1 text-[12px] text-slate-600">Interviewer: {booking.interviewerName}</p> : null}
                </>
              ) : session ? (
                <>
                  <p className="break-words text-[14px] font-bold text-slate-900">{session.title ?? "Interview session"}</p>
                  <p className="tabular-nums">
                    {formatTimeRange(session.startMinutes, session.durationMinutes)} · {sessionSlotStarts(session).length} slots of {session.slotMinutes} min ·{" "}
                    {PLATFORM_LABEL[session.platform]}
                  </p>
                </>
              ) : null}
              {zoomLine ? <p className="mt-1 text-[12px] text-amber-800">{zoomLine}</p> : null}
              {joinUrl ? (
                <a className="mt-1 block break-all text-[12px] font-semibold text-sky-700 underline" href={joinUrl} rel="noreferrer" target="_blank">
                  {joinUrl}
                </a>
              ) : null}
              <p className="mt-1 text-[12px] text-slate-500">Nothing was sent to anyone.</p>
            </div>
          </div>
          {done.kind === "booking" && done.notice ? <NoteLine tone="sky">{done.notice}</NoteLine> : null}
          <div className="flex flex-wrap justify-end gap-2">
            <Action onClick={onClose} size="md" tone="quiet">
              Done
            </Action>
            {booking ? (
              <Action onClick={() => onOpenBooking(booking.id)} size="md" tone="primary">
                Open the interview
              </Action>
            ) : session ? (
              <Action onClick={() => onOpenSession(session.id)} size="md" tone="primary">
                <Users className="h-4 w-4" />
                Open the session to add people
              </Action>
            ) : null}
          </div>
        </div>
      </CalendarDialog>
    );
  }

  const problem = mode === "interview" ? interviewProblem : sessionProblem;
  const summary =
    mode === "interview"
      ? `${formatTimeRange(start, duration)}${personLabel(person) ? ` · ${personLabel(person)}` : ""}${platform ? ` · ${PLATFORM_LABEL[platform]}` : ""}`
      : `${formatTimeRange(start, sessionMinutes)} · ${slots.length} ${slots.length === 1 ? "slot" : "slots"} of ${slot} min · ${PLATFORM_LABEL[sessionPlatform]}`;

  return (
    <CalendarDialog
      eyebrow="Book on the calendar"
      footer={
        <>
          <p className="min-w-0 break-words text-[12px] tabular-nums text-slate-600">
            {error ? <span className="font-semibold text-red-700">{error}</span> : problem ? problem : <span className="font-semibold text-slate-900">{summary}</span>}
          </p>
          <div className="flex shrink-0 justify-end gap-2">
            <Action onClick={onClose} size="md" tone="quiet">
              Cancel
            </Action>
            <Action disabled={busy || problem !== null} onClick={() => void (mode === "interview" ? book() : createSession())} size="md" tone="primary">
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <CalendarCheck2 className="h-4 w-4" />}
              {mode === "interview" ? "Book interview" : "Make the session"}
            </Action>
          </div>
        </>
      }
      onClose={onClose}
      sub={formatDayLong(dateKey)}
      title={mode === "interview" ? "One interview" : "Interview session"}
      width="lg"
    >
      <div className="flex flex-col gap-4">
        <Segmented<"interview" | "session">
          label="What to book"
          onChange={(next) => {
            setMode(next);
            setError(null);
          }}
          options={[
            { label: "One interview", value: "interview" },
            { label: "Interview session (several people, one meeting)", value: "session" },
          ]}
          value={mode}
        />

        {onTheDay.length > 0 ? (
          <div className="border border-amber-200 border-l-[3px] border-l-amber-500 bg-amber-50 px-3 py-2 text-[12px] text-slate-700">
            <p className="font-bold text-slate-900">Already on this day</p>
            <ul className="mt-0.5 tabular-nums">
              {onTheDay.map((line) => (
                <li className="break-words" key={line.key}>
                  {line.text}
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {mode === "interview" ? (
          <div className="grid gap-5 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
            <section aria-label="Who">
              <PersonPicker api={api} canAdd={canAdd} canSearch={canSearch} onChange={setPerson} value={person} />
            </section>
            <section aria-label="When and where" className="flex flex-col gap-3">
              <label className="block">
                <FieldLabel>Starts at</FieldLabel>
                <TimeOfDayInput ariaLabel="Starts at" className={`${phxFieldClassName} block`} onChange={chooseStart} value={start} />
              </label>
              <div>
                <FieldLabel>How long</FieldLabel>
                <div className="flex flex-wrap items-center gap-2">
                  <Segmented<number>
                    label="How long"
                    onChange={(minutes) => setDuration(minutes)}
                    options={DURATION_CHOICES.map((minutes) => ({ disabled: !fits(start, minutes), label: `${minutes} min`, value: minutes }))}
                    value={(DURATION_CHOICES as readonly number[]).includes(duration) ? duration : null}
                  />
                  <select
                    aria-label="Longer"
                    className={cn(selectClass, "w-auto")}
                    onChange={(event) => {
                      const minutes = Number(event.target.value);
                      if (minutes > 0) setDuration(minutes);
                    }}
                    value={(LONG_DURATION_CHOICES as readonly number[]).includes(duration) ? duration : 0}
                  >
                    <option value={0}>Longer…</option>
                    {LONG_DURATION_CHOICES.filter((minutes) => fits(start, minutes)).map((minutes) => (
                      <option key={minutes} value={minutes}>
                        {formatDuration(minutes)}
                      </option>
                    ))}
                  </select>
                </div>
                <p className="mt-1.5 text-[13px] font-bold tabular-nums text-slate-900">{formatTimeRange(start, duration)}</p>
              </div>
              <div>
                <FieldLabel>Where</FieldLabel>
                <PlatformChoice onChange={setPlatform} value={platform} zoomConnected={zoomConnected} />
                {platform === "zoom" && !zoomConnected ? (
                  <p className="mt-1.5 text-[11px] text-amber-800">It is booked as Zoom; the meeting link is made once Zoom is connected to Phoenix.</p>
                ) : null}
                <div className="mt-2">
                  <InterviewLocationField location={location} onLocation={setLocation} platform={platform} />
                </div>
              </div>
              <div>
                <FieldLabel>Interviewer (optional)</FieldLabel>
                <InterviewerPicker api={api} onChange={chooseInterviewer} value={interviewer} />
              </div>
              <OrgFields api={api} area={area} jobTitle={jobTitle} line={line} onArea={setArea} onJobTitle={setJobTitle} onLine={setLine} />
              <div>
                <FieldLabel>Panel (optional)</FieldLabel>
                <PanelPicker api={api} excludeHrId={interviewer?.hrId ?? null} onChange={setPanel} value={panel} />
              </div>
              <label className="block">
                <FieldLabel>Note (optional)</FieldLabel>
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
        ) : (
          <div className="grid gap-5 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
            <section aria-label="The session" className="flex flex-col gap-3">
              <label className="block">
                <FieldLabel>Name (optional)</FieldLabel>
                <input
                  className={`${phxFieldClassName} block`}
                  maxLength={120}
                  onChange={(event) => setTitle(event.target.value)}
                  placeholder="For example: Medical Rep interviews, Cairo"
                  value={title}
                />
              </label>
              <div className="grid grid-cols-2 gap-2">
                <label className="block">
                  <FieldLabel>Starts at</FieldLabel>
                  <TimeOfDayInput ariaLabel="Session starts at" className={`${phxFieldClassName} block`} onChange={chooseStart} value={start} />
                </label>
                <label className="block">
                  <FieldLabel>Ends at</FieldLabel>
                  <select className={selectClass} onChange={(event) => setEnd(Number(event.target.value))} value={end}>
                    {endChoices(start).map((minutes) => (
                      <option key={minutes} value={minutes}>
                        {formatTimeOfDay(minutes)}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <div>
                <FieldLabel>Each interview (slot)</FieldLabel>
                <Segmented<number>
                  label="Slot length"
                  onChange={(minutes) => setSlot(minutes)}
                  options={SESSION_SLOT_CHOICES.map((minutes) => ({ disabled: minutes > sessionMinutes, label: `${minutes} min`, value: minutes }))}
                  value={slot}
                />
              </div>
              <div>
                <FieldLabel>Where</FieldLabel>
                <PlatformChoice onChange={setSessionPlatform} value={sessionPlatform} zoomConnected={zoomConnected} />
              </div>
              <label className="block">
                <FieldLabel>Note (optional)</FieldLabel>
                <textarea
                  className={`${phxTextareaClassName} block`}
                  maxLength={2000}
                  onChange={(event) => setNotes(event.target.value)}
                  placeholder="Who is on the panel, what the session is for"
                  rows={2}
                  value={notes}
                />
              </label>
            </section>
            <section aria-label="The slots">
              <FieldLabel>{`${slots.length} ${slots.length === 1 ? "slot" : "slots"}, ${formatDuration(sessionMinutes)} in all`}</FieldLabel>
              <ul className="grid grid-cols-2 gap-1.5 sm:grid-cols-3">
                {slots.map((at) => (
                  <li className={`border border-slate-200 bg-slate-50 px-2 py-1.5 text-[12px] font-semibold tabular-nums text-slate-700 ${adminRecessedDepthClassName}`} key={at}>
                    {formatTimeRange(at, slot)}
                  </li>
                ))}
              </ul>
              {leftover > 0 ? (
                <p className="mt-1.5 text-[11px] text-slate-500">The last {leftover} minutes are too short for a slot and stay free.</p>
              ) : null}
              <NoteLine tone="sky">
                {sessionPlatform === "zoom"
                  ? "One Zoom meeting for the whole session; every person booked into it gets the same link. "
                  : "Everyone comes to the office at their slot's time. "}
                Add people to the slots after it is made — from Phoenix or from outside.
              </NoteLine>
            </section>
          </div>
        )}
        {error ? <ErrorLine>{error}</ErrorLine> : null}
      </div>
    </CalendarDialog>
  );
}
