"use client";

// Choose who conducts an interview: an employee, found by name or job title. Optional — an interview
// with nobody chosen is still an interview, and the calendar's owner is then taken to be its interviewer.

import { Loader2, Search, UserRound, X } from "lucide-react";
import { useEffect, useState } from "react";

import type { InterviewCalendarPerson } from "@/lib/recruitment/interview-calendar-types";

import type { CalendarApi } from "./calendar-api";

export type ChosenInterviewer = { hrId: string; name: string; area?: string | null; line?: string | null };

export function InterviewerPicker({
  api,
  onChange,
  value,
}: {
  api: CalendarApi;
  onChange: (person: ChosenInterviewer | null) => void;
  value: ChosenInterviewer | null;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<InterviewCalendarPerson[]>([]);
  const [searching, setSearching] = useState(false);
  const text = query.trim();

  useEffect(() => {
    if (text.length < 2) return;
    let live = true;
    const timer = window.setTimeout(() => {
      setSearching(true);
      api
        .get(`/people?for=interviewer&q=${encodeURIComponent(text)}`)
        .then((data) => {
          if (live) setResults(Array.isArray(data.people) ? (data.people as InterviewCalendarPerson[]) : []);
        })
        .catch(() => {
          if (live) setResults([]);
        })
        .finally(() => {
          if (live) setSearching(false);
        });
    }, 250);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [api, text]);

  if (value) {
    return (
      <div className="flex items-center justify-between gap-2 border border-slate-200 bg-slate-50 px-3 py-2">
        <p className="flex min-w-0 items-center gap-2 break-words text-[13px] font-semibold text-slate-900">
          <UserRound className="h-4 w-4 shrink-0 text-slate-400" />
          {value.name}
        </p>
        <button
          aria-label={`Remove ${value.name} as the interviewer`}
          className="inline-flex h-7 w-7 shrink-0 items-center justify-center border border-transparent text-slate-500 hover:border-slate-200 hover:text-slate-900"
          onClick={() => onChange(null)}
          type="button"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    );
  }

  const shown = text.length < 2 ? [] : results;
  return (
    <div>
      <label className="flex items-center gap-2 border border-slate-200 bg-white px-2 focus-within:border-orange-500">
        <Search className="h-4 w-4 shrink-0 text-slate-400" />
        <input
          aria-label="Search for the interviewer"
          className="block min-w-0 flex-1 bg-transparent py-1.5 text-[13px] text-slate-800 focus:outline-none"
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search an employee by name or job title"
          value={query}
        />
        {searching ? <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-slate-400" /> : null}
      </label>
      {shown.length > 0 ? (
        <ul className="mt-1 max-h-44 overflow-y-auto border border-slate-200 bg-white">
          {shown.map((person) => (
            <li key={person.hrId}>
              <button
                className="block w-full px-3 py-1.5 text-left hover:bg-orange-50"
                onClick={() => {
                  onChange({ area: person.area ?? null, hrId: person.hrId, line: person.line ?? null, name: person.name });
                  setQuery("");
                  setResults([]);
                }}
                type="button"
              >
                <span className="block break-words text-[13px] font-semibold text-slate-900">{person.name}</span>
                {person.jobTitle ? <span className="block break-words text-[11px] text-slate-500">{person.jobTitle}</span> : null}
              </button>
            </li>
          ))}
        </ul>
      ) : text.length >= 2 && !searching ? (
        <p className="mt-1 text-[11px] text-slate-500">Nobody matches that.</p>
      ) : null}
    </div>
  );
}
