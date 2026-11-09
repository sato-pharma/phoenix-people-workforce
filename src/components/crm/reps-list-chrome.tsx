/**
 * The Reps List board's chrome — the section frame, the KPI tile and the small parts every tab shares.
 *
 * The vocabulary is copied verbatim from doctor-list-board.tsx, the board Reps List replaced: flat
 * borders, slate-900 header bar, KPI tiles, orange accent. Never a one-off look (owner's standing
 * rule).
 *
 * EXTRACTED so the Contact List tab and the Reps Weekly Plans tab cannot drift apart visually. Two
 * tabs inside one border that each define their own header bar is two headers that differ the first
 * time either is touched — and the whole reason the owner asked for a tab rather than a second page
 * is that these are one screen.
 *
 * THE PREMIUM PASS (owner, 2026-11-09: "premium polish big work every single component"). Every part
 * here was redrawn to one print-like finish, and the finish has rules a later edit must keep:
 *
 * - FLAT INK ONLY. A colour is a rule, a square swatch or a figure — never a gradient, a glow, a
 *   drop shadow or a tinted card. "Nothing you design may look AI-made" (owner, 2026-10-22).
 * - SQUARE EDGES. No border-radius anywhere — the square-edge golden rule. A meter is a flat bar
 *   with square ends, a swatch is a square, a monogram is a square.
 * - ONE ACCENT RULE PER PART. A tile carries its tone on a 3px top rule and on its figure; a card
 *   carries its status on a 3px left rule. Never a badge inside a badge.
 * - FIGURES ARE TABULAR. Every count uses tabular numerals so a column of tiles and cards lines up
 *   digit for digit, the way a printed report does.
 * - NOTHING SCROLLS SIDEWAYS. Every row wraps or re-columns; nothing has a min-width (the
 *   fits-the-screen golden rule).
 *
 * `tests/reps-list-premium.test.ts` pins these rules against this file.
 */

import { ArrowLeft, ChevronRight } from "lucide-react";
import Link from "next/link";

import { meterPercent, repInitials, shareSlices, type ShareSegment } from "@/lib/crm/reps-list-groups";

/** The five tones the board speaks in. Each maps to one figure colour, one rule colour and one swatch. */
export type ChromeTone = "amber" | "emerald" | "rose" | "sky" | "slate";

/** The figure (text) colour of each tone. Literal strings, so Tailwind sees every class it must emit. */
export const TONE_TEXT: Record<ChromeTone, string> = {
  amber: "text-amber-700",
  emerald: "text-emerald-700",
  rose: "text-rose-700",
  sky: "text-sky-700",
  slate: "text-slate-900",
};

/** The 3px top rule a tile carries. Neutral is a quiet slate, so an untoned tile still has its rule. */
const TONE_TOP_RULE: Record<ChromeTone, string> = {
  amber: "border-t-amber-500",
  emerald: "border-t-emerald-600",
  rose: "border-t-rose-600",
  sky: "border-t-sky-600",
  slate: "border-t-slate-300",
};

/** The 3px left rule a card carries for its status. */
export const TONE_LEFT_RULE: Record<ChromeTone, string> = {
  amber: "border-l-amber-500",
  emerald: "border-l-emerald-600",
  rose: "border-l-rose-600",
  sky: "border-l-sky-600",
  slate: "border-l-slate-300",
};

/** A filled square or bar segment in the tone — the swatch, the meter and the share bar. */
export const TONE_FILL: Record<ChromeTone, string> = {
  amber: "bg-amber-500",
  emerald: "bg-emerald-600",
  rose: "bg-rose-600",
  sky: "bg-sky-600",
  slate: "bg-slate-400",
};

/**
 * A text-colour class from the plan module (`planStatusClass` → "text-amber-700") read back as a tone, so a card's
 * rule and its status text can never disagree. Anything unrecognised is neutral.
 */
export function toneFromTextClass(textClass: string): ChromeTone {
  if (textClass.includes("amber")) return "amber";
  if (textClass.includes("emerald")) return "emerald";
  if (textClass.includes("rose")) return "rose";
  if (textClass.includes("sky")) return "sky";
  return "slate";
}

/**
 * The way back from one rep to all of them, as the FIRST thing on a rep's screen (owner, 2026-11-09: "when I
 * press a rep there is no back button to go back to all reps"). The small outlined link in the dark title bar
 * stays; this bar is the one a reader cannot miss, on a phone as on a desktop.
 */
export function BackToAllReps({ href, label = "Back to all reps" }: { href: string; label?: string }) {
  return (
    <div className="border-b border-slate-200 bg-white px-5 py-3 print:hidden">
      <Link
        className="inline-flex min-h-11 items-center gap-2 border border-orange-500 bg-orange-50 px-3 py-2 text-phx-xs font-black uppercase tracking-[0.12em] text-orange-800 transition-colors hover:bg-orange-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-orange-400 md:min-h-0"
        href={href}
      >
        <ArrowLeft aria-hidden className="h-4 w-4 shrink-0" />
        {label}
      </Link>
    </div>
  );
}

/**
 * A board section: the dark title bar and its body.
 *
 * The bar carries a 3px orange keyline on its left edge — the same accent the page header and the active tab use —
 * so a stack of sections reads as one document with chapter marks rather than a run of identical black slabs.
 * `meta` is a short right-aligned figure ("13 reps"); `action` is a control, and wins the right edge when both are
 * given, because a control a reader needs outranks a figure he can read below.
 */
export function Section({
  action,
  children,
  description,
  meta,
  title,
}: {
  action?: React.ReactNode;
  children: React.ReactNode;
  description?: string;
  meta?: string;
  title: string;
}) {
  return (
    <section className="border-b border-slate-200 bg-white last:border-b-0">
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 border-b border-l-[3px] border-b-slate-200 border-l-orange-500 bg-slate-900 px-5 py-3.5">
        <div className="min-w-0 flex-1">
          <h2 className="text-phx-xs font-black uppercase tracking-[0.14em] text-white">{title}</h2>
          {description ? <p className="mt-1 max-w-[110ch] text-phx-sm leading-relaxed text-slate-300">{description}</p> : null}
        </div>
        {action ?? (meta ? <p className="shrink-0 text-phx-sm font-black uppercase tracking-[0.14em] text-slate-300 tabular-nums">{meta}</p> : null)}
      </div>
      {children}
    </section>
  );
}

/**
 * A KPI tile, and — when given an `href` — the control that filters the board down to what it counts.
 *
 * ONE COMPONENT FOR BOTH, rather than a `FilterTile` beside it. These sit in the same four-across
 * row, and a second component would match on the day it was written and stop matching on the next
 * change to either: the row would then read as three stats and one button, which is exactly the
 * "one-off look" the owner's standing rule forbids. A tile with no `href` is a plain `div`.
 *
 * The active tile keeps its tone on the NUMBER and takes the orange accent on the BORDER. Tinting
 * the number instead would collide with what the tone means here — amber is "waiting on you", rose
 * is "nobody filed" — so the selected state has to be carried by something the tones do not use.
 *
 * The tone also rides on a 3px TOP rule, so a row of tiles can be read for its colours from across the room before a
 * single figure is read. `share` (0–100) draws a flat meter under the figure: what part of the whole this tile is.
 */
export function Tile({
  active,
  href,
  label,
  share,
  sub,
  tone,
  value,
}: {
  /** Whether this tile is the filter currently applied. Ignored without an `href`. */
  active?: boolean;
  /** Makes the tile a link. Omit it and the tile is a static figure. */
  href?: string;
  label: string;
  /** This tile's share of the whole, 0–100 — drawn as a flat meter under the figure. Omit for no meter. */
  share?: number;
  sub?: string;
  tone?: Exclude<ChromeTone, "slate">;
  value: string;
}) {
  const key: ChromeTone = tone ?? "slate";
  const body = (
    <>
      <div className="flex items-start justify-between gap-2">
        <p className="text-phx-xs font-black uppercase tracking-[0.14em] text-slate-500">{label}</p>
        {href ? (
          <ChevronRight
            aria-hidden
            className={`h-3.5 w-3.5 shrink-0 ${active ? "text-orange-600" : "text-slate-300"}`}
          />
        ) : null}
      </div>
      <p className={`mt-1.5 text-2xl font-black leading-none tabular-nums ${TONE_TEXT[key]}`}>{value}</p>
      {share != null ? <Meter percent={share} tone={key} /> : null}
      {sub ? <p className="mt-1.5 text-phx-sm leading-snug text-slate-500">{sub}</p> : null}
    </>
  );
  const frame = `border border-t-[3px] ${TONE_TOP_RULE[key]} px-3.5 pb-3 pt-2.5`;

  if (!href) return <div className={`${frame} border-x-slate-200 border-b-slate-200 bg-white`}>{body}</div>;

  return (
    <Link
      aria-current={active ? "true" : undefined}
      className={
        active
          ? `block ${frame} border-x-orange-500 border-b-orange-500 bg-orange-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-orange-400`
          : `block ${frame} border-x-slate-200 border-b-slate-200 bg-white transition-colors hover:border-x-orange-400 hover:border-b-orange-400 hover:bg-orange-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-orange-400`
      }
      href={href}
    >
      {body}
    </Link>
  );
}

/**
 * The grid a row of tiles sits in, sized by how many there are, so a fifth tile never sits alone on a second line
 * under four (the Vacant seats tile did, 2026-11-09). Two across on a phone, then the count's own column number.
 */
const TILE_COLUMNS: Record<number, string> = {
  1: "grid-cols-1",
  2: "grid-cols-2",
  3: "grid-cols-2 sm:grid-cols-3",
  4: "grid-cols-2 lg:grid-cols-4",
  5: "grid-cols-2 sm:grid-cols-3 lg:grid-cols-5",
  6: "grid-cols-2 sm:grid-cols-3 lg:grid-cols-6",
  7: "grid-cols-2 sm:grid-cols-4 xl:grid-cols-7",
};

export function tileColumns(count: number): string {
  return TILE_COLUMNS[Math.max(1, Math.min(7, count))] ?? TILE_COLUMNS[4]!;
}

export function TileRow({ children, count }: { children: React.ReactNode; count: number }) {
  return <div className={`grid gap-2 px-5 pt-5 ${tileColumns(count)}`}>{children}</div>;
}

/** A flat meter: a 4px track with a square-ended fill. Purely visual — the figure beside it is the information. */
export function Meter({ percent, tone = "slate" }: { percent: number; tone?: ChromeTone }) {
  const width = Math.max(0, Math.min(100, percent));
  return (
    <div aria-hidden className="mt-2 h-1 w-full bg-slate-100">
      <div className={`h-1 ${TONE_FILL[tone]}`} style={{ width: `${width}%` }} />
    </div>
  );
}

/** A small square in a tone, before a status word or a legend entry. */
export function Swatch({ tone }: { tone: ChromeTone }) {
  return <span aria-hidden className={`inline-block h-2 w-2 shrink-0 ${TONE_FILL[tone]}`} />;
}

/** A status in words, led by its square swatch. The words are the information; the swatch only repeats the tone. */
export function StatusMark({ text, tone }: { text: string; tone: ChromeTone }) {
  return (
    <span className={`inline-flex items-center gap-1.5 text-phx-sm font-black uppercase tracking-[0.1em] ${TONE_TEXT[tone]}`}>
      <Swatch tone={tone} />
      {text}
    </span>
  );
}

export type ShareBarSegment = ShareSegment & { tone: ChromeTone };

/**
 * A row of counts as ONE flat bar with a legend under it — the week, or the list, read at a glance (the owner wants
 * figures shown as charts, not sentences). The bar is decorative to a screen reader; the legend carries every figure
 * and its percent in words, so nothing is said only in colour.
 */
export function ShareBar({ caption, segments }: { caption: string; segments: readonly ShareBarSegment[] }) {
  const { slices, total } = shareSlices(segments);
  const toneOf = new Map(segments.map((segment) => [segment.key, segment.tone]));
  return (
    <figure className="px-5 pt-4">
      <figcaption className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <span className="text-phx-xs font-black uppercase tracking-[0.14em] text-slate-500">{caption}</span>
        <span className="text-phx-sm font-semibold text-slate-500 tabular-nums">{total} in all</span>
      </figcaption>
      <div aria-hidden className="mt-2 flex h-2.5 w-full bg-slate-100">
        {slices.map((slice) =>
          slice.width > 0 ? (
            <div
              className={`h-2.5 ${TONE_FILL[toneOf.get(slice.key) ?? "slate"]} border-r border-white last:border-r-0`}
              key={slice.key}
              style={{ width: `${slice.width}%` }}
            />
          ) : null,
        )}
      </div>
      <ul className="mt-2 flex flex-wrap gap-x-5 gap-y-1.5">
        {slices.map((slice) => (
          <li className="inline-flex items-center gap-1.5 text-phx-sm text-slate-600" key={slice.key}>
            <Swatch tone={toneOf.get(slice.key) ?? "slate"} />
            <span className="font-semibold">{slice.label}</span>
            <span className="font-black text-slate-900 tabular-nums">{slice.value}</span>
            <span className="text-slate-400 tabular-nums">{slice.percent}%</span>
          </li>
        ))}
      </ul>
    </figure>
  );
}

/**
 * A region's heading inside a card grid: the region in capitals, how many cards it holds, and an optional figure on
 * the right. A hairline above it separates it from the group before — no fill, no box, the way a printed report
 * starts a new chapter of a table.
 */
export function RegionHeading({ count, label, noun, right }: { count: number; label: string; noun: string; right?: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b border-slate-900 pb-1.5">
      <h3 className="text-phx-xs font-black uppercase tracking-[0.14em] text-slate-900">
        {label}
        <span className="ml-2 font-semibold normal-case tracking-normal text-slate-500 tabular-nums">
          {count} {count === 1 ? noun : `${noun}s`}
        </span>
      </h3>
      {right ? <div className="text-phx-sm text-slate-500">{right}</div> : null}
    </div>
  );
}

/**
 * The cards of one board, under a heading per region and district manager — drawn even when there is only one team,
 * because the heading is where a reader learns whose team it is (owner, 2026-11-09: "group reps by district
 * manager"). Each board passes its own groups and its own card renderer, so the grouping is one decision and the
 * cards stay each board's own.
 */
export function GroupedCardGrid<T>({
  groups,
  noun,
  phoneOnly,
  renderCard,
  renderGroupMeta,
}: {
  groups: readonly { key?: string; label: string; reps: readonly T[] }[];
  noun: string;
  /** True when a `TeamTable` draws the same groups from `md` up, so the cards are the phone's alone. */
  phoneOnly?: boolean;
  renderCard: (item: T) => React.ReactNode;
  renderGroupMeta?: (items: readonly T[]) => React.ReactNode;
}) {
  return (
    <div className={`space-y-6 p-5 ${phoneOnly ? "md:hidden print:hidden" : ""}`}>
      {groups.map((group) => (
        <div key={group.key ?? group.label}>
          <RegionHeading
            count={group.reps.length}
            label={group.label}
            noun={noun}
            right={renderGroupMeta ? renderGroupMeta(group.reps) : undefined}
          />
          <div className="mt-2.5 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">{group.reps.map(renderCard)}</div>
        </div>
      ))}
    </div>
  );
}

/**
 * A rep's square monogram — the first letters of the first two words of the name. A flat block, never a circle (the
 * square-edge rule) and never a stand-in photo: a monogram is honest about being initials.
 */
export function RepMonogram({ muted, name }: { muted?: boolean; name: string }) {
  return (
    <span
      aria-hidden
      className={`flex h-9 w-9 shrink-0 items-center justify-center text-phx-sm font-black tracking-[0.06em] ${
        muted ? "border border-dashed border-slate-300 bg-white text-slate-400" : "bg-slate-900 text-white"
      }`}
    >
      {repInitials(name)}
    </span>
  );
}

/**
 * The frame every rep card on the Reps List is drawn in — the monogram, the name, the areas, then whatever the tab
 * says about the rep, with the status carried on a 3px left rule. One frame for all three tabs, so a card cannot look
 * different from tab to tab.
 */
export function RepCardFrame({
  children,
  href,
  monogramMuted,
  name,
  places,
  tone,
}: {
  children?: React.ReactNode;
  href: string;
  monogramMuted?: boolean;
  name: string;
  places: string;
  tone: ChromeTone;
}) {
  return (
    <Link
      className={`group flex items-start gap-3 border border-l-[3px] border-slate-200 ${TONE_LEFT_RULE[tone]} bg-white px-3.5 py-3 transition-colors hover:border-y-orange-400 hover:border-r-orange-400 hover:bg-orange-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-orange-400`}
      href={href}
    >
      <RepMonogram muted={monogramMuted} name={name} />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-black leading-tight text-slate-900 [overflow-wrap:anywhere]">{name}</p>
        <p className="mt-0.5 text-phx-sm font-semibold text-slate-500 [overflow-wrap:anywhere]">{places}</p>
        {children ? <div className="mt-2">{children}</div> : null}
      </div>
      <ChevronRight
        aria-hidden
        className="mt-1 h-4 w-4 shrink-0 text-slate-300 transition-colors group-hover:text-orange-600"
      />
    </Link>
  );
}

/** A count and its noun, with the noun in the plural when it should be. */
export function countOf(value: number, noun: string): string {
  return `${value.toLocaleString("en-US")} ${value === 1 ? noun : `${noun}s`}`;
}

/** The thin meter under a card's figure, against the largest figure in view. */
export function CardMeter({ max, tone = "slate", value }: { max: number; tone?: ChromeTone; value: number }) {
  return <Meter percent={meterPercent(value, max)} tone={tone} />;
}

/**
 * An empty or explanatory state: a short title and a detail, framed by a dotted rule so it reads as a note in the
 * margin of the board rather than as a broken card.
 */
export function EmptyNote({ detail, title }: { detail?: React.ReactNode; title: string }) {
  return (
    <div className="m-5 border border-dashed border-slate-300 bg-white px-5 py-5">
      <p className="text-sm font-black text-slate-800">{title}</p>
      {detail ? <p className="mt-1 max-w-[90ch] text-phx-xs leading-relaxed text-slate-500">{detail}</p> : null}
    </div>
  );
}

/** A one-line helper sentence under a control row — the field-week note, the scope note. */
export function HelpLine({ children }: { children: React.ReactNode }) {
  return <p className="self-end text-phx-sm leading-relaxed text-slate-500">{children}</p>;
}

/** Cairo wall-clock, per the owner's standing rule that no raw UTC is ever shown. */
export function cairoStamp(iso: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    month: "short",
    timeZone: "Africa/Cairo",
    year: "numeric",
  }).format(new Date(iso));
}

/** One column of a team table: its heading, its width in the colgroup, and what each row prints in it. */
export type TeamColumn<T> = {
  align?: "right";
  cell: (item: T) => React.ReactNode;
  key: string;
  label: string;
  /** The column's share of the table, as a width class for its `<col>` — the colgroup is what fits the table. */
  width: string;
};

/**
 * The team as a TABLE, on a desktop — the owner's standing rule for the admin and manager screens: desktop shows full
 * tables, a phone gets cards. The phone keeps `GroupedCardGrid`; this draws from `md` up, with the same groups in the
 * same order, one `<tbody>` per region and district manager headed by the same title the cards wear.
 *
 * It fits the screen by its colgroup — `table-fixed`, every width a share of the whole — and long names wrap, so it
 * never scrolls sideways (the fits-the-screen golden rule). Each row's first cell carries the link, because a whole
 * table row cannot be a link.
 */
export function TeamTable<T>({
  caption,
  columns,
  groups,
  noun,
  renderGroupMeta,
  rowKey,
}: {
  caption: string;
  columns: readonly TeamColumn<T>[];
  groups: readonly { key?: string; label: string; reps: readonly T[] }[];
  noun: string;
  renderGroupMeta?: (items: readonly T[]) => React.ReactNode;
  rowKey: (item: T) => string;
}) {
  return (
    <div className="hidden p-5 md:block print:block">
      <table className="w-full table-fixed border border-slate-200 text-left">
        <caption className="sr-only">{caption}</caption>
        <colgroup>
          {columns.map((column) => (
            <col className={column.width} key={column.key} />
          ))}
        </colgroup>
        <thead>
          <tr className="bg-slate-900">
            {columns.map((column) => (
              <th
                className={`px-3 py-2.5 text-phx-sm font-black uppercase tracking-[0.12em] text-white ${column.align === "right" ? "text-right" : ""}`}
                key={column.key}
                scope="col"
              >
                {column.label}
              </th>
            ))}
          </tr>
        </thead>
        {groups.map((group) => (
          <tbody key={group.key ?? group.label}>
            <tr className="border-t-2 border-slate-900 bg-slate-50">
              <th className="px-3 py-2.5" colSpan={columns.length} scope="colgroup">
                <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                  <span className="text-phx-xs font-black uppercase tracking-[0.14em] text-slate-900">
                    {group.label}
                    <span className="ml-2 font-semibold normal-case tracking-normal text-slate-500 tabular-nums">
                      {countOf(group.reps.length, noun)}
                    </span>
                  </span>
                  {renderGroupMeta ? (
                    <span className="text-phx-sm font-normal normal-case tracking-normal text-slate-500">
                      {renderGroupMeta(group.reps)}
                    </span>
                  ) : null}
                </div>
              </th>
            </tr>
            {group.reps.map((item) => (
              <tr className="border-t border-slate-100 transition-colors hover:bg-orange-50" key={rowKey(item)}>
                {columns.map((column) => (
                  <td
                    className={`px-3 py-2.5 align-top text-sm text-slate-700 [overflow-wrap:anywhere] ${column.align === "right" ? "text-right tabular-nums" : ""}`}
                    key={column.key}
                  >
                    {column.cell(item)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        ))}
      </table>
    </div>
  );
}

/** A team table's first cell: the monogram and the name, as the row's link. */
export function TeamTableName({ href, muted, name, sub }: { href: string; muted?: boolean; name: string; sub?: string }) {
  return (
    <Link className="group flex items-start gap-2.5 focus:outline-none focus-visible:ring-2 focus-visible:ring-orange-400" href={href}>
      <RepMonogram muted={muted} name={name} />
      <span className="min-w-0">
        <span className="block font-black leading-tight text-slate-900 group-hover:text-orange-700">{name}</span>
        {sub ? <span className="mt-0.5 block text-phx-sm font-semibold text-slate-500">{sub}</span> : null}
      </span>
    </Link>
  );
}

/**
 * The band an opened rep's screen starts with, under the back bar: the monogram, the name, the team he sits in, the
 * areas he works, and up to four facts in a row. It answers "whose screen is this" before a single figure is read,
 * the way the first line of a printed report names its subject.
 */
export function RepProfileBand({
  facts,
  muted,
  name,
  places,
  team,
}: {
  facts: readonly { label: string; tone?: ChromeTone; value: string }[];
  /** A vacant seat: the monogram is drawn as the dashed empty square its card wears — the person is what is missing. */
  muted?: boolean;
  name: string;
  places: string;
  team: string;
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3 border-b border-slate-200 px-5 py-4">
      <div className="flex min-w-0 items-start gap-3">
        <span
          aria-hidden
          className={`flex h-12 w-12 shrink-0 items-center justify-center text-phx-xs font-black tracking-[0.06em] ${
            muted ? "border border-dashed border-slate-300 bg-white text-slate-400" : "bg-slate-900 text-white"
          }`}
        >
          {repInitials(name)}
        </span>
        <div className="min-w-0">
          <p className="text-base font-black leading-tight text-slate-900 [overflow-wrap:anywhere]">{name}</p>
          <p className="mt-0.5 text-phx-sm font-black uppercase tracking-[0.12em] text-orange-700 [overflow-wrap:anywhere]">{team}</p>
          <p className="mt-0.5 text-phx-sm font-semibold text-slate-500 [overflow-wrap:anywhere]">{places}</p>
        </div>
      </div>
      {facts.length > 0 ? (
        <dl className="grid grid-cols-2 gap-x-6 gap-y-2 sm:flex sm:flex-wrap">
          {facts.map((fact) => (
            <div className="border-l-[3px] border-slate-200 pl-2.5" key={fact.label}>
              <dt className="text-phx-xs font-black uppercase tracking-[0.14em] text-slate-500">{fact.label}</dt>
              <dd className={`text-sm font-black tabular-nums ${TONE_TEXT[fact.tone ?? "slate"]}`}>{fact.value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
    </div>
  );
}

/**
 * A list of named figures as flat horizontal bars, largest first — the bricks of a contact list, read at a glance (the
 * owner wants figures shown as charts). Each bar is measured against the largest; the figure and its words carry the
 * information, so the bar is decorative to a screen reader.
 */
export function RankedBars({
  caption,
  items,
  total,
}: {
  caption: string;
  items: readonly { key: string; label: string; note?: string; tone?: ChromeTone; value: number }[];
  /** Printed beside the caption: what the bars add up to, said in words. */
  total: string;
}) {
  const largest = items.reduce((most, item) => Math.max(most, item.value), 0);
  return (
    <figure className="px-5 pt-4">
      <figcaption className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <span className="text-phx-xs font-black uppercase tracking-[0.14em] text-slate-500">{caption}</span>
        <span className="text-phx-sm font-semibold text-slate-500 tabular-nums">{total}</span>
      </figcaption>
      <ul className="mt-2 grid gap-x-6 gap-y-2 lg:grid-cols-2">
        {items.map((item) => (
          <li key={item.key}>
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-phx-sm font-semibold text-slate-700 [overflow-wrap:anywhere]" dir="auto">
                {item.label}
                {item.note ? <span className="ml-1.5 text-amber-700">{item.note}</span> : null}
              </span>
              <span className="shrink-0 text-phx-sm font-black text-slate-900 tabular-nums">{item.value}</span>
            </div>
            <div aria-hidden className="mt-1 h-1.5 w-full bg-slate-100">
              <div className={`h-1.5 ${TONE_FILL[item.tone ?? "slate"]}`} style={{ width: `${meterPercent(item.value, largest)}%` }} />
            </div>
          </li>
        ))}
      </ul>
    </figure>
  );
}

/** The row a board's download button sits in, under its tiles — a sentence saying what it holds, then the button. */
export function ExportRowBar({ children, note }: { children: React.ReactNode; note: string }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-5 pt-4 print:hidden">
      <p className="text-phx-sm leading-relaxed text-slate-500">{note}</p>
      {children}
    </div>
  );
}

/**
 * Every team on one screen, one line each — the regional manager's first question ("which of my teams is behind?")
 * answered before he scrolls through a single card. Each line is the team's heading, how many it holds, and its own
 * flat bar with the figures in words beside it, so two teams are compared by eye and confirmed by number.
 *
 * Drawn only when there are two teams or more: one team's roll-up is the bar above it, said twice. A definition list,
 * not a table — it has no columns to read down, and on a phone each team simply stacks its bar under its name, so
 * nothing ever scrolls sideways.
 */
export function TeamRollup<T>({
  caption,
  groups,
  noun,
  segments,
}: {
  caption: string;
  groups: readonly { key?: string; label: string; reps: readonly T[] }[];
  noun: string;
  /** The team's own figures, in the same order and tones as the tab's whole-board bar. */
  segments: (items: readonly T[]) => readonly ShareBarSegment[];
}) {
  if (groups.length < 2) return null;
  return (
    <figure className="px-5 pt-4">
      <figcaption className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <span className="text-phx-xs font-black uppercase tracking-[0.14em] text-slate-500">{caption}</span>
        <span className="text-phx-sm font-semibold text-slate-500 tabular-nums">{countOf(groups.length, "team")}</span>
      </figcaption>
      <dl className="mt-2 border-t border-slate-200">
        {groups.map((group) => {
          const parts = segments(group.reps);
          const { slices } = shareSlices(parts);
          const toneOf = new Map(parts.map((part) => [part.key, part.tone]));
          return (
            <div
              className="grid gap-x-6 gap-y-1.5 border-b border-slate-100 py-2.5 md:grid-cols-[minmax(0,2fr)_minmax(0,3fr)] md:items-center"
              key={group.key ?? group.label}
            >
              <dt className="text-phx-sm font-black uppercase tracking-[0.12em] text-slate-900 [overflow-wrap:anywhere]">
                {group.label}
                <span className="ml-2 font-semibold normal-case tracking-normal text-slate-500 tabular-nums">
                  {countOf(group.reps.length, noun)}
                </span>
              </dt>
              <dd className="min-w-0">
                <div aria-hidden className="flex h-2 w-full bg-slate-100">
                  {slices.map((slice) =>
                    slice.width > 0 ? (
                      <div
                        className={`h-2 ${TONE_FILL[toneOf.get(slice.key) ?? "slate"]} border-r border-white last:border-r-0`}
                        key={slice.key}
                        style={{ width: `${slice.width}%` }}
                      />
                    ) : null,
                  )}
                </div>
                <p className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5 text-phx-sm text-slate-600">
                  {slices.map((slice) => (
                    <span className="inline-flex items-center gap-1.5" key={slice.key}>
                      <Swatch tone={toneOf.get(slice.key) ?? "slate"} />
                      <span className="font-black text-slate-900 tabular-nums">{slice.value}</span>
                      {slice.label.toLowerCase()}
                    </span>
                  ))}
                </p>
              </dd>
            </div>
          );
        })}
      </dl>
    </figure>
  );
}
