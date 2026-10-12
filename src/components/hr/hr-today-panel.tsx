"use client";

/**
 * "YOUR DAY" — the HR command centre's opening panel, rebuilt from nothing on 2026-10-12.
 *
 * 🔴 THE REBUILD, IN HIS WORDS. The owner screenshotted this panel together with the notice band
 * above it: "the place where I screenshot to you is a fucking oven. It needs to be burned out and
 * re-created from scratch a premium polished. Meant to be this account. I want this account to be
 * the fucking best of the world." In the same message he ruled the identity banner and the portrait
 * FINISHED — "do not touch, do not ever touch. They're perfect right now" — so nothing above this
 * section was altered to make it fit; this section was rebuilt to belong to it.
 *
 * WHAT WAS ACTUALLY WRONG, because "premium" is not a colour. The panel was correct and cheap at the
 * same time:
 *   · THREE TRAFFIC-LIGHT PALETTES AT ONCE. Every row carried a rose / amber / emerald tinted chip,
 *     a tinted pill and a tinted rail — three saturated families stacked under a warm cream
 *     letterhead. Colour was doing the work typography should do, and it fought the banner.
 *   · A COUNT PRINTED TWICE. The pill beside the title and the number inside the sentence were the
 *     same fact, so the eye had to decide which one mattered.
 *   · COOL GREY ON WARM PAPER. `slate-200` hairlines and `slate-500` body text under a #fdf8f3
 *     banner read as two different documents pasted together.
 *
 * WHAT IT IS NOW — THE LEDGER PAGE OF THE LETTERHEAD ABOVE IT.
 *   · ONE ACCENT. Phoenix orange #f47b20, and nothing else. Urgency is a 3px margin edge and a
 *     three-word caption, never a filled box: the house ink rule says no filled areas, and that is
 *     exactly the rule the tinted chips were breaking.
 *   · THE COUNT IS THE LEFT GUTTER. Each task opens with its own figure set large and tabular in the
 *     margin, which is what the pill was for — so the pill is gone and the figure is read, not
 *     decoded. Figures line up down the column because they are tabular, which is the whole reason a
 *     ledger looks expensive.
 *   · THE HEADLINE IS SET, NOT STYLED. One sentence in the display serif at 19px with its figures
 *     picked out in orange. It says the same thing it always said; it now reads as the page's
 *     opening line instead of as a status string.
 *   · WARM HAIRLINES AND HOUSE PAPER. #e6e0d6 rules and #fdfaf6 grounds, mixed off the banner's own
 *     #fdf8f3, so the eye reads one document continuing down the page.
 *
 * ── The rules this file has always been under, and still is ──
 *
 * PRESS A TASK, THE WORK APPEARS. That was the owner's own description on 2026-09-01 and it is the
 * whole interaction: every task is a disclosure button, and inside are real records, each a link to
 * the page that actions it. The most urgent opens by default, because a board that makes you click
 * before it tells you anything has only moved the problem down one level.
 *
 * WHAT IT REPLACED IN THE FIRST PLACE. A ring reading "5 of 18 waiting" over four bar charts. Every
 * number in it was true and none of them was work: the denominator counted TILES and one of the five
 * was lit because it held a zero. Never reintroduce a figure whose denominator is the layout.
 *
 * NEVER A HORIZONTAL SCROLL (owner's golden rule). There is no table, no `min-width` and no
 * `overflow-x-auto` in this file. Every row is flex-wrap, every long value carries `break-words`,
 * and a name / context / age stack onto their own lines on a phone rather than sitting behind a
 * sideways drag. Wrapping is the permitted answer; nothing is ever truncated with an ellipsis.
 *
 * SQUARE EDGES. No radius is written here at all — not a pill, not a chip, not an icon well. The
 * admin shell zeroes radii anyway (globals RULE 1), but a file that writes `rounded-full` and leans
 * on the sweep is one stylesheet scope away from shipping the breach.
 */

import { ArrowUpRight, Check, ChevronDown, type LucideIcon } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";

import type { HrTask, HrTaskUrgency } from "@/lib/hr/today-tasks";

/**
 * THE LETTERHEAD'S PALETTE. #231e18 and #f47b20 are the fill and the stroke of the wave the identity
 * bar closes on; the greys are mixed off its #fdf8f3 paper. Nothing cool appears on this page.
 */
const INK = "#231e18";
const ORANGE = "#f47b20";
const RULE = "#e6e0d6";
const RULE_SOFT = "#ece6dc";
const PAPER = "#fdfaf6";
const MUTED = "#6f6256";
const FAINT = "#a8907a";
const STONE = "#d8cfc2";
const TEAL = "#3f8a86";

/** Rank for sorting. Overdue first, then what is merely waiting, then what is done. */
const URGENCY_RANK: Record<HrTaskUrgency, number> = {
  clear: 2,
  due: 1,
  overdue: 0,
};

/**
 * URGENCY, IN TWO MARKS INSTEAD OF A PALETTE. The margin edge and the gutter figure — that is all.
 * A row that needs him first takes the brand orange on both; a row that is merely waiting takes warm
 * stone and ink. There is deliberately no third colour and no fill: this map replaced one that
 * carried a tinted badge, a tinted count, a tinted icon well and a tinted rail per state.
 */
const URGENCY_MARKS: Record<HrTaskUrgency, { figure: string; rail: string }> = {
  clear: { figure: TEAL, rail: TEAL },
  due: { figure: MUTED, rail: STONE },
  overdue: { figure: ORANGE, rail: ORANGE },
};

/** One segment of the opening sentence. A `figure` is set in orange tabular; prose is not. */
type HeadlineSegment = { figure?: boolean; text: string };

/**
 * The opening sentence, built from the tasks themselves so it can never disagree with the list below
 * it, and phrased in items of work — never in tiles, which is what the old ring counted.
 *
 * IT IS RETURNED IN SEGMENTS RATHER THAN AS A STRING so the figures inside it can be set in the
 * accent without a regex hunting digits in rendered prose. The wording is unchanged from the version
 * that has been on the page since 2026-09-01.
 */
function summarise(tasks: HrTask[]): { segments: HeadlineSegment[]; tone: HrTaskUrgency } {
  const waiting = tasks.filter((task) => task.urgency !== "clear");
  const overdue = tasks.filter((task) => task.urgency === "overdue");
  const items = waiting.reduce((total, task) => total + task.count, 0);

  if (waiting.length === 0) {
    return {
      segments: [{ text: "Nothing is waiting on you. Every queue on your desk is clear." }],
      tone: "clear",
    };
  }

  const segments: HeadlineSegment[] = [
    { figure: true, text: items.toLocaleString("en-US") },
    { text: items === 1 ? " item across " : " items across " },
    { figure: true, text: waiting.length.toLocaleString("en-US") },
    { text: waiting.length === 1 ? " task is waiting on you." : " tasks are waiting on you." },
  ];

  if (overdue.length === 0) return { segments, tone: "due" };

  segments.push({ text: " Of those, " });
  if (overdue.length === 1) {
    segments.push({ figure: true, text: "one" }, { text: " has" });
  } else {
    segments.push(
      { figure: true, text: overdue.length.toLocaleString("en-US") },
      { text: " have" },
    );
  }
  segments.push({ text: " been waiting long enough to need you first." });

  return { segments, tone: "overdue" };
}

/** The marker. A rotated square, because this page has no round corners anywhere. */
function Diamond({ color }: { color: string }) {
  return (
    <span
      aria-hidden="true"
      className="inline-block h-[6px] w-[6px] shrink-0 rotate-45"
      style={{ background: color }}
    />
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
  const marks = URGENCY_MARKS[task.urgency];
  const panelId = `hr-task-${task.key}`;
  const hidden = task.totalItems - task.items.length;

  // THE RULE BETWEEN ROWS IS WRITTEN ON THE ROW ITSELF, NEVER WITH `divide-y`. `divide-y` sets a
  // width and no colour, and `border-color` is not an inherited property — so a divided list whose
  // colour is set on the PARENT draws its rules in `currentColor`, the text colour, which is how a
  // warm hairline turns into a black line nobody asked for.
  return (
    <li className="relative border-t first:border-t-0" style={{ borderColor: RULE }}>
      {/* The margin edge. Full height, 3px, so a row's state reads before its words do — and it is
          the ONLY place a row carries state colour. */}
      <span
        aria-hidden="true"
        className="absolute inset-y-0 left-0 w-[3px]"
        style={{ background: marks.rail }}
      />

      <button
        aria-controls={panelId}
        aria-expanded={isOpen}
        className="group flex w-full items-start gap-3.5 py-4 pl-4 pr-3 text-left transition-colors duration-200 hover:bg-[#fdfaf6] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-orange-500 sm:gap-4 sm:pl-6 sm:pr-5"
        onClick={onToggle}
        type="button"
      >
        {/* THE GUTTER FIGURE. This is the count — the pill that used to repeat it is gone. Tabular
            so every figure in the column lands on the same axis, which is what makes a stack of
            rows read as one ledger rather than as five cards. */}
        <span
          className="w-8 shrink-0 text-right text-[22px] font-black leading-none tabular-nums sm:w-10 sm:text-[26px]"
          style={{ color: marks.figure }}
        >
          {task.count.toLocaleString("en-US")}
        </span>

        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
            <Icon aria-hidden="true" className="h-3.5 w-3.5 shrink-0" style={{ color: FAINT }} />
            <span
              className="break-words text-[13.5px] font-black leading-snug"
              style={{ color: INK }}
            >
              {task.title}
            </span>
            {/* "NEEDS YOU FIRST" IS SPOKEN, NOT PRINTED. It was printed at first and the page
                measured three identical orange captions stacked down the column — the same fact
                said three times, which is the repetition that makes a dense page look loud. The
                SEEN marks are the orange margin edge and the orange figure, and the sentence in the
                masthead already names how many rows carry them. The words stay for a screen
                reader, because colour alone is not an affordance. */}
            {task.urgency === "overdue" ? <span className="sr-only">Needs you first</span> : null}
          </span>
          <span
            className="mt-1.5 block break-words text-[11.5px] font-medium leading-5"
            style={{ color: MUTED }}
          >
            {task.detail}
          </span>
        </span>

        <ChevronDown
          aria-hidden="true"
          className={`mt-1 h-4 w-4 shrink-0 transition-transform duration-200 ${
            isOpen ? "rotate-180" : ""
          }`}
          style={{ color: FAINT }}
        />
      </button>

      {isOpen ? (
        <div
          className="border-t pb-4 pl-4 pr-3 pt-3 sm:pl-6 sm:pr-5"
          id={panelId}
          style={{ background: PAPER, borderColor: RULE }}
        >
          {task.count === 0 ? (
            <p
              className="flex flex-wrap items-center gap-2 py-1 text-[12px] font-bold"
              style={{ color: TEAL }}
            >
              <Check aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
              <span className="break-words">{task.clearLabel}</span>
            </p>
          ) : (
            <ul className="flex flex-col">
              {task.items.map((item) => (
                <li
                  className="border-t first:border-t-0"
                  key={item.id}
                  style={{ borderColor: RULE_SOFT }}
                >
                  <Link
                    className="group/item flex flex-wrap items-baseline gap-x-3 gap-y-1 py-2.5 transition-colors duration-150 hover:bg-white focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-orange-500"
                    href={item.href}
                  >
                    <span
                      className="break-words text-[12.5px] font-black leading-snug"
                      style={{ color: INK }}
                    >
                      {item.name}
                    </span>
                    {item.meta ? (
                      <span
                        className="break-words text-[11px] font-medium leading-snug"
                        style={{ color: MUTED }}
                      >
                        {item.meta}
                      </span>
                    ) : null}
                    {item.age ? (
                      <span
                        className="ml-auto whitespace-nowrap text-[9.5px] font-black uppercase tracking-[0.14em] tabular-nums"
                        style={{ color: item.urgent ? ORANGE : FAINT }}
                      >
                        {item.age}
                      </span>
                    ) : null}
                    <ArrowUpRight
                      aria-hidden="true"
                      className="h-3.5 w-3.5 shrink-0 opacity-0 transition-opacity duration-150 group-hover/item:opacity-100"
                      style={{ color: ORANGE }}
                    />
                  </Link>
                </li>
              ))}
            </ul>
          )}

          {/* Never a silent cap: when the list is longer than the preview, it says so and how many. */}
          <div
            className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1.5 border-t pt-3"
            style={{ borderColor: RULE }}
          >
            {hidden > 0 ? (
              <span
                className="break-words text-[9.5px] font-black uppercase tracking-[0.16em] tabular-nums"
                style={{ color: FAINT }}
              >
                Showing {task.items.length} of {task.totalItems.toLocaleString("en-US")}
              </span>
            ) : null}
            <Link
              className="ml-auto inline-flex items-center gap-1 whitespace-nowrap text-[10px] font-black uppercase tracking-[0.16em] transition-opacity hover:opacity-70 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-orange-500"
              href={task.href}
              style={{ color: ORANGE }}
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
 * NAMED, because "no employee has written to HR" and "we do not track that" look identical when the
 * row is missing. But four full-height rows each reading 0, at the top of the page, is what he
 * called rubbish, and he was right: on the day this was built five of the nine tasks were clear, so
 * more than half the panel was dead weight above the work.
 *
 * So every clear queue keeps its name and its link and loses its row. Nothing is hidden and no count
 * is dropped; the ones with nothing in them simply stop taking the space of the ones that do.
 */
function ClearStrip({ tasks }: { tasks: HrTask[] }) {
  return (
    <li
      className="flex flex-wrap items-center gap-x-3 gap-y-2 border-t px-4 py-3.5 first:border-t-0 sm:px-6"
      style={{ background: PAPER, borderColor: RULE }}
    >
      <span className="inline-flex shrink-0 items-center gap-2">
        <Check aria-hidden="true" className="h-3.5 w-3.5 shrink-0" style={{ color: TEAL }} />
        <span
          className="whitespace-nowrap text-[9.5px] font-black uppercase tracking-[0.18em] tabular-nums"
          style={{ color: INK }}
        >
          {tasks.length} {tasks.length === 1 ? "queue is" : "queues are"} clear
        </span>
      </span>
      <span className="flex flex-wrap items-center gap-1.5">
        {tasks.map((task) => (
          <Link
            className="inline-flex items-center whitespace-nowrap border bg-white px-2 py-1 text-[10px] font-bold transition-colors hover:bg-[#f6f2ec] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-orange-500"
            href={task.href}
            key={task.key}
            style={{ borderColor: RULE, color: MUTED }}
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
  openAll = false,
  tasks,
}: {
  /** The seat's function icons, passed in so this file holds no second copy of that map. */
  icons: Record<string, LucideIcon>;
  /**
   * Open EVERY waiting task on arrival instead of only the most urgent one.
   *
   * The panel is no longer a standing block above the toolbar — since 2026-10-13 it is what the
   * toolbar's "Needs attention" button opens ("make it show all pendings when clicked on and remove
   * the upper part"). Someone who has just pressed that button has asked for the pendings, so a
   * panel that opens with four of the five tasks still shut would be answering a narrower question
   * than the one that was asked. On the page itself nothing opens it, so the default is unchanged.
   */
  openAll?: boolean;
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

  // The most urgent task opens on arrival — or every waiting one when the panel was opened by the
  // "Needs attention" button, which is a request for the pendings themselves. Deterministic from
  // props, so the server and the client agree on the first render.
  const [openKeys, setOpenKeys] = useState<Set<string>>(() => {
    const waitingKeys = ordered.filter((task) => task.urgency !== "clear").map((task) => task.key);
    return new Set(openAll ? waitingKeys : waitingKeys.slice(0, 1));
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
    <section className="border-b border-t bg-white" style={{ borderColor: RULE }}>
      {/* THE MASTHEAD. House paper, a diamond in the accent, a hairline leader that fades into the
          margin, and the opening sentence set in the display serif. The leader is the one piece of
          pure craft on the panel and it is a 1px gradient — not an ornament, not an image.

          ITS BASELINE IS 2px OF INK, NOT A HAIRLINE. That rule is what makes the sentence read as
          the opening line of a document rather than as a status string floating above a list: a
          masthead needs a baseline under it, and the weight has to be heavier than the rules between
          the rows below or the hierarchy inverts. It is the same #231e18 the identity bar closes its
          wave in — the one ink this page uses. */}
      <div
        className="px-4 py-5 sm:px-6"
        style={{ background: PAPER, borderBottom: `2px solid ${INK}` }}
      >
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <Diamond color={ORANGE} />
          <h2
            className="whitespace-nowrap text-[10px] font-black uppercase tracking-[0.22em]"
            style={{ color: INK }}
          >
            Your day
          </h2>
          <span
            aria-hidden="true"
            className="hidden h-px flex-1 sm:block"
            style={{ background: `linear-gradient(to right, ${RULE}, rgba(230,224,214,0))` }}
          />
          <span
            className="whitespace-nowrap text-[9px] font-black uppercase tracking-[0.18em]"
            style={{ color: FAINT }}
          >
            {/* The caption teaches the interaction, so it must describe the state the panel is
                actually in: opened from the button every task is already open, and telling him to
                press one to see the work is an instruction to close it. */}
            {openAll ? "Press a task to close it" : "Press a task to see the work"}
          </span>
        </div>

        <p
          className="font-display mt-3.5 break-words text-[17px] leading-7 sm:text-[19px] sm:leading-8"
          style={{ color: summary.tone === "clear" ? TEAL : INK }}
        >
          {summary.segments.map((segment, index) =>
            segment.figure ? (
              <span
                className="font-black tabular-nums"
                key={`${segment.text}-${index}`}
                style={{ color: ORANGE }}
              >
                {segment.text}
              </span>
            ) : (
              <span key={`${segment.text}-${index}`}>{segment.text}</span>
            ),
          )}
        </p>
      </div>

      <ul className="flex flex-col">
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
