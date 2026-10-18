"use client";

import { useEffect, useState } from "react";

import { phxFieldClassName, phxLabelTextClassName } from "@/components/ui/form-tokens";

import type { CalendarApi } from "./calendar-api";

// The interview's Role, Area and Line — all optional, and all shown in the calendar and the share
// link so an outside viewer can read the interviewer, the role, the area and the line at a glance
// (owner, 2026-09-26 for area and line). Choosing the interviewer auto-fills area and line from
// their org seat (handled by the dialog); they stay editable here. Line is the small fixed set of
// sales lines; Area is a name, usually auto-filled.
//
// THE ROLE IS WHY A CANDIDATE USED TO VANISH FROM THEIR OWN ROUND. A booking carried the area and
// the line but nothing naming the job, so a candidate the calendar created was written with no
// `applied_for_job_title` and never appeared in that role's pile — 28 of the 68 interviews from
// 1 September 2026 were in exactly that state when it was measured on 15 October. It is a FREE-TEXT
// box over a datalist, the way the Job Offers composer asks the same question: the offer catalogue
// holds four active titles and interviews are held for roles that are not in it, so the catalogue
// suggests and never decides.

const LINES = ["CNS", "Anti Infective", "Pedia", "Head Office", "Other"] as const;

const inputClass = `${phxFieldClassName} mt-1 block`;

/**
 * The titles the catalogue suggests. Best-effort on purpose: a failed read leaves the box as plain
 * free text, which is what it already is — an interview must still be bookable when the suggestion
 * list cannot be fetched.
 */
export function useInterviewJobTitles(api: CalendarApi): string[] {
  const [titles, setTitles] = useState<string[]>([]);
  useEffect(() => {
    let live = true;
    api
      .get("/job-titles")
      .then((data) => {
        if (live && Array.isArray(data.titles)) setTitles(data.titles.filter((title): title is string => typeof title === "string"));
      })
      .catch(() => {
        if (live) setTitles([]);
      });
    return () => {
      live = false;
    };
  }, [api]);
  return titles;
}

export function OrgFields({
  api,
  area,
  jobTitle,
  line,
  onArea,
  onJobTitle,
  onLine,
}: {
  api: CalendarApi;
  area: string;
  jobTitle: string;
  line: string;
  onArea: (value: string) => void;
  onJobTitle: (value: string) => void;
  onLine: (value: string) => void;
}) {
  const titles = useInterviewJobTitles(api);
  // Keep an auto-filled line that is not one of the fixed options selectable rather than dropping it.
  const lineOptions = line && !(LINES as readonly string[]).includes(line) ? [line, ...LINES] : [...LINES];
  return (
    <div className="flex flex-col gap-2.5">
      <label className="block">
        <span className={phxLabelTextClassName}>Role interviewed for (optional)</span>
        <input
          autoComplete="off"
          className={inputClass}
          list="interview-job-title-options"
          maxLength={120}
          onChange={(event) => onJobTitle(event.target.value)}
          placeholder="e.g. Office Coordinator"
          value={jobTitle}
        />
        <datalist id="interview-job-title-options">
          {titles.map((title) => (
            <option key={title} value={title} />
          ))}
        </datalist>
        <span className="mt-1 block text-[11px] leading-4 text-slate-500">
          Choose a title or type one. Someone added to Recruitment from this booking is filed under it.
        </span>
      </label>
      <div className="grid gap-2.5 sm:grid-cols-2">
        <label className="block">
          <span className={phxLabelTextClassName}>Line (optional)</span>
          <select className={inputClass} onChange={(event) => onLine(event.target.value)} value={line}>
            <option value="">—</option>
            {lineOptions.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className={phxLabelTextClassName}>Area (optional)</span>
          <input autoComplete="off" className={inputClass} maxLength={80} onChange={(event) => onArea(event.target.value)} placeholder="e.g. Delta (1)" value={area} />
        </label>
      </div>
    </div>
  );
}
