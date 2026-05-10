"use client";

import {
  Baby,
  CalendarDays,
  Cake,
  RefreshCw,
  Search,
  UserPlus,
} from "lucide-react";
import { useMemo, useState } from "react";

import {
  AdminCallout,
  AdminInsightChip,
  AdminPageHero,
  AdminSectionHeader,
  AdminStatCard,
  AdminTableShell,
} from "@/components/admin/admin-design-system";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import type { HrCalendarEmployee } from "@/lib/hr-calendar/types";
import { cn } from "@/lib/utils";
import type { ReactNode } from "react";

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
const selectClassName =
  "h-11 w-full rounded-2xl border border-[#D8E0EA] bg-white/95 px-3 text-sm font-semibold text-[#0F172A] shadow-[0_14px_35px_rgba(15,23,42,0.06)] outline-none transition focus:border-[#FDBA74] focus:ring-2 focus:ring-[#F97316]/15";
const panelClassName =
  "rounded-[28px] border border-white/75 bg-white/94 shadow-[0_28px_90px_rgba(15,23,42,0.12)] ring-1 ring-slate-900/5";
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

function HrCalendarPageShell({ children }: { children: ReactNode }) {
  return (
    <div className="relative overflow-hidden rounded-[34px] border border-[#FED7AA]/80 bg-[radial-gradient(circle_at_10%_0%,rgba(249,115,22,0.13),transparent_34%),linear-gradient(135deg,#FFF7ED_0%,#F8FAFC_44%,#FFFFFF_100%)] p-4 shadow-[0_30px_110px_rgba(15,23,42,0.11)] sm:p-5">
      <div className="pointer-events-none absolute inset-x-10 top-0 h-px bg-gradient-to-r from-transparent via-[#F97316]/45 to-transparent" />
      <div className="relative space-y-6">{children}</div>
    </div>
  );
}

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
    return "border-[#A7F3D0] bg-[#ECFDF5] text-[#065F46]";
  }

  if (eventType === "birthday") {
    return "border-[#CBD5E1] bg-[#F8FAFC] text-[#334155]";
  }

  return "border-[#FED7AA] bg-[#FFF7ED] text-[#C2410C]";
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

function eventDayLabel(eventType: CalendarEventType) {
  if (eventType === "new_hire") {
    return "New hire";
  }

  if (eventType === "birthday") {
    return "Birthday";
  }

  return "Anniversary";
}

export function HrCalendar({ initialData, initialError }: Props) {
  const today = new Date();
  const currentMonth = today.getMonth() + 1;
  const currentYear = today.getFullYear();

  const [areaFilter, setAreaFilter] = useState(allValue);
  const [eventTypeFilter, setEventTypeFilter] = useState<
    CalendarEventType | "all"
  >("all");
  const [lineFilter, setLineFilter] = useState(allValue);
  const [query, setQuery] = useState("");
  const [selectedMonth, setSelectedMonth] = useState(currentMonth);
  const [selectedYear, setSelectedYear] = useState(currentYear);
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
    selectedMonth !== currentMonth ||
    selectedYear !== currentYear;
  const activeFilterCount = [
    areaFilter !== allValue ? areaFilter : "",
    eventTypeFilter !== "all" ? eventTypeFilter : "",
    lineFilter !== allValue ? lineFilter : "",
    query.trim(),
    selectedMonth !== currentMonth ? String(selectedMonth) : "",
    selectedYear !== currentYear ? String(selectedYear) : "",
  ].filter(Boolean).length;

  function resetFilters() {
    setAreaFilter(allValue);
    setEventTypeFilter("all");
    setLineFilter(allValue);
    setQuery("");
    setSelectedMonth(currentMonth);
    setSelectedYear(currentYear);
  }

  if (initialError) {
    return (
      <Card className={`${panelClassName} overflow-hidden p-0`}>
        <AdminPageHero
          badges={
            <div className="flex flex-wrap gap-2">
              <AdminInsightChip>HR Calendar</AdminInsightChip>
            </div>
          }
          description="Track anniversaries, new hires, and birthdays."
          eyebrow="People Operations"
          icon={<CalendarDays className="h-3.5 w-3.5" />}
          title="HR Calendar"
        />
        <div className="p-5">
          <AdminCallout tone="danger">
            <CalendarDays className="mt-0.5 h-4 w-4 text-danger" />
            <div>
              <h2 className="text-sm font-semibold text-[#991B1B]">
                HR Calendar data unavailable
              </h2>
              <p className="mt-1 text-sm text-[#991B1B]">{initialError}</p>
            </div>
          </AdminCallout>
        </div>
      </Card>
    );
  }

  return (
    <HrCalendarPageShell>
      <AdminPageHero
        actions={
          <Button
            className="h-11 gap-2 rounded-2xl"
            disabled={!hasActiveFilters}
            onClick={resetFilters}
            variant="secondary"
          >
            <RefreshCw className="h-4 w-4" />
            Reset {activeFilterCount > 0 ? `(${activeFilterCount})` : ""}
          </Button>
        }
        badges={
          <div className="flex flex-wrap gap-2">
            <AdminInsightChip>{allEvents.length} events</AdminInsightChip>
            <AdminInsightChip tone="orange">
              {selectedMonthLabel} {selectedYear}
            </AdminInsightChip>
            <AdminInsightChip tone="slate">
              {filteredEvents.length} in scope
            </AdminInsightChip>
          </div>
        }
        description="Anniversaries, birthdays, and new hires in a monthly calendar."
        eyebrow="People Operations"
        icon={<CalendarDays className="h-3.5 w-3.5" />}
        title="HR Calendar"
      />

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <AdminStatCard
          description="Calendar items in scope"
          icon={<CalendarDays className="h-5 w-5" />}
          label="Total Events"
          value={filteredEvents.length}
        />
        <AdminStatCard
          description="First month on the team"
          icon={<UserPlus className="h-5 w-5" />}
          label="New Hires"
          value={newHireCount}
        />
        <AdminStatCard
          description="Annual work milestones"
          icon={<Cake className="h-5 w-5" />}
          label="Anniversaries"
          value={anniversaryCount}
        />
        <AdminStatCard
          description="Birth dates in scope"
          icon={<Baby className="h-5 w-5" />}
          label="Birthdays"
          value={birthdayCount}
        />
      </div>

      <AdminTableShell
        action={
          <Button
            className="h-11 gap-2 rounded-2xl"
            disabled={!hasActiveFilters}
            onClick={resetFilters}
            variant="secondary"
          >
            <RefreshCw className="h-4 w-4" />
            Reset {activeFilterCount > 0 ? `(${activeFilterCount})` : ""}
          </Button>
        }
        description="Use month, year, keyword, event type, line, and area filters to scope events."
        title="Filters"
      >
        <div className="grid gap-3 p-4 xl:grid-cols-6">
          <label className="block">
            <span className="mb-1.5 block text-[11px] font-black uppercase tracking-[0.14em] text-[#64748B]">Month</span>
            <select
              className={selectClassName}
              onChange={(event) => setSelectedMonth(Number(event.target.value))}
              value={selectedMonth}
            >
              {months.map((month) => (
                <option key={month.value} value={month.value}>
                  {month.label}
                </option>
              ))}
            </select>
          </label>

          <label className="block">
            <span className="mb-1.5 block text-[11px] font-black uppercase tracking-[0.14em] text-[#64748B]">Year</span>
            <select
              className={selectClassName}
              onChange={(event) => setSelectedYear(Number(event.target.value))}
              value={selectedYear}
            >
              {Array.from(
                { length: 7 },
                (_, index) => currentYear - 3 + index,
              ).map((year) => (
                <option key={year} value={year}>
                  {year}
                </option>
              ))}
            </select>
          </label>

          <label className="relative block">
            <span className="sr-only">Search events</span>
            <Search className="pointer-events-none absolute left-3 top-9 h-4 w-4 text-[#64748B]" />
            <Input
              className="h-11 rounded-2xl border-[#D8E0EA] bg-white/95 pl-9 shadow-[0_14px_35px_rgba(15,23,42,0.06)]"
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search name, HR ID, manager"
              value={query}
            />
          </label>

          <label className="block">
            <span className="mb-1.5 block text-[11px] font-black uppercase tracking-[0.14em] text-[#64748B]">Event Type</span>
            <select
              className={selectClassName}
              onChange={(event) =>
                setEventTypeFilter(
                  event.target.value as CalendarEventType | "all",
                )
              }
              value={eventTypeFilter}
            >
              <option value="all">All events</option>
              <option value="new_hire">New hires</option>
              <option value="anniversary">Anniversaries</option>
              <option value="birthday">Birthdays</option>
            </select>
          </label>

          <label className="block">
            <span className="mb-1.5 block text-[11px] font-black uppercase tracking-[0.14em] text-[#64748B]">Line</span>
            <select
              className={selectClassName}
              onChange={(event) => setLineFilter(event.target.value)}
              value={lineFilter}
            >
              <option value={allValue}>All lines</option>
              {filterOptions.lines.map((line) => (
                <option key={line} value={line}>
                  {line}
                </option>
              ))}
            </select>
          </label>

          <label className="block">
            <span className="mb-1.5 block text-[11px] font-black uppercase tracking-[0.14em] text-[#64748B]">Area</span>
            <select
              className={selectClassName}
              onChange={(event) => setAreaFilter(event.target.value)}
              value={areaFilter}
            >
              <option value={allValue}>All areas</option>
              {filterOptions.areas.map((area) => (
                <option key={area} value={area}>
                  {area}
                </option>
              ))}
            </select>
          </label>
        </div>
      </AdminTableShell>

      <Card className={`${panelClassName} overflow-hidden p-0`}>
        <AdminSectionHeader
          title={`${selectedMonthLabel} ${selectedYear}`}
          description="Events are grouped by calendar day. Birthdays are shown only when a birth date exists."
        />
        <div className="overflow-x-auto">
          <div className="min-w-[980px] bg-white/80">
            <div className="grid grid-cols-7 border-b border-[#FED7AA] bg-[#FFF7ED]/80 backdrop-blur">
              {weekdays.map((weekday) => (
                <div
                  className="px-3 py-2 text-[10px] font-black uppercase tracking-[0.14em] text-[#64748B]"
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
                      "min-h-36 border-b border-r border-[#E2E8F0] bg-white/95 p-2 transition-colors hover:bg-[#FFF7ED]/55",
                      !date && "bg-[#F8FAFC]",
                      isToday && "bg-[#FFF7ED]",
                    )}
                    key={`${index}-${day ?? "empty"}`}
                  >
                    {day ? (
                      <>
                        <div
                          className={cn(
                            "mb-2 flex h-6 w-6 items-center justify-center rounded-full text-sm font-semibold text-[#0F172A]",
                            isToday && "bg-[#F97316] text-white",
                          )}
                        >
                          {day}
                        </div>
                        <div className="space-y-1.5">
                          {dayEvents.slice(0, 4).map((event) => (
                            <div
                              className={cn(
                                "rounded-xl border px-2 py-1.5 text-xs shadow-[0_8px_18px_rgba(15,23,42,0.04)]",
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
                            <div className="rounded-xl border border-[#CBD5E1] bg-[#F8FAFC] px-2 py-1 text-xs font-medium text-[#64748B]">
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

      <Card className={`${panelClassName} overflow-hidden p-0`}>
        <AdminSectionHeader
          action={
            <Badge variant="neutral">
              {filteredEvents.length} visible
            </Badge>
          }
          description="Compact list for review and filtering."
          title={`Event Details (${filteredEvents.length})`}
        />
        <div className="overflow-x-auto bg-white/80">
          <table className="w-full min-w-[980px] text-left text-sm">
            <thead>
              <tr className="border-b border-[#FED7AA] bg-[#FFF7ED]/80 text-[10px] font-black uppercase tracking-[0.16em] text-[#64748B]">
                {["Date", "Event", "Employee", "HR ID", "Job Title", "Line", "Area", "Manager"].map((column) => (
                  <th className="px-3 py-3" key={column}>
                    {column}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-[#E2E8F0]">
              {filteredEvents.length === 0 ? (
                <tr>
                  <td className="px-3 py-10 text-center" colSpan={8}>
                    <p className="text-sm font-semibold text-[#0F172A]">
                      No HR calendar events found.
                    </p>
                    <p className="mt-2 text-sm text-[#64748B]">
                      Try another month, year, line, area, or event type.
                    </p>
                  </td>
                </tr>
              ) : (
                filteredEvents.map((event) => (
                  <tr
                    className="transition-colors hover:bg-[#FFF7ED]/55"
                    key={`${event.eventType}-${event.employee.hrId}-${event.date}-row`}
                  >
                    <td className="whitespace-nowrap px-3 py-3 font-medium text-[#0F172A]">
                      {formatDate(event.date)}
                    </td>
                    <td className="px-3 py-3">
                      <Badge variant={eventBadgeVariant(event.eventType)}>
                        {eventDayLabel(event.eventType)}
                      </Badge>
                    </td>
                    <td className="px-3 py-3">
                      <div>
                        <p className="font-semibold text-[#0F172A]">
                          {event.employee.fullName}
                        </p>
                        <p className="mt-0.5 text-xs text-[#64748B]">
                          {event.employee.workEmail ?? "No work email"}
                        </p>
                      </div>
                    </td>
                    <td className="whitespace-nowrap px-3 py-3 font-mono text-xs text-[#64748B]">
                      {event.employee.hrId}
                    </td>
                    <td className="px-3 py-3 text-[#64748B]">
                      {event.employee.jobTitle}
                    </td>
                    <td className="px-3 py-3 text-[#64748B]">
                      {event.employee.lineName}
                    </td>
                    <td className="px-3 py-3 text-[#64748B]">
                      {event.employee.areaName}
                    </td>
                    <td className="px-3 py-3 text-[#64748B]">
                      {event.employee.managerName}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </Card>
    </HrCalendarPageShell>
  );
}
