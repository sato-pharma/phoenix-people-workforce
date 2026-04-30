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
    return "border-success/30 bg-success/10 text-success";
  }

  if (eventType === "birthday") {
    return "border-border bg-bg-muted text-text";
  }

  return "border-warning/30 bg-orange-50 text-warning dark:bg-orange-950/20";
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
        className="h-10 w-full rounded-lg border border-border bg-card px-3 text-sm text-text transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
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
    <Card>
      <div className="flex items-start gap-4">
        <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
          {icon}
        </div>
        <div>
          <p className="text-sm text-text-secondary">{label}</p>
          <p className="mt-1 text-2xl font-semibold tracking-tight text-text">
            {value}
          </p>
          <p className="mt-0.5 text-xs text-text-secondary">{description}</p>
        </div>
      </div>
    </Card>
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

  if (initialError) {
    return (
      <div className="space-y-6">
        <div>
          <p className="text-sm font-medium uppercase tracking-[0.18em] text-primary">
            People Operations
          </p>
          <h1 className="mt-2 text-2xl font-bold text-text">HR Calendar</h1>
          <p className="mt-1 text-text-secondary">
            Track anniversaries, new hires, and birthdays.
          </p>
        </div>
        <Card className="border-danger/20 bg-red-50 dark:bg-red-950/20">
          <div className="flex items-center gap-3">
            <CalendarDays className="h-5 w-5 text-danger" />
            <p className="text-sm text-danger">{initialError}</p>
          </div>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <p className="text-sm font-medium uppercase tracking-[0.18em] text-primary">
            People Operations
          </p>
          <h1 className="mt-2 text-2xl font-bold text-text">HR Calendar</h1>
          <p className="mt-1 text-text-secondary">
            Anniversaries, birthdays, and new hires in a monthly calendar.
          </p>
        </div>
        <Badge variant="neutral">
          {selectedMonthLabel} {selectedYear}
        </Badge>
      </div>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
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

      <Card>
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-7">
          <select
            className="h-10 rounded-lg border border-border bg-card px-3 text-sm text-text transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
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
            className="h-10 rounded-lg border border-border bg-card px-3 text-sm text-text transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
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
              className="pl-9"
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search name, HR ID, manager"
              value={query}
            />
          </div>

          <select
            className="h-10 rounded-lg border border-border bg-card px-3 text-sm text-text transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
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
            variant="secondary"
            onClick={() => {
              setAreaFilter(allValue);
              setEventTypeFilter("all");
              setLineFilter(allValue);
              setQuery("");
              setSelectedMonth(today.getMonth() + 1);
              setSelectedYear(today.getFullYear());
            }}
          >
            <RefreshCw className="mr-2 h-4 w-4" />
            Reset
          </Button>
        </div>
      </Card>

      <Card className="overflow-hidden p-0">
        <div className="border-b border-border px-5 py-4">
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
            <div className="grid grid-cols-7 border-b border-border bg-bg-muted">
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
                      "min-h-36 border-b border-r border-border bg-card p-2",
                      !date && "bg-bg-soft",
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
                            <div className="rounded-lg border border-border bg-bg-muted px-2 py-1 text-xs font-medium text-text-secondary">
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
      </Card>

      <Card>
        <div className="mb-4">
          <h2 className="text-base font-semibold text-text">
            Event Details ({filteredEvents.length})
          </h2>
          <p className="mt-1 text-sm text-text-secondary">
            Compact list for review and filtering.
          </p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[1040px] text-left text-sm">
            <thead>
              <tr className="border-b border-border">
                {["Date", "Event", "Employee", "HR ID", "Job Title", "Line", "Area", "Manager"].map(
                  (column) => (
                    <th
                      className="pb-3 pr-4 font-medium text-text-secondary"
                      key={column}
                    >
                      {column}
                    </th>
                  ),
                )}
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {filteredEvents.length === 0 ? (
                <tr>
                  <td className="py-10 text-center" colSpan={8}>
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
                    className="transition-colors hover:bg-bg-muted"
                    key={`${event.eventType}-${event.employee.hrId}-${event.date}-row`}
                  >
                    <td className="whitespace-nowrap py-3 pr-4 font-medium text-text">
                      {formatDate(event.date)}
                    </td>
                    <td className="py-3 pr-4">
                      <Badge variant={eventBadgeVariant(event.eventType)}>
                        {eventLabel(event)}
                      </Badge>
                    </td>
                    <td className="py-3 pr-4">
                      <div>
                        <p className="font-semibold text-text">
                          {event.employee.fullName}
                        </p>
                        <p className="mt-0.5 text-xs text-text-secondary">
                          {event.employee.workEmail ?? "No work email"}
                        </p>
                      </div>
                    </td>
                    <td className="whitespace-nowrap py-3 pr-4 font-mono text-xs text-text-secondary">
                      {event.employee.hrId}
                    </td>
                    <td className="py-3 pr-4 text-text-secondary">
                      {event.employee.jobTitle}
                    </td>
                    <td className="py-3 pr-4 text-text-secondary">
                      {event.employee.lineName}
                    </td>
                    <td className="py-3 pr-4 text-text-secondary">
                      {event.employee.areaName}
                    </td>
                    <td className="py-3 pr-4 text-text-secondary">
                      {event.employee.managerName}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
