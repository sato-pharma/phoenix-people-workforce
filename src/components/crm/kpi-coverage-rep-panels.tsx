/**
 * THE OPEN REP'S COVERAGE PANEL — the premium pass of 9 November 2026 (owner: "eyeball every report in My
 * Team's Reports, premium polish big work, every single component").
 *
 * When a manager opens one rep's doctors on the Coverage report, this file draws what sits above the two
 * lists: the four tiles, a track of his planned list against the 95% floor, how late the late doctors are,
 * the doctors to see first to clear the floor, how often the covered ones were seen, and the same doctors by
 * the week they were planned, by grade and by speciality. Every figure comes from
 * crm/kpi-coverage-rep-detail.ts, which counts the two lists the server built for this rep and adds no
 * measure — so the tiles here, his row and the lists below can never disagree.
 *
 * ## The finish (owner, 22 Oct 2026: nothing may look machine-made)
 *
 * Flat colour, square corners, no gradient, glow or drop shadow. Colour marks a status in one place per part
 * (a segment, a swatch, a meter) and every figure is tabular. Nothing sets a min-width or scrolls sideways,
 * and nothing is cut with an ellipsis. A table that can sit in half a row switches to rows by ITS OWN width
 * (`@container`), never the viewport's, so it fits in the two-column grid on a laptop and alone on a phone.
 *
 * ## NO "use client"
 *
 * Markup only, no handlers: the board stays a server component (tests/rsc-client-function-props.test.ts).
 * Links arrive as ready-made strings, never as functions.
 *
 * ## text-phx-* never goes through cn()
 *
 * tailwind-merge strips custom named font sizes, so every class string here is a plain template literal.
 */

import Link from "next/link";

import { CAPTION, KpiMeter, KpiTile, NUM, TD, TH, toneOf } from "@/components/crm/kpis-chrome";
import { KpiShareBar } from "@/components/crm/kpi-coverage-panels";
import {
  kpiFloorSentence,
  kpiShortDay,
  type KpiCoverageGroup,
  type KpiCoverageWeek,
  type KpiFloorPathStep,
  type KpiLateBucket,
  type KpiRepCoverageSummary,
} from "@/lib/crm/kpi-coverage-rep-detail";
import type { KpiCoverageDoctor } from "@/lib/crm/kpis-board";
import { kpiBandOf, type KpiBand } from "@/lib/crm/kpis-filters";

const EYEBROW = "text-phx-2xs font-black uppercase tracking-[0.14em] text-slate-500 sm:text-phx-3xs";
const SMALL = "text-phx-2xs leading-4 text-slate-500 sm:text-phx-3xs";
const LINK = "underline decoration-slate-300 underline-offset-2 hover:text-orange-700 hover:decoration-orange-500";

/** The three states of a planned doctor, each one flat swatch. Late is the only one in a warning colour. */
const STATE_SWATCH = {
  covered: "bg-emerald-600",
  late: "bg-rose-600",
  ahead: "bg-slate-300",
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
        <p className="text-phx-3xs font-black uppercase tracking-[0.14em] text-slate-500">{title}</p>
        {caption ? <p className="mt-0.5 text-phx-3xs leading-4 text-slate-500">{caption}</p> : null}
      </div>
      {children}
    </div>
  );
}

// ── The four tiles ───────────────────────────────────────────────────────────────────────────

/**
 * Coverage, Covered, Late and Not due yet, in the board's own `KpiTile`. Covered + Late + Not due yet is
 * Planned, by construction, so the four tiles add up to the row above them.
 */
export function KpiRepCoverageTiles({ summary }: { summary: KpiRepCoverageSummary }) {
  const { covered, late, notDue, pct, planned, visits, seenOnce } = summary;
  const repeat = covered - seenOnce;
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <KpiTile
        band={kpiBandOf(pct)}
        caption={`${covered} of ${planned} planned doctors seen at least once`}
        label="Coverage"
        progress={pct}
        value={`${pct}%`}
      />
      <KpiTile
        caption={`${plural(visits, "visit")} in all · ${plural(repeat, "doctor")} seen more than once`}
        label="Covered"
        value={String(covered)}
      />
      <KpiTile
        band={late > 0 ? "behind" : "elite"}
        caption={late > 0 ? "Planned day has passed with no visit" : "Nobody is overdue"}
        label="Late"
        value={String(late)}
      />
      <KpiTile caption={notDue > 0 ? "Planned day is still ahead" : "No planned day left ahead"} label="Not due yet" value={String(notDue)} />
    </div>
  );
}

// ── The track to the floor ───────────────────────────────────────────────────────────────────

/**
 * THE PLANNED LIST AS ONE TRACK: covered, late and not due yet, end to end, with the floor marked where
 * it falls. The covered segment reaching the mark is the floor cleared; the legend under it carries every
 * figure in words, so nothing is read off a colour alone.
 */
export function KpiFloorTrack({
  lateHref,
  aheadHref,
  summary,
}: {
  lateHref?: string;
  aheadHref?: string;
  summary: KpiRepCoverageSummary;
}) {
  const { covered, floorPct, floorTarget, late, notDue, planned } = summary;
  const share = (count: number) => `${(count / planned) * 100}%`;
  const segments = [
    { key: "covered", count: covered, swatch: STATE_SWATCH.covered, label: "Covered", href: undefined as string | undefined },
    { key: "late", count: late, swatch: STATE_SWATCH.late, label: "Late", href: lateHref },
    { key: "ahead", count: notDue, swatch: STATE_SWATCH.ahead, label: "Not due yet", href: aheadHref },
  ];
  return (
    <figure className="min-w-0 border border-slate-200 bg-white px-4 py-4 sm:px-5">
      <figcaption className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <span className={EYEBROW}>The planned list against the floor</span>
        <span className={`${SMALL} tabular-nums`}>
          Floor {floorPct}% · {floorTarget} of {planned}
        </span>
      </figcaption>
      <div className="relative mt-3">
        <div aria-hidden className="flex h-4 w-full bg-slate-100">
          {segments
            .filter((segment) => segment.count > 0)
            .map((segment) => (
              <span
                className={`h-full border-r border-white last:border-r-0 ${segment.swatch}`}
                key={segment.key}
                style={{ width: share(segment.count) }}
              />
            ))}
        </div>
        {/* The floor: one 2px rule through the track, a little taller than it. */}
        <span
          aria-hidden
          className="absolute -bottom-1 -top-1 w-0.5 -translate-x-1/2 bg-slate-900"
          style={{ left: `${Math.min(100, floorPct)}%` }}
        />
      </div>
      <ul className="mt-3 grid gap-x-4 gap-y-1 sm:grid-cols-3">
        {segments.map((segment) => (
          <li className="flex items-start gap-2" key={segment.key}>
            <span aria-hidden className={`mt-1 h-2 w-2 shrink-0 ${segment.swatch}`} />
            <span className="min-w-0 flex-1 text-phx-xs leading-4 text-slate-700 sm:text-phx-2xs">{segment.label}</span>
            <span className="shrink-0 text-phx-xs font-black tabular-nums text-slate-900 sm:text-phx-2xs">
              <CountLink count={segment.count} href={segment.href} />
            </span>
          </li>
        ))}
      </ul>
      <p className={`mt-3 leading-4 ${CAPTION}`}>{kpiFloorSentence(summary)}</p>
    </figure>
  );
}

// ── How late ─────────────────────────────────────────────────────────────────────────────────

/**
 * THE LATE DOCTORS BY AGE: missed in the last week, the week before, and earlier. Three counts that add up
 * to the Late tile, and for each the oldest miss, so a manager sees whether the rep is slipping now or
 * carrying old misses. Nothing is drawn when nobody is late.
 */
export function KpiLateAgeingPanel({
  asOf,
  buckets,
  lateHref,
}: {
  asOf: string;
  buckets: readonly KpiLateBucket[];
  lateHref?: string;
}) {
  const total = buckets.reduce((sum, bucket) => sum + bucket.doctors.length, 0);
  if (total === 0) return null;
  const tone: Record<KpiLateBucket["age"], string> = {
    "this-week": "bg-amber-500",
    "last-week": "bg-rose-500",
    older: "bg-rose-700",
  };
  return (
    <Panel caption={`Counted to ${kpiShortDay(asOf) ?? asOf}, from the last planned day each doctor missed.`} title="How late the late doctors are">
      <div className="px-3 py-3">
        <KpiShareBar
          caption="Late doctors by age"
          slices={buckets.map((bucket) => ({
            key: bucket.age,
            label: bucket.label,
            count: bucket.doctors.length,
            swatch: tone[bucket.age],
          }))}
          unit={["late doctor", "late doctors"]}
        />
      </div>
      <dl className="grid divide-y divide-slate-100 border-t border-slate-100 sm:grid-cols-3 sm:divide-x sm:divide-y-0">
        {buckets.map((bucket) => {
          const oldest = bucket.doctors
            .flatMap((doctor) => doctor.planDates.filter((day) => day <= asOf))
            .sort()[0];
          return (
            <div className="min-w-0 px-3 py-2.5" key={bucket.age}>
              <dt className={SMALL}>{bucket.label}</dt>
              <dd className="mt-0.5 text-lg font-black tabular-nums text-slate-900">
                <CountLink count={bucket.doctors.length} href={lateHref} />
              </dd>
              <dd className={SMALL}>
                {bucket.doctors.length === 0 ? "Nobody" : `Oldest planned day ${kpiShortDay(oldest) ?? "not on the plan"}`}
              </dd>
            </div>
          );
        })}
      </dl>
    </Panel>
  );
}

// ── Who to see first ─────────────────────────────────────────────────────────────────────────

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
        <span className="block text-phx-3xs leading-4 text-slate-500" dir="auto">
          {meta}
        </span>
      ) : null}
    </span>
  );
}

function stepWhy(step: KpiFloorPathStep): string {
  const days = step.days.map((day) => kpiShortDay(day)).filter(Boolean);
  if (step.late) {
    if (days.length === 0) return "Late · no planned day the list could read";
    return `Late · missed ${days.join(" · ")}`;
  }
  return days.length > 0 ? `Next planned ${days[0]}` : "No day on the plan";
}

/**
 * THE SHORTEST WAY TO THE FLOOR — exactly as many doctors as he is short, in the order to send him: late
 * grade A first, then the rest of the late list, then the doctors still ahead. A suggestion over his own
 * plan, never a change to it: any doctors of the same number clear the floor as well.
 */
export function KpiFloorPathPanel({ steps, summary }: { steps: readonly KpiFloorPathStep[]; summary: KpiRepCoverageSummary }) {
  if (steps.length === 0) return null;
  const late = steps.filter((step) => step.late).length;
  return (
    <Panel
      caption={`${plural(steps.length, "doctor")} clear the ${summary.floorPct}% floor — ${late > 0 ? `${late} already late, ` : ""}late grade A first. Any ${steps.length} of the not-covered doctors clear it as well.`}
      title="To clear the floor, see these first"
    >
      <div className="@container">
        <table className="hidden w-full table-fixed @min-[34rem]:table">
          <colgroup>
            <col style={{ width: "10%" }} />
            <col style={{ width: "50%" }} />
            <col style={{ width: "40%" }} />
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
                  <span className={`block text-phx-2xs font-semibold leading-4 ${step.late ? "text-rose-700" : "text-slate-600"}`}>
                    {stepWhy(step)}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <ol className="divide-y divide-slate-100 @min-[34rem]:hidden">
          {steps.map((step, index) => (
            <li className="flex items-start gap-3 px-3 py-2.5 text-sm" key={step.doctor.contactCrmId}>
              <span className="w-5 shrink-0 font-black tabular-nums text-slate-400">{index + 1}</span>
              <span className="min-w-0 flex-1">
                <DoctorLine doctor={step.doctor} />
                <span className={`mt-1 block text-phx-3xs font-semibold leading-4 ${step.late ? "text-rose-700" : "text-slate-600"}`}>
                  {stepWhy(step)}
                </span>
              </span>
            </li>
          ))}
        </ol>
      </div>
    </Panel>
  );
}

// ── How often the covered doctors were seen ──────────────────────────────────────────────────

/** Covered doctors seen once, twice and three times or more. Adds up to the Covered tile. */
export function KpiRepVisitDepth({ summary }: { summary: KpiRepCoverageSummary }) {
  if (summary.covered === 0) return null;
  return (
    <div className="min-w-0 border border-slate-200 bg-white px-3 py-3">
      <KpiShareBar
        caption="How often the covered doctors were seen"
        note="Coverage counts a doctor once, however often they were seen. How often each one should be seen is the Frequency report's measure."
        slices={[
          { key: "once", label: "Seen once", count: summary.seenOnce, swatch: "bg-emerald-300" },
          { key: "twice", label: "Seen twice", count: summary.seenTwice, swatch: "bg-emerald-500" },
          { key: "more", label: "Seen three times or more", count: summary.seenThreePlus, swatch: "bg-emerald-700" },
        ]}
        unit={["covered doctor", "covered doctors"]}
      />
    </div>
  );
}

// ── The breakdown tables ─────────────────────────────────────────────────────────────────────

/** A group row's links into the list below it, narrowed to that group — strings, never functions. */
export type KpiCoverageGroupLinks = { group?: string; late?: string; ahead?: string };

export type KpiCoverageGroupLine = KpiCoverageGroup & {
  links?: KpiCoverageGroupLinks;
  /** A second line under the group's name — "Not begun yet" for a week still ahead. */
  note?: string;
};

function groupBand(row: KpiCoverageGroup): KpiBand {
  return kpiBandOf(row.pct);
}

function GroupName({ row }: { row: KpiCoverageGroupLine }) {
  return (
    <span className="block min-w-0" dir="auto">
      {row.links?.group ? (
        <Link className={LINK} href={row.links.group}>
          {row.label}
        </Link>
      ) : (
        row.label
      )}
      {row.note ? <span className="mt-0.5 block text-phx-3xs leading-4 text-slate-400">{row.note}</span> : null}
    </span>
  );
}

/** "3 late · 2 ahead", each a link, or "None" — the two kinds of not covered in one merged cell. */
function NotCoveredCell({ row }: { row: KpiCoverageGroupLine }) {
  if (row.late === 0 && row.notDue === 0) return <span className="text-slate-400">None</span>;
  return (
    <span className="block">
      {row.late > 0 ? (
        <span className="block text-rose-700">
          <CountLink count={row.late} href={row.links?.late} /> late
        </span>
      ) : null}
      {row.notDue > 0 ? (
        <span className="block text-slate-500">
          <CountLink count={row.notDue} href={row.links?.ahead} /> not due yet
        </span>
      ) : null}
    </span>
  );
}

/**
 * ONE BREAKDOWN OF THE OPEN REP'S DOCTORS — by week, by grade or by speciality. Group, Planned, Covered,
 * Not covered (late and not due yet merged into one cell — the golden rule's own answer: merge, never
 * shrink) and the rate with its meter. A table once the panel itself is 34rem wide, rows below that.
 */
export function KpiCoverageGroupTable({
  caption,
  groupHeading,
  rows,
  title,
}: {
  caption?: string;
  groupHeading: string;
  rows: readonly KpiCoverageGroupLine[];
  title: string;
}) {
  if (rows.length === 0) return null;
  return (
    <Panel caption={caption} title={title}>
      <div className="@container">
        <table className="hidden w-full table-fixed @min-[34rem]:table">
          <colgroup>
            <col style={{ width: "32%" }} />
            <col style={{ width: "14%" }} />
            <col style={{ width: "14%" }} />
            <col style={{ width: "20%" }} />
            <col style={{ width: "20%" }} />
          </colgroup>
          <thead className="border-b border-slate-100">
            <tr>
              <th className={TH} scope="col">
                {groupHeading}
              </th>
              <th className={TH} scope="col">
                Planned
              </th>
              <th className={TH} scope="col">
                Covered
              </th>
              <th className={TH} scope="col">
                Not covered
              </th>
              <th className={TH} scope="col">
                Rate
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rows.map((row) => (
              <tr key={row.label}>
                <td className={TD}>
                  <GroupName row={row} />
                </td>
                <td className={NUM}>{row.planned}</td>
                <td className={NUM}>{row.covered}</td>
                <td className={`${NUM} text-phx-2xs`}>
                  <NotCoveredCell row={row} />
                </td>
                <td className={NUM}>
                  <span className={`block font-black ${toneOf(groupBand(row)).text}`}>{row.pct}%</span>
                  <KpiMeter band={groupBand(row)} value={row.pct} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <ul className="divide-y divide-slate-100 @min-[34rem]:hidden">
          {rows.map((row) => (
            <li className="px-3 py-2.5" key={row.label}>
              <div className="flex items-baseline justify-between gap-3">
                <span className="min-w-0 text-sm font-semibold text-slate-900">
                  <GroupName row={row} />
                </span>
                <span className={`shrink-0 text-sm font-black tabular-nums ${toneOf(groupBand(row)).text}`}>{row.pct}%</span>
              </div>
              <KpiMeter band={groupBand(row)} value={row.pct} />
              <span className="mt-1 block text-phx-3xs leading-4 text-slate-500">
                {row.covered} of {row.planned} planned doctors seen
                {row.late > 0 ? (
                  <>
                    {" · "}
                    <span className="text-rose-700">
                      <CountLink count={row.late} href={row.links?.late} /> late
                    </span>
                  </>
                ) : null}
                {row.notDue > 0 ? (
                  <>
                    {" · "}
                    <CountLink count={row.notDue} href={row.links?.ahead} /> not due yet
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
export function KpiCoverageWeekTable({ weeks }: { weeks: readonly KpiCoverageWeek[] }) {
  // One week (a week's own period) says nothing a tile does not already say.
  if (weeks.length < 2) return null;
  return (
    <KpiCoverageGroupTable
      caption="Each doctor counted once, in the week of the first day the plan booked them. A covered doctor counts as covered whenever the visit came."
      groupHeading="Week"
      rows={weeks.map((week) => ({ ...week, note: week.ahead ? "Not begun yet" : undefined }))}
      title="By the week planned"
    />
  );
}
