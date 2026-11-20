/**
 * The KPIs board's premium vocabulary — every visual part the four tabs share.
 *
 * ## Why this file exists at all
 *
 * The owner's standing rule is that a new screen matches its siblings and never invents a one-off
 * look. Four tabs that each spelled their own tile, meter and rank badge would match on the day
 * they were written and drift on the next change to any one of them — the Reps List chrome was
 * extracted for exactly this reason, and the comment at the top of reps-list-chrome.tsx is the
 * precedent this follows. One definition, four consumers.
 *
 * ## NO "use client", and that is load-bearing
 *
 * Everything here is pure markup: no state, no handlers, no effects. That keeps the whole board a
 * server component, which matters because a server component may never hand a FUNCTION to a client
 * one — React cannot serialise it and the page 500s on every load for everyone. That is not
 * hypothetical: it took /admin/doctor-coverage and its portal twin down for about an hour on
 * 2026-08-21. tests/rsc-client-function-props.test.ts walks the import graph and guards it.
 *
 * The one interactive piece, the filter panel, lives in kpis-filter-bar.tsx behind its own
 * "use client" and receives only plain data.
 *
 * ## Fits the screen
 *
 * The owner's golden rule forbids a horizontal scroll at any width. Nothing here sets a min-width,
 * nothing is `whitespace-nowrap` over content that can grow, and no value is ever truncated with an
 * ellipsis. Long names WRAP — that is the permitted answer and the ellipsis ban is untouched.
 *
 * ## text-phx-* never goes through cn()
 *
 * tailwind-merge SILENTLY strips custom named font sizes, so a `text-phx-sm` handed to `cn()`
 * disappears and only `getComputedStyle` in a real browser can see that it did. Every class string
 * in this file is a plain template literal for that reason.
 */

import Link from "next/link";

import { adminSoftDepthClassName } from "@/components/admin/admin-design-tokens";
import { LANDING_FOCUS, LANDING_INK, LANDING_NAVY_TILE, LandingTitle } from "@/components/employee-portal/landing-kit";
import { KPI_BAND_SHORT, type KpiBand } from "@/lib/crm/kpis-filters";
import { utcDate } from "@/lib/format/cairo-datetime";

// ── Tone ──────────────────────────────────────────────────────────────────────────────────────

/**
 * One tone per band, used by the meter, the chip, the tile and the podium alike.
 *
 * `noplan` is deliberately the quietest tone on the board. It is not a bad score — it is the
 * absence of one — and painting it rose would accuse a rep of missing a target nobody set him.
 *
 * ## The flat finish (owner, 22 Oct 2026: nothing may look machine-made)
 *
 * Every part of this board is flat colour: no gradient, no glow, no drop shadow, no inset track. The
 * 2026-09-08 "depth" pass gave the meters, tiles, medals and section bars two-stop gradients and
 * two-layer shadows; the premium pass of 9 Nov 2026 took them off again, because that finish is the
 * one the owner retired. `bar` fills a meter and caps a tile, `chip` is the band as a coloured word
 * on a 2px rail (the landing kit's status rule, never a filled pill), `text` prints a figure and
 * `dot` is the same tone as a pip. `onNavyText` / `onNavyBar` are the same tones on the page's one
 * night-navy board. The square-edge golden rule is untouched: not one class here rounds an edge.
 */
type Tone = { bar: string; chip: string; text: string; dot: string; onNavyText: string; onNavyBar: string };

const TONES: Record<KpiBand, Tone> = {
  elite: {
    bar: "bg-emerald-500",
    chip: "border-l-2 border-l-emerald-500 pl-1.5 text-emerald-700",
    text: "text-emerald-700",
    dot: "bg-emerald-500",
    onNavyText: "text-emerald-300",
    onNavyBar: "bg-emerald-400",
  },
  strong: {
    bar: "bg-sky-500",
    chip: "border-l-2 border-l-sky-500 pl-1.5 text-sky-700",
    text: "text-sky-700",
    dot: "bg-sky-500",
    onNavyText: "text-sky-300",
    onNavyBar: "bg-sky-400",
  },
  steady: {
    bar: "bg-amber-500",
    chip: "border-l-2 border-l-amber-500 pl-1.5 text-amber-700",
    text: "text-amber-700",
    dot: "bg-amber-500",
    onNavyText: "text-amber-300",
    onNavyBar: "bg-amber-400",
  },
  behind: {
    bar: "bg-rose-500",
    chip: "border-l-2 border-l-rose-500 pl-1.5 text-rose-700",
    text: "text-rose-700",
    dot: "bg-rose-500",
    onNavyText: "text-rose-300",
    onNavyBar: "bg-rose-400",
  },
  noplan: {
    bar: "bg-slate-300",
    chip: "border-l-2 border-l-slate-300 pl-1.5 text-slate-500",
    text: "text-slate-500",
    dot: "bg-slate-400",
    onNavyText: "text-white/60",
    onNavyBar: "bg-white/40",
  },
};

export function toneOf(band: KpiBand): Tone {
  return TONES[band];
}

/**
 * No depth. A card here is a 1px slate rule on white, and `shadow-none` tells the shell's ambient
 * `main` rule (`:not([class*="shadow"])`) to leave it flat rather than add a shadow of its own.
 */
const FLAT = "shadow-none";

// A DailyVisitBand tone map and chip lived here briefly (2026-09-05), for a combined AM+PM
// "visits/day" band the owner retracted the same week — see call-rate.ts's header comment where
// DAILY_VISIT_RATE_TARGET used to be. The correct PM-only band lives in kpi-reports-tables.tsx.

// ── Shared class strings ──────────────────────────────────────────────────────────────────────

/**
 * The page's outer sheet: the landing kit's white panel — a hairline and the platform's soft depth
 * token. Only the OUTER frame takes the depth; a card inside it stays a flat hairline, so there is
 * never a shadowed card on a card.
 */
export const PANEL = `border border-slate-200 bg-white ${adminSoftDepthClassName}`;
// One step larger BELOW `sm` only (11px on a phone, 10px from 640px up). Every table on this board
// renders from `md`, where the `sm:` size applies, so the measured desktop tables
// (tests/kpis-board-tables-fit.test.ts) are unchanged; only the phone cards and captions grow.
export const CAPTION = "text-phx-md text-slate-500 sm:text-phx-sm";
/** A white small-capital table head (the landing kit's): slate capitals on white, a hairline under the row. */
export const TH = "px-3 py-2.5 text-left text-phx-xs font-bold uppercase tracking-[0.1em] text-slate-500";
/** The row every `<thead>` on these boards wears: white, one hairline under it. */
export const THEAD = "border-b border-slate-200 bg-white";
export const TD = "px-3 py-3 align-top text-sm text-slate-700";
/** A figure cell: navy, tabular. */
export const NUM = `px-3 py-3 align-top text-sm font-semibold tabular-nums ${LANDING_INK}`;
/** A link inside a row or a caption: navy ink, an underline that darkens on hover, the orange keyboard ring. */
export const ROW_LINK = `underline decoration-slate-300 underline-offset-2 transition-colors hover:decoration-[#08111f] motion-reduce:transition-none ${LANDING_FOCUS}`;
/** A small outline action inside a row or a card: the landing kit's navy frame at row size. */
export const ROW_ACTION = `inline-flex min-h-8 items-center gap-1 border border-[#08111f] bg-white px-2 py-1 text-phx-xs font-bold uppercase tracking-[0.08em] ${LANDING_INK} transition-colors hover:bg-[#08111f] hover:text-white motion-reduce:transition-none ${LANDING_FOCUS}`;
/** A situation flag beside a name: a quiet coloured word on a 2px slate rail, never a filled pill. */
export const FLAG = "inline-block border-l-2 border-l-slate-300 pl-1.5 text-phx-xs font-semibold leading-4 text-slate-600";

// ── Section frame ─────────────────────────────────────────────────────────────────────────────

/**
 * A titled block: the landing kit's panel head — the orange tick, then the title in navy small
 * capitals on white, a hairline under it.
 *
 * A HEADER IS A TITLE (owner, 2026-11-20: "DELETE ANY TEXT UNDER ANY HEADER"), so `description` is
 * no longer drawn. The prop stays so no caller has to change at once; what a section needs to say
 * goes in its rows.
 */
export function KpiSection({
  action,
  children,
  title,
}: {
  action?: React.ReactNode;
  children: React.ReactNode;
  /** No longer drawn — a header is a title. Kept so existing callers still compile. */
  description?: string;
  title: string;
}) {
  return (
    <div className="border-b border-slate-200 bg-white last:border-b-0">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b border-slate-200 px-3 py-2.5 sm:px-4">
        <div className="min-w-0 flex-1">
          <LandingTitle>{title}</LandingTitle>
        </div>
        {action ? <div className="min-w-0">{action}</div> : null}
      </div>
      {children}
    </div>
  );
}

// ── Meter ─────────────────────────────────────────────────────────────────────────────────────

/**
 * The horizontal bar that turns a percentage into something readable at a glance.
 *
 * CLAMPED AT 100 for the fill only — the printed number keeps its real value. A call rate can
 * legitimately exceed its target, and a bar that overflowed its track would render as a full bar
 * for 101% and for 400% alike, which is the one reading a manager must not get.
 */
export function KpiMeter({ band, onNavy = false, value }: { band: KpiBand; onNavy?: boolean; value: number | null }) {
  const fill = value == null ? 0 : Math.max(0, Math.min(100, value));
  return (
    // Flat: a slate track and one tone of fill (a dim white track on the navy board). Height stays
    // h-1.5 — the row rhythm the four tables and the mobile card were measured against does not move.
    <div aria-hidden className={`relative mt-1.5 h-1.5 w-full overflow-hidden ${onNavy ? "bg-white/10" : "bg-slate-100"}`}>
      <div className={`h-full ${onNavy ? toneOf(band).onNavyBar : toneOf(band).bar}`} style={{ width: `${fill}%` }} />
    </div>
  );
}

/**
 * A band as a coloured small-capital word on a 2px rail of its own tone — the landing kit's status
 * rule, never a filled pill. Short label — this sits inside a table cell.
 */
export function KpiBandChip({ band, onNavy = false }: { band: KpiBand; onNavy?: boolean }) {
  const tone = toneOf(band);
  return (
    <span
      className={`inline-flex items-center text-phx-xs font-bold uppercase tracking-[0.1em] ${
        onNavy ? `border-l-2 border-l-white/30 pl-1.5 ${tone.onNavyText}` : tone.chip
      }`}
    >
      {KPI_BAND_SHORT[band]}
    </span>
  );
}

// ── Command tile ──────────────────────────────────────────────────────────────────────────────

/**
 * The big headline number, with its own meter and caption.
 *
 * `progress` is separate from the printed `value` because the two are not always the same thing:
 * the reps tile prints a head count and has no percentage to fill a bar with, and the call-rate
 * tile prints "1.42 / 8.10" while its bar shows attainment against target. Passing `null` renders
 * the tile with no bar at all rather than an empty track, which would read as zero.
 */
export function KpiTile({
  band,
  caption,
  label,
  onNavy = false,
  progress,
  value,
}: {
  band?: KpiBand;
  caption?: string;
  label: string;
  /**
   * The tile stands on the page's one navy board of key figures: a navy-tile ground, white capitals,
   * the band's light tone for the figure. Off the board it is a flat hairline card on white.
   */
  onNavy?: boolean;
  progress?: number | null;
  value: string;
}) {
  const tone = band ? toneOf(band) : null;
  // The figure takes the band's own tone when the tile scores something, and stays neutral when it
  // does not (the reps count and the untargeted pharmacy rate), so a neutral tile never wears a
  // colour that would read as a band it does not have.
  const figure = onNavy ? (tone ? tone.onNavyText : "text-white") : tone ? tone.text : LANDING_INK;
  return (
    <div className={onNavy ? `min-w-0 px-3 pb-3 pt-2.5 ${LANDING_NAVY_TILE}` : `min-w-0 border border-slate-200 bg-white px-3 pb-3 pt-2.5 ${FLAT}`}>
      <p className={`break-words text-phx-xs font-bold uppercase tracking-[0.1em] ${onNavy ? "text-white/60" : "text-slate-500"}`}>{label}</p>
      <p className={`mt-1.5 break-words text-[28px] font-bold leading-none tracking-[-0.02em] tabular-nums ${figure}`}>{value}</p>
      {progress != null && band ? <KpiMeter band={band} onNavy={onNavy} value={progress} /> : null}
      {caption ? (
        <p className={onNavy ? "mt-1.5 break-words text-phx-xs font-semibold leading-4 text-white/45" : `mt-1.5 leading-4 ${CAPTION}`}>{caption}</p>
      ) : null}
    </div>
  );
}

// ── Rank ──────────────────────────────────────────────────────────────────────────────────────

/**
 * Gold, silver and bronze for the first three; a plain number after that.
 *
 * A SQUARE rather than an emoji medal. Emoji render at wildly different sizes across Windows, iOS and
 * Android and would break the row's vertical rhythm on exactly the phones the field force uses.
 */
export function KpiRank({ rank }: { rank: number }) {
  // Gold, silver and bronze for the podium three: a hairline square in the medal's tone with the
  // number in the same tone — never a filled disc. A plain number after that carries no medal.
  const style =
    rank === 1
      ? "border-amber-500 text-amber-700"
      : rank === 2
        ? "border-slate-400 text-slate-600"
        : rank === 3
          ? "border-[#9a5b2e] text-[#7c4a24]"
          : "border-transparent text-slate-400";
  return (
    <span
      className={`inline-flex h-5 w-5 shrink-0 items-center justify-center border bg-white text-phx-xs font-black tabular-nums ${style}`}
    >
      {rank}
    </span>
  );
}

// ── Podium ────────────────────────────────────────────────────────────────────────────────────

export type PodiumEntry = { repName: string; value: number; caption: string };

/**
 * One leaderboard. Three of these sit side by side on the Summary tab, one per measure.
 *
 * There is no combined "best rep" anywhere on this board, and that is a design rule rather than an
 * omission: kpis-board.ts assembles measures that were already right and adds no fourth one, and a
 * blended rank would be precisely that fourth measure. The three podiums frequently name three
 * different people, which is the honest answer.
 */
export function KpiPodiumCard({
  entries,
  suffix = "%",
  title,
  wide = false,
}: {
  entries: readonly PodiumEntry[];
  /** No longer drawn — a card's header is its title alone. Kept so existing callers still compile. */
  hint?: string;
  /**
   * Appended after `entry.value`, default "%" for the four attainment-percentage boards. Pharmacy
   * has no target to be a percentage OF (see PHARMACY_CALL_RATE_TARGET) and ranks on the raw rate
   * instead, so its caller passes "" — a bare "3.20%" would misstate a calls-per-day count as a
   * percentage.
   */
  suffix?: string;
  title: string;
  /**
   * The card ALONE in its row (a report with one measure): its three names side by side from `sm`, so a
   * card built for a quarter of the row does not sit in the corner of an empty one. Same entries, same
   * order, same figures.
   */
  wide?: boolean;
}) {
  return (
    // Flat: a hairline card inside the page's panel (never a shadowed card on a card), its header the
    // landing kit's tick title on white.
    <div className={`min-w-0 border border-slate-200 bg-white ${FLAT}`}>
      <div className="border-b border-slate-200 px-3 py-2.5">
        <LandingTitle as="h3">{title}</LandingTitle>
      </div>
      {entries.length === 0 ? (
        <p className="px-3 py-3 text-phx-sm text-slate-500">
          Nobody in view can be ranked on this measure yet.
        </p>
      ) : (
        <ol
          className={
            wide
              ? "divide-y divide-slate-200 sm:grid sm:grid-cols-3 sm:divide-x sm:divide-y-0"
              : "divide-y divide-slate-200"
          }
        >
          {entries.map((entry, index) => (
            <li
              className="flex items-start gap-2 px-3 py-2 transition-colors hover:bg-slate-50 motion-reduce:transition-none"
              key={`${entry.repName}-${index}`}
            >
              <KpiRank rank={index + 1} />
              <span className="min-w-0 flex-1">
                <span className={`block break-words text-phx-md font-bold leading-4 ${LANDING_INK}`} dir="auto">
                  {entry.repName}
                </span>
                <span className="block text-phx-sm leading-4 text-slate-500 sm:text-phx-xs">{entry.caption}</span>
              </span>
              <span className={`shrink-0 text-base font-bold tabular-nums ${LANDING_INK}`}>
                {entry.value}
                {suffix}
              </span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

// ── Sortable column header ────────────────────────────────────────────────────────────────────

/**
 * A table heading that is also the sort control.
 *
 * A LINK, not a button: the whole board's state already rides in the URL, so sorting through a
 * plain navigation costs no client JavaScript, survives a refresh, and — the part that matters —
 * re-runs the server-side scope gate on every change, exactly as a tab or a month change does.
 */
export function KpiSortableTh({
  active,
  align = "left",
  direction,
  href,
  label,
  sub,
}: {
  active: boolean;
  align?: "left" | "right";
  direction: "asc" | "desc";
  href: string;
  label: string;
  sub?: string;
}) {
  // The arrow is a real character rather than an icon so it inherits the heading's own size and
  // colour, and it is aria-hidden because `aria-sort` on the cell is what a screen reader reads.
  const arrow = active ? (direction === "asc" ? "↑" : "↓") : "";
  return (
    <th
      aria-sort={active ? (direction === "asc" ? "ascending" : "descending") : "none"}
      className={`${TH} ${align === "right" ? "text-right" : "text-left"}`}
      scope="col"
    >
      <Link
        className={
          active
            ? `inline-flex flex-wrap items-baseline gap-1 ${LANDING_INK} underline decoration-[#08111f] decoration-2 underline-offset-4 ${LANDING_FOCUS}`
            : `inline-flex flex-wrap items-baseline gap-1 transition-colors hover:text-[#08111f] motion-reduce:transition-none ${LANDING_FOCUS}`
        }
        href={href}
      >
        <span>{label}</span>
        {arrow ? <span aria-hidden>{arrow}</span> : null}
      </Link>
      {sub ? <span className="mt-0.5 block text-phx-xs font-bold normal-case tracking-normal text-slate-400">{sub}</span> : null}
    </th>
  );
}

// ── Rep name ──────────────────────────────────────────────────────────────────────────────────

/**
 * The one line every tab shows about a rep, so a card and a row always name him the same way.
 *
 * `dir="auto"` on a SINGLE-language value is correct and is house style — this is one name, not a
 * bilingual body, so the first strong character resolves the whole string. The rule that forbids
 * `dir="auto"` at block level is about mixed Arabic-and-English paragraphs, which this is not.
 */
export function KpiRepName({
  areaName,
  hireDate,
  jobTitle,
  lineName,
  name,
  rank,
}: {
  areaName?: string | null;
  /** `employees.hire_date` (`YYYY-MM-DD`) — printed as "Hired 12 Mar 2025" (owner, 2026-10-25). */
  hireDate?: string | null;
  jobTitle?: string | null;
  lineName?: string | null;
  name: string;
  rank?: number;
}) {
  const where = [lineName, areaName].filter((part): part is string => Boolean(part?.trim())).join(" · ");
  // A date-only value, so the UTC formatter — the same bytes on the server and in every browser.
  const hired = hireDate && /^\d{4}-\d{2}-\d{2}/.test(hireDate) ? utcDate(hireDate.slice(0, 10)) : null;
  return (
    <span className="flex items-start gap-2">
      {rank != null ? <KpiRank rank={rank} /> : null}
      <span className="min-w-0 flex-1">
        <span className={`block break-words font-semibold leading-5 ${LANDING_INK}`} dir="auto">
          {name || "Unnamed rep"}
        </span>
        {/* Phone-only step up; from `sm` (and so in every desktop table) it is the measured 9px. */}
        {where ? <span className="block text-phx-sm leading-4 text-slate-500 sm:text-phx-xs">{where}</span> : null}
        {!where && jobTitle ? (
          <span className="block text-phx-sm leading-4 text-slate-500 sm:text-phx-xs">{jobTitle}</span>
        ) : null}
        {hired && hired !== "—" ? (
          <span className="block text-phx-sm leading-4 text-slate-500 tabular-nums sm:text-phx-xs">Hired {hired}</span>
        ) : null}
      </span>
    </span>
  );
}

// ── Empty state ───────────────────────────────────────────────────────────────────────────────

/** What the board says when a filter has emptied it — never a bare blank. */
export function KpiEmptyState({ action, message, title }: { action?: React.ReactNode; message: string; title: string }) {
  return (
    <div className="px-5 py-8 text-center">
      <p className={`text-sm font-bold ${LANDING_INK}`}>{title}</p>
      <p className={`mx-auto mt-1 max-w-md leading-5 ${CAPTION}`}>{message}</p>
      {action ? <div className="mt-3">{action}</div> : null}
    </div>
  );
}
