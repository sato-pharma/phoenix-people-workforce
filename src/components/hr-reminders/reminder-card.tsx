"use client";

import { Check, Clock, Lock, MessageSquare, Pencil, Users } from "lucide-react";

import { adminSoftDepthClassName } from "@/components/admin/admin-design-tokens";
import { COLOR_STYLES, MEDALLION } from "@/components/hr-reminders/reminder-style";
import { cn } from "@/lib/utils";
import { initialsOf, relativeDayLabel, sharingKind, formatTimeSpan } from "@/lib/hr-reminders/logic";
import type { ReminderView } from "@/lib/hr-reminders/types";

export function SharingBadge({ reminder }: { reminder: Pick<ReminderView, "shareWithTeam" | "sharedWithHrIds"> }) {
  const kind = sharingKind(reminder);
  if (kind === "team") {
    return (
      <span className="inline-flex items-center gap-1 text-xs font-semibold text-slate-500">
        <Users className="h-3.5 w-3.5" /> Whole team
      </span>
    );
  }
  if (kind === "people") {
    const count = reminder.sharedWithHrIds.length;
    return (
      <span className="inline-flex items-center gap-1 text-xs font-semibold text-slate-500">
        <Users className="h-3.5 w-3.5" /> Shared with {count} {count === 1 ? "person" : "people"}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 text-xs font-semibold text-slate-500">
      <Lock className="h-3.5 w-3.5" /> Private
    </span>
  );
}

export function ReminderCard({
  onEdit,
  onOpen,
  onToggle,
  pending,
  reminder,
  today,
}: {
  onEdit: (reminder: ReminderView) => void;
  onOpen: (reminder: ReminderView) => void;
  onToggle: (reminder: ReminderView) => void;
  pending: boolean;
  reminder: ReminderView;
  today: string;
}) {
  const style = COLOR_STYLES[reminder.color];
  const done = reminder.status === "done";
  const overdue = !done && reminder.remindOn !== null && reminder.remindOn < today;
  const timeSpan = formatTimeSpan(reminder.startsAt, reminder.endsAt);

  return (
    <article
      className={cn(
        "relative flex min-w-0 border border-phx-line bg-white",
        adminSoftDepthClassName,
        done ? "opacity-70" : "",
      )}
    >
      <span aria-hidden className={cn("w-1 shrink-0", style.bar)} />
      <div className="flex min-w-0 flex-1 gap-3 p-3.5">
        {reminder.canChange ? (
          <button
            aria-label={done ? `Mark "${reminder.title}" as not done` : `Mark "${reminder.title}" as done`}
            aria-pressed={done}
            className={cn(
              "mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center border transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500 disabled:opacity-50",
              done ? "border-emerald-600 bg-emerald-600 text-white" : "border-slate-300 bg-white text-transparent hover:border-orange-500 hover:text-orange-400",
            )}
            disabled={pending}
            onClick={() => onToggle(reminder)}
            type="button"
          >
            <Check className="h-3.5 w-3.5" />
          </button>
        ) : (
          <span
            aria-label={done ? "Done" : "Not done yet"}
            className={cn(
              "mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center border",
              done ? "border-emerald-600 bg-emerald-600 text-white" : "border-slate-200 bg-slate-50 text-transparent",
            )}
            role="img"
          >
            <Check className="h-3.5 w-3.5" />
          </span>
        )}

        <div className="min-w-0 flex-1">
          <button
            className="block w-full text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500"
            onClick={() => onOpen(reminder)}
            type="button"
          >
            <span className={cn("block break-words text-sm font-bold text-slate-900", done ? "line-through decoration-slate-400" : "")}>
              {reminder.title}
            </span>
            {reminder.body ? (
              <span className="mt-1 block whitespace-pre-wrap break-words text-sm leading-relaxed text-slate-600">{reminder.body}</span>
            ) : null}
          </button>

          <div className="mt-2.5 flex flex-wrap items-center gap-x-3.5 gap-y-1.5">
            {reminder.remindOn ? (
              <span
                className={cn(
                  "inline-flex items-center gap-1 text-xs font-bold",
                  overdue ? "text-rose-700" : "text-orange-700",
                )}
              >
                <Clock className="h-3.5 w-3.5" />
                {overdue ? "Overdue · " : ""}
                {relativeDayLabel(reminder.remindOn, today)}
                {timeSpan ? ` · ${timeSpan}` : ""}
              </span>
            ) : null}
            <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-slate-600">
              <span className={MEDALLION}>{initialsOf(reminder.ownerName)}</span>
              {reminder.ownerName}
            </span>
            <SharingBadge reminder={reminder} />
            <button
              className="inline-flex items-center gap-1 text-xs font-bold text-slate-500 transition hover:text-orange-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500"
              onClick={() => onOpen(reminder)}
              type="button"
            >
              <MessageSquare className="h-3.5 w-3.5" />
              {reminder.commentCount === 0 ? "Comment" : `${reminder.commentCount} ${reminder.commentCount === 1 ? "comment" : "comments"}`}
            </button>
          </div>
        </div>

        {reminder.canChange ? (
          <button
            aria-label={`Edit "${reminder.title}"`}
            className="h-fit shrink-0 border border-transparent p-1.5 text-slate-400 transition hover:border-orange-200 hover:text-orange-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500"
            onClick={() => onEdit(reminder)}
            type="button"
          >
            <Pencil className="h-4 w-4" />
          </button>
        ) : null}
      </div>
    </article>
  );
}
