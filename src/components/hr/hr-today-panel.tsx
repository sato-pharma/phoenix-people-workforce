"use client";

/**
 * "Your day" — the HR command centre's opening panel.
 *
 * WHAT IT REPLACED, AND WHY. This was a ring reading "5 of 18 waiting" over four bar charts. Every
 * number in it was true and none of them was work: the denominator counted TILES, the numerator
 * counted how many of those tiles were coloured, and one of the five was lit because it held a
 * zero. The owner's verdict on 2026-09-01 was that it showed nothing. What a seat needs on opening
 * her own landing page is the list — this candidate, that probation case, those seats — so the
 * panel is now a list of tasks that opens into the actual named rows behind each one.
 *
 * PRESS A TASK, THE WORK APPEARS. That was the owner's own description of what he wanted, and it
 * is the whole interaction: every task is a disclosure button, and inside are real records, each a
 * link to the page that actions it. The most urgent task opens by default, because a board that
 * makes you click before it tells you anything has only moved the problem down one level.
 *
 * DESIGN IDENTITY is the admin shell's, not a new one (AGENTS.md §4). The orange dot and 9px
 * uppercase micro-labels are `AdminSectionHeader`'s and `MetricTile`'s; the tones are the same four
 * the tiles use; the figures are `tabular-nums font-black` exactly as everywhere else. What is new
 * is the ROW, and it is a row rather than a card because a task is a line of work, not a statistic.
 *
 * NEVER A HORIZONTAL SCROLL (owner's golden rule, 2026-09-01). There is no table, no `min-width`,
 * and no `overflow-x-auto` anywhere in this file. Every row is flex-wrap, every long value carries
 * `break-words`, and the name / context / age of an item stack onto their own lines on a phone
 * rather than sitting behind a sideways drag. Wrapping is the permitted answer; nothing is ever
 * truncated with an ellipsis.
 */

import { ArrowUpRight, Check, ChevronDown, type LucideIcon } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";

import type { HrTask, HrTaskUrgency } from "@/lib/hr/today-tasks";

/** Rank for sorting. Overdue first, then what is merely waiting, then what is done. */
const URGENCY_RANK: Record<HrTaskUrgency, number> = {
  clear: 2,
  due: 1,
  overdue: 0,
};

const URGENCY_STYLES: Record<
  HrTaskUrgency,
  { badge: string; count: string; icon: string; rail: string }
> = {
  clear: {
    badge: "border-emerald-200 bg-emerald-50 text-emerald-700",
    count: "text-emerald-600",
    icon: "border-emerald-200 bg-emerald-50 text-emerald-600",
    rail: "bg-emerald-400",
  },
  due: {
    badge: "border-amber-200 bg-amber-50 text-amber-800",
    count: "text-amber-700",
    icon: "border-amber-200 bg-amber-50 text-amber-700",
    rail: "bg-amber-400",
  },
  overdue: {
    badge: "border-rose-200 bg-rose-50 text-rose-800",
    count: "text-rose-700",
    icon: "border-rose-200 bg-rose-50 text-rose-700",
    rail: "bg-rose-500",
  },
};

/**
 * The one sentence at the top. Built from the tasks themselves so it can never disagree with the
 * list below it, and phrased in items of work — never in tiles, which is what the old ring counted.
 */
function summarise(tasks: HrTask[]): { headline: string; tone: HrTaskUrgency } {
  const waiting = tasks.filter((task) => task.urgency !== "clear");
  const overdue = tasks.filter((task) => task.urgency === "overdue");
  const items = waiting.reduce((total, task) => total + task.count, 0);

  if (waiting.length === 0) {
    return {
      headline: "Nothing is waiting on you. Every queue on your desk is clear.",
      tone: "clear",
    };
  }

  const itemWord = items === 1 ? "item" : "items";
  const taskWord = waiting.length === 1 ? "task" : "tasks";
  const base = `${items.toLocaleString("en-US")} ${itemWord} across ${waiting.length} ${taskWord} are waiting on you.`;

  if (overdue.length === 0) return { headline: base, tone: "due" };

  const overdueWord = overdue.length === 1 ? "one has" : `${overdue.length} have`;
  return {
    headline: `${base} Of those, ${overdueWord} been waiting long enough to need you first.`,
    tone: "overdue",
  };
}

function CountPill({ count, urgency }: { count: number; urgency: HrTaskUrgency }) {
  const styles = URGENCY_STYLES[urgency];
  return (
    <span
      className={`inline-flex items-center whitespace-nowrap rounded-full border px-2.5 py-0.5 text-[11px] font-black tabular-nums ${styles.badge}`}
    >
      {count.toLocaleString("en-US")}
    </span>
  );
}

function TaskRow({
  icon: Icon,
  isOpen,
  onToggle,
  task,
}: {
  icon: LucideIcon;
  isOpen: boolean;
  onToggle: () => void;
  task: HrTask;
}) {
  const styles = URGENCY_STYLES[task.urgency];
  const panelId = `hr-task-${task.key}`;
  const hidden = task.totalItems - task.items.length;

  return (
    <li className="relative">
      {/* The urgency rail. Full-height, 3px, so a row's state reads before its words do. */}
      <span aria-hidden="true" className={`absolute inset-y-0 left-0 w-[3px] ${styles.rail}`} />

      <button
        aria-controls={panelId}
        aria-expanded={isOpen}
        className="group flex w-full items-start gap-3 px-4 py-4 text-left transition-colors duration-200 hover:bg-slate-50/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-orange-500 sm:gap-4 sm:px-5"
        onClick={onToggle}
        type="button"
      >
        <span
          className={`mt-0.5 inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border ${styles.icon}`}
        >
          <Icon aria-hidden="true" className="h-4 w-4" />
        </span>

        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="break-words text-[13px] font-black leading-snug text-slate-900">
              {task.title}
            </span>
            <CountPill count={task.count} urgency={task.urgency} />
          </span>
          <span className="mt-1.5 block break-words text-[11px] font-medium leading-5 text-slate-500">
            {task.detail}
          </span>
        </span>

        <ChevronDown
          aria-hidden="true"
          className={`mt-1 h-4 w-4 shrink-0 text-slate-400 transition-transform duration-200 group-hover:text-slate-600 ${
            isOpen ? "rotate-180" : ""
          }`}
        />
      </button>

      {isOpen ? (
        <div
          className="border-t border-slate-200/70 bg-gradient-to-b from-slate-50/90 to-white px-4 pb-4 pt-3 sm:px-5"
          id={panelId}
        >
          {task.count === 0 ? (
            <p className="flex flex-wrap items-center gap-2 py-1 text-[12px] font-semibold text-emerald-700">
              <Check aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
              <span className="break-words">{task.clearLabel}</span>
            </p>
          ) : (
            <ul className="divide-y divide-slate-200/70">
              {task.items.map((item) => (
                <li key={item.id}>
                  <Link
                    className="group/item flex flex-wrap items-baseline gap-x-3 gap-y-1 py-2.5 transition-colors duration-150 hover:bg-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500"
                    href={item.href}
                  >
                    <span className="break-words text-[12.5px] font-bold leading-snug text-slate-900">
                      {item.name}
                    </span>
                    {item.meta ? (
                      <span className="break-words text-[11px] font-medium leading-snug text-slate-500">
                        {item.meta}
                      </span>
                    ) : null}
                    {item.age ? (
                      <span
                        className={`ml-auto whitespace-nowrap text-[10px] font-black uppercase tracking-[0.1em] ${
                          item.urgent ? "text-rose-600" : "text-slate-400"
                        }`}
                      >
                        {item.age}
                      </span>
                    ) : null}
                    <ArrowUpRight
                      aria-hidden="true"
                      className="h-3.5 w-3.5 shrink-0 text-orange-400 opacity-0 transition-opacity duration-150 group-hover/item:opacity-100"
                    />
                  </Link>
                </li>
              ))}
            </ul>
          )}

          {/* Never a silent cap: when the list is longer than the preview, it says so and how many. */}
          <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1.5 border-t border-slate-200/70 pt-3">
            {hidden > 0 ? (
              <span className="break-words text-[10px] font-black uppercase tracking-[0.12em] text-slate-400">
                Showing {task.items.length} of {task.totalItems.toLocaleString("en-US")}
              </span>
            ) : null}
            <Link
              className="inline-flex items-center gap-1 whitespace-nowrap text-[11px] font-black uppercase tracking-[0.1em] text-orange-600 transition-colors hover:text-orange-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500"
              href={task.href}
            >
              {task.hrefLabel}
              <ArrowUpRight aria-hidden="true" className="h-3.5 w-3.5" />
            </Link>
          </div>
        </div>
      ) : null}
    </li>
  );
}

/**
 * The queues with nothing in them, as one line instead of four empty rows.
 *
 * The owner's rule for this page type is "relevant even if empty" — a clear queue must still be
 * NAMED, because "no employee has written to HR" and "we do not track that" look identical when
 * the row is missing. But four full-height rows each reading 0, at the top of the page, is what he
 * called rubbish, and he was right: on the day this was built five of the nine tasks were clear,
 * so more than half the panel was dead weight above the work.
 *
 * So every clear queue keeps its name and its link and loses its row. Nothing is hidden and no
 * count is dropped; the ones with nothing in them simply stop taking the space of the ones that do.
 */
function ClearStrip({ tasks }: { tasks: HrTask[] }) {
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-slate-200/70 bg-emerald-50/40 px-4 py-3.5 sm:px-5">
      <span className="inline-flex shrink-0 items-center gap-2">
        <Check aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-emerald-600" />
        <span className="whitespace-nowrap text-[10px] font-black uppercase tracking-[0.12em] text-emerald-700">
          {tasks.length} {tasks.length === 1 ? "queue is" : "queues are"} clear
        </span>
      </span>
      <span className="flex flex-wrap items-center gap-1.5">
        {tasks.map((task) => (
          <Link
            className="inline-flex items-center gap-1 whitespace-nowrap border border-emerald-200/80 bg-white px-2 py-1 text-[10px] font-bold text-emerald-800 transition-colors hover:border-emerald-300 hover:bg-emerald-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500"
            href={task.href}
            key={task.key}
            title={task.clearLabel}
          >
            {task.subject}
          </Link>
        ))}
      </span>
    </li>
  );
}

export function HrTodayPanel({
  icons,
  tasks,
}: {
  /** The seat's function icons, passed in so this file holds no second copy of that map. */
  icons: Record<string, LucideIcon>;
  tasks: HrTask[];
}) {
  const ordered = useMemo(
    () =>
      [...tasks].sort((a, b) => {
        const rank = URGENCY_RANK[a.urgency] - URGENCY_RANK[b.urgency];
        return rank !== 0 ? rank : b.count - a.count;
      }),
    [tasks],
  );

  const waiting = useMemo(() => ordered.filter((task) => task.urgency !== "clear"), [ordered]);
  const clear = useMemo(() => ordered.filter((task) => task.urgency === "clear"), [ordered]);

  const summary = useMemo(() => summarise(tasks), [tasks]);

  // The most urgent task opens on arrival. Deterministic from props, so the server and the client
  // agree on the first render.
  const [openKeys, setOpenKeys] = useState<Set<string>>(() => {
    const first = ordered.find((task) => task.urgency !== "clear");
    return new Set(first ? [first.key] : []);
  });

  const toggle = (key: string) => {
    setOpenKeys((previous) => {
      const next = new Set(previous);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  if (ordered.length === 0) return null;

  return (
    <section className="border-b border-slate-200/70 bg-white">
      <div className="px-4 py-5 sm:px-6">
        <div className="flex flex-wrap items-center gap-2.5">
          <span className="h-2 w-2 shrink-0 rounded-full bg-gradient-to-r from-orange-500 to-amber-400 shadow-[0_0_8px_rgba(249,115,22,0.5)]" />
          <h2 className="whitespace-nowrap text-[11px] font-black uppercase tracking-[0.16em] text-slate-950">
            Your day
          </h2>
          <span className="whitespace-nowrap text-[10px] font-bold uppercase tracking-[0.12em] text-slate-400">
            Press a task to see the work
          </span>
        </div>
        <p
          className={`mt-2.5 break-words text-[15px] font-bold leading-6 ${
            summary.tone === "clear"
              ? "text-emerald-700"
              : summary.tone === "overdue"
                ? "text-slate-900"
                : "text-slate-800"
          }`}
        >
          {summary.headline}
        </p>
      </div>

      <ul className="divide-y divide-slate-200/70 border-t border-slate-200/70">
        {waiting.map((task) => (
          <TaskRow
            icon={icons[task.functionKey] ?? ArrowUpRight}
            isOpen={openKeys.has(task.key)}
            key={task.key}
            onToggle={() => toggle(task.key)}
            task={task}
          />
        ))}
        {clear.length > 0 ? <ClearStrip tasks={clear} /> : null}
      </ul>
    </section>
  );
}
