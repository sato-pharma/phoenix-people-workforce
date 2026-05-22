"use client";

import { AlertCircle, CalendarDays, SendHorizonal } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";

import { AdminCallout, AdminPageHero, adminPanelClassName } from "@/components/admin/admin-design-system";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { PageContainer } from "@/components/layout/page-container";
import { addDaysToDateOnly, parseDateOnly, toDateOnlyString } from "@/lib/date-only";
import {
  calculateVacationDurationDays,
  getAnnualVacationMinimumStartDate,
  getVacationPolicyWarnings,
  getVacationPolicyToday,
  vacationUnpaidReasonLabel,
} from "@/lib/vacation/calculations";
import { formatHrIdForDisplay } from "@/lib/hr-id";
import type {
  VacationBalanceSnapshot,
  VacationDayPart,
  VacationEmployeeSummary,
  VacationType,
  VacationWeeklyOffPolicyRecord,
} from "@/lib/vacation/types";
import { VACATION_DAY_PARTS, VACATION_REQUEST_TYPES } from "@/lib/vacation/types";
import { cn } from "@/lib/utils";

type VacationRequestFormProps = {
  initialData: {
    balance: VacationBalanceSnapshot | null;
    balances?: Partial<Record<VacationType, VacationBalanceSnapshot | null>>;
    dayPartOptions: ReadonlyArray<{ label: string; value: VacationDayPart }>;
    employee: VacationEmployeeSummary;
    manager: VacationEmployeeSummary | null;
    managerOfManager: VacationEmployeeSummary | null;
    vacationTypeOptions: ReadonlyArray<{ label: string; value: VacationType }>;
    weeklyOffPolicy: VacationWeeklyOffPolicyRecord | null;
  } | null;
  initialError: string | null;
  showHero?: boolean;
};

type VacationRequestPageTab = "request" | "policy" | "national";

type NationalHoliday = {
  description: string | null;
  durationDays: number;
  endDate: string | null;
  id: string;
  name: string;
  startDate: string;
};

type NationalHolidayPayload = {
  calendarId: string | null;
  connected: boolean;
  holidays: NationalHoliday[];
  message: string | null;
  month: number;
  sourceLabel: string;
  success: boolean;
  year: number;
};

function VacationBalanceCard({
  balance,
}: {
  balance: VacationBalanceSnapshot | null | undefined;
}) {
  const isFirstSixMonthsLock = balance?.unpaidReason === "first_six_months";
  const headlineLabel = isFirstSixMonthsLock ? "Accrued balance" : "Available balance";
  const headlineValue = balance
    ? formatDays(isFirstSixMonthsLock ? balance.entitlementDays : balance.balanceBeforeDays)
    : "-";
  const description = isFirstSixMonthsLock
    ? "Your accrued balance is tracked from the hire date, but it becomes available for use after completing the first 6 months."
    : balance?.unpaidReason
      ? vacationUnpaidReasonLabel(balance.unpaidReason)
      : "Available based on current approved paid vacations.";

  return (
    <Card className="relative overflow-hidden rounded-[28px] border border-slate-200/90 bg-[linear-gradient(160deg,rgba(255,255,255,0.98),rgba(255,247,237,0.96))] p-6 shadow-[0_18px_42px_rgba(15,23,42,0.07)]">
      <div className="pointer-events-none absolute -right-12 -top-12 h-32 w-32 rounded-full bg-orange-200/30 blur-3xl" />
      <div className="relative flex items-start justify-between gap-4">
        <div className="space-y-3">
          <p className="vacation-summary-kicker text-[11px] font-semibold uppercase text-slate-400">
            {headlineLabel}
          </p>
          <p className="font-display text-[2.35rem] leading-none tracking-[-0.055em] text-slate-950">
            {headlineValue}
          </p>
        </div>
        <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-white/90 text-orange-500 shadow-[0_10px_26px_rgba(249,115,22,0.16)] ring-1 ring-orange-200/80">
          <CalendarDays className="h-5 w-5" />
        </div>
      </div>
      <p className="relative mt-4 max-w-[24ch] text-sm leading-6 text-slate-500">{description}</p>
      {isFirstSixMonthsLock && balance ? (
        <p className="relative mt-3 text-sm font-semibold leading-6 text-amber-700">
          Available now: {formatDays(balance.balanceBeforeDays)}. This accrued balance is not available for use yet.
        </p>
      ) : null}
    </Card>
  );
}

function VacationSummaryPerson({
  hrId,
  label,
  name,
}: {
  hrId: string | null | undefined;
  label: string;
  name: string;
}) {
  return (
    <div className="rounded-[22px] border border-white/80 bg-white/72 px-4 py-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.75)] backdrop-blur-sm">
      <p className="vacation-summary-kicker text-[11px] font-semibold uppercase text-slate-400">
        {label}
      </p>
      <p className="mt-2 text-[15px] font-semibold leading-5 tracking-[-0.02em] text-slate-950">
        {name}
      </p>
      <p className="mt-2 text-[11px] font-medium uppercase tracking-[0.14em] text-slate-500">
        {formatHrIdForDisplay(hrId) ?? "No HR ID"}
      </p>
    </div>
  );
}

function formatDays(days: number) {
  return `${Number(days.toFixed(2))} day${days === 1 ? "" : "s"}`;
}

function durationDisplay(days: number) {
  if (days === 0.5) return "Half day";
  if (days === 1) return "1 day";
  return `${Number(days.toFixed(2))} days`;
}

function dateLabel(value: string) {
  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  }).format(new Date(`${value}T00:00:00Z`));
}

function dateParts(value: string) {
  const parsed = parseDateOnly(value) ?? new Date();
  return {
    month: parsed.getMonth() + 1,
    year: parsed.getFullYear(),
  };
}

function dateOnlyFromParts(year: number, month: number, day: number) {
  return toDateOnlyString(new Date(year, month - 1, day)) ?? "";
}

function daysInMonth(year: number, month: number) {
  return new Date(year, month, 0).getDate();
}

function isFridayDate(value: string) {
  const parsed = parseDateOnly(value);
  return parsed?.getDay() === 5;
}

function isRequestDateSelectable(input: {
  compensatoryEventDate: string;
  date: string;
  dayPart: VacationDayPart;
  endDate: string;
  picker: "start" | "end";
  startDate: string;
  vacationType: VacationType;
}) {
  if (isFridayDate(input.date)) return false;

  const today = todayDateOnly();
  if (input.date < today) return false;

  if (input.picker === "end") {
    if (input.dayPart !== "full_day") return input.date === input.startDate;
    if (input.date < input.startDate) return false;
  }

  if (input.vacationType === "emergency") {
    return input.date === today;
  }

  if (input.vacationType === "annual") {
    return input.date >= getAnnualVacationMinimumStartDate();
  }

  if (input.vacationType === "compensatory" && input.compensatoryEventDate) {
    const expiryDate = addDaysToDateOnly(input.compensatoryEventDate, 14);
    if (input.date < input.compensatoryEventDate) return false;
    if (expiryDate && input.date > expiryDate) return false;
  }

  return true;
}

function VacationDatePicker({
  compensatoryEventDate,
  dayPart,
  disabled = false,
  endDate,
  label,
  onChange,
  picker,
  startDate,
  vacationType,
  value,
}: {
  compensatoryEventDate: string;
  dayPart: VacationDayPart;
  disabled?: boolean;
  endDate: string;
  label: string;
  onChange: (value: string) => void;
  picker: "start" | "end";
  startDate: string;
  vacationType: VacationType;
  value: string;
}) {
  const [open, setOpen] = useState(false);
  const [panelDate, setPanelDate] = useState<{ month: number; year: number } | null>(null);
  const selectedParts = dateParts(value);
  const visibleMonth = panelDate?.month ?? selectedParts.month;
  const visibleYear = panelDate?.year ?? selectedParts.year;

  const monthDays = Array.from({ length: daysInMonth(visibleYear, visibleMonth) }, (_, index) => index + 1);
  const firstDayOffset = new Date(visibleYear, visibleMonth - 1, 1).getDay();
  const yearOptions = Array.from({ length: 8 }, (_, index) => new Date().getFullYear() - 1 + index);

  return (
    <div className="relative space-y-2">
      <span className="text-xs font-black uppercase tracking-[0.16em] text-slate-500">{label}</span>
      <button
        className={cn(
          "flex h-11 w-full items-center justify-between rounded-lg border border-border bg-card px-3 text-left text-sm font-semibold text-text outline-none transition focus:border-orange-300",
          disabled ? "cursor-not-allowed opacity-55" : "hover:border-orange-200",
        )}
        disabled={disabled}
        type="button"
        onClick={() => setOpen((current) => !current)}
      >
        <span>{dateLabel(value)}</span>
        <CalendarDays className="h-4 w-4 text-slate-400" />
      </button>

      {open && !disabled ? (
        <div className="absolute z-30 mt-2 w-full min-w-[320px] rounded-2xl border border-slate-200 bg-white p-3 shadow-[0_24px_58px_rgba(15,23,42,0.18)]">
          <div className="grid grid-cols-2 gap-2">
            <select
              className="h-10 rounded-lg border border-slate-200 bg-white px-2 text-sm font-bold text-slate-800"
              value={visibleMonth}
              onChange={(event) =>
                setPanelDate({
                  month: Number(event.target.value),
                  year: visibleYear,
                })}
            >
              {Array.from({ length: 12 }, (_, index) => index + 1).map((monthValue) => (
                <option key={monthValue} value={monthValue}>
                  {new Intl.DateTimeFormat("en", { month: "long" }).format(new Date(Date.UTC(2026, monthValue - 1, 1)))}
                </option>
              ))}
            </select>
            <select
              className="h-10 rounded-lg border border-slate-200 bg-white px-2 text-sm font-bold text-slate-800"
              value={visibleYear}
              onChange={(event) =>
                setPanelDate({
                  month: visibleMonth,
                  year: Number(event.target.value),
                })}
            >
              {yearOptions.map((yearValue) => (
                <option key={yearValue} value={yearValue}>{yearValue}</option>
              ))}
            </select>
          </div>

          <div className="mt-3 grid grid-cols-7 gap-1 text-center text-[10px] font-black uppercase tracking-[0.08em] text-slate-400">
            {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((day) => (
              <span className={day === "Fri" ? "text-rose-500" : ""} key={day}>{day}</span>
            ))}
          </div>
          <div className="mt-2 grid grid-cols-7 gap-1">
            {Array.from({ length: firstDayOffset }).map((_, index) => (
              <span key={`empty-${index}`} />
            ))}
            {monthDays.map((day) => {
              const date = dateOnlyFromParts(visibleYear, visibleMonth, day);
              const friday = isFridayDate(date);
              const selectable = isRequestDateSelectable({
                compensatoryEventDate,
                date,
                dayPart,
                endDate,
                picker,
                startDate,
                vacationType,
              });
              const selected = date === value;
              return (
                <button
                  className={cn(
                    "h-9 rounded-lg text-sm font-black transition",
                    selected ? "bg-orange-600 text-white shadow-sm" : "",
                    !selected && friday ? "bg-rose-50 text-rose-600" : "",
                    !selected && !friday && selectable ? "bg-white text-slate-800 hover:bg-orange-50" : "",
                    !selected && !selectable && !friday ? "bg-slate-100 text-slate-300" : "",
                    !selectable ? "cursor-not-allowed opacity-80" : "",
                  )}
                  disabled={!selectable}
                  key={date}
                  type="button"
                  onClick={() => {
                    onChange(date);
                    setPanelDate(null);
                    setOpen(false);
                  }}
                >
                  {day}
                </button>
              );
            })}
          </div>
          <p className="mt-3 text-xs font-semibold leading-5 text-slate-500">
            Fridays are marked in red. Grey dates are outside the current vacation policy.
          </p>
        </div>
      ) : null}
    </div>
  );
}

const applicationPolicyItems = [
  {
    example: "Example: if an employee is hired on 1 Feb 2026, the first-year Annual balance accrues at 1.25 days per month. After the first anniversary, the monthly accrual becomes 1.75 days.",
    rule: "Annual Leave is accrued monthly. The first employment year is based on 15 days per year, then 21 days per year after completing one full year of service.",
    situation: "Use this when the employee requests a planned future vacation.",
    title: "Annual balance accrual",
    tone: "green",
  },
  {
    example: "Example: if today is 21 May and the employee requests 21 May, the system treats it as Emergency. If the employee requests 22 May or later, it stays Normal Annual when balance is available.",
    rule: "Annual requests are classified automatically as Normal, Emergency, or Unpaid. The employee does not choose the subtype.",
    situation: "Use this to understand why the final subtype may differ from the selected request type.",
    title: "Automatic Annual classification",
    tone: "yellow",
  },
  {
    example: "Example: a full-day Emergency request submitted at 9:30 AM can remain paid if balance and eligibility allow it. The same request submitted at 10:15 AM is submitted as unpaid for review. PM-only Emergency can be submitted later.",
    rule: "Emergency requests must be for today only. Full-day and AM-only Emergency should be submitted before 10:00 AM Cairo time. PM-only Emergency can be submitted later.",
    situation: "Use this when the employee needs same-day leave.",
    title: "Emergency same-day rule",
    tone: "red",
  },
  {
    example: "Example: an employee hired on 1 April 2026 who requests annual vacation on 15 August 2026 will be marked unpaid because the employee has not completed 6 months yet.",
    rule: "Before completing 6 months from hire date, every annual vacation request is unpaid.",
    situation: "Use this for any employee still inside the first 6 months of employment.",
    title: "First 6 months",
    tone: "red",
  },
  {
    example: "Example: if the request duration is 3 days and the available paid balance is 1.5 days, the request is not rejected automatically. The available 1.5 days are deducted from the paid balance, and the remaining 1.5 days are submitted as unpaid for manager and HR review.",
    rule: "If available paid balance is not enough, the system does not create negative balance. The request is split into the paid balance available and the remaining unpaid days.",
    situation: "Use this when balance is insufficient but the business still needs the request to go through approval.",
    title: "Insufficient balance",
    tone: "red",
  },
  {
    example: "Example: if Friday is full off for the employee title, a Thursday-to-Sunday request counts Thursday, Saturday, and Sunday only.",
    rule: "Duration is calculated automatically from the selected dates, day part, public holidays, and the Vacation Control weekly-off setup for the employee title.",
    situation: "Use this when the request crosses Fridays, Saturdays, half-days, or configured weekly-off days.",
    title: "Duration calculation",
    tone: "green",
  },
  {
    example: "Example: if an official national holiday is on 23 July, a vacation request ending on 22 July or starting on 24 July will be rejected because it is directly attached to the official holiday.",
    rule: "Vacation requests are not allowed directly before or directly after an official national holiday. This is the only policy case where the system rejects the request automatically.",
    situation: "Use this when reviewing vacation dates around official national holidays.",
    title: "Official holiday adjacency",
    tone: "red",
  },
  {
    example: "Example: a one-day vacation on 22 May must be entered from 22 May to 22 May. AM-only and PM-only requests are always single-date requests.",
    rule: "A single-day request uses the same start and end date. Half-day requests cannot span multiple dates.",
    situation: "Use this when the employee is requesting one day or half a day.",
    title: "Single-day and half-day entry",
    tone: "green",
  },
  {
    example: "Example: if the employee uploads a private medical insurance form from GlobeMed only, this does not qualify as Sick vacation. The Sick request must include a stamped governmental hospital certificate. If the employee selects Other, the notes must explain the reason so HR can decide how it should be treated.",
    rule: "Sick vacation requires a medical certificate stamped from a governmental hospital to integrate with social insurance. Private medical insurance forms, including GlobeMed forms, do not qualify as Sick vacation documents. Other vacation requires explanation and HR review before deciding whether it affects balance, does not affect balance, or will be unpaid.",
    situation: "Use this for medical leave or non-standard vacation reasons.",
    title: "Sick and Other requests",
    tone: "yellow",
  },
  {
    example: "Example: if an employee worked during a Friday conference on 1 May, the compensatory day can be used up to 15 May. After that two-week window, the compensatory day expires.",
    rule: "Compensatory Day is used as a day off instead of a worked weekly-off event day. It does not deduct from Annual balance and must be used within 14 days from the event date.",
    situation: "Use this when the employee worked during an approved event or conference on a weekly off day.",
    title: "Compensatory Day",
    tone: "green",
  },
  {
    example: "Example: if a workday has no CRM entry or a day is missing in CRM, and there is no approved Phoenix vacation or official national holiday, the day will be handled as absence. If the employee has available vacation balance, it will be deducted from that balance. If there is no available balance, the day will be deducted from monthly payroll. If CRM visits are below the required KPI, repeated cases may be treated as partial absence, such as half-day or quarter-day absence, based on the visit count and after prior communication.",
    rule: "CRM is integrated with Phoenix. A workday should not have no CRM entry unless the employee has an approved Phoenix vacation request or the day is an official national holiday. Daily work, daily visits, and required CRM KPIs are counted in Phoenix attendance logic.",
    situation: "Use this when checking daily visits on CRM, below-KPI visits, and repeated CRM action cases.",
    title: "CRM and Phoenix Integration",
    tone: "red",
  },
] as const;

function todayDateOnly() {
  return getVacationPolicyToday();
}

function annualMinimumDateOnly() {
  return getAnnualVacationMinimumStartDate();
}

function currentMonthSelection() {
  const now = new Date();
  return {
    month: now.getMonth() + 1,
    year: now.getFullYear(),
  };
}

function monthLabel(month: number, year: number) {
  return new Intl.DateTimeFormat("en", { month: "long", year: "numeric" }).format(new Date(Date.UTC(year, month - 1, 1)));
}

function formatHolidayDate(value: string) {
  return new Intl.DateTimeFormat("en", {
    day: "2-digit",
    month: "short",
    timeZone: "UTC",
    year: "numeric",
  }).format(new Date(`${value}T00:00:00Z`));
}

function VacationPolicyPanel() {
  const toneClasses = {
    green: {
      card: "border-emerald-100 bg-emerald-50/60",
      label: "text-emerald-600",
      text: "text-emerald-900",
    },
    red: {
      card: "border-rose-100 bg-rose-50/70",
      label: "text-rose-600",
      text: "text-rose-900",
    },
    yellow: {
      card: "border-amber-100 bg-amber-50/70",
      label: "text-amber-600",
      text: "text-amber-900",
    },
  } as const;

  return (
    <Card className={cn(adminPanelClassName, "p-5")}>
      <div className="space-y-4">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <p className="text-xs font-black uppercase tracking-[0.16em] text-orange-600">Application Policy</p>
            <h3 className="mt-1 text-lg font-black tracking-[-0.02em] text-slate-950">How vacation requests are classified and reviewed</h3>
            <p className="mt-2 max-w-3xl text-sm font-semibold leading-6 text-slate-600">
              These rules explain what the system calculates automatically and what remains subject to manager and HR review.
            </p>
          </div>
          <Badge className="w-fit rounded-full border border-orange-200 bg-orange-50 px-3 py-1 text-[10px] font-black uppercase tracking-[0.14em] text-orange-700">
            Policy Guide
          </Badge>
        </div>

        <div className="grid gap-3">
          {applicationPolicyItems.map((item, index) => (
            <div
              className="rounded-2xl border border-slate-200 bg-white px-4 py-4 shadow-[0_8px_22px_rgba(15,23,42,0.04)]"
              key={item.title}
            >
              <div className="flex items-start gap-3">
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-xl bg-orange-50 text-xs font-black text-orange-700 ring-1 ring-orange-100">
                  {index + 1}
                </span>
                <div className="min-w-0 flex-1">
                  <h4 className="text-sm font-black text-slate-950">{item.title}</h4>
                  <p className="mt-1 text-sm font-semibold leading-6 text-slate-700">{item.rule}</p>
                  <div className="mt-3 grid gap-2 lg:grid-cols-2">
                    <div className="rounded-xl border border-slate-100 bg-slate-50 px-3 py-2">
                      <p className="text-[10px] font-black uppercase tracking-[0.14em] text-slate-400">Situation</p>
                      <p className="mt-1 text-xs font-semibold leading-5 text-slate-600">{item.situation}</p>
                    </div>
                    <div className={cn("rounded-xl border px-3 py-2", toneClasses[item.tone].card)}>
                      <p className={cn("text-[10px] font-black uppercase tracking-[0.14em]", toneClasses[item.tone].label)}>Example</p>
                      <p className={cn("mt-1 text-xs font-semibold leading-5", toneClasses[item.tone].text)}>{item.example}</p>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </Card>
  );
}

function NationalEgyptianVacationPanel() {
  const initialSelection = useMemo(() => currentMonthSelection(), []);
  const [month, setMonth] = useState(initialSelection.month);
  const [year, setYear] = useState(initialSelection.year);
  const [data, setData] = useState<NationalHolidayPayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);

    fetch(`/api/vacations/national-holidays?year=${encodeURIComponent(year)}&month=${encodeURIComponent(month)}`, {
      signal: controller.signal,
    })
      .then(async (response) => {
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) {
          throw new Error(typeof payload.message === "string" ? payload.message : "Unable to load Egyptian national holidays.");
        }
        setData(payload as NationalHolidayPayload);
      })
      .catch((loadError) => {
        if (controller.signal.aborted) return;
        setError(loadError instanceof Error ? loadError.message : "Unable to load Egyptian national holidays.");
        setData(null);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });

    return () => controller.abort();
  }, [month, year]);

  const yearOptions = useMemo(() => {
    const currentYear = initialSelection.year;
    return Array.from({ length: 11 }, (_, index) => currentYear - 5 + index);
  }, [initialSelection.year]);

  return (
    <Card className={cn(adminPanelClassName, "p-5")}>
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <p className="text-xs font-black uppercase tracking-[0.16em] text-orange-600">Google Calendar Connection</p>
          <h3 className="mt-1 text-lg font-black tracking-normal text-slate-950">National Egyptian holiday</h3>
          <p className="mt-2 max-w-3xl text-sm font-semibold leading-6 text-slate-600">
            This view is connected to Google Calendar, but government holiday decisions can be moved or shifted. Employees should follow the official HR announcement before taking any national holiday, even if the holiday already appears on the calendar.
          </p>
        </div>
        <Badge className="w-fit rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1 text-[10px] font-black uppercase tracking-[0.14em] text-emerald-700">
          Linked to Google Calendar
        </Badge>
      </div>

      <div className="mt-5 grid gap-3 rounded-2xl border border-slate-200 bg-slate-50 p-4 sm:grid-cols-[180px_140px_minmax(0,1fr)] sm:items-end">
        <label className="space-y-2">
          <span className="text-xs font-black uppercase tracking-[0.16em] text-slate-500">Month</span>
          <select
            className="h-11 w-full rounded-lg border border-border bg-card px-3 text-sm font-semibold text-text outline-none transition focus:border-orange-300"
            value={month}
            onChange={(event) => setMonth(Number(event.target.value))}
          >
            {Array.from({ length: 12 }, (_, index) => index + 1).map((monthValue) => (
              <option key={monthValue} value={monthValue}>
                {new Intl.DateTimeFormat("en", { month: "long" }).format(new Date(Date.UTC(2026, monthValue - 1, 1)))}
              </option>
            ))}
          </select>
        </label>
        <label className="space-y-2">
          <span className="text-xs font-black uppercase tracking-[0.16em] text-slate-500">Year</span>
          <select
            className="h-11 w-full rounded-lg border border-border bg-card px-3 text-sm font-semibold text-text outline-none transition focus:border-orange-300"
            value={year}
            onChange={(event) => setYear(Number(event.target.value))}
          >
            {yearOptions.map((yearValue) => (
              <option key={yearValue} value={yearValue}>{yearValue}</option>
            ))}
          </select>
        </label>
        <div className="rounded-xl border border-white bg-white px-4 py-3 shadow-sm">
          <p className="text-xs font-black uppercase tracking-[0.16em] text-slate-400">Selected period</p>
          <p className="mt-1 text-sm font-black text-slate-900">{monthLabel(month, year)}</p>
        </div>
      </div>

      <div className="mt-5">
        {error ? (
          <AdminCallout tone="danger">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{error}</span>
          </AdminCallout>
        ) : null}

        {data?.message ? (
          <AdminCallout tone={data.connected ? "warning" : "danger"}>
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{data.message}</span>
          </AdminCallout>
        ) : null}

        <div className="grid gap-3">
          {loading ? (
            <div className="rounded-2xl border border-slate-200 bg-white px-4 py-5 text-sm font-bold text-slate-500">
              Loading official holidays from Google Calendar...
            </div>
          ) : data && !data.connected ? null : data?.holidays.length ? (
            <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white">
              <table className="min-w-full divide-y divide-slate-100 text-left text-sm">
                <thead className="bg-slate-50 text-xs font-black uppercase tracking-[0.14em] text-slate-500">
                  <tr>
                    <th className="px-4 py-3">Holiday</th>
                    <th className="px-4 py-3">Start</th>
                    <th className="px-4 py-3">End</th>
                    <th className="px-4 py-3">Duration</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {data.holidays.map((holiday) => (
                    <tr className="align-top transition hover:bg-emerald-50/40" key={holiday.id}>
                      <td className="px-4 py-3">
                        <p className="font-black text-slate-950">{holiday.name}</p>
                        {holiday.description ? (
                          <p className="mt-1 max-w-xl text-xs font-semibold leading-5 text-slate-500">{holiday.description}</p>
                        ) : null}
                      </td>
                      <td className="px-4 py-3 font-semibold text-slate-700">{formatHolidayDate(holiday.startDate)}</td>
                      <td className="px-4 py-3 font-semibold text-slate-700">{formatHolidayDate(holiday.endDate ?? holiday.startDate)}</td>
                      <td className="px-4 py-3">
                        <Badge className="w-fit border border-emerald-200 bg-emerald-50 text-emerald-700">
                          {formatDays(holiday.durationDays)}
                        </Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="rounded-2xl border border-slate-200 bg-white px-4 py-5 text-sm font-bold text-slate-600">
              No official Egyptian national vacations found for {monthLabel(month, year)} in Google Calendar.
            </div>
          )}
        </div>
      </div>
    </Card>
  );
}

export function VacationRequestForm({ initialData, initialError, showHero = true }: VacationRequestFormProps) {
  const router = useRouter();
  const [activeTab, setActiveTab] = useState<VacationRequestPageTab>("request");
  const [vacationType, setVacationType] = useState<VacationType>("annual");
  const [dayPart, setDayPart] = useState<VacationDayPart>("full_day");
  const [startDate, setStartDate] = useState(annualMinimumDateOnly());
  const [endDate, setEndDate] = useState(annualMinimumDateOnly());
  const [sickDocument, setSickDocument] = useState<File | null>(null);
  const [otherReason, setOtherReason] = useState("");
  const [compensatoryEventName, setCompensatoryEventName] = useState("");
  const [compensatoryEventDate, setCompensatoryEventDate] = useState("");
  const [compensatoryEventLocation, setCompensatoryEventLocation] = useState("");
  const [compensatoryManager1, setCompensatoryManager1] = useState("");
  const [compensatoryManager2, setCompensatoryManager2] = useState("");
  const [compensatoryPhoto, setCompensatoryPhoto] = useState<File | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(initialError);

  const durationPreview = useMemo(() => {
    try {
      return {
        days: calculateVacationDurationDays({
          dayPart,
          endDate,
          startDate,
          weeklyOffPolicy: initialData?.weeklyOffPolicy,
        }),
        error: null,
      };
    } catch (previewError) {
      return {
        days: 0,
        error: previewError instanceof Error ? previewError.message : "Invalid vacation dates.",
      };
    }
  }, [dayPart, endDate, initialData?.weeklyOffPolicy, startDate]);

  const policyWarnings = useMemo(
    () => getVacationPolicyWarnings({ dayPart, endDate, startDate, vacationType }),
    [dayPart, endDate, startDate, vacationType],
  );

  async function submitRequest() {
    setSubmitting(true);
    setError(null);

    try {
      const formData = new FormData();
      formData.append("dayPart", dayPart);
      formData.append("endDate", endDate);
      formData.append("startDate", startDate);
      formData.append("vacationType", vacationType);
      if (vacationType === "other") {
        formData.append("otherReason", otherReason);
      }
      if (sickDocument) {
        formData.append("sickDocument", sickDocument);
      }
      if (vacationType === "compensatory") {
        formData.append("compensatoryEventDate", compensatoryEventDate);
        formData.append("compensatoryEventLocation", compensatoryEventLocation);
        formData.append("compensatoryEventName", compensatoryEventName);
        formData.append("compensatoryManager1", compensatoryManager1);
        formData.append("compensatoryManager2", compensatoryManager2);
        if (compensatoryPhoto) formData.append("compensatoryPhoto", compensatoryPhoto);
      }

      const response = await fetch("/api/vacations/requests", {
        body: formData,
        method: "POST",
      });
      const payload = await response.json().catch(() => ({}));

      if (!response.ok) {
        throw new Error(typeof payload.message === "string" ? payload.message : "Vacation request failed.");
      }

      router.push("/leave-management/vacation-report?status=pending_manager");
      router.refresh();
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "Vacation request failed.");
    } finally {
      setSubmitting(false);
    }
  }

  const balance = initialData?.balances?.[vacationType] ?? initialData?.balance;
  const isSick = vacationType === "sick";
  const isOther = vacationType === "other";
  const isCompensatory = vacationType === "compensatory";
  const compensatoryExpiryDate = isCompensatory && compensatoryEventDate
    ? addDaysToDateOnly(compensatoryEventDate, 14)
    : null;
  const compensatoryDateError = isCompensatory && compensatoryEventDate
    ? startDate < compensatoryEventDate
      ? "Compensatory Day cannot be requested before the event date."
      : compensatoryExpiryDate && startDate > compensatoryExpiryDate
        ? `Compensatory Day expires on ${formatHolidayDate(compensatoryExpiryDate)}. It must be used within 14 days from the event date.`
        : null
    : null;
  const submitDisabled =
    !initialData ||
    !initialData.balance ||
    submitting ||
    Boolean(durationPreview.error) ||
    (isSick && !sickDocument) ||
    (isOther && !otherReason.trim()) ||
    (isCompensatory && (
      !compensatoryEventName.trim() ||
      !compensatoryEventDate ||
      !compensatoryEventLocation.trim() ||
      !compensatoryManager1.trim() ||
      !compensatoryPhoto ||
      Boolean(compensatoryDateError)
    ));

  function updateVacationType(value: VacationType) {
    setVacationType(value);
    setSickDocument(null);
    setOtherReason("");
    setCompensatoryPhoto(null);
    if (value === "emergency") {
      const today = todayDateOnly();
      setStartDate(today);
      setEndDate(today);
      return;
    }
  }

  function updateDayPart(value: VacationDayPart) {
    setDayPart(value);
    if (value !== "full_day") {
      setEndDate(startDate);
    }
  }

  function updateStartDate(value: string) {
    const nextValue = value;
    setStartDate(nextValue);
    if (dayPart !== "full_day" || endDate < nextValue) {
      setEndDate(nextValue);
    }
  }

  return (
    <PageContainer className="vacation-request-premium">
      {showHero ? (
        <AdminPageHero
          description="Submit a vacation request for direct manager approval and HR review."
          eyebrow="Leave Management"
          icon={<CalendarDays className="h-3.5 w-3.5" />}
          title="Vacation Request"
        />
      ) : null}

      {error ? (
        <AdminCallout tone="danger">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{error}</span>
        </AdminCallout>
      ) : null}

      <div className="flex w-fit rounded-2xl border border-slate-200 bg-slate-50 p-1 shadow-[0_8px_22px_rgba(15,23,42,0.04)]" role="tablist" aria-label="Vacation request page tabs">
        {([
          { label: "Vacation Request", value: "request" },
          { label: "Vacation Policy", value: "policy" },
          { label: "National Egyptian holiday", value: "national" },
        ] as const).map((tab) => {
          const active = activeTab === tab.value;
          return (
            <button
              aria-selected={active}
              className={cn(
                "h-10 rounded-xl px-4 text-sm font-black transition",
                active ? "bg-white text-orange-700 shadow-sm" : "text-slate-500 hover:bg-white/70 hover:text-slate-900",
              )}
              key={tab.value}
              role="tab"
              type="button"
              onClick={() => setActiveTab(tab.value)}
            >
              {tab.label}
            </button>
          );
        })}
      </div>

      {activeTab === "policy" ? (
        <VacationPolicyPanel />
      ) : activeTab === "national" ? (
        <NationalEgyptianVacationPanel />
      ) : (
      <div className="space-y-4">
        <div className="space-y-4">
          <Card className={cn(adminPanelClassName, "p-5")}>
            <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2 sm:col-span-2">
              <span className="text-xs font-black uppercase tracking-[0.16em] text-slate-500">Vacation type</span>
              <div className="grid grid-cols-2 gap-2 rounded-xl border border-slate-200 bg-slate-50 p-1 sm:grid-cols-4" role="tablist" aria-label="Vacation type">
                {(initialData?.vacationTypeOptions ?? VACATION_REQUEST_TYPES).map((option) => {
                  const active = vacationType === option.value;
                  return (
                    <button
                      key={option.value}
                      aria-selected={active}
                      className={cn(
                        "h-10 rounded-lg px-3 text-[13px] font-black transition sm:text-sm",
                        active ? "bg-white text-orange-700 shadow-sm" : "text-slate-500 hover:bg-white/70 hover:text-slate-900",
                      )}
                      role="tab"
                      type="button"
                      onClick={() => updateVacationType(option.value)}
                    >
                      <span className="whitespace-nowrap">{option.label}</span>
                    </button>
                  );
                })}
              </div>
            </div>

            <label className="space-y-2">
              <span className="text-xs font-black uppercase tracking-[0.16em] text-slate-500">Day part</span>
              <select
                className="h-11 w-full rounded-lg border border-border bg-card px-3 text-sm font-semibold text-text outline-none transition focus:border-orange-300"
                value={dayPart}
                onChange={(event) => updateDayPart(event.target.value as VacationDayPart)}
              >
                {(initialData?.dayPartOptions ?? VACATION_DAY_PARTS).map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
            </label>

            <VacationDatePicker
              compensatoryEventDate={compensatoryEventDate}
              dayPart={dayPart}
              endDate={endDate}
              label="Vacation start from"
              picker="start"
              startDate={startDate}
              vacationType={vacationType}
              value={startDate}
              onChange={updateStartDate}
            />

            <VacationDatePicker
              compensatoryEventDate={compensatoryEventDate}
              dayPart={dayPart}
              disabled={dayPart !== "full_day"}
              endDate={endDate}
              label="Vacation to"
              picker="end"
              startDate={startDate}
              vacationType={vacationType}
              value={endDate}
              onChange={setEndDate}
            />

            <div className="rounded-xl border border-orange-100 bg-orange-50/70 px-4 py-4 sm:col-span-2">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <p className="text-xs font-black uppercase tracking-[0.16em] text-orange-700">Calculated duration</p>
                  <p className="mt-1 text-2xl font-black text-slate-950">
                    {durationPreview.error ? "Invalid" : durationDisplay(durationPreview.days)}
                  </p>
                  <p className="mt-1 text-xs font-semibold text-orange-900">
                    Duration updates automatically for every vacation type based on the selected dates and day part.
                  </p>
                </div>
                {!durationPreview.error ? (
                  <Badge className="w-fit border border-orange-200 bg-white text-orange-700">
                    {formatDays(durationPreview.days)}
                  </Badge>
                ) : null}
              </div>
              {durationPreview.error ? <p className="mt-3 text-sm font-semibold text-rose-700">{durationPreview.error}</p> : null}
              {policyWarnings.length > 0 ? (
                <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-bold leading-5 text-amber-800">
                  {policyWarnings.map((warning) => (
                    <p key={warning}>{warning}</p>
                  ))}
                  <p className="mt-1 text-amber-700">The request can still be submitted for human review. HR owns the final decision.</p>
                </div>
              ) : null}
            </div>

            {isSick ? (
              <div className="space-y-2 sm:col-span-2">
                <span className="text-xs font-black uppercase tracking-[0.16em] text-slate-500">Medical document</span>
                <label className="flex cursor-pointer flex-col items-center justify-center rounded-2xl border-2 border-dashed border-sky-200 bg-sky-50/60 px-4 py-5 text-center transition hover:border-sky-300 hover:bg-sky-50">
                  <input
                    accept=".pdf,.doc,.docx,image/jpeg,image/png,image/webp"
                    className="sr-only"
                    required
                    type="file"
                    onChange={(event) => setSickDocument(event.target.files?.[0] ?? null)}
                  />
                  <span className="rounded-xl bg-sky-600 px-4 py-2 text-sm font-black text-white shadow-sm">
                    Browse medical document
                  </span>
                  <span className="mt-2 text-xs font-semibold leading-5 text-slate-600">
                    Upload a stamped governmental hospital document. PDF, Word, JPG, PNG, or WEBP accepted.
                  </span>
                </label>
                <p className="text-xs font-semibold text-slate-500">
                  {sickDocument ? sickDocument.name : "Required for sick vacation requests."}
                </p>
              </div>
            ) : null}

            {isOther ? (
              <label className="space-y-2 sm:col-span-2">
                <span className="text-xs font-black uppercase tracking-[0.16em] text-slate-500">Other vacation explanation</span>
                <textarea
                  className="min-h-28 w-full rounded-xl border border-border bg-card px-3 py-3 text-sm font-semibold text-text outline-none transition placeholder:text-slate-400 focus:border-orange-300"
                  placeholder="Explain what this Other vacation is for. HR will review whether it affects balance, does not affect balance, or will be unpaid."
                  required
                  value={otherReason}
                  onChange={(event) => setOtherReason(event.target.value)}
                />
                <p className="text-xs font-semibold text-slate-500">
                  Required for Other vacation requests.
                </p>
              </label>
            ) : null}

            {isCompensatory ? (
              <div className="space-y-4 rounded-2xl border border-orange-100 bg-orange-50/40 p-4 sm:col-span-2">
                <div>
                  <p className="text-xs font-black uppercase tracking-[0.16em] text-orange-700">Compensatory Day evidence</p>
                  <p className="mt-1 text-xs font-semibold leading-5 text-orange-900">
                    Required because this day is granted instead of work done during a weekly-off event or conference. It does not deduct from vacation balance and expires 14 days after the event date.
                  </p>
                </div>
                <div className="grid gap-4 sm:grid-cols-2">
                  <label className="space-y-2">
                    <span className="text-xs font-black uppercase tracking-[0.16em] text-slate-500">Event name</span>
                    <Input
                      placeholder="Conference or event name"
                      required
                      value={compensatoryEventName}
                      onChange={(event) => setCompensatoryEventName(event.target.value)}
                    />
                  </label>
                  <label className="space-y-2">
                    <span className="text-xs font-black uppercase tracking-[0.16em] text-slate-500">Event date</span>
                    <Input
                      required
                      type="date"
                      value={compensatoryEventDate}
                      onChange={(event) => setCompensatoryEventDate(event.target.value)}
                    />
                    {compensatoryExpiryDate ? (
                      <p className="text-xs font-semibold text-orange-800">
                        Available until {formatHolidayDate(compensatoryExpiryDate)}.
                      </p>
                    ) : null}
                  </label>
                  <label className="space-y-2 sm:col-span-2">
                    <span className="text-xs font-black uppercase tracking-[0.16em] text-slate-500">Event location</span>
                    <Input
                      placeholder="Venue, city, or territory"
                      required
                      value={compensatoryEventLocation}
                      onChange={(event) => setCompensatoryEventLocation(event.target.value)}
                    />
                  </label>
                  <label className="space-y-2">
                    <span className="text-xs font-black uppercase tracking-[0.16em] text-slate-500">Manager with you 1</span>
                    <Input
                      placeholder="Manager name"
                      required
                      value={compensatoryManager1}
                      onChange={(event) => setCompensatoryManager1(event.target.value)}
                    />
                  </label>
                  <label className="space-y-2">
                    <span className="text-xs font-black uppercase tracking-[0.16em] text-slate-500">Manager with you 2</span>
                    <Input
                      placeholder="Manager name (optional)"
                      value={compensatoryManager2}
                      onChange={(event) => setCompensatoryManager2(event.target.value)}
                    />
                  </label>
                  <label className="space-y-2 sm:col-span-2">
                    <span className="text-xs font-black uppercase tracking-[0.16em] text-slate-500">Event photo</span>
                    <label className="flex cursor-pointer flex-col items-center justify-center rounded-2xl border-2 border-dashed border-orange-200 bg-white/70 px-4 py-5 text-center transition hover:border-orange-300 hover:bg-white">
                      <input
                        accept="image/jpeg,image/png,image/webp"
                        className="sr-only"
                        required
                        type="file"
                        onChange={(event) => setCompensatoryPhoto(event.target.files?.[0] ?? null)}
                      />
                      <span className="rounded-xl bg-orange-600 px-4 py-2 text-sm font-black text-white shadow-sm">
                        Browse event photo
                      </span>
                      <span className="mt-2 text-xs font-semibold leading-5 text-slate-600">
                        Upload the event or conference photo. JPG, PNG, or WEBP accepted.
                      </span>
                    </label>
                    <p className="text-xs font-semibold text-slate-500">
                      {compensatoryPhoto ? compensatoryPhoto.name : "Required event or conference photo."}
                    </p>
                  </label>
                </div>
                {compensatoryDateError ? (
                  <div className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs font-bold leading-5 text-rose-800">
                    {compensatoryDateError}
                  </div>
                ) : null}
              </div>
            ) : null}
            </div>

            <div className="mt-5 flex flex-col gap-3 rounded-xl border border-slate-200 bg-slate-50 px-4 py-4 sm:flex-row sm:items-center sm:justify-end">
              <Button
                className="gap-2 rounded-xl bg-orange-600 px-5 py-3 font-black hover:bg-orange-700"
                disabled={submitDisabled}
                onClick={submitRequest}
                type="button"
              >
                <SendHorizonal className="h-4 w-4" />
                {submitting ? "Submitting..." : "Submit Request"}
              </Button>
            </div>
          </Card>
        </div>

        <div className="grid gap-4 xl:grid-cols-[minmax(280px,320px)_minmax(0,1fr)]">
          <VacationBalanceCard balance={balance} />

          <Card
            className={cn(
              adminPanelClassName,
              "overflow-hidden rounded-[28px] border border-slate-200/90 bg-[linear-gradient(135deg,rgba(255,255,255,0.98),rgba(248,250,252,0.96))] p-5 shadow-[0_18px_42px_rgba(15,23,42,0.06)]",
            )}
          >
            <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_auto] md:items-center">
              <VacationSummaryPerson
                hrId={initialData?.employee.hrId}
                label="Employee"
                name={initialData?.employee.fullName ?? "-"}
              />
              <VacationSummaryPerson
                hrId={initialData?.manager?.hrId}
                label="Direct manager"
                name={initialData?.manager?.fullName ?? "Not assigned"}
              />
              <VacationSummaryPerson
                hrId={initialData?.managerOfManager?.hrId}
                label="Manager of manager"
                name={initialData?.managerOfManager?.fullName ?? (initialData?.manager ? "Top of hierarchy" : "Not assigned")}
              />
              <Badge className="w-fit px-4 py-2 text-[10px] font-semibold tracking-[0.18em] md:justify-self-end" variant={balance?.paymentStatus === "paid" ? "success" : "warning"}>
                {balance?.paymentStatus === "paid"
                  ? "Paid eligible"
                  : balance?.paymentStatus === "partial"
                    ? `${formatDays(balance.paidDurationDays)} paid / ${formatDays(balance.unpaidDurationDays)} unpaid`
                    : "Unpaid if requested today"}
              </Badge>
            </div>
          </Card>
        </div>
      </div>
      )}
    </PageContainer>
  );
}
