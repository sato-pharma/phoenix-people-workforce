"use client";

import { Calendar, CalendarDays, ChevronLeft, ChevronRight, Eye, Plus, StickyNote } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { adminSoftDepthClassName } from "@/components/admin/admin-design-tokens";
import { ReminderCard } from "@/components/hr-reminders/reminder-card";
import { MonthCalendar, WeekCalendar } from "@/components/hr-reminders/reminder-calendars";
import { ReminderEditor } from "@/components/hr-reminders/reminder-editor";
import { CONTROL_SKIN, TAB_BASE, TAB_OFF, TAB_ON } from "@/components/hr-reminders/reminder-style";
import { ReminderThread } from "@/components/hr-reminders/reminder-thread";
import { remindersApi } from "@/components/hr-reminders/reminders-api";
import { phxButtonAccentClassName, phxSelectClassName } from "@/components/ui/form-tokens";
import {
  addDays,
  addMonths,
  bucketForNotes,
  dayOfMonth,
  filterByOwner,
  formatDayLong,
  formatMonthTitle,
  monthName,
  weekOf,
} from "@/lib/hr-reminders/logic";
import type { ReminderBoardData, ReminderView } from "@/lib/hr-reminders/types";
import { cn } from "@/lib/utils";

type ViewKey = "notes" | "week" | "month";

const VIEWS: Array<{ icon: typeof StickyNote; key: ViewKey; label: string }> = [
  { icon: StickyNote, key: "notes", label: "Notes" },
  { icon: CalendarDays, key: "week", label: "Week" },
  { icon: Calendar, key: "month", label: "Month" },
];

const REFRESH_MIN_GAP_MS = 20_000;

function weekTitle(anchor: string): string {
  const days = weekOf(anchor);
  const first = days[0] as string;
  const last = days[6] as string;
  const sameMonthWeek = first.slice(0, 7) === last.slice(0, 7);
  return sameMonthWeek
    ? `${dayOfMonth(first)} – ${dayOfMonth(last)} ${monthName(last)} ${last.slice(0, 4)}`
    : `${dayOfMonth(first)} ${monthName(first)} – ${dayOfMonth(last)} ${monthName(last)} ${last.slice(0, 4)}`;
}

function Stat({ accent, label, value }: { accent: string; label: string; value: number }) {
  return (
    <div className={cn("relative border border-phx-line bg-white px-4 py-3", adminSoftDepthClassName)}>
      <span aria-hidden className={cn("absolute inset-x-0 top-0 h-0.5", accent)} />
      <p className="text-[10px] font-black uppercase tracking-[0.16em] text-slate-500">{label}</p>
      <p className="mt-1 text-2xl font-black leading-none text-slate-900">{value}</p>
    </div>
  );
}

function Section({ children, count, title, tone }: { children: ReactNode; count: number; title: string; tone: string }) {
  if (count === 0) return null;
  return (
    <section className="space-y-2.5">
      <h3 className={cn("flex items-center gap-2 text-[11px] font-black uppercase tracking-[0.16em]", tone)}>
        {title}
        <span className="border border-current px-1.5 py-px text-[10px]">{count}</span>
      </h3>
      <div className="grid grid-cols-1 gap-2.5 xl:grid-cols-2">{children}</div>
    </section>
  );
}

export function RemindersBoard({ initial, initialOpenId }: { initial: ReminderBoardData; initialOpenId: string | null }) {
  const { team, today, viewer } = initial;
  const [reminders, setReminders] = useState<ReminderView[]>(initial.reminders);
  const [view, setView] = useState<ViewKey>("notes");
  const [anchor, setAnchor] = useState(today);
  const [selectedDay, setSelectedDay] = useState<string | null>(today);
  const [owner, setOwner] = useState<string>("all");
  const [showDone, setShowDone] = useState(false);
  const [editor, setEditor] = useState<{ day: string | null; reminder: ReminderView | null } | null>(null);
  // A link from a notice can name a reminder this person may no longer be able to open.
  const linkedGone = Boolean(initialOpenId) && !initial.reminders.some((reminder) => reminder.id === initialOpenId);
  const [openId, setOpenId] = useState<string | null>(linkedGone ? null : initialOpenId);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(linkedGone ? "That reminder is no longer available to you." : null);
  const lastRefresh = useRef(0);

  const overseer = team.find((member) => member.isOverseer) ?? null;
  const visible = useMemo(() => filterByOwner(reminders, owner), [reminders, owner]);
  const buckets = useMemo(() => bucketForNotes(visible, today), [visible, today]);
  const opened = openId ? reminders.find((reminder) => reminder.id === openId) ?? null : null;

  const upsert = useCallback((reminder: ReminderView) => {
    setReminders((current) => {
      const index = current.findIndex((entry) => entry.id === reminder.id);
      if (index === -1) return [reminder, ...current];
      const next = [...current];
      next[index] = reminder;
      return next;
    });
  }, []);

  const refresh = useCallback(async () => {
    lastRefresh.current = Date.now();
    try {
      const fresh = await remindersApi<ReminderBoardData>("GET", "/api/hr-reminders");
      setReminders(fresh.reminders);
    } catch {
      // A failed background refresh keeps what is on screen; the next action reports its own error.
    }
  }, []);

  // A teammate may have written something while this tab sat in the background.
  useEffect(() => {
    function onVisible() {
      if (document.visibilityState === "visible" && Date.now() - lastRefresh.current > REFRESH_MIN_GAP_MS) void refresh();
    }
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [refresh]);

  async function toggle(reminder: ReminderView) {
    setPendingId(reminder.id);
    setNotice(null);
    try {
      const result = await remindersApi<{ reminder: ReminderView }>("PATCH", `/api/hr-reminders/${reminder.id}`, {
        status: reminder.status === "done" ? "open" : "done",
      });
      upsert(result.reminder);
    } catch (caught) {
      setNotice(caught instanceof Error ? caught.message : "That could not be saved.");
    } finally {
      setPendingId(null);
    }
  }

  async function remove(reminder: ReminderView) {
    await remindersApi<{ ok: true }>("DELETE", `/api/hr-reminders/${reminder.id}`);
    setReminders((current) => current.filter((entry) => entry.id !== reminder.id));
    setOpenId(null);
  }

  function commented(reminderId: string) {
    setReminders((current) =>
      current.map((entry) =>
        entry.id === reminderId
          ? { ...entry, commentCount: entry.commentCount + 1, lastCommentAt: new Date().toISOString() }
          : entry,
      ),
    );
  }

  function editFromAnywhere(reminder: ReminderView) {
    setOpenId(null);
    setEditor({ day: null, reminder });
  }

  function cardFor(reminder: ReminderView) {
    return (
      <ReminderCard
        key={reminder.id}
        onEdit={editFromAnywhere}
        onOpen={(target) => setOpenId(target.id)}
        onToggle={toggle}
        pending={pendingId === reminder.id}
        reminder={reminder}
        today={today}
      />
    );
  }

  function step(direction: -1 | 1) {
    if (view === "week") setAnchor((current) => addDays(current, direction * 7));
    if (view === "month") setAnchor((current) => addMonths(current, direction));
  }

  const dayItems = selectedDay ? visible.filter((reminder) => reminder.remindOn === selectedDay) : [];
  const dated = visible.filter((reminder) => reminder.remindOn !== null);
  const notesEmpty =
    buckets.overdue.length + buckets.today.length + buckets.upcoming.length + buckets.undated.length + buckets.done.length === 0;

  if (!initial.schemaReady) {
    return (
      <div className="border border-amber-200 bg-amber-50 p-5 text-sm font-semibold text-amber-900">
        HR Reminders is being switched on.
        <span className="mt-1 block font-normal">This page opens as soon as its tables are in place. Nothing is lost; try again in a few minutes.</span>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {notice ? (
        <p className="border border-rose-300 bg-rose-50 px-3 py-2 text-sm font-bold text-rose-800" role="alert">
          {notice}
        </p>
      ) : null}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat accent="bg-rose-500" label="Overdue" value={buckets.overdue.length} />
        <Stat accent="bg-orange-500" label="Today" value={buckets.today.length} />
        <Stat accent="bg-amber-500" label="Coming up" value={buckets.upcoming.length} />
        <Stat accent="bg-slate-400" label="Notes" value={buckets.undated.length} />
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-2" role="tablist" aria-label="Views">
          {VIEWS.map(({ icon: Icon, key, label }) => (
            <button
              aria-selected={view === key}
              className={cn(TAB_BASE, view === key ? TAB_ON : TAB_OFF)}
              key={key}
              onClick={() => setView(key)}
              role="tab"
              type="button"
            >
              <Icon className="h-4 w-4" /> {label}
            </button>
          ))}
        </div>

        <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
          <div className="min-w-0 flex-1 sm:w-56 sm:flex-none">
            <label className="sr-only" htmlFor="reminder-owner">
              Whose reminders
            </label>
            <select className={phxSelectClassName} id="reminder-owner" onChange={(event) => setOwner(event.target.value)} value={owner}>
              <option value="all">Everyone I can see</option>
              <option value={viewer.hrId}>Only mine</option>
              {team
                .filter((member) => member.hrId.toLowerCase() !== viewer.hrId.toLowerCase())
                .map((member) => (
                  <option key={member.hrId} value={member.hrId}>
                    {member.name}
                  </option>
                ))}
            </select>
          </div>
          <button
            className={phxButtonAccentClassName}
            onClick={() => setEditor({ day: view === "notes" ? null : selectedDay ?? today, reminder: null })}
            type="button"
          >
            <Plus className="h-4 w-4" /> New reminder
          </button>
        </div>
      </div>

      <p className="flex items-start gap-2 text-xs text-slate-500">
        <Eye className="mt-0.5 h-3.5 w-3.5 shrink-0 text-slate-400" />
        {viewer.isOverseer
          ? "You see every reminder on the team, whatever its sharing."
          : `Only you see your private reminders${overseer ? `, and ${overseer.name}, the HR Manager,` : ", and the HR Manager,"} always sees everything.`}
      </p>

      {view !== "notes" ? (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-lg font-black tracking-tight text-slate-900">{view === "week" ? weekTitle(anchor) : formatMonthTitle(anchor)}</h2>
          <div className="flex items-center gap-2">
            <button aria-label={view === "week" ? "Previous week" : "Previous month"} className={cn("p-2 text-slate-500", CONTROL_SKIN)} onClick={() => step(-1)} type="button">
              <ChevronLeft className="h-4 w-4" />
            </button>
            <button
              className={cn("px-3 py-2 text-sm font-bold text-slate-600", CONTROL_SKIN)}
              onClick={() => {
                setAnchor(today);
                setSelectedDay(today);
              }}
              type="button"
            >
              Today
            </button>
            <button aria-label={view === "week" ? "Next week" : "Next month"} className={cn("p-2 text-slate-500", CONTROL_SKIN)} onClick={() => step(1)} type="button">
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>
        </div>
      ) : null}

      {view === "notes" ? (
        <div className="space-y-6">
          {notesEmpty ? (
            <div className="border border-dashed border-slate-300 bg-white px-6 py-12 text-center">
              <p className="text-base font-black text-slate-900">Nothing here yet</p>
              <p className="mx-auto mt-1 max-w-md text-sm text-slate-500">
                Write a note, or give it a day and it lands on the week and month calendars too. Share it with a teammate and you can talk about it underneath.
              </p>
              <button className={cn(phxButtonAccentClassName, "mt-4")} onClick={() => setEditor({ day: null, reminder: null })} type="button">
                <Plus className="h-4 w-4" /> Add the first reminder
              </button>
            </div>
          ) : null}
          <Section count={buckets.overdue.length} title="Overdue" tone="text-rose-700">
            {buckets.overdue.map(cardFor)}
          </Section>
          <Section count={buckets.today.length} title="Today" tone="text-orange-700">
            {buckets.today.map(cardFor)}
          </Section>
          <Section count={buckets.upcoming.length} title="Coming up" tone="text-slate-700">
            {buckets.upcoming.map(cardFor)}
          </Section>
          <Section count={buckets.undated.length} title="Notes" tone="text-slate-700">
            {buckets.undated.map(cardFor)}
          </Section>
          {buckets.done.length > 0 ? (
            <div className="space-y-3">
              <button
                aria-expanded={showDone}
                className={cn("px-3 py-2 text-sm font-bold text-slate-600", CONTROL_SKIN)}
                onClick={() => setShowDone((current) => !current)}
                type="button"
              >
                {showDone ? "Hide" : "Show"} {buckets.done.length} finished
              </button>
              {showDone ? (
                <Section count={buckets.done.length} title="Finished" tone="text-emerald-700">
                  {buckets.done.map(cardFor)}
                </Section>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}

      {view === "week" ? (
        <WeekCalendar
          anchor={anchor}
          onAdd={(day) => setEditor({ day, reminder: null })}
          onOpen={(reminder) => setOpenId(reminder.id)}
          reminders={dated}
          today={today}
          viewerHrId={viewer.hrId}
        />
      ) : null}

      {view === "month" ? (
        <div className="space-y-4">
          <MonthCalendar
            anchor={anchor}
            onOpen={(reminder) => setOpenId(reminder.id)}
            onSelectDay={setSelectedDay}
            reminders={dated}
            selectedDay={selectedDay}
            today={today}
            viewerHrId={viewer.hrId}
          />
          {selectedDay ? (
            <section className="space-y-2.5" aria-label={formatDayLong(selectedDay)}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="text-sm font-black text-slate-900">{formatDayLong(selectedDay)}</h3>
                <button
                  className={cn("inline-flex items-center gap-1.5 px-3 py-2 text-sm font-bold text-slate-600", CONTROL_SKIN)}
                  onClick={() => setEditor({ day: selectedDay, reminder: null })}
                  type="button"
                >
                  <Plus className="h-4 w-4" /> Add on this day
                </button>
              </div>
              {dayItems.length === 0 ? (
                <p className="border border-dashed border-slate-300 bg-white px-4 py-4 text-sm text-slate-500">Nothing planned for this day.</p>
              ) : (
                <div className="grid grid-cols-1 gap-2.5 xl:grid-cols-2">{dayItems.map(cardFor)}</div>
              )}
            </section>
          ) : null}
        </div>
      ) : null}

      {editor ? (
        <ReminderEditor
          defaultDay={editor.day}
          initial={editor.reminder}
          onClose={() => setEditor(null)}
          onSaved={(reminder) => {
            upsert(reminder);
            setEditor(null);
          }}
          team={team}
          viewer={viewer}
        />
      ) : null}

      {opened ? (
        <ReminderThread
          onClose={() => setOpenId(null)}
          onCommented={commented}
          onDelete={remove}
          onEdit={editFromAnywhere}
          onToggle={toggle}
          reminder={opened}
          team={team}
          today={today}
        />
      ) : null}
    </div>
  );
}
