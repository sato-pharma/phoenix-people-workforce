import type { HiringCalendarInterview } from "@/lib/phoenix-crm/team-calendar";

/** The sentence a day page shows when the hiring calendar could not be read — said, never an empty day. */
export const HIRING_INTERVIEWS_UNREAD_NOTE =
  "The interviews on the hiring calendar could not be read just now, so any interview this day had is not shown here.";

/**
 * Phoenix CRM — the interviews from the HIRING calendar on one day (owner, 2026-11-27: "every single entry … must
 * appear in both calendars"). The private calendar's own list, in its own words: the time, the role and the
 * person's part. Display only — nothing here counts toward a figure.
 */
export function HiringInterviewsList({ interviews }: { interviews: readonly HiringCalendarInterview[] }) {
  if (interviews.length === 0) return null;
  return (
    <div className="mt-2 min-w-0">
      <p className="break-words text-sm font-black leading-6 text-slate-900">
        {interviews.length === 1 ? "1 interview" : `${interviews.length} interviews`} on the hiring calendar
      </p>
      <ul className="mt-1 grid min-w-0 gap-1">
        {interviews.map((interview, index) => (
          <li className="break-words text-sm font-semibold leading-6 text-slate-700" key={`${interview.time}-${index}`}>
            <span className="font-black text-slate-900">{interview.time || "Time not set"}</span>
            {" — "}
            <span dir="auto">{interview.title}</span>
            {interview.part ? ` · ${interview.part}` : ""}
          </li>
        ))}
      </ul>
    </div>
  );
}
