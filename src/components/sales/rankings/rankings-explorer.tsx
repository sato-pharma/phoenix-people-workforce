"use client";

// ─────────────────────────────────────────────────────────────────────────────
// Rankings — the explorer.
//
// The owner's concept, built as its own tab rather than inside any overview (2026-10-03): the two
// standing cards, the boards under them, and a filter bar that can cut the field by line, by
// several lines, by the whole company, by title, by region, by one person, and over a month, a
// quarter, a semester, a year or every published month.
//
// 🔒 THE SQUARE-EDGE RULE AND THE FITS-THE-SCREEN RULE both apply here: no radius anywhere, and
// every table is `table-fixed` with a `<colgroup>` and no min-width floor, so the page fits a
// phone by MERGING what it shows (the phone gets cards) rather than by scrolling sideways. Long
// names WRAP — nothing on this page is ever cut short with an ellipsis (owner rule).
//
// Filters live in the URL, so a board is a link: the state a manager is looking at is the state
// he can send to somebody else. Navigation runs inside a transition, which is why the board dims
// rather than blanks while the server re-reads.
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useMemo, useState, useTransition } from "react";
import { usePathname, useRouter } from "next/navigation";
import { BarChart3, Crosshair, Search, Users } from "lucide-react";

import {
  AchievementMeter,
  SURFACE_CLASS,
  SectionCard,
  TABLE_HEAD_CLASS,
  TABLE_ROW_CLASS,
  chipClass,
  formatEgp,
} from "@/components/sales/target-visuals";
import { phxSelectClassName } from "@/components/ui/form-tokens";
import { cn } from "@/lib/utils";
import type { RankingEntry, RankingWindowMode } from "@/lib/sales/rankings";
import type { RankingOption, RankingsPageData } from "@/lib/sales/rankings-page";

const MODE_LABELS: Record<RankingWindowMode, string> = {
  month: "Month",
  quarter: "Quarter",
  semester: "Semester",
  year: "Year",
  published: "All published",
};

const MODES: RankingWindowMode[] = ["month", "quarter", "semester", "year", "published"];

/** Initials for a rep with no photograph on file — never an HR id, which is never shown. */
function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  const first = parts[0][0] ?? "";
  const last = parts.length > 1 ? (parts[parts.length - 1][0] ?? "") : "";
  return `${first}${last}`.toUpperCase();
}

function Avatar({ entry, size = "sm" }: { entry: Pick<RankingEntry, "hrId" | "name" | "hasPhoto">; size?: "sm" | "md" }) {
  const [failed, setFailed] = useState(false);
  const box = size === "md" ? "h-12 w-12 text-sm" : "h-9 w-9 text-phx-sm";
  if (!entry.hasPhoto || failed) {
    return (
      <span
        aria-hidden
        className={cn("flex shrink-0 items-center justify-center border border-slate-200 bg-slate-100 font-black text-slate-500", box)}
      >
        {initialsOf(entry.name)}
      </span>
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element -- the photo endpoint streams bytes; next/image would proxy a private route.
    <img
      alt=""
      className={cn("shrink-0 border border-slate-200 object-cover", box)}
      onError={() => setFailed(true)}
      src={`/api/employees/${encodeURIComponent(entry.hrId)}/photo`}
    />
  );
}

/**
 * ▲ +5 / ▼ -1 / — against the window before this one.
 *
 * A tinted square chip rather than bare coloured text: the move is one of the three things a
 * manager reads off a row, and as plain text it was the quietest thing in the cell. `tone="dark"`
 * drops the tint for the navy standing cards, where a light chip would punch a hole in the panel.
 */
function Trend({ value, className, tone = "light" }: { value: number | null; className?: string; tone?: "light" | "dark" }) {
  const dark = tone === "dark";
  if (value == null || value === 0) {
    return (
      <span
        className={cn(
          "inline-flex items-center whitespace-nowrap border px-1.5 py-0.5 font-bold",
          dark ? "border-white/20 text-white/70" : "border-slate-200 bg-slate-50 text-slate-500",
          className,
        )}
      >
        {value === 0 ? "— Held" : "New"}
      </span>
    );
  }
  const up = value > 0;
  return (
    <span
      className={cn(
        "inline-flex items-center whitespace-nowrap border px-1.5 py-0.5 font-black tabular-nums",
        dark
          ? up
            ? "border-emerald-400/40 text-emerald-300"
            : "border-rose-400/40 text-rose-300"
          : up
            ? "border-emerald-200 bg-emerald-50 text-emerald-700"
            : "border-rose-200 bg-rose-50 text-rose-700",
        className,
      )}
    >
      {up ? "▲" : "▼"} {up ? "+" : ""}
      {value}
    </span>
  );
}

/**
 * The rank tile: gold, silver and bronze for the first three, quiet slate below them.
 *
 * A square seal, not a badge — the house square-edge rule, and the podium three carry an inner
 * keyline (`inset 0 0 0 1px`) so the first places read as struck tiles rather than coloured boxes.
 */
function RankTile({ rank }: { rank: number }) {
  const podium = rank <= 3;
  const tone =
    rank === 1
      ? "border-amber-500 bg-amber-400 text-amber-950"
      : rank === 2
        ? "border-slate-400 bg-slate-300 text-slate-800"
        : rank === 3
          ? "border-orange-400 bg-orange-300 text-orange-950"
          : "border-slate-200 bg-slate-100 text-slate-600";
  return (
    <span
      className={cn(
        "flex h-7 w-7 shrink-0 items-center justify-center border font-black tabular-nums",
        podium ? "text-[0.8125rem]" : "text-xs",
        tone,
      )}
      style={podium ? { boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.55)" } : undefined}
    >
      {rank}
    </span>
  );
}

/** The podium's own accents, used by both the table row and the phone card. */
const PODIUM_EDGE: Record<number, string> = {
  1: "border-l-[3px] border-l-amber-400 bg-amber-50/40",
  2: "border-l-[3px] border-l-slate-400 bg-slate-50/60",
  3: "border-l-[3px] border-l-orange-400 bg-orange-50/30",
};

/**
 * One standing, as the owner's concept draws it: a dark panel closed by a 3px rule, the placing
 * set large beside what it was won against, then the move and the period.
 */
function StandingCard({
  accent,
  icon: Icon,
  title,
  rank,
  outOf,
  outOfNote,
  trend,
  periodLabel,
}: {
  accent: "orange" | "blue";
  icon: typeof BarChart3;
  title: string;
  rank: number;
  outOf: number;
  outOfNote: string;
  trend: number | null;
  periodLabel: string;
}) {
  const accentColor = accent === "orange" ? "#f97316" : "#1482c2";
  return (
    <section
      className="relative isolate overflow-hidden border border-[#152a46] bg-[#0b1f3a] text-white shadow-[0_1px_2px_rgba(15,23,42,0.18),0_10px_30px_rgba(11,31,58,0.28)]"
      style={{ borderTopColor: accentColor, borderTopWidth: 3 }}
    >
      {/* Depth, never decoration: a 3% white hairline grid on 56px, the same way the house dark
          bands carry theirs. It is drawn, not rounded — the square-edge rule is untouched, and the
          grid is what stops a large navy panel reading as flat ink. */}
      <span
        aria-hidden
        className="pointer-events-none absolute inset-0 -z-10"
        style={{
          backgroundImage:
            "linear-gradient(to right, rgba(255,255,255,0.03) 1px, transparent 1px), linear-gradient(to bottom, rgba(255,255,255,0.03) 1px, transparent 1px)",
          backgroundSize: "56px 56px",
        }}
      />
      {/* The placing again, enormous and almost invisible, bled off the trailing edge. It carries
          the eye to the figure that matters without adding a second thing to read. */}
      <span
        aria-hidden
        className="pointer-events-none absolute -right-2 -top-6 -z-10 select-none text-[8.5rem] font-black leading-none tabular-nums text-white/[0.045]"
      >
        {rank}
      </span>
      <div className="flex flex-wrap items-center gap-x-5 gap-y-3 px-4 py-4 sm:px-6">
        <Icon aria-hidden className="h-8 w-8 shrink-0" style={{ color: accentColor }} />
        <div className="min-w-0">
          <p className="text-sm font-black tracking-tight text-white">{title}</p>
          <p className="mt-1 flex flex-wrap items-baseline gap-x-2">
            <span className="text-4xl font-black leading-none tabular-nums" style={{ color: accentColor }}>
              #{rank}
            </span>
            <span className="text-2xl font-black leading-none tabular-nums text-white/70">/ {outOf}</span>
            <span className="text-phx-sm font-bold uppercase tracking-[0.14em] text-white/60">{outOfNote}</span>
          </p>
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-x-5 gap-y-2">
          <div className="border-l border-white/15 pl-4">
            <Trend className="text-sm" tone="dark" value={trend} />
            <p className="mt-1 text-phx-sm font-bold uppercase tracking-[0.14em] text-white/50">vs previous</p>
          </div>
          <p className="border-l border-white/15 pl-4 text-phx-sm font-black uppercase tracking-[0.18em] text-white/70">
            {periodLabel}
          </p>
        </div>
      </div>
    </section>
  );
}

/** A multi-select row of chips. Selecting nothing means "everyone", which the first chip says. */
function ChipFilter({
  label,
  allLabel,
  options,
  selected,
  onChange,
}: {
  label: string;
  allLabel: string;
  options: readonly RankingOption[];
  selected: readonly string[];
  onChange: (next: string[]) => void;
}) {
  if (options.length === 0) return null;
  const toggle = (value: string) => {
    onChange(selected.includes(value) ? selected.filter((item) => item !== value) : [...selected, value]);
  };
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="whitespace-nowrap text-phx-sm font-black uppercase tracking-[0.18em] text-slate-500">{label}</span>
      <button
        aria-pressed={selected.length === 0}
        className={cn("whitespace-nowrap", chipClass(selected.length === 0))}
        onClick={() => onChange([])}
        type="button"
      >
        {allLabel}
      </button>
      {options.map((option) => (
        <button
          aria-pressed={selected.includes(option.value)}
          className={chipClass(selected.includes(option.value))}
          key={option.value}
          onClick={() => toggle(option.value)}
          type="button"
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

/** "Medical Representative · CNS · Delta" — one line under the name, in names only. */
function subtitleOf(entry: RankingEntry, showLine: boolean): string {
  return [entry.title, showLine ? entry.lineLabel : "", entry.regionName].filter(Boolean).join(" · ");
}

function BoardTable({ entries, showLine }: { entries: readonly RankingEntry[]; showLine: boolean }) {
  return (
    /* 🔒 THE TABLE/CARD SWITCH IS THE PANEL'S OWN WIDTH, NEVER THE VIEWPORT'S. A board sits in a
       full-width section at one moment and in a half of `xl:grid-cols-2` the next, and those are
       not the same number of pixels: measured at a 1280px viewport the two-up panel is 452px, where
       a viewport-keyed `lg:block` table clipped 18 cells — the fits-the-screen rule broken on a
       wide monitor. `@container` + `@min-[660px]` asks the band itself, the way
       early-birds-hall-of-fame.tsx and employee-360-view.tsx already do. */
    <div className="@container">
      {/* `table-fixed`, a PERCENTAGE colgroup and NO min-width floor — the house pattern, and the
          five columns are already the merged form of seven: the line and the region ride under the
          name rather than taking columns of their own. The 660px threshold is NOT a guess — it is
          the narrowest the admin table ever gets (a 1024px viewport, rail in), which is the one
          width tests/sales-rankings.test.ts proves this colgroup at. Below it the board has not
          been proven, so it shows cards; the full-width board at 1024px is 670px and keeps its
          table, while the 452px two-up panel takes cards. */}
      <div className="hidden @min-[660px]:block">
        <table className="w-full table-fixed text-left text-sm">
          <colgroup>
            <col style={{ width: "8%" }} />
            <col style={{ width: "42%" }} />
            <col style={{ width: "22%" }} />
            <col style={{ width: "17%" }} />
            <col style={{ width: "11%" }} />
          </colgroup>
          {/* The head STICKS. A board is now the whole line — forty rows — and a column heading
              that scrolls away turns "109%" into a number with no name on it. */}
          <thead className={cn(TABLE_HEAD_CLASS, "sticky top-0 z-10")}>
            <tr>
              <th className="px-3 py-2">#</th>
              <th className="px-3 py-2">Name</th>
              <th className="px-3 py-2 text-right">Achievement</th>
              <th className="px-3 py-2 text-right">Sales</th>
              <th className="px-3 py-2 text-right">Trend</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((entry) => (
              // Zebra + the podium's left edge, both the house idiom (see deductions-workspace).
              // Over forty rows the eye loses the row it is reading; the zebra is what holds it.
              <tr className={cn(TABLE_ROW_CLASS, "odd:bg-slate-50/60", PODIUM_EDGE[entry.rank])} key={entry.key}>
                <td className="px-3 py-2 align-middle">
                  <RankTile rank={entry.rank} />
                </td>
                <td className="px-3 py-2 align-middle">
                  <span className="flex items-center gap-3">
                    <Avatar entry={entry} />
                    <span className="min-w-0">
                      <span className="block break-words font-bold leading-tight text-slate-900">{entry.name}</span>
                      <span className="block break-words text-phx-xs leading-tight text-slate-500">
                        {subtitleOf(entry, showLine)}
                      </span>
                    </span>
                  </span>
                </td>
                <td className="px-3 py-2 align-middle">
                  <AchievementMeter value={entry.achievementPercent / 100} />
                </td>
                <td className="px-3 py-2 text-right align-middle tabular-nums text-slate-700">{formatEgp(entry.salesValue)}</td>
                <td className="px-3 py-2 text-right align-middle">
                  <Trend className="text-xs" value={entry.trend} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Anything narrower: one card each, never a table — the columns merge instead of scrolling. */}
      <ul className="divide-y divide-slate-100 @min-[660px]:hidden">
        {entries.map((entry) => (
          <li
            className={cn("flex items-start gap-3 py-3", PODIUM_EDGE[entry.rank] && `${PODIUM_EDGE[entry.rank]} pl-3`)}
            key={entry.key}
          >
            <RankTile rank={entry.rank} />
            <Avatar entry={entry} />
            <div className="min-w-0 flex-1">
              <p className="break-words font-bold leading-tight text-slate-900">{entry.name}</p>
              <p className="break-words text-phx-xs leading-tight text-slate-500">{subtitleOf(entry, showLine)}</p>
              <div className="mt-2 flex items-end gap-3">
                <span className="min-w-0 flex-1">
                  <AchievementMeter align="left" value={entry.achievementPercent / 100} />
                </span>
                <span className="shrink-0 text-right">
                  <Trend className="text-xs" value={entry.trend} />
                  <span className="mt-0.5 block whitespace-nowrap text-phx-sm tabular-nums text-slate-500">
                    {formatEgp(entry.salesValue)}
                  </span>
                </span>
              </div>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function RankingsExplorer({ data }: { data: RankingsPageData }) {
  const router = useRouter();
  const pathname = usePathname();
  const [pending, startTransition] = useTransition();
  const [queryDraft, setQueryDraft] = useState(data.filters.query);

  const push = useCallback(
    (next: Partial<{ mode: string; period: string; lines: string[]; titles: string[]; regions: string[]; q: string; manager: string }>) => {
      const params = new URLSearchParams();
      const mode = next.mode ?? data.mode;
      const period = next.period ?? data.window.anchor;
      const lines = next.lines ?? [...data.filters.lines];
      const titles = next.titles ?? [...data.filters.titles];
      const regions = next.regions ?? [...data.filters.regions];
      const query = next.q ?? data.filters.query;
      const manager = next.manager ?? data.filters.manager ?? "";
      if (mode !== "published") {
        params.set("mode", mode);
        if (period) params.set("period", period);
      } else {
        params.set("mode", "published");
      }
      if (lines.length > 0) params.set("lines", lines.join(","));
      if (titles.length > 0) params.set("titles", titles.join(","));
      if (regions.length > 0) params.set("regions", regions.join(","));
      if (query.trim()) params.set("q", query.trim());
      if (manager.trim()) params.set("manager", manager.trim());
      startTransition(() => router.replace(`${pathname}?${params.toString()}`, { scroll: false }));
    },
    [data.filters, data.mode, data.window.anchor, pathname, router],
  );

  const scopeLabel = useMemo(() => {
    if (data.filters.lines.length === 0) return "All company";
    return data.filters.lines
      .map((code) => data.lineOptions.find((option) => option.value === code)?.label ?? code)
      .join(" · ");
  }, [data.filters.lines, data.lineOptions]);

  const leader = data.boards.overall[0] ?? null;
  const focus = data.focus;
  // The two cards at the top: the searched person's own standing, or — with no search — the name
  // holding the board, so the pair always says something true about what is on screen.
  const companyCard = focus
    ? { rank: focus.company.rank, outOf: focus.company.outOf, outOfIsSeats: focus.company.outOfIsSeats, trend: focus.company.trend, name: focus.entry.name }
    : leader
      ? { rank: leader.rank, outOf: data.boards.seats ?? data.boards.ranked, outOfIsSeats: data.boards.seats != null, trend: leader.trend, name: leader.name }
      : null;
  const lineBoardForCard = focus
    ? focus.line
    : leader
      ? (() => {
          const board = data.boards.byLine.find((item) => item.lineCode === leader.lineCode);
          const entry = board?.entries[0] ?? null;
          return board && entry
            ? {
                lineLabel: board.lineLabel,
                rank: entry.rank,
                outOf: board.seats ?? board.entries.length,
                outOfIsSeats: board.seats != null,
                trend: entry.trend,
              }
            : null;
        })()
      : null;

  if (data.nothingPublished) {
    return (
      <section className={cn(SURFACE_CLASS, "border-t-[3px] border-t-orange-500 px-5 py-8 text-center")}>
        <h1 className="text-xl font-black text-slate-900">Rankings</h1>
        <p className="mt-2 text-sm text-slate-600">
          No Monthly Closing has been published yet, so there is nothing to rank. The board opens by itself the day a
          closing is published.
        </p>
      </section>
    );
  }

  return (
    <div className="space-y-4">
      {/* ── Page header, with the window's own figures beside it ──
          The strip is the house figures block: a micro label over a large tabular numeral, columns
          divided by a hairline. It adds information rather than ornament — how many the window
          could score, how many seats stand behind the board, and how many of those are empty, which
          is the number that explains a short board. The seat pair disappears when a title, region
          or name filter is on, because the seat model then answers a question the board is no
          longer asking. */}
      <section className={cn(SURFACE_CLASS, "relative border-t-[3px] border-t-orange-500")}>
        <div className="flex flex-wrap items-end justify-between gap-x-8 gap-y-5 px-5 py-5 sm:px-7 sm:py-6">
          <div className="min-w-0">
            <p className="text-phx-xs font-black uppercase tracking-[0.24em] text-orange-600">Commercial Performance</p>
            <h1 className="mt-1 text-3xl font-black leading-tight tracking-tight text-slate-900 sm:text-[2.2rem]">Rankings</h1>
            <p className="mt-2 text-sm text-slate-600">
              {data.window.label} · {data.window.rangeLabel} · {scopeLabel} · Monthly Closing, published months only
            </p>
          </div>
          <dl className="flex flex-wrap items-end gap-x-6 gap-y-3">
            {[
              { label: "Ranked", value: data.boards.ranked, tone: "text-slate-900" },
              ...(data.boards.seats != null
                ? [
                    { label: "Rep seats", value: data.boards.seats, tone: "text-slate-900" },
                    { label: "Vacant", value: data.boards.vacant ?? 0, tone: "text-orange-600" },
                  ]
                : []),
            ].map((figure, index) => (
              <div className={cn(index > 0 && "border-l border-slate-200 pl-6")} key={figure.label}>
                <dt className="text-phx-sm font-black uppercase tracking-[0.14em] text-slate-500">{figure.label}</dt>
                <dd className={cn("mt-0.5 text-2xl font-black leading-none tabular-nums", figure.tone)}>{figure.value}</dd>
              </div>
            ))}
          </dl>
        </div>
      </section>

      {/* ── Filters ── */}
      {/* Hairline-divided rows rather than a loose stack of chips: six filter rows with nothing
          between them read as one heap, and a rule per row is the house's own way of saying these
          are separate questions. The rules are drawn on the rows themselves, so a row that hides
          (no titles to offer) takes its rule with it. */}
      <section className={cn(SURFACE_CLASS, "px-4 py-1 sm:px-5")}>
        <div className="divide-y divide-slate-100 [&>*]:py-2.5">
          <div className="flex flex-wrap items-center gap-2">
            <span className="whitespace-nowrap text-phx-sm font-black uppercase tracking-[0.18em] text-slate-500">Period</span>
            {MODES.map((mode) => (
              <button
                aria-pressed={mode === data.mode}
                className={cn("whitespace-nowrap", chipClass(mode === data.mode))}
                key={mode}
                onClick={() => push({ mode })}
                type="button"
              >
                {MODE_LABELS[mode]}
              </button>
            ))}
          </div>

          {data.anchorOptions.length > 0 ? (
            <div className="flex flex-wrap items-center gap-2">
              <span className="whitespace-nowrap text-phx-sm font-black uppercase tracking-[0.18em] text-slate-500">
                {MODE_LABELS[data.mode]}
              </span>
              {data.anchorOptions.map((option) => (
                <button
                  aria-pressed={option.value === data.window.anchor}
                  className={cn("whitespace-nowrap", chipClass(option.value === data.window.anchor))}
                  key={option.value}
                  onClick={() => push({ period: option.value })}
                  type="button"
                >
                  {option.label}
                </button>
              ))}
            </div>
          ) : null}

          <ChipFilter
            allLabel="All company"
            label="Line"
            onChange={(lines) => push({ lines })}
            options={data.lineOptions}
            selected={data.filters.lines}
          />
          <ChipFilter
            allLabel="All titles"
            label="Title"
            onChange={(titles) => push({ titles })}
            options={data.titleOptions}
            selected={data.filters.titles}
          />
          <ChipFilter
            allLabel="All regions"
            label="Region"
            onChange={(regions) => push({ regions })}
            options={data.regionOptions}
            selected={data.filters.regions}
          />

          {/* A manager's reps, found by his NAME (owner, 2026-10-20). A list rather than a row of
              chips: every District, Regional and National Sales Manager above the board is offered,
              which is far more names than a chip row can carry legibly. */}
          {data.managerOptions.length > 0 || data.filters.manager ? (
            <label className="flex flex-wrap items-center gap-2">
              <span className="whitespace-nowrap text-phx-sm font-black uppercase tracking-[0.18em] text-slate-500">Manager</span>
              <span className="min-w-0 flex-1 sm:max-w-xs">
                <select
                  aria-label="Filter by manager"
                  className={phxSelectClassName}
                  onChange={(event) => push({ manager: event.target.value })}
                  value={data.filters.manager ?? ""}
                >
                  <option value="">All managers</option>
                  {data.filters.manager && !data.managerOptions.some((option) => option.value === data.filters.manager) ? (
                    <option value={data.filters.manager}>{data.filters.manager}</option>
                  ) : null}
                  {data.managerOptions.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </span>
            </label>
          ) : null}

          <form
            className="flex flex-wrap items-center gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              push({ q: queryDraft });
            }}
          >
            <span className="whitespace-nowrap text-phx-sm font-black uppercase tracking-[0.18em] text-slate-500">Person</span>
            <span className="flex min-w-0 flex-1 items-center gap-2 border border-slate-200 bg-white px-3 py-1.5 sm:max-w-xs">
              <Search aria-hidden className="h-4 w-4 shrink-0 text-slate-400" />
              <input
                aria-label="Search a name"
                className="min-w-0 flex-1 border-0 bg-transparent text-sm text-slate-800 outline-none placeholder:text-slate-400"
                onChange={(event) => setQueryDraft(event.target.value)}
                placeholder="Search a name"
                value={queryDraft}
              />
            </span>
            <button className={chipClass(false)} type="submit">
              Search
            </button>
            {data.filters.query ? (
              <button
                className={chipClass(false)}
                onClick={() => {
                  setQueryDraft("");
                  push({ q: "" });
                }}
                type="button"
              >
                Clear
              </button>
            ) : null}
          </form>
        </div>
      </section>

      <div className={cn("space-y-4 transition-opacity", pending && "opacity-60")}>
        {/* ── The two standings ── */}
        {companyCard ? (
          <div className="grid gap-3 lg:grid-cols-2">
            <StandingCard
              accent="orange"
              icon={BarChart3}
              outOf={companyCard.outOf}
              outOfNote={companyCard.outOfIsSeats ? "Rep seats" : "Ranked"}
              periodLabel={data.window.label}
              rank={companyCard.rank}
              title={focus ? `${companyCard.name} — ${scopeLabel}` : `Leading ${scopeLabel}: ${companyCard.name}`}
              trend={companyCard.trend}
            />
            {lineBoardForCard ? (
              <StandingCard
                accent="blue"
                icon={Crosshair}
                outOf={lineBoardForCard.outOf}
                outOfNote={lineBoardForCard.outOfIsSeats ? "Rep seats" : "Ranked"}
                periodLabel={data.window.label}
                rank={lineBoardForCard.rank}
                title={`${lineBoardForCard.lineLabel} line`}
                trend={lineBoardForCard.trend}
              />
            ) : null}
          </div>
        ) : null}

        {/* ── Per-line boards, when more than one line is in scope ──
            🔒 EVERY REP ON THE LINE, never a top slice (owner, 2026-10-03: "Don't show me the top
            five only. I want to see the whole line."). A cut-off board answers a different question
            from the one this page exists for — where everybody stands — and it hid the bottom of
            each line, which is the half a line manager acts on. Do not reintroduce a `slice` here.
            Pinned by tests/sales-rankings.test.ts. */}
        {data.boards.byLine.length > 1 ? (
          <div className="grid gap-3 xl:grid-cols-2">
            {data.boards.byLine.map((board) => (
              <SectionCard
                icon={Crosshair}
                key={board.lineCode}
                subtitle={
                  board.seats != null
                    ? `all ${board.entries.length} ranked of ${board.seats} rep seats · ${board.vacant ?? 0} vacant`
                    : `all ${board.entries.length} ranked`
                }
                title={`${board.lineLabel} line — full ranking`}
              >
                {board.entries.length === 0 ? (
                  <p className="py-6 text-center text-sm text-slate-600">
                    Nobody on this line can be ranked in this window — a rep with no target is not ranked, because their
                    achievement would be arithmetic, not performance.
                  </p>
                ) : (
                  <BoardTable entries={board.entries} showLine={false} />
                )}
              </SectionCard>
            ))}
          </div>
        ) : null}

        {/* ── The whole board ── */}
        <SectionCard
          icon={Users}
          subtitle={
            data.boards.seats != null
              ? `${data.boards.ranked} ranked of ${data.boards.seats} rep seats · ${data.boards.vacant ?? 0} vacant · ${data.window.rangeLabel}`
              : `${data.boards.ranked} ranked · ${data.window.rangeLabel}`
          }
          title={focus ? `${focus.entry.name} — where the filters place them` : `Full ranking — ${scopeLabel}`}
        >
          {data.boards.overall.length === 0 ? (
            <p className="py-6 text-center text-sm text-slate-600">
              Nobody in this window matches those filters. A rep with no target in the window is not ranked — their
              achievement would be arithmetic, not performance.
            </p>
          ) : (
            <BoardTable entries={data.boards.overall} showLine={data.filters.lines.length !== 1} />
          )}
        </SectionCard>

        {/* ── The District Managers (owner, 2026-10-20) ──
            Each ranked by his TEAM's sales against his team's target, read from the published
            Monthly Closing's own district figure — the same board, the same table and cards, never
            a sum of the rows above. Every manager on it, never a top slice. */}
        <SectionCard
          icon={BarChart3}
          subtitle={`${data.boards.districtManagers.length} ranked · team sales against team target · ${data.window.rangeLabel}`}
          title={`District Managers — ${scopeLabel}`}
        >
          {data.boards.districtManagers.length === 0 ? (
            <p className="py-6 text-center text-sm text-slate-600">
              No District Manager can be ranked in this window with these filters. A district with no target in the
              window is not ranked — its achievement would be arithmetic, not performance.
            </p>
          ) : (
            <BoardTable entries={data.boards.districtManagers} showLine={data.filters.lines.length !== 1} />
          )}
        </SectionCard>
      </div>
    </div>
  );
}
