/**
 * Phoenix CRM — which teams are LIVE, and so may be told anything (owner, 2026-10-08).
 *
 * "Bump notifications to people who didn't go live yet. The only ones who go live are Cairo and Giza,
 * and Delta One." A team is live from the moment the Super Admin presses Start on it
 * (`phoenix_crm_team_starts`) until a stop takes effect — NOT from the Saturday it is counted from, because
 * Cairo and Giza reps are already planning and sending the week of 10 October. Everyone else is silent:
 * no in-app notice, no Telegram, no email, no phone, and no pulsing badge, for the rep, the district
 * manager, the SFE Manager and the national sales manager alike.
 *
 * Pure: the database read lives in `server/live-teams.ts`. A team is keyed by its district-manager SEAT,
 * the same key `phoenix_crm_team_starts.team_seat_id` carries and every territory holds as `parentSeatId`.
 */

export type TeamStartWindow = {
  teamSeatId: string;
  /** The Saturday the team goes back to iReports360; null while it runs. */
  stopsOn: string | null;
};

/** The team seats that are live on `cairoToday`: a start with no stop, or a stop that has not yet taken effect. */
export function liveTeamSeatIds(starts: ReadonlyArray<TeamStartWindow>, cairoToday: string): Set<string> {
  const live = new Set<string>();
  for (const start of starts) {
    if (start.stopsOn === null || start.stopsOn > cairoToday) live.add(start.teamSeatId);
  }
  return live;
}

/** Whether a territory (or a team seat itself) belongs to a live team. A seat nobody can place is not live. */
export function seatIsInLiveTeam(
  seat: { seatId: string; parentSeatId?: string | null } | null | undefined,
  live: ReadonlySet<string>,
): boolean {
  if (!seat) return false;
  return live.has(seat.seatId) || (seat.parentSeatId ? live.has(seat.parentSeatId) : false);
}

/**
 * Whether any live team sits BELOW this seat — the rule that moves a regional or national sales manager's
 * week into Phoenix CRM, and the one the notice gate must follow. A team's own seat never counts for itself.
 */
export function seatHasLiveTeamBelow(
  seats: ReadonlyMap<string, { path: ReadonlyArray<string> }>,
  seatId: string,
  live: ReadonlySet<string>,
): boolean {
  for (const liveSeatId of live) {
    if (liveSeatId !== seatId && seats.get(liveSeatId)?.path.includes(seatId)) return true;
  }
  return false;
}

/** One start of a team as every other screen counts it: from its Saturday, until its stop. */
export type TeamCountedWindow = { teamSeatId: string; startsOn: string; stopsOn: string | null };

/**
 * The days, of those given, on which NONE of these teams was counted from Phoenix CRM — before its start, or
 * after its stop (owner, 2026-10-02: "Before the start date, iReports360 stays the source"). A person whose
 * seats sit in no started team has every day here. Pure.
 */
export function daysBeforePhoenixCrm(
  windows: ReadonlyArray<TeamCountedWindow>,
  teamSeatIds: ReadonlySet<string>,
  dates: ReadonlyArray<string>,
): string[] {
  const mine = windows.filter((window) => teamSeatIds.has(window.teamSeatId));
  return dates.filter((date) => !mine.some((window) => window.startsOn <= date && (window.stopsOn === null || date < window.stopsOn)));
}

/** Same question by seat id, through the organogram. */
export function seatIdIsInLiveTeam(
  seats: ReadonlyMap<string, { seatId: string; parentSeatId?: string | null }>,
  seatId: string | null | undefined,
  live: ReadonlySet<string>,
): boolean {
  return seatIsInLiveTeam(seatId ? (seats.get(seatId) ?? null) : null, live);
}
