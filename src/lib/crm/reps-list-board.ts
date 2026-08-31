/**
 * The Reps List board — the cascade, the scope and the grouped contact list, assembled once.
 *
 * Both entry points call this and nothing else: the admin board (`/admin/reps-list`) and the
 * portal's manager copy (`/employee-portals/reps-list`). Two pages that assemble "the same" board
 * by each doing it are two pages that disagree the first time one is edited, and here the thing they
 * would disagree about is WHO A VIEWER MAY SEE — so the assembly is not duplicated.
 *
 * ## The scope rule this file exists to enforce
 *
 * `loadCoverageFilterTree` is `unstable_cache`d and COMPANY-WIDE by construction — it has to be, or
 * every viewer would pay for their own copy of the org tree. That makes it the exact shape of the
 * fault the owner caught on 2026-08-28: scoped rows behind an unscoped picker, which offered a
 * medical rep the names of all ~73 reps. So the tree is restricted through
 * `restrictCoverageFilterTree` BEFORE a single option list is derived from it, and every option, the
 * rep list and the selected rep all come from that one restricted tree. A picker is never wider than
 * its viewer, and here they cannot drift because there is only one tree.
 *
 * ## Why the cascade is presented Line -> Region -> Area
 *
 * The owner asked for it in that order ("filter by line... then its regions appear... then he
 * chooses the region... then the area and the medical rep"). `coverage-filters.ts` derives every
 * option list from real (region, line, area, seat) CELLS rather than from four independent sets, so
 * the presentation order is free — narrowing by line first is as correct as narrowing by region
 * first, and neither can offer a combination no rep actually occupies. That cell design is also what
 * stops the Fayoum/Beni Suef per-line split from producing a dead end.
 */

import {
  narrowCoverageOptions,
  repsMatching,
  resolveCoverageSelection,
  restrictCoverageFilterTree,
  type CoverageFilterOption,
  type CoverageFilterOptions,
  type CoverageFilterSelection,
  type CoverageFilterTree,
} from "@/lib/crm/coverage-filters";
import { loadCoverageFilterTree } from "@/lib/crm/coverage-filters-data";
import { getDoctorListRepSummaries, type DoctorListRepSummary } from "@/lib/crm/contact-lists";
import type { CrmManagerScope } from "@/lib/crm/manager-scope";
import { getRepsListForAgent, type RepsListForRep } from "@/lib/crm/reps-list";

/** One rep offered by the cascade, with whatever CRM list they hold. */
export type RepsListRep = {
  /** Null when the org tree seats this rep but the CRM mirror holds no list for them. */
  agentCrmId: number | null;
  /**
   * The areas this rep's seat actually works, by NAME — the owner asked for the area to appear
   * beside the rep. Several names is not a defect: one seat legitimately spans more than one area,
   * and collapsing that to the first would state something untrue about where the person works.
   */
  areaNames: string[];
  contactCount: number;
  hrId: string;
  name: string;
  /** The cascade's own key for this rep — what rides in the URL. */
  repKey: string;
};

export type RepsListBoard = {
  /** The rep whose list is on screen, or null when the selection resolves to nobody. */
  list: RepsListForRep | null;
  options: CoverageFilterOptions;
  reps: RepsListRep[];
  /** What the viewer's reach is, in words, so a short picker is never read as a thin CRM. */
  scopeLabel: string;
  /** Set when the viewer resolves to nobody; the board explains instead of showing an empty picker. */
  scopeReason: string | null;
  selected: RepsListRep | null;
  selection: CoverageFilterSelection;
  syncedAt: string | null;
};

const EMPTY_OPTIONS: CoverageFilterOptions = { areas: [], lines: [], regions: [], reps: [] };
const lower = (value: string | null | undefined): string => (value ?? "").trim().toLowerCase();

/**
 * Which rep hr-ids the viewer may see, in the shape `restrictCoverageFilterTree` wants.
 *
 * `null` means "no restriction" and is returned ONLY for a company-scoped viewer. A team-scoped
 * viewer whose seat resolves to nobody gets an empty array — never `null` — because the difference
 * between those two is the difference between seeing nothing and seeing everyone.
 */
function allowedHrIdsFor(scope: CrmManagerScope): readonly string[] | null {
  if (scope.kind === "company") return null;
  if (scope.kind === "agents") return scope.agentHrIds;
  return [];
}

/**
 * The regions reachable under the picked line.
 *
 * `narrowCoverageOptions` returns EVERY region unconditionally, and deliberately so: on Doctor
 * Coverage the cascade starts at Region, and narrowing the top level by a lower one would hide the
 * region you were about to switch to. Reps List starts at LINE — the owner's order, in his words
 * "filter by line; then if he chooses the line, its regions appear" — so here Region is a level
 * BELOW and has to narrow like one.
 *
 * Overridden here rather than changed in the shared module: the other board's rule is right for the
 * other board's order, and one function cannot be top-level and second-level at the same time.
 *
 * Exported for tests/reps-list.test.ts — the cascade order is the owner's specification, and it is
 * not observable from `getRepsListBoard` without a database.
 */
export function regionsForLine(
  tree: CoverageFilterTree,
  line: string | undefined,
  all: CoverageFilterOption[],
): CoverageFilterOption[] {
  if (!line) return all;
  const codes = new Set(tree.cells.filter((cell) => cell.lineCode === line).map((cell) => cell.regionCode));
  return all.filter((option) => codes.has(option.code));
}

/**
 * Drop any selected level the tree does not actually offer — in THIS board's cascade order.
 *
 * `pruneCoverageSelection` does the same job region-first, so a hand-typed URL naming a line and a
 * region that line does not work would keep the region and silently discard the LINE. On a board
 * whose top level is the line that is the wrong survivor: the user's broadest choice would vanish
 * and the narrower one would stand. Same shape, same helpers for the two lower levels — so the
 * Fayoum/Beni Suef area fold and the rep narrowing stay identical — only the order differs.
 *
 * Exported for tests/reps-list.test.ts, for the same reason as `regionsForLine` above.
 */
export function pruneLineFirst(tree: CoverageFilterTree, raw: CoverageFilterSelection): CoverageFilterSelection {
  const offers = (options: CoverageFilterOption[], value: string | undefined) =>
    value && options.some((option) => option.code === value) ? value : undefined;

  const line = offers(tree.lines, raw.line);
  const region = offers(regionsForLine(tree, line, tree.regions), raw.region);
  const area = offers(narrowCoverageOptions(tree, { line, region }).areas, raw.area);
  const rep = offers(narrowCoverageOptions(tree, { area, line, region }).reps, raw.rep);

  return { area, line, region, rep };
}

/**
 * Assembles the board for one viewer and one selection.
 *
 * `searchParams` is taken raw and normalised here rather than by the pages, so a hand-typed filter
 * that no longer exists in the org tree is pruned identically on both.
 */
export async function getRepsListBoard(input: {
  scope: CrmManagerScope;
  params: { area?: string; line?: string; region?: string; rep?: string };
}): Promise<RepsListBoard> {
  const scopeLabel = input.scope.kind === "none" ? "No reach" : input.scope.label;
  if (input.scope.kind === "none") {
    return {
      list: null,
      options: EMPTY_OPTIONS,
      reps: [],
      scopeLabel,
      scopeReason: input.scope.reason,
      selected: null,
      selection: {},
      syncedAt: null,
    };
  }

  const [companyTree, summaries] = await Promise.all([loadCoverageFilterTree(), getDoctorListRepSummaries()]);
  // RESTRICT FIRST. Every option list below is derived from `tree`, never from `companyTree`.
  const tree = restrictCoverageFilterTree(companyTree, allowedHrIdsFor(input.scope));

  const selection = pruneLineFirst(tree, resolveCoverageSelection(input.params));
  const narrowed = narrowCoverageOptions(tree, selection);
  const options: CoverageFilterOptions = {
    ...narrowed,
    regions: regionsForLine(tree, selection.line, narrowed.regions),
  };

  const summaryByHrId = new Map<string, DoctorListRepSummary>();
  for (const summary of summaries) {
    // HR ids are mixed-case across this system, so both sides are lowered. An exact-case join
    // happens to return everything today; it is one CRM re-import away from silently under-returning.
    if (summary.hrId) summaryByHrId.set(lower(summary.hrId), summary);
  }

  // Area NAMES per seat, so the rep list can show where each person works without ever printing a
  // raw area code at the reader (owner's standing rule). Built once from the restricted tree rather
  // than per rep, because `cells` is the whole org and a per-rep scan of it is quadratic.
  const areaNameByCode = new Map(tree.areas.map((area) => [area.code, area.name]));
  const areaNamesBySeat = new Map<string, Set<string>>();
  for (const cell of tree.cells) {
    const name = areaNameByCode.get(cell.areaCode);
    if (!name) continue;
    let names = areaNamesBySeat.get(cell.seatId);
    if (!names) {
      names = new Set<string>();
      areaNamesBySeat.set(cell.seatId, names);
    }
    names.add(name);
  }

  // The cascade's reps are the org tree's seated reps — the authority on who exists and who a
  // viewer may see. A rep with no CRM list is kept and reported as holding none, because "this rep
  // has no list in the CRM" is a finding the owner wants to see, not a row to hide.
  const reps: RepsListRep[] = repsMatching(tree, selection)
    .map((rep) => {
      const summary = summaryByHrId.get(lower(rep.hrId));
      return {
        agentCrmId: summary?.agentCrmId ?? null,
        areaNames: [...(areaNamesBySeat.get(rep.seatId) ?? [])].sort((left, right) => left.localeCompare(right)),
        contactCount: summary ? summary.pmCount + summary.amCount + summary.pharmacyCount : 0,
        hrId: rep.hrId,
        name: rep.repName,
        repKey: rep.repKey,
      };
    })
    .sort((left, right) => left.name.localeCompare(right.name));

  // Only an explicitly selected rep opens a list. The board's first screen is the cascade, exactly
  // as specified — a rep is chosen, then that rep's contacts appear.
  const selected = selection.rep ? (reps.find((rep) => rep.repKey === selection.rep) ?? null) : null;
  const list = selected?.agentCrmId != null ? await getRepsListForAgent(selected.agentCrmId) : null;

  const syncedAt = reps.reduce<string | null>((latest, rep) => {
    const summary = summaryByHrId.get(lower(rep.hrId));
    const at = summary?.syncedAt ?? null;
    return at && (!latest || at > latest) ? at : latest;
  }, null);

  return { list, options, reps, scopeLabel, scopeReason: null, selected, selection, syncedAt };
}

/** Re-exported so the pages never import the cascade module directly. */
export type { CoverageFilterOption, CoverageFilterOptions, CoverageFilterSelection };
