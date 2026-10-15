"use client";

// The interviews that are over and that nobody has said how they went — asked for on the calendar
// itself, by the person who can answer.
//
// WHY IT EXISTS. The outcome has been on every interview since 2026-09-20 and it already moves the
// candidate in Recruitment: Shortlisted, Back-up, Rejected, or Prioritized with the three-star top
// pick. The reminder job has nagged the lead interviewer since 2026-09-23. And still, measured on
// production on 15 October 2026, 50 of the 68 interviews held from 1 September on carried no
// outcome at all — so the candidate sat in whatever pile the CV landed in, and the interview might
// as well not have happened. A notice in a list somebody has to open is not the same as the
// calendar asking; this asks, where the person already is, and one click opens the interview with
// its outcome picker.
//
// WHO SEES IT: the server returns only the interviews THIS caller may set an outcome on — the lead
// interviewer, or the calendar's owner. A viewer is never handed a list they cannot act on, and a
// share-link guest is never handed one at all.

import { ClipboardCheck } from "lucide-react";
import { useEffect, useState } from "react";

import { adminPanelDepthClassName } from "@/components/admin/admin-design-tokens";
import { PLATFORM_LABEL, type InterviewBooking } from "@/lib/recruitment/interview-calendar-types";
import { formatShortDate, formatTimeRange } from "@/lib/recruitment/interview-calendar-week";

import { type CalendarApi } from "./calendar-api";

export function OutcomePromptPanel({
  api,
  onOpenBooking,
  reloadSignal = 0,
}: {
  api: CalendarApi;
  onOpenBooking: (id: string) => void;
  /** Bumped when an outcome is recorded, so the panel drops the interview that was just answered. */
  reloadSignal?: number;
}) {
  const [bookings, setBookings] = useState<InterviewBooking[] | null>(null);

  useEffect(() => {
    let live = true;
    api
      .get("/bookings?awaiting=outcome")
      .then((data) => {
        if (live) setBookings(Array.isArray(data.bookings) ? (data.bookings as InterviewBooking[]) : []);
      })
      .catch(() => {
        // Silent on purpose: this panel is a prompt, and a failed read must not put an error across
        // the top of a calendar that is otherwise working.
        if (live) setBookings([]);
      });
    return () => {
      live = false;
    };
  }, [api, reloadSignal]);

  // Nothing waiting, or still reading — the calendar shows no box at all rather than an empty one.
  if (bookings === null) return null;
  if (bookings.length === 0) return null;

  return (
    <section aria-label="Interviews waiting for an outcome" className={`border border-slate-200 bg-white ${adminPanelDepthClassName}`}>
      <div className="flex items-center justify-between gap-2 border-b-2 border-b-amber-500 px-4 py-2.5">
        <p className="inline-flex items-center gap-2 text-[14px] font-bold text-slate-900">
          <ClipboardCheck className="h-4 w-4 text-amber-600" />
          {bookings.length === 1 ? "An interview is waiting for its outcome" : "Interviews waiting for their outcome"}
        </p>
        <span className="border border-amber-300 bg-amber-100 px-2 py-0.5 text-[11px] font-bold text-amber-800">{bookings.length}</span>
      </div>
      <div className="px-3 py-3">
        <p className="px-1 text-[12px] text-slate-600">
          These are over. Open one and say how it went — Shortlisted, Back-up, Rejected or Prioritized also moves the candidate in
          Recruitment. Nothing is sent to the candidate.
        </p>
        <ul className="mt-2 flex flex-col">
          {bookings.map((booking) => (
            <li className="border-b border-slate-100 last:border-b-0" key={booking.id}>
              <button
                className="flex w-full flex-wrap items-baseline gap-x-2 gap-y-0.5 px-1 py-2 text-left hover:bg-amber-50"
                onClick={() => onOpenBooking(booking.id)}
                type="button"
              >
                <span className="break-words text-[13px] font-bold text-amber-800 underline decoration-amber-300 underline-offset-2">
                  {booking.candidateName}
                </span>
                {booking.jobTitle ? <span className="break-words text-[12px] text-slate-700">{booking.jobTitle}</span> : null}
                <span className="text-[11px] tabular-nums text-slate-500">
                  {formatShortDate(booking.dateKey)} · {formatTimeRange(booking.startMinutes, booking.durationMinutes)} ·{" "}
                  {PLATFORM_LABEL[booking.platform]}
                </span>
                {booking.interviewerName ? <span className="text-[11px] text-slate-500">{booking.interviewerName}</span> : null}
              </button>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
