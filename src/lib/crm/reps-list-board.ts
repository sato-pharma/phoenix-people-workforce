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
  coverageRepKey,
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
import { districtSeatAbove, groupByRegionAndManager, NO_REGION } from "@/lib/phoenix-crm/region-manager-groups";
import type { OrgIndex, OrgSeat } from "@/lib/phoenix-crm/scope";
import { loadPhoenixCrmOrg } from "@/lib/phoenix-crm/server/org";
import { loadPeopleNames, nameOf } from "@/lib/phoenix-crm/server/people";
import { getRepListSummaries, type RepListSummary } from "@/lib/crm/contact-lists";
import { canonicalHrIdKey } from "@/lib/hr-id";
import type { CrmManagerScope } from "@/lib/crm/manager-scope";
import { getRepsListForAgent, type RepsListForRep } from "@/lib/crm/reps-list";
// Month vocabulary is BORROWED, never restated. `monthLabelOf` and `resolveRepDoctorListMonth`
// come from the module that produces the activity itself, and `kpiMonthOptions` from the board that
// already offers the same twelve-month picker. Writing a local copy of any of the three is how two
// screens start disagreeing about which month "August" is — see the DATE DISCIPLINE note in
// rep-doctor-lists.ts on why all of it is string arithmetic and never Date parsing.
import { kpiMonthOptions, type KpiPeriodOption } from "@/lib/crm/kpis-board";
import { monthBounds, monthLabelOf, repDoctorListRepKey, resolveRepDoctorListMonth } from "@/lib/crm/rep-doctor-lists";
import { activityForContact, countUnvisited, type RepsListActivity } from "@/lib/crm/reps-list-activity";
import { loadRepsListActivity } from "@/lib/crm/reps-list-activity-data";
import { cairoTodayIso } from "@/lib/crm/dates";
import { withRepNamesWithheld } from "@/lib/crm/location-confidence";
import { getEmployeeDirectoryRows } from "@/lib/employees/employee-directory";

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
  /**
   * The rep's team — the organogram region and the district manager above the seat — which every board groups its
   * rep cards under (owner, 2026-11-09: "in every screen u build for Hany group reps by their manager and region").
   */
  team: RepTeam;
};

/**
 * One group on a Reps List board: a region and its district manager, ordered exactly as `groupByRegionAndManager`
 * orders every Regional Sales Manager screen. `managerName` is null when no district manager sits above the seat —
 * or when the organogram could not be read, in which case the region alone heads the group.
 */
export type RepTeam = {
  key: string;
  managerName: string | null;
  /** The group's position in region-then-district order; lower reads first. */
  order: number;
  regionName: string;
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

/**
 * Which rep hr-ids the viewer may see, in the shape `restrictCoverageFilterTree` wants.
 *
 * `null` means "no restriction" and is returned ONLY for a company-scoped viewer. A team-scoped
 * viewer whose seat resolves to nobody gets an empty array — never `null` — because the difference
 * between those two is the difference between seeing nothing and seeing everyone.
 *
 * Exported for the Vacant Areas tab, which restricts the same tree by the same rule — a vacancy is
 * offered to a team-scoped viewer only when it stands in a region and line his own reps work.
 */
export function allowedHrIdsFor(scope: CrmManagerScope): readonly string[] | null {
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
   * Rep key -> rep name, COMPANY-WIDE. The key is `repDoctorListRepKey`'s: the CRM id as a string,
   * or `hr:<id>` for a rep with no CRM account. Built here because it is derived from the
   * unrestricted tree this function already holds; what it is for, and why it is the one read that
   * wants the unrestricted tree, is written out where it is built below.
   */
  repNameByRepKey: Map<string, string>;
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

/** The team of a rep the organogram does not place — filed last, under "No region", never under a guess. */
export const NO_TEAM: RepTeam = { key: NO_REGION, managerName: null, order: Number.MAX_SAFE_INTEGER, regionName: NO_REGION };

/**
 * Each matched seat's team: the organogram region and the district manager above it, grouped and ordered by
 * `groupByRegionAndManager` — the one rule every Regional Sales Manager screen follows. A seat the organogram does
 * not hold (or a failed organogram read) falls back to the coverage tree's own region names with no manager, so a
 * card is never dropped and never filed under a guess.
 */
export async function repTeamsFor(
  matched: ReadonlyArray<{ seatId: string }>,
  org: OrgIndex | null,
  coverageRegions: (seatId: string) => string[],
): Promise<Map<string, RepTeam>> {
  const seatIds = [...new Set(matched.map((rep) => rep.seatId))];
  const seatOf = (seatId: string): OrgSeat => {
    const known = org?.seats.get(seatId);
    if (known) return known;
    const regionName = coverageRegions(seatId).join(" · ") || null;
    return { areaName: null, lineCode: null, lineName: null, occupantHrId: null, parentSeatId: null, path: [seatId], regionName, seatId, seatLabel: null, tier: "REP" };
  };
  const groups = groupByRegionAndManager(seatIds, seatOf, (seat) => (org ? districtSeatAbove(org.seats, seat) : null));
  const managerHrIds = groups.flatMap((group) => (group.district?.occupantHrId ? [group.district.occupantHrId] : []));
  const names = managerHrIds.length > 0 ? await loadPeopleNames(managerHrIds).catch(() => null) : null;
  const teams = new Map<string, RepTeam>();
  groups.forEach((group, order) => {
    const district = group.district;
    const managerName = !district
      ? org
        ? "No district manager"
        : null
      : district.occupantHrId
        ? names
          ? nameOf(names, district.occupantHrId, "District manager")
          : "District manager"
        : "District manager seat vacant";
    for (const seatId of group.items) teams.set(seatId, { key: group.key, managerName, order, regionName: group.regionName });
  });
  return teams;
}

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
      repNameByRepKey: new Map<string, string>(),
      reps: [],
      repsIgnoringRep: [],
      scopeLabel,
      scopeReason: input.scope.reason,
      selected: null,
      selection: {},
      syncedAt: null,
    };
  }

  const [companyTree, summaries, org] = await Promise.all([
    loadCoverageFilterTree(),
    getRepListSummaries(),
    // The organogram is read only to group the cards by region and district manager. A failed read costs the
    // grouping its manager names and nothing else — the reps, their lists and every count come from the reads above.
    loadPhoenixCrmOrg().catch(() => null),
  ]);
  // RESTRICT FIRST. Every option list below is derived from `tree`, never from `companyTree`.
  const tree = restrictCoverageFilterTree(companyTree, allowedHrIdsFor(input.scope));

  const selection = pruneLineFirst(tree, resolveCoverageSelection(input.params));
  const narrowed = narrowCoverageOptions(tree, selection);
  const options: CoverageFilterOptions = {
    ...narrowed,
    regions: regionsForLine(tree, selection.line, narrowed.regions),
  };

  // KEYED ON THE CANONICAL HR ID, on both sides. A rep is joined to his list by who he is, never by
  // his CRM account: a rep hired after the cutover has no account, and a join through one reported
  // him as holding no list whatever he held. HR ids are also stored in more than one casing across
  // this system, which `canonicalHrIdKey` absorbs.
  const summaryByHrId = new Map<string, RepListSummary>();
  for (const summary of summaries) {
    const key = canonicalHrIdKey(summary.hrId);
    if (key) summaryByHrId.set(key, summary);
  }
  const summaryFor = (hrId: string | null | undefined): RepListSummary | undefined => {
    const key = canonicalHrIdKey(hrId);
    return key ? summaryByHrId.get(key) : undefined;
  };

  // Area NAMES per seat, so the rep list can show where each person works without ever printing a
  // raw area code at the reader (owner's standing rule). Built once from the restricted tree rather
  // than per rep, because `cells` is the whole org and a per-rep scan of it is quadratic.
  const areaNameByCode = new Map(tree.areas.map((area) => [area.code, area.name]));
  const regionNameByCode = new Map(tree.regions.map((region) => [region.code, region.name]));
  const areaNamesBySeat = new Map<string, Set<string>>();
  const regionNamesBySeat = new Map<string, Set<string>>();
  const addName = (bySeat: Map<string, Set<string>>, seatId: string, name: string | undefined) => {
    if (!name) return;
    let names = bySeat.get(seatId);
    if (!names) {
      names = new Set<string>();
      bySeat.set(seatId, names);
    }
    names.add(name);
  };
  for (const cell of tree.cells) {
    addName(areaNamesBySeat, cell.seatId, areaNameByCode.get(cell.areaCode));
    addName(regionNamesBySeat, cell.seatId, regionNameByCode.get(cell.regionCode));
  }

  // The cascade's reps are the org tree's seated reps — the authority on who exists and who a
  // viewer may see. A rep with no CRM list is kept and reported as holding none, because "this rep
  // has no list in the CRM" is a finding the owner wants to see, not a row to hide.
  // Matched WITHOUT the rep level, then narrowed below. One pass over the tree yields both lists:
  // the one the grid browses and the one the status picker counts.
  const matched = repsMatching(tree, { ...selection, rep: undefined })
    .map((rep) => {
      const summary = summaryFor(rep.hrId);
      return {
        agentCrmId: summary?.agentCrmId ?? null,
        areaNames: [...(areaNamesBySeat.get(rep.seatId) ?? [])].sort((left, right) => left.localeCompare(right)),
        // Contacts are PM + AM. The pharmacy count rides beside them, never inside them.
        contactCount: summary ? summary.pmCount + summary.amCount : 0,
        hrId: rep.hrId,
        name: rep.repName,
        pharmacyCount: summary?.pharmacyCount ?? 0,
        repKey: rep.repKey,
        seatId: rep.seatId,
      };
    })
    .sort((left, right) => left.name.localeCompare(right.name));
  const teams = await repTeamsFor(matched, org, (seatId) =>
    [...(regionNamesBySeat.get(seatId) ?? [])].sort((left, right) => left.localeCompare(right, "en", { numeric: true })),
  );
  const repsIgnoringRep: RepsListRep[] = matched.map(({ seatId, ...rep }) => ({
    ...rep,
    team: teams.get(seatId) ?? NO_TEAM,
  }));

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
  // AND NOT FROM `summaries`. getRepListSummaries constructs every row with `name: ""` and
  // never fills it — the name is resolved against the org tree by whichever board is assembling the
  // screen. Reading `summary.name` here therefore produced an EMPTY MAP, and an empty map means
  // every match is dropped for want of a name: the whole shared-customer feature rendered nothing,
  // on every rep, with no error anywhere. Measured 2026-09-01 — agent 1131 has 18 shared contacts
  // and the board showed 0. Do not reintroduce `summaries` here.
  //
  // The owner was asked directly on 2026-09-01 and approved the one thing this widens: a manager
  // may read the NAME of a rep outside his own team, on a shared row he can already see.
  //
  // KEYED ON THE REP KEY, NOT THE CRM ID. Keyed on the CRM id, a rep hired without an account could
  // never be named, so every customer he shared was dropped and his visits never counted as a second
  // observer. The key is the one the roster and the check-ins are stamped with: the CRM id when the
  // rep has one, otherwise `hr:<id>`. A row that names such a rep by his HR id alone stays unnamed and
  // is skipped, which costs a highlight and never puts the wrong rep's name on a customer.
  const repNameByRepKey = new Map<string, string>();
  for (const rep of companyTree.reps) {
    const key = repDoctorListRepKey(summaryFor(rep.hrId)?.agentCrmId, rep.hrId);
    const name = rep.repName?.trim();
    if (key && name) repNameByRepKey.set(key, name);
  }

  const syncedAt = reps.reduce<string | null>((latest, rep) => {
    const summary = summaryFor(rep.hrId);
    const at = summary?.syncedAt ?? null;
    return at && (!latest || at > latest) ? at : latest;
  }, null);

  return { options, repNameByRepKey, reps, repsIgnoringRep, scopeLabel, scopeReason: null, selected, selection, syncedAt };
}

/**
 * Attach each contact's month activity to the rows, leaving the grouping untouched.
 *
 * Done HERE and not in `getRepsListForAgent` on purpose. That function mirrors the CRM's own
 * contact list and knows nothing about plans or visits, which is exactly what makes it the honest
 * answer to "what was this rep given". The activity is an ANNOTATION over that list, and keeping the
 * two apart is what lets the board still render a complete, correct contact list on a day the plan
 * mirror cannot be read at all.
 *
 * Exported for the Vacant Areas tab, which annotates a departed rep's list the same way.
 */
export function withActivity(
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

/**
 * Tab one's body — the selected rep's contact list and its month activity, over a cascade that has
 * already decided who the viewer may see.
 *
 * Takes the cascade instead of building one, so Reps List and My List are ONE assembly over two
 * reaches: a manager's cascade comes from `buildRepsCascade`, a rep's from `buildOwnListCascade`.
 * A second copy of this body for My List would be the drift this file's header exists to prevent.
 */
async function assembleBoard(cascade: RepsCascade, month: string | undefined): Promise<RepsListBoard> {
  const today = cairoTodayIso();
  // An unparseable or hand-typed month falls back to the Cairo month we are in, never throws — this
  // rides in the URL, so a stale bookmark is a user-reachable input.
  const activityMonth = resolveRepDoctorListMonth(month);
  const monthEnd = monthBounds(activityMonth).to;
  // The same clamp the builder applies internally, restated for the CAPTION so the screen can say
  // how much of the month it is actually reporting on. On the 2nd of a month that matters enormously:
  // every doctor is legitimately unvisited, and a board that did not print the span would read as a
  // catastrophic collapse in coverage rather than as a month that has barely started.
  const activityAsOf = today < monthEnd ? today : monthEnd;

  // The list is found by the rep's HR id, so a rep with no CRM account still gets his list. Gated on
  // the summary counts only — pharmacies included, since a pharmacy-only list is still a list.
  const selectedRep = cascade.selected;
  const hasList = Boolean(selectedRep && selectedRep.contactCount + selectedRep.pharmacyCount > 0);

  // THE ACTIVITY MUST NEVER TAKE THE CONTACT LIST DOWN WITH IT. The list is this board's whole
  // purpose and it comes from a different mirror; the plan mirror is newer than several
  // environments' schemas and `scanPlanEntries` already degrades to empty rather than throwing. A
  // failure here therefore drops the annotation and says so, and the board below still renders every
  // contact — the behaviour this board had before the column existed.
  //
  // A REP WITH NO CRM ACCOUNT GETS HIS ACTIVITY TOO. The loader reads by the CRM id when there is one
  // and by the HR id only when there is not; with neither it answers unavailable, never "unvisited".
  //
  // STARTED BESIDE THE LIST, NOT AFTER IT (2026-10-01, "slow to transfer between page and page"). It
  // needs the rep and the month, never the list, so waiting for the list made the board as slow as
  // both added together. It is only ever READ for a board that has a list, exactly as before, and a
  // failure settles to "unavailable" the moment it happens — so it can never reject unobserved.
  const activityRead: Promise<Map<number, RepsListActivity> | null> =
    hasList && selectedRep && (selectedRep.agentCrmId != null || selectedRep.hrId)
      ? loadRepsListActivity({ agentCrmId: selectedRep.agentCrmId, hrId: selectedRep.hrId, month: activityMonth }).catch(
          () => null,
        )
      : Promise.resolve(null);

  const rawList =
    hasList && selectedRep
      ? await getRepsListForAgent({ agentCrmId: selectedRep.agentCrmId, hrId: selectedRep.hrId }, cascade.repNameByRepKey)
      : null;
  const activityIndex = rawList ? await activityRead : null;

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

/** Assembles tab one — the cascade plus the selected rep's contact list, grouped by brick. */
export async function getRepsListBoard(input: {
  scope: CrmManagerScope;
  params: { area?: string; line?: string; month?: string; region?: string; rep?: string };
}): Promise<RepsListBoard> {
  return assembleBoard(await buildRepsCascade(input), input.params.month);
}

/**
 * My List — the viewer's own contact list, on the same assembly as Reps List. This is the engine the
 * Phoenix CRM List tab loads; the old My List sidebar board was retired 2026-09-25.
 *
 * The caller passes a scope restricted to the session's own HR id — the Phoenix CRM List route hands
 * in `{ agentHrIds: [repHrId], kind: "agents" }`. Everything below is Reps List with three
 * differences, and only three:
 *
 *  - NO PICKER. A rep chooses nobody, so the options and the selection come back empty.
 *  - A REP THE ORGANOGRAM HAS NOT SEATED STILL GETS THEIR LIST. The cascade offers seated reps only,
 *    but a list is found by HR id, so an unseated rep is built from their list summary rather than
 *    told they hold nothing.
 *  - NO PEER IS NAMED. See `UNNAMED_REP` (location-confidence.ts) for the owner's rule this follows.
 */
export async function getMyListBoard(input: {
  scope: CrmManagerScope;
  params: { month?: string };
}): Promise<RepsListBoard> {
  return assembleBoard(await buildOwnListCascade(input.scope), input.params.month);
}

/**
 * The cascade for one rep's own list, built THROUGH `buildRepsCascade` rather than beside it.
 *
 * The rep is selected exactly as a manager selects one — by rep key, off a tree restricted to the
 * scope — so the join to the list, the counts and the sync time are the reviewed ones, not a copy.
 *
 * The shared-customer name map keeps EVERY KEY the manager's board holds and replaces every name.
 * The keys are what a match needs (`findSharedCustomers` drops a partner it has no entry for), so a
 * rep's list shows every shared customer, every partner's visits in the score and every insight a
 * manager sees on it; only the name is withheld.
 */
async function buildOwnListCascade(scope: CrmManagerScope): Promise<RepsCascade> {
  // ONE LIST OR NONE. Any other shape is a caller mistake, and it is refused, never widened.
  const key = scope.kind === "agents" && scope.agentHrIds.length === 1 ? canonicalHrIdKey(scope.agentHrIds[0]) : null;
  if (scope.kind !== "agents" || !key) {
    return buildRepsCascade({
      params: {},
      scope: {
        kind: "none",
        reason:
          scope.kind === "none" ? scope.reason : "My List opens one contact list, your own, and this session did not resolve to one.",
      },
    });
  }

  const hrId = scope.agentHrIds[0];
  const cascade = await buildRepsCascade({ params: { rep: coverageRepKey(hrId) }, scope });

  // A rep holding two seats is two entries under one key. The list is one, and it covers both seats'
  // areas, so the areas are merged rather than taken from whichever seat sorts first.
  const [seat] = cascade.reps;
  let self: RepsListRep | null = seat
    ? {
        ...seat,
        areaNames: [...new Set(cascade.reps.flatMap((rep) => rep.areaNames))].sort((left, right) => left.localeCompare(right)),
      }
    : null;
  let syncedAt = cascade.syncedAt;

  if (!self) {
    const summary = (await getRepListSummaries()).find((candidate) => canonicalHrIdKey(candidate.hrId) === key);
    self = {
      agentCrmId: summary?.agentCrmId ?? null,
      areaNames: [],
      contactCount: summary ? summary.pmCount + summary.amCount : 0,
      // The stored spelling when the summary has one — the session carries the lower-cased key.
      hrId: summary?.hrId ?? hrId,
      name: "",
      pharmacyCount: summary?.pharmacyCount ?? 0,
      repKey: coverageRepKey(hrId),
      team: NO_TEAM,
    };
    syncedAt = summary?.syncedAt ?? null;
  }

  // The organogram falls back to the HR id when a seat carries no name. An id is never printed at a
  // reader, so the name comes from the employee directory then, and is left blank if it has none.
  if (!self.name || self.name === self.hrId) {
    const employee = (await getEmployeeDirectoryRows()).find((row) => canonicalHrIdKey(row.hrId) === key);
    self = { ...self, name: employee?.displayName ?? "" };
  }

  return {
    options: EMPTY_OPTIONS,
    repNameByRepKey: withRepNamesWithheld(cascade.repNameByRepKey),
    reps: [self],
    repsIgnoringRep: [self],
    scopeLabel: cascade.scopeLabel,
    scopeReason: null,
    selected: self,
    selection: {},
    syncedAt,
  };
}

/** Re-exported so the pages never import the cascade module directly. */
export type { CoverageFilterOption, CoverageFilterOptions, CoverageFilterSelection };
