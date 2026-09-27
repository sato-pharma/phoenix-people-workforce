/**
 * Phoenix CRM — has the field force actually STARTED? (F3 of the owner's plan.)
 *
 * `phoenix_crm_territory_readiness` is read today for a pill on one row. What is nowhere is adoption
 * across the company: which territories have opened the module at all, how long they have had it,
 * and which have had it for weeks and never touched it. Every other board in this module measures
 * work being done; this one measures whether the work has begun, which is a different question and
 * the only one worth asking while a rollout is still landing.
 *
 * ## 🔴 A board naming who has never opened the module must not reach the field
 *
 * That is the whole access rule, and it is the reason this is gated by `readsTeamReports` like the
 * exceptions board and the place-vs-actual report. A rep seeing his own name on a list of people who
 * have not started is being told the system is watching him begin — Golden Rule #1's blind half —
 * and a rep seeing a COLLEAGUE'S name on it is worse.
 *
 * ## Days are counted from the LINE's opening, never from today backwards
 *
 * A territory cannot have adopted a module that was not open to it. Fourteen days of silence on a
 * line that opened yesterday is not silence at all — `daysOpen` is null for an undated line, and a
 * null never becomes a zero, because "we do not know when this opened" and "this opened today" would
 * read the same on screen and only one of them is a finding.
 *
 * ## The four stages, and why "ready" is not the last one
 *
 * Readiness means the carried-over list is finished. It is a milestone, not the goal: a rep can
 * validate all twelve customers in an afternoon and then never enter a visit. So `working` — a
 * countable visit exists — sits above it, and a territory that went ready and stopped is the single
 * most useful row on the board.
 */

/**
 * Most in need of a manager first. The order IS the board's ranking, so moving a line moves the board.
 *
 * 🔴 **`not_open` sits LAST, not first.** It looks like the worst stage and is the only one that is
 * nobody's fault: a territory whose line has not been opened cannot have failed to adopt it, and
 * putting it at the top would bury the territories that HAVE been given the module and ignored it
 * under a list of people waiting for it. `working` is above it for the same reason — a healthy
 * territory is still a territory the rollout reached.
 */
export const ADOPTION_STAGES = [
  {
    key: "never_touched",
    label: "Never opened the module",
    why: "The line is open and nothing at all has been entered from this territory.",
  },
  {
    key: "started",
    label: "Started, list unfinished",
    why: "Something has been entered, but the carried-over list is not finished.",
  },
  { key: "ready", label: "List finished, no visit yet", why: "The list is done and no visit has been entered." },
  { key: "working", label: "Working", why: "The list is moving and visits are being entered." },
  {
    key: "not_open",
    label: "Line not open yet",
    why: "Phoenix CRM has not been opened for this line, so there is nothing to adopt.",
  },
] as const;

export type AdoptionStage = (typeof ADOPTION_STAGES)[number]["key"];

export function adoptionLabel(stage: AdoptionStage): string {
  return ADOPTION_STAGES.find((entry) => entry.key === stage)?.label ?? stage;
}

export function adoptionWhy(stage: AdoptionStage): string {
  return ADOPTION_STAGES.find((entry) => entry.key === stage)?.why ?? "";
}

const STAGE_RANK = new Map<AdoptionStage, number>(ADOPTION_STAGES.map((entry, index) => [entry.key, index]));

/**
 * How long a line may be open before never touching it is worth a manager's attention.
 *
 * A fortnight, not a week: a rollout lands on a line, not on a person, and a rep on leave or in the
 * field for a week is not a rollout problem. Below it a `never_touched` territory is still reported
 * — absence is the fact — but it is not counted as OVERDUE, which is the figure a manager acts on.
 */
export const ADOPTION_GRACE_DAYS = 14;

export type TerritoryAdoption = {
  seatId: string;
  territoryName: string;
  lineName: string | null;
  /** Null for a vacant seat: the board says so rather than printing an empty name. */
  repName: string | null;
  hasRep: boolean;
  stage: AdoptionStage;
  label: string;
  why: string;
  /** Days since the line opened. Null when the line has no date — never 0. */
  daysOpen: number | null;
  /** True only when the line is open, nothing has been entered, and the grace has passed. */
  overdue: boolean;
  /** When the carried-over list was finished, or null. */
  readyAt: string | null;
  /** The first countable visit ever entered here, or null. */
  firstVisitOn: string | null;
  /** Already worded — "3 of 12 validated", "first visit 14 Sept". */
  detail: string | null;
};

export type AdoptionFacts = {
  seatId: string;
  territoryName: string;
  lineName: string | null;
  repName: string | null;
  hasRep: boolean;
  /** Null when the line has no opening date, or the date is in the future. */
  lineOpenedOn: string | null;
  lineIsOpen: boolean;
  /** The carried-over list, or null when it could not be measured. */
  readiness: { total: number; validated: number; dropped: number; dropPending: number; ready: boolean } | null;
  readyAt: string | null;
  /** The first countable visit ever on this seat. */
  firstVisitOn: string | null;
  /** Countable visits ever. Zero and a first visit cannot both be true. */
  visitsEver: number;
};

export type AdoptionRules = { cairoToday: string };

function daysBetween(from: string, to: string): number {
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  if (Number.isNaN(start) || Number.isNaN(end)) return 0;
  return Math.round((end - start) / 86_400_000);
}

/**
 * Has this territory touched the module at all?
 *
 * 🔴 **"Touched" is wider than "visited", deliberately.** A rep who validated three customers and
 * entered no visit HAS started — reporting him beside a territory that has done literally nothing
 * would bury the one that needs a phone call. Any of a validation, a drop, a drop request or a visit
 * counts, which is the same "touched" the exceptions board's `never_opened` rung uses.
 */
function hasTouched(facts: AdoptionFacts): boolean {
  const list = facts.readiness;
  const touchedList = list !== null && list.validated + list.dropped + list.dropPending > 0;
  return touchedList || facts.visitsEver > 0;
}

export function judgeAdoption(facts: AdoptionFacts, rules: AdoptionRules): TerritoryAdoption {
  const daysOpen = facts.lineOpenedOn ? Math.max(0, daysBetween(facts.lineOpenedOn, rules.cairoToday)) : null;
  const base = {
    seatId: facts.seatId,
    territoryName: facts.territoryName,
    lineName: facts.lineName,
    repName: facts.repName,
    hasRep: facts.hasRep,
    daysOpen,
    readyAt: facts.readyAt,
    firstVisitOn: facts.firstVisitOn,
  };
  const of = (stage: AdoptionStage, detail: string | null, overdue = false): TerritoryAdoption => ({
    ...base,
    stage,
    label: adoptionLabel(stage),
    why: adoptionWhy(stage),
    overdue,
    detail,
  });

  // A closed line is the one stage that is nobody's fault, so it can never be overdue and it never
  // carries a "days open" — there is nothing to be open for.
  if (!facts.lineIsOpen) return { ...of("not_open", null), daysOpen: null };

  if (!hasTouched(facts)) {
    // 🔴 Null days never become a zero: an undated line cannot be judged late, and reading "0 days"
    // as "opened today" is how an unknown turns into a finding nobody can defend.
    const overdue = daysOpen !== null && daysOpen > ADOPTION_GRACE_DAYS;
    return of("never_touched", daysOpen === null ? null : `${daysOpen} days since the line opened`, overdue);
  }

  const list = facts.readiness;
  if (facts.visitsEver > 0) {
    const first = facts.firstVisitOn ? `first visit ${facts.firstVisitOn}` : null;
    // Ready AND visiting is the finished state; visiting with the list unfinished is still working.
    if (list !== null && !list.ready) {
      return of("working", [first, `${list.validated} of ${list.total} validated`].filter(Boolean).join(" · "));
    }
    return of("working", first);
  }

  // Touched, no visit. Whether the list is finished is what separates the two rungs — and a territory
  // that finished its list and then entered nothing is the row this board exists to surface.
  if (list !== null && list.ready) return of("ready", facts.readyAt ? `list finished ${facts.readyAt.slice(0, 10)}` : null);
  return of("started", list === null ? null : `${list.validated} of ${list.total} validated`);
}

export type AdoptionSummary = {
  territories: number;
  /** Territories on an open line — the only ones adoption can be measured for. */
  open: number;
  neverTouched: number;
  /** Never touched AND past the grace. The figure a manager acts on. */
  overdue: number;
  ready: number;
  working: number;
  byStage: Array<{ stage: AdoptionStage; label: string; count: number }>;
};

export type AdoptionReport = { rows: TerritoryAdoption[]; summary: AdoptionSummary };

/**
 * Every territory judged, worst first.
 *
 * 🔴 **Unlike the exceptions board, NOTHING is dropped here.** That board answers "what needs you
 * today" and a clean seat is noise; this one answers "how far has the rollout got", and a question
 * about coverage of a rollout cannot be answered by a list that leaves out the territories doing
 * fine. A `working` row is the good news and belongs on the page.
 */
export function buildAdoptionReport(facts: ReadonlyArray<AdoptionFacts>, rules: AdoptionRules): AdoptionReport {
  const rows = facts
    .map((entry) => judgeAdoption(entry, rules))
    .sort(
      (left, right) =>
        (STAGE_RANK.get(left.stage) ?? 99) - (STAGE_RANK.get(right.stage) ?? 99)
        // Inside a stage the longest-open first: a line open 40 days and untouched outranks one open 3.
        || (right.daysOpen ?? -1) - (left.daysOpen ?? -1)
        || left.territoryName.localeCompare(right.territoryName),
    );

  const counts = new Map<AdoptionStage, number>();
  for (const row of rows) counts.set(row.stage, (counts.get(row.stage) ?? 0) + 1);

  return {
    rows,
    summary: {
      territories: rows.length,
      open: rows.filter((row) => row.stage !== "not_open").length,
      neverTouched: rows.filter((row) => row.stage === "never_touched").length,
      overdue: rows.filter((row) => row.overdue).length,
      ready: rows.filter((row) => row.stage === "ready").length,
      working: rows.filter((row) => row.stage === "working").length,
      byStage: ADOPTION_STAGES.flatMap((entry) =>
        counts.has(entry.key) ? [{ stage: entry.key, label: entry.label, count: counts.get(entry.key) as number }] : [],
      ),
    },
  };
}
