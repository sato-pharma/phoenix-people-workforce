"use client";

import { useMemo, useState, useSyncExternalStore, useTransition } from "react";
import { createPortal } from "react-dom";
import { CalendarDays, ChevronLeft, ChevronRight, Clock, MapPin, Plus, Trash2, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  calendarEventCategories,
  type CalendarEventCategory,
  type CalendarItem,
  type CompanyCalendarEventInput,
} from "@/lib/calendar/logic";
import type { CompanyCalendarWorkspace } from "@/lib/calendar/service";
import { currentCairoDateOnlyIso, currentCairoDateParts } from "@/lib/i18n/format";
import { SearchableSelect } from "@/components/ui/searchable-select";
import {
  phxFieldClassName,
  phxTextareaClassName,
} from "@/components/ui/form-tokens";
import { cn } from "@/lib/utils";
import { adminSoftDepthClassName } from "@/components/admin/admin-design-tokens";


const emptySubscribe = () => () => {};

const TONES: Record<string, { chip: string; dot: string }> = {
  sky: { chip: "border-sky-200 bg-sky-50 text-sky-700", dot: "bg-sky-500" },
  violet: { chip: "border-violet-200 bg-violet-50 text-violet-700", dot: "bg-violet-500" },
  orange: { chip: "border-orange-200 bg-orange-50 text-orange-700", dot: "bg-orange-500" },
  amber: { chip: "border-amber-200 bg-amber-50 text-amber-800", dot: "bg-amber-500" },
  red: { chip: "border-red-200 bg-red-50 text-red-700", dot: "bg-red-500" },
  emerald: { chip: "border-emerald-200 bg-emerald-50 text-emerald-700", dot: "bg-emerald-500" },
  blue: { chip: "border-blue-200 bg-blue-50 text-blue-700", dot: "bg-blue-500" },
  pink: { chip: "border-pink-200 bg-pink-50 text-pink-700", dot: "bg-pink-500" },
  indigo: { chip: "border-indigo-200 bg-indigo-50 text-indigo-700", dot: "bg-indigo-500" },
  slate: { chip: "border-slate-200 bg-slate-50 text-slate-700", dot: "bg-slate-400" },
};

const CATEGORY_TONE: Record<CalendarEventCategory, string> = {
  meeting: "sky",
  training: "violet",
  event: "orange",
  announcement: "amber",
  deadline: "red",
  holiday: "emerald",
  other: "slate",
};

function toneFor(item: CalendarItem) {
  if (item.source === "holiday") return TONES.emerald;
  if (item.source === "leave") return TONES.blue;
  if (item.source === "birthday") return TONES.pink;
  if (item.source === "plan") return TONES.indigo;
  return TONES[CATEGORY_TONE[item.category]] ?? TONES.slate;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function todayIso() {
  return currentCairoDateOnlyIso();
}

// DATE-ONLY (a month label off a synthetic `Date.UTC`; the selected-day heading further down is the
// same case), which `new Date` parses as UTC midnight. UTC here is CORRECT and must stay: it is what
// stops the calendar day being shifted by a zone offset. Not an instant — do not "fix" this one to
// Cairo.
function monthLabel(year: number, month: number) {
  return new Intl.DateTimeFormat("en", { month: "long", year: "numeric", timeZone: "UTC" }).format(
    new Date(Date.UTC(year, month - 1, 1)),
  );
}

type EditorState = {
  id: string | null;
  title: string;
  category: CalendarEventCategory;
  startDate: string;
  endDate: string;
  allDay: boolean;
  startTime: string;
  endTime: string;
  scope: "company" | "line";
  location: string;
  description: string;
};

function blankEditor(date: string): EditorState {
  return {
    id: null,
    title: "",
    category: "event",
    startDate: date,
    endDate: date,
    allDay: true,
    startTime: "",
    endTime: "",
    scope: "company",
    location: "",
    description: "",
  };
}

export function CompanyCalendar({
  initialWorkspace,
}: {
  initialWorkspace: CompanyCalendarWorkspace;
}) {
  const [workspace, setWorkspace] = useState(initialWorkspace);
  const [selectedDate, setSelectedDate] = useState<string>(todayIso());
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const mounted = useSyncExternalStore(emptySubscribe, () => true, () => false);

  const { year, month, weeks, items, canManage, canPublishCompanyWide, viewerLineName } = workspace;
  const today = todayIso();

  const itemsByDay = useMemo(() => {
    const map = new Map<string, CalendarItem[]>();
    for (const week of weeks) {
      for (const day of week) {
        if (!day.date) continue;
        const dayItems = items.filter((item) => day.date! >= item.startDate && day.date! <= item.endDate);
        if (dayItems.length) map.set(day.date, dayItems);
      }
    }
    return map;
  }, [weeks, items]);

  const selectedItems = useMemo(
    () => items.filter((item) => selectedDate >= item.startDate && selectedDate <= item.endDate),
    [items, selectedDate],
  );

  async function loadMonth(nextYear: number, nextMonth: number) {
    const response = await fetch(`/api/calendar?year=${nextYear}&month=${nextMonth}`, { cache: "no-store" });
    const payload = await response.json();
    if (payload.success) setWorkspace(payload.data);
  }

  function shiftMonth(delta: number) {
    const base = new Date(Date.UTC(year, month - 1 + delta, 1));
    setMessage(null);
    startTransition(() => loadMonth(base.getUTCFullYear(), base.getUTCMonth() + 1));
  }

  function goToday() {
    const { year: todayYear, month: todayMonth } = currentCairoDateParts();
    setSelectedDate(todayIso());
    setMessage(null);
    startTransition(() => loadMonth(todayYear, todayMonth));
  }

  function openCreate() {
    const editorState = blankEditor(selectedDate);
    if (!canPublishCompanyWide) editorState.scope = "line";
    setEditor(editorState);
  }

  function openEdit(item: CalendarItem) {
    if (item.source !== "event" || !item.canManage) return;
    setEditor({
      id: item.id,
      title: item.title,
      category: item.category,
      startDate: item.startDate,
      endDate: item.endDate,
      allDay: item.time === null,
      startTime: item.time?.split(" - ")[0] ?? "",
      endTime: item.time?.split(" - ")[1] ?? "",
      scope: item.scope,
      location: item.location ?? "",
      description: item.description ?? "",
    });
  }

  async function saveEditor() {
    if (!editor) return;
    const payload: CompanyCalendarEventInput = {
      title: editor.title,
      category: editor.category,
      startDate: editor.startDate,
      endDate: editor.endDate,
      allDay: editor.allDay,
      startTime: editor.allDay ? null : editor.startTime || null,
      endTime: editor.allDay ? null : editor.endTime || null,
      audienceScope: canPublishCompanyWide ? editor.scope : "line",
      location: editor.location || null,
      description: editor.description || null,
    };
    const endpoint = editor.id ? `/api/calendar/${editor.id}` : "/api/calendar";
    const response = await fetch(endpoint, {
      body: JSON.stringify(payload),
      headers: { "Content-Type": "application/json" },
      method: editor.id ? "PATCH" : "POST",
    });
    const result = await response.json();
    if (!response.ok || !result.success) throw new Error(result.message ?? "Unable to save the event.");
    setEditor(null);
    setMessage(editor.id ? "Event updated." : "Event added to the calendar.");
    await loadMonth(year, month);
  }

  async function deleteEditor() {
    if (!editor?.id) return;
    const response = await fetch(`/api/calendar/${editor.id}`, { method: "DELETE" });
    const result = await response.json();
    if (!response.ok || !result.success) throw new Error(result.message ?? "Unable to delete the event.");
    setEditor(null);
    setMessage("Event deleted.");
    await loadMonth(year, month);
  }

  function run(action: () => Promise<void>) {
    setMessage(null);
    startTransition(async () => {
      try {
        await action();
      } catch (error) {
        setMessage(error instanceof Error ? error.message : "Action failed.");
      }
    });
  }

  return (
    <div className="space-y-4">
      {!workspace.schemaReady ? (
        <div className="rounded border border-amber-200 bg-amber-50 p-3 text-sm font-semibold text-amber-800">
          Calendar database migration is not applied yet — showing holidays, leave, and birthdays only.
        </div>
      ) : null}

      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-200 bg-white p-3 shadow-sm">
        <div className="flex items-center gap-2">
          <button
            aria-label="Previous month"
            className="flex h-9 w-9 items-center justify-center rounded border border-slate-200 text-slate-600 active:bg-slate-50"
            disabled={isPending}
            onClick={() => shiftMonth(-1)}
            type="button"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
          <h2 className="min-w-[9rem] text-center text-base font-black text-slate-900">
            {monthLabel(year, month)}
          </h2>
          <button
            aria-label="Next month"
            className="flex h-9 w-9 items-center justify-center rounded border border-slate-200 text-slate-600 active:bg-slate-50"
            disabled={isPending}
            onClick={() => shiftMonth(1)}
            type="button"
          >
            <ChevronRight className="h-4 w-4" />
          </button>
          <button
            className="ml-1 rounded border border-slate-200 px-3 py-1.5 text-xs font-bold text-slate-600 active:bg-slate-50"
            disabled={isPending}
            onClick={goToday}
            type="button"
          >
            Today
          </button>
        </div>
        {canManage ? (
          <Button disabled={isPending} onClick={openCreate}>
            <Plus className="mr-2 h-4 w-4" />
            Add event
          </Button>
        ) : null}
      </div>

      {message ? (
        <div className="rounded border border-sky-200 bg-sky-50 p-3 text-sm font-semibold text-sky-800">
          {message}
        </div>
      ) : null}

      {/* Grid */}
      <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
        <div className="grid grid-cols-7 border-b border-slate-100 bg-slate-50">
          {WEEKDAYS.map((day) => (
            <div className="px-1 py-2 text-center text-phx-sm font-black uppercase tracking-wide text-slate-400" key={day}>
              {day}
            </div>
          ))}
        </div>
        <div className="grid grid-cols-7">
          {weeks.flat().map((day, index) => {
            const dayItems = day.date ? itemsByDay.get(day.date) ?? [] : [];
            const isToday = day.date === today;
            const isSelected = day.date === selectedDate;
            return (
              <button
                className={`min-h-[60px] border-b border-r border-slate-100 p-1 text-left align-top transition-colors sm:min-h-[88px] ${
                  day.inMonth ? "bg-white" : "bg-slate-50/50"
                } ${isSelected ? "ring-2 ring-inset ring-orange-400" : "hover:bg-orange-50/30"}`}
                disabled={!day.date}
                key={day.date ?? `cell-${index}`}
                onClick={() => day.date && setSelectedDate(day.date)}
                type="button"
              >
                <div className="flex items-center justify-between">
                  <span
                    className={`flex h-5 w-5 items-center justify-center rounded-full text-phx-xs font-bold ${
                      isToday ? "bg-orange-600 text-white" : day.inMonth ? "text-slate-700" : "text-slate-300"
                    }`}
                  >
                    {day.date ? Number(day.date.slice(8, 10)) : ""}
                  </span>
                  {dayItems.length > 0 ? (
                    <span className="text-phx-xs font-black text-slate-400 sm:hidden">{dayItems.length}</span>
                  ) : null}
                </div>
                {/* Mobile: dots. Desktop: labels. */}
                <div className="mt-1 hidden space-y-0.5 sm:block">
                  {dayItems.slice(0, 3).map((item) => (
                    <div
                      className={`whitespace-nowrap rounded border px-1 py-0.5 text-phx-xs font-bold ${toneFor(item).chip}`}
                      key={item.id}
                    >
                      {item.title}
                    </div>
                  ))}
                  {dayItems.length > 3 ? (
                    <div className="px-1 text-phx-xs font-bold text-slate-400">+{dayItems.length - 3} more</div>
                  ) : null}
                </div>
                <div className="mt-1 flex flex-wrap gap-0.5 sm:hidden">
                  {dayItems.slice(0, 4).map((item) => (
                    <span className={`h-1.5 w-1.5 rounded-full ${toneFor(item).dot}`} key={item.id} />
                  ))}
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {/* Selected day detail */}
      <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <div className="mb-3 flex items-center gap-2">
          <CalendarDays className="h-4 w-4 text-orange-500" />
          <h3 className="text-sm font-black text-slate-900">
            {new Intl.DateTimeFormat("en", {
              weekday: "long",
              day: "numeric",
              month: "long",
              timeZone: "UTC",
            }).format(new Date(`${selectedDate}T00:00:00Z`))}
          </h3>
        </div>
        {selectedItems.length === 0 ? (
          <p className="text-sm font-semibold text-slate-400">Nothing scheduled for this day.</p>
        ) : (
          <ul className="space-y-2">
            {selectedItems.map((item) => {
              const tone = toneFor(item);
              return (
                <li
                  className={`flex items-start justify-between gap-2 rounded border p-2.5 ${tone.chip}`}
                  key={item.id}
                >
                  <div className="min-w-0">
                    <p className="whitespace-nowrap text-sm font-black">{item.title}</p>
                    <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-phx-xs font-semibold opacity-80">
                      <span className="capitalize">{item.source === "event" ? item.category : item.source}</span>
                      {item.time ? (
                        <span className="inline-flex items-center gap-1">
                          <Clock className="h-3 w-3" />
                          {item.time}
                        </span>
                      ) : null}
                      {item.location ? (
                        <span className="inline-flex items-center gap-1">
                          <MapPin className="h-3 w-3" />
                          {item.location}
                        </span>
                      ) : null}
                      {item.scope === "line" && item.lineName ? <span>{item.lineName}</span> : null}
                    </div>
                    {item.description ? <p className="mt-1 text-xs opacity-80">{item.description}</p> : null}
                  </div>
                  {item.source === "event" && item.canManage ? (
                    <button
                      className="shrink-0 rounded border border-black/10 bg-white/60 px-2 py-1 text-phx-xs font-bold"
                      onClick={() => openEdit(item)}
                      type="button"
                    >
                      Edit
                    </button>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {/* Event editor (portaled to escape the page-transition transform) */}
      {mounted && editor
        ? createPortal(
            <div className="fixed inset-0 z-50">
              <button
                aria-label="Close"
                className="absolute inset-0 bg-slate-900/40 backdrop-blur-sm"
                onClick={() => setEditor(null)}
                type="button"
              />
              <div
                className="absolute inset-x-0 bottom-0 mx-auto max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-t-2xl border-t border-slate-200 bg-white shadow-2xl sm:inset-x-auto sm:bottom-auto sm:left-1/2 sm:top-1/2 sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-2xl"
                style={{ paddingBottom: "calc(env(safe-area-inset-bottom) + 16px)" }}
              >
                <div className="sticky top-0 flex items-center justify-between border-b border-slate-100 bg-white px-4 py-3">
                  <h3 className="text-sm font-black text-slate-900">{editor.id ? "Edit event" : "New event"}</h3>
                  <button
                    aria-label="Close"
                    className="rounded-full p-1.5 text-slate-400 active:bg-slate-100"
                    onClick={() => setEditor(null)}
                    type="button"
                  >
                    <X className="h-5 w-5" />
                  </button>
                </div>
                <div className="space-y-3 px-4 py-4">
                  <Field label="Title">
                    <input
                      className={inputCls}
                      onChange={(e) => setEditor({ ...editor, title: e.target.value })}
                      placeholder="e.g. Cycle meeting"
                      value={editor.title}
                    />
                  </Field>
                  <div className="grid grid-cols-2 gap-3">
                    <Field label="Category">
                      <SearchableSelect
                        className={inputCls}
                        onChange={(e) => setEditor({ ...editor, category: e.target.value as CalendarEventCategory })}
                        value={editor.category}
                      >
                        {calendarEventCategories.map((category) => (
                          <option key={category} value={category}>
                            {category}
                          </option>
                        ))}
                      </SearchableSelect>
                    </Field>
                    <Field label="Audience">
                      {canPublishCompanyWide ? (
                        <SearchableSelect
                          className={inputCls}
                          onChange={(e) => setEditor({ ...editor, scope: e.target.value as "company" | "line" })}
                          value={editor.scope}
                        >
                          <option value="company">Whole company</option>
                          <option value="line">My team / line</option>
                        </SearchableSelect>
                      ) : (
                        <div className={`flex h-11 items-center rounded border border-slate-200 bg-slate-50 px-3 text-sm font-semibold text-slate-500 ${adminSoftDepthClassName}`}>
                          {viewerLineName ? `Team: ${viewerLineName}` : "Your team line"}
                        </div>
                      )}
                    </Field>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <Field label="Start date">
                      <input
                        className={inputCls}
                        onChange={(e) => setEditor({ ...editor, startDate: e.target.value, endDate: editor.endDate < e.target.value ? e.target.value : editor.endDate })}
                        type="date"
                        value={editor.startDate}
                      />
                    </Field>
                    <Field label="End date">
                      <input
                        className={inputCls}
                        min={editor.startDate}
                        onChange={(e) => setEditor({ ...editor, endDate: e.target.value })}
                        type="date"
                        value={editor.endDate}
                      />
                    </Field>
                  </div>
                  <label className="flex items-center gap-2 text-sm font-semibold text-slate-700">
                    <input
                      checked={editor.allDay}
                      onChange={(e) => setEditor({ ...editor, allDay: e.target.checked })}
                      type="checkbox"
                    />
                    All-day
                  </label>
                  {!editor.allDay ? (
                    <div className="grid grid-cols-2 gap-3">
                      <Field label="Start time">
                        <input
                          className={inputCls}
                          onChange={(e) => setEditor({ ...editor, startTime: e.target.value })}
                          type="time"
                          value={editor.startTime}
                        />
                      </Field>
                      <Field label="End time">
                        <input
                          className={inputCls}
                          onChange={(e) => setEditor({ ...editor, endTime: e.target.value })}
                          type="time"
                          value={editor.endTime}
                        />
                      </Field>
                    </div>
                  ) : null}
                  <Field label="Location (optional)">
                    <input
                      className={inputCls}
                      onChange={(e) => setEditor({ ...editor, location: e.target.value })}
                      placeholder="e.g. HQ meeting room"
                      value={editor.location}
                    />
                  </Field>
                  <Field label="Description (optional)">
                    <textarea
                      className={cn(phxTextareaClassName, "min-h-20")}
                      onChange={(e) => setEditor({ ...editor, description: e.target.value })}
                      value={editor.description}
                    />
                  </Field>
                  <div className="flex gap-2 pt-1">
                    {editor.id ? (
                      <Button className="flex-1" disabled={isPending} onClick={() => run(deleteEditor)} variant="destructive">
                        <Trash2 className="mr-2 h-4 w-4" />
                        Delete
                      </Button>
                    ) : null}
                    <Button
                      className="flex-1"
                      disabled={isPending || editor.title.trim().length === 0}
                      onClick={() => run(saveEditor)}
                    >
                      {editor.id ? "Save" : "Add event"}
                    </Button>
                  </div>
                </div>
              </div>
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}

const inputCls  = phxFieldClassName;

function Field({ children, label }: { children: React.ReactNode; label: string }) {
  return (
    <label className="block">
      <span className="mb-1 block text-phx-xs font-black uppercase tracking-[0.08em] text-slate-500">{label}</span>
      {children}
    </label>
  );
}
