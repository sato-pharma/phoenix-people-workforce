/**
 * Today's interviews — the first panel he chose for her page on 2026-10-16 ("Today's interviews").
 *
 * WHAT IT ANSWERS: "who am I seeing today, when, and which one is next". The week grid below answers
 * the same question for seven days at once and needs a scroll to reach the right hour; this panel is
 * the one glance a recruiter takes at 9am. It is NOT a second calendar: every row is a link into the
 * real interview calendar with that interview open (`?open=<id>`), which is where she does anything
 * to it.
 *
 * THE ROWS ARE THE CALENDAR'S OWN. `listInterviewCalendarDay` reads them through the calendar's own
 * gate, so this panel can never show her an interview the calendar would not.
 *
 * NEXT AND ENDED ARE THE SERVER'S CLOCK. `orderTodaysInterviews` marks an interview ENDED once its
 * end time has passed — not its start, because one that began ten minutes ago still has a candidate
 * in the room — and NEXT is the first one not ended. Both use the minutes the server saw when it
 * built the page, refreshed every minute with the rest of it, so a browser on the wrong timezone
 * cannot grey out the interview that is about to start.
 *
 * A FAILED READ IS SAID. `loaded: false` draws the amber notice, never "No interviews today".
 */

import { CalendarClock, CalendarX2, Video, MapPin } from "lucide-react";
import Link from "next/link";

import {
  orderTodaysInterviews,
  startClockParts,
  type TalentToday,
} from "@/lib/hr/talent-acquisition-logic";

import { TA_ROW_LINK_CLASS, TaChip, TaCouldNotLoad, TaEmpty, TaPanel, TaQuietLink } from "./panel";

const CALENDAR_HREF = "/hr/recruitment/interview-calendar";

export function TaTodayInterviews({
  className = "",
  readOnly = false,
  today,
}: {
  className?: string;
  /** A seat that only views the calendar (owner, 2026-10-20) is never told to book on it. */
  readOnly?: boolean;
  today: TalentToday;
}) {
  const rows = orderTodaysInterviews(today.interviews, today.nowMinutes);
  const ended = rows.filter((row) => row.done).length;
  const toCome = rows.length - ended;

  return (
    <TaPanel
      className={className}
      count={today.loaded ? rows.length : null}
      footer={
        today.loaded && rows.length > 0 ? (
          <span>
            <span className="font-black tabular-nums text-slate-700">{toCome}</span> still to come
            <span aria-hidden="true" className="px-1.5 text-slate-300">
              ·
            </span>
            <span className="font-black tabular-nums text-slate-700">{ended}</span> ended
          </span>
        ) : undefined
      }
      href={CALENDAR_HREF}
      hrefLabel="Open calendar"
      icon={CalendarClock}
      id="ta-today-interviews"
      title="Today's interviews"
    >
      {!today.loaded ? (
        <TaCouldNotLoad what="Today's interviews" />
      ) : rows.length === 0 ? (
        <TaEmpty
          action={<TaQuietLink href={CALENDAR_HREF}>{readOnly ? "Open the calendar" : "Book on the calendar"}</TaQuietLink>}
          icon={CalendarX2}
          line="Nothing is booked today. The week below shows what is coming."
          title="No interviews today"
        />
      ) : (
        <ol className="divide-y divide-slate-100">
          {rows.map((row) => {
            const PlatformIcon = /zoom|teams|meet|online/i.test(row.platformLabel) ? Video : MapPin;
            const clock = startClockParts(row.startMinutes);
            return (
              <li key={row.id}>
                <Link
                  aria-label={`${row.timeLabel}, ${row.candidateName}${row.jobTitle ? `, ${row.jobTitle}` : ""}${row.done ? ", ended" : row.next ? ", next" : ""}`}
                  className={`${TA_ROW_LINK_CLASS} items-start ${
                    row.next ? "bg-[linear-gradient(90deg,rgba(255,247,237,0.95)_0%,rgba(255,255,255,0)_75%)]" : ""
                  }`}
                  href={row.href}
                >
                  {row.next ? (
                    <span aria-hidden="true" className="absolute inset-y-0 left-0 w-[3px] bg-[linear-gradient(180deg,#F97316_0%,#FB923C_100%)]" />
                  ) : null}
                  {/* The time column: the start large, the end under it, so a run of rows reads down
                      the left edge like a diary. */}
                  <span className="flex w-14 shrink-0 flex-col items-start pt-0.5">
                    <span
                      className={`text-[15px] font-black leading-none tabular-nums ${
                        row.done ? "text-slate-500" : row.next ? "text-orange-700" : "text-slate-900"
                      }`}
                    >
                      {clock.time}
                      <span className="ml-0.5 text-[10px] tracking-[0.06em]">{clock.suffix}</span>
                    </span>
                    <span className="mt-1 text-[10px] font-bold tabular-nums text-slate-500">
                      {row.durationMinutes} min
                    </span>
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <span
                        className={`break-words text-[13px] font-bold leading-snug ${
                          row.done ? "text-slate-500" : "text-slate-900 group-hover/row:text-orange-800"
                        }`}
                        dir="auto"
                      >
                        {row.candidateName}
                      </span>
                      {row.next ? <TaChip tone="orange">Next</TaChip> : null}
                      {row.done ? <TaChip>Ended</TaChip> : null}
                    </span>
                    {row.jobTitle ? (
                      <span className="mt-0.5 block break-words text-[11px] font-semibold text-slate-500">
                        {row.jobTitle}
                      </span>
                    ) : null}
                    <span className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] font-bold uppercase tracking-[0.1em] text-slate-500">
                      <span className="inline-flex items-center gap-1 whitespace-nowrap">
                        <PlatformIcon aria-hidden="true" className="h-3 w-3" />
                        {row.platformLabel}
                      </span>
                      {row.interviewerName ? (
                        <span className="break-words normal-case tracking-normal text-[11px] font-semibold text-slate-500">
                          with {row.interviewerName}
                        </span>
                      ) : null}
                    </span>
                  </span>
                </Link>
              </li>
            );
          })}
        </ol>
      )}
    </TaPanel>
  );
}
