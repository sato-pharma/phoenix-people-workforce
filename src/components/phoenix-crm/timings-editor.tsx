"use client";

/**
 * Phoenix CRM — the days and hours a customer receives visits at one place.
 *
 * The owner's example: "Saturday, Monday and Tuesday … Saturday 2 to 4" — the hours can differ by
 * day, so a rep picks the days that share an hour, types the hour once, and adds it; a day with two
 * sittings gets a second hour. The Ramadan hours are a second, optional set: without them the normal
 * hours are used in Ramadan and the plan says so.
 *
 * Every change is checked with the same rules the server applies (src/lib/phoenix-crm/timings.ts), so
 * an overlap or a slip like "2:00 to 1:00" is caught while the rep is still at the clinic.
 */

import { useState } from "react";
import { Plus, X } from "lucide-react";

import { CrmButton, CrmField, CrmNote, crmInputClassName } from "@/components/phoenix-crm/ui";
import {
  clockValue,
  formatTimingWindow,
  parseClockMinute,
  parseTimings,
  PHOENIX_CRM_WEEKDAY_NAMES,
  PHOENIX_CRM_WEEKDAY_ORDER,
  PHOENIX_CRM_WEEKDAY_SHORT,
  resolveEndMinute,
  sortTimings,
} from "@/lib/phoenix-crm/timings";
import type { PhoenixCrmSeason, PhoenixCrmTiming } from "@/lib/phoenix-crm/types";
import { cn } from "@/lib/utils";

/** The shape the routes read: clock strings, as a time input gives them. */
export function timingsToDrafts(timings: ReadonlyArray<PhoenixCrmTiming>) {
  return timings.map((timing) => ({
    weekday: timing.weekday,
    start: clockValue(timing.startMinute),
    end: timing.endMinute === null ? "" : clockValue(timing.endMinute),
    season: timing.season,
  }));
}

type Checked = { ok: true; timings: PhoenixCrmTiming[] } | { ok: false; error: string };

/**
 * The server's check, for a list still being built: Ramadan hours may be entered before the normal
 * ones, so "no normal hours yet" is left to the save.
 */
function checkWhileEditing(timings: ReadonlyArray<PhoenixCrmTiming>): Checked {
  if (timings.length === 0) return { ok: true, timings: [] };
  const drafts = timingsToDrafts(timings);
  const result = parseTimings(drafts);
  if (result.ok) return result;
  if (timings.some((timing) => timing.season === "normal")) return result;
  const asOneSeason = parseTimings(drafts.map((draft) => ({ ...draft, season: "normal" })));
  return asOneSeason.ok ? { ok: true, timings: sortTimings([...timings]) } : { ok: false, error: asOneSeason.error };
}

function SeasonTimings({
  disabled = false,
  onRemove,
  season,
  timings,
}: {
  disabled?: boolean;
  /** Absent when the timings are only read. */
  onRemove?: (timing: PhoenixCrmTiming) => void;
  season: PhoenixCrmSeason;
  timings: ReadonlyArray<PhoenixCrmTiming>;
}) {
  const days = PHOENIX_CRM_WEEKDAY_ORDER.map((weekday) => ({
    weekday,
    windows: timings.filter((timing) => timing.season === season && timing.weekday === weekday),
  })).filter((day) => day.windows.length > 0);

  if (days.length === 0) {
    return (
      <p className="text-sm font-medium text-slate-500">
        {season === "normal" ? "No days added yet." : "No Ramadan hours. The normal hours are used in Ramadan."}
      </p>
    );
  }
  return (
    <ul className="divide-y divide-slate-100 border border-slate-200">
      {days.map((day) => (
        <li className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2.5" key={day.weekday}>
          <span className="w-24 shrink-0 text-sm font-black text-slate-900">{PHOENIX_CRM_WEEKDAY_NAMES[day.weekday]}</span>
          <span className="flex min-w-0 flex-1 flex-wrap gap-1.5">
            {day.windows.map((timing) => (
              <span
                className={cn(
                  "inline-flex max-w-full items-center gap-1 border border-slate-200 bg-slate-50 pl-2 text-xs font-bold text-slate-800",
                  // With a remove button the chip is the button's height; read only, it keeps its padding.
                  onRemove ? "py-0 pr-0" : "py-1 pr-1",
                )}
                key={`${timing.startMinute}-${timing.endMinute ?? "open"}`}
              >
                <span className="break-words">{formatTimingWindow(timing)}</span>
                {onRemove ? (
                  // 40px: the rep takes an hour off at the clinic door, with a thumb.
                  <button
                    aria-label={`Remove ${PHOENIX_CRM_WEEKDAY_NAMES[day.weekday]} ${formatTimingWindow(timing)}`}
                    className="inline-flex h-10 w-10 shrink-0 items-center justify-center text-slate-500 hover:bg-slate-200 hover:text-slate-900 disabled:opacity-40"
                    disabled={disabled}
                    onClick={() => onRemove(timing)}
                    type="button"
                  >
                    <X aria-hidden className="h-3.5 w-3.5" />
                  </button>
                ) : null}
              </span>
            ))}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** A place's saved days and hours, read only: the normal hours, then the Ramadan ones. */
export function TimingsReadout({ timings }: { timings: ReadonlyArray<PhoenixCrmTiming> }) {
  return (
    <div className="grid min-w-0 gap-3">
      <div className="grid gap-2">
        <p className="text-phx-sm font-black uppercase tracking-[0.12em] text-slate-500">Receives visits</p>
        <SeasonTimings season="normal" timings={timings} />
      </div>
      <div className="grid gap-2">
        <p className="text-phx-sm font-black uppercase tracking-[0.12em] text-slate-500">In Ramadan</p>
        <SeasonTimings season="ramadan" timings={timings} />
      </div>
    </div>
  );
}

export function TimingsEditor({
  disabled = false,
  idPrefix,
  onChange,
  ramadanNote,
  value,
}: {
  disabled?: boolean;
  /** Keeps the inputs' ids unique when two editors are on one screen. */
  idPrefix: string;
  onChange: (next: PhoenixCrmTiming[]) => void;
  ramadanNote?: string | null;
  value: ReadonlyArray<PhoenixCrmTiming>;
}) {
  const [season, setSeason] = useState<PhoenixCrmSeason>("normal");
  const [days, setDays] = useState<number[]>([]);
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [error, setError] = useState<string | null>(null);

  function toggleDay(weekday: number) {
    setError(null);
    setDays((current) => (current.includes(weekday) ? current.filter((day) => day !== weekday) : [...current, weekday]));
  }

  function add() {
    if (days.length === 0) {
      setError("Choose the days that share this hour.");
      return;
    }
    const startMinute = parseClockMinute(start);
    if (startMinute === null) {
      setError("Write the hour the customer starts receiving.");
      return;
    }
    const endClock = end.trim() ? parseClockMinute(end) : null;
    if (end.trim() && endClock === null) {
      setError("The end hour is not a time. Clear it or write it again.");
      return;
    }
    const additions: PhoenixCrmTiming[] = days.map((weekday) => ({
      weekday,
      startMinute,
      endMinute: resolveEndMinute(startMinute, endClock),
      season,
    }));
    const checked = checkWhileEditing([...value, ...additions]);
    if (!checked.ok) {
      setError(checked.error);
      return;
    }
    setError(null);
    setDays([]);
    setStart("");
    setEnd("");
    onChange(checked.timings);
  }

  function remove(timing: PhoenixCrmTiming) {
    setError(null);
    onChange(
      value.filter(
        (entry) =>
          !(
            entry.season === timing.season &&
            entry.weekday === timing.weekday &&
            entry.startMinute === timing.startMinute &&
            entry.endMinute === timing.endMinute
          ),
      ),
    );
  }

  const ramadanCount = value.filter((timing) => timing.season === "ramadan").length;

  return (
    <div className="grid min-w-0 gap-4">
      <div className="grid gap-2">
        <p className="text-phx-sm font-black uppercase tracking-[0.12em] text-slate-500">Receives visits</p>
        <SeasonTimings disabled={disabled} onRemove={remove} season="normal" timings={value} />
      </div>
      <div className="grid gap-2">
        <p className="text-phx-sm font-black uppercase tracking-[0.12em] text-slate-500">In Ramadan</p>
        <SeasonTimings disabled={disabled} onRemove={remove} season="ramadan" timings={value} />
        {ramadanNote ? <p className="text-xs font-medium text-slate-500">{ramadanNote}</p> : null}
      </div>

      <div className="grid min-w-0 gap-3 border border-dashed border-slate-300 bg-slate-50/60 p-3">
        <div className="grid grid-cols-2 gap-1.5" role="radiogroup" aria-label="Which hours">
          {(["normal", "ramadan"] as const).map((option) => (
            <button
              aria-checked={season === option}
              className={cn(
                "min-h-10 rounded-none border px-3 text-sm font-black",
                season === option ? "border-orange-500 bg-orange-50 text-orange-800" : "border-slate-200 bg-white text-slate-600",
              )}
              disabled={disabled}
              key={option}
              onClick={() => {
                setSeason(option);
                setError(null);
              }}
              role="radio"
              type="button"
            >
              {option === "normal" ? "Normal hours" : `Ramadan hours${ramadanCount ? ` (${ramadanCount})` : ""}`}
            </button>
          ))}
        </div>

        <div className="grid gap-1.5">
          <p className="text-phx-sm font-black uppercase tracking-[0.12em] text-slate-500">Days that share this hour</p>
          <div className="grid grid-cols-4 gap-1.5 sm:grid-cols-7">
            {PHOENIX_CRM_WEEKDAY_ORDER.map((weekday) => {
              const selected = days.includes(weekday);
              return (
                <button
                  aria-label={PHOENIX_CRM_WEEKDAY_NAMES[weekday]}
                  aria-pressed={selected}
                  className={cn(
                    "min-h-10 rounded-none border px-1 text-sm font-black transition",
                    selected ? "border-orange-500 bg-orange-600 text-white" : "border-slate-200 bg-white text-slate-700 hover:border-slate-300",
                  )}
                  disabled={disabled}
                  key={weekday}
                  onClick={() => toggleDay(weekday)}
                  type="button"
                >
                  {PHOENIX_CRM_WEEKDAY_SHORT[weekday]}
                </button>
              );
            })}
          </div>
        </div>

        <div className="grid grid-cols-2 gap-2">
          {/* `appearance-none`, as on the date inputs: without it iOS draws its own rounded control. */}
          <CrmField htmlFor={`${idPrefix}-start`} label="From">
            <input
              className={cn(crmInputClassName, "appearance-none")}
              disabled={disabled}
              id={`${idPrefix}-start`}
              onChange={(event) => setStart(event.target.value)}
              step={300}
              type="time"
              value={start}
            />
          </CrmField>
          <CrmField htmlFor={`${idPrefix}-end`} label="To (if known)">
            <input
              className={cn(crmInputClassName, "appearance-none")}
              disabled={disabled}
              id={`${idPrefix}-end`}
              onChange={(event) => setEnd(event.target.value)}
              step={300}
              type="time"
              value={end}
            />
          </CrmField>
        </div>

        <CrmButton disabled={disabled} onClick={add} variant="secondary">
          <Plus aria-hidden className="h-4 w-4" />
          Add {season === "ramadan" ? "Ramadan hours" : "these hours"}
        </CrmButton>
        {error ? <CrmNote tone="bad">{error}</CrmNote> : null}
      </div>
    </div>
  );
}
