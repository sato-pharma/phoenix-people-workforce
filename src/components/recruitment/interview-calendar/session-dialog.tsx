"use client";

// One interview SESSION — a block of a day under one meeting, cut into slots (the owner, 2026-09-18:
// "day 20 from 11 a.m. to 3 p.m."). Every slot is shown: a booked one opens that person's interview,
// a free one is booked from here — from Phoenix or from outside. The session's Zoom invitation, its
// polls, and after it ends who attended, their answers and Zoom's summary, sit underneath.
//
// Changing its times moves every booked slot with it. Cancelling it cancels the interviews in it.
// Nothing is sent to anyone either way.

import { CalendarDays, Clock3, Loader2, Pencil, Plus, RefreshCw, Trash2, Users, Video } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { Action } from "@/components/recruitment/workstation/workstation-look";
import {
  PLATFORM_LABEL,
  sessionSlotStarts,
  zoomStatusSentence,
  type InterviewBooking,
  type InterviewPlatform,
  type InterviewSession,
} from "@/lib/recruitment/interview-calendar-types";
import { SESSION_SLOT_CHOICES, formatDayLong, formatDuration, formatTimeOfDay, formatTimeRange } from "@/lib/recruitment/interview-calendar-week";
import { cn } from "@/lib/utils";

import { type CalendarApi, reasonText } from "./calendar-api";
import { CalendarDialog, ErrorLine, NoteLine, PanelHeading, Segmented } from "./calendar-dialog";
import { LATEST_START, PlatformChoice, endChoices } from "./cell-dialog";
import { PersonPicker, initialPersonChoice, personProblem, submitBooking, type PersonChoice } from "./person-picker";
import { TimeOfDayInput } from "./time-of-day-input";
import { ZoomMeetingPanels } from "./zoom-panels";
import {
  phxButtonDangerDenseClassName,
  phxFieldClassName,
  phxLabelClassName,
  phxSelectClassName,
  phxTextareaClassName,
} from "@/components/ui/form-tokens";
import { adminSoftDepthClassName } from "@/components/admin/admin-design-tokens";
import { RecruitmentPill } from "@/components/recruitment/recruitment-premium";

export function SessionDialog({
  api,
  canAdd,
  canBook,
  canSearch,
  onChanged,
  onClose,
  onOpenBooking,
  onRemoved,
  sessionId,
  zoomConnected,
}: {
  api: CalendarApi;
  canAdd: boolean;
  canBook: boolean;
  canSearch: boolean;
  /** The session or its bookings changed — the calendar redraws them. */
  onChanged: (session: InterviewSession, bookings: InterviewBooking[]) => void;
  onClose: () => void;
  onOpenBooking: (id: string) => void;
  onRemoved: (sessionId: string, bookingIds: string[]) => void;
  sessionId: string;
  zoomConnected: boolean;
}) {
  const [data, setData] = useState<{ session: InterviewSession; bookings: InterviewBooking[] } | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [booking, setBooking] = useState<number | null>(null);
  const [editing, setEditing] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [busy, setBusy] = useState<"zoom" | "cancel" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const path = `/sessions/${encodeURIComponent(sessionId)}`;

  const land = useCallback(
    (next: { session: InterviewSession; bookings: InterviewBooking[] }) => {
      setData(next);
      onChanged(next.session, next.bookings);
    },
    [onChanged],
  );

  useEffect(() => {
    let live = true;
    api
      .get(path)
      .then((answer) => {
        if (!live) return;
        setData({ bookings: Array.isArray(answer.bookings) ? (answer.bookings as InterviewBooking[]) : [], session: answer.session as InterviewSession });
      })
      .catch((reason) => {
        if (live) setLoadError(reasonText(reason, "The session could not be read."));
      });
    return () => {
      live = false;
    };
  }, [api, path]);

  async function reload() {
    const answer = await api.get(path);
    land({ bookings: Array.isArray(answer.bookings) ? (answer.bookings as InterviewBooking[]) : [], session: answer.session as InterviewSession });
  }

  async function retryZoom() {
    if (!data) return;
    setBusy("zoom");
    setError(null);
    try {
      const answer = await api.post(`${path}/zoom`, {});
      land({ bookings: data.bookings, session: answer.session as InterviewSession });
    } catch (reason) {
      setError(reasonText(reason, "Zoom could not make the meeting."));
    } finally {
      setBusy(null);
    }
  }

  async function cancel() {
    if (!data) return;
    setBusy("cancel");
    setError(null);
    try {
      await api.del(path);
      onRemoved(sessionId, data.bookings.map((entry) => entry.id));
    } catch (reason) {
      setError(reasonText(reason, "The session could not be cancelled."));
      setBusy(null);
    }
  }

  if (!data) {
    return (
      <CalendarDialog eyebrow="Interview session" onClose={onClose} title="Interview session" width="sm">
        {loadError ? (
          <ErrorLine>{loadError}</ErrorLine>
        ) : (
          <p className="flex items-center gap-1.5 text-[12px] text-slate-500">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> Reading the session…
          </p>
        )}
      </CalendarDialog>
    );
  }

  const { session, bookings } = data;
  const slots = sessionSlotStarts(session);
  const byStart = new Map(bookings.map((entry) => [entry.startMinutes, entry]));
  const zoomLine = zoomStatusSentence(session.zoomStatus, session.zoomError);
  const hasMeeting = session.platform === "zoom" && session.zoomStatus === "created";
  const target = { id: session.id, kind: "session" as const };

  return (
    <CalendarDialog
      eyebrow="Interview session"
      onClose={onClose}
      sub={`${formatDayLong(session.dateKey)} · ${formatTimeRange(session.startMinutes, session.durationMinutes)}`}
      title={session.title ?? "Interview session"}
      width="lg"
      z={225}
    >
      <div className="flex flex-col gap-5">
        <dl className={`grid grid-cols-[1.25rem_minmax(0,1fr)] gap-x-2 gap-y-2 border border-slate-200 bg-white p-3 text-[13px] text-slate-800 ${adminSoftDepthClassName}`}>
          <dt className="pt-0.5 text-slate-400">
            <CalendarDays aria-label="Day" className="h-4 w-4" />
          </dt>
          <dd className="font-semibold">{formatDayLong(session.dateKey)}</dd>
          <dt className="pt-0.5 text-slate-400">
            <Clock3 aria-label="Time" className="h-4 w-4" />
          </dt>
          <dd className="tabular-nums">
            {formatTimeRange(session.startMinutes, session.durationMinutes)}{" "}
            <span className="text-slate-500">
              ({formatDuration(session.durationMinutes)}, {slots.length} slots of {session.slotMinutes} min — {bookings.length} booked)
            </span>
          </dd>
          <dt className="pt-0.5 text-slate-400">
            <Video aria-label="Where" className="h-4 w-4" />
          </dt>
          <dd>
            <span className="font-semibold">{PLATFORM_LABEL[session.platform]}</span>
            {session.zoomJoinUrl ? (
              <a className="mt-0.5 block break-all text-[12px] font-semibold text-sky-700 underline" href={session.zoomJoinUrl} rel="noreferrer" target="_blank">
                {session.zoomJoinUrl}
              </a>
            ) : null}
            {zoomLine && session.zoomStatus !== "created" ? <span className="mt-0.5 block text-[12px] text-amber-800">{zoomLine}</span> : null}
            {canBook && session.platform === "zoom" && session.zoomStatus !== "created" && zoomConnected ? (
              <Action className="mt-1.5" disabled={busy !== null} onClick={() => void retryZoom()} tone="quiet">
                {busy === "zoom" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
                Make the Zoom meeting
              </Action>
            ) : null}
          </dd>
        </dl>
        {session.notes ? (
          <p className="whitespace-pre-wrap break-words border-l-[3px] border-l-slate-300 bg-slate-50 px-3 py-2 text-[12px] text-slate-700">{session.notes}</p>
        ) : null}
        {session.createdByName ? <p className="-mt-3 text-[11px] text-slate-500">Made by {session.createdByName}</p> : null}

        <section aria-label="Slots">
          <PanelHeading
            aside={
              <span className="text-[11px] font-bold tabular-nums text-slate-500">
                {bookings.length} of {slots.length} booked
              </span>
            }
          >
            <span className="inline-flex items-center gap-1.5">
              <Users className="h-3.5 w-3.5" /> Slots
            </span>
          </PanelHeading>
          <ul className={`divide-y divide-slate-100 border border-slate-200 bg-white ${adminSoftDepthClassName}`}>
            {slots.map((at) => {
              const held = byStart.get(at) ?? null;
              return (
                <li className="flex flex-wrap items-center justify-between gap-2 px-3 py-2" key={at}>
                  <span className="w-[9.5rem] shrink-0 text-[12px] font-bold tabular-nums text-slate-700">{formatTimeRange(at, session.slotMinutes)}</span>
                  {held ? (
                    <button
                      className="min-w-0 flex-1 text-left text-[13px] font-bold text-orange-700 underline decoration-orange-300 underline-offset-2 hover:text-orange-800"
                      onClick={() => onOpenBooking(held.id)}
                      type="button"
                    >
                      <span className="break-words">{held.candidateName}</span>
                      {held.external ? <span className="ml-1.5 text-[11px] font-semibold text-slate-500 no-underline">from outside</span> : null}
                    </button>
                  ) : (
                    <span className="min-w-0 flex-1">
                      <RecruitmentPill tone="emerald">Free</RecruitmentPill>
                    </span>
                  )}
                  {!held && canBook && !session.ended ? (
                    <Action onClick={() => setBooking(at)} tone="quiet">
                      <Plus className="h-3.5 w-3.5" />
                      Book this slot
                    </Action>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </section>

        {canBook ? (
          confirmCancel ? (
            <div className="border border-red-200 border-l-[3px] border-l-red-600 bg-red-50 p-3">
              <p className="break-words text-[12px] font-semibold text-red-800">
                Cancel this session?{" "}
                {bookings.length > 0
                  ? `Its ${bookings.length} booked ${bookings.length === 1 ? "interview is" : "interviews are"} cancelled with it`
                  : "It has no one booked"}
                {session.zoomJoinUrl ? ", and its Zoom meeting is deleted" : ""}. Nothing is sent to anyone.
              </p>
              <div className="mt-2 flex flex-wrap gap-2">
                <Action onClick={() => setConfirmCancel(false)} tone="quiet">
                  Keep it
                </Action>
                <button
                  className={cn("inline-flex items-center gap-1.5 border px-2 py-1.5 text-[12px] font-bold leading-none disabled:opacity-50", phxButtonDangerDenseClassName)}
                  disabled={busy !== null}
                  onClick={() => void cancel()}
                  type="button"
                >
                  {busy === "cancel" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                  Cancel session
                </button>
              </div>
            </div>
          ) : (
            <div className="flex flex-wrap gap-2">
              <Action onClick={() => setEditing(true)} tone="quiet">
                <Pencil className="h-3.5 w-3.5" />
                Change the session
              </Action>
              <Action onClick={() => setConfirmCancel(true)} tone="ghost">
                <Trash2 className="h-3.5 w-3.5" />
                Cancel session
              </Action>
            </div>
          )
        ) : null}
        {error ? <ErrorLine>{error}</ErrorLine> : null}

        {session.platform === "zoom" ? (
          <section aria-label="Zoom" className="border-t border-slate-200 pt-4">
            <ZoomMeetingPanels api={api} canBook={canBook} hasMeeting={hasMeeting} pollTarget={target} target={target} zoomConnected={zoomConnected} />
          </section>
        ) : null}
      </div>

      {booking !== null ? (
        <BookSlotDialog
          api={api}
          at={booking}
          canAdd={canAdd}
          canSearch={canSearch}
          onBooked={(entry) => {
            land({ bookings: [...bookings.filter((existing) => existing.id !== entry.id), entry].sort((a, b) => a.startMinutes - b.startMinutes), session });
          }}
          onClose={() => setBooking(null)}
          session={session}
        />
      ) : null}
      {editing ? (
        <EditSessionDialog
          api={api}
          bookedCount={bookings.length}
          onClose={() => setEditing(false)}
          onSaved={async () => {
            setEditing(false);
            try {
              await reload();
            } catch (reason) {
              setError(reasonText(reason, "The session was changed, but could not be read again. Close it and open it again."));
            }
          }}
          session={session}
          zoomConnected={zoomConnected}
        />
      ) : null}
    </CalendarDialog>
  );
}

function BookSlotDialog({
  api,
  at,
  canAdd,
  canSearch,
  onBooked,
  onClose,
  session,
}: {
  api: CalendarApi;
  at: number;
  canAdd: boolean;
  canSearch: boolean;
  onBooked: (booking: InterviewBooking) => void;
  onClose: () => void;
  session: InterviewSession;
}) {
  const [person, setPerson] = useState<PersonChoice>(() => initialPersonChoice(canSearch, canAdd));
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [done, setDone] = useState<InterviewBooking | null>(null);
  const problem = personProblem(person);

  async function book() {
    if (problem) return;
    setBusy(true);
    setError(null);
    try {
      const data = await submitBooking(api, person, { notes: notes.trim(), sessionId: session.id, startMinutes: at });
      const entry = data.booking as InterviewBooking;
      onBooked(entry);
      setDone(entry);
      setNotice(typeof data.notice === "string" ? data.notice : null);
    } catch (reason) {
      setError(reasonText(reason, "The slot could not be booked."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <CalendarDialog
      eyebrow={session.title ?? "Interview session"}
      footer={
        done ? (
          <>
            <p className="text-[12px] text-slate-600">Nothing was sent to them.</p>
            <Action onClick={onClose} size="md" tone="primary">
              Done
            </Action>
          </>
        ) : (
          <>
            <p className="min-w-0 break-words text-[12px] text-slate-600">{error ? <span className="font-semibold text-red-700">{error}</span> : (problem ?? "")}</p>
            <div className="flex shrink-0 justify-end gap-2">
              <Action onClick={onClose} size="md" tone="quiet">
                Cancel
              </Action>
              <Action disabled={busy || problem !== null} onClick={() => void book()} size="md" tone="primary">
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
                Book this slot
              </Action>
            </div>
          </>
        )
      }
      onClose={onClose}
      sub={`${formatDayLong(session.dateKey)} · ${formatTimeRange(at, session.slotMinutes)}`}
      title="Book a slot"
      width="md"
      z={240}
    >
      {done ? (
        <div className="flex flex-col gap-3">
          <NoteLine tone="emerald">
            <span className="font-bold">{done.candidateName}</span> is booked for {formatTimeRange(done.startMinutes, done.durationMinutes)}
            {session.platform === "zoom" ? ", on the session's Zoom meeting" : ""}.
          </NoteLine>
          {notice ? <NoteLine tone="sky">{notice}</NoteLine> : null}
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <PersonPicker api={api} canAdd={canAdd} canSearch={canSearch} onChange={setPerson} value={person} />
          <label className="block">
            <span className={phxLabelClassName}>Note (optional)</span>
            <textarea
              className={`${phxTextareaClassName} block`}
              maxLength={2000}
              onChange={(event) => setNotes(event.target.value)}
              rows={2}
              value={notes}
            />
          </label>
        </div>
      )}
    </CalendarDialog>
  );
}

function EditSessionDialog({
  api,
  bookedCount,
  onClose,
  onSaved,
  session,
  zoomConnected,
}: {
  api: CalendarApi;
  bookedCount: number;
  onClose: () => void;
  onSaved: () => void;
  session: InterviewSession;
  zoomConnected: boolean;
}) {
  const [title, setTitle] = useState(session.title ?? "");
  const [start, setStart] = useState(session.startMinutes);
  const [end, setEnd] = useState(session.startMinutes + session.durationMinutes);
  const [slot, setSlot] = useState(session.slotMinutes);
  const [platform, setPlatform] = useState<InterviewPlatform>(session.platform);
  const [notes, setNotes] = useState(session.notes ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const shift = start - session.startMinutes;

  function chooseStart(next: number | null) {
    if (next === null || next > LATEST_START) return;
    // Moving the start keeps the session's length, as long as it still ends by midnight.
    const length = end - start;
    setStart(next);
    const ends = endChoices(next);
    setEnd(ends.includes(next + length) ? next + length : (ends[ends.length - 1] ?? next + 30));
  }

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await api.patch(`/sessions/${encodeURIComponent(session.id)}`, {
        dateKey: session.dateKey,
        durationMinutes: end - start,
        notes: notes.trim(),
        platform,
        slotMinutes: slot,
        startMinutes: start,
        title: title.trim(),
      });
      onSaved();
    } catch (reason) {
      setError(reasonText(reason, "The session could not be changed."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <CalendarDialog
      eyebrow="Interview session"
      footer={
        <>
          <p className="min-w-0 break-words text-[12px] tabular-nums text-slate-600">
            {error ? <span className="font-semibold text-red-700">{error}</span> : `${formatTimeRange(start, end - start)} · slots of ${slot} min`}
          </p>
          <div className="flex shrink-0 justify-end gap-2">
            <Action onClick={onClose} size="md" tone="quiet">
              Cancel
            </Action>
            <Action disabled={busy} onClick={() => void save()} size="md" tone="primary">
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              Save
            </Action>
          </div>
        </>
      }
      onClose={onClose}
      sub={formatDayLong(session.dateKey)}
      title="Change the session"
      width="md"
      z={240}
    >
      <div className="flex flex-col gap-3">
        <label className="block">
          <span className={phxLabelClassName}>Name (optional)</span>
          <input
            className={`${phxFieldClassName} block`}
            maxLength={120}
            onChange={(event) => setTitle(event.target.value)}
            value={title}
          />
        </label>
        <div className="grid grid-cols-2 gap-2">
          <label className="block">
            <span className={phxLabelClassName}>Starts at</span>
            <TimeOfDayInput ariaLabel="Session starts at" className={`${phxFieldClassName} block`} onChange={chooseStart} value={start} />
          </label>
          <label className="block">
            <span className={phxLabelClassName}>Ends at</span>
            <select
              className={phxSelectClassName}
              onChange={(event) => setEnd(Number(event.target.value))}
              value={end}
            >
              {endChoices(start).map((minutes) => (
                <option key={minutes} value={minutes}>
                  {formatTimeOfDay(minutes)}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div>
          <span className={phxLabelClassName}>Each interview (slot)</span>
          <Segmented<number>
            label="Slot length"
            onChange={(minutes) => setSlot(minutes)}
            options={SESSION_SLOT_CHOICES.map((minutes) => ({
              disabled: (bookedCount > 0 && minutes !== session.slotMinutes) || minutes > end - start,
              label: `${minutes} min`,
              value: minutes,
            }))}
            value={slot}
          />
          {bookedCount > 0 ? <p className="mt-1 text-[11px] text-slate-500">The slot length is fixed while people are booked into it.</p> : null}
        </div>
        <div>
          <span className={phxLabelClassName}>Where</span>
          <PlatformChoice onChange={setPlatform} value={platform} zoomConnected={zoomConnected} />
        </div>
        <label className="block">
          <span className={phxLabelClassName}>Note (optional)</span>
          <textarea
            className={`${phxTextareaClassName} block`}
            maxLength={2000}
            onChange={(event) => setNotes(event.target.value)}
            rows={2}
            value={notes}
          />
        </label>
        {bookedCount > 0 && shift !== 0 ? (
          <NoteLine tone="amber">
            Every booked slot moves {Math.abs(shift)} minutes {shift > 0 ? "later" : "earlier"} with the session. Nothing is sent to them — tell them yourself.
          </NoteLine>
        ) : null}
        {platform !== session.platform ? (
          <NoteLine tone="amber">
            {platform === "in_office" ? "The session's Zoom meeting is deleted; everyone comes to the office." : "Phoenix makes one Zoom meeting for the whole session."}
          </NoteLine>
        ) : null}
        <p className={cn("text-[11px] text-slate-500", bookedCount === 0 && "hidden")}>A session cannot end before its last booked slot.</p>
      </div>
    </CalendarDialog>
  );
}
