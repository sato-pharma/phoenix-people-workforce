"use client";

// Choose ADDITIONAL panel members for an interview — beyond the lead interviewer. Each one also sees
// the interview on their calendar, in their "My interviews" and on their .ics feed; the lead stays
// the outcome-setter and the Zoom host. Same people as the interviewer search (District Managers and
// above), and the lead is never offered as a panel member. Optional — an interview needs no panel.

import { Loader2, Search, UserPlus, X } from "lucide-react";
import { useEffect, useState } from "react";

import type { InterviewCalendarPerson } from "@/lib/recruitment/interview-calendar-types";

import type { CalendarApi } from "./calendar-api";
import type { ChosenInterviewer } from "./interviewer-picker";

export function PanelPicker({
  api,
  excludeHrId,
  onChange,
  value,
}: {
  api: CalendarApi;
  /** The lead interviewer's hr id, when one is chosen — never offered as a panel member. */
  excludeHrId?: string | null;
  onChange: (people: ChosenInterviewer[]) => void;
  value: ChosenInterviewer[];
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<InterviewCalendarPerson[]>([]);
  const [searching, setSearching] = useState(false);
  const text = query.trim();
  const chosenKeys = new Set(value.map((person) => person.hrId.toLowerCase()));
  const excludeKey = excludeHrId?.toLowerCase() ?? null;

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

  function add(person: InterviewCalendarPerson) {
    onChange([...value, { hrId: person.hrId, name: person.name }]);
    setQuery("");
    setResults([]);
  }

  function remove(hrId: string) {
    onChange(value.filter((person) => person.hrId !== hrId));
  }

  // Not already chosen, and not the lead — those cannot be added twice.
  const shown = text.length < 2 ? [] : results.filter((person) => !chosenKeys.has(person.hrId.toLowerCase()) && person.hrId.toLowerCase() !== excludeKey);

  return (
    <div className="flex flex-col gap-2">
      {value.length > 0 ? (
        <ul className="flex flex-wrap gap-1.5">
          {value.map((person) => (
            <li className="inline-flex items-center gap-1.5 border border-slate-200 bg-slate-50 px-2 py-1 text-[12px] font-semibold text-slate-800" key={person.hrId}>
              {person.name}
              <button
                aria-label={`Remove ${person.name} from the panel`}
                className="inline-flex h-4 w-4 items-center justify-center text-slate-500 hover:text-slate-900"
                onClick={() => remove(person.hrId)}
                type="button"
              >
                <X className="h-3 w-3" />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <div>
        <label className="flex items-center gap-2 border border-slate-200 bg-white px-2 focus-within:border-orange-500">
          <Search className="h-4 w-4 shrink-0 text-slate-400" />
          <input
            aria-label="Add a panel member"
            className="block min-w-0 flex-1 bg-transparent py-1.5 text-[13px] text-slate-800 focus:outline-none"
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Add another interviewer by name or job title"
            value={query}
          />
          {searching ? <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-slate-400" /> : null}
        </label>
        {shown.length > 0 ? (
          <ul className="mt-1 max-h-40 overflow-y-auto border border-slate-200 bg-white">
            {shown.map((person) => (
              <li key={person.hrId}>
                <button className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-orange-50" onClick={() => add(person)} type="button">
                  <UserPlus className="h-3.5 w-3.5 shrink-0 text-slate-400" />
                  <span className="min-w-0">
                    <span className="block break-words text-[13px] font-semibold text-slate-900">{person.name}</span>
                    {person.jobTitle ? <span className="block break-words text-[11px] text-slate-500">{person.jobTitle}</span> : null}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        ) : text.length >= 2 && !searching ? (
          <p className="mt-1 text-[11px] text-slate-500">Nobody else matches that.</p>
        ) : null}
      </div>
    </div>
  );
}
