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

// ── Tone ──────────────────────────────────────────────────────────────────────────────────────

/**
 * One tone per band, used by the meter, the chip and the podium alike.
 *
 * `noplan` is deliberately the quietest tone on the board. It is not a bad score — it is the
 * absence of one — and painting it rose would accuse a rep of missing a target nobody set him.
 */
type Tone = { bar: string; chip: string; text: string };

const TONES: Record<KpiBand, Tone> = {
  elite: { bar: "bg-emerald-500", chip: "border-emerald-200 bg-emerald-50 text-emerald-800", text: "text-emerald-700" },
  strong: { bar: "bg-sky-500", chip: "border-sky-200 bg-sky-50 text-sky-800", text: "text-sky-700" },
  steady: { bar: "bg-amber-500", chip: "border-amber-200 bg-amber-50 text-amber-900", text: "text-amber-700" },
  behind: { bar: "bg-rose-500", chip: "border-rose-200 bg-rose-50 text-rose-800", text: "text-rose-700" },
  noplan: { bar: "bg-slate-300", chip: "border-slate-200 bg-slate-50 text-slate-600", text: "text-slate-500" },
};

export function toneOf(band: KpiBand): Tone {
  return TONES[band];
}

// ── Shared class strings ──────────────────────────────────────────────────────────────────────

export const PANEL = "border border-slate-200 bg-white";
export const CAPTION = "text-phx-2xs text-slate-500";
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
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-200 bg-slate-900 px-4 py-3 sm:px-5">
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
    <div aria-hidden className="mt-1.5 h-1.5 w-full bg-slate-100">
      <div className={`h-1.5 ${toneOf(band).bar}`} style={{ width: `${fill}%` }} />
    </div>
  );
}

/** A band as a small chip. Short label — this sits inside a table cell. */
export function KpiBandChip({ band }: { band: KpiBand }) {
  return (
    <span
      className={`inline-block border px-1.5 py-0.5 text-phx-3xs font-black uppercase tracking-[0.1em] ${toneOf(band).chip}`}
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
  return (
    <div className="relative overflow-hidden border border-slate-200 bg-white px-4 py-3.5">
      <p className="text-phx-3xs font-black uppercase tracking-[0.14em] text-slate-400">{label}</p>
      <p className={`mt-1 text-2xl font-black leading-none tabular-nums ${tone ? tone.text : "text-slate-900"}`}>
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
  const style =
    rank === 1
      ? "border-amber-300 bg-amber-100 text-amber-900"
      : rank === 2
        ? "border-slate-300 bg-slate-100 text-slate-700"
        : rank === 3
          ? "border-orange-300 bg-orange-100 text-orange-900"
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
  title,
}: {
  entries: readonly PodiumEntry[];
  hint: string;
  title: string;
}) {
  return (
    <div className="border border-slate-200 bg-white">
      <div className="border-b border-slate-200 bg-slate-50 px-3 py-2">
        <p className="text-phx-3xs font-black uppercase tracking-[0.14em] text-slate-500">{title}</p>
        <p className="mt-0.5 text-phx-3xs leading-4 text-slate-400">{hint}</p>
      </div>
      {entries.length === 0 ? (
        <p className="px-3 py-3 text-phx-2xs text-slate-500">
          Nobody in view can be ranked on this measure yet.
        </p>
      ) : (
        <ol className="divide-y divide-slate-100">
          {entries.map((entry, index) => (
            <li className="flex items-start gap-2 px-3 py-2" key={`${entry.repName}-${index}`}>
              <KpiRank rank={index + 1} />
              <span className="min-w-0 flex-1">
                <span className="block text-phx-xs font-bold leading-4 text-slate-900" dir="auto">
                  {entry.repName}
                </span>
                <span className="block text-phx-3xs leading-4 text-slate-500">{entry.caption}</span>
              </span>
              <span className="shrink-0 text-sm font-black tabular-nums text-slate-900">{entry.value}%</span>
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
  jobTitle,
  lineName,
  name,
  rank,
}: {
  areaName?: string | null;
  jobTitle?: string | null;
  lineName?: string | null;
  name: string;
  rank?: number;
}) {
  const where = [lineName, areaName].filter((part): part is string => Boolean(part?.trim())).join(" · ");
  return (
    <span className="flex items-start gap-2">
      {rank != null ? <KpiRank rank={rank} /> : null}
      <span className="min-w-0 flex-1">
        <span className="block font-semibold leading-5 text-slate-900" dir="auto">
          {name || "Unnamed rep"}
        </span>
        {where ? <span className="block text-phx-3xs leading-4 text-slate-500">{where}</span> : null}
        {!where && jobTitle ? <span className="block text-phx-3xs leading-4 text-slate-500">{jobTitle}</span> : null}
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
