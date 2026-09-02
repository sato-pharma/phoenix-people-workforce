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
// Month vocabulary is BORROWED, never restated. `monthLabelOf` and `resolveRepDoctorListMonth`
// come from the module that produces the activity itself, and `kpiMonthOptions` from the board that
// already offers the same twelve-month picker. Writing a local copy of any of the three is how two
// screens start disagreeing about which month "August" is — see the DATE DISCIPLINE note in
// rep-doctor-lists.ts on why all of it is string arithmetic and never Date parsing.
import { kpiMonthOptions, type KpiPeriodOption } from "@/lib/crm/kpis-board";
import { monthBounds, monthLabelOf, resolveRepDoctorListMonth } from "@/lib/crm/rep-doctor-lists";
import { activityForContact, countUnvisited, type RepsListActivity } from "@/lib/crm/reps-list-activity";
import { loadRepsListActivity } from "@/lib/crm/reps-list-activity-data";
import { cairoTodayIso } from "@/lib/crm/dates";

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
  /**
   * AM + PM only. A pharmacy is NOT a contact — the owner's rule, 2026-09-01 — so the picker's
   * "N contacts" and the pharmacy figure beside it are two separate things, counted apart.
   */
  contactCount: number;
  hrId: string;
  name: string;
  /** Pharmacies on this rep's list. Counted apart from `contactCount` and never folded into it. */
  pharmacyCount: number;
  /** The cascade's own key for this rep — what rides in the URL. */
  repKey: string;
};

export type RepsListBoard = {
  /**
   * FALSE means the activity could not be read — NOT that nothing happened.
   *
   * The board renders the difference, and it is the whole difference between a column that is
   * missing and one that accuses every doctor on the list of being ignored. A plan mirror that has
   * not shipped, a rep with no CRM account, and a departed agent all land here.
   */
  activityAvailable: boolean;
  /** The month the activity describes — the contact list itself is not time-scoped. */
  activityMonth: string;
  activityMonthLabel: string;
  /** The last day the activity covers: today for the live month, else the month's last day. Printed,
   * so a two-day-old month can never be read as a full one. */
  activityAsOf: string;
  /** Contacts on this list that went unvisited in the month — `untouched` plus `missed`. */
  activityUnvisited: number;
  /** The twelve months the picker offers, newest first. */
  monthOptions: readonly KpiPeriodOption[];
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
 * Everything both Reps List tabs need before they diverge: the scope, the cascade, the rep cards
 * and the selected rep.
 *
 * EXTRACTED SO THE TWO TABS CANNOT DRIFT. Tab one lists the selected rep's contacts; tab two shows
 * that rep's weekly plan for a chosen week. They are different screens over the same question —
 * "which rep, and may this viewer see him" — and the moment each answers it for itself is the
 * moment one of them can offer a rep the other refuses. That is the same fault the owner caught on
 * 2026-08-28 (a picker wider than its viewer), one level up.
 *
 * `searchParams` is taken raw and normalised here rather than by the pages, so a hand-typed filter
 * that no longer exists in the org tree is pruned identically on every surface.
 */
export type RepsCascade = {
  options: CoverageFilterOptions;
  /**
   * Agent id -> rep name, COMPANY-WIDE. Built here because it is derived from the unrestricted
   * tree this function already holds; what it is for, and why it is the one read that wants the
   * unrestricted tree, is written out where it is built below.
   */
  repNameByAgentId: Map<number, string>;
  reps: RepsListRep[];
  /**
   * The same list WITHOUT the rep level applied — every rep in the chosen line, region and area.
   *
   * `reps` is narrowed to one person the moment `?rep=` is set, which is right for the grid and
   * wrong for any control that COUNTS. The Reps Weekly Plans status picker drops the rep when it
   * navigates, so counting `reps` had it offering "Verified (0)" on a page whose Verified slice
   * actually holds 61 people — every number on the control describing somewhere the control does
   * not go. Count with this; browse with `reps`.
   */
  repsIgnoringRep: RepsListRep[];
  scopeLabel: string;
  scopeReason: string | null;
  selected: RepsListRep | null;
  selection: CoverageFilterSelection;
  syncedAt: string | null;
};

export async function buildRepsCascade(input: {
  scope: CrmManagerScope;
  params: { area?: string; line?: string; region?: string; rep?: string };
}): Promise<RepsCascade> {
  const scopeLabel = input.scope.kind === "none" ? "No reach" : input.scope.label;
  if (input.scope.kind === "none") {
    return {
      options: EMPTY_OPTIONS,
      // A fresh Map per call, never a shared literal: a caller that mutated a shared one would
      // leak one viewer's names into the next request served by the same process.
      repNameByAgentId: new Map<number, string>(),
      reps: [],
      repsIgnoringRep: [],
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
  // Matched WITHOUT the rep level, then narrowed below. One pass over the tree yields both lists:
  // the one the grid browses and the one the status picker counts.
  const repsIgnoringRep: RepsListRep[] = repsMatching(tree, { ...selection, rep: undefined })
    .map((rep) => {
      const summary = summaryByHrId.get(lower(rep.hrId));
      return {
        agentCrmId: summary?.agentCrmId ?? null,
        areaNames: [...(areaNamesBySeat.get(rep.seatId) ?? [])].sort((left, right) => left.localeCompare(right)),
        // Contacts are PM + AM. The pharmacy count rides beside them, never inside them.
        contactCount: summary ? summary.pmCount + summary.amCount : 0,
        hrId: rep.hrId,
        name: rep.repName,
        pharmacyCount: summary?.pharmacyCount ?? 0,
        repKey: rep.repKey,
      };
    })
    .sort((left, right) => left.name.localeCompare(right.name));

  const reps: RepsListRep[] = selection.rep
    ? repsIgnoringRep.filter((rep) => rep.repKey === selection.rep)
    : repsIgnoringRep;

  // Only an explicitly selected rep opens a list. The board's first screen is the cascade, exactly
  // as specified — a rep is chosen, then that rep's contacts appear.
  const selected = selection.rep ? (reps.find((rep) => rep.repKey === selection.rep) ?? null) : null;

  // COMPANY-WIDE ON PURPOSE, and not a widened picker. A shared customer's other half is by
  // definition on another rep's list, often outside this viewer's scope, so a map restricted to
  // the scope would leave the commonest case saying only "shared with someone". This never becomes
  // a list a viewer can browse — a name is printed only on a row the viewer can already see.
  //
  // BUILT FROM `companyTree.reps`, NOT FROM `tree.reps` — THE ONE READ IN THIS FILE THAT WANTS THE
  // UNRESTRICTED TREE. `tree` is scope-restricted a few lines above, which is right for every
  // option list, for the rep cards and for the selection, and wrong here and only here. Built from
  // `tree` the map holds the viewer's OWN reps alone, so a partner outside his team cannot be
  // named — and `findSharedCustomers` does not degrade an unnameable partner to "shared with
  // someone", it discards the match outright (`if (!repName) return`). The discarded entry is also
  // what carries `contactCrmIds`, so the partner's check-ins are never fetched and the confidence
  // score silently loses its second observer as well: both of the bugs fixed on 2026-09-01,
  // reopened for team-scoped viewers only. /admin/reps-list was never affected — a company scope
  // restricts nothing, so only the portal board was blind. Measured on production 2026-09-01: of
  // 3,334 cross-rep same-name pairs 2,842 (85%) sit under a different manager, and of the 62
  // shared-phone pairs ALL 62 do.
  //
  // AND NOT FROM `summaries`. getDoctorListRepSummaries constructs every row with `name: ""` and
  // never fills it — the name is resolved against the org tree by whichever board is assembling the
  // screen. Reading `summary.name` here therefore produced an EMPTY MAP, and an empty map means
  // every match is dropped for want of a name: the whole shared-customer feature rendered nothing,
  // on every rep, with no error anywhere. Measured 2026-09-01 — agent 1131 has 18 shared contacts
  // and the board showed 0. Do not reintroduce `summaries` here.
  //
  // The owner was asked directly on 2026-09-01 and approved the one thing this widens: a manager
  // may read the NAME of a rep outside his own team, on a shared row he can already see.
  const repNameByAgentId = new Map<number, string>();
  for (const rep of companyTree.reps) {
    const summary = summaryByHrId.get(lower(rep.hrId));
    const name = rep.repName?.trim();
    if (summary?.agentCrmId != null && name) repNameByAgentId.set(summary.agentCrmId, name);
  }

  const syncedAt = reps.reduce<string | null>((latest, rep) => {
    const summary = summaryByHrId.get(lower(rep.hrId));
    const at = summary?.syncedAt ?? null;
    return at && (!latest || at > latest) ? at : latest;
  }, null);

  return { options, repNameByAgentId, reps, repsIgnoringRep, scopeLabel, scopeReason: null, selected, selection, syncedAt };
}

/**
 * Attach each contact's month activity to the rows, leaving the grouping untouched.
 *
 * Done HERE and not in `getRepsListForAgent` on purpose. That function mirrors the CRM's own
 * contact list and knows nothing about plans or visits, which is exactly what makes it the honest
 * answer to "what was this rep given". The activity is an ANNOTATION over that list, and keeping the
 * two apart is what lets the board still render a complete, correct contact list on a day the plan
 * mirror cannot be read at all.
 */
function withActivity(
  list: RepsListForRep,
  index: ReadonlyMap<number, RepsListActivity> | null,
): RepsListForRep {
  return {
    ...list,
    groups: list.groups.map((group) => ({
      ...group,
      // A contact carried on BOTH the AM and PM lists appears as two rows and both get the same
      // activity, because the activity is a property of the contact and not of the list he sits on.
      // Two rows reading "2 of 3" are one doctor visited twice, not four visits.
      rows: group.rows.map((row) => ({ ...row, activity: activityForContact(index, row.contactCrmId) })),
    })),
  };
}

/** Assembles tab one — the cascade plus the selected rep's contact list, grouped by brick. */
export async function getRepsListBoard(input: {
  scope: CrmManagerScope;
  params: { area?: string; line?: string; month?: string; region?: string; rep?: string };
}): Promise<RepsListBoard> {
  const cascade = await buildRepsCascade(input);
  const today = cairoTodayIso();
  // An unparseable or hand-typed month falls back to the Cairo month we are in, never throws — this
  // rides in the URL, so a stale bookmark is a user-reachable input.
  const activityMonth = resolveRepDoctorListMonth(input.params.month);
  const monthEnd = monthBounds(activityMonth).to;
  // The same clamp the builder applies internally, restated for the CAPTION so the screen can say
  // how much of the month it is actually reporting on. On the 2nd of a month that matters enormously:
  // every doctor is legitimately unvisited, and a board that did not print the span would read as a
  // catastrophic collapse in coverage rather than as a month that has barely started.
  const activityAsOf = today < monthEnd ? today : monthEnd;

  const rawList =
    cascade.selected?.agentCrmId != null
      ? await getRepsListForAgent(cascade.selected.agentCrmId, cascade.repNameByAgentId)
      : null;

  // THE ACTIVITY MUST NEVER TAKE THE CONTACT LIST DOWN WITH IT. The list is this board's whole
  // purpose and it comes from a different mirror; the plan mirror is newer than several
  // environments' schemas and `scanPlanEntries` already degrades to empty rather than throwing. A
  // failure here therefore drops the annotation and says so, and the board below still renders every
  // contact — the behaviour this board had before the column existed.
  let activityIndex: Map<number, RepsListActivity> | null = null;
  if (rawList && cascade.selected?.agentCrmId != null) {
    try {
      activityIndex = await loadRepsListActivity({ agentCrmId: cascade.selected.agentCrmId, month: activityMonth });
    } catch {
      activityIndex = null;
    }
  }

  const list = rawList ? withActivity(rawList, activityIndex) : null;
  const activityUnvisited =
    list && activityIndex ? countUnvisited(list.groups.flatMap((group) => group.rows.map((row) => row.activity ?? null))) : 0;

  return {
    activityAsOf,
    activityAvailable: activityIndex != null,
    activityMonth,
    activityMonthLabel: monthLabelOf(activityMonth),
    activityUnvisited,
    list,
    monthOptions: kpiMonthOptions(today),
    options: cascade.options,
    reps: cascade.reps,
    scopeLabel: cascade.scopeLabel,
    scopeReason: cascade.scopeReason,
    selected: cascade.selected,
    selection: cascade.selection,
    syncedAt: cascade.syncedAt,
  };
}

/** Re-exported so the pages never import the cascade module directly. */
export type { CoverageFilterOption, CoverageFilterOptions, CoverageFilterSelection };
