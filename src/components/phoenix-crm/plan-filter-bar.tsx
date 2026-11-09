"use client";

/**
 * Phoenix CRM — the customer filter on the plan board, owner 2026-09-25 and 2026-09-29.
 *
 * While the rep ticks a day he narrows its customers by the weekday they receive on (from their
 * validated days and hours), by brick, by AM / PM, by grade and by speciality, and finds one by name.
 * The narrowings are independent (plan-filters.ts). This bar only holds the controls and reports the
 * change; the filtering itself is filterPlannerCustomers, so one test covers the logic.
 *
 * 🔴 EVERY FILTER IS A DROPDOWN, AND THE PICKERS ARE BUTTONS (owner, 2026-10-01). "Receives on" used to
 * be a grid of day buttons — the same square buttons as the Week and the Day pickers above it — and on
 * the first Delta (1) session reps pressed it believing they were choosing the day they were planning.
 * So nothing in this bar is a button grid any more: Week and Day CHOOSE where he is, and these
 * dropdowns only NARROW the list. Do not turn one back into a `CrmChoice`.
 *
 * The time window reads only with a weekday chosen — "between 2 and 4" means nothing without a day. The
 * bar wraps on a phone and never scrolls sideways; a native select opens the phone's own picker.
 */

import { CrmButton, CrmField, CrmSearchField, CrmSelect, crmInputClassName } from "@/components/phoenix-crm/ui";
import { EMPTY_DOCTOR_FILTER, doctorFilterActive, type DoctorFilter, type DoctorSessionFilter } from "@/lib/phoenix-crm/plan-filters";
import { PHOENIX_CRM_WEEKDAY_NAMES, PHOENIX_CRM_WEEKDAY_ORDER } from "@/lib/phoenix-crm/timings";
import type { PhoenixCrmGrade } from "@/lib/phoenix-crm/types";
import { cn } from "@/lib/utils";

/** "14:30" ↔ minutes after midnight; a blank field is the open end of the range. */
function minutesToTime(minute: number | null): string {
  if (minute === null) return "";
  return `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
}

function timeToMinutes(value: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const minute = Number(match[1]) * 60 + Number(match[2]);
  return Number.isFinite(minute) && minute >= 0 && minute <= 1439 ? minute : null;
}

const SESSION_OPTIONS: ReadonlyArray<{ value: DoctorSessionFilter; label: string }> = [
  { value: "all", label: "AM and PM" },
  { value: "AM", label: "AM" },
  { value: "PM", label: "PM" },
];

function isSession(value: string): value is DoctorSessionFilter {
  return value === "all" || value === "AM" || value === "PM";
}

export function PlanFilterBar({
  bricks,
  filter,
  grades = [],
  idPrefix,
  locked = false,
  onChange,
  onQueryChange,
  query = "",
  /** A screen that shows one list (the rep's AM or PM step) hides the AM or PM control. */
  showSession = true,
  /** A screen that fixes the weekday hides its control and the day part of the label. */
  showWeekday = true,
  specialities = [],
  venues = [],
}: {
  bricks: ReadonlyArray<{ value: string; label: string }>;
  filter: DoctorFilter;
  /** Grades present on the list, for the grade picker; empty hides it. */
  grades?: ReadonlyArray<PhoenixCrmGrade>;
  idPrefix: string;
  locked?: boolean;
  onChange: (next: DoctorFilter) => void;
  /** The name search; without it the search box is not shown. */
  onQueryChange?: (next: string) => void;
  query?: string;
  showSession?: boolean;
  showWeekday?: boolean;
  /** Specialities present on the list, for the speciality picker; empty hides it. */
  specialities?: ReadonlyArray<string>;
  /** Polyclinics and centres customers are seated in, for the building picker; empty hides it. */
  venues?: ReadonlyArray<{ value: string; label: string }>;
}) {
  const weekdayId = `${idPrefix}-filter-weekday`;
  const sessionId = `${idPrefix}-filter-session`;
  const gradeId = `${idPrefix}-filter-grade`;
  const brickId = `${idPrefix}-filter-brick`;
  const venueId = `${idPrefix}-filter-venue`;
  const specialityId = `${idPrefix}-filter-speciality`;
  const searchId = `${idPrefix}-filter-search`;
  const fromId = `${idPrefix}-filter-from`;
  const toId = `${idPrefix}-filter-to`;
  const active = doctorFilterActive(filter) || query.trim() !== "";
  const dayChosen = filter.weekday !== null;

  return (
    <div className="grid min-w-0 gap-3 border border-slate-200 bg-slate-50 px-3.5 py-3">
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
        <p className="text-phx-sm font-black uppercase tracking-[0.16em] text-slate-500">Filter the customers</p>
        {active ? (
          <CrmButton
            disabled={locked}
            onClick={() => {
              onChange(EMPTY_DOCTOR_FILTER);
              onQueryChange?.("");
            }}
            size="sm"
            variant="ghost"
          >
            Clear filters
          </CrmButton>
        ) : null}
      </div>

      {onQueryChange ? (
        <CrmSearchField id={searchId} label="Find a customer" onChange={onQueryChange} placeholder="Name, speciality, brick or place" value={query} />
      ) : null}

      <div className="grid min-w-0 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {showWeekday ? (
          <CrmField hint="Narrows the list only" htmlFor={weekdayId} label="Receives on">
            <CrmSelect
              disabled={locked}
              id={weekdayId}
              onChange={(event) =>
                onChange({ ...filter, weekday: event.target.value === "" ? null : Number(event.target.value), fromMinute: null, toMinute: null })
              }
              value={filter.weekday === null ? "" : String(filter.weekday)}
            >
              <option value="">Any day</option>
              {PHOENIX_CRM_WEEKDAY_ORDER.filter((weekday) => weekday !== 5).map((weekday) => (
                <option key={weekday} value={String(weekday)}>
                  {PHOENIX_CRM_WEEKDAY_NAMES[weekday]}
                </option>
              ))}
            </CrmSelect>
          </CrmField>
        ) : null}

        {showSession ? (
          <CrmField htmlFor={sessionId} label="AM or PM">
            <CrmSelect
              disabled={locked}
              id={sessionId}
              onChange={(event) => {
                if (isSession(event.target.value)) onChange({ ...filter, session: event.target.value });
              }}
              value={filter.session}
            >
              {SESSION_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </CrmSelect>
          </CrmField>
        ) : null}

        {grades.length > 0 ? (
          <CrmField htmlFor={gradeId} label="Grade">
            <CrmSelect
              disabled={locked}
              id={gradeId}
              onChange={(event) => onChange({ ...filter, grade: event.target.value === "" ? null : (event.target.value as PhoenixCrmGrade) })}
              value={filter.grade ?? ""}
            >
              <option value="">Any grade</option>
              {grades.map((grade) => (
                <option key={grade} value={grade}>
                  Grade {grade}
                </option>
              ))}
            </CrmSelect>
          </CrmField>
        ) : null}

        {bricks.length > 0 ? (
          <CrmField htmlFor={brickId} label="Brick">
            <CrmSelect
              disabled={locked}
              id={brickId}
              onChange={(event) => onChange({ ...filter, brick: event.target.value || null })}
              value={filter.brick ?? ""}
            >
              <option value="">Every brick</option>
              {bricks.map((brick) => (
                <option key={brick.value} value={brick.value}>
                  {brick.label}
                </option>
              ))}
            </CrmSelect>
          </CrmField>
        ) : null}

        {venues.length > 0 ? (
          <CrmField htmlFor={venueId} label="Polyclinic or centre">
            <CrmSelect
              disabled={locked}
              id={venueId}
              onChange={(event) => onChange({ ...filter, venue: event.target.value || null })}
              value={filter.venue ?? ""}
            >
              <option value="">Every polyclinic and centre</option>
              {venues.map((venue) => (
                <option key={venue.value} value={venue.value}>
                  {venue.label}
                </option>
              ))}
            </CrmSelect>
          </CrmField>
        ) : null}

        {specialities.length > 0 ? (
          <CrmField htmlFor={specialityId} label="Speciality">
            <CrmSelect
              disabled={locked}
              id={specialityId}
              onChange={(event) => onChange({ ...filter, speciality: event.target.value || null })}
              value={filter.speciality ?? ""}
            >
              <option value="">Every speciality</option>
              {specialities.map((speciality) => (
                <option key={speciality} value={speciality}>
                  {speciality}
                </option>
              ))}
            </CrmSelect>
          </CrmField>
        ) : null}
      </div>

      {dayChosen || !showWeekday ? (
        <div className="grid min-w-0 grid-cols-2 gap-3 sm:max-w-md">
          <CrmField hint="Optional" htmlFor={fromId} label="From">
            <input
              className={cn(crmInputClassName, "appearance-none")}
              disabled={locked}
              id={fromId}
              onChange={(event) => onChange({ ...filter, fromMinute: timeToMinutes(event.target.value) })}
              type="time"
              value={minutesToTime(filter.fromMinute)}
            />
          </CrmField>
          <CrmField hint="Optional" htmlFor={toId} label="To">
            <input
              className={cn(crmInputClassName, "appearance-none")}
              disabled={locked}
              id={toId}
              onChange={(event) => onChange({ ...filter, toMinute: timeToMinutes(event.target.value) })}
              type="time"
              value={minutesToTime(filter.toMinute)}
            />
          </CrmField>
        </div>
      ) : null}
    </div>
  );
}
