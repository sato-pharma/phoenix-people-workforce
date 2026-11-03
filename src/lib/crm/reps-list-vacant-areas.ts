/**
 * Reps List — Vacant Areas. The doctors of a territory whose rep seat is empty.
 *
 * The owner's request, 2026-09-14: "make a third tab that is showing the doctors list in vacant
 * areas exactly as the other tab but this for vacant areas". Same cascade, same brick-grouped list,
 * same activity column — the only difference is that the thing picked is an AREA with nobody in the
 * seat rather than a rep.
 *
 * ## Where a vacant area's doctors come from
 *
 * A vacant seat has no rep, so it has no list of its own. What it does have is the list its LAST
 * REP left behind: when a rep resigns, their open periods in `crm_contact_assignments` stay open
 * until the list is handed to somebody. Measured on production 2026-09-14: 45 target-carrying cells
 * were vacant, and 7 of them still carried the open list of the resigned rep who last sat there
 * (each list's mapped bricks sit in that same area, which is the cross-check).
 *
 * ## Who the last rep was — three records, the latest wins
 *
 * The owner, same day: "you must get the latest rep on every vacant area". The seat history alone
 * named nobody for 20 of 46 vacant seats — the organogram's history only starts 2026-07-13, so a rep
 * who left before that is not in it. So the last rep is the LATEST of three records:
 *
 *  1. `seat`          — `au_v_seat_occupancy_all`, the public view over `au.occupancy_history`
 *                       (PostgREST cannot reach the `au` schema itself).
 *  2. `earlier_seat`  — a DIFFERENT seat that covered this same line and area for a while, read from
 *                       `au_v_line_area_map_all`. Beni Suef had no seat of its own until the Upper
 *                       Egypt split: from 2026-08-03 the Fayoum rep covered both halves, so Beni
 *                       Suef's last rep is whoever held Fayoum inside that window.
 *  3. `vacancy_record`— `position_vacancies.replacement_for_hr_id` on this seat: HR opened the
 *                       vacancy to replace that person, which dates to before the seat history.
 *
 * Somebody who DECLINED the offer never worked the area, yet the seat history and the vacancy
 * records both carry such people (a same-day occupancy, a vacancy "replacing" them). They are skipped,
 * so the rep before them is named — never a person who never started.
 *
 * Measured 2026-09-14: this names a rep for 36 of the 46 vacant seats. The other 10 have nobody in
 * any of the three: seats created by a territory move (Delta (3), the Upper Egypt split) or opened
 * as a new hire from the start. They stay on screen as `never_held`.
 *
 * ## Four states, all stated on screen
 *
 *  - `list`             — the last rep has left and their list is still open. Shown in full.
 *  - `list_closed`      — the last rep has left and holds no open list any more.
 *  - `holder_reseated`  — the last rep now sits in ANOTHER seat. Their open list is the one for
 *                         the territory they work today, so it is NOT shown here: it would put a
 *                         working rep's doctors under an area he no longer covers.
 *  - `never_held`       — none of the three records names anybody for this seat.
 *
 * None of the last three is hidden, for the reason `coverage-filters.ts` keeps vacancies at all: a
 * gap dropped from a screen reads as "there is no gap".
 *
 * ## Scope
 *
 * The same `CrmManagerScope` the contact tab uses, restricted through the same
 * `restrictCoverageFilterTree`. A team-scoped viewer is offered only the vacancies standing in a
 * region and line his own reps work — the adjacency rule that function already applies.
 */

import {
  narrowCoverageOptions,
  resolveCoverageSelection,
  restrictCoverageFilterTree,
  vacanciesMatching,
  type CoverageFilterCell,
  type CoverageFilterOptions,
  type CoverageFilterSelection,
  type CoverageFilterTree,
  type CoverageFilterVacancy,
} from "@/lib/crm/coverage-filters";
import { loadCoverageFilterTree } from "@/lib/crm/coverage-filters-data";
import { getRepListSummaries, type RepListSummary } from "@/lib/crm/contact-lists";
import { cairoTodayIso } from "@/lib/crm/dates";
import { kpiMonthOptions, type KpiPeriodOption } from "@/lib/crm/kpis-board";
import type { CrmManagerScope } from "@/lib/crm/manager-scope";
import { monthBounds, monthLabelOf, resolveRepDoctorListMonth } from "@/lib/crm/rep-doctor-lists";
import { getRepsListForAgent, type RepsListForRep } from "@/lib/crm/reps-list";
import { countUnvisited, type RepsListActivity } from "@/lib/crm/reps-list-activity";
import { loadRepsListActivity } from "@/lib/crm/reps-list-activity-data";
import { foldAreaCodeForLine, getMergedAreaName } from "@/lib/sales/closing-area-merges";
import {
  allowedHrIdsFor,
  buildRepsCascade,
  pruneLineFirst,
  regionsForLine,
  withActivity,
} from "@/lib/crm/reps-list-board";
import { canonicalHrIdKey, hrIdLookupKeys } from "@/lib/hr-id";
import { getSupabaseAdmin } from "@/lib/supabase/server";

/** PostgREST silently returns zero rows for a long `.in()` list. */
const IN_CHUNK = 50;

/** An employment status that means the person never worked a day in the seat. */
const NEVER_STARTED_STATUS = "declined_offer";

export type VacantAreaStatus = "list" | "list_closed" | "holder_reseated" | "never_held";

/** The person who last worked a vacant area, with the list they left behind. */
export type VacantAreaHolder = {
  agentCrmId: number | null;
  /** AM + PM. A pharmacy is not a contact (owner, 2026-09-01). */
  contactCount: number;
  /** The last day they worked the area, `YYYY-MM-DD`, or null when no record carries one. */
  heldUntil: string | null;
  hrId: string;
  name: string;
  pharmacyCount: number;
};

export type VacantArea = CoverageFilterVacancy & {
  holder: VacantAreaHolder | null;
  status: VacantAreaStatus;
};

export type VacantAreasBoard = {
  activityAsOf: string;
  activityAvailable: boolean;
  activityMonth: string;
  activityMonthLabel: string;
  activityUnvisited: number;
  areas: VacantArea[];
  /** The selected area's inherited list, or null when none is selected or it has none. */
  list: RepsListForRep | null;
  monthOptions: readonly KpiPeriodOption[];
  options: CoverageFilterOptions;
  scopeLabel: string;
  scopeReason: string | null;
  selected: VacantArea | null;
  selection: CoverageFilterSelection;
  syncedAt: string | null;
};

/** One row of `au_v_seat_occupancy_all`, as read. */
export type SeatOccupancyRow = {
  effective_from: string | null;
  effective_to: string | null;
  node_type: string | null;
  occupant_canonical_hr_id: string | null;
  occupant_hr_id: string | null;
  seat_id: string | null;
};

/** One row of `au_v_line_area_map_all` — which seat covered a line's area, and when. */
export type LineAreaSeatRow = {
  area_code: string | null;
  effective_from: string | null;
  effective_to: string | null;
  line_code: string | null;
  rep_seat_id: string | null;
};

/** One row of `position_vacancies` that names the person it was opened to replace. */
export type VacancyReplacementRow = {
  created_at: string | null;
  replacement_for_hr_id: string | null;
  seat_id: string | null;
};

/** What the roster says about a candidate, keyed by `canonicalHrIdKey`. */
export type HolderPerson = {
  employmentStatus: string | null;
  lastWorkingDate: string | null;
};

/** On the same day, the more direct record wins. */
const SOURCE_RANK = { seat: 0, earlier_seat: 1, vacancy_record: 2 } as const;
export type HolderSource = keyof typeof SOURCE_RANK;

export type SeatLastPerson = {
  heldUntil: string | null;
  /** As stored, for the name and list reads. */
  hrId: string;
  /** `canonicalHrIdKey` of the person, for every comparison. */
  key: string;
  source: HolderSource;
};

/**
 * The date a candidate is ranked by. An occupancy with no end is still open, so it is the latest of
 * all; a vacancy record with no date at all tells us nothing about WHEN, so it ranks last. ISO date
 * strings compare correctly as strings — no Date parsing, so no timezone can move a day.
 */
function rankDate(candidate: SeatLastPerson): string {
  if (candidate.heldUntil) return candidate.heldUntil.slice(0, 10);
  return candidate.source === "vacancy_record" ? "" : "9999-12-31";
}

function isLaterHolder(a: SeatLastPerson, b: SeatLastPerson): boolean {
  const dateA = rankDate(a);
  const dateB = rankDate(b);
  if (dateA !== dateB) return dateA > dateB;
  return SOURCE_RANK[a.source] < SOURCE_RANK[b.source];
}

function sameCode(a: string | null | undefined, b: string | null | undefined): boolean {
  return (a ?? "").trim().toLowerCase() === (b ?? "").trim().toLowerCase();
}

function dateOnly(value: string | null | undefined): string | null {
  const match = /^\d{4}-\d{2}-\d{2}/.exec(value ?? "");
  return match ? match[0] : null;
}

/**
 * PURE — the last rep who worked each vacant seat's area, from the three records in the header.
 * `vacant_placeholder` rows are ignored: they state that the seat is empty and name nobody. A seat
 * none of the records names is absent from the map.
 */
export function lastHolderBySeat(input: {
  coverage: readonly LineAreaSeatRow[];
  occupancy: readonly SeatOccupancyRow[];
  people: ReadonlyMap<string, HolderPerson>;
  replacements: readonly VacancyReplacementRow[];
  vacancies: ReadonlyArray<Pick<CoverageFilterCell, "areaCode" | "lineCode" | "seatId">>;
}): Map<string, SeatLastPerson> {
  const occupancyBySeat = new Map<string, SeatOccupancyRow[]>();
  for (const row of input.occupancy) {
    if (row.node_type !== "person") continue;
    const seatId = (row.seat_id ?? "").trim();
    if (!seatId) continue;
    const rows = occupancyBySeat.get(seatId) ?? [];
    rows.push(row);
    occupancyBySeat.set(seatId, rows);
  }

  const best = new Map<string, SeatLastPerson>();
  const offer = (seatId: string, candidate: SeatLastPerson) => {
    // Somebody who declined the offer never worked the area; the rep before them is the last one.
    if (input.people.get(candidate.key)?.employmentStatus === NEVER_STARTED_STATUS) return;
    const current = best.get(seatId);
    if (!current || isLaterHolder(candidate, current)) best.set(seatId, candidate);
  };
  const personOf = (row: SeatOccupancyRow) => {
    const hrId = (row.occupant_hr_id ?? row.occupant_canonical_hr_id ?? "").trim();
    const key = canonicalHrIdKey(row.occupant_canonical_hr_id ?? row.occupant_hr_id);
    return hrId && key ? { hrId, key } : null;
  };

  for (const vacancy of input.vacancies) {
    // 1. The seat's own history.
    for (const row of occupancyBySeat.get(vacancy.seatId) ?? []) {
      const person = personOf(row);
      if (person) offer(vacancy.seatId, { ...person, heldUntil: row.effective_to, source: "seat" });
    }

    // 2. Another seat that covered this same line and area, and only while it did.
    for (const map of input.coverage) {
      const earlierSeat = (map.rep_seat_id ?? "").trim();
      if (!earlierSeat || earlierSeat === vacancy.seatId) continue;
      if (!sameCode(map.line_code, vacancy.lineCode) || !sameCode(map.area_code, vacancy.areaCode)) continue;
      const windowFrom = map.effective_from ?? "";
      const windowTo = map.effective_to;
      for (const row of occupancyBySeat.get(earlierSeat) ?? []) {
        const person = personOf(row);
        if (!person) continue;
        const start = row.effective_from ?? "";
        const end = row.effective_to;
        // The occupancy must overlap the window in which that seat covered this area.
        if (windowTo != null && start >= windowTo) continue;
        if (end != null && end < windowFrom) continue;
        const heldUntil = end == null ? windowTo : windowTo == null || end < windowTo ? end : windowTo;
        offer(vacancy.seatId, { ...person, heldUntil, source: "earlier_seat" });
      }
    }
  }

  // 3. The HR vacancy opened on this seat to replace a named person.
  const seatIds = new Set(input.vacancies.map((vacancy) => vacancy.seatId));
  for (const row of input.replacements) {
    const seatId = (row.seat_id ?? "").trim();
    const hrId = (row.replacement_for_hr_id ?? "").trim();
    const key = canonicalHrIdKey(hrId);
    if (!seatIds.has(seatId) || !hrId || !key) continue;
    const heldUntil = dateOnly(input.people.get(key)?.lastWorkingDate) ?? dateOnly(row.created_at);
    offer(seatId, { heldUntil, hrId, key, source: "vacancy_record" });
  }

  return best;
}

/**
 * PURE — fold a line's merged area cells into ONE vacancy card. Anti Infective's Suez (OT2) and
 * Ismailia (OT9) became one area, "Ismailia and Suez", on 2026-09-01 (closing-area-merges): one
 * empty seat covers both cells, so `vacanciesMatching` hands back two rows with the SAME seatId —
 * two cards, a heading that reads "45" where it should read "44", and a duplicate React key. The
 * cascade dropdown already folds (coverage-filters); this folds the cards to match.
 *
 * Collapse is per SEAT, not per merged code, and only when two of a seat's cells fold to the same
 * keep-code: a single empty seat that happened to cover two UNMERGED areas still shows two cards, and
 * two DIFFERENT empty seats are never merged into one — hiding a second empty seat would be worse
 * than the double count. Folded at the current month, because a vacancy is a now-fact.
 */
export function foldVacancyCells(vacancies: readonly CoverageFilterVacancy[]): CoverageFilterVacancy[] {
  const byKey = new Map<string, CoverageFilterVacancy>();
  for (const vacancy of vacancies) {
    const foldedCode = foldAreaCodeForLine(vacancy.lineCode, vacancy.areaCode);
    const key = `${vacancy.seatId}|${vacancy.lineCode.toUpperCase()}|${foldedCode}`;
    const mergedName = getMergedAreaName(vacancy.lineCode, foldedCode);
    const folded: CoverageFilterVacancy = {
      ...vacancy,
      areaCode: foldedCode,
      areaName: mergedName ?? vacancy.areaName,
    };
    const existing = byKey.get(key);
    // Keep the survivor cell (the one already carrying the keep-code) so its own areaName is the
    // fallback when no merged name is defined; otherwise the first cell seen wins.
    if (!existing || vacancy.areaCode.toUpperCase() === foldedCode) byKey.set(key, folded);
  }
  return [...byKey.values()];
}

/** PURE — which of the four states a vacancy is in. See the header. */
export function resolveVacantAreaStatus(
  last: SeatLastPerson | undefined,
  seatedKeys: ReadonlySet<string>,
  summary: Pick<RepListSummary, "amCount" | "pharmacyCount" | "pmCount"> | undefined,
): VacantAreaStatus {
  if (!last) return "never_held";
  // Checked BEFORE the list: a reseated rep's open list belongs to the seat he holds today.
  if (seatedKeys.has(last.key)) return "holder_reseated";
  if (!summary || summary.pmCount + summary.amCount + summary.pharmacyCount === 0) return "list_closed";
  return "list";
}

/**
 * PURE — the tree the Vacant Areas cascade narrows over: its cells are the VACANCIES, it offers no
 * rep level, and its line and region options are only those a vacancy actually sits in, so no pick
 * can lead to an empty grid. Everything else — the Fayoum/Beni Suef fold, the line-first pruning —
 * is the contact tab's own helpers running over these cells.
 */
export function vacancyCascadeTree(tree: CoverageFilterTree): CoverageFilterTree {
  const cells: CoverageFilterCell[] = tree.vacancies;
  const codes = (pick: (cell: CoverageFilterCell) => string) => new Set(cells.map(pick));
  const lineCodes = codes((cell) => cell.lineCode);
  const regionCodes = codes((cell) => cell.regionCode);
  return {
    ...tree,
    cells,
    lines: tree.lines.filter((option) => lineCodes.has(option.code)),
    regions: tree.regions.filter((option) => regionCodes.has(option.code)),
    reps: [],
  };
}

async function readInChunks<Row>(
  values: readonly string[],
  read: (chunk: string[]) => PromiseLike<{ data: unknown; error: { message: string } | null }>,
  what: string,
): Promise<Row[]> {
  const rows: Row[] = [];
  const unique = [...new Set(values.filter(Boolean))];
  for (let from = 0; from < unique.length; from += IN_CHUNK) {
    const { data, error } = await read(unique.slice(from, from + IN_CHUNK));
    if (error) throw new Error(`Could not read ${what}: ${error.message}`);
    rows.push(...((data ?? []) as Row[]));
  }
  return rows;
}

function loadSeatOccupancy(seatIds: readonly string[]): Promise<SeatOccupancyRow[]> {
  const supabase = getSupabaseAdmin();
  return readInChunks<SeatOccupancyRow>(
    seatIds,
    (chunk) =>
      supabase
        .from("au_v_seat_occupancy_all")
        .select("seat_id, node_type, occupant_hr_id, occupant_canonical_hr_id, effective_from, effective_to")
        .in("seat_id", chunk)
        .eq("node_type", "person"),
    "the seat history",
  );
}

/** Every seat that has ever covered these areas, on any line — narrowed to the vacancy's line by the caller. */
function loadCoverageHistory(areaCodes: readonly string[]): Promise<LineAreaSeatRow[]> {
  const supabase = getSupabaseAdmin();
  return readInChunks<LineAreaSeatRow>(
    areaCodes,
    (chunk) =>
      supabase
        .from("au_v_line_area_map_all")
        .select("line_code, area_code, rep_seat_id, effective_from, effective_to")
        .in("area_code", chunk)
        .not("rep_seat_id", "is", null),
    "the area coverage history",
  );
}

function loadVacancyReplacements(seatIds: readonly string[]): Promise<VacancyReplacementRow[]> {
  const supabase = getSupabaseAdmin();
  return readInChunks<VacancyReplacementRow>(
    seatIds,
    (chunk) =>
      supabase
        .from("position_vacancies")
        .select("seat_id, replacement_for_hr_id, created_at")
        .in("seat_id", chunk)
        .not("replacement_for_hr_id", "is", null),
    "the vacancy records",
  );
}

/** Departed reps too — the whole point is people no longer in the seat. */
async function loadPeople(hrIds: readonly string[]): Promise<Map<string, HolderPerson & { name: string }>> {
  const supabase = getSupabaseAdmin();
  const rows = await readInChunks<{
    employment_status: string | null;
    full_name: string | null;
    hr_id: string | null;
    last_working_date: string | null;
  }>(
    hrIds.flatMap((hrId) => hrIdLookupKeys(hrId)),
    (chunk) => supabase.from("employees").select("hr_id, full_name, employment_status, last_working_date").in("hr_id", chunk),
    "employee records",
  );
  const people = new Map<string, HolderPerson & { name: string }>();
  for (const row of rows) {
    const key = canonicalHrIdKey(row.hr_id);
    if (!key || people.has(key)) continue;
    people.set(key, {
      employmentStatus: row.employment_status,
      lastWorkingDate: row.last_working_date,
      name: (row.full_name ?? "").trim(),
    });
  }
  return people;
}

/** The three records for the vacancies in view, read in two rounds (the earlier seats come from round one). */
export async function loadLastHolders(
  vacancies: readonly CoverageFilterVacancy[],
): Promise<{ lastBySeat: Map<string, SeatLastPerson>; names: Map<string, string> }> {
  if (vacancies.length === 0) return { lastBySeat: new Map(), names: new Map() };
  const seatIds = vacancies.map((vacancy) => vacancy.seatId);
  const [allCoverage, replacements] = await Promise.all([
    loadCoverageHistory(vacancies.map((vacancy) => vacancy.areaCode)),
    loadVacancyReplacements(seatIds),
  ]);
  const coverage = allCoverage.filter((row) =>
    vacancies.some(
      (vacancy) =>
        sameCode(row.line_code, vacancy.lineCode) &&
        sameCode(row.area_code, vacancy.areaCode) &&
        (row.rep_seat_id ?? "").trim() !== vacancy.seatId,
    ),
  );
  const occupancy = await loadSeatOccupancy([...seatIds, ...coverage.map((row) => (row.rep_seat_id ?? "").trim())]);
  const people = await loadPeople([
    ...occupancy.map((row) => (row.occupant_hr_id ?? row.occupant_canonical_hr_id ?? "").trim()),
    ...replacements.map((row) => (row.replacement_for_hr_id ?? "").trim()),
  ]);
  const lastBySeat = lastHolderBySeat({ coverage, occupancy, people, replacements, vacancies });
  const names = new Map<string, string>();
  for (const [key, person] of people) if (person.name) names.set(key, person.name);
  return { lastBySeat, names };
}

const EMPTY_OPTIONS: CoverageFilterOptions = { areas: [], lines: [], regions: [], reps: [] };

/** Assembles tab three — the vacancy cascade plus the selected area's inherited contact list. */
export async function getVacantAreasBoard(input: {
  scope: CrmManagerScope;
  params: { area?: string; line?: string; month?: string; region?: string; vacancy?: string };
}): Promise<VacantAreasBoard> {
  const today = cairoTodayIso();
  const activityMonth = resolveRepDoctorListMonth(input.params.month);
  const monthEnd = monthBounds(activityMonth).to;
  const base = {
    activityAsOf: today < monthEnd ? today : monthEnd,
    activityMonth,
    activityMonthLabel: monthLabelOf(activityMonth),
    monthOptions: kpiMonthOptions(today),
  };

  if (input.scope.kind === "none") {
    return {
      ...base,
      activityAvailable: false,
      activityUnvisited: 0,
      areas: [],
      list: null,
      options: EMPTY_OPTIONS,
      scopeLabel: "No reach",
      scopeReason: input.scope.reason,
      selected: null,
      selection: {},
      syncedAt: null,
    };
  }

  const [companyTree, summaries] = await Promise.all([loadCoverageFilterTree(), getRepListSummaries()]);
  // RESTRICT FIRST, exactly as the contact tab does — every option below comes from `tree`.
  const tree = vacancyCascadeTree(restrictCoverageFilterTree(companyTree, allowedHrIdsFor(input.scope)));

  const raw = resolveCoverageSelection({ area: input.params.area, line: input.params.line, region: input.params.region });
  const selection = pruneLineFirst(tree, raw);
  const narrowed = narrowCoverageOptions(tree, selection);
  const options: CoverageFilterOptions = {
    ...narrowed,
    regions: regionsForLine(tree, selection.line, narrowed.regions),
    reps: [],
  };

  const inView = foldVacancyCells(
    vacanciesMatching(tree, { area: selection.area, line: selection.line, region: selection.region }),
  );

  const { lastBySeat, names } = await loadLastHolders(inView);

  // Seated anywhere in the COMPANY, not just in this viewer's reach: a holder reseated outside a
  // manager's team is still working, and his list is still somebody's current territory.
  const seatedKeys = new Set(
    companyTree.reps.map((rep) => canonicalHrIdKey(rep.hrId)).filter((key): key is string => Boolean(key)),
  );
  const summaryByKey = new Map<string, RepListSummary>();
  for (const summary of summaries) {
    const key = canonicalHrIdKey(summary.hrId);
    if (key) summaryByKey.set(key, summary);
  }

  const areas: VacantArea[] = inView.map((vacancy) => {
    const last = lastBySeat.get(vacancy.seatId);
    const summary = last ? summaryByKey.get(last.key) : undefined;
    const status = resolveVacantAreaStatus(last, seatedKeys, summary);
    // Counts only for `list`. A reseated holder's counts describe his CURRENT territory.
    const counted = status === "list" && summary;
    return {
      ...vacancy,
      holder: last
        ? {
            agentCrmId: summary?.agentCrmId ?? null,
            contactCount: counted ? summary.pmCount + summary.amCount : 0,
            heldUntil: dateOnly(last.heldUntil),
            hrId: last.hrId,
            name: names.get(last.key) ?? "A former rep not on the employee roster",
            pharmacyCount: counted ? summary.pharmacyCount : 0,
          }
        : null,
      status,
    };
  });

  const vacancyKey = (input.params.vacancy ?? "").trim();
  // Found inside `areas`, which is already scoped and filtered: a hand-typed seat outside the
  // viewer's reach matches nothing and the grid is shown instead.
  const selected = vacancyKey ? (areas.find((area) => area.seatId === vacancyKey) ?? null) : null;
  const holder = selected?.status === "list" ? selected.holder : null;

  let list: RepsListForRep | null = null;
  let activityIndex: Map<number, RepsListActivity> | null = null;
  if (holder) {
    const { repNameByRepKey } = await buildRepsCascade({ params: {}, scope: input.scope });
    const rawList = await getRepsListForAgent({ agentCrmId: holder.agentCrmId, hrId: holder.hrId }, repNameByRepKey);
    // Same rule as the contact tab: the activity is an annotation and never takes the list down.
    try {
      activityIndex = await loadRepsListActivity({ agentCrmId: holder.agentCrmId, hrId: holder.hrId, month: activityMonth });
    } catch {
      activityIndex = null;
    }
    list = withActivity(rawList, activityIndex);
  }

  const activityUnvisited =
    list && activityIndex ? countUnvisited(list.groups.flatMap((group) => group.rows.map((row) => row.activity ?? null))) : 0;

  const syncedAt = areas.reduce<string | null>((latest, area) => {
    if (area.status !== "list" || !area.holder) return latest;
    const at = summaryByKey.get(canonicalHrIdKey(area.holder.hrId) ?? "")?.syncedAt ?? null;
    return at && (!latest || at > latest) ? at : latest;
  }, null);

  return {
    ...base,
    activityAvailable: activityIndex != null,
    activityUnvisited,
    areas,
    list,
    options,
    scopeLabel: input.scope.label,
    scopeReason: null,
    selected,
    selection: { area: selection.area, line: selection.line, region: selection.region },
    syncedAt,
  };
}
