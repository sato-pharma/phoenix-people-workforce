/**
 * Phoenix CRM — the Team tab's one Rep picker (owner, 2026-11-27: "i need 2 be able 2 filter by rep in
 * all tabs", answered "Team's sections"). One choice on the Team tab narrows EVERY section to that rep:
 * the weekly plans, plan edits, monthly plans, off-plan visits, list requests, decided · reverse, the
 * customer lists and the double-visit asks. The two manager sections open on the rep's own manager.
 * The choice stays when he moves between sections.
 *
 * A rep is a PERSON, keyed by his HR id, never a territory: a rep who holds two seats is one choice.
 * An item belongs to him when it names him (its rep's HR id) or, for the kinds that name only a seat
 * (a list request, a plan edit, a double-visit ask), when it sits on one of his seats. An item that
 * names ANOTHER rep is never his, even on his seat — the rep who held the seat before him keeps his own.
 *
 * Pure: the screen hands it what the Team payload already carries, and nothing is read again.
 */

/** What a territory row offers the picker — `TerritorySummary` carries every field. */
export type TeamRepSource = {
  seatId: string;
  name: string;
  repHrId: string | null;
  repName: string | null;
  reviewerHrId: string | null;
};

export type TeamRep = {
  hrId: string;
  name: string;
  /** His seats, in the order they were first met. */
  seatIds: string[];
  /** His territories' names, for the option's label. */
  places: string[];
  /** Who reviews his territories — the manager the two manager sections open on. */
  managerHrIds: string[];
};

/** The reps the picker offers: every occupied territory's rep, once each, A to Z by name. */
export function teamRepsOf(territories: Iterable<TeamRepSource>): TeamRep[] {
  const byHrId = new Map<string, TeamRep>();
  for (const territory of territories) {
    const hrId = territory.repHrId?.trim();
    if (!hrId) continue;
    let rep = byHrId.get(hrId);
    if (!rep) {
      rep = { hrId, name: territory.repName?.trim() || hrId, seatIds: [], places: [], managerHrIds: [] };
      byHrId.set(hrId, rep);
    }
    if (!rep.seatIds.includes(territory.seatId)) {
      rep.seatIds.push(territory.seatId);
      if (territory.name && !rep.places.includes(territory.name)) rep.places.push(territory.name);
    }
    const reviewer = territory.reviewerHrId?.trim();
    if (reviewer && reviewer !== hrId && !rep.managerHrIds.includes(reviewer)) rep.managerHrIds.push(reviewer);
  }
  return [...byHrId.values()].sort((left, right) => left.name.localeCompare(right.name) || left.hrId.localeCompare(right.hrId));
}

/** The option's words: "Mohamed Mehrez · Minia 2". */
export function teamRepLabel(rep: TeamRep): string {
  return rep.places.length > 0 ? `${rep.name} · ${rep.places.join(" · ")}` : rep.name;
}

/** The chosen rep, or null for every rep. A choice no longer on the team reads as every rep. */
export type TeamRepScope = { hrId: string; seatIds: ReadonlySet<string>; managerHrIds: readonly string[] } | null;

export function teamRepScope(reps: readonly TeamRep[], hrId: string | null): TeamRepScope {
  if (!hrId) return null;
  const rep = reps.find((entry) => entry.hrId === hrId);
  if (!rep) return null;
  return { hrId: rep.hrId, seatIds: new Set(rep.seatIds), managerHrIds: rep.managerHrIds };
}

/** What an item says about whose it is: the rep it names, the seat it sits on, or both. */
export type TeamRepOwned = { repHrId?: string | null; seatId?: string | null };

export function inTeamRepScope(scope: TeamRepScope, item: TeamRepOwned): boolean {
  if (!scope) return true;
  const repHrId = item.repHrId?.trim();
  if (repHrId) return repHrId === scope.hrId;
  return Boolean(item.seatId && scope.seatIds.has(item.seatId));
}

export function filterByTeamRep<T>(scope: TeamRepScope, items: readonly T[], ownerOf: (item: T) => TeamRepOwned): T[] {
  return scope ? items.filter((item) => inTeamRepScope(scope, ownerOf(item))) : [...items];
}

/**
 * The manager the two manager sections open on for the chosen rep: the first of his reviewers this viewer
 * can read, or null when none is among them (a manager he does not reach is never asked for — the server
 * answers "not one you read") or the section already shows that one.
 */
export function teamRepManagerToOpen(
  managerHrIds: readonly string[],
  choices: ReadonlyArray<{ hrId: string }> | null,
  showing: string | null,
): string | null {
  if (!choices || choices.length === 0) return null;
  const match = managerHrIds.find((hrId) => choices.some((entry) => entry.hrId === hrId)) ?? null;
  return match && match !== showing ? match : null;
}
