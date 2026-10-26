// ─────────────────────────────────────────────────────────────────────────────
// KPIs — THE MANAGER ROWS. Owner, 2026-10-20, answering in chat: "add manager row and every dm
// kpis is calculated based on his reps averag and nsm based on dsms av and so on".
//
// The rep rows stay what they have been since 2026-09-03: medical reps only (crm/medical-rep.ts),
// because a manager carries no doctor plan of his own and his OWN visits would score "No plan" on
// two of the three measures. A manager is therefore never a rep row. He is a row of a different
// kind, built here, from the rep rows the board has already finished:
//
//   - A DISTRICT MANAGER's row is the simple average of HIS medical reps' rows — the reps whose
//     directory record names him as their manager.
//   - EVERY MANAGER ABOVE averages the rows DIRECTLY beneath him: a Regional Sales Manager his
//     District Managers, a National Sales Manager the District and Regional Managers who report to
//     him directly — never all the reps at the bottom of his tree. A manager with both (a rep in a
//     vacant district reporting straight to him, say) averages both kinds of row, each row once.
//
// EVERY MEASURE IS AVERAGED ON ITS OWN. AM attainment and PM attainment are two averages, never one
// (the owner's ban of 2026-09-04: "this two and this ten. Don't never get average"), and so are
// coverage, frequency, every rate and the overall score each rep row already carries. A row with
// nothing to measure on a measure — "No plan", "No calls", "No GPS feed", "Not scored yet" — is LEFT
// OUT of that measure's average rather than counted as a zero; when no row beneath him has a value,
// the manager has none either. Nothing here forms a score the rep rows do not already carry: no
// blend, no rank, no fourth KPI (see the header of crm/kpis-filters.ts).
//
// ROUNDED THE WAY THE ROWS PRINT. Percentages are whole numbers and rates two decimals, exactly as
// the board prints them, and a manager above averages the rows beneath him AS PRINTED — so anybody
// can average the District Manager figures on the screen by hand and land on the National Sales
// Manager's.
//
// SCOPE. Built only from the rep rows handed in, which are the rows the viewer's scope already let
// through, so a manager row can never carry a rep the viewer may not see. And the caller's `canSee`
// decides which managers get a row at all: the board passes the downward rule (owner, 2026-09-04:
// "you see yourself and your scope down"), so nobody is shown a row for his own manager — a row that
// would anyway average only the part of that manager's team the viewer can reach.
//
// PURE — no IO, no server import — so it is tested with fixtures (tests/kpis-filters.test.ts).
// ─────────────────────────────────────────────────────────────────────────────

import { kpiIndexOf } from "@/lib/crm/kpi-index";
import type { KpiDirectoryEntry, KpiRepRow } from "@/lib/crm/kpis-board";
import { canonicalHrIdKey, normalizeHrIdForAccess } from "@/lib/hr-id";

/** Where a manager sits, read from his job title. "other" is a title the ladder does not name. */
export type KpiManagerLevel = "national" | "regional" | "district" | "other";

export const KPI_MANAGER_LEVEL_LABEL: Record<KpiManagerLevel, string> = {
  national: "National manager",
  regional: "Regional manager",
  district: "District manager",
  other: "Manager",
};

/** The level a job title names. Both vocabularies (app role and HR title) say the same word. */
export function kpiManagerLevelOf(jobTitle: string | null | undefined): KpiManagerLevel {
  const title = (jobTitle ?? "").trim().toLowerCase();
  if (/\bnational\b/.test(title)) return "national";
  if (/\bregional\b/.test(title)) return "regional";
  if (/\bdistrict\b/.test(title)) return "district";
  return "other";
}

/**
 * Every figure a manager row carries, each one the average of the same figure on the rows beneath
 * him. AM and PM are separate entries, and there is no entry that combines them.
 */
export const KPI_MANAGER_MEASURES = [
  "coveragePct",
  "frequencyPct",
  "amAttainmentPct",
  "pmAttainmentPct",
  "amRate",
  "pmRate",
  "pharmacyRate",
  "amReportedRate",
  "pmReportedRate",
  "pharmacyReportedRate",
  "campaignShare",
  "overallPct",
] as const;

export type KpiManagerMeasure = (typeof KPI_MANAGER_MEASURES)[number];

type MeasureValues = Record<KpiManagerMeasure, number | null>;

/** Printed as whole percentages on the board, so averaged and rounded as whole percentages. */
const WHOLE_PERCENT = new Set<KpiManagerMeasure>([
  "coveragePct",
  "frequencyPct",
  "amAttainmentPct",
  "pmAttainmentPct",
  "overallPct",
]);

export type KpiManagerRow = {
  /** Canonical LOWER-cased hr id, the same form as `KpiRepRow.agentHrId`. A key, never printed. */
  hrId: string;
  /** The directory's display name. */
  name: string;
  jobTitle: string | null;
  level: KpiManagerLevel;
  lineName: string | null;
  regionName: string | null;
  areaName: string | null;
  /** His own manager's name, from the directory. Null at the top of the tree. */
  reportsTo: string | null;
  /** The managers above `reportsTo`, nearest first, from the directory. */
  managersAbove: string[];
  /** Medical reps on the board anywhere beneath him — the viewer's own reach, never wider. */
  repsBeneath: number;
  /** Rep rows averaged directly (his own reps). */
  directReps: number;
  /** Manager rows averaged directly (the managers who report to him). */
  directManagers: number;
  /** `directReps + directManagers` — how many rows each of his figures is an average OF. */
  averagedRows: number;
  /** Per measure, how many of those rows had a value and so went into that average. */
  measured: Record<KpiManagerMeasure, number>;

  // ── The averages. Null when no row beneath him has a value on that measure. ──────────────────
  coveragePct: number | null;
  frequencyPct: number | null;
  /** Morning attainment against the AM target, averaged on its own. */
  amAttainmentPct: number | null;
  /** Afternoon attainment against the PM target, averaged on its own — never blended with AM. */
  pmAttainmentPct: number | null;
  amRate: number | null;
  pmRate: number | null;
  /** No owner-set pharmacy target exists, so this is a rate and never a percentage. */
  pharmacyRate: number | null;
  amReportedRate: number | null;
  pmReportedRate: number | null;
  pharmacyReportedRate: number | null;
  /** Share of the calls that took the campaign route, 0 to 1. */
  campaignShare: number | null;
  /** The average of the overall scores beneath him — the rows' own consolidated figure, averaged. */
  overallPct: number | null;
};

/**
 * What one rep row contributes to each average: the figure his own row PRINTS, or null where it
 * prints a marker instead of a number. The guards are the board's own — `hasMeasurablePlan` for the
 * plan measures, `hasCallRate` and ruling A1's `noGpsFeed` for the proved call rates — so a rep the
 * board reads as "No plan" or "No calls" is never averaged in as a 0.
 */
export function kpiRepMeasures(row: KpiRepRow): MeasureValues {
  // A rep too new to judge prints "Just started", not a number, so she adds nothing to any average
  // above her — a hire of two days would otherwise pull her district manager down (owner, 2026-10-26).
  if (row.justStarted) {
    const blank = {} as MeasureValues;
    for (const measure of KPI_MANAGER_MEASURES) blank[measure] = null;
    return blank;
  }
  const proved = row.hasCallRate && !row.noGpsFeed;
  return {
    coveragePct: row.hasMeasurablePlan ? row.coveragePct : null,
    frequencyPct: row.hasMeasurablePlan ? row.frequencyPct : null,
    amAttainmentPct: proved ? row.amAttainmentPct : null,
    pmAttainmentPct: proved ? row.pmAttainmentPct : null,
    amRate: proved ? row.amRate : null,
    pmRate: proved ? row.pmRate : null,
    pharmacyRate: proved ? row.pharmacyRate : null,
    amReportedRate: row.hasCallRate ? row.amReportedRate : null,
    pmReportedRate: row.hasCallRate ? row.pmReportedRate : null,
    pharmacyReportedRate: row.hasCallRate ? row.pharmacyReportedRate : null,
    campaignShare: row.totalCalls > 0 ? row.campaignShare : null,
    // The same domain function, with the same inputs, as the Overall cell on the rep's own row.
    overallPct: kpiIndexOf({
      coveragePct: row.coveragePct,
      frequencyPct: row.frequencyPct,
      hasMeasurablePlan: row.hasMeasurablePlan,
      amAttainmentPct: row.amAttainmentPct,
      pmAttainmentPct: row.pmAttainmentPct,
      hasCallRate: row.hasCallRate,
      noGpsFeed: row.noGpsFeed,
    }).overallPct,
  };
}

function managerMeasures(row: KpiManagerRow): MeasureValues {
  const values = {} as MeasureValues;
  for (const measure of KPI_MANAGER_MEASURES) values[measure] = row[measure];
  return values;
}

/** Rounded to the precision the board prints the measure at. */
function settle(measure: KpiManagerMeasure, value: number): number {
  if (WHOLE_PERCENT.has(measure)) return Math.round(value);
  if (measure === "campaignShare") return Math.round(value * 10000) / 10000;
  return Math.round(value * 100) / 100;
}

/** The simple mean of the rows that HAVE a value. Every other row is left out, never zeroed. */
function averageOf(rows: readonly MeasureValues[], measure: KpiManagerMeasure): { value: number | null; measured: number } {
  let total = 0;
  let measured = 0;
  for (const row of rows) {
    const value = row[measure];
    if (value == null || !Number.isFinite(value)) continue;
    total += value;
    measured += 1;
  }
  return { value: measured === 0 ? null : settle(measure, total / measured), measured };
}

/**
 * The manager rows for one board, in tree order — each manager before the managers beneath him,
 * siblings by name.
 *
 * `reps` are the FINAL rep rows: scoped, medical reps only, restamped by the Phoenix rules where they
 * apply — the very rows the board prints. They are read and never changed. `directory` is the
 * employee directory INCLUDING people who have left, so a chain through a departed manager still
 * climbs. `canSee` receives a manager's hr id and decides whether he gets a row; a manager it hides
 * still counts as one row in the average of the manager above him, because that average is about
 * the tree, not about what one viewer is shown.
 */
export function buildKpiManagerRows(input: {
  reps: readonly KpiRepRow[];
  directory: readonly KpiDirectoryEntry[];
  canSee?: (hrId: string) => boolean;
}): KpiManagerRow[] {
  const canSee = input.canSee ?? (() => true);

  // Keyed on the access form of the id (case, legacy aliases AND punctuation folded), the same key
  // the scope resolver climbs the org tree with — so "B-10" on one record and "b10" on another are
  // one person, as they are to the scope gate.
  const byKey = new Map<string, KpiDirectoryEntry>();
  for (const entry of input.directory) {
    const key = normalizeHrIdForAccess(entry.hrId);
    if (key && !byKey.has(key)) byKey.set(key, entry);
  }

  type ManagerRef = { key: string; hrId: string; name: string | null };
  const managerOf = (key: string): ManagerRef | null => {
    const entry = byKey.get(key);
    const raw = entry?.managerHrId?.trim() ?? "";
    const managerKey = normalizeHrIdForAccess(raw);
    if (!managerKey || managerKey === key) return null;
    return { key: managerKey, hrId: raw, name: entry?.managerName?.trim() || null };
  };

  type Node = {
    key: string;
    hrId: string;
    /** The name his reports' records give him, for a manager with no directory record of his own. */
    nameFromBelow: string | null;
    reps: KpiRepRow[];
    managers: Set<string>;
    repsBeneath: number;
  };
  const nodes = new Map<string, Node>();
  const nodeOf = (ref: ManagerRef): Node => {
    let node = nodes.get(ref.key);
    if (!node) {
      node = { key: ref.key, hrId: ref.hrId, nameFromBelow: ref.name, reps: [], managers: new Set(), repsBeneath: 0 };
      nodes.set(ref.key, node);
    }
    if (!node.nameFromBelow && ref.name) node.nameFromBelow = ref.name;
    return node;
  };

  // Each rep is hung under his own manager, and counted once under every manager above him. The
  // climb stops at the top or at the first id it has already passed — this directory holds
  // self-referencing and mutually-referencing pairs, and an unguarded climb would never end.
  for (const rep of input.reps) {
    const repKey = normalizeHrIdForAccess(rep.agentHrId);
    if (!repKey) continue;
    const direct = managerOf(repKey);
    if (!direct) continue;
    nodeOf(direct).reps.push(rep);
    const passed = new Set<string>([repKey]);
    let current: ManagerRef | null = direct;
    while (current && !passed.has(current.key)) {
      passed.add(current.key);
      nodeOf(current).repsBeneath += 1;
      const above = managerOf(current.key);
      if (above && !passed.has(above.key)) nodeOf(above).managers.add(current.key);
      current = above;
    }
  }

  // Bottom-up: a manager's row needs the rows beneath him first. `inProgress` breaks a loop that two
  // different reps' climbs can still close between them, so no row is ever averaged into itself.
  const rows = new Map<string, KpiManagerRow>();
  const inProgress = new Set<string>();
  const rowOf = (key: string): KpiManagerRow | null => {
    const done = rows.get(key);
    if (done) return done;
    const node = nodes.get(key);
    if (!node || inProgress.has(key)) return null;
    inProgress.add(key);

    const beneath: MeasureValues[] = node.reps.map(kpiRepMeasures);
    let directManagers = 0;
    for (const childKey of node.managers) {
      const child = rowOf(childKey);
      if (!child) continue;
      beneath.push(managerMeasures(child));
      directManagers += 1;
    }

    const values = {} as MeasureValues;
    const measured = {} as Record<KpiManagerMeasure, number>;
    for (const measure of KPI_MANAGER_MEASURES) {
      const average = averageOf(beneath, measure);
      values[measure] = average.value;
      measured[measure] = average.measured;
    }

    const entry = byKey.get(key);
    const jobTitle = entry?.jobTitle?.trim() || null;
    const row: KpiManagerRow = {
      hrId: canonicalHrIdKey(entry?.hrId ?? node.hrId) ?? key,
      name: entry?.displayName?.trim() || node.nameFromBelow || "Unnamed manager",
      jobTitle,
      level: kpiManagerLevelOf(jobTitle),
      lineName: entry?.lineName?.trim() || null,
      regionName: entry?.regionName?.trim() || null,
      areaName: entry?.areaName?.trim() || null,
      reportsTo: managerOf(key) ? entry?.managerName?.trim() || null : null,
      managersAbove: (entry?.managersAbove ?? []).map((name) => name?.trim() ?? "").filter((name) => name.length > 0),
      repsBeneath: node.repsBeneath,
      directReps: node.reps.length,
      directManagers,
      averagedRows: node.reps.length + directManagers,
      measured,
      ...values,
    };
    inProgress.delete(key);
    rows.set(key, row);
    return row;
  };
  for (const key of nodes.keys()) rowOf(key);

  // Tree order: every top-of-tree manager, then depth first beneath him, siblings by name.
  const parentOf = new Map<string, string>();
  for (const node of nodes.values()) {
    for (const child of node.managers) if (!parentOf.has(child)) parentOf.set(child, node.key);
  }
  const byName = (left: string, right: string): number =>
    (rows.get(left)?.name ?? "").localeCompare(rows.get(right)?.name ?? "") || (left < right ? -1 : left > right ? 1 : 0);
  const ordered: string[] = [];
  const placed = new Set<string>();
  const place = (key: string): void => {
    if (placed.has(key)) return;
    placed.add(key);
    ordered.push(key);
    for (const child of [...(nodes.get(key)?.managers ?? [])].sort(byName)) place(child);
  };
  const tops = [...nodes.keys()].filter((key) => {
    const parent = parentOf.get(key);
    return !parent || !nodes.has(parent);
  });
  for (const key of tops.sort(byName)) place(key);
  // Anybody only reachable round a loop in the org links still gets his row.
  for (const key of [...nodes.keys()].sort(byName)) place(key);

  return ordered.flatMap((key) => {
    const row = rows.get(key);
    const node = nodes.get(key);
    if (!row || !node || node.repsBeneath === 0) return [];
    return canSee(byKey.get(key)?.hrId ?? node.hrId) ? [row] : [];
  });
}
