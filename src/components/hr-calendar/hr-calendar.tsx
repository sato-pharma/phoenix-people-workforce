"use client";

import {
  Baby,
  CalendarDays,
  Cake,
  RefreshCw,
  Search,
  UserPlus,
} from "lucide-react";
import type { ReactNode } from "react";
import { useMemo, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import type { HrCalendarEmployee } from "@/lib/hr-calendar/types";
import { cn } from "@/lib/utils";

type Props = {
  initialData: HrCalendarEmployee[] | null;
  initialError: string | null;
};

type CalendarEventType = "anniversary" | "birthday" | "new_hire";

type CalendarEvent = {
  date: string;
  employee: HrCalendarEmployee;
  eventType: CalendarEventType;
  tenureYears: number;
};

const allValue = "__all__";
const weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const months = [
  { label: "January", value: 1 },
  { label: "February", value: 2 },
  { label: "March", value: 3 },
  { label: "April", value: 4 },
  { label: "May", value: 5 },
  { label: "June", value: 6 },
  { label: "July", value: 7 },
  { label: "August", value: 8 },
  { label: "September", value: 9 },
  { label: "October", value: 10 },
  { label: "November", value: 11 },
  { label: "December", value: 12 },
];

function parseDate(value: string | null) {
  if (!value) {
    return null;
  }

  const date = new Date(`${value}T00:00:00`);

  return Number.isNaN(date.getTime()) ? null : date;
}

function toDateInputValue(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");

  return `${year}-${month}-${day}`;
}

function monthDayDate(sourceDate: Date, selectedYear: number) {
  return new Date(selectedYear, sourceDate.getMonth(), sourceDate.getDate());
}

function formatDate(value: string) {
  const date = parseDate(value);

  if (!date) {
    return value;
  }

  return new Intl.DateTimeFormat("en", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  }).format(date);
}

function dayOfMonth(value: string) {
  return parseDate(value)?.getDate() ?? 0;
}

function uniqueOptions(values: string[]) {
  return Array.from(new Set(values.filter(Boolean))).sort((a, b) =>
    a.localeCompare(b),
  );
}

function buildEvents(
  employees: HrCalendarEmployee[],
  selectedMonth: number,
  selectedYear: number,
) {
  const events: CalendarEvent[] = [];

  for (const employee of employees) {
    const hireDate = parseDate(employee.hireDate);
    const birthDate = parseDate(employee.birthDate);

    if (hireDate && hireDate.getMonth() + 1 === selectedMonth) {
      const hireYear = hireDate.getFullYear();

      if (hireYear === selectedYear) {
        events.push({
          date: employee.hireDate,
          employee,
          eventType: "new_hire",
          tenureYears: 0,
        });
      }

      if (hireYear < selectedYear) {
        events.push({
          date: toDateInputValue(monthDayDate(hireDate, selectedYear)),
          employee,
          eventType: "anniversary",
          tenureYears: selectedYear - hireYear,
        });
      }
    }

    if (birthDate && birthDate.getMonth() + 1 === selectedMonth) {
      events.push({
        date: toDateInputValue(monthDayDate(birthDate, selectedYear)),
        employee,
        eventType: "birthday",
        tenureYears: 0,
      });
    }
  }

  return events.sort((left, right) => {
    const dayDiff = dayOfMonth(left.date) - dayOfMonth(right.date);

    if (dayDiff !== 0) {
      return dayDiff;
    }

    return left.employee.fullName.localeCompare(right.employee.fullName);
  });
}

function buildCalendarDays(selectedMonth: number, selectedYear: number) {
  const firstDay = new Date(selectedYear, selectedMonth - 1, 1);
  const daysInMonth = new Date(selectedYear, selectedMonth, 0).getDate();
  const leadingEmptyDays = firstDay.getDay();
  const cells: Array<Date | null> = [];

  for (let index = 0; index < leadingEmptyDays; index += 1) {
    cells.push(null);
  }

  for (let day = 1; day <= daysInMonth; day += 1) {
    cells.push(new Date(selectedYear, selectedMonth - 1, day));
  }

  while (cells.length % 7 !== 0) {
    cells.push(null);
  }

  return cells;
}

function eventLabel(event: CalendarEvent) {
  if (event.eventType === "new_hire") {
    return "New hire";
  }

  if (event.eventType === "birthday") {
    return "Birthday";
  }

  return `${event.tenureYears} year anniversary`;
}

function eventClass(eventType: CalendarEventType) {
  if (eventType === "new_hire") {
    return "border-emerald-200 bg-emerald-50 text-emerald-800";
  }

  if (eventType === "birthday") {
    return "border-slate-200 bg-slate-50 text-slate-900";
  }

  return "border-orange-200 bg-orange-50 text-orange-800";
}

function eventBadgeVariant(eventType: CalendarEventType) {
  if (eventType === "new_hire") {
    return "success" as const;
  }

  if (eventType === "birthday") {
    return "neutral" as const;
  }

  return "warning" as const;
}

function SelectFilter({
  label,
  onChange,
  options,
  value,
}: {
  label: string;
  onChange: (value: string) => void;
  options: string[];
  value: string;
}) {
  return (
    <label className="block">
      <span className="sr-only">{label}</span>
      <select
        className="h-10 w-full rounded-lg border border-border bg-white px-3 text-sm text-text transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
        onChange={(event) => onChange(event.target.value)}
        value={value}
      >
        <option value={allValue}>{label}</option>
        {options.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    </label>
  );
}

function SummaryCard({
  description,
  icon,
  label,
  value,
}: {
  description: string;
  icon: ReactNode;
  label: string;
  value: number;
}) {
  return (
    <div className="rounded-xl border border-slate-200 bg-slate-50 p-4 text-slate-900">
      <div className="flex items-start gap-4">
        <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-white/70 text-primary">
          {icon}
        </div>
        <div>
          <p className="text-[10px] font-bold uppercase tracking-[0.16em] opacity-70">{label}</p>
          <p className="mt-2 font-mono text-2xl font-bold tracking-tight">
            {value}
          </p>
          <p className="mt-1 text-xs opacity-70">{description}</p>
        </div>
      </div>
    </div>
  );
}

export function HrCalendar({ initialData, initialError }: Props) {
  const today = new Date();
  const [areaFilter, setAreaFilter] = useState(allValue);
  const [eventTypeFilter, setEventTypeFilter] = useState<CalendarEventType | "all">(
    "all",
  );
  const [lineFilter, setLineFilter] = useState(allValue);
  const [query, setQuery] = useState("");
  const [selectedMonth, setSelectedMonth] = useState(today.getMonth() + 1);
  const [selectedYear, setSelectedYear] = useState(today.getFullYear());
  const rows = useMemo(() => initialData ?? [], [initialData]);

  const allEvents = useMemo(
    () => buildEvents(rows, selectedMonth, selectedYear),
    [rows, selectedMonth, selectedYear],
  );

  const filterOptions = useMemo(
    () => ({
      areas: uniqueOptions(rows.map((row) => row.areaName)),
      lines: uniqueOptions(rows.map((row) => row.lineName)),
    }),
    [rows],
  );

  const filteredEvents = useMemo(() => {
    const search = query.trim().toLowerCase();

    return allEvents.filter((event) => {
      const searchable = [
        event.employee.fullName,
        event.employee.hrId,
        event.employee.jobTitle,
        event.employee.managerName,
      ]
        .join(" ")
        .toLowerCase();

      return (
        (!search || searchable.includes(search)) &&
        (eventTypeFilter === "all" || event.eventType === eventTypeFilter) &&
        (lineFilter === allValue || event.employee.lineName === lineFilter) &&
        (areaFilter === allValue || event.employee.areaName === areaFilter)
      );
    });
  }, [allEvents, areaFilter, eventTypeFilter, lineFilter, query]);

  const eventsByDay = useMemo(() => {
    const map = new Map<number, CalendarEvent[]>();

    for (const event of filteredEvents) {
      const day = dayOfMonth(event.date);

      map.set(day, [...(map.get(day) ?? []), event]);
    }

    return map;
  }, [filteredEvents]);

  const calendarCells = useMemo(
    () => buildCalendarDays(selectedMonth, selectedYear),
    [selectedMonth, selectedYear],
  );
  const selectedMonthLabel =
    months.find((month) => month.value === selectedMonth)?.label ?? "Month";
  const newHireCount = filteredEvents.filter(
    (event) => event.eventType === "new_hire",
  ).length;
  const anniversaryCount = filteredEvents.filter(
    (event) => event.eventType === "anniversary",
  ).length;
  const birthdayCount = filteredEvents.filter(
    (event) => event.eventType === "birthday",
  ).length;
  const hasActiveFilters =
    areaFilter !== allValue ||
    eventTypeFilter !== "all" ||
    lineFilter !== allValue ||
    query.trim() ||
    selectedMonth !== today.getMonth() + 1 ||
    selectedYear !== today.getFullYear();
  const activeFilterCount = [
    areaFilter !== allValue ? areaFilter : "",
    eventTypeFilter !== "all" ? eventTypeFilter : "",
    lineFilter !== allValue ? lineFilter : "",
    query.trim(),
    selectedMonth !== today.getMonth() + 1 ? String(selectedMonth) : "",
    selectedYear !== today.getFullYear() ? String(selectedYear) : "",
  ].filter(Boolean).length;

  function resetFilters() {
    setAreaFilter(allValue);
    setEventTypeFilter("all");
    setLineFilter(allValue);
    setQuery("");
    setSelectedMonth(today.getMonth() + 1);
    setSelectedYear(today.getFullYear());
  }

  if (initialError) {
    return (
      <Card className="overflow-hidden border-slate-200 bg-white p-0 shadow-[0_20px_50px_rgba(15,23,42,0.06)]">
        <div className="border-b border-slate-200 bg-slate-950 px-5 py-5 text-white">
          <p className="text-[10px] font-bold uppercase tracking-[0.22em] text-orange-300">
            People Operations
          </p>
          <h1 className="mt-2 text-2xl font-bold">HR Calendar</h1>
          <p className="mt-1 text-sm text-slate-300">
            Track anniversaries, new hires, and birthdays.
          </p>
        </div>
        <div className="p-5">
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3">
          <div className="flex items-center gap-3">
            <CalendarDays className="h-5 w-5 text-danger" />
            <p className="text-sm text-danger">{initialError}</p>
          </div>
        </div>
        </div>
      </Card>
    );
  }

  return (
    <Card className="overflow-hidden border-slate-200 bg-white p-0 shadow-[0_20px_50px_rgba(15,23,42,0.06)]">
      <div className="border-b border-slate-200 bg-slate-950 px-5 py-5 text-white">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-[10px] font-bold uppercase tracking-[0.22em] text-orange-300">
              People Operations
            </p>
            <h1 className="mt-2 text-2xl font-bold">HR Calendar</h1>
            <p className="mt-1 max-w-2xl text-sm text-slate-300">
              Anniversaries, birthdays, and new hires in a monthly calendar.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="neutral">
              {selectedMonthLabel} {selectedYear}
            </Badge>
            <Button
              className="border-white/15 bg-white/10 px-3 py-2 text-xs text-white hover:bg-white/15"
              disabled={!hasActiveFilters}
              onClick={resetFilters}
              variant="secondary"
            >
              <RefreshCw className="mr-2 h-3.5 w-3.5" />
              Reset
            </Button>
          </div>
        </div>
      </div>

      <div className="space-y-4 p-5">
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <SummaryCard
          description="Calendar items in scope"
          icon={<CalendarDays className="h-5 w-5" />}
          label="Total Events"
          value={filteredEvents.length}
        />
        <SummaryCard
          description="First month on the team"
          icon={<UserPlus className="h-5 w-5" />}
          label="New Hires"
          value={newHireCount}
        />
        <SummaryCard
          description="Annual work milestones"
          icon={<Cake className="h-5 w-5" />}
          label="Anniversaries"
          value={anniversaryCount}
        />
        <SummaryCard
          description="Birth dates in scope"
          icon={<Baby className="h-5 w-5" />}
          label="Birthdays"
          value={birthdayCount}
        />
      </div>

      <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-7">
          <select
            className="h-10 rounded-lg border border-border bg-white px-3 text-sm text-text transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
            onChange={(event) => setSelectedMonth(Number(event.target.value))}
            value={selectedMonth}
          >
            {months.map((month) => (
              <option key={month.value} value={month.value}>
                {month.label}
              </option>
            ))}
          </select>

          <select
            className="h-10 rounded-lg border border-border bg-white px-3 text-sm text-text transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
            onChange={(event) => setSelectedYear(Number(event.target.value))}
            value={selectedYear}
          >
            {Array.from(
              { length: 7 },
              (_, index) => today.getFullYear() - 3 + index,
            ).map((year) => (
              <option key={year} value={year}>
                {year}
              </option>
            ))}
          </select>

          <div className="relative md:col-span-2">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-secondary" />
            <Input
              className="bg-white pl-9"
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search name, HR ID, manager"
              value={query}
            />
          </div>

          <select
            className="h-10 rounded-lg border border-border bg-white px-3 text-sm text-text transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
            onChange={(event) =>
              setEventTypeFilter(event.target.value as CalendarEventType | "all")
            }
            value={eventTypeFilter}
          >
            <option value="all">All events</option>
            <option value="new_hire">New hires</option>
            <option value="anniversary">Anniversaries</option>
            <option value="birthday">Birthdays</option>
          </select>

          <SelectFilter
            label="All lines"
            onChange={setLineFilter}
            options={filterOptions.lines}
            value={lineFilter}
          />
          <SelectFilter
            label="All areas"
            onChange={setAreaFilter}
            options={filterOptions.areas}
            value={areaFilter}
          />
        </div>
        <div className="mt-4 flex justify-end">
          <Button
            disabled={!hasActiveFilters}
            variant="secondary"
            onClick={resetFilters}
          >
            <RefreshCw className="mr-2 h-4 w-4" />
            Reset {activeFilterCount > 0 ? `(${activeFilterCount})` : ""}
          </Button>
        </div>
      </div>

      <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
        <div className="border-b border-slate-200 bg-slate-50 px-5 py-4">
          <h2 className="text-base font-semibold text-text">
            {selectedMonthLabel} {selectedYear}
          </h2>
          <p className="mt-1 text-sm text-text-secondary">
            Events are grouped by calendar day. Birthdays appear only when
            birth_date exists in employee master data.
          </p>
        </div>

        <div className="overflow-x-auto">
          <div className="min-w-[1120px]">
            <div className="grid grid-cols-7 border-b border-slate-200 bg-slate-100">
              {weekdays.map((weekday) => (
                <div
                  className="px-3 py-2 text-xs font-semibold uppercase tracking-[0.14em] text-text-secondary"
                  key={weekday}
                >
                  {weekday}
                </div>
              ))}
            </div>
            <div className="grid grid-cols-7">
              {calendarCells.map((date, index) => {
                const day = date?.getDate() ?? null;
                const dayEvents = day ? eventsByDay.get(day) ?? [] : [];
                const isToday =
                  date &&
                  date.getFullYear() === today.getFullYear() &&
                  date.getMonth() === today.getMonth() &&
                  date.getDate() === today.getDate();

                return (
                  <div
                    className={cn(
                      "min-h-36 border-b border-r border-slate-200 bg-white p-2",
                      !date && "bg-slate-50",
                    )}
                    key={`${index}-${day ?? "empty"}`}
                  >
                    {day ? (
                      <>
                        <div
                          className={cn(
                            "mb-2 flex h-6 w-6 items-center justify-center rounded-full text-sm font-semibold text-text",
                            isToday && "bg-primary text-white",
                          )}
                        >
                          {day}
                        </div>
                        <div className="space-y-1.5">
                          {dayEvents.slice(0, 4).map((event) => (
                            <div
                              className={cn(
                                "rounded-lg border px-2 py-1.5 text-xs",
                                eventClass(event.eventType),
                              )}
                              key={`${event.eventType}-${event.employee.hrId}-${event.date}`}
                              title={`${event.employee.fullName} - ${eventLabel(event)}`}
                            >
                              <p className="truncate font-semibold">
                                {event.employee.fullName}
                              </p>
                              <p className="truncate text-[11px] font-medium opacity-80">
                                {eventLabel(event)}
                              </p>
                            </div>
                          ))}
                          {dayEvents.length > 4 ? (
                            <div className="rounded-lg border border-slate-200 bg-slate-50 px-2 py-1 text-xs font-medium text-text-secondary">
                              +{dayEvents.length - 4} more
                            </div>
                          ) : null}
                        </div>
                      </>
                    ) : null}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>

      <div className="rounded-xl border border-slate-200 bg-white">
        <div className="border-b border-slate-200 bg-slate-50 px-4 py-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-base font-semibold text-text">
                Event Details ({filteredEvents.length})
              </h2>
              <p className="mt-1 text-sm text-text-secondary">
                Compact list for review and filtering.
              </p>
            </div>
            <Badge variant="neutral">{filteredEvents.length} visible</Badge>
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[1040px] text-left text-sm">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-100 text-xs uppercase tracking-[0.12em] text-text-secondary">
                {["Date", "Event", "Employee", "HR ID", "Job Title", "Line", "Area", "Manager"].map(
                  (column) => (
                    <th
                      className="px-4 py-3 font-semibold"
                      key={column}
                    >
                      {column}
                    </th>
                  ),
                )}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {filteredEvents.length === 0 ? (
                <tr>
                  <td className="px-4 py-10 text-center" colSpan={8}>
                    <p className="text-sm font-semibold text-text">
                      No HR calendar events found.
                    </p>
                    <p className="mt-2 text-sm text-text-secondary">
                      Try another month, year, line, area, or event type.
                    </p>
                  </td>
                </tr>
              ) : (
                filteredEvents.map((event) => (
                  <tr
                    className="transition-colors hover:bg-slate-50"
                    key={`${event.eventType}-${event.employee.hrId}-${event.date}-row`}
                  >
                    <td className="whitespace-nowrap px-4 py-3 font-medium text-text">
                      {formatDate(event.date)}
                    </td>
                    <td className="px-4 py-3">
                      <Badge variant={eventBadgeVariant(event.eventType)}>
                        {eventLabel(event)}
                      </Badge>
                    </td>
                    <td className="px-4 py-3">
                      <div>
                        <p className="font-semibold text-text">
                          {event.employee.fullName}
                        </p>
                        <p className="mt-0.5 text-xs text-text-secondary">
                          {event.employee.workEmail ?? "No work email"}
                        </p>
                      </div>
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 font-mono text-xs text-text-secondary">
                      {event.employee.hrId}
                    </td>
                    <td className="px-4 py-3 text-text-secondary">
                      {event.employee.jobTitle}
                    </td>
                    <td className="px-4 py-3 text-text-secondary">
                      {event.employee.lineName}
                    </td>
                    <td className="px-4 py-3 text-text-secondary">
                      {event.employee.areaName}
                    </td>
                    <td className="px-4 py-3 text-text-secondary">
                      {event.employee.managerName}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
      </div>
    </Card>
  );
}
