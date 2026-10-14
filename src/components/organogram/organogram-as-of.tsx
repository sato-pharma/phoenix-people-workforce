"use client";

import { History } from "lucide-react";
import * as React from "react";

import { phxLabelTextClassName, phxSelectClassName } from "@/components/ui/form-tokens";
import {
  currentCairoMonth,
  formatOrganogramAsOfDay,
  formatOrganogramAsOfMonth,
  listOrganogramAsOfMonths,
} from "@/lib/reports/organogram-as-of";

/**
 * "View as of" — the control that turns the live organogram into a picture of a finished month.
 *
 * The value is a `YYYY-MM` month or `null` for today. Choosing is the whole job here: the screen
 * that owns the chart fetches `/api/reports/organogram?asOf=` and decides what to do with the
 * answer, so a failed fetch can put the picker back to the date the chart really shows.
 */
export function OrganogramAsOfPicker({
  disabled = false,
  labelClassName = phxLabelTextClassName,
  onChange,
  value,
}: {
  disabled?: boolean;
  /** Typography of the label only. A screen whose neighbouring fields carry their own label style passes it, so the row reads as one. */
  labelClassName?: string;
  onChange: (month: string | null) => void;
  value: string | null;
}) {
  const id = React.useId();
  // Read on the client at mount. The list only changes when a month rolls over in Cairo, and the
  // server re-validates whatever month arrives, so a stale list can never draw a wrong chart.
  const months = React.useMemo(() => listOrganogramAsOfMonths(currentCairoMonth()), []);

  return (
    <div className="min-w-0">
      <label className={`mb-1.5 block ${labelClassName}`} htmlFor={id}>
        View as of
      </label>
      <select
        className={phxSelectClassName}
        disabled={disabled}
        id={id}
        onChange={(event) => onChange(event.target.value || null)}
        value={value ?? ""}
      >
        <option value="">Today (live)</option>
        {months.map((month) => (
          <option key={month} value={month}>
            End of {formatOrganogramAsOfMonth(month)}
          </option>
        ))}
      </select>
    </div>
  );
}

/**
 * The line above a past chart. It stays in print, on purpose: a page taken off this screen must
 * say it is a picture of the past, or it gets filed as today's structure.
 */
export function OrganogramAsOfBanner({ month }: { month: string }) {
  return (
    <div
      className="flex items-start gap-3 border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900"
      data-organogram-as-of={month}
      role="status"
    >
      <History aria-hidden className="mt-0.5 h-4 w-4 shrink-0" />
      <div className="min-w-0">
        <p className="font-bold">
          Structure as it stood on {formatOrganogramAsOfDay(month)}
        </p>
        <p className="mt-0.5 text-phx-xs leading-relaxed text-amber-800">
          A read-only picture of the past: seats, reporting lines and who held each seat are as recorded
          at the end of that month. Edit, Resign, exports and email lists are off, open offers are not
          shown, and the Head Office branch is left out because its roles are not dated.
        </p>
      </div>
    </div>
  );
}
