"use client";

import { Plus } from "lucide-react";

import { COLOR_STYLES } from "@/components/hr-reminders/reminder-style";
import {
  dayOfMonth,
  formatClock,
  groupByDay,
  initialsOf,
  monthWeeks,
  sameMonth,
  weekOf,
  weekdayName,
  weekdayShort,
} from "@/lib/hr-reminders/logic";
import type { ReminderView } from "@/lib/hr-reminders/types";
import { cn } from "@/lib/utils";

type ChipProps = {
  onOpen: (reminder: ReminderView) => void;
  reminder: ReminderView;
  showOwner: boolean;
};

/** One reminder on a calendar: a tinted chip with a coloured edge. Wraps; never clips. */
function Chip({ onOpen, reminder, showOwner }: ChipProps) {
  const done = reminder.status === "done";
  return (
    <button
      className={cn(
        "block w-full min-w-0 px-2 py-1 text-left text-xs leading-snug transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500",
        COLOR_STYLES[reminder.color].chip,
        done ? "opacity-60" : "",
      )}
      onClick={(event) => {
        event.stopPropagation();
        onOpen(reminder);
      }}
      type="button"
    >
      {reminder.startsAt ? <span className="mr-1 font-black">{formatClock(reminder.startsAt)}</span> : null}
      <span className={cn("break-words font-semibold", done ? "line-through" : "")}>{reminder.title}</span>
      {showOwner ? <span className="ml-1 text-[10px] font-black uppercase tracking-wide opacity-60">{initialsOf(reminder.ownerName)}</span> : null}
    </button>
  );
}

// ── Week ───────────────────────────────────────────────────────────────────────────────────────

/**
 * Seven days, Sunday first. One structure at every width: a stack of day cards on a phone, seven
 * columns from `md`. Each column is `min-w-0` and its chips wrap, so the row can never scroll sideways.
 */
export function WeekCalendar({
  anchor,
  onAdd,
  onOpen,
  reminders,
  today,
  viewerHrId,
}: {
  anchor: string;
  onAdd: (day: string) => void;
  onOpen: (reminder: ReminderView) => void;
  reminders: readonly ReminderView[];
  today: string;
  viewerHrId: string;
}) {
  const days = weekOf(anchor);
  const byDay = groupByDay(reminders);
  const viewerKey = viewerHrId.toLowerCase();

  return (
    <div className="grid grid-cols-1 gap-2 md:grid-cols-7 md:gap-0 md:border md:border-phx-line md:bg-white">
      {days.map((day) => {
        const items = byDay.get(day) ?? [];
        const isToday = day === today;
        return (
          <section
            aria-label={`${weekdayName(day)} ${dayOfMonth(day)}`}
            className={cn(
              "flex min-w-0 flex-col border border-phx-line bg-white md:min-h-[320px] md:border-0 md:border-l md:first:border-l-0",
              isToday ? "bg-orange-50/50" : "",
            )}
            key={day}
          >
            <header
              className={cn(
                "flex items-center justify-between gap-2 border-b border-phx-line px-3 py-2",
                isToday ? "border-b-orange-300 bg-orange-100/60" : "bg-slate-50/80",
              )}
            >
              <span className="min-w-0">
                <span className={cn("block text-[10px] font-black uppercase tracking-[0.14em]", isToday ? "text-orange-700" : "text-slate-500")}>
                  {weekdayShort(day)}
                </span>
                <span className={cn("block text-lg font-black leading-none", isToday ? "text-orange-700" : "text-slate-900")}>{dayOfMonth(day)}</span>
              </span>
              <button
                aria-label={`Add a reminder on ${weekdayName(day)} ${dayOfMonth(day)}`}
                className="shrink-0 border border-transparent p-1.5 text-slate-400 transition hover:border-orange-200 hover:text-orange-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500"
                onClick={() => onAdd(day)}
                type="button"
              >
                <Plus className="h-4 w-4" />
              </button>
            </header>
            <div className="flex-1 space-y-1.5 p-2">
              {items.length === 0 ? (
                <p className="px-1 py-1 text-xs text-slate-300 md:hidden">Nothing planned</p>
              ) : (
                items.map((reminder) => (
                  <Chip
                    key={reminder.id}
                    onOpen={onOpen}
                    reminder={reminder}
                    showOwner={reminder.ownerHrId.toLowerCase() !== viewerKey}
                  />
                ))
              )}
            </div>
          </section>
        );
      })}
    </div>
  );
}

// ── Month ──────────────────────────────────────────────────────────────────────────────────────

const WEEKDAY_HEADS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const CHIPS_PER_DAY = 3;

/**
 * The month as a grid of days. At 375px a day shows coloured marks only (its items are listed under
 * the grid when the day is picked); from `sm` the cell names up to three of them and counts the rest.
 */
export function MonthCalendar({
  anchor,
  onOpen,
  onSelectDay,
  reminders,
  selectedDay,
  today,
  viewerHrId,
}: {
  anchor: string;
  onOpen: (reminder: ReminderView) => void;
  onSelectDay: (day: string) => void;
  reminders: readonly ReminderView[];
  selectedDay: string | null;
  today: string;
  viewerHrId: string;
}) {
  const weeks = monthWeeks(anchor);
  const byDay = groupByDay(reminders);
  const viewerKey = viewerHrId.toLowerCase();

  return (
    <div className="border border-phx-line bg-white">
      <div className="grid grid-cols-7 border-b border-phx-line bg-slate-50/80">
        {WEEKDAY_HEADS.map((head) => (
          <div className="px-1 py-2 text-center text-[10px] font-black uppercase tracking-[0.12em] text-slate-500 sm:px-2 sm:text-left" key={head}>
            {head}
          </div>
        ))}
      </div>
      {weeks.map((week) => (
        <div className="grid grid-cols-7 border-b border-phx-line last:border-b-0" key={week[0]}>
          {week.map((day) => {
            const items = byDay.get(day) ?? [];
            const inMonth = sameMonth(day, anchor);
            const isToday = day === today;
            const selected = day === selectedDay;
            const extra = items.length - CHIPS_PER_DAY;
            return (
              <div
                className={cn(
                  "flex min-h-[64px] min-w-0 cursor-pointer flex-col border-l border-phx-line p-1 first:border-l-0 sm:min-h-[112px] sm:p-1.5",
                  inMonth ? "bg-white" : "bg-slate-50/70",
                  selected ? "outline outline-2 -outline-offset-2 outline-orange-500" : "",
                )}
                key={day}
                onClick={() => onSelectDay(day)}
              >
                <button
                  aria-label={`${weekdayName(day)} ${dayOfMonth(day)}, ${items.length} ${items.length === 1 ? "reminder" : "reminders"}`}
                  aria-pressed={selected}
                  className={cn(
                    "mb-1 inline-flex h-6 min-w-6 items-center justify-center self-start px-1 text-xs font-black focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500",
                    isToday ? "bg-orange-600 text-white" : inMonth ? "text-slate-900" : "text-slate-400",
                  )}
                  onClick={(event) => {
                    event.stopPropagation();
                    onSelectDay(day);
                  }}
                  type="button"
                >
                  {dayOfMonth(day)}
                </button>

                <div className="flex flex-wrap gap-1 sm:hidden">
                  {items.map((reminder) => (
                    <span aria-hidden className={cn("h-2 w-2", COLOR_STYLES[reminder.color].dot, reminder.status === "done" ? "opacity-40" : "")} key={reminder.id} />
                  ))}
                </div>

                <div className="hidden min-w-0 flex-1 space-y-1 sm:block">
                  {items.slice(0, CHIPS_PER_DAY).map((reminder) => (
                    <Chip key={reminder.id} onOpen={onOpen} reminder={reminder} showOwner={reminder.ownerHrId.toLowerCase() !== viewerKey} />
                  ))}
                  {extra > 0 ? <p className="px-1 text-[11px] font-bold text-slate-500">+{extra} more</p> : null}
                </div>
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}
