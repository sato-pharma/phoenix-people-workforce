/**
 * THE OPEN REP'S FREQUENCY PANEL — the premium pass of 9 November 2026 (owner: "eyeball every report in My
 * Team's Reports, premium polish big work, every single component").
 *
 * When a manager opens one rep's doctors on the Frequency report, this file draws what sits above the list:
 * the four tiles, the judged list as one track (the pass, the short, the extra, the not judged), how far short
 * the short doctors are, who to go back to first, and the same doctors by the week they were planned, by grade
 * and by speciality. Every figure comes from crm/kpi-frequency-rep-detail.ts, which counts the verdicts the
 * server stamped on this rep's list and adds no measure — so the tiles, his row and the list can never
 * disagree. The frame, the eyebrow and the share bar are the Coverage panel's own, so both pages wear one kit.
 *
 * ## The finish (owner, 22 Oct 2026: nothing may look machine-made)
 *
 * Flat colour, square corners, no gradient, glow or drop shadow. Colour marks a status in one place per part
 * and every figure is tabular. Nothing sets a min-width or scrolls sideways, and nothing is cut with an
 * ellipsis. A table that can sit in half a row is a table only when BOTH its own panel is 34rem wide AND the
 * screen is `md` or wider — `@min-[34rem]:md:table`, the CRM's desktop gate.
 *
 * ## NO "use client"
 *
 * Markup only, no handlers: the board stays a server component. Links arrive as ready-made strings.
 *
 * ## text-phx-* never goes through cn()
 *
 * tailwind-merge strips custom named font sizes, so every class string here is a plain template literal.
 */

import Link from "next/link";

import { CAPTION, KpiMeter, KpiTile, NUM, TD, TH, toneOf } from "@/components/crm/kpis-chrome";
import { KpiShareBar } from "@/components/crm/kpi-coverage-panels";
import {
  kpiFrequencySentence,
  kpiFrequencyStepWhy,
  type KpiFrequencyGroup,
  type KpiFrequencyStep,
  type KpiFrequencyWeek,
  type KpiRepFrequencySummary,
  type KpiShortBucket,
} from "@/lib/crm/kpi-frequency-rep-detail";
import type { KpiCoverageDoctor } from "@/lib/crm/kpis-board";
import { kpiBandOf, type KpiBand } from "@/lib/crm/kpis-filters";

const EYEBROW = "text-phx-sm font-black uppercase tracking-[0.14em] text-slate-500 sm:text-phx-xs";
const SMALL = "text-phx-sm leading-4 text-slate-500 sm:text-phx-xs";
const LINK = "underline decoration-slate-300 underline-offset-2 hover:text-orange-700 hover:decoration-orange-500";

/** The four states of a doctor on the track, each one flat swatch. Short is the only warning colour. */
const TRACK_SWATCH = {
  passing: "bg-emerald-600",
  short: "bg-rose-600",
  extra: "bg-amber-500",
  waiting: "bg-slate-300",
} as const;

function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** A count that opens the list narrowed to it, when there is something to open. */
function CountLink({ count, href }: { count: number; href?: string }) {
  if (count === 0 || !href) return <>{count}</>;
  return (
    <Link className={LINK} href={href}>
      {count}
    </Link>
  );
}

/** A panel's frame and its eyebrow, the brick table's own header. */
function Panel({ caption, children, title }: { caption?: string; children: React.ReactNode; title: string }) {
  return (
    <div className="min-w-0 border border-slate-200 bg-white">
      <div className="border-b border-slate-200 bg-slate-50 px-3 py-2">
        <p className="text-phx-xs font-black uppercase tracking-[0.14em] text-slate-500">{title}</p>
        {caption ? <p className="mt-0.5 text-phx-xs leading-4 text-slate-500">{caption}</p> : null}
      </div>
      {children}
    </div>
  );
}

// ── The four tiles ───────────────────────────────────────────────────────────────────────────

/**
 * Frequency, Visits made, Visits owed and Short doctors, in the board's own `KpiTile`. The Frequency tile is
 * the figure on his row; the other three are the visits behind it.
 */
export function KpiRepFrequencyTiles({ phoenix, summary }: { phoenix: boolean; summary: KpiRepFrequencySummary }) {
  const { asked, due, judged, made, neverVisited, owed, passing, pct, short } = summary;
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <KpiTile
        band={pct == null ? "noplan" : kpiBandOf(pct)}
        caption={
          pct == null
            ? "Nothing to judge yet"
            : `${passing} of ${judged} judged doctors ${phoenix ? "at their norm" : "visited exactly as planned"}`
        }
        label="Frequency"
        progress={pct}
        value={pct == null ? "—" : `${pct}%`}
      />
      <KpiTile
        caption={due === asked ? `of ${plural(asked, "visit")} asked for in the period` : `${due} have come due so far, of ${asked} asked for`}
        label="Visits made"
        value={String(made)}
      />
      <KpiTile
        band={owed > 0 ? "behind" : "elite"}
        caption={owed > 0 ? "Due so far and not yet made" : "Nothing is owed"}
        label="Visits owed"
        value={String(owed)}
      />
      <KpiTile
        band={short > 0 ? "behind" : undefined}
        caption={short > 0 ? (neverVisited > 0 ? `${neverVisited} of them never visited` : "Every one of them seen at least once") : "Nobody is short"}
        label="Doctors short"
        value={String(short)}
      />
    </div>
  );
}

// ── The track ────────────────────────────────────────────────────────────────────────────────

/**
 * THE LIST AS ONE TRACK: the doctors at the pass, the doctors short, the doctors seen more often than asked
 * (a deviation under the original rules, still at the norm under the Phoenix rules), and the doctors not
 * judged yet (not due, or ungraded). The four add up to every doctor on the list; the legend carries every
 * figure in words, and the sentence under it says what is owed and what one more visit each would do.
 */
export function KpiFrequencyTrack({
  hrefs,
  lift,
  phoenix,
  summary,
}: {
  hrefs: { passing?: string; short?: string; extra?: string; waiting?: string };
  lift: { doctors: number; pct: number } | null;
  phoenix: boolean;
  summary: KpiRepFrequencySummary;
}) {
  const above = phoenix ? 0 : (summary.byStatus.get("above") ?? 0);
  const waiting = summary.notDue + summary.ungraded;
  // Short is every judged doctor that is neither passing nor above — below and never visited.
  const shortDoctors = Math.max(0, summary.judged - summary.passing - above);
  const total = summary.passing + shortDoctors + above + waiting;
  const segments = [
    { key: "passing", count: summary.passing, swatch: TRACK_SWATCH.passing, label: phoenix ? "At norm" : "Exact", href: hrefs.passing },
    { key: "short", count: shortDoctors, swatch: TRACK_SWATCH.short, label: phoenix ? "Below norm" : "Below or not visited", href: hrefs.short },
    ...(phoenix ? [] : [{ key: "extra", count: above, swatch: TRACK_SWATCH.extra, label: "Above plan", href: hrefs.extra }]),
    {
      key: "waiting",
      count: waiting,
      swatch: TRACK_SWATCH.waiting,
      label: phoenix ? "Ungraded or not due" : "Not due yet",
      href: hrefs.waiting,
    },
  ];
  if (total === 0) return null;
  return (
    <figure className="min-w-0 border border-slate-200 bg-white px-4 py-4 sm:px-5">
      <figcaption className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <span className={EYEBROW}>{phoenix ? "The doctors against their grade's norm" : "The doctors against the plan"}</span>
        <span className={`${SMALL} tabular-nums`}>{plural(total, "doctor")} on the list</span>
      </figcaption>
      <div aria-hidden className="mt-3 flex h-4 w-full bg-slate-100">
        {segments
          .filter((segment) => segment.count > 0)
          .map((segment) => (
            <span
              className={`h-full border-r border-white last:border-r-0 ${segment.swatch}`}
              key={segment.key}
              style={{ width: `${(segment.count / total) * 100}%` }}
            />
          ))}
      </div>
      <ul className={`mt-3 grid gap-x-4 gap-y-1 ${phoenix ? "sm:grid-cols-3" : "sm:grid-cols-2 lg:grid-cols-4"}`}>
        {segments.map((segment) => (
          <li className="flex items-start gap-2" key={segment.key}>
            <span aria-hidden className={`mt-1 h-2 w-2 shrink-0 ${segment.swatch}`} />
            <span className="min-w-0 flex-1 text-phx-md leading-4 text-slate-700 sm:text-phx-sm">{segment.label}</span>
            <span className="shrink-0 text-phx-md font-black tabular-nums text-slate-900 sm:text-phx-sm">
              <CountLink count={segment.count} href={segment.href} />
            </span>
          </li>
        ))}
      </ul>
      <p className={`mt-3 leading-4 ${CAPTION}`}>{kpiFrequencySentence(summary, lift, phoenix)}</p>
    </figure>
  );
}

// ── How far short ────────────────────────────────────────────────────────────────────────────

/**
 * THE SHORT DOCTORS BY DEPTH: one visit short, two, three or more, and never visited at all. Four counts that
 * add up to the Doctors short tile, each with the visits it owes, so a manager sees whether the rep is a visit
 * away from the pass or has not started on half his list. Nothing is drawn when nobody is short.
 */
export function KpiShortDepthPanel({ buckets, shortHref }: { buckets: readonly KpiShortBucket[]; shortHref?: string }) {
  const total = buckets.reduce((sum, bucket) => sum + bucket.rows.length, 0);
  if (total === 0) return null;
  const tone: Record<KpiShortBucket["depth"], string> = {
    one: "bg-amber-400",
    two: "bg-amber-600",
    "three-plus": "bg-rose-600",
    never: "bg-rose-800",
  };
  return (
    <Panel caption="Each short doctor by how many of the visits that have come due are still not made." title="How far short the short doctors are">
      <div className="px-3 py-3">
        <KpiShareBar
          caption="Short doctors by depth"
          slices={buckets.map((bucket) => ({ key: bucket.depth, label: bucket.label, count: bucket.rows.length, swatch: tone[bucket.depth] }))}
          unit={["short doctor", "short doctors"]}
        />
      </div>
      <dl className="grid grid-cols-2 divide-x divide-y divide-slate-100 border-t border-slate-100 sm:grid-cols-4 sm:divide-y-0">
        {buckets.map((bucket) => (
          <div className="min-w-0 px-3 py-2.5" key={bucket.depth}>
            <dt className={SMALL}>{bucket.label}</dt>
            <dd className="mt-0.5 text-lg font-black tabular-nums text-slate-900">
              <CountLink count={bucket.rows.length} href={shortHref} />
            </dd>
            <dd className={SMALL}>{bucket.rows.length === 0 ? "Nobody" : `${plural(bucket.owed, "visit")} owed`}</dd>
          </div>
        ))}
      </dl>
    </Panel>
  );
}

// ── Who to go back to first ──────────────────────────────────────────────────────────────────

function DoctorLine({ doctor }: { doctor: KpiCoverageDoctor }) {
  const meta = [doctor.speciality, doctor.grade ? `Grade ${doctor.grade}` : null].filter(Boolean).join(" · ");
  return (
    <span className="block min-w-0">
      {doctor.name ? (
        <span className="block font-semibold leading-5 text-slate-900" dir="auto">
          {doctor.name}
        </span>
      ) : (
        <span className="block font-semibold leading-5 text-slate-500">Name not on the plan</span>
      )}
      {meta ? (
        <span className="block text-phx-xs leading-4 text-slate-500" dir="auto">
          {meta}
        </span>
      ) : null}
    </span>
  );
}

/**
 * WHO TO GO BACK TO FIRST — the short doctors in the order to send the rep: the ones a single visit passes
 * first, then grade A before B before C, then the most owed. A suggestion over his own list, never a change
 * to it. When the plan already brings a doctor back, the next planned day says so.
 */
export function KpiFrequencyFirstPanel({ phoenix, steps, total }: { phoenix: boolean; steps: readonly KpiFrequencyStep[]; total: number }) {
  if (steps.length === 0) return null;
  const oneVisit = steps.filter((step) => step.owed === 1).length;
  return (
    <Panel
      caption={`${steps.length === total ? `All ${plural(total, "short doctor")}` : `${steps.length} of ${plural(total, "short doctor")}`}, the ones a single visit ${phoenix ? "brings to their norm" : "makes exact"} first${oneVisit > 0 ? ` (${oneVisit})` : ""}, then by grade.`}
      title="Go back to these first"
    >
      <div className="@container">
        <table className="hidden w-full table-fixed @min-[34rem]:md:table">
          <colgroup>
            <col style={{ width: "10%" }} />
            <col style={{ width: "48%" }} />
            <col style={{ width: "42%" }} />
          </colgroup>
          <thead className="border-b border-slate-100">
            <tr>
              <th className={TH} scope="col">
                #
              </th>
              <th className={TH} scope="col">
                Doctor
              </th>
              <th className={TH} scope="col">
                Why now
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {steps.map((step, index) => (
              <tr key={step.doctor.contactCrmId}>
                <td className={NUM}>{index + 1}</td>
                <td className={TD}>
                  <DoctorLine doctor={step.doctor} />
                </td>
                <td className={TD}>
                  <span className={`block text-phx-sm font-semibold leading-4 ${step.owed === 1 ? "text-amber-700" : "text-rose-700"}`}>
                    {kpiFrequencyStepWhy(step)}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <ol className="divide-y divide-slate-100 @min-[34rem]:md:hidden">
          {steps.map((step, index) => (
            <li className="flex items-start gap-3 px-3 py-2.5 text-sm" key={step.doctor.contactCrmId}>
              <span className="w-5 shrink-0 font-black tabular-nums text-slate-400">{index + 1}</span>
              <span className="min-w-0 flex-1">
                <DoctorLine doctor={step.doctor} />
                <span className={`mt-1 block text-phx-xs font-semibold leading-4 ${step.owed === 1 ? "text-amber-700" : "text-rose-700"}`}>
                  {kpiFrequencyStepWhy(step)}
                </span>
              </span>
            </li>
          ))}
        </ol>
      </div>
    </Panel>
  );
}

// ── The breakdown tables ─────────────────────────────────────────────────────────────────────

/** A group row's links into the list below it, narrowed to that group — strings, never functions. */
export type KpiFrequencyGroupLinks = { group?: string; short?: string };

export type KpiFrequencyGroupLine = KpiFrequencyGroup & {
  links?: KpiFrequencyGroupLinks;
  /** A second line under the group's name — "Not begun yet" for a week still ahead. */
  note?: string;
};

function groupBand(row: KpiFrequencyGroup): KpiBand {
  return kpiBandOf(row.pct);
}

function GroupName({ row }: { row: KpiFrequencyGroupLine }) {
  return (
    <span className="block min-w-0" dir="auto">
      {row.links?.group ? (
        <Link className={LINK} href={row.links.group}>
          {row.label}
        </Link>
      ) : (
        row.label
      )}
      {row.note ? <span className="mt-0.5 block text-phx-xs leading-4 text-slate-400">{row.note}</span> : null}
    </span>
  );
}

/** "3 short · 5 owed", the short count a link, or "None" — the group's shortfall in one merged cell. */
function ShortCell({ row }: { row: KpiFrequencyGroupLine }) {
  if (row.short === 0) return <span className="text-slate-400">None</span>;
  return (
    <span className="block text-rose-700">
      <CountLink count={row.short} href={row.links?.short} /> short
      <span className="block text-slate-500">{plural(row.owed, "visit")} owed</span>
    </span>
  );
}

/**
 * ONE BREAKDOWN OF THE OPEN REP'S DOCTORS — by week, by grade or by speciality. Group, Doctors, Visits (made of
 * asked), Short (doctors short and the visits they owe, merged into one cell — the golden rule's own answer:
 * merge, never shrink) and the rate with its meter. A table once the panel itself is 34rem wide, rows below.
 */
export function KpiFrequencyGroupTable({
  caption,
  groupHeading,
  phoenix,
  rows,
  title,
}: {
  caption?: string;
  groupHeading: string;
  phoenix: boolean;
  rows: readonly KpiFrequencyGroupLine[];
  title: string;
}) {
  if (rows.length === 0) return null;
  const pctText = (row: KpiFrequencyGroup) => (row.pct == null ? "—" : `${row.pct}%`);
  return (
    <Panel caption={caption} title={title}>
      <div className="@container">
        <table className="hidden w-full table-fixed @min-[34rem]:md:table">
          <colgroup>
            <col style={{ width: "30%" }} />
            <col style={{ width: "13%" }} />
            <col style={{ width: "19%" }} />
            <col style={{ width: "19%" }} />
            <col style={{ width: "19%" }} />
          </colgroup>
          <thead className="border-b border-slate-100">
            <tr>
              <th className={TH} scope="col">
                {groupHeading}
              </th>
              <th className={TH} scope="col">
                Doctors
              </th>
              <th className={TH} scope="col">
                Visits
              </th>
              <th className={TH} scope="col">
                Short
              </th>
              <th className={TH} scope="col">
                {phoenix ? "At norm" : "Exact"}
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rows.map((row) => (
              <tr key={row.label}>
                <td className={TD}>
                  <GroupName row={row} />
                </td>
                <td className={NUM}>{row.doctors}</td>
                <td className={NUM}>
                  {row.made}
                  <span className="mt-0.5 block text-phx-xs font-semibold leading-4 text-slate-500">of {row.asked} asked</span>
                </td>
                <td className={`${NUM} text-phx-sm`}>
                  <ShortCell row={row} />
                </td>
                <td className={NUM}>
                  <span className={`block font-black ${toneOf(groupBand(row)).text}`}>{pctText(row)}</span>
                  {row.pct == null ? null : <KpiMeter band={groupBand(row)} value={row.pct} />}
                  <span className="mt-0.5 block text-phx-xs font-semibold leading-4 text-slate-500">
                    {row.passing} of {row.judged}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <ul className="divide-y divide-slate-100 @min-[34rem]:md:hidden">
          {rows.map((row) => (
            <li className="px-3 py-2.5" key={row.label}>
              <div className="flex items-baseline justify-between gap-3">
                <span className="min-w-0 text-sm font-semibold text-slate-900">
                  <GroupName row={row} />
                </span>
                <span className={`shrink-0 text-sm font-black tabular-nums ${toneOf(groupBand(row)).text}`}>{pctText(row)}</span>
              </div>
              {row.pct == null ? null : <KpiMeter band={groupBand(row)} value={row.pct} />}
              <span className="mt-1 block text-phx-xs leading-4 text-slate-500">
                {plural(row.doctors, "doctor")} · {row.made} of {row.asked} visits made · {row.passing} of {row.judged}{" "}
                {phoenix ? "at norm" : "exact"}
                {row.short > 0 ? (
                  <>
                    {" · "}
                    <span className="text-rose-700">
                      <CountLink count={row.short} href={row.links?.short} /> short, {row.owed} owed
                    </span>
                  </>
                ) : null}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </Panel>
  );
}

/** The week table: the doctors by the week of their first planned day, a week still ahead marked so. */
export function KpiFrequencyWeekTable({ phoenix, weeks }: { phoenix: boolean; weeks: readonly KpiFrequencyWeek[] }) {
  // One week (a week's own period) says nothing a tile does not already say.
  if (weeks.length < 2) return null;
  return (
    <KpiFrequencyGroupTable
      caption="Each doctor counted once, in the week of the first day the plan booked them. A doctor's visits count whenever they came."
      groupHeading="Week"
      phoenix={phoenix}
      rows={weeks.map((week) => ({ ...week, note: week.ahead ? "Not begun yet" : undefined }))}
      title="By the week planned"
    />
  );
}
