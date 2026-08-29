"use client";

/**
 * The HR command centre's chrome.
 *
 * DESIGN IDENTITY is the finance command centre's, deliberately (AGENTS.md §4: match the sibling
 * pages, never invent a one-off look). Same centred MetricTile with its 9px uppercase micro-label,
 * same `text-3xl font-black tabular-nums` figure, same orange accent, same four tones. What is new
 * is the GROUPING: finance is one long page of sections, this is a page of FUNCTIONS, because that
 * is what an HR seat is composed of. The group header carries the icon so the tiles underneath can
 * be pure figures — repeating one icon across five tiles is noise, not polish.
 *
 * NO TABLE, AT ANY BREAKPOINT. Every figure here is a link to the page that actions it, so this is
 * a grid of cards on a phone and a grid of cards on a desktop. The `md:` table split exists for
 * genuine tables, and there is not one on this page.
 *
 * TWO COLUMNS ON A PHONE, not one. These are compact figures rather than wide rows, and a single
 * column would make a five-tile group a scroll marathon on a 375px screen. The tile's min height
 * and centred axis are what make the pair read cleanly at that width.
 *
 * THE HERO matches Finance's exactly, too — `AdminHeroFrame` + `CeoHeroIdentity`, not the flatter
 * `PremiumHero` this used to carry. HR Advisory and HR Operations only opened 1 September 2026, so
 * neither seat has a photo on file yet; `CeoHeroIdentity`'s initials medallion is what fills that
 * gap instead of an empty slot until whoever holds the seat uploads a real one at /admin/profile.
 *
 * EVERYTHING BELOW THE HERO IS A REUSE, NOT AN INVENTION. The status strip is `AdminInsightChip`
 * exactly as it renders on 55 other pages, tallying a signal the data layer already computed
 * (`tile.tone`) rather than a second opinion on urgency. The group header's icon badge borrows
 * `AdminStatCard`'s icon-container language. The tile's hover lift and corner arrow reuse
 * `AdminLinkHint`'s icon and QueueRow's "this goes somewhere" idea, gated behind `group/tile` —
 * declared on the tile long before anything consumed it. None of it touches the tile's RESTING
 * state, which still matches Finance's pixel for pixel.
 *
 * WHY THIS IS A CLIENT COMPONENT. The toolbar below (filter, attention-only, collapse, jump-to)
 * is per-viewer view state, not data — nothing here re-queries, and every figure still arrives
 * server-rendered as props. Filtering is a pure function of `data.groups`, so the numbers a seat
 * sees are always the numbers the server computed; the toolbar can only ever hide a tile, never
 * change one. That matters on a page whose whole job is to be trusted at a glance.
 *
 * THE COLLAPSE STATE IS DELIBERATELY PER-BROWSER (localStorage), not a saved preference. It is a
 * convenience for one person on one machine, and wiring it to the database would mean a write on
 * every disclosure toggle for something nobody would miss if it reset.
 *
 * NO ELLIPSIS, NO WRAPPING (owner's standing rule). Chips carry `whitespace-nowrap` and the ROW
 * wraps instead — the text inside a control never does, and nothing here is ever truncated.
 */

import {
  ArrowUpRight,
  BriefcaseBusiness,
  ChevronDown,
  Fingerprint,
  FileSpreadsheet,
  HeartPulse,
  Hourglass,
  IdCard,
  Network,
  Search,
  ShieldCheck,
  TriangleAlert,
  UsersRound,
  X,
  type LucideIcon,
} from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";

import { AdminHeroFrame, AdminInsightChip } from "@/components/admin/admin-design-system";
import { CeoHeroIdentity } from "@/components/admin/ceo-hero-identity";
import type { HrFunctionKey } from "@/lib/auth/hr-functions";
import type { HrCommandCenterData, HrCommandGroup, HrCommandTile } from "@/lib/hr/command-center";

const GROUP_ICONS: Record<HrFunctionKey, LucideIcon> = {
  engagement_retention: HeartPulse,
  hr_governance: ShieldCheck,
  payroll_inputs: FileSpreadsheet,
  people_records: IdCard,
  performance_probation: Hourglass,
  recruiting: BriefcaseBusiness,
  time_attendance: Fingerprint,
  workforce_insight: Network,
};

/** Per-browser, per-viewer. See the header — this is a convenience, not a saved preference. */
const COLLAPSE_STORAGE_KEY = "phoenix.hr-command-center.collapsed-groups";

/**
 * Tailwind cannot build a class name at runtime — `lg:grid-cols-${n}` is purged and silently
 * renders as one column. So the column counts are literals, looked up by tile count.
 */
const GRID_BY_COUNT: Record<number, string> = {
  1: "sm:grid-cols-1",
  2: "sm:grid-cols-2",
  3: "sm:grid-cols-2 lg:grid-cols-3",
  4: "sm:grid-cols-2 lg:grid-cols-4",
  5: "sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5",
  6: "sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6",
  // 7-10 exist because people_records now carries up to TEN tiles (records, resignations, four
  // clearance tiles, contracts). Without them the `??` fallback below silently applies a 4-column
  // grid, which leaves nine tiles as 4 + 4 + 1 - a ragged single tile that reads as a rendering
  // fault. Every value here is a LITERAL class string because Tailwind cannot build a class name
  // at runtime: `lg:grid-cols-${n}` is purged from the stylesheet and the grid silently collapses
  // to one column.
  7: "sm:grid-cols-2 lg:grid-cols-4",
  8: "sm:grid-cols-2 lg:grid-cols-4",
  9: "sm:grid-cols-3 lg:grid-cols-3",
  10: "sm:grid-cols-2 lg:grid-cols-5",
};

function needsAttention(tile: HrCommandTile): boolean {
  return tile.tone === "amber" || tile.tone === "rose";
}

function MetricTile({ tile }: { tile: HrCommandTile }) {
  const toneClass = {
    amber: "text-amber-700",
    emerald: "text-emerald-700",
    rose: "text-rose-700",
    slate: "text-slate-900",
  }[tile.tone];
  // A thin top-edge stripe in the tile's own tone, so a group scans as a row of colour before it
  // scans as a row of numbers. Purely decorative - the tone already governs the figure's own
  // colour above; this repeats the same signal, not a second one.
  const toneBarClass = {
    amber: "bg-amber-400",
    emerald: "bg-emerald-400",
    rose: "bg-rose-400",
    slate: "bg-slate-200",
  }[tile.tone];

  return (
    <Link
      className="group/tile relative min-h-32 border border-slate-200 bg-white px-4 py-4 text-center transition-all duration-200 hover:-translate-y-0.5 hover:border-orange-200 hover:bg-slate-50 hover:shadow-[0_10px_24px_rgba(15,23,42,0.08)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500"
      href={tile.href}
    >
      <span aria-hidden="true" className={`absolute inset-x-0 top-0 h-0.5 ${toneBarClass}`} />
      {/* `group/tile` was declared but never consumed before this - the tile already looked like a
          link (hover:bg-slate-50), it just never confirmed "you are going somewhere" the way
          QueueRow's trailing arrow does. Hidden at rest so it costs the resting card nothing. */}
      <ArrowUpRight
        aria-hidden="true"
        className="absolute right-2 top-2.5 h-3.5 w-3.5 text-orange-400 opacity-0 transition-opacity duration-200 group-hover/tile:opacity-100"
      />
      <div className="text-[9px] font-black uppercase leading-tight tracking-[0.14em] text-slate-500">
        {tile.label}
      </div>
      <p className={`mt-4 text-3xl font-black leading-none tabular-nums ${toneClass}`}>
        {tile.value.toLocaleString("en-US")}
      </p>
      <p className="mt-2 text-[10px] font-bold uppercase tracking-[0.12em] text-slate-400">
        {tile.sub}
      </p>
    </Link>
  );
}

/**
 * Named rather than counted. A dashboard quietly short one group reads as "nothing to do today",
 * which is the one wrong answer a queue of people waiting can give.
 */
function UnavailableNotice({ sources }: { sources: string[] }) {
  return (
    <div className="mx-5 mb-5 flex items-start gap-3 border border-amber-200 bg-amber-50 px-4 py-3">
      <TriangleAlert aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
      <p className="text-[11px] font-semibold leading-relaxed text-amber-900">
        Some figures could not be loaded and are not shown below:{" "}
        <span className="font-black">{sources.join(", ")}</span>. Everything else on this page is
        current.
      </p>
    </div>
  );
}

export function HrCommandCenter({
  data,
  viewerImageUrl,
  viewerInitials,
  viewerName,
}: {
  data: HrCommandCenterData;
  viewerImageUrl?: string | null;
  viewerInitials?: string;
  viewerName: string;
}) {
  const [query, setQuery] = useState("");
  const [attentionOnly, setAttentionOnly] = useState(false);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set<string>());
  const searchRef = useRef<HTMLInputElement>(null);

  // Restore the collapse state. Deferred out of the effect body because `setState` called
  // synchronously inside an effect is a lint ERROR in this repo, and wrapped because localStorage
  // throws outright in some privacy modes rather than returning null.
  useEffect(() => {
    const id = setTimeout(() => {
      try {
        const raw = window.localStorage.getItem(COLLAPSE_STORAGE_KEY);
        if (!raw) return;
        const parsed: unknown = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          setCollapsed(new Set(parsed.filter((key): key is string => typeof key === "string")));
        }
      } catch {
        // A viewer with site data blocked simply gets every group expanded. Not worth a message.
      }
    }, 0);
    return () => clearTimeout(id);
  }, []);

  // `/` focuses the filter and Escape clears it — the two shortcuts worth having on a page whose
  // job is to be scanned quickly. Guarded so `/` typed INTO a field stays a slash.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      const isTyping =
        !!target &&
        (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);

      if (event.key === "/" && !isTyping) {
        event.preventDefault();
        searchRef.current?.focus();
        return;
      }
      if (event.key === "Escape" && target === searchRef.current) {
        setQuery("");
        searchRef.current?.blur();
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  function toggleGroup(functionKey: string) {
    setCollapsed((previous) => {
      const next = new Set(previous);
      if (next.has(functionKey)) next.delete(functionKey);
      else next.add(functionKey);
      try {
        window.localStorage.setItem(COLLAPSE_STORAGE_KEY, JSON.stringify([...next]));
      } catch {
        // Persisting is the nice-to-have; collapsing still works for this visit.
      }
      return next;
    });
  }

  // Cuts across every group's tiles rather than reporting per group, because the seat opens this
  // page once a day and wants ONE answer to "do I need to do anything", not eight partial ones.
  // Reuses each tile's own tone rather than re-deriving urgency - the data layer already decided
  // what counts as amber/rose per figure (see queueTone/TILES_BY_FUNCTION in command-center.ts),
  // so this is a count of an existing signal, never a second opinion on it.
  const attentionCount = useMemo(
    () => data.groups.flatMap((group) => group.tiles).filter(needsAttention).length,
    [data.groups],
  );

  const trimmedQuery = query.trim().toLowerCase();
  const isFiltering = trimmedQuery.length > 0 || attentionOnly;

  // Pure view state over the server's own numbers — this can hide a tile, never alter one.
  // Matching includes the GROUP label so "recruiting" surfaces that whole group, which is how
  // someone who thinks in functions rather than figure names will actually search.
  const visibleGroups: HrCommandGroup[] = useMemo(() => {
    if (!isFiltering) return data.groups;
    return data.groups
      .map((group) => ({
        ...group,
        tiles: group.tiles.filter((tile) => {
          if (attentionOnly && !needsAttention(tile)) return false;
          if (!trimmedQuery) return true;
          return (
            tile.label.toLowerCase().includes(trimmedQuery) ||
            tile.sub.toLowerCase().includes(trimmedQuery) ||
            group.label.toLowerCase().includes(trimmedQuery)
          );
        }),
      }))
      .filter((group) => group.tiles.length > 0);
  }, [attentionOnly, data.groups, isFiltering, trimmedQuery]);

  const visibleTileCount = visibleGroups.reduce((total, group) => total + group.tiles.length, 0);

  function jumpToGroup(functionKey: string) {
    document
      .getElementById(`hr-group-${functionKey}`)
      ?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  return (
    <div className="min-w-0 max-w-full overflow-x-hidden">
      <AdminHeroFrame className="z-10 overflow-visible">
        <div className="p-5 sm:p-6 lg:p-8">
          <div className="mb-5 inline-flex items-center gap-2 border border-orange-400/40 bg-orange-500/15 px-3 py-1.5 text-phx-3xs font-black uppercase tracking-[0.22em] text-orange-100">
            <UsersRound aria-hidden="true" className="h-3.5 w-3.5" />
            HR Command Center
          </div>
          <CeoHeroIdentity
            flushToEdges
            fullName={viewerName}
            imageUrl={viewerImageUrl}
            initials={viewerInitials}
            roleLabel={data.seat}
            subGreeting="Your day, by the part of the job it belongs to."
          />
        </div>
      </AdminHeroFrame>

      {/* At-a-glance status strip - light surface, sits below the dark hero rather than inside it
          so it can never disturb CeoHeroIdentity's vertically-centred initials medallion. Reuses
          AdminInsightChip exactly as built (no new colour tokens): "orange" is this app's existing
          pay-attention accent, "emerald" its existing all-clear one. */}
      <div className="flex flex-wrap items-center gap-2 border-b border-slate-100 bg-slate-50/60 px-5 py-3">
        {attentionCount > 0 ? (
          <AdminInsightChip tone="orange">
            <span className="whitespace-nowrap">
              {attentionCount} {attentionCount === 1 ? "item needs" : "items need"} your attention
              today
            </span>
          </AdminInsightChip>
        ) : (
          <AdminInsightChip tone="emerald">
            <span className="whitespace-nowrap">All caught up - nothing waiting on you</span>
          </AdminInsightChip>
        )}
      </div>

      {/* ── Toolbar. Filter, attention-only, and a jump chip per group. Not sticky on purpose:
          AppShell already freezes the page chrome, and a second sticky at the same offset is the
          trap documented in admin-design-system.tsx. ── */}
      <div className="border-b border-slate-200/70 bg-white px-5 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-0 flex-1 sm:max-w-xs">
            <Search
              aria-hidden="true"
              className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400"
            />
            <input
              aria-label="Filter figures on this page"
              className="w-full border border-slate-200 bg-white py-2 pl-9 pr-16 text-[12px] font-semibold text-slate-900 placeholder:text-slate-400 focus:border-orange-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500"
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Filter figures..."
              ref={searchRef}
              type="search"
              value={query}
            />
            {query ? (
              <button
                aria-label="Clear the filter"
                className="absolute right-2 top-1/2 -translate-y-1/2 border border-slate-200 bg-white p-1 text-slate-400 transition-colors hover:text-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500"
                onClick={() => {
                  setQuery("");
                  searchRef.current?.focus();
                }}
                type="button"
              >
                <X aria-hidden="true" className="h-3 w-3" />
              </button>
            ) : (
              // The shortcut hint doubles as the affordance that teaches it exists.
              <kbd className="pointer-events-none absolute right-2.5 top-1/2 hidden -translate-y-1/2 border border-slate-200 bg-slate-50 px-1.5 py-0.5 text-[10px] font-black text-slate-400 sm:block">
                /
              </kbd>
            )}
          </div>

          <button
            aria-pressed={attentionOnly}
            className={`inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap border px-3 py-2 text-[10px] font-black uppercase tracking-[0.12em] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500 ${
              attentionOnly
                ? "border-orange-300 bg-orange-50 text-orange-700"
                : "border-slate-200 bg-white text-slate-500 hover:bg-slate-50"
            }`}
            onClick={() => setAttentionOnly((previous) => !previous)}
            type="button"
          >
            <TriangleAlert aria-hidden="true" className="h-3.5 w-3.5" />
            Needs attention
            <span className="tabular-nums">({attentionCount})</span>
          </button>

          {/* Jump-to. Only worth showing when nothing is filtered, since a filtered page is
              already short enough to see whole. */}
          {!isFiltering ? (
            <div className="hidden flex-wrap items-center gap-1.5 lg:flex">
              {data.groups.map((group) => {
                const Icon = GROUP_ICONS[group.functionKey];
                return (
                  <button
                    className="inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap border border-slate-200 bg-white px-2.5 py-2 text-[10px] font-black uppercase tracking-[0.12em] text-slate-500 transition-colors hover:border-orange-200 hover:bg-orange-50 hover:text-orange-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500"
                    key={group.functionKey}
                    onClick={() => jumpToGroup(group.functionKey)}
                    type="button"
                  >
                    <Icon aria-hidden="true" className="h-3.5 w-3.5" />
                    {group.label}
                  </button>
                );
              })}
            </div>
          ) : null}
        </div>

        {/* A filtered page must say what it is showing, or a short page reads as an empty one. */}
        {isFiltering ? (
          <p className="mt-2 text-[11px] font-semibold text-slate-500">
            Showing {visibleTileCount} of {data.groups.flatMap((group) => group.tiles).length}{" "}
            figures
            {attentionOnly ? " that need attention" : ""}
            {trimmedQuery ? ` matching "${query.trim()}"` : ""}.
          </p>
        ) : null}
      </div>

      {data.unavailableSources.length > 0 ? (
        <UnavailableNotice sources={data.unavailableSources} />
      ) : null}

      {isFiltering && visibleGroups.length === 0 ? (
        <div className="px-5 py-12 text-center">
          <p className="text-sm font-black text-slate-900">Nothing matches that filter</p>
          <p className="mt-1.5 text-[12px] font-semibold text-slate-500">
            {attentionOnly && attentionCount === 0
              ? "Nothing on this page needs your attention right now."
              : "Try a different word, or clear the filter to see every figure."}
          </p>
          <button
            className="mt-4 inline-flex items-center gap-1.5 border border-slate-200 bg-white px-3 py-2 text-[10px] font-black uppercase tracking-[0.12em] text-slate-600 transition-colors hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500"
            onClick={() => {
              setQuery("");
              setAttentionOnly(false);
            }}
            type="button"
          >
            <X aria-hidden="true" className="h-3.5 w-3.5" />
            Clear the filter
          </button>
        </div>
      ) : null}

      {visibleGroups.map((group) => {
        const Icon = GROUP_ICONS[group.functionKey];
        const grid = GRID_BY_COUNT[group.tiles.length] ?? "sm:grid-cols-2 lg:grid-cols-4";
        // A filtered view is always expanded: the seat asked to see these, so honouring a
        // collapse saved yesterday would hide the very thing they just searched for.
        const isCollapsed = collapsed.has(group.functionKey) && !isFiltering;
        const groupAttention = group.tiles.filter(needsAttention).length;

        return (
          <section
            className="border-t border-slate-100 scroll-mt-4"
            id={`hr-group-${group.functionKey}`}
            key={group.functionKey}
          >
            <button
              aria-controls={`hr-group-tiles-${group.functionKey}`}
              aria-expanded={!isCollapsed}
              className="flex w-full items-start gap-3 border-b border-slate-200/70 bg-gradient-to-b from-white to-slate-50/60 px-5 py-4 text-left transition-colors hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-orange-500"
              onClick={() => toggleGroup(group.functionKey)}
              type="button"
            >
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-orange-200 bg-gradient-to-br from-orange-50 to-orange-100 text-orange-600 shadow-[0_4px_10px_rgba(249,115,22,0.14)]">
                <Icon aria-hidden="true" className="h-4 w-4" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex flex-wrap items-center gap-2">
                  <span className="text-[11px] font-black uppercase tracking-[0.14em] text-slate-950">
                    {group.label}
                  </span>
                  {/* The count travels with the header, so a collapsed group still says whether
                      anything inside it is waiting — otherwise collapsing could hide a queue. */}
                  {groupAttention > 0 ? (
                    <span className="whitespace-nowrap border border-orange-200 bg-orange-50 px-1.5 py-0.5 text-[9px] font-black uppercase tracking-[0.12em] text-orange-700">
                      {groupAttention} to action
                    </span>
                  ) : null}
                </span>
                <span className="mt-1 block text-[11px] font-semibold leading-relaxed text-slate-500">
                  {group.summary}
                </span>
              </span>
              <ChevronDown
                aria-hidden="true"
                className={`mt-0.5 h-4 w-4 shrink-0 text-slate-400 transition-transform duration-200 ${
                  isCollapsed ? "-rotate-90" : ""
                }`}
              />
            </button>
            {isCollapsed ? null : (
              <div
                className={`grid grid-cols-2 gap-2 p-5 ${grid}`}
                id={`hr-group-tiles-${group.functionKey}`}
              >
                {group.tiles.map((tile) => (
                  <MetricTile key={tile.key} tile={tile} />
                ))}
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}
