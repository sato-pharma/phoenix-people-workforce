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
 * tailwind-merge SILENTLY strips custom named font sizes, so a `text-phx-2xs` handed to `cn()`
 * disappears and only `getComputedStyle` in a real browser can see that it did. Every class string
 * in this file is a plain template literal for that reason.
 */

import Link from "next/link";

import { KPI_BAND_SHORT, type KpiBand } from "@/lib/crm/kpis-filters";
import { utcDate } from "@/lib/format/cairo-datetime";

// ── Tone ──────────────────────────────────────────────────────────────────────────────────────

/**
 * One tone per band, used by the meter, the chip, the tile and the podium alike.
 *
 * `noplan` is deliberately the quietest tone on the board. It is not a bad score — it is the
 * absence of one — and painting it rose would accuse a rep of missing a target nobody set him.
 *
 * ## The godmode premium pass — depth, not radius (owner golden rule, 2026-09-08)
 *
 * `grad` (a two-stop tonal gradient) fills the meter and caps a tile so a flat colour reads as a
 * lit surface rather than a printed block, and `dot` is the same tone as a status pip. They ride
 * ALONGSIDE the flat `bar`/`chip`/`text` this board already used — nothing here changes a value, a
 * width or a corner. The square-edge golden rule is untouched: not one class in this file rounds an
 * edge, and the admin shell's own `border-radius: 0 !important` would win even if one did.
 */
type Tone = { bar: string; chip: string; text: string; grad: string; dot: string };

const TONES: Record<KpiBand, Tone> = {
  elite: {
    bar: "bg-emerald-500",
    chip: "border-emerald-200 bg-emerald-50 text-emerald-800",
    text: "text-emerald-700",
    grad: "from-emerald-400 to-emerald-600",
    dot: "bg-emerald-500",
  },
  strong: {
    bar: "bg-sky-500",
    chip: "border-sky-200 bg-sky-50 text-sky-800",
    text: "text-sky-700",
    grad: "from-sky-400 to-sky-600",
    dot: "bg-sky-500",
  },
  steady: {
    bar: "bg-amber-500",
    chip: "border-amber-200 bg-amber-50 text-amber-900",
    text: "text-amber-700",
    grad: "from-amber-400 to-amber-600",
    dot: "bg-amber-500",
  },
  behind: {
    bar: "bg-rose-500",
    chip: "border-rose-200 bg-rose-50 text-rose-800",
    text: "text-rose-700",
    grad: "from-rose-400 to-rose-600",
    dot: "bg-rose-500",
  },
  noplan: {
    bar: "bg-slate-300",
    chip: "border-slate-200 bg-slate-50 text-slate-600",
    text: "text-slate-500",
    grad: "from-slate-300 to-slate-400",
    dot: "bg-slate-400",
  },
};

export function toneOf(band: KpiBand): Tone {
  return TONES[band];
}

/**
 * The two-layer premium shadow (owner's godmode golden rule): a 1px contact shadow so the card has
 * an edge, and a wide ambient one so it sits above the page. It states its own depth, so the
 * shell's ambient `main` rule (`:not([class*="shadow"])`) leaves it alone rather than stacking a
 * second shadow on it. box-shadow is outside the box model, so it moves nothing — the
 * fits-the-screen rule is untouched.
 */
const DEPTH = "shadow-[0_1px_2px_rgba(15,23,42,0.05),0_10px_26px_rgba(15,23,42,0.06)]";
const DEPTH_HAIR = "shadow-[0_1px_2px_rgba(15,23,42,0.05)]";

// A DailyVisitBand tone map and chip lived here briefly (2026-09-05), for a combined AM+PM
// "visits/day" band the owner retracted the same week — see call-rate.ts's header comment where
// DAILY_VISIT_RATE_TARGET used to be. The correct PM-only band lives in kpi-reports-tables.tsx.

// ── Shared class strings ──────────────────────────────────────────────────────────────────────

export const PANEL = "border border-slate-200 bg-white";
// One step larger BELOW `sm` only (11px on a phone, 10px from 640px up). Every table on this board
// renders from `md`, where the `sm:` size applies, so the measured desktop tables
// (tests/kpis-board-tables-fit.test.ts) are unchanged; only the phone cards and captions grow.
export const CAPTION = "text-phx-xs text-slate-500 sm:text-phx-2xs";
export const TH = "px-3 py-2.5 text-left text-phx-2xs font-black uppercase tracking-[0.12em] text-slate-500";
export const TD = "px-3 py-3 align-top text-sm text-slate-700";
export const NUM = "px-3 py-3 align-top text-sm font-semibold tabular-nums text-slate-900";

// ── Section frame ─────────────────────────────────────────────────────────────────────────────

/**
 * A titled block with the slate-900 header bar.
 *
 * Copied from reps-list-chrome.tsx rather than reinvented — same module, same header bar, same
 * orange accent. A second spelling of this bar is the "one-off look" the owner's rule forbids.
 */
export function KpiSection({
  action,
  children,
  description,
  title,
}: {
  action?: React.ReactNode;
  children: React.ReactNode;
  description?: string;
  title: string;
}) {
  return (
    <div className="border-b border-slate-200 bg-white last:border-b-0">
      {/* Premium pass: a subtle diagonal on the near-black bar so it reads as a lit surface, an
          orange light-edge across the top, and a left accent tick — the same command-bar language
          the module's other section headers use. Type and spacing are unchanged. */}
      <div className="relative flex flex-wrap items-start justify-between gap-3 overflow-hidden border-b border-slate-200 bg-[linear-gradient(135deg,#0f172a_0%,#111c31_60%,#1a2436_100%)] px-4 py-3 pl-5 sm:px-5 sm:pl-6">
        <span aria-hidden className="pointer-events-none absolute inset-y-0 left-0 w-[3px] bg-gradient-to-b from-orange-400 to-orange-500" />
        <span aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-orange-500/0 via-orange-400/70 to-orange-500/0" />
        <div className="min-w-0 flex-1">
          <h2 className="text-phx-xs font-black uppercase tracking-[0.14em] text-white">{title}</h2>
          {description ? <p className="mt-0.5 text-phx-2xs leading-4 text-slate-400">{description}</p> : null}
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
export function KpiMeter({ band, value }: { band: KpiBand; value: number | null }) {
  const fill = value == null ? 0 : Math.max(0, Math.min(100, value));
  return (
    // Premium pass: a recessed track (inner shadow) under a two-stop tonal fill with a faint glow,
    // so the bar reads as a lit gauge rather than a flat block. Height is UNCHANGED at h-1.5 — the
    // row rhythm the four tables and the mobile card were measured against does not move.
    <div
      aria-hidden
      className="relative mt-1.5 h-1.5 w-full overflow-hidden bg-slate-100 shadow-[inset_0_1px_1px_rgba(15,23,42,0.07)]"
    >
      <div
        className={`h-full bg-gradient-to-r ${toneOf(band).grad} shadow-[0_0_6px_rgba(15,23,42,0.16)]`}
        style={{ width: `${fill}%` }}
      />
    </div>
  );
}

/** A band as a small chip. Short label — this sits inside a table cell. */
export function KpiBandChip({ band }: { band: KpiBand }) {
  const tone = toneOf(band);
  return (
    <span
      className={`inline-flex items-center gap-1 border px-1.5 py-0.5 text-phx-3xs font-black uppercase tracking-[0.1em] ${tone.chip} ${DEPTH_HAIR}`}
    >
      <span aria-hidden className={`h-1.5 w-1.5 ${tone.dot}`} />
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
  progress,
  value,
}: {
  band?: KpiBand;
  caption?: string;
  label: string;
  progress?: number | null;
  value: string;
}) {
  const tone = band ? toneOf(band) : null;
  // The top accent cap: the band's own tonal gradient when the tile scores something, a quiet slate
  // gradient when it does not (the reps count and the untargeted pharmacy rate), so a neutral tile
  // never wears a colour that would read as a band it does not have.
  const cap = tone ? tone.grad : "from-slate-300 to-slate-400";
  return (
    <div className={`relative overflow-hidden border border-slate-200 bg-white px-4 pb-3.5 pt-4 ${DEPTH}`}>
      <span aria-hidden className={`pointer-events-none absolute inset-x-0 top-0 h-[3px] bg-gradient-to-r ${cap}`} />
      <p className="text-phx-2xs font-black uppercase tracking-[0.14em] text-slate-400 sm:text-phx-3xs">{label}</p>
      <p className={`mt-1 text-[1.7rem] font-black leading-none tabular-nums ${tone ? tone.text : "text-slate-900"}`}>
        {value}
      </p>
      {progress != null && band ? <KpiMeter band={band} value={progress} /> : null}
      {caption ? <p className={`mt-1.5 leading-4 ${CAPTION}`}>{caption}</p> : null}
    </div>
  );
}

// ── Rank ──────────────────────────────────────────────────────────────────────────────────────

/**
 * Gold, silver and bronze for the first three; a plain number after that.
 *
 * A DISC rather than an emoji medal. Emoji render at wildly different sizes across Windows, iOS and
 * Android and would break the row's vertical rhythm on exactly the phones the field force uses.
 */
export function KpiRank({ rank }: { rank: number }) {
  // Metallic gold / silver / bronze for the podium three — a two-stop vertical gradient and a soft
  // contact shadow so each disc reads as a struck medal, not a flat swatch. A plain number after
  // that carries no medal and no depth.
  const style =
    rank === 1
      ? "border-amber-300 bg-gradient-to-b from-amber-100 to-amber-300 text-amber-900 shadow-[0_1px_2px_rgba(146,64,14,0.35)]"
      : rank === 2
        ? "border-slate-300 bg-gradient-to-b from-slate-50 to-slate-200 text-slate-700 shadow-[0_1px_2px_rgba(15,23,42,0.2)]"
        : rank === 3
          ? "border-orange-300 bg-gradient-to-b from-orange-100 to-orange-300 text-orange-900 shadow-[0_1px_2px_rgba(154,52,18,0.3)]"
          : "border-transparent bg-transparent text-slate-400";
  return (
    <span
      className={`inline-flex h-5 w-5 shrink-0 items-center justify-center border text-phx-3xs font-black tabular-nums ${style}`}
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
  hint,
  suffix = "%",
  title,
}: {
  entries: readonly PodiumEntry[];
  hint: string;
  /**
   * Appended after `entry.value`, default "%" for the four attainment-percentage boards. Pharmacy
   * has no target to be a percentage OF (see PHARMACY_CALL_RATE_TARGET) and ranks on the raw rate
   * instead, so its caller passes "" — a bare "3.20%" would misstate a calls-per-day count as a
   * percentage.
   */
  suffix?: string;
  title: string;
}) {
  return (
    <div className={`relative overflow-hidden border border-slate-200 bg-white ${DEPTH}`}>
      <span aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-[3px] bg-gradient-to-r from-orange-400 to-orange-500" />
      <div className="border-b border-slate-200 bg-gradient-to-b from-slate-50 to-white px-3 py-2">
        <p className="text-phx-2xs font-black uppercase tracking-[0.14em] text-slate-600 sm:text-phx-3xs">{title}</p>
        <p className="mt-0.5 text-phx-2xs leading-4 text-slate-400 sm:text-phx-3xs">{hint}</p>
      </div>
      {entries.length === 0 ? (
        <p className="px-3 py-3 text-phx-2xs text-slate-500">
          Nobody in view can be ranked on this measure yet.
        </p>
      ) : (
        <ol className="divide-y divide-slate-100">
          {entries.map((entry, index) => (
            <li
              className={`flex items-start gap-2 px-3 py-2 transition-colors hover:bg-slate-50 ${
                index === 0 ? "bg-amber-50/40" : ""
              }`}
              key={`${entry.repName}-${index}`}
            >
              <KpiRank rank={index + 1} />
              <span className="min-w-0 flex-1">
                <span className="block text-phx-xs font-bold leading-4 text-slate-900" dir="auto">
                  {entry.repName}
                </span>
                <span className="block text-phx-2xs leading-4 text-slate-500 sm:text-phx-3xs">{entry.caption}</span>
              </span>
              <span className="shrink-0 text-base font-black tabular-nums text-slate-900">
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
            ? "inline-flex flex-wrap items-baseline gap-1 text-orange-600 underline decoration-orange-300 underline-offset-2"
            : "inline-flex flex-wrap items-baseline gap-1 transition-colors hover:text-slate-900"
        }
        href={href}
      >
        <span>{label}</span>
        {arrow ? <span aria-hidden>{arrow}</span> : null}
      </Link>
      {sub ? <span className="mt-0.5 block text-phx-3xs font-bold normal-case tracking-normal text-slate-400">{sub}</span> : null}
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
        <span className="block font-semibold leading-5 text-slate-900" dir="auto">
          {name || "Unnamed rep"}
        </span>
        {/* Phone-only step up; from `sm` (and so in every desktop table) it is the measured 9px. */}
        {where ? <span className="block text-phx-2xs leading-4 text-slate-500 sm:text-phx-3xs">{where}</span> : null}
        {!where && jobTitle ? (
          <span className="block text-phx-2xs leading-4 text-slate-500 sm:text-phx-3xs">{jobTitle}</span>
        ) : null}
        {hired && hired !== "—" ? (
          <span className="block text-phx-2xs leading-4 text-slate-500 tabular-nums sm:text-phx-3xs">Hired {hired}</span>
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
      <p className="text-sm font-bold text-slate-800">{title}</p>
      <p className={`mx-auto mt-1 max-w-md leading-5 ${CAPTION}`}>{message}</p>
      {action ? <div className="mt-3">{action}</div> : null}
    </div>
  );
}
