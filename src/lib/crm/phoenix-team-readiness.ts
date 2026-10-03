/**
 * IS THIS TEAM READY TO START IN PHOENIX CRM? — the readiness beside the Start button.
 *
 * The owner rolls Phoenix CRM out ONE TEAM AT A TIME and only he presses Start (`/admin/crm`, the
 * "Teams counted from Phoenix CRM" panel — `phoenix-team-starts.ts`). Until this file existed the
 * panel told him what each team IS counted from and nothing at all about whether it is ready to
 * move, so the judgement was made from memory. This is the pure half: the facts in, the row out,
 * no I/O (`phoenix-team-readiness-server.ts` does the reading).
 *
 * ## 🔴 "SEATS FILLED" IS THE MISLEADING NUMBER, AND IT IS NOT THE HEADLINE
 *
 * Measured on production 2026-10-03: **Pedia Upper Egypt 1 reads 6 rep seats, 6 of them filled —
 * and FIVE of those reps were hired between 1 and 4 October and carry no customers at all.** One
 * rep of six has a list. A board headlining "6 of 6 seats filled" says that team is ready; it is
 * the least ready team on the line. So the headline here is **REPS WITH A LIST** — a rep seat
 * carrying at least one real (non-test) Phoenix CRM customer — printed as "N of M reps have a
 * list". Seats filled is still carried, as a secondary fact, because a VACANT seat with a carried
 * list and a FILLED seat with none are different problems and the Super Admin acts differently on
 * each.
 *
 * ## 🔴 A NEW HIRE IS SHOWN, BY NAME, SO AN EMPTY LIST EXPLAINS ITSELF
 *
 * `employees.hire_date` within the last {@link PHOENIX_TEAM_READINESS_WINDOW_DAYS} days. A rep who
 * started four days ago has no list because nobody has built him one yet — that is the rollout
 * working, not a defect. Reading the same zero without the hire dates cost the owner a round trip
 * on 2026-10-03, which is the whole reason the column exists.
 *
 * ## 🔴 ONE PERSON CAN HOLD TWO SEATS, AND EVERY PERSON-SHAPED FIGURE COUNTS HIM ONCE
 *
 * Nosiba Salah Hassanin Moussa (`B-1`) holds BOTH the Anti-Infective Upper Egypt 1 ACTING_DM seat
 * and the `AIF UE1` rep seat under it (production, 2026-10-03). So:
 *   - `people`, `repsWithList` and `newHires` are counts of DISTINCT PEOPLE, keyed on the hr id;
 *   - a person's field visits are taken ONCE, never summed per seat — the visits are keyed by the
 *     person, so adding them up per seat doubles a two-seat rep's activity and makes the team look
 *     busier than it is;
 *   - `managerAlsoRepName` NAMES the district manager who is also sitting in one of his own team's
 *     rep seats, because that is the shape that inflates a count and it must be visible rather
 *     than silently corrected.
 * A per-SEAT figure stays per seat: `repSeats`, `seatsWithList` and the customer totals are counts
 * of seats and of rows, where a second seat is a second real list.
 *
 * ## What is excluded, everywhere
 *
 *   - **Test data.** `phoenix_crm_customers.is_test` — only real rows are counted. On production
 *     2026-10-03 all 13 customers with `status = 'active'` were test rows, so the real validated
 *     count is **0 of 8,344**: a readiness board that forgot the filter would have reported 13
 *     teams' worth of validated lists that do not exist.
 *   - **The pseudo-DM "Others" seats** (`au.seats.is_other_pseudo_dm`) — the per-line sales-only
 *     bucket, which holds no reps and is not a team. It cannot reach the panel today (a team is
 *     read as the parent of a REP seat and these have none), so this is the belt beside the
 *     braces, stated here because the day one gains a child seat is the day it would appear.
 *
 * ## The order: unstarted and most ready, first
 *
 * He is looking for the next team to press Start on, so a team not yet counted from Phoenix CRM
 * sorts above one that is, and within that by the share of its reps that have a list. A started
 * team is kept on the board rather than dropped — it is the comparison, and losing it would hide a
 * team that was started while half its reps had no list.
 */

import { addDaysIso } from "@/lib/crm/dates";
import { countedFromLabel } from "@/lib/crm/phoenix-team-starts";

/** The window the new-hire and field-visit figures are measured over. */
export const PHOENIX_TEAM_READINESS_WINDOW_DAYS = 30;

/** One rep seat of a team, as the reads hand it over. */
export type TeamReadinessRepSeat = {
  seatId: string;
  /** Upper-case hr id, or null when the seat is vacant. */
  occupantHrId: string | null;
  /** The person's display name — names, never hr ids, on every screen. */
  occupantName: string | null;
  /** Real (non-test) Phoenix CRM customers carried on this seat. */
  customers: number;
  /** ...of which validated (`status = 'active'`). */
  validated: number;
  /** `employees.hire_date`, YYYY-MM-DD, or null when it is not known. */
  hireDate: string | null;
  /** The occupant's field visits in the window — a PERSON's figure, so identical on his every seat. */
  visits: number;
};

/** One team — an active DM or ACTING_DM seat — as the reads hand it over. */
export type TeamReadinessFacts = {
  teamSeatId: string;
  /** "Dina Hamdy · Anti Infective · Delta (1)" — the panel's own title, names only. */
  team: string;
  lineName: string | null;
  /** The district manager on the team's own seat, for the two-seat note. Names, never ids. */
  managerHrId: string | null;
  managerName: string | null;
  /** The Saturday it is counted from Phoenix CRM, when a start is running; null when none is. */
  startedOn: string | null;
  /** True when that start is a Saturday still to come. */
  startsLater: boolean;
  /** The per-line sales-only "Others" bucket — never a team. */
  isOtherPseudoDm?: boolean;
  repSeats: TeamReadinessRepSeat[];
};

export type PhoenixTeamReadinessVerdict = "counted" | "ready" | "nearly" | "not_ready";

export type PhoenixTeamReadinessRow = {
  teamSeatId: string;
  team: string;
  lineName: string | null;
  /** Counted from Phoenix CRM already (running or starting on a Saturday to come). */
  started: boolean;
  /** "Counted from Saturday 03 Oct 2026", "From Saturday 10 Oct 2026", or "Not started". */
  startedLine: string;
  /** Rep seats under the team today. The denominator of the headline. */
  repSeats: number;
  /** ...of them with somebody on them. NEVER the headline — see the file header. */
  seatsFilled: number;
  /** Distinct PEOPLE on those seats: a rep holding two seats is one person. */
  people: number;
  /** Rep seats carrying at least one real customer. */
  seatsWithList: number;
  /** Distinct PEOPLE whose seat carries at least one real customer. The headline numerator. */
  repsWithList: number;
  /** "4 of 5 reps have a list". */
  repsWithListLine: string;
  /** Distinct PEOPLE on a rep seat hired inside the window. */
  newHires: number;
  /** Their names, alphabetical — so an empty list explains itself. */
  newHireNames: string[];
  /** Real customers carried across the team's rep seats. */
  customersCarried: number;
  /** ...of them validated (`status = 'active'`). */
  customersValidated: number;
  /** Field visits in the window, summed over DISTINCT people. */
  visits: number;
  /** Rep seats with nobody on them. */
  vacantSeats: number;
  /** The district manager who is also sitting in one of his own team's rep seats, by name. */
  managerAlsoRepName: string | null;
  verdict: PhoenixTeamReadinessVerdict;
  /** What is in the way, in plain words — empty when nothing is. Never an ellipsis. */
  blockers: string[];
  /** repsWithList / repSeats, 0 when the team has no rep seat. For the order only. */
  readyShare: number;
};

export type PhoenixTeamReadinessPanelData = {
  /** False when the figures could not be read — the panel says so instead of showing zeros. */
  readable: boolean;
  cairoToday: string;
  windowDays: number;
  rows: PhoenixTeamReadinessRow[];
};

/** The empty board, for a read that failed or a database without the team-starts table. */
export function unreadableTeamReadiness(cairoToday: string): PhoenixTeamReadinessPanelData {
  return { readable: false, cairoToday, windowDays: PHOENIX_TEAM_READINESS_WINDOW_DAYS, rows: [] };
}

/** The first day of the window — a hire on it is a new hire. */
export function readinessWindowFrom(cairoToday: string): string {
  return addDaysIso(cairoToday, -PHOENIX_TEAM_READINESS_WINDOW_DAYS);
}

function plural(count: number, one: string, many: string): string {
  return count === 1 ? `1 ${one}` : `${count} ${many}`;
}

/** "4 of 5 reps have a list" — the honest headline, never "seats filled". */
export function repsWithListLine(repsWithList: number, repSeats: number): string {
  if (repSeats === 0) return "No rep seat on this team";
  return `${repsWithList} of ${repSeats} ${repSeats === 1 ? "rep has" : "reps have"} a list`;
}

/** One person on the team's rep seats, folded from every seat he holds. */
type Person = { hrId: string; name: string | null; customers: number; hireDate: string | null; visits: number };

function foldPeople(seats: ReadonlyArray<TeamReadinessRepSeat>): Person[] {
  const people = new Map<string, Person>();
  for (const seat of seats) {
    if (!seat.occupantHrId) continue;
    const key = seat.occupantHrId.toUpperCase();
    const held = people.get(key);
    if (!held) {
      people.set(key, {
        hrId: key,
        name: seat.occupantName,
        customers: seat.customers,
        hireDate: seat.hireDate,
        // Taken ONCE, never summed: the visits are the PERSON's, so a second seat would double them.
        visits: seat.visits,
      });
      continue;
    }
    held.customers += seat.customers;
    held.name = held.name ?? seat.occupantName;
    held.hireDate = held.hireDate ?? seat.hireDate;
    held.visits = Math.max(held.visits, seat.visits);
  }
  return [...people.values()];
}

function verdictOf(input: { started: boolean; repSeats: number; repsWithList: number }): PhoenixTeamReadinessVerdict {
  if (input.started) return "counted";
  if (input.repSeats === 0) return "not_ready";
  if (input.repsWithList >= input.repSeats) return "ready";
  return input.repsWithList * 2 >= input.repSeats ? "nearly" : "not_ready";
}

/**
 * One team's readiness. Pure: every figure comes from the facts handed in, and the wording is
 * built here so the test reads exactly what the Super Admin reads.
 */
export function judgeTeamReadiness(facts: TeamReadinessFacts, options: { cairoToday: string }): PhoenixTeamReadinessRow {
  const windowFrom = readinessWindowFrom(options.cairoToday);
  const seats = facts.repSeats;
  const people = foldPeople(seats);
  const managerKey = facts.managerHrId ? facts.managerHrId.toUpperCase() : null;

  const repSeats = seats.length;
  const seatsFilled = seats.filter((seat) => Boolean(seat.occupantHrId)).length;
  const seatsWithList = seats.filter((seat) => seat.customers > 0).length;
  const repsWithList = people.filter((person) => person.customers > 0).length;
  const newHirePeople = people.filter((person) => person.hireDate !== null && person.hireDate >= windowFrom);
  const customersCarried = seats.reduce((total, seat) => total + seat.customers, 0);
  const customersValidated = seats.reduce((total, seat) => total + seat.validated, 0);
  const visits = people.reduce((total, person) => total + person.visits, 0);
  const started = facts.startedOn !== null;

  const managerAlsoRep = managerKey === null ? null : (people.find((person) => person.hrId === managerKey) ?? null);

  const blockers: string[] = [];
  const withoutList = repSeats - repsWithList;
  if (repSeats === 0) {
    blockers.push("No rep seat hangs from this team yet");
  } else {
    if (withoutList > 0) {
      blockers.push(`${plural(withoutList, "rep has", "reps have")} no list yet`);
    }
    if (repSeats - seatsFilled > 0) {
      blockers.push(`${plural(repSeats - seatsFilled, "rep seat is", "rep seats are")} vacant`);
    }
    if (newHirePeople.length > 0) {
      blockers.push(
        `${plural(newHirePeople.length, "rep was", "reps were")} hired in the last ${PHOENIX_TEAM_READINESS_WINDOW_DAYS} days`,
      );
    }
  }

  return {
    teamSeatId: facts.teamSeatId,
    team: facts.team,
    lineName: facts.lineName,
    started,
    startedLine: facts.startedOn
      ? `${facts.startsLater ? "From" : "Counted from"} ${countedFromLabel(facts.startedOn)}`
      : "Not started",
    repSeats,
    seatsFilled,
    people: people.length,
    seatsWithList,
    repsWithList,
    repsWithListLine: repsWithListLine(repsWithList, repSeats),
    newHires: newHirePeople.length,
    newHireNames: newHirePeople
      .map((person) => person.name)
      .filter((name): name is string => Boolean(name))
      .sort((left, right) => left.localeCompare(right)),
    customersCarried,
    customersValidated,
    visits,
    vacantSeats: repSeats - seatsFilled,
    // Named, never silently corrected: a person on two seats is what inflates a count.
    managerAlsoRepName: managerAlsoRep ? (managerAlsoRep.name ?? facts.managerName) : null,
    verdict: verdictOf({ started, repSeats, repsWithList }),
    blockers,
    readyShare: repSeats === 0 ? 0 : repsWithList / repSeats,
  };
}

/**
 * Every team's readiness, unstarted and most ready first — the order the Super Admin reads when he
 * is choosing the next team to press Start on. The "Others" pseudo-DM buckets are dropped: they are
 * sales-only, hold no reps, and are not teams.
 */
export function buildPhoenixTeamReadinessRows(input: {
  teams: ReadonlyArray<TeamReadinessFacts>;
  cairoToday: string;
}): PhoenixTeamReadinessRow[] {
  const rows = input.teams
    .filter((facts) => facts.isOtherPseudoDm !== true)
    .map((facts) => judgeTeamReadiness(facts, { cairoToday: input.cairoToday }));

  return rows.sort(
    (left, right) =>
      Number(left.started) - Number(right.started) ||
      right.readyShare - left.readyShare ||
      right.repsWithList - left.repsWithList ||
      right.customersCarried - left.customersCarried ||
      left.team.localeCompare(right.team),
  );
}
