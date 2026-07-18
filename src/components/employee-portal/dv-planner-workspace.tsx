"use client";

import { useCallback, useMemo, useState, useSyncExternalStore } from "react";
import { CalendarCheck2, Check, Search, UserRoundCheck, X } from "lucide-react";

import {
  groupDvPlannerVisitsByRepDate,
  matchDvPlannerVisits,
  type DvPlannerRep,
  type DvPlannerVisit,
} from "@/lib/double-visit-analytics/planner";
import { canonicalHrIdKey } from "@/lib/hr-id";

type PlannedDates = Record<string, string>;

const DV_PLANNER_STORAGE_EVENT = "phoenix-dv-planner-change";

function usePlannedDates(storageKey: string): PlannedDates {
  const subscribe = useCallback((callback: () => void) => {
    window.addEventListener("storage", callback);
    window.addEventListener(DV_PLANNER_STORAGE_EVENT, callback);
    return () => {
      window.removeEventListener("storage", callback);
      window.removeEventListener(DV_PLANNER_STORAGE_EVENT, callback);
    };
  }, []);
  const getSnapshot = useCallback(() => {
    try {
      return window.localStorage.getItem(storageKey) ?? "{}";
    } catch {
      return "{}";
    }
  }, [storageKey]);
  const serialized = useSyncExternalStore(subscribe, getSnapshot, () => "{}");
  return useMemo(() => {
    try {
      return JSON.parse(serialized) as PlannedDates;
    } catch {
      return {};
    }
  }, [serialized]);
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  }).format(new Date(`${value}T12:00:00Z`));
}

export function DvPlannerWorkspace({
  dateFrom,
  dateTo,
  reps,
  today,
  viewerHrId,
  visits,
}: {
  dateFrom: string;
  dateTo: string;
  reps: DvPlannerRep[];
  today: string;
  viewerHrId: string;
  visits: DvPlannerVisit[];
}) {
  const storageKey = `phoenix-dv-planner:${viewerHrId.toLowerCase()}`;
  const plannedDates = usePlannedDates(storageKey);
  const [search, setSearch] = useState("");

  const visitsByRepDate = useMemo(() => groupDvPlannerVisitsByRepDate(visits), [visits]);

  const filteredReps = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return reps;
    return reps.filter((rep) =>
      [rep.name, rep.hrId, rep.areaName, rep.lineName]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(term)),
    );
  }, [reps, search]);

  function setPlannedDate(hrId: string, date: string) {
    const key = canonicalHrIdKey(hrId) ?? hrId.toLowerCase();
    const next = { ...plannedDates };
    if (date) next[key] = date;
    else delete next[key];
    try {
      window.localStorage.setItem(storageKey, JSON.stringify(next));
      window.dispatchEvent(new Event(DV_PLANNER_STORAGE_EVENT));
    } catch {
      // The planner still works for this session when browser storage is unavailable.
    }
  }

  return (
    <div className="space-y-4">
      <section className="overflow-hidden border border-slate-200 bg-[#f8fbff] shadow-[0_18px_45px_rgba(30,64,175,0.08)]">
        <div className="grid gap-5 border-b border-slate-200 bg-white px-5 py-5 lg:grid-cols-[1fr_auto] lg:items-end">
          <div>
            <div className="mb-2 flex items-center gap-2 text-[11px] font-black uppercase tracking-[0.18em] text-blue-700">
              <CalendarCheck2 className="h-4 w-4" /> Simple day check
            </div>
            <p className="max-w-2xl text-sm leading-6 text-slate-600">
              Pick the date you chose for each rep. The result answers one question only: did CRM record a double visit for that rep on that day?
            </p>
          </div>
          <label className="relative block min-w-0 lg:w-[320px]">
            <span className="sr-only">Search Medical Reps</span>
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <input
              className="h-11 w-full border border-slate-200 bg-slate-50 pl-10 pr-3 text-sm text-slate-900 outline-none transition focus:border-blue-400 focus:bg-white focus:ring-4 focus:ring-blue-100"
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search rep, HR ID, area or line"
              type="search"
              value={search}
            />
          </label>
        </div>

        <div className="hidden grid-cols-[minmax(230px,1.5fr)_minmax(190px,0.9fr)_minmax(260px,1fr)] border-b border-slate-200 bg-[#eef4ff] px-5 py-3 text-[10px] font-black uppercase tracking-[0.14em] text-slate-500 md:grid">
          <span>Medical Rep</span>
          <span>Chosen DV date</span>
          <span>CRM result</span>
        </div>

        <div className="divide-y divide-slate-200 bg-white">
          {filteredReps.map((rep) => {
            const hrKey = canonicalHrIdKey(rep.hrId) ?? rep.hrId.toLowerCase();
            const selectedDate = plannedDates[hrKey] ?? "";
            const { visitors, wasRecorded } = matchDvPlannerVisits(visitsByRepDate, rep.hrId, selectedDate);
            const isFuture = Boolean(selectedDate && selectedDate > today);

            return (
              <div
                className="grid gap-4 px-5 py-4 transition hover:bg-blue-50/45 md:grid-cols-[minmax(230px,1.5fr)_minmax(190px,0.9fr)_minmax(260px,1fr)] md:items-center"
                key={hrKey}
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-3">
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center bg-[#172554] text-white">
                      <UserRoundCheck className="h-4 w-4" />
                    </span>
                    <div className="min-w-0">
                      <p className="truncate text-sm font-bold text-slate-950">{rep.name}</p>
                      <p className="mt-0.5 truncate text-xs text-slate-500">
                        {rep.hrId} · {[rep.areaName, rep.lineName].filter(Boolean).join(" · ") || "Scope member"}
                      </p>
                    </div>
                  </div>
                </div>

                <div>
                  <label className="mb-1.5 block text-[10px] font-black uppercase tracking-wider text-slate-400 md:hidden" htmlFor={`dv-date-${hrKey}`}>
                    Chosen DV date
                  </label>
                  <input
                    className="h-10 w-full border border-slate-200 bg-white px-3 text-sm font-semibold text-slate-800 outline-none transition focus:border-blue-400 focus:ring-4 focus:ring-blue-100"
                    id={`dv-date-${hrKey}`}
                    max={dateTo}
                    min={dateFrom}
                    onChange={(event) => setPlannedDate(rep.hrId, event.target.value)}
                    type="date"
                    value={selectedDate}
                  />
                </div>

                <div>
                  <p className="mb-1.5 text-[10px] font-black uppercase tracking-wider text-slate-400 md:hidden">CRM result</p>
                  {!selectedDate ? (
                    <div className="border border-dashed border-slate-300 bg-slate-50 px-3 py-2.5 text-xs font-semibold text-slate-500">
                      Choose a date
                    </div>
                  ) : wasRecorded ? (
                    <div className="flex items-start gap-2 border border-emerald-200 bg-emerald-50 px-3 py-2.5 text-emerald-900">
                      <Check className="mt-0.5 h-4 w-4 shrink-0" />
                      <div>
                        <p className="text-xs font-black">Yes · Double visit recorded</p>
                        <p className="mt-0.5 text-[11px] text-emerald-700">
                          {formatDate(selectedDate)}{visitors.length ? ` · with ${visitors.join(", ")}` : ""}
                        </p>
                      </div>
                    </div>
                  ) : isFuture ? (
                    <div className="border border-blue-200 bg-blue-50 px-3 py-2.5 text-xs font-bold text-blue-800">
                      Date selected · {formatDate(selectedDate)}
                    </div>
                  ) : (
                    <div className="flex items-start gap-2 border border-amber-200 bg-amber-50 px-3 py-2.5 text-amber-950">
                      <X className="mt-0.5 h-4 w-4 shrink-0" />
                      <div>
                        <p className="text-xs font-black">No · Not recorded in CRM</p>
                        <p className="mt-0.5 text-[11px] text-amber-700">Checked for {formatDate(selectedDate)}</p>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            );
          })}

          {filteredReps.length === 0 ? (
            <div className="px-5 py-12 text-center text-sm text-slate-500">No Medical Reps match this search.</div>
          ) : null}
        </div>
      </section>

      <p className="text-xs leading-5 text-slate-500">
        Read-only CRM check · Local planner dates stay in this browser · Nothing is submitted to Weekly Plans.
      </p>
    </div>
  );
}
