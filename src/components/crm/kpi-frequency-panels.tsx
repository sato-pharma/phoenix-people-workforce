/**
 * THE FREQUENCY REPORT'S PANELS — the premium pass of 9 November 2026 (owner: "eyeball every report in My
 * Team's Reports, premium polish big work, every single component", then "group reps by district manager").
 *
 * What the pass found on the Frequency page, read as the Regional Sales Manager for three regions:
 *
 * - one Frequency tile in a row built for six, then one podium card, so the top of the page was mostly white;
 * - every rep in one flat list with nothing saying which district manager he reports to — the question a
 *   regional manager opens the page to answer — while the Coverage page next door already grouped them;
 * - nothing that said how the team's judged doctors split between the pass and the rest, or which team
 *   carries the most doctors off target.
 *
 * So this file draws, from the board's own figures (crm/kpi-frequency-teams.ts adds no measure, and holds the
 * extra tiles beside the Frequency tile as plain data): where the team stands, the teams side by side, and a
 * heading per team over the reps. The share bar and the flat meter are the Coverage page's own (kpi-coverage-panels.tsx), so the
 * two pages wear one kit.
 *
 * ## The finish (owner, 22 Oct 2026: nothing may look machine-made)
 *
 * Flat colour only: no gradient, no glow, no drop shadow, square corners. Colour carries a status in one place
 * per part and is never a fill behind a block. Every figure is tabular. Nothing sets a min-width, nothing
 * scrolls sideways and nothing is cut with an ellipsis: a long name wraps.
 *
 * ## NO "use client"
 *
 * Pure markup with no handlers, so the board stays a server component (tests/rsc-client-function-props.test.ts).
 *
 * ## text-phx-* never goes through cn()
 *
 * tailwind-merge strips custom named font sizes, so every class string here is a plain template literal.
 */

import { KpiFlatMeter, KpiShareBar, kpiInkOf, kpiSwatchOf } from "@/components/crm/kpi-coverage-panels";
import { kpiTeamHeading } from "@/lib/crm/kpi-coverage-teams";
import {
  kpiFrequencyBandMix,
  kpiFrequencyDoctorMix,
  kpiFrequencyHeadCount,
  kpiFrequencyOffTarget,
  kpiFrequencyPctText,
  kpiFrequencyTeamsSentence,
  kpiTeamFrequency,
  type KpiTeamWithFrequency,
} from "@/lib/crm/kpi-frequency-teams";
import type { KpisBoard } from "@/lib/crm/kpis-board";

const EYEBROW = "text-phx-sm font-black uppercase tracking-[0.14em] text-slate-500 sm:text-phx-xs";
const SMALL = "text-phx-sm leading-4 text-slate-500 sm:text-phx-xs";

/** The swatch each slice of the judged list is drawn in: the pass green, the deviations in two warm tones. */
const DOCTOR_SWATCH: Record<string, string> = {
  met: "bg-emerald-600",
  below: "bg-rose-600",
  above: "bg-amber-500",
  rest: "bg-slate-300",
  ungraded: "bg-slate-200",
};

function isPhoenixBoard(board: Pick<KpisBoard, "kpiRules">): boolean {
  return board.kpiRules === "phoenix";
}

/** The whole board's frequency, from the same arithmetic as each team's — the teams add up to it. */
function boardFrequency(board: KpisBoard) {
  return kpiTeamFrequency(board.reps, board.kpiRules ?? "legacy");
}

// ── Where the team stands ────────────────────────────────────────────────────────────────────

/**
 * WHERE THE TEAM STANDS ON FREQUENCY — the judged doctors as the pass against everything else, in the rules'
 * own words, and the reps as the bands their own frequency chips already show. The doctors bar adds up to the
 * Frequency tile's denominator (the ungraded slice, Phoenix only, is marked as outside it); the reps bar adds
 * up to the Medical reps in reach tile. Drawn for a board of more than one rep.
 */
export function KpiFrequencyStanding({ board }: { board: KpisBoard }) {
  const phoenix = isPhoenixBoard(board);
  const team = boardFrequency(board);
  const mix = kpiFrequencyDoctorMix(team, board.kpiRules);
  const bands = kpiFrequencyBandMix(board.reps);
  const off = kpiFrequencyOffTarget(team);
  return (
    <div className="grid gap-6 px-4 py-5 sm:px-5 lg:grid-cols-2">
      <KpiShareBar
        caption={phoenix ? "The graded doctors" : "The planned doctors"}
        note={
          team.judged > 0
            ? `${team.met} of ${team.judged} ${phoenix ? "graded doctors at their norm" : "planned doctors visited exactly as planned"}; ${off} off target.${
                phoenix && team.ungraded > 0 ? ` ${team.ungraded} ungraded doctors are on the lists and outside the percentage.` : ""
              }`
            : undefined
        }
        slices={mix.map((slice) => ({
          key: slice.key,
          label: slice.label,
          count: slice.count,
          swatch: DOCTOR_SWATCH[slice.key] ?? "bg-slate-300",
        }))}
        unit={phoenix ? ["doctor", "doctors"] : ["planned doctor", "planned doctors"]}
      />
      <KpiShareBar
        caption="The reps by frequency"
        note="Each rep in the band their own frequency chip shows. A rep who has just started is judged by nothing, and a rep with no plan has nothing to measure."
        slices={bands.map((slice) => ({
          key: slice.key,
          label: slice.label,
          count: slice.count,
          swatch: slice.key === "just-started" ? "bg-slate-400" : kpiSwatchOf(slice.band),
        }))}
        unit={["rep", "reps"]}
      />
    </div>
  );
}

// ── The teams side by side ───────────────────────────────────────────────────────────────────

/** "12 below · 3 above", or "12 below" under the Phoenix rules, or "None" — the off-target cell in words. */
function offTargetWords(team: KpiTeamWithFrequency["frequency"], phoenix: boolean): string {
  if (kpiFrequencyOffTarget(team) === 0) return "None";
  if (phoenix || team.above === 0) return `${team.below} below`;
  if (team.below === 0) return `${team.above} above`;
  return `${team.below} below · ${team.above} above`;
}

/**
 * THE TEAMS AT A GLANCE — one line per region and district manager: the team's frequency with its meter, the
 * pass of the judged doctors, the doctors off target and the reps whose own chip reads 90% or more. Drawn for
 * two teams or more; one team is the board itself. A table from `md` (four columns, a colgroup that totals
 * 100%), a list on a phone. The sentence under it names the team with the most doctors off target.
 */
export function KpiTeamFrequencyRollup({ phoenix, teams }: { phoenix: boolean; teams: readonly KpiTeamWithFrequency[] }) {
  if (teams.length < 2) return null;
  const sentence = kpiFrequencyTeamsSentence(teams);
  const passWord = phoenix ? "at norm" : "exact";
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
              <span className="mt-0.5 block text-phx-xs font-bold normal-case tracking-normal text-slate-400">Region · manager</span>
            </th>
            <th className={`px-3 py-2.5 text-left ${EYEBROW}`} scope="col">
              Frequency
              <span className="mt-0.5 block text-phx-xs font-bold normal-case tracking-normal text-slate-400">
                {phoenix ? "At norm ÷ graded" : "Exact ÷ planned"}
              </span>
            </th>
            <th className={`px-3 py-2.5 text-right ${EYEBROW}`} scope="col">
              Off target
              <span className="mt-0.5 block text-phx-xs font-bold normal-case tracking-normal text-slate-400">
                {phoenix ? "Below the norm" : "Below or above"}
              </span>
            </th>
            <th className={`px-3 py-2.5 text-right ${EYEBROW}`} scope="col">
              Reps at 90%+
              <span className="mt-0.5 block text-phx-xs font-bold normal-case tracking-normal text-slate-400">Of those with a plan</span>
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {teams.map(({ frequency, team }) => (
            <tr key={team.key}>
              <td className="px-3 py-3 align-top">
                <span className="block text-sm font-bold leading-5 text-slate-900" dir="auto">
                  {team.managerName}
                </span>
                <span className={`block ${SMALL}`} dir="auto">
                  {team.regionName} · {kpiFrequencyHeadCount(frequency)}
                </span>
              </td>
              <td className="px-3 py-3 align-top">
                <span className={`block text-sm font-black tabular-nums ${kpiInkOf(frequency.band)}`}>{kpiFrequencyPctText(frequency)}</span>
                <KpiFlatMeter band={frequency.band} value={frequency.frequencyPct} />
                <span className={`mt-1 block tabular-nums ${SMALL}`}>
                  {frequency.met} of {frequency.judged} {passWord}
                </span>
              </td>
              <td className="px-3 py-3 text-right align-top text-sm font-semibold tabular-nums text-slate-900">
                {offTargetWords(frequency, phoenix)}
              </td>
              <td className="px-3 py-3 text-right align-top text-sm font-semibold tabular-nums text-slate-900">
                {frequency.withPlan > 0 ? `${frequency.topBand} of ${frequency.withPlan}` : "–"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <ul className="divide-y divide-slate-100 border border-slate-200 md:hidden">
        {teams.map(({ frequency, team }) => (
          <li className="px-3 py-3" key={team.key}>
            <div className="flex items-baseline justify-between gap-3">
              <span className="min-w-0">
                <span className="block text-sm font-bold leading-5 text-slate-900" dir="auto">
                  {team.managerName}
                </span>
                <span className={`block ${SMALL}`} dir="auto">
                  {team.regionName} · {kpiFrequencyHeadCount(frequency)}
                </span>
              </span>
              <span className={`shrink-0 text-base font-black tabular-nums ${kpiInkOf(frequency.band)}`}>
                {kpiFrequencyPctText(frequency)}
              </span>
            </div>
            <KpiFlatMeter band={frequency.band} value={frequency.frequencyPct} />
            <span className={`mt-1 block tabular-nums ${SMALL}`}>
              {frequency.met} of {frequency.judged} {passWord} · off target {offTargetWords(frequency, phoenix)}
              {frequency.withPlan > 0 ? ` · ${frequency.topBand} of ${frequency.withPlan} reps at 90%+` : ""}
            </span>
          </li>
        ))}
      </ul>
      {sentence ? <p className={`mt-3 ${SMALL}`}>{sentence}</p> : null}
    </div>
  );
}

// ── A heading per team over the reps ─────────────────────────────────────────────────────────

/**
 * The band a team's heading opens in the Frequency table: one cell across every column, the team's name, its
 * head count and its frequency in words. A component, not a raw row in the table's own source, so the table's
 * column count (tests/kpis-board-tables-fit.test.ts) still reads off the rep rows. A `<th scope="colgroup">`:
 * it heads the reps under it.
 */
export function KpiFrequencyTeamHeadingRow({ columns, entry, phoenix }: { columns: number; entry: KpiTeamWithFrequency; phoenix: boolean }) {
  return (
    <tr className="border-t-2 border-slate-900 bg-slate-50">
      <th className="px-3 py-2.5 text-left font-normal" colSpan={columns} scope="colgroup">
        <KpiFrequencyTeamHeadingText entry={entry} phoenix={phoenix} />
      </th>
    </tr>
  );
}

/** The same heading over a team's phone cards. */
export function KpiFrequencyTeamHeadingBand({ entry, phoenix }: { entry: KpiTeamWithFrequency; phoenix: boolean }) {
  return (
    <div className="border-t-2 border-slate-900 bg-slate-50 px-4 py-2.5">
      <KpiFrequencyTeamHeadingText entry={entry} phoenix={phoenix} />
    </div>
  );
}

function KpiFrequencyTeamHeadingText({ entry, phoenix }: { entry: KpiTeamWithFrequency; phoenix: boolean }) {
  const { frequency, team } = entry;
  return (
    <span className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
      <span className="min-w-0">
        <span className="block text-phx-md font-black uppercase tracking-[0.12em] text-slate-900" dir="auto">
          {kpiTeamHeading(team)}
        </span>
        <span className={`block ${SMALL}`}>{kpiFrequencyHeadCount(frequency)}</span>
      </span>
      <span className="flex items-baseline gap-2">
        <span className={`text-sm font-black tabular-nums ${kpiInkOf(frequency.band)}`}>{kpiFrequencyPctText(frequency)}</span>
        <span className={`tabular-nums ${SMALL}`}>
          {frequency.met} of {frequency.judged} {phoenix ? "at norm" : "exact"}
        </span>
      </span>
    </span>
  );
}
