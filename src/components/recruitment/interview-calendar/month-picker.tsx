"use client";

// The interview calendar's date picker: one month, Sunday first, and only the days an interview can
// be held on are choosable — every day of the week since 7 Nov 2026 (it was Sunday to Thursday), and
// never a day already gone. A day that cannot be booked stays on the grid, struck quiet, so the month
// still reads as a month.

import { ChevronLeft, ChevronRight } from "lucide-react";

import {
  WEEKDAY_INITIALS,
  formatLongDate,
  formatMonthCaption,
  isBookableDay,
  monthGrid,
} from "@/lib/recruitment/interview-calendar-week";
import { cn } from "@/lib/utils";
import { adminControlDepthClassName } from "@/components/admin/admin-design-tokens";

export type MonthCursor = { year: number; monthIndex: number };

export function cursorFor(dateKey: string): MonthCursor {
  const [year, month] = dateKey.split("-").map(Number);
  return { monthIndex: month - 1, year };
}

export function shiftCursor(cursor: MonthCursor, months: number): MonthCursor {
  const total = cursor.year * 12 + cursor.monthIndex + months;
  return { monthIndex: ((total % 12) + 12) % 12, year: Math.floor(total / 12) };
}

export function MonthPicker({
  cursor,
  onCursor,
  selected,
  onSelect,
  todayKey,
  allowPast = false,
  highlightWeekOf,
}: {
  cursor: MonthCursor;
  onCursor: (cursor: MonthCursor) => void;
  selected: string | null;
  onSelect: (dateKey: string) => void;
  todayKey: string;
  /** The calendar's own week picker may go back in time; booking may not. */
  allowPast?: boolean;
  /** Tint the row of the week currently shown (the week picker). */
  highlightWeekOf?: string[] | null;
}) {
  const rows = monthGrid(cursor.year, cursor.monthIndex);
  const todayCursor = cursorFor(todayKey);
  const atFloor = !allowPast && cursor.year * 12 + cursor.monthIndex <= todayCursor.year * 12 + todayCursor.monthIndex;
  const highlighted = new Set(highlightWeekOf ?? []);

  return (
    <div className="w-full select-none">
      <div className="mb-2 flex items-center justify-between gap-2">
        <button
          aria-label="Previous month"
          className={`inline-flex h-8 w-8 items-center justify-center border border-slate-200 bg-white text-slate-600 hover:border-slate-300 hover:text-slate-900 disabled:cursor-not-allowed disabled:opacity-40 ${adminControlDepthClassName} disabled:shadow-none`}
          disabled={atFloor}
          onClick={() => onCursor(shiftCursor(cursor, -1))}
          type="button"
        >
          <ChevronLeft className="h-4 w-4" />
        </button>
        <p className="text-[13px] font-bold text-slate-900" aria-live="polite">
          {formatMonthCaption(cursor.year, cursor.monthIndex)}
        </p>
        <button
          aria-label="Next month"
          className={`inline-flex h-8 w-8 items-center justify-center border border-slate-200 bg-white text-slate-600 hover:border-slate-300 hover:text-slate-900 ${adminControlDepthClassName}`}
          onClick={() => onCursor(shiftCursor(cursor, 1))}
          type="button"
        >
          <ChevronRight className="h-4 w-4" />
        </button>
      </div>
      <table className="w-full table-fixed border-collapse text-center">
        <thead>
          <tr>
            {WEEKDAY_INITIALS.map((name, index) => (
              <th
                className={cn("pb-1 text-[11px] font-bold uppercase tracking-wide", index > 4 ? "text-slate-300" : "text-slate-500")}
                key={name}
                scope="col"
              >
                {name}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, rowIndex) => (
            <tr className={cn(row.some((key) => key && highlighted.has(key)) && "bg-orange-50")} key={rowIndex}>
              {row.map((key, index) => {
                if (!key) return <td className="h-9" key={`blank-${index}`} />;
                const day = Number(key.slice(8));
                const bookable = isBookableDay(key) && (allowPast || key >= todayKey);
                const isSelected = key === selected;
                const isToday = key === todayKey;
                return (
                  <td className="p-0.5" key={key}>
                    <button
                      aria-label={formatLongDate(key)}
                      aria-pressed={isSelected}
                      className={cn(
                        "flex h-8 w-full items-center justify-center text-[13px] tabular-nums transition-colors",
                        isSelected
                          ? "bg-orange-600 font-bold text-white"
                          : bookable
                            ? "font-semibold text-slate-800 hover:bg-orange-50 hover:text-orange-700"
                            : "cursor-not-allowed text-slate-300",
                        isToday && !isSelected && "outline outline-1 -outline-offset-1 outline-orange-500",
                      )}
                      disabled={!bookable}
                      onClick={() => onSelect(key)}
                      type="button"
                    >
                      {day}
                    </button>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
