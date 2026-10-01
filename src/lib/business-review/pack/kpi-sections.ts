// The Sales Review pack — the CRM's own KPIs: coverage and frequency against the plan, and the call
// rate.
//
// Owner, 2026-10-01, asked whether the pack should carry them: "add all three", per rep, per month.
//
// WORDS ONLY. Every figure is a row the CRM KPIs board printed for that rep and month, or
// `kpiTeamFigures` — the board's own team arithmetic — over such rows (sources/crm-kpis.ts). Nothing
// here computes a rate or a percentage of its own, so the pack can never disagree with the board.
//
// THE OWNER'S RULES THIS SECTION CARRIES, each already decided and none of them re-opened here:
//  * AM against 2 a day and PM against 10 — two figures in two places, never averaged and never
//    joined by a slash (he read "1.63 / 6.57" as one number over another). Pharmacies are a third
//    figure with no target, because he has set none.
//  * Coverage = doctors on the plan visited at least once. The floor is 95%.
//  * Frequency = doctors visited EXACTLY as often as the plan asked. More often is a deviation too,
//    never a bonus, so "more often than planned" is shown on its own and never on the good side.
//  * No plan is not 0%: "No plan". Nothing logged is not a rate of zero: "No calls". A rep whose CRM
//    account sent no GPS check-in reads "No GPS feed" (ruling A1) and is out of the team's call rate.
//
// NAMES, NEVER CODES OR IDS. A leaver keeps his rows and his "(left …)" mark.

import { AM_CALL_RATE_TARGET, PM_CALL_RATE_TARGET } from "@/lib/crm/call-rate";
import type { KpiRepRow } from "@/lib/crm/kpis-board";
import { COVERAGE_TARGET_FLOOR_PCT } from "@/lib/crm/kpis-filters";
import { canonicalHrIdKey } from "@/lib/hr-id";

import { isResignedStatus, leaverLabel } from "../employment-status";
import { periodColumnLabel, periodLabel } from "../period-format";
import type { ReviewKpiMonth, ReviewKpiTeam } from "../sources/crm-kpis";
import type { ReviewPersonRow } from "../sources/roles";
import type { PackAlign, PackCell, PackChart, PackInput, PackSection } from "./model";

const rate = (value: number | null) => (value == null ? "—" : value.toFixed(1));
const count = (value: number) => value.toLocaleString("en-US");
const plural = (value: number, one: string, many: string) => `${count(value)} ${value === 1 ? one : many}`;

type Lane = "am" | "pm" | "pharmacy";

function laneRate(figures: { amRate: number | null; pmRate: number | null; pharmacyRate: number | null }, lane: Lane) {
  return lane === "am" ? figures.amRate : lane === "pm" ? figures.pmRate : figures.pharmacyRate;
}

/** One rep's call rate in one lane, saying WHY when there is no number. */
export function repRateCell(row: KpiRepRow, lane: Lane): string {
  if (row.noGpsFeed) return "No GPS feed";
  if (!row.hasCallRate) return "No calls";
  return rate(laneRate(row, lane));
}

/** A team's call rate in one lane — the board's average-rep rate, never a sum of rates. */
export function teamRateCell(team: ReviewKpiTeam, lane: Lane): string {
  if (team.reps === 0) return "—";
  if (team.noGpsFeedReps === team.reps) return "No GPS feed";
  return rate(laneRate(team, lane));
}

const coverageCell = (row: KpiRepRow) =>
  row.hasMeasurablePlan ? `${count(row.visitedDoctors)} of ${count(row.plannedDoctors)} (${row.coveragePct}%)` : "No plan";
const frequencyCell = (row: KpiRepRow) => (row.hasMeasurablePlan ? `${row.frequencyPct}%` : "No plan");
const teamCoverageCell = (team: ReviewKpiTeam) =>
  team.plannedDoctors > 0 ? `${count(team.visitedDoctors)} of ${count(team.plannedDoctors)} (${team.coveragePct}%)` : "No plan";
const teamFrequencyCell = (team: ReviewKpiTeam) => (team.plannedDoctors > 0 ? `${team.frequencyPct}%` : "No plan");

/** The months the board answered, oldest first. */
function readMonths(months: readonly ReviewKpiMonth[]): ReviewKpiMonth[] {
  return months.filter((month) => !month.unread);
}

/** What every version of the section says about how the figures were made, in its reader's voice. */
function basisNote(months: readonly ReviewKpiMonth[], isRep: boolean): string {
  const parts: string[] = [];
  const phoenix = months.some((month) => month.rules === "phoenix");
  const legacy = months.some((month) => month.rules === "legacy" && !month.unread);
  if (legacy) {
    parts.push(
      isRep
        ? "A visit counts in your call rate when the CRM holds a GPS check-in at that customer the same day; the rate is those visits over the month's working days, holidays out."
        : "The call rate counts the regular visits the CRM can prove with a same-day GPS check-in at that customer, over the month's working days with holidays out — the KPIs board's own rule before the switch to Phoenix CRM.",
    );
  }
  if (phoenix) {
    parts.push(
      "From the switch to Phoenix CRM every submitted visit counts, and frequency is judged over the graded doctors on the plan.",
    );
  }
  const noCalendar = months.filter((month) => !month.unread && !month.holidaysComplete);
  if (noCalendar.length > 0) {
    parts.push(
      `The holiday calendar could not be read for ${noCalendar.map((month) => periodLabel(month.month)).join(", ")}, so ${noCalendar.length === 1 ? "its" : "their"} call rates may read low.`,
    );
  }
  const unread = months.filter((month) => month.unread);
  if (unread.length > 0) {
    parts.push(
      `The KPIs board could not be read for ${unread.map((month) => periodLabel(month.month)).join(", ")} — ${unread.length === 1 ? "that month is" : "those months are"} left empty, never read as zero.`,
    );
  }
  return parts.join(" ");
}

function personNamer(people: readonly ReviewPersonRow[]) {
  const byKey = new Map<string, ReviewPersonRow>();
  for (const person of people) {
    const key = canonicalHrIdKey(person.hrId);
    if (key) byKey.set(key, person);
  }
  return (row: KpiRepRow): string => {
    const person = byKey.get(canonicalHrIdKey(row.agentHrId) ?? "");
    if (person) return isResignedStatus(person.employmentStatus) ? leaverLabel(person.name, person.lastWorkingDate) : person.name;
    return row.repName?.trim() || "Unnamed employee";
  };
}

/** Each bar is one coverage figure of the last month the board answered, with the 95% floor across. */
function coverageChart(items: { label: string; note: string | null; value: number }[], monthLabel: string): PackChart | null {
  if (items.length < 2) return null;
  const plotted = items.slice(0, 12);
  return {
    capNote:
      items.length > plotted.length
        ? `The ${plotted.length} lowest of ${items.length} in ${monthLabel} — the table holds every one.`
        : null,
    items: plotted,
    kind: "bars",
    reference: { label: `${COVERAGE_TARGET_FLOOR_PCT}% floor`, value: COVERAGE_TARGET_FLOOR_PCT },
    unit: "pct",
  };
}

// ─────────────────────────────────────────────────────────────── the section ──

export function crmKpiSection(input: PackInput): PackSection | null {
  const months = input.crmKpis ?? null;
  if (!months || months.length === 0) return null;
  const answered = readMonths(months);
  if (answered.every((month) => month.rows.length === 0) && months.every((month) => !month.unread)) return null;
  const level = input.subject.level;
  if (level === "rep") return repSection(months);
  if (level === "district") return districtSection(input, months);
  return teamsSection(months);
}

/**
 * A medical rep's own: one column per month, one plain line per measure — the shape of his landing
 * tile, which he already reads, with the months side by side.
 */
function repSection(months: readonly ReviewKpiMonth[]): PackSection | null {
  const own = months.map((month) => (month.unread ? null : month.rows[0] ?? null));
  if (own.every((row) => row == null) && months.every((month) => !month.unread)) return null;
  const labels = months.map((month) => month.month);
  const cell = (row: KpiRepRow | null, month: ReviewKpiMonth, value: (row: KpiRepRow) => PackCell): PackCell =>
    month.unread ? "Could not be read" : row ? value(row) : "Not on the board";
  const line = (measure: string, value: (row: KpiRepRow) => PackCell): PackCell[] => [
    measure,
    ...months.map((month, i) => cell(own[i], month, value)),
  ];
  const planOnly = (value: (row: KpiRepRow) => PackCell) => (row: KpiRepRow) => (row.hasMeasurablePlan ? value(row) : "No plan");
  return {
    align: ["left", ...months.map((): PackAlign => "right")],
    columns: ["", ...labels.map((month) => periodColumnLabel(month, labels))],
    metric: "crm-kpis",
    note: `Coverage is the doctors on your plan you visited at least once — the floor is ${COVERAGE_TARGET_FLOOR_PCT}%. Frequency is the doctors you visited exactly as often as your plan asked; visiting more often than planned is off the plan too. Only regular visits count in either. ${basisNote(months, true)}`.trim(),
    rows: [
      line("Doctors on your plan", planOnly((row) => count(row.plannedDoctors))),
      line("Visited at least once (coverage)", (row) => coverageCell(row)),
      line("Visited exactly as planned (frequency)", planOnly((row) => `${count(row.onPlanDoctors)} (${row.frequencyPct}%)`)),
      line("Visited more often than planned", planOnly((row) => count(row.overDoctors))),
      line("Visited, but less often than planned", planOnly((row) => count(row.underDoctors))),
      line("Not visited", planOnly((row) => count(row.missedDoctors))),
      line(`AM visits a day (target ${AM_CALL_RATE_TARGET})`, (row) => repRateCell(row, "am")),
      line(`PM visits a day (target ${PM_CALL_RATE_TARGET})`, (row) => repRateCell(row, "pm")),
      line("Pharmacy visits a day", (row) => repRateCell(row, "pharmacy")),
    ],
    title: "Your plan and your calls",
    weights: [3, ...months.map(() => 2)],
  };
}

/** A district: every rep, month by month, and the team under them. */
function districtSection(input: PackInput, months: readonly ReviewKpiMonth[]): PackSection | null {
  const nameOf = personNamer(input.people);
  const withMonth = months.length > 1;
  const labels = months.map((month) => month.month);
  const rows: PackCell[][] = [];
  type Entry = { month: ReviewKpiMonth; row: KpiRepRow };
  const byRep = new Map<string, Entry[]>();
  for (const month of months) {
    for (const row of month.rows) {
      const key = canonicalHrIdKey(row.agentHrId) ?? row.repName;
      byRep.set(key, [...(byRep.get(key) ?? []), { month, row }]);
    }
  }
  const reps = [...byRep.values()].sort(
    (a, b) =>
      (a[0].row.areaName ?? "").localeCompare(b[0].row.areaName ?? "") ||
      nameOf(a[0].row).localeCompare(nameOf(b[0].row)),
  );
  for (const entries of reps) {
    for (const { month, row } of entries) {
      rows.push([
        nameOf(row),
        ...(withMonth ? [periodColumnLabel(month.month, labels)] : []),
        coverageCell(row),
        frequencyCell(row),
        row.hasMeasurablePlan ? count(row.overDoctors) : "No plan",
        repRateCell(row, "am"),
        repRateCell(row, "pm"),
        repRateCell(row, "pharmacy"),
      ]);
    }
  }
  if (rows.length === 0 && months.every((month) => !month.unread)) return null;
  for (const month of months) {
    if (month.unread) {
      rows.push(["The team", ...(withMonth ? [periodColumnLabel(month.month, labels)] : []), "Could not be read", "—", "—", "—", "—", "—"]);
      continue;
    }
    if (month.rows.length < 2) continue;
    rows.push([
      "The team",
      ...(withMonth ? [periodColumnLabel(month.month, labels)] : []),
      teamCoverageCell(month.team),
      teamFrequencyCell(month.team),
      count(month.rows.reduce((sum, row) => sum + row.overDoctors, 0)),
      teamRateCell(month.team, "am"),
      teamRateCell(month.team, "pm"),
      teamRateCell(month.team, "pharmacy"),
    ]);
  }

  const last = [...months].reverse().find((month) => !month.unread && month.rows.length > 0) ?? null;
  const chart = last
    ? coverageChart(
        last.rows
          .filter((row) => row.hasMeasurablePlan)
          .sort((a, b) => a.coveragePct - b.coveragePct)
          .map((row) => ({ label: nameOf(row), note: row.areaName ?? null, value: row.coveragePct })),
        periodLabel(last.month),
      )
    : null;
  const noFeed = last ? last.team.noGpsFeedReps : 0;
  return {
    align: ["left", ...(withMonth ? (["left"] as PackAlign[]) : []), "right", "right", "right", "right", "right", "right"],
    chart,
    columns: [
      "Rep",
      ...(withMonth ? ["Month"] : []),
      "Coverage",
      "Frequency",
      "More often than planned",
      `AM a day (target ${AM_CALL_RATE_TARGET})`,
      `PM a day (target ${PM_CALL_RATE_TARGET})`,
      "Pharmacies a day",
    ],
    metric: "crm-kpis",
    note: [
      `Each rep against his OWN plan, from the CRM KPIs board. Coverage = planned doctors visited at least once (the floor is ${COVERAGE_TARGET_FLOOR_PCT}%). Frequency = planned doctors visited exactly as often as planned; more often than planned is a deviation too, counted beside it. AM and PM are each scored against their own target and never averaged. "The team" is the average rep: its calls over its rep-days.${chart && last ? ` The chart is each rep's coverage in ${periodLabel(last.month)}, lowest first, with the floor drawn across.` : ""}`,
      noFeed > 0
        ? `${plural(noFeed, "rep reads", "reps read")} "No GPS feed": the CRM received no GPS check-in from ${noFeed === 1 ? "his account" : "their accounts"}, so ${noFeed === 1 ? "he is" : "they are"} out of the team's call rate and still in its coverage and frequency.`
        : "",
      basisNote(months, false),
    ]
      .filter(Boolean)
      .join(" "),
    rows,
    title: "Coverage, frequency and call rate, rep by rep",
  };
}

/** A line or the company: each manager's team, month by month, and everyone together. */
function teamsSection(months: readonly ReviewKpiMonth[]): PackSection | null {
  const withMonth = months.length > 1;
  const labels = months.map((month) => month.month);
  const monthCells = (month: ReviewKpiMonth) => (withMonth ? [periodColumnLabel(month.month, labels)] : []);
  const teamCells = (team: ReviewKpiTeam): PackCell[] => [
    count(team.reps),
    teamCoverageCell(team),
    teamFrequencyCell(team),
    teamRateCell(team, "am"),
    teamRateCell(team, "pm"),
    teamRateCell(team, "pharmacy"),
  ];
  const managers = [...new Set(months.flatMap((month) => month.teams.map((team) => team.managerName)))];
  const rows: PackCell[][] = [];
  for (const manager of managers) {
    for (const month of months) {
      const team = month.teams.find((entry) => entry.managerName === manager);
      if (team) rows.push([manager, ...monthCells(month), ...teamCells(team.figures)]);
    }
  }
  if (rows.length === 0 && months.every((month) => !month.unread)) return null;
  for (const month of months) {
    if (month.unread) {
      rows.push(["Everyone", ...monthCells(month), "—", "Could not be read", "—", "—", "—", "—"]);
    } else if (month.teams.length > 1) {
      rows.push(["Everyone", ...monthCells(month), ...teamCells(month.team)]);
    }
  }
  const last = [...months].reverse().find((month) => !month.unread && month.rows.length > 0) ?? null;
  const chart = last
    ? coverageChart(
        last.teams
          .filter((team) => team.figures.plannedDoctors > 0)
          .sort((a, b) => a.figures.coveragePct - b.figures.coveragePct)
          .map((team) => ({ label: team.managerName, note: null, value: team.figures.coveragePct })),
        periodLabel(last.month),
      )
    : null;
  const underFloor = last
    ? last.rows.filter((row) => row.hasMeasurablePlan && row.meetsCoverageFloor === false).length
    : 0;
  const scored = last ? last.rows.filter((row) => row.hasMeasurablePlan).length : 0;
  return {
    align: ["left", ...(withMonth ? (["left"] as PackAlign[]) : []), "right", "right", "right", "right", "right", "right"],
    chart,
    columns: [
      "Manager",
      ...(withMonth ? ["Month"] : []),
      "Reps",
      "Coverage",
      "Frequency",
      `AM a day (target ${AM_CALL_RATE_TARGET})`,
      `PM a day (target ${PM_CALL_RATE_TARGET})`,
      "Pharmacies a day",
    ],
    metric: "crm-kpis",
    note: [
      `Each team is the reps the employee directory puts under that manager, scored against their OWN plans on the CRM KPIs board. Coverage = planned doctors visited at least once (the floor is ${COVERAGE_TARGET_FLOOR_PCT}%); frequency = planned doctors visited exactly as often as planned. The call rate is the average rep's — the team's calls over its rep-days — with AM and PM each against its own target, never averaged.${chart && last ? ` The chart is each team's coverage in ${periodLabel(last.month)}, lowest first, with the floor drawn across.` : ""}`,
      last && scored > 0
        ? `In ${periodLabel(last.month)}, ${plural(underFloor, "rep was", "reps were")} under the ${COVERAGE_TARGET_FLOOR_PCT}% floor, of ${count(scored)} with a plan.`
        : "",
      basisNote(months, false),
    ]
      .filter(Boolean)
      .join(" "),
    rows,
    title: "Coverage, frequency and call rate, team by team",
  };
}

// ─────────────────────────────────────────────────────────────── the one-page summary ──

/**
 * The summary's lines about the plan and the calls — the LAST month the board answered, because a
 * plan is a month's and the board never scores two months as one. Every sentence starts in English
 * (the summary's own rule: a cell opening on an Arabic name is laid out right to left).
 */
export function kpiSummaryRows(input: PackInput): PackCell[][] {
  const months = input.crmKpis ?? null;
  if (!months) return [];
  const last = [...months].reverse().find((month) => !month.unread && month.rows.length > 0) ?? null;
  if (!last) return [];
  const when = periodLabel(last.month);
  const rows: PackCell[][] = [];

  if (input.subject.level === "rep") {
    const row = last.rows[0];
    rows.push([
      "Your plan",
      row.hasMeasurablePlan
        ? `In ${when} you visited ${count(row.visitedDoctors)} of the ${count(row.plannedDoctors)} doctors on your plan (${row.coveragePct}%, against the ${COVERAGE_TARGET_FLOOR_PCT}% floor), and ${row.frequencyPct}% of them got exactly the visits planned.`
        : `In ${when} the KPIs board holds no plan for you.`,
    ]);
    rows.push([
      "Your calls",
      row.noGpsFeed
        ? `In ${when} your CRM account sent no GPS check-in, so the KPIs board shows no call rate for you.`
        : row.hasCallRate
          ? `In ${when} you made ${rate(row.amRate)} AM visits a day against a target of ${AM_CALL_RATE_TARGET}, and ${rate(row.pmRate)} PM visits a day against ${PM_CALL_RATE_TARGET}; pharmacies ${rate(row.pharmacyRate)} a day.`
          : `In ${when} the KPIs board holds no calls for you.`,
    ]);
    return rows;
  }

  const team = last.team;
  const scored = last.rows.filter((row) => row.hasMeasurablePlan);
  const atFloor = scored.filter((row) => row.meetsCoverageFloor === true).length;
  if (team.plannedDoctors > 0) {
    rows.push([
      "Plan",
      `In ${when} the team visited ${team.coveragePct}% of the doctors on its plans (the floor is ${COVERAGE_TARGET_FLOOR_PCT}%) and ${team.frequencyPct}% exactly as often as planned; ${count(atFloor)} of ${plural(scored.length, "rep", "reps")} reached the floor.`,
    ]);
  }
  if (team.reps > team.noGpsFeedReps && team.amRate != null && team.pmRate != null) {
    rows.push([
      "Call rate",
      `In ${when} the average rep made ${rate(team.amRate)} AM visits a day against a target of ${AM_CALL_RATE_TARGET}, and ${rate(team.pmRate)} PM visits a day against ${PM_CALL_RATE_TARGET}.`,
    ]);
  }
  return rows;
}
