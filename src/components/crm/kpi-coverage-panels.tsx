/**
 * THE COVERAGE REPORT'S PANELS — the premium pass of 9 November 2026 (owner: "eyeball every report in My
 * Team's Reports, premium polish big work, every single component", then "group reps by district manager").
 *
 * What the pass found on the Coverage page, read as the Regional Sales Manager for three regions:
 *
 * - two tiles in a row built for six, then one podium card in a row built for four, so most of the top of
 *   the page was empty white;
 * - nine reps in one flat list, with nothing saying which district manager each one reports to — the
 *   question a regional manager opens the page to answer;
 * - fifty-odd bricks in one long table, with nothing above it saying how many are done and how many no
 *   rep has walked into yet.
 *
 * So this file draws four things, each from the board's own figures (crm/kpi-coverage-teams.ts adds no
 * measure): where the team stands, the teams side by side, a heading per team over the reps, and the
 * bricks at a glance over the brick table.
 *
 * ## The finish (owner, 22 Oct 2026: nothing may look machine-made)
 *
 * Flat colour only: no gradient, no glow, no drop shadow, square corners. Colour carries a status in one
 * place per part — a bar's segment, a legend's swatch, a meter's fill — and is never a fill behind a block.
 * Every figure is tabular. Nothing sets a min-width, nothing scrolls sideways and nothing is cut with an
 * ellipsis: a long name wraps.
 *
 * ## NO "use client"
 *
 * Pure markup with no handlers, so the board stays a server component and never hands a function to a
 * client one (tests/rsc-client-function-props.test.ts).
 *
 * ## text-phx-* never goes through cn()
 *
 * tailwind-merge strips custom named font sizes, so every class string here is a plain template literal.
 */

import Link from "next/link";

import {
  kpiBrickBandMix,
  kpiBrickCoveragePct,
  kpiBricksMostLeft,
  kpiBricksNotReached,
  kpiBrickTotals,
  kpiCoverageBandMix,
  kpiCoverageFloorCount,
  kpiMeterWidth,
  kpiNotValidatedTotal,
  kpiSharePercents,
  kpiTeamCoverage,
  kpiTeamHeading,
  type KpiCoverageTeam,
  type KpiTeamCoverage,
} from "@/lib/crm/kpi-coverage-teams";
import type { KpiRepRow, KpisBoard } from "@/lib/crm/kpis-board";
import type { KpiBrickRow } from "@/lib/crm/kpis-brick-table";
import type { KpiBand } from "@/lib/crm/kpis-filters";

// ── Tone ──────────────────────────────────────────────────────────────────────────────────────

/** One flat swatch per band. `noplan` is the quietest on the page: it is the absence of a score. */
const SWATCH: Record<KpiBand, string> = {
  elite: "bg-emerald-600",
  strong: "bg-sky-600",
  steady: "bg-amber-500",
  behind: "bg-rose-600",
  noplan: "bg-slate-300",
};

/** The same band as text, for a printed percentage. */
const INK: Record<KpiBand, string> = {
  elite: "text-emerald-700",
  strong: "text-sky-700",
  steady: "text-amber-700",
  behind: "text-rose-700",
  noplan: "text-slate-500",
};

export function kpiSwatchOf(band: KpiBand): string {
  return SWATCH[band];
}

export function kpiInkOf(band: KpiBand): string {
  return INK[band];
}

const EYEBROW = "text-phx-2xs font-black uppercase tracking-[0.14em] text-slate-500 sm:text-phx-3xs";
const SMALL = "text-phx-2xs leading-4 text-slate-500 sm:text-phx-3xs";

// ── The share bar ─────────────────────────────────────────────────────────────────────────────

/** One slice of a share bar: a label, a count and the flat swatch it is drawn in. */
export type KpiShareSlice = {
  key: string;
  label: string;
  count: number;
  /** A flat background class, e.g. `bg-emerald-600`. */
  swatch: string;
  /** Optional link, so a slice can open the rows it counts. */
  href?: string;
};

/**
 * ONE FLAT BAR AND A LEGEND THAT CARRIES EVERY FIGURE. The bar is for the eye; the legend is the record:
 * every slice's count and its share in words, so nothing is read off a colour alone. Empty slices are left
 * out of both. A bar with nothing to draw draws nothing — a caller never shows an empty track that would
 * read as zero.
 */
export function KpiShareBar({
  caption,
  note,
  slices,
  unit,
}: {
  caption: string;
  note?: string;
  slices: readonly KpiShareSlice[];
  /** The noun counted, singular and plural: ["rep", "reps"]. */
  unit: readonly [string, string];
}) {
  const shown = slices.filter((slice) => slice.count > 0);
  const total = shown.reduce((sum, slice) => sum + slice.count, 0);
  if (total === 0) return null;
  const percents = kpiSharePercents(shown.map((slice) => slice.count));
  return (
    <figure className="min-w-0">
      <figcaption className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <span className={EYEBROW}>{caption}</span>
        <span className={`${SMALL} tabular-nums`}>
          {total} {total === 1 ? unit[0] : unit[1]}
        </span>
      </figcaption>
      <div aria-hidden className="mt-2 flex h-3 w-full bg-slate-100">
        {shown.map((slice) => (
          <span
            className={`h-full border-r border-white last:border-r-0 ${slice.swatch}`}
            key={slice.key}
            style={{ width: `${(slice.count / total) * 100}%` }}
          />
        ))}
      </div>
      <ul className="mt-2 grid gap-x-4 gap-y-1 sm:grid-cols-2">
        {shown.map((slice, index) => {
          const body = (
            <>
              <span aria-hidden className={`mt-1 h-2 w-2 shrink-0 ${slice.swatch}`} />
              <span className="min-w-0 flex-1 text-phx-xs leading-4 text-slate-700 sm:text-phx-2xs">{slice.label}</span>
              <span className="shrink-0 text-phx-xs font-black tabular-nums text-slate-900 sm:text-phx-2xs">{slice.count}</span>
              <span className="w-9 shrink-0 text-right text-phx-2xs tabular-nums text-slate-500 sm:text-phx-3xs">
                {percents[index]}%
              </span>
            </>
          );
          return (
            <li key={slice.key}>
              {slice.href ? (
                <Link
                  className="flex items-start gap-2 underline-offset-2 hover:underline hover:decoration-orange-500"
                  href={slice.href}
                >
                  {body}
                </Link>
              ) : (
                <span className="flex items-start gap-2">{body}</span>
              )}
            </li>
          );
        })}
      </ul>
      {note ? <p className={`mt-2 ${SMALL}`}>{note}</p> : null}
    </figure>
  );
}

// ── A flat meter ──────────────────────────────────────────────────────────────────────────────

/** A flat 6px meter. The fill is clamped at 100; the printed figure beside it keeps its real value. */
export function KpiFlatMeter({ band, value }: { band: KpiBand; value: number | null }) {
  const fill = value == null ? 0 : Math.max(0, Math.min(100, value));
  return (
    <span aria-hidden className="mt-1.5 block h-1.5 w-full bg-slate-100">
      <span className={`block h-full ${SWATCH[band]}`} style={{ width: `${fill}%` }} />
    </span>
  );
}

// ── Where the team stands ─────────────────────────────────────────────────────────────────────

/**
 * WHERE THE TEAM STANDS — the planned list as covered against not reached, and the reps as the bands their
 * own coverage chips already show. Both bars add up to the tiles above them: the list bar to the Coverage
 * tile's "353 of 769", the reps bar to the Medical reps in reach tile. Drawn on the Coverage tab only, and
 * only for a board of more than one rep — a rep's own board has nobody to stand among.
 */
export function KpiCoverageStanding({ board }: { board: KpisBoard }) {
  const { totals } = board;
  const notReached = Math.max(0, totals.plannedDoctors - totals.visitedDoctors);
  const bands = kpiCoverageBandMix(board.reps);
  const floor = kpiCoverageFloorCount(board.reps);
  const judged = floor.atFloor + floor.belowFloor;
  return (
    <div className="grid gap-6 px-4 py-5 sm:px-5 lg:grid-cols-2">
      <KpiShareBar
        caption="The planned list"
        note={
          judged > 0
            ? `${floor.atFloor} of ${judged} ${judged === 1 ? "rep clears" : "reps clear"} the ${board.coverageFloorPct}% floor on their own list.`
            : undefined
        }
        slices={[
          { key: "covered", label: "Covered — seen at least once", count: totals.visitedDoctors, swatch: "bg-emerald-600" },
          { key: "not-reached", label: "Not reached yet", count: notReached, swatch: "bg-rose-600" },
        ]}
        unit={["planned doctor", "planned doctors"]}
      />
      <KpiShareBar
        caption="The reps by coverage"
        note="Each rep in the band their own coverage chip shows. A rep who has just started is judged by nothing, and a rep with no plan has nothing to measure."
        slices={bands.map((slice) => ({
          key: slice.key,
          label: slice.label,
          count: slice.count,
          swatch: slice.key === "just-started" ? "bg-slate-400" : SWATCH[slice.band],
        }))}
        unit={["rep", "reps"]}
      />
    </div>
  );
}

/**
 * The Coverage report's extra tiles: what is left to reach, who clears the floor, the off-plan doctors and
 * the doctors not validated yet. Plain figures from the board, drawn in the board's own `KpiTile`. The not-validated
 * tile appears only when the count was read: a failed read prints nothing, never a 0.
 */
export function kpiCoverageExtraTiles(board: KpisBoard): Array<{ key: string; label: string; value: string; caption: string; band?: KpiBand }> {
  const { totals } = board;
  const notReached = Math.max(0, totals.plannedDoctors - totals.visitedDoctors);
  const floor = kpiCoverageFloorCount(board.reps);
  const judged = floor.atFloor + floor.belowFloor;
  const offPlan = board.reps.reduce((sum, row) => sum + (row.justStarted ? 0 : (row.offPlanDoctors ?? 0)), 0);
  const notValidated = kpiNotValidatedTotal(board.reps);
  const tiles: Array<{ key: string; label: string; value: string; caption: string; band?: KpiBand }> = [
    {
      key: "not-reached",
      label: "Not reached yet",
      value: String(notReached),
      caption: `of ${totals.plannedDoctors} planned doctors, nobody has seen them yet`,
      band: notReached === 0 && totals.plannedDoctors > 0 ? "elite" : undefined,
    },
    {
      key: "floor",
      label: `At the ${board.coverageFloorPct}% floor`,
      value: judged > 0 ? `${floor.atFloor} of ${judged}` : "No plan",
      caption: judged > 0 ? "reps with a plan, judged on their own list" : "no rep in view carries a plan to judge",
      band: judged === 0 ? undefined : floor.atFloor === judged ? "elite" : floor.atFloor === 0 ? "behind" : "steady",
    },
    {
      key: "off-plan",
      label: "Off plan",
      value: String(offPlan),
      caption: "doctors seen who are not on the list — real work, outside the percentage",
    },
  ];
  if (notValidated) {
    tiles.push({
      key: "not-validated",
      label: "Not validated yet",
      value: String(notValidated.doctors),
      caption:
        notValidated.doctors === 0
          ? "every planned doctor has a validated live photo"
          : `planned doctors with no validated live photo, across ${notValidated.reps} ${notValidated.reps === 1 ? "rep" : "reps"}`,
    });
  }
  return tiles;
}

// ── The teams side by side ────────────────────────────────────────────────────────────────────

/** One team with its coverage, ready to draw. */
export type KpiTeamWithCoverage = { team: KpiCoverageTeam<KpiRepRow>; coverage: KpiTeamCoverage };

/** Every team's coverage, from the board's own team arithmetic. */
export function kpiTeamsWithCoverage(
  teams: ReadonlyArray<KpiCoverageTeam<KpiRepRow>>,
  rules: KpisBoard["kpiRules"],
): KpiTeamWithCoverage[] {
  return teams.map((team) => ({
    team,
    coverage: kpiTeamCoverage(
      team.members.map((member) => member.row),
      // The board names its rules once scored; until then it is "legacy", the board's own default.
      rules ?? "legacy",
    ),
  }));
}

function teamPct(coverage: KpiTeamCoverage): string {
  return coverage.coveragePct == null ? "No plan" : `${coverage.coveragePct}%`;
}

function repsWord(count: number): string {
  return `${count} ${count === 1 ? "rep" : "reps"}`;
}

/** "3 reps · 1 just started" — the team's head count, with the reps the figure leaves out named. */
function teamHeadCount(coverage: KpiTeamCoverage): string {
  return coverage.justStarted > 0 ? `${repsWord(coverage.reps)} · ${coverage.justStarted} just started` : repsWord(coverage.reps);
}

/**
 * THE TEAMS AT A GLANCE — one line per region and district manager: the team's coverage with its meter,
 * covered of planned, and how many of its reps clear the floor. Drawn for two teams or more; one team is
 * the board itself. A table from `md` (four columns, a colgroup that totals 100%), a list on a phone.
 */
export function KpiTeamCoverageRollup({ floorPct, teams }: { floorPct: number; teams: readonly KpiTeamWithCoverage[] }) {
  if (teams.length < 2) return null;
  return (
    <div className="px-4 py-4 sm:px-5">
      <table className="hidden w-full table-fixed border border-slate-200 md:table">
        <colgroup>
          <col style={{ width: "34%" }} />
          <col style={{ width: "30%" }} />
          <col style={{ width: "18%" }} />
          <col style={{ width: "18%" }} />
        </colgroup>
        <thead className="border-b border-slate-200 bg-slate-50">
          <tr>
            <th className={`px-3 py-2.5 text-left ${EYEBROW}`} scope="col">
              Team
              <span className="mt-0.5 block text-phx-3xs font-bold normal-case tracking-normal text-slate-400">Region · manager</span>
            </th>
            <th className={`px-3 py-2.5 text-left ${EYEBROW}`} scope="col">
              Coverage
              <span className="mt-0.5 block text-phx-3xs font-bold normal-case tracking-normal text-slate-400">Covered ÷ planned</span>
            </th>
            <th className={`px-3 py-2.5 text-right ${EYEBROW}`} scope="col">
              Not reached
              <span className="mt-0.5 block text-phx-3xs font-bold normal-case tracking-normal text-slate-400">Planned, unseen</span>
            </th>
            <th className={`px-3 py-2.5 text-right ${EYEBROW}`} scope="col">
              At the floor
              <span className="mt-0.5 block text-phx-3xs font-bold normal-case tracking-normal text-slate-400">{floorPct}% or more</span>
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {teams.map(({ coverage, team }) => (
            <tr key={team.key}>
              <td className="px-3 py-3 align-top">
                <span className="block text-sm font-bold leading-5 text-slate-900" dir="auto">
                  {team.managerName}
                </span>
                <span className={`block ${SMALL}`} dir="auto">
                  {team.regionName} · {teamHeadCount(coverage)}
                </span>
              </td>
              <td className="px-3 py-3 align-top">
                <span className={`block text-sm font-black tabular-nums ${INK[coverage.band]}`}>{teamPct(coverage)}</span>
                <KpiFlatMeter band={coverage.band} value={coverage.coveragePct} />
                <span className={`mt-1 block tabular-nums ${SMALL}`}>
                  {coverage.covered} of {coverage.planned} planned doctors
                </span>
              </td>
              <td className="px-3 py-3 text-right align-top text-sm font-semibold tabular-nums text-slate-900">
                {coverage.notReached}
              </td>
              <td className="px-3 py-3 text-right align-top text-sm font-semibold tabular-nums text-slate-900">
                {coverage.withPlan > 0 ? `${coverage.atFloor} of ${coverage.withPlan}` : "–"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <ul className="divide-y divide-slate-100 border border-slate-200 md:hidden">
        {teams.map(({ coverage, team }) => (
          <li className="px-3 py-3" key={team.key}>
            <div className="flex items-baseline justify-between gap-3">
              <span className="min-w-0">
                <span className="block text-sm font-bold leading-5 text-slate-900" dir="auto">
                  {team.managerName}
                </span>
                <span className={`block ${SMALL}`} dir="auto">
                  {team.regionName} · {teamHeadCount(coverage)}
                </span>
              </span>
              <span className={`shrink-0 text-base font-black tabular-nums ${INK[coverage.band]}`}>{teamPct(coverage)}</span>
            </div>
            <KpiFlatMeter band={coverage.band} value={coverage.coveragePct} />
            <span className={`mt-1 block tabular-nums ${SMALL}`}>
              {coverage.covered} of {coverage.planned} planned doctors · {coverage.notReached} not reached
              {coverage.withPlan > 0 ? ` · ${coverage.atFloor} of ${coverage.withPlan} at the floor` : ""}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ── A heading per team over the reps ──────────────────────────────────────────────────────────

/**
 * The band a team's heading opens in a table: one cell across every column, the team's name, its head
 * count and its coverage in words. A component, not a raw row in the table's own source, so the table's
 * column count (tests/kpis-board-tables-fit.test.ts) still reads off the rep rows.
 *
 * The cell is a `<th scope="colgroup">`: it HEADS the reps under it, which is what a screen reader should
 * announce over each of them. It is not a panel a row opens (TableRowDetail's business) and not an empty
 * state, the two shapes tests/table-row-detail-joined.test.ts counts.
 */
export function KpiTeamHeadingRow({ columns, entry }: { columns: number; entry: KpiTeamWithCoverage }) {
  return (
    <tr className="border-t-2 border-slate-900 bg-slate-50">
      <th className="px-3 py-2.5 text-left font-normal" colSpan={columns} scope="colgroup">
        <KpiTeamHeadingText entry={entry} />
      </th>
    </tr>
  );
}

/** The same heading over a team's phone cards. */
export function KpiTeamHeadingBand({ entry }: { entry: KpiTeamWithCoverage }) {
  return (
    <div className="border-t-2 border-slate-900 bg-slate-50 px-4 py-2.5">
      <KpiTeamHeadingText entry={entry} />
    </div>
  );
}

function KpiTeamHeadingText({ entry }: { entry: KpiTeamWithCoverage }) {
  const { coverage, team } = entry;
  return (
    <span className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
      <span className="min-w-0">
        <span className="block text-phx-xs font-black uppercase tracking-[0.12em] text-slate-900" dir="auto">
          {kpiTeamHeading(team)}
        </span>
        <span className={`block ${SMALL}`}>{teamHeadCount(coverage)}</span>
      </span>
      <span className="flex items-baseline gap-2">
        <span className={`text-sm font-black tabular-nums ${INK[coverage.band]}`}>{teamPct(coverage)}</span>
        <span className={`tabular-nums ${SMALL}`}>
          {coverage.covered} of {coverage.planned} covered
        </span>
      </span>
    </span>
  );
}

// ── The bricks at a glance ────────────────────────────────────────────────────────────────────

/**
 * THE BRICKS AT A GLANCE, above the team's brick table: how many bricks are fully covered, how many sit in
 * each band, and how many no rep has reached yet — then the bricks nobody has reached by name, and the
 * reached bricks with the most planned doctors still to see. Real bricks only: "Not validated yet" and
 * "no brick on record" are not places a rep can walk into, so they stay in the table and out of this.
 */
export function KpiBrickGlance({ rows }: { rows: readonly KpiBrickRow[] }) {
  const totals = kpiBrickTotals(rows);
  if (totals.bricks === 0) return null;
  const mix = kpiBrickBandMix(rows);
  const untouched = kpiBricksNotReached(rows);
  const mostLeft = kpiBricksMostLeft(rows, 6);
  const largestLeft = mostLeft.reduce((most, row) => Math.max(most, row.left), 0);
  return (
    <div className="grid gap-6 border-b border-slate-100 px-4 py-5 sm:px-5 lg:grid-cols-2">
      <div className="min-w-0 space-y-5">
        <KpiShareBar
          caption="The bricks by coverage"
          note={`${totals.covered} of ${totals.planned} planned doctors seen across ${totals.bricks} ${totals.bricks === 1 ? "brick" : "bricks"} with a validated live photo.`}
          slices={mix.map((slice) => ({
            key: slice.key,
            label: slice.label,
            count: slice.count,
            swatch: slice.key === "full" ? "bg-emerald-800" : slice.key === "untouched" ? "bg-rose-800" : SWATCH[slice.band],
          }))}
          unit={["brick", "bricks"]}
        />
        {untouched.length > 0 ? (
          <div className="min-w-0">
            <p className={EYEBROW}>Not reached yet</p>
            <p className={`mt-0.5 ${SMALL}`}>
              {untouched.length} {untouched.length === 1 ? "brick" : "bricks"} with planned doctors and not one of them seen, the
              largest first.
            </p>
            <ul className="mt-2 flex flex-wrap gap-1.5">
              {untouched.map((row) => (
                <li
                  className="inline-flex items-baseline gap-1.5 border border-rose-200 px-2 py-1 text-phx-2xs text-slate-800"
                  key={row.brick}
                >
                  <span dir="auto">{row.label}</span>
                  <span className="font-black tabular-nums text-rose-700">{row.planned}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
      {mostLeft.length > 0 ? (
        <figure className="min-w-0">
          <figcaption className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
            <span className={EYEBROW}>Most left to see</span>
            <span className={SMALL}>Reached bricks, by planned doctors not seen yet</span>
          </figcaption>
          <ol className="mt-2 space-y-2">
            {mostLeft.map((row) => {
              const pct = kpiBrickCoveragePct(row);
              return (
                <li className="min-w-0" key={row.brick}>
                  <span className="flex items-baseline justify-between gap-3">
                    <span className="min-w-0 text-phx-xs font-semibold leading-4 text-slate-800 sm:text-phx-2xs" dir="auto">
                      {row.label}
                    </span>
                    <span className="shrink-0 text-phx-xs tabular-nums text-slate-500 sm:text-phx-2xs">
                      <span className="font-black text-slate-900">{row.left}</span> left · {row.covered} of {row.planned}
                      {pct == null ? "" : ` · ${pct}%`}
                    </span>
                  </span>
                  <span aria-hidden className="mt-1 block h-2 w-full bg-slate-100">
                    <span className="block h-full bg-rose-600" style={{ width: `${kpiMeterWidth(row.left, largestLeft)}%` }} />
                  </span>
                </li>
              );
            })}
          </ol>
        </figure>
      ) : null}
    </div>
  );
}
