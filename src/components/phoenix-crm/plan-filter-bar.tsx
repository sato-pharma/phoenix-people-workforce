"use client";

/**
 * Phoenix CRM — the customer filter on the plan board, owner 2026-09-25 and 2026-09-29.
 *
 * While the rep ticks a day he narrows its customers by the weekday they receive on (from their
 * validated days and hours), by brick, by AM / PM, by grade and by speciality, and finds one by name.
 * The narrowings are independent (plan-filters.ts). This bar only holds the controls and reports the
 * change; the filtering itself is filterPlannerCustomers, so one test covers the logic.
 *
 * The time window reads only with a weekday chosen — "between 2 and 4" means nothing without a day. The
 * bar wraps to one column on a phone and never scrolls sideways; a native select opens the phone picker.
 */

import { CrmButton, CrmChoice, CrmField, CrmSearchField, CrmSelect, crmInputClassName } from "@/components/phoenix-crm/ui";
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

export function PlanFilterBar({
  bricks,
  filter,
  grades = [],
  idPrefix,
  locked = false,
  onChange,
  onQueryChange,
  query = "",
  /** A screen that fixes the weekday hides its control and the day part of the label. */
  showWeekday = true,
  specialities = [],
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
  showWeekday?: boolean;
  /** Specialities present on the list, for the speciality picker; empty hides it. */
  specialities?: ReadonlyArray<string>;
}) {
  const brickId = `${idPrefix}-filter-brick`;
  const specialityId = `${idPrefix}-filter-speciality`;
  const searchId = `${idPrefix}-filter-search`;
  const fromId = `${idPrefix}-filter-from`;
  const toId = `${idPrefix}-filter-to`;
  const active = doctorFilterActive(filter) || query.trim() !== "";
  const dayChosen = filter.weekday !== null;

  return (
    <div className="grid min-w-0 gap-3 border border-slate-200 bg-slate-50 px-3.5 py-3">
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
        <p className="text-phx-2xs font-black uppercase tracking-[0.16em] text-slate-500">Filter the customers</p>
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

      {showWeekday ? (
        <CrmField label="Receives on">
          <CrmChoice
            columns={4}
            label="Receives on"
            onChange={(next) => onChange({ ...filter, weekday: next === "any" ? null : Number(next), fromMinute: null, toMinute: null })}
            options={[
              { value: "any", label: "Any day", disabled: locked },
              ...PHOENIX_CRM_WEEKDAY_ORDER.filter((weekday) => weekday !== 5).map((weekday) => ({
                value: String(weekday),
                label: PHOENIX_CRM_WEEKDAY_NAMES[weekday],
                disabled: locked,
              })),
            ]}
            value={filter.weekday === null ? "any" : String(filter.weekday)}
          />
        </CrmField>
      ) : null}

      {dayChosen || !showWeekday ? (
        <div className="grid min-w-0 grid-cols-2 gap-3 sm:max-w-md">
          <CrmField hint="Optional" htmlFor={fromId} label="From">
            <input
              className={crmInputClassName}
              disabled={locked}
              id={fromId}
              onChange={(event) => onChange({ ...filter, fromMinute: timeToMinutes(event.target.value) })}
              type="time"
              value={minutesToTime(filter.fromMinute)}
            />
          </CrmField>
          <CrmField hint="Optional" htmlFor={toId} label="To">
            <input
              className={crmInputClassName}
              disabled={locked}
              id={toId}
              onChange={(event) => onChange({ ...filter, toMinute: timeToMinutes(event.target.value) })}
              type="time"
              value={minutesToTime(filter.toMinute)}
            />
          </CrmField>
        </div>
      ) : null}

      <CrmField label="AM or PM">
        <CrmChoice
          columns={3}
          label="AM or PM"
          onChange={(session) => onChange({ ...filter, session })}
          options={SESSION_OPTIONS.map((option) => ({ ...option, disabled: locked }))}
          value={filter.session}
        />
      </CrmField>

      {grades.length > 0 ? (
        <CrmField label="Grade">
          <CrmChoice
            columns={4}
            label="Grade"
            onChange={(next) => onChange({ ...filter, grade: next === "any" ? null : next })}
            options={[
              { value: "any" as const, label: "Any grade", disabled: locked },
              ...grades.map((grade) => ({ value: grade, label: `Grade ${grade}`, disabled: locked })),
            ]}
            value={filter.grade ?? "any"}
          />
        </CrmField>
      ) : null}

      <div className={cn("grid min-w-0 gap-3", bricks.length > 0 && specialities.length > 0 ? "sm:grid-cols-2" : undefined)}>
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
    </div>
  );
}
