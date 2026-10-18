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

import { ChevronRight, ClipboardCheck } from "lucide-react";
import { useEffect, useState } from "react";

import { adminSoftDepthClassName } from "@/components/admin/admin-design-tokens";
import { RecruitmentPanel } from "@/components/recruitment/recruitment-premium";
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
    <div aria-label="Interviews waiting for an outcome" role="region">
      <RecruitmentPanel
        bodyClassName="p-3 sm:p-4"
        count={bookings.length}
        description="These are over. Open one and say how it went — Shortlisted, Back-up, Rejected or Prioritized also moves the candidate in Recruitment. Nothing is sent to the candidate."
        icon={<ClipboardCheck aria-hidden className="h-4 w-4" />}
        title={bookings.length === 1 ? "An interview is waiting for its outcome" : "Interviews waiting for their outcome"}
      >
        <ul className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
          {bookings.map((booking) => (
            <li className="min-w-0" key={booking.id}>
              <button
                className={`group flex h-full w-full items-start gap-3 border border-amber-200 border-l-[3px] border-l-amber-500 bg-amber-50/40 px-3 py-2.5 text-left transition-colors hover:border-amber-300 hover:bg-amber-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400 ${adminSoftDepthClassName}`}
                onClick={() => onOpenBooking(booking.id)}
                type="button"
              >
                <span className="min-w-0 flex-1">
                  <span className="block break-words text-[13px] font-bold text-amber-900 underline decoration-amber-300 underline-offset-2 group-hover:decoration-amber-600">
                    {booking.candidateName}
                  </span>
                  {booking.jobTitle ? <span className="mt-0.5 block break-words text-[12px] text-slate-700">{booking.jobTitle}</span> : null}
                  <span className="mt-1 block text-[11px] tabular-nums text-slate-500">
                    {formatShortDate(booking.dateKey)} · {formatTimeRange(booking.startMinutes, booking.durationMinutes)} ·{" "}
                    {PLATFORM_LABEL[booking.platform]}
                  </span>
                  {booking.interviewerName ? <span className="block break-words text-[11px] font-semibold text-slate-600">{booking.interviewerName}</span> : null}
                </span>
                <span className="inline-flex items-center gap-0.5 pt-0.5 text-[11px] font-black uppercase tracking-[0.06em] text-amber-800">
                  Outcome
                  <ChevronRight aria-hidden className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" />
                </span>
              </button>
            </li>
          ))}
        </ul>
      </RecruitmentPanel>
    </div>
  );
}
