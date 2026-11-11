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
 * THE HERO IS A 92px STRIP, NOT A BAND — see the note at the top of the returned tree. It matched
 * Finance's exactly (`AdminHeroFrame` + `CeoHeroIdentity`) until the owner removed it on
 * 2026-09-03 for taking a third of the first screen, then asked the same day for the identity back
 * in the employee portal's language and under 96px tall. Height, not presence, is the rule that
 * survived both instructions.
 *
 * EVERYTHING ON THIS PAGE IS A REUSE, NOT AN INVENTION. The group header's icon badge borrows
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
  Mail,
  ArrowUpRight,
  Award,
  BriefcaseBusiness,
  CalendarDays,
  ChevronDown,
  Fingerprint,
  FileSearch,
  FileSignature,
  FileSpreadsheet,
  HeartPulse,
  LifeBuoy,
  Hourglass,
  IdCard,
  Network,
  Search,
  ShieldCheck,
  StickyNote,
  TriangleAlert,
  UserRound,
  X,
  type LucideIcon,
} from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";

import { HrCommandCharts } from "@/components/hr/hr-command-charts";
import { HrMyRecord } from "@/components/hr/hr-my-record";
import { HrOnVacationToday } from "@/components/hr/hr-on-vacation-today";
import { HrTodayPanel } from "@/components/hr/hr-today-panel";
import { PushOptInNudge } from "@/components/notifications/push-opt-in-nudge";
import { PhoenixIdentityStrip } from "@/components/phoenix-signature-card/PhoenixIdentityStrip";
import { type HrFunctionKey } from "@/lib/auth/hr-functions";
import type { HrCommandCenterData, HrCommandGroup, HrCommandTile } from "@/lib/hr/command-center";
import { phxFieldClassName } from "@/components/ui/form-tokens";
import { cn } from "@/lib/utils";

const GROUP_ICONS: Record<HrFunctionKey, LucideIcon> = {
  // `cv_lookup` contributes no tiles and no charts (SOURCES_BY_FUNCTION.cv_lookup — a candidate
  // figure here would show the size of the pool to the one seat the pool is withheld from), so
  // buildGroups never emits a group for it and this icon is never drawn. It is declared anyway
  // because the Record is exhaustive: a missing key is a runtime crash on the page HR opens every
  // morning, and leaving it out "because nothing renders it" bets on a function never earning a tile.
  cv_lookup: FileSearch,
  engagement_retention: HeartPulse,
  hr_communication: Mail,
  hr_governance: ShieldCheck,
  payroll_inputs: FileSpreadsheet,
  people_records: IdCard,
  performance_probation: Hourglass,
  recruiting: BriefcaseBusiness,
  time_attendance: Fingerprint,
  workforce_insight: Network,
  // The Talent Acquisition seat's four non-recruiting functions (2026-10-08). Only
  // employee_requests draws a group today; the other three contribute no tiles, and are declared for
  // the reason cv_lookup is above.
  employee_requests: LifeBuoy,
  hiring_paperwork: FileSignature,
  hiring_desk: FileSignature,
  hr_calendars: CalendarDays,
  workforce_context: Network,
  recognition: Award,
  team_reminders: StickyNote,
  // The HR Operations Specialist seat's two functions (2026-10-20). Both draw a group on her
  // Overview: the Daily & Weekly Reports queue, and the personnel records without money.
  attendance_review: Fingerprint,
  people_master: IdCard,
};

/**
 * What the identity strip needs. A narrowed shape rather than `ViewerIdentity` itself, because
 * this page has no business with the rest of that type and a narrower prop is one less thing a
 * future change to the auth module can silently alter here.
 */
export type HrCommandCenterIdentity = {
  displayName: string;
  employeeCode: string | null;
  photoUrl: string | null;
  /** The seat's JOB TITLE, already resolved — never the raw permission key. */
  roleLabel: string;
};

/** Per-browser, per-viewer. See the header — this is a convenience, not a saved preference. */
const COLLAPSE_STORAGE_KEY = "phoenix.hr-command-center.collapsed-groups";

/** The pendings panel the "Needs attention" button opens — named once, so the button's
 *  `aria-controls` and the panel's `id` can never drift apart into a dangling reference. */
const PENDINGS_PANEL_ID = "hr-pendings";

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
  // 7-10 exist because people_records carries the most tiles of any function (records,
  // resignations, contracts). Without them the `??` fallback below silently applies a 4-column
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
  //
  // It FADES AT BOTH ENDS as of 2026-09-03 (the owner's premium pass). A hard edge-to-edge bar
  // butts into the tile's own border at each corner and reads as a rendering seam; tapering it
  // makes the same signal look chosen. Literal hex rather than Tailwind colour classes because
  // this is one arbitrary background-image value, not five utilities.
  const toneBarClass = {
    amber: "bg-[linear-gradient(90deg,transparent_0%,#FBBF24_18%,#F59E0B_50%,#FBBF24_82%,transparent_100%)]",
    emerald: "bg-[linear-gradient(90deg,transparent_0%,#34D399_18%,#10B981_50%,#34D399_82%,transparent_100%)]",
    rose: "bg-[linear-gradient(90deg,transparent_0%,#FB7185_18%,#F43F5E_50%,#FB7185_82%,transparent_100%)]",
    slate: "bg-[linear-gradient(90deg,transparent_0%,#CBD5E1_20%,#94A3B8_50%,#CBD5E1_80%,transparent_100%)]",
  }[tile.tone];

  return (
    <Link
      // RESTING STATE CARRIES THE POLISH, not just the hover (owner's premium pass, 2026-09-03).
      // It was flat #FFF inside a hard 1px border, which is a box rather than a card: on a grid of
      // five it read as table cells. It now sits on a barely-there top-to-bottom wash with a
      // hairline contact shadow, and brightens to pure white as it lifts. Every value here is a
      // colour or a shadow - the tile's size, min-height and centred axis are untouched, so it
      // still matches Finance's tile pixel for pixel where it counts.
      className="group/tile relative min-h-32 border border-slate-200/90 bg-[linear-gradient(180deg,#FFFFFF_0%,#FDFEFF_55%,#F7F9FC_100%)] px-4 py-4 text-center shadow-[0_1px_2px_rgba(15,23,42,0.045)] transition-all duration-200 hover:-translate-y-0.5 hover:border-orange-200 hover:bg-[linear-gradient(180deg,#FFFFFF_0%,#FFFFFF_100%)] hover:shadow-[0_14px_30px_rgba(15,23,42,0.11)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500"
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
      {/* `valueLabel` wins when the fact has no unit — see HrCommandTile.valueLabel. `break-words`
          because a label is prose and prose is the thing that can outgrow its box: the owner's
          golden rule is that this page never scrolls sideways, and wrapping is the permitted
          answer. `tabular-nums` is inert on letters, so one class list serves both cases. */}
      <p className={`mt-4 break-words text-3xl font-black leading-none tabular-nums ${toneClass}`}>
        {tile.valueLabel ?? tile.value.toLocaleString("en-US")}
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


/**
 * The Hired tile's window, as a from/to pair.
 *
 * WHY IT IS IN THE URL and not in component state: the count is made on the SERVER over every
 * application the seat can see, not over a subset already on the page, so changing the window has
 * to reach the server. Putting it in the query string also makes a chosen range shareable and
 * survivable across a reload, and "Reset" is then simply the absence of both params.
 *
 * Square edges and a wrapping row, per the house rules — the two date boxes and the buttons drop
 * onto a second line at 375px rather than pushing the group into a horizontal scroll.
 */
function HiredWindowPicker({ window: current }: { window: { fromIso: string; toIso: string } }) {
  // NOTE: the caller gives this component a `key` built from the resolved window, so a window the
  // server normalised (a reversed or malformed range) REMOUNTS it and the boxes re-seed from what
  // was actually counted. Syncing props into state with an effect would do the same job and is a
  // lint ERROR in this repo (react-hooks/set-state-in-effect) as well as a cascading render.
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [from, setFrom] = useState(current.fromIso);
  const [to, setTo] = useState(current.toIso);

  function apply(next: { from: string; to: string } | null) {
    const params = new URLSearchParams(searchParams?.toString() ?? "");
    if (next) {
      params.set("hiredFrom", next.from);
      params.set("hiredTo", next.to);
    } else {
      params.delete("hiredFrom");
      params.delete("hiredTo");
    }
    const query = params.toString();
    router.push(query ? `${pathname}?${query}` : pathname);
  }

  const isDefault = !searchParams?.get("hiredFrom") && !searchParams?.get("hiredTo");

  return (
    <div className="flex flex-wrap items-end gap-2 border-b border-slate-200/70 bg-slate-50/60 px-5 py-3">
      <span className="w-full text-[9px] font-black uppercase tracking-[0.14em] text-slate-500 sm:w-auto sm:self-center">
        Hired between
      </span>
      <label className="flex flex-col gap-1">
        <span className="text-[9px] font-bold uppercase tracking-[0.12em] text-slate-400">From</span>
        <input
          className={phxFieldClassName}
          onChange={(event) => setFrom(event.target.value)}
          type="date"
          value={from}
        />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-[9px] font-bold uppercase tracking-[0.12em] text-slate-400">To</span>
        <input
          className={phxFieldClassName}
          onChange={(event) => setTo(event.target.value)}
          type="date"
          value={to}
        />
      </label>
      <button
        className="border border-orange-300 bg-orange-50 px-3 py-2 text-[10px] font-black uppercase tracking-[0.12em] text-orange-700 transition-colors hover:bg-orange-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500"
        onClick={() => apply({ from, to })}
        type="button"
      >
        Apply
      </button>
      {isDefault ? null : (
        <button
          className="border border-slate-200 bg-white px-3 py-2 text-[10px] font-black uppercase tracking-[0.12em] text-slate-600 transition-colors hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500"
          onClick={() => apply(null)}
          type="button"
        >
          This month
        </button>
      )}
    </div>
  );
}

export function HrCommandCenter({
  data,
  identity,
}: {
  data: HrCommandCenterData;
  /**
   * The signed-in seat, for the identity strip at the top. Resolved by the page from
   * `resolveViewerIdentityFromPage`, which is the same source the topbar chip reads — so the
   * strip and the chip can never disagree about whose account this is.
   */
  identity: HrCommandCenterIdentity;
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

  /** Every figure the seat can see. The ring's denominator, and the filter summary's. */
  const totalTileCount = useMemo(
    () => data.groups.reduce((total, group) => total + group.tiles.length, 0),
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
      {/* THE IDENTITY IS BACK, AS A STRIP — and the size is the whole point.

          History, because both halves of it were the owner's own instruction and a session that
          knows only one half will undo the other:

            1. This page opened with `AdminHeroFrame` + `CeoHeroIdentity`, matching Finance and
               the CEO — a full-bleed dark band holding a photo, a badge, a greeting and a clock.
               It cost roughly a THIRD of the first screen before one row of real work appeared,
               and on 2026-09-03 he removed it: "no heavy banner in any of her pages taking all
               the space".
            2. Later the same day he asked for the identity back, in the employee portal's
               language rather than the dark band's: "check the employee portal one ... but the
               most important thing that I don't want it to be too thick, too many space in the
               page. I want it to be narrow, to have much space for the page to show data." He
               set the height himself, under 96px.

          So the rule that survived both instructions is HEIGHT, not presence. `PhoenixIdentityStrip`
          is a fixed 120px on a phone and 160px from `sm` up — still a fraction of what the old band
          took and of the portal card it borrows from. THOSE NUMBERS ARE NOT THE ONES HE SET ON
          2026-09-03: he raised them himself on 09-04 ("make it taller and its weak") and again on
          2026-10-12 ("i want the photo bigger clear obvious"), which is what the desktop 160 buys.
          Read the height paragraphs in `PhoenixIdentityStrip` before quoting the 09-03 figure at
          anyone. Anything added here later is measured against the strip, not against how the CEO
          and Finance pages look: those keep their own heroes on purpose, and this divergence is
          still the instruction.

          It reads its seat from `resolveViewerIdentityFromPage`, the same source as the topbar
          chip, so the two can never disagree — including on the JOB TITLE, which that resolver
          maps through HR_SEAT_JOB_TITLES rather than printing the permission key. */}
      <PhoenixIdentityStrip
        employeeCode={identity.employeeCode}
        name={identity.displayName}
        photoSrc={identity.photoUrl}
        title={identity.roleLabel}
      />

      <PushOptInNudge />

      {/* ── Who is on a vacation today, by name (owner, 2026-09-29). It is the same kind of fact as
          the day panel — today's reality rather than a monthly figure — and it sits above the
          toolbar because the toolbar filters the COMPANY FIGURES below it, not this.
          Renders nothing at all when the source did not answer; see hr-on-vacation-today.tsx. ── */}
      <HrOnVacationToday rows={data.onVacationToday} />

      {/* ── Toolbar. Filter, attention-only, and a jump chip per group. Not sticky on purpose:
          AppShell already freezes the page chrome, and a second sticky at the same offset is the
          trap documented in admin-design-system.tsx. ── */}
      <div className="border-b border-slate-200/70 bg-white px-5 py-3">
        <div className="flex flex-wrap items-center gap-2">
          {/* Full width on a phone, sharing the row from `sm` up. Measured at 375px: sharing the
              row there leaves the field 127px, which clips its own placeholder — and the owner's
              standing rule is that text is never truncated.
              `sm:min-w-60` is that same rule at the OTHER end. The jump chips beside it are
              `shrink-0` and the field is `flex-1`, so every chip's width came out of the field:
              measured at 1440px it was squeezed to a 10px box holding 102px of placeholder — a
              clipped control that looked like a rendering fault. With a floor the chips wrap to
              the next line instead, which is what `flex-wrap` on this row is for. */}
          <div className="relative w-full min-w-0 sm:w-auto sm:min-w-60 sm:max-w-xs sm:flex-1">
            <Search
              aria-hidden="true"
              className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400"
            />
            <input
              aria-label="Filter figures on this page"
              className={cn(phxFieldClassName, "pl-9 pr-16")}
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

          {/* THE ONE ENTRY POINT TO THE WORK (owner, 2026-10-13: "the needs attentions button is
              fair enough make it show all pendings when clicked on and remove the upper part").
              It carries BOTH halves of "what needs me": pressing it opens every pending task below
              this toolbar AND narrows the figures to the ones carrying a queue. It is a disclosure
              as well as a filter, so it says both — `aria-expanded` for the panel it opens and
              `aria-pressed` for the filter it applies. */}
          <button
            aria-controls={PENDINGS_PANEL_ID}
            aria-expanded={attentionOnly}
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
              {/* The merged personal section gets a chip too — it is a section of this page now,
                  not a second page, and leaving it off the jump row would be the one part of the
                  page you can only reach by scrolling. */}
              <button
                className="inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap border border-slate-200 bg-white px-2.5 py-2 text-[10px] font-black uppercase tracking-[0.12em] text-slate-500 transition-colors hover:border-orange-200 hover:bg-orange-50 hover:text-orange-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500"
                onClick={() => jumpToGroup("my-record")}
                type="button"
              >
                <UserRound aria-hidden="true" className="h-3.5 w-3.5" />
                My Record
              </button>
            </div>
          ) : null}
        </div>

        {/* A filtered page must say what it is showing, or a short page reads as an empty one. */}
        {isFiltering ? (
          <p className="mt-2 text-[11px] font-semibold text-slate-500">
            Showing {visibleTileCount} of {totalTileCount} figures
            {attentionOnly ? " that need attention" : ""}
            {trimmedQuery ? ` matching "${query.trim()}"` : ""}.
          </p>
        ) : null}
      </div>

      {/* ── EVERY PENDING, BEHIND THAT ONE BUTTON.

          "Your day" used to stand open here, above the toolbar, and it was the first thing on the
          page after the identity strip. On 2026-10-13 the owner removed that whole upper block in
          his own words — "the needs attentions button is fair enough make it show all pendings when
          clicked on and remove the upper part" — so the panel is unchanged in LOOK and moved in
          PLACE: it is now what the button opens, with every waiting task already expanded
          (`openAll`), rather than a standing block the page opens on.

          Nothing was dropped to make room: the same tasks, the same real named rows inside them and
          the same links are one press away. The page itself now opens on the figures. ── */}
      {attentionOnly ? (
        <div id={PENDINGS_PANEL_ID}>
          <HrTodayPanel icons={GROUP_ICONS} openAll tasks={data.tasks} />
        </div>
      ) : null}

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
              <div id={`hr-group-tiles-${group.functionKey}`}>
                {/* The shape first, then the figures. A chart is the answer to a question the
                    tiles below it cannot reach — "is that a bad Tuesday or a fortnight of drift"
                    — so it reads before them, not as an appendix underneath.
                    Suppressed while a filter is active: the filter matches tile LABELS, so a
                    chart left standing beside two matched tiles would be showing a whole function
                    under a heading that says the page is showing two figures. */}
                {/* Only the recruiting group carries a window, because only its Hired tile is a
                    period figure — every other tile on this page is a count of how things stand
                    right now. Hidden while a filter is active, for the same reason the chart is:
                    a control over a figure the filter may have removed is a control over nothing. */}
                {group.functionKey === "recruiting" && !isFiltering ? (
                  <HiredWindowPicker
                    key={`${data.hiredWindow.fromIso}|${data.hiredWindow.toIso}`}
                    window={data.hiredWindow}
                  />
                ) : null}
                {isFiltering ? null : <HrCommandCharts charts={group.charts} />}
                <div className={`grid grid-cols-2 gap-2 p-5 ${grid}`}>
                  {group.tiles.map((tile) => (
                    <MetricTile key={tile.key} tile={tile} />
                  ))}
                </div>
              </div>
            )}
          </section>
        );
      })}

      {/* ── Her own record, merged in from the /workspace dashboard on 2026-09-01 at the owner's
          instruction. Hidden while a filter is active, because the filter is over the COMPANY
          figures above and a personal leave balance is not one of them — leaving it visible under
          "Showing 2 of 18 figures" would make the count read as a lie. ── */}
      {isFiltering ? null : <HrMyRecord record={data.personal} />}
    </div>
  );
}
