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
  const box = size === "md" ? "h-12 w-12 text-sm" : "h-9 w-9 text-phx-2xs";
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

/** ▲ +5 / ▼ -1 / – against the window before this one. */
function Trend({ value, className }: { value: number | null; className?: string }) {
  if (value == null || value === 0) {
    return <span className={cn("whitespace-nowrap font-bold text-slate-400", className)}>{value === 0 ? "—" : "New"}</span>;
  }
  const up = value > 0;
  return (
    <span className={cn("whitespace-nowrap font-black tabular-nums", up ? "text-emerald-600" : "text-rose-600", className)}>
      {up ? "▲" : "▼"} {up ? "+" : ""}
      {value}
    </span>
  );
}

/** The rank tile: gold, silver and bronze for the first three, quiet slate below them. */
function RankTile({ rank }: { rank: number }) {
  const tone =
    rank === 1
      ? "border-amber-300 bg-amber-400 text-white"
      : rank === 2
        ? "border-slate-300 bg-slate-300 text-slate-800"
        : rank === 3
          ? "border-orange-300 bg-orange-300 text-orange-950"
          : "border-slate-200 bg-slate-100 text-slate-600";
  return (
    <span className={cn("flex h-7 w-7 shrink-0 items-center justify-center border text-xs font-black tabular-nums", tone)}>
      {rank}
    </span>
  );
}

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
    <section className="border border-[#152a46] bg-[#0b1f3a] text-white" style={{ borderTopColor: accentColor, borderTopWidth: 3 }}>
      <div className="flex flex-wrap items-center gap-x-5 gap-y-3 px-4 py-4 sm:px-6">
        <Icon aria-hidden className="h-8 w-8 shrink-0" style={{ color: accentColor }} />
        <div className="min-w-0">
          <p className="text-sm font-black tracking-tight text-white">{title}</p>
          <p className="mt-1 flex flex-wrap items-baseline gap-x-2">
            <span className="text-4xl font-black leading-none tabular-nums" style={{ color: accentColor }}>
              #{rank}
            </span>
            <span className="text-2xl font-black leading-none tabular-nums text-white/70">/ {outOf}</span>
            <span className="text-phx-2xs font-bold uppercase tracking-[0.14em] text-white/60">{outOfNote}</span>
          </p>
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-x-5 gap-y-2">
          <div className="border-l border-white/15 pl-4">
            <Trend className="text-base" value={trend} />
            <p className="mt-0.5 text-phx-2xs font-bold uppercase tracking-[0.14em] text-white/50">vs previous</p>
          </div>
          <p className="border-l border-white/15 pl-4 text-phx-2xs font-black uppercase tracking-[0.18em] text-white/70">
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
      <span className="whitespace-nowrap text-phx-2xs font-black uppercase tracking-[0.18em] text-slate-500">{label}</span>
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
          <thead className={TABLE_HEAD_CLASS}>
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
              <tr className={TABLE_ROW_CLASS} key={entry.key}>
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
          <li className="flex items-start gap-3 py-3" key={entry.key}>
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
                  <span className="mt-0.5 block whitespace-nowrap text-phx-2xs tabular-nums text-slate-500">
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
    (next: Partial<{ mode: string; period: string; lines: string[]; titles: string[]; regions: string[]; q: string }>) => {
      const params = new URLSearchParams();
      const mode = next.mode ?? data.mode;
      const period = next.period ?? data.window.anchor;
      const lines = next.lines ?? [...data.filters.lines];
      const titles = next.titles ?? [...data.filters.titles];
      const regions = next.regions ?? [...data.filters.regions];
      const query = next.q ?? data.filters.query;
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
      {/* ── Page header ── */}
      <section className={cn(SURFACE_CLASS, "relative border-t-[3px] border-t-orange-500")}>
        <div className="px-5 py-5 sm:px-7 sm:py-6">
          <p className="text-phx-xs font-black uppercase tracking-[0.24em] text-orange-600">Commercial Performance</p>
          <h1 className="mt-1 text-3xl font-black leading-tight tracking-tight text-slate-900 sm:text-[2.2rem]">Rankings</h1>
          <p className="mt-2 text-sm text-slate-600">
            {data.window.label} · {data.window.rangeLabel} · {scopeLabel} · Monthly Closing, published months only
          </p>
        </div>
      </section>

      {/* ── Filters ── */}
      <section className={cn(SURFACE_CLASS, "px-4 py-4 sm:px-5")}>
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="whitespace-nowrap text-phx-2xs font-black uppercase tracking-[0.18em] text-slate-500">Period</span>
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
              <span className="whitespace-nowrap text-phx-2xs font-black uppercase tracking-[0.18em] text-slate-500">
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

          <form
            className="flex flex-wrap items-center gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              push({ q: queryDraft });
            }}
          >
            <span className="whitespace-nowrap text-phx-2xs font-black uppercase tracking-[0.18em] text-slate-500">Person</span>
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

        {/* ── Per-line boards, when more than one line is in scope ── */}
        {data.boards.byLine.length > 1 ? (
          <div className="grid gap-3 xl:grid-cols-2">
            {data.boards.byLine.map((board) => (
              <SectionCard
                icon={Crosshair}
                key={board.lineCode}
                subtitle={
                  board.seats != null
                    ? `${board.entries.length} ranked of ${board.seats} rep seats · ${board.vacant ?? 0} vacant`
                    : `${board.entries.length} ranked`
                }
                title={`Top 5 — ${board.lineLabel} line`}
              >
                <BoardTable entries={board.entries.slice(0, 5)} showLine={false} />
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
          title={focus ? `${focus.entry.name} — where the filters place him` : `Full ranking — ${scopeLabel}`}
        >
          {data.boards.overall.length === 0 ? (
            <p className="py-6 text-center text-sm text-slate-600">
              Nobody in this window matches those filters. A rep with no target in the window is not ranked — his
              achievement would be arithmetic, not performance.
            </p>
          ) : (
            <BoardTable entries={data.boards.overall} showLine={data.filters.lines.length !== 1} />
          )}
        </SectionCard>
      </div>
    </div>
  );
}
