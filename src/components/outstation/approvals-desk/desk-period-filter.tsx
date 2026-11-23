"use client";

import { X } from "lucide-react";
import { useId } from "react";

import { CrmField, CrmSelect, crmInputClassName } from "@/components/phoenix-crm/ui";
import { currentCairoDateOnlyIso } from "@/lib/i18n/format";
import { NO_PERIOD, type TripPeriod, hasPeriod, monthLabel, monthPeriod, periodMonth, recentMonths, withFrom, withTo } from "@/lib/outstation/approvals/trip-period";
import { cn } from "@/lib/utils";

const ANY = "";
const CHOSEN = "chosen";

/**
 * The trip-date filter: a month, one day, or a period (owner, 2026-11-23: "AND FILTER BY PERIOD OR
 * MONTH OR DATE").
 *
 *   - Trip month — one pick narrows the lane to that month.
 *   - From — one pick is that ONE day; moving To later makes it a period.
 *   - To — the last day of the period.
 *
 * The dates are the trip's own, the ones each row prints, and a trip of several days is listed when
 * any of its days is inside. It narrows Ready, Your call and History alike, and the choice is kept
 * in the address, so a reload or a shared link opens the same list.
 */
export function DeskPeriodFilter({ onChoose, period }: { onChoose: (period: TripPeriod) => void; period: TripPeriod }) {
  const id = useId();
  const month = periodMonth(period);
  const listed = recentMonths(currentCairoDateOnlyIso());
  // A month named in a shared link that is older than the list still has its own line.
  const months = month && !listed.includes(month) ? [month, ...listed] : listed;
  const chosen = hasPeriod(period) && !month;

  return (
    <div aria-label="Trip dates" className="grid min-w-0 grid-cols-2 items-end gap-2 sm:flex sm:flex-wrap" data-desk-period role="group">
      <CrmField className="col-span-2 sm:w-44" htmlFor={`${id}-month`} label="Trip month">
        <CrmSelect
          data-period-month
          id={`${id}-month`}
          onChange={(event) => onChoose(monthPeriod(event.target.value) ?? NO_PERIOD)}
          value={month ?? (chosen ? CHOSEN : ANY)}
        >
          <option value={ANY}>Any date</option>
          {chosen ? (
            <option disabled value={CHOSEN}>
              The dates chosen
            </option>
          ) : null}
          {months.map((key) => (
            <option key={key} value={key}>
              {monthLabel(key)}
            </option>
          ))}
        </CrmSelect>
      </CrmField>
      <CrmField className="sm:w-40" htmlFor={`${id}-from`} label="From">
        <input
          className={cn(crmInputClassName, "appearance-none")}
          data-period-from
          id={`${id}-from`}
          onChange={(event) => onChoose(withFrom(period, event.target.value))}
          type="date"
          value={period.from ?? ""}
        />
      </CrmField>
      <CrmField className="sm:w-40" htmlFor={`${id}-to`} label="To">
        <input
          className={cn(crmInputClassName, "appearance-none")}
          data-period-to
          id={`${id}-to`}
          onChange={(event) => onChoose(withTo(period, event.target.value))}
          type="date"
          value={period.to ?? ""}
        />
      </CrmField>
      {hasPeriod(period) ? (
        <button
          className="col-span-2 inline-flex min-h-11 min-w-0 items-center justify-center gap-1.5 border border-slate-300 bg-white px-3 py-1 text-xs font-black text-slate-700 transition hover:border-slate-500 sm:col-span-1"
          data-period-clear
          onClick={() => onChoose(NO_PERIOD)}
          type="button"
        >
          <X aria-hidden className="h-3.5 w-3.5 shrink-0" /> Clear dates
        </button>
      ) : null}
    </div>
  );
}
