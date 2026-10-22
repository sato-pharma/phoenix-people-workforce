"use client";

import * as React from "react";
import { AlertTriangle } from "lucide-react";

import { stableEnGbFormatter } from "@/lib/format/cairo-datetime";
import type { CrmWorkAfterDate } from "@/lib/resignations/crm-work-after-date";
import { cn } from "@/lib/utils";

/**
 * The warning beside an exit form's last working day: the CRM work this person did AFTER the date
 * about to be saved (owner, 2026-10-22 — two exits were saved before work the CRM already held).
 * It reads, it never blocks, and it never changes the date or a payroll choice.
 *
 * `variant`:
 * - "after-last-day" — work after the last working day being entered (Resign, New resignation,
 *   Edit dates, Declined Offer).
 * - "since-hire-unpaid" — the Declined Offer form with "Enter into payroll: No": every day of CRM
 *   work since the hire date, which "No" leaves unpaid. `date` is then the day before the hire.
 */
export function CrmWorkAfterWarning({
  className,
  date,
  hrId,
  variant = "after-last-day",
}: {
  className?: string;
  date: string | null | undefined;
  hrId: string | null | undefined;
  variant?: "after-last-day" | "since-hire-unpaid";
}) {
  // Each answer is kept with the request it answers, so a changed date or person never shows the
  // previous one's result, and nothing is set synchronously inside the effect.
  const [state, setState] = React.useState<
    { key: string; status: "error" } | { data: CrmWorkAfterDate; key: string; status: "ready" } | null
  >(null);

  const day = String(date ?? "").slice(0, 10);
  const person = String(hrId ?? "").trim();
  const key = person && /^\d{4}-\d{2}-\d{2}$/.test(day) ? `${person}|${day}` : "";

  React.useEffect(() => {
    if (!key) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      fetch(`/api/resignations/crm-work-after?hrId=${encodeURIComponent(person)}&date=${encodeURIComponent(day)}`, {
        signal: controller.signal,
      })
        .then(async (response) => {
          const payload = (await response.json().catch(() => null)) as { data?: CrmWorkAfterDate } | null;
          if (!response.ok || !payload?.data) throw new Error("crm_work_after_failed");
          setState({ data: payload.data, key, status: "ready" });
        })
        .catch((error: unknown) => {
          if ((error as { name?: string })?.name === "AbortError") return;
          setState({ key, status: "error" });
        });
    }, 300);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [key, person, day]);

  if (!key || !state || state.key !== key) return null;
  if (state.status === "error") {
    return (
      <p className={cn("border border-slate-300 bg-slate-50 px-3 py-2 text-xs text-slate-600", className)} role="status">
        The CRM could not be read for this date, so any work after it is not shown.
      </p>
    );
  }

  const { data } = state;
  if (data.visits === 0) return null;
  const dayCount = data.days.length;
  const span =
    data.firstDay && data.lastDay && data.firstDay !== data.lastDay
      ? `from ${formatDay(data.firstDay)} to ${formatDay(data.lastDay)}`
      : `on ${formatDay(data.firstDay)}`;
  const manager =
    data.daysWithManager.length > 0
      ? ` A manager was beside them on ${plural(data.daysWithManager.length, "of those days", "of those days")}.`
      : "";

  return (
    <div
      className={cn("flex gap-2.5 border border-amber-300 bg-amber-50 px-3 py-2.5 text-sm text-amber-900", className)}
      role="alert"
    >
      <AlertTriangle aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-amber-700" />
      <div className="min-w-0">
        {variant === "since-hire-unpaid" ? (
          <>
            <p className="font-semibold">
              The CRM holds {plural(data.visits, "visit", "visits")} on {plural(dayCount, "day", "days")} since the hire
              date, {span}.{manager}
            </p>
            <p className="mt-1">&ldquo;No&rdquo; leaves every one of those days unpaid.</p>
          </>
        ) : (
          <>
            <p className="font-semibold">
              The CRM holds {plural(data.visits, "visit", "visits")} on {plural(dayCount, "day", "days")} after{" "}
              {formatDay(data.afterDate)}, {span}.{manager}
            </p>
            <p className="mt-1">If they worked those days, the last working day is {formatDay(data.lastDay)}.</p>
          </>
        )}
      </div>
    </div>
  );
}

function plural(count: number, one: string, many: string) {
  return `${count} ${count === 1 ? one : many}`;
}

function formatDay(day: string | null) {
  if (!day) return "";
  const parsed = new Date(`${day}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return day;
  // A calendar day with no clock, so it is read in UTC on purpose — the day never shifts.
  return stableEnGbFormatter({ day: "numeric", month: "short", timeZone: "UTC", year: "numeric" }).format(parsed);
}

/** The day before `day` (YYYY-MM-DD), for the since-hire variant's `date`. */
export function dayBefore(day: string | null | undefined): string | null {
  const text = String(day ?? "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  const parsed = new Date(`${text}T00:00:00Z`);
  parsed.setUTCDate(parsed.getUTCDate() - 1);
  return parsed.toISOString().slice(0, 10);
}
