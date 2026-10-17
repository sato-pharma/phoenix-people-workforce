"use client";

// Step 2 of the request flow, on the calendar: HR sees the requests waiting for a time ("Mina Masoud
// sent 2 CVs for Tuesday"), phones the candidates, and gives each CV a real time — which turns it
// into a booking on both the requester's and the interviewer's calendar. A requester sees their own
// requests here too, so they can follow what HR has booked.
//
// Two panels, each drawn only for who may use it: the INBOX for a caller with book rights (HR and the
// owners), and MY REQUESTS for a requester (a District Manager and above, or HR). The owner sees both.

import { CalendarClock, CheckCircle2, ChevronDown, ChevronRight, Clock3, Loader2, Trash2, UserRound, Users } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { CvPreviewModal } from "@/components/recruitment/cv-preview-modal";
import { Action } from "@/components/recruitment/workstation/workstation-look";
import { Button } from "@/components/ui/button";
import {
  INTERVIEW_REQUEST_STATUS_LABEL,
  PLATFORM_LABEL,
  type InterviewBooking,
  type InterviewRequest,
  type InterviewRequestItem,
} from "@/lib/recruitment/interview-calendar-types";
import { formatDayLong, formatDuration, formatShortDate, formatTimeOfDay, requestDayHasPassed, slotStarts } from "@/lib/recruitment/interview-calendar-week";
import { cn } from "@/lib/utils";

import { type CalendarApi, reasonText } from "./calendar-api";
import { CalendarDialog, ErrorLine, NoteLine, Segmented } from "./calendar-dialog";
import { useInterviewJobTitles } from "./org-fields";
import {
  phxFieldClassName,
  phxSelectClassName,
  phxTextareaClassName,
} from "@/components/ui/form-tokens";
import { adminPanelDepthClassName } from "@/components/admin/admin-design-tokens";

const DURATION_OPTIONS = [30, 45, 60] as const;

// ── The scheduling pop-up: give one CV a time ────────────────────────────────────────────────────

function BookTimeDialog({
  api,
  item,
  onClose,
  onBooked,
  request,
  todayKey,
  zoomConnected,
}: {
  api: CalendarApi;
  item: InterviewRequestItem;
  onClose: () => void;
  onBooked: (request: InterviewRequest, booking: InterviewBooking) => void;
  request: InterviewRequest;
  todayKey: string;
  zoomConnected: boolean;
}) {
  const [start, setStart] = useState<number | null>(null);
  const [duration, setDuration] = useState<number>(30);
  const [platform, setPlatform] = useState<InterviewBooking["platform"]>("in_office");
  // A request names the line it is for but never the role, so HR names it as the time is given —
  // otherwise this booking joins the ones with nothing saying what round they belong to.
  const [jobTitle, setJobTitle] = useState("");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const starts = useMemo(() => slotStarts(), []);
  const jobTitles = useInterviewJobTitles(api);

  async function book() {
    if (start === null || busy) return;
    setBusy(true);
    setError(null);
    try {
      const data = await api.post(`/requests/${encodeURIComponent(request.id)}/schedule`, {
        dateKey: request.requestedDay,
        durationMinutes: duration,
        itemId: item.id,
        jobTitle: jobTitle.trim() || null,
        notes: notes.trim() || null,
        platform,
        startMinutes: start,
      });
      onBooked(data.request as InterviewRequest, data.booking as InterviewBooking);
      onClose();
    } catch (reason) {
      setError(reasonText(reason, "The time could not be booked."));
      setBusy(false);
    }
  }

  return (
    <CalendarDialog
      eyebrow="Book a time"
      footer={
        <>
          <p className="min-w-0 text-[12px] text-slate-500">
            {start === null ? "Choose a time." : `${item.candidateName} at ${formatTimeOfDay(start)}, ${formatDayLong(request.requestedDay)}.`}
          </p>
          <div className="flex shrink-0 gap-2">
            <Action onClick={onClose} size="md" tone="quiet">
              Cancel
            </Action>
            <Action disabled={busy || start === null} onClick={() => void book()} size="md" tone="primary">
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Clock3 className="h-4 w-4" />}
              Book the time
            </Action>
          </div>
        </>
      }
      onClose={onClose}
      sub={`${formatDayLong(request.requestedDay)} · interviewer ${request.interviewerName}`}
      title={item.candidateName}
      width="sm"
      z={240}
    >
      <div className="flex flex-col gap-4">
        <div>
          <p className="mb-1 text-[12px] font-bold uppercase tracking-[0.06em] text-slate-700">Time</p>
          <select
            aria-label="Interview time"
            className={`${phxSelectClassName} block`}
            onChange={(event) => setStart(event.target.value === "" ? null : Number(event.target.value))}
            value={start ?? ""}
          >
            <option value="">Choose a time…</option>
            {starts.map((minutes) => (
              <option key={minutes} value={minutes}>
                {formatTimeOfDay(minutes)}
              </option>
            ))}
          </select>
        </div>
        <div>
          <p className="mb-1 text-[12px] font-bold uppercase tracking-[0.06em] text-slate-700">Role interviewed for (optional)</p>
          <input
            aria-label="Role interviewed for"
            autoComplete="off"
            className={`${phxFieldClassName} block`}
            list="interview-request-job-title-options"
            maxLength={120}
            onChange={(event) => setJobTitle(event.target.value)}
            placeholder="e.g. Medical Rep"
            value={jobTitle}
          />
          <datalist id="interview-request-job-title-options">
            {jobTitles.map((title) => (
              <option key={title} value={title} />
            ))}
          </datalist>
        </div>
        <div>
          <p className="mb-1 text-[12px] font-bold uppercase tracking-[0.06em] text-slate-700">How long</p>
          <Segmented
            label="How long"
            onChange={(value) => setDuration(value)}
            options={DURATION_OPTIONS.map((minutes) => ({ label: formatDuration(minutes), value: minutes }))}
            value={duration}
          />
        </div>
        <div>
          <p className="mb-1 text-[12px] font-bold uppercase tracking-[0.06em] text-slate-700">Where</p>
          <Segmented
            label="Where"
            onChange={(value) => setPlatform(value)}
            options={[
              { label: PLATFORM_LABEL.in_office, value: "in_office" },
              { label: PLATFORM_LABEL.zoom, value: "zoom" },
            ]}
            value={platform}
          />
          {platform === "zoom" && !zoomConnected ? (
            <p className="mt-1 text-[11px] text-amber-800">Zoom is not connected — the meeting link can be made from the interview afterwards.</p>
          ) : null}
        </div>
        <div>
          <p className="mb-1 text-[12px] font-bold uppercase tracking-[0.06em] text-slate-700">A note (optional)</p>
          <textarea
            aria-label="A note on the interview"
            className={`${phxTextareaClassName} block`}
            maxLength={2000}
            onChange={(event) => setNotes(event.target.value)}
            rows={2}
            value={notes}
          />
        </div>
        {todayKey > request.requestedDay ? <NoteLine tone="amber">This day has passed. Choose a booking on a day still to come instead.</NoteLine> : null}
        {error ? <ErrorLine>{error}</ErrorLine> : null}
      </div>
    </CalendarDialog>
  );
}

// ── One request card ─────────────────────────────────────────────────────────────────────────────

function RequestCard({
  api,
  canBook,
  onBooked,
  onCancelled,
  onOpenBooking,
  request,
  todayKey,
  zoomConnected,
}: {
  api: CalendarApi;
  /** Book rights — draws the per-CV "Book time" buttons. */
  canBook: boolean;
  onBooked: (request: InterviewRequest, booking: InterviewBooking) => void;
  onCancelled: (requestId: string) => void;
  onOpenBooking: (bookingId: string) => void;
  request: InterviewRequest;
  todayKey: string;
  zoomConnected: boolean;
}) {
  // A request whose day has gone can no longer be given a time (the booking always lands on the
  // requested day), so its CVs read "Day passed" rather than offering a Book button that cannot work.
  const dayPassed = requestDayHasPassed(request.requestedDay, todayKey);
  const [open, setOpen] = useState(request.pendingItemCount > 0 && !dayPassed);
  const [booking, setBooking] = useState<InterviewRequestItem | null>(null);
  // The CV being read — opened from the request itself, so HR can read it BEFORE phoning the candidate.
  // `previewOpen` is the same idiom every other "View CV" control uses (candidate-cv-actions.tsx), and
  // `reading` carries WHICH item's CV, since one card lists several.
  const [reading, setReading] = useState<InterviewRequestItem | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const waiting = request.pendingItemCount;
  const done = request.status !== "cancelled" && waiting === 0;
  const canWithdraw = request.items.every((item) => !item.booked) && request.status !== "cancelled";

  async function withdraw() {
    setBusy(true);
    setError(null);
    try {
      await api.del(`/requests/${encodeURIComponent(request.id)}`);
      onCancelled(request.id);
    } catch (reason) {
      setError(reasonText(reason, "The request could not be withdrawn."));
      setBusy(false);
    }
  }

  return (
    <li className={cn("border", request.status === "cancelled" ? "border-slate-200 bg-slate-50" : done ? "border-emerald-200 bg-emerald-50/40" : "border-slate-200 bg-white")}>
      <button
        aria-expanded={open}
        className="flex w-full items-start gap-2 px-3 py-2.5 text-left hover:bg-slate-50"
        onClick={() => setOpen((value) => !value)}
        type="button"
      >
        <span className="pt-0.5 text-slate-400">{open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}</span>
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-baseline gap-x-2">
            <span className="inline-flex items-center gap-1 text-[14px] font-bold text-slate-900">
              <CalendarClock className="h-3.5 w-3.5 text-orange-600" />
              {formatDayLong(request.requestedDay)}
            </span>
            <span className="text-[12px] text-slate-500">{formatShortDate(request.requestedDay)}</span>
          </span>
          <span className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[12px] text-slate-600">
            <span className="inline-flex items-center gap-1">
              <UserRound className="h-3 w-3 text-slate-400" /> {request.requestedByName}
            </span>
            <span aria-hidden>→</span>
            <span className="inline-flex items-center gap-1 font-semibold text-slate-800">{request.interviewerName}</span>
            <span className="inline-flex items-center gap-1">
              <Users className="h-3 w-3 text-slate-400" /> {request.status === "cancelled" ? request.items.length : waiting} {(request.status === "cancelled" ? request.items.length : waiting) === 1 ? "CV" : "CVs"}
            </span>
          </span>
        </span>
        <span
          className={cn(
            "shrink-0 whitespace-nowrap border px-2 py-0.5 text-[11px] font-bold",
            request.status === "cancelled"
              ? "border-slate-300 text-slate-500"
              : waiting > 0 && dayPassed
                ? "border-slate-300 bg-slate-100 text-slate-700"
                : waiting > 0
                  ? "border-orange-300 bg-orange-100 text-orange-800"
                  : "border-emerald-300 bg-emerald-100 text-emerald-800",
          )}
        >
          {request.status === "cancelled"
            ? INTERVIEW_REQUEST_STATUS_LABEL.cancelled
            : waiting > 0 && dayPassed
              ? `${waiting} not booked · day passed`
              : waiting > 0
                ? `${waiting} to book`
                : INTERVIEW_REQUEST_STATUS_LABEL.scheduled}
        </span>
      </button>

      {open ? (
        <div className="border-t border-slate-100 px-3 py-2.5">
          {request.note ? <p className="mb-2 whitespace-pre-wrap break-words border-l-[3px] border-l-slate-300 bg-slate-50 px-3 py-2 text-[12px] text-slate-700">{request.note}</p> : null}
          <ul className="flex flex-col divide-y divide-slate-100 border border-slate-100">
            {request.items.filter((item) => !item.booked).map((item) => (
              <li className="flex flex-wrap items-center justify-between gap-2 px-3 py-2" key={item.id}>
                <span className="min-w-0">
                  <span className="block break-words text-[13px] font-semibold text-slate-900">{item.candidateName}</span>
                  <span className="flex flex-wrap items-center gap-x-2 text-[11px] text-slate-500">
                    {item.candidateJobTitle ? <span className="break-words">{item.candidateJobTitle}</span> : null}
                    {item.external ? <span>from outside</span> : <span>from Recruitment</span>}
                    {item.external && item.externalPhone ? <span dir="ltr">{item.externalPhone}</span> : null}
                    {item.hasCv ? null : <span>No CV on record</span>}
                  </span>
                </span>
                <span className="flex shrink-0 flex-wrap items-center gap-2">
                {item.hasCv ? (
                  <Button variant="secondary" onClick={() => { setReading(item); setPreviewOpen(true); }}>
                    View CV
                  </Button>
                ) : null}
                {item.booked ? (
                  <button
                    className="inline-flex shrink-0 items-center gap-1 text-[12px] font-bold text-emerald-800 hover:underline"
                    onClick={() => item.bookingId && onOpenBooking(item.bookingId)}
                    type="button"
                  >
                    <CheckCircle2 className="h-3.5 w-3.5" /> Booked
                  </button>
                ) : dayPassed && request.status !== "cancelled" ? (
                  <span className="shrink-0 text-[11px] font-semibold text-slate-500">Day passed — never booked</span>
                ) : canBook && request.status !== "cancelled" ? (
                  <Action onClick={() => setBooking(item)} tone="primary">
                    <Clock3 className="h-3.5 w-3.5" />
                    Book time
                  </Action>
                ) : (
                  <span className="shrink-0 text-[11px] font-semibold text-orange-700">Waiting for HR</span>
                )}
                </span>
              </li>
            ))}
          </ul>

          {canWithdraw ? (
            confirmCancel ? (
              <div className="mt-2 border border-red-200 bg-red-50 p-2.5">
                <p className="text-[12px] font-semibold text-red-800">Withdraw this whole request? None of its CVs are booked yet.</p>
                <div className="mt-2 flex flex-wrap gap-2">
                  <Action onClick={() => setConfirmCancel(false)} tone="quiet">
                    Keep it
                  </Action>
                  <button
                    className="inline-flex items-center gap-1.5 border border-red-700 bg-red-700 px-2 py-1.5 text-[12px] font-bold leading-none text-white hover:bg-red-800 disabled:opacity-50"
                    disabled={busy}
                    onClick={() => void withdraw()}
                    type="button"
                  >
                    {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                    Withdraw request
                  </button>
                </div>
              </div>
            ) : (
              <div className="mt-2">
                <Action onClick={() => setConfirmCancel(true)} tone="ghost">
                  <Trash2 className="h-3.5 w-3.5" />
                  Withdraw request
                </Action>
              </div>
            )
          ) : null}
          {error ? <div className="mt-2"><ErrorLine>{error}</ErrorLine></div> : null}
        </div>
      ) : null}

      {previewOpen && reading ? (
        <CvPreviewModal
          downloadUrl={api.href(`/requests/${encodeURIComponent(request.id)}/items/${encodeURIComponent(reading.id)}/cv`)}
          fileName={`${reading.candidateName} · ${reading.cvFileName ?? "CV"}`}
          mimeType={reading.cvMimeType}
          onClose={() => { setPreviewOpen(false); setReading(null); }}
        />
      ) : null}

      {booking ? (
        <BookTimeDialog
          api={api}
          item={booking}
          onBooked={onBooked}
          onClose={() => setBooking(null)}
          request={request}
          todayKey={todayKey}
          zoomConnected={zoomConnected}
        />
      ) : null}
    </li>
  );
}

// ── The panel(s) ─────────────────────────────────────────────────────────────────────────────────

function useRequests(api: CalendarApi, path: string, enabled: boolean, reloadSignal: number) {
  const [requests, setRequests] = useState<InterviewRequest[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(() => {
    if (!enabled) return;
    let live = true;
    api
      .get(path)
      .then((data) => {
        if (live) {
          setRequests(Array.isArray(data.requests) ? (data.requests as InterviewRequest[]) : []);
          setError(null);
        }
      })
      .catch((reason) => {
        if (live) {
          setRequests([]);
          setError(reasonText(reason, "The requests could not be read."));
        }
      });
    return () => {
      live = false;
    };
  }, [api, enabled, path]);

  useEffect(() => reload(), [reload, reloadSignal]);

  return {
    error,
    replace: (next: InterviewRequest) => setRequests((current) => (current ?? []).map((request) => (request.id === next.id ? next : request))),
    requests,
    remove: (id: string) => setRequests((current) => (current ?? []).filter((request) => request.id !== id)),
  };
}

export function InterviewRequestPanels({
  api,
  canBook,
  canRequest,
  onBookingCreated,
  onOpenBooking,
  reloadSignal,
  todayKey,
  zoomConnected,
}: {
  api: CalendarApi;
  canBook: boolean;
  canRequest: boolean;
  /** A booking HR just made from a request — the grid adds it. */
  onBookingCreated: (booking: InterviewBooking) => void;
  onOpenBooking: (bookingId: string) => void;
  /** Bumped by the view when a new request is created, so both panels re-read. */
  reloadSignal: number;
  todayKey: string;
  zoomConnected: boolean;
}) {
  const inbox = useRequests(api, "/requests", canBook, reloadSignal);
  const mine = useRequests(api, "/requests?mine=1", canRequest, reloadSignal);

  const onBooked = useCallback(
    (request: InterviewRequest, booking: InterviewBooking) => {
      inbox.replace(request);
      mine.replace(request);
      onBookingCreated(booking);
    },
    [inbox, mine, onBookingCreated],
  );

  // "Waiting for a time" is only the days still to come. A request whose day went by with a CV never
  // booked (the owner, 2026-10-17: finished days still crowded the list) moves to its own collapsed
  // group — kept, not dropped, so HR can still read it or withdraw it.
  const inboxOpen = (inbox.requests ?? []).filter((request) => request.status !== "cancelled" && request.pendingItemCount > 0);
  const inboxWaiting = inboxOpen.filter((request) => !requestDayHasPassed(request.requestedDay, todayKey));
  const inboxMissed = inboxOpen.filter((request) => requestDayHasPassed(request.requestedDay, todayKey));
  // A request with a slot on the calendar is SETTLED and leaves the requests at once, whatever its day
  // (the owner, 2026-10-17: "once the request is settled in the calendar it should not be appearing in
  // the requests anymore"): the interview lives on the calendar, and the card lists only CVs not yet
  // booked. There is no "fully booked" group any more.
  const isSettled = (request: InterviewRequest) => request.status !== "cancelled" && request.pendingItemCount === 0;
  const mineUpcoming = (mine.requests ?? []).filter((request) => !isSettled(request) && !requestDayHasPassed(request.requestedDay, todayKey));
  const mineEarlier = (mine.requests ?? []).filter((request) => !isSettled(request) && requestDayHasPassed(request.requestedDay, todayKey));

  return (
    <>
      {canBook ? (
        <section className={`border border-slate-200 bg-white ${adminPanelDepthClassName}`}>
          <div className="flex items-center justify-between gap-2 border-b-2 border-b-orange-600 px-4 py-2.5">
            <p className="inline-flex items-center gap-2 text-[14px] font-bold text-slate-900">
              <CalendarClock className="h-4 w-4 text-orange-600" />
              Requests waiting for a time
            </p>
            {inboxWaiting.length > 0 ? (
              <span className="border border-orange-300 bg-orange-100 px-2 py-0.5 text-[11px] font-bold text-orange-800">{inboxWaiting.length}</span>
            ) : null}
          </div>
          <div className="px-3 py-3">
            {inbox.error ? (
              <ErrorLine>{inbox.error}</ErrorLine>
            ) : inbox.requests === null ? (
              <p className="inline-flex items-center gap-1.5 px-1 text-[12px] text-slate-500">
                <Loader2 className="h-3.5 w-3.5 animate-spin" /> Reading the requests…
              </p>
            ) : inboxWaiting.length === 0 ? (
              <p className="px-1 text-[13px] text-slate-500">No requests are waiting for a time.</p>
            ) : (
              <ul className="flex flex-col gap-2">
                {inboxWaiting.map((request) => (
                  <RequestCard
                    api={api}
                    canBook={canBook}
                    key={request.id}
                    onBooked={onBooked}
                    onCancelled={inbox.remove}
                    onOpenBooking={onOpenBooking}
                    request={request}
                    todayKey={todayKey}
                    zoomConnected={zoomConnected}
                  />
                ))}
              </ul>
            )}
            {inboxMissed.length > 0 ? (
              <details className="mt-3">
                <summary className="cursor-pointer text-[12px] font-semibold text-slate-500 hover:text-slate-800">
                  {inboxMissed.length} {inboxMissed.length === 1 ? "request" : "requests"} whose day passed without a time
                </summary>
                <ul className="mt-2 flex flex-col gap-2">
                  {inboxMissed.map((request) => (
                    <RequestCard
                      api={api}
                      canBook={canBook}
                      key={request.id}
                      onBooked={onBooked}
                      onCancelled={inbox.remove}
                      onOpenBooking={onOpenBooking}
                      request={request}
                      todayKey={todayKey}
                      zoomConnected={zoomConnected}
                    />
                  ))}
                </ul>
              </details>
            ) : null}
          </div>
        </section>
      ) : null}

      {canRequest ? (
        <section className={`border border-slate-200 bg-white ${adminPanelDepthClassName}`}>
          <div className="flex items-center justify-between gap-2 border-b border-b-slate-200 px-4 py-2.5">
            <p className="inline-flex items-center gap-2 text-[14px] font-bold text-slate-900">
              <UserRound className="h-4 w-4 text-slate-500" />
              Your interview requests
            </p>
          </div>
          <div className="px-3 py-3">
            {mine.error ? (
              <ErrorLine>{mine.error}</ErrorLine>
            ) : mine.requests === null ? (
              <p className="inline-flex items-center gap-1.5 px-1 text-[12px] text-slate-500">
                <Loader2 className="h-3.5 w-3.5 animate-spin" /> Reading your requests…
              </p>
            ) : mine.requests.length === 0 ? (
              <p className="px-1 text-[13px] text-slate-500">You have not asked for any interviews yet. Use “Request an interview” above.</p>
            ) : (
              <>
                {mineUpcoming.length === 0 ? (
                  <p className="px-1 text-[13px] text-slate-500">No requests for the days ahead.</p>
                ) : (
                  <ul className="flex flex-col gap-2">
                    {mineUpcoming.map((request) => (
                      <RequestCard
                        api={api}
                        canBook={false}
                        key={request.id}
                        onBooked={onBooked}
                        onCancelled={mine.remove}
                        onOpenBooking={onOpenBooking}
                        request={request}
                        todayKey={todayKey}
                        zoomConnected={zoomConnected}
                      />
                    ))}
                  </ul>
                )}
                {mineEarlier.length > 0 ? (
                  <details className="mt-3">
                    <summary className="cursor-pointer text-[12px] font-semibold text-slate-500 hover:text-slate-800">
                      {mineEarlier.length} earlier {mineEarlier.length === 1 ? "request" : "requests"}
                    </summary>
                    <ul className="mt-2 flex flex-col gap-2">
                      {mineEarlier.map((request) => (
                        <RequestCard
                          api={api}
                          canBook={false}
                          key={request.id}
                          onBooked={onBooked}
                          onCancelled={mine.remove}
                          onOpenBooking={onOpenBooking}
                          request={request}
                          todayKey={todayKey}
                          zoomConnected={zoomConnected}
                        />
                      ))}
                    </ul>
                  </details>
                ) : null}
              </>
            )}
          </div>
        </section>
      ) : null}
    </>
  );
}
