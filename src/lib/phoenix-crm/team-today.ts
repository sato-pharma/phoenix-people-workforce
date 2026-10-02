/**
 * Phoenix CRM — each rep's day, as his managers read it on the Team tab: how much of today's SENT plan
 * is done, AM and PM apart, how many visits he has logged, and when the last one was.
 *
 * Owner, 2026-09-30: "the best-appearing and easiest CRM, yet controlled". The rep's own screens stay
 * easy and blind; the control is here, with the people who review him. This is his WORK — his plan and
 * his visits — never a judgement of his honesty, so it is his managers' to read (Golden Rule #1 draws
 * that boundary: integrity signals stay with the Super Admin and the SFE Manager, and none is here).
 *
 * AM and PM are never added together (the call rate is never averaged): every figure is a pair.
 * "Planned done" counts a planned customer once he has a visit today; a visit off the plan counts in
 * "logged" and never inflates the plan's figure.
 */

import type { PhoenixCrmDoctorListType } from "@/lib/phoenix-crm/types";

export type TeamTodayPlanned = { seatId: string; customerId: string; listType: PhoenixCrmDoctorListType };
export type TeamTodayVisit = { seatId: string; customerId: string; listType: PhoenixCrmDoctorListType; capturedAt: string };

export type TeamTodayFigures = {
  /** A plan for this week was sent (submitted or approved) — else there is nothing planned to finish. */
  planSent: boolean;
  amPlanned: number;
  amPlannedDone: number;
  pmPlanned: number;
  pmPlannedDone: number;
  amLogged: number;
  pmLogged: number;
  /** The latest visit's server time today, or null before the first. */
  lastVisitAt: string | null;
};

const EMPTY: TeamTodayFigures = {
  planSent: false,
  amPlanned: 0,
  amPlannedDone: 0,
  pmPlanned: 0,
  pmPlannedDone: 0,
  amLogged: 0,
  pmLogged: 0,
  lastVisitAt: null,
};

/** A day with nothing in it yet. */
export function emptyTeamToday(): TeamTodayFigures {
  return { ...EMPTY };
}

/** Every seat asked for gets an answer, so a rep with nothing today reads "nothing", never a gap. */
export function summarizeTeamToday(input: {
  seatIds: ReadonlyArray<string>;
  seatsWithPlan: ReadonlySet<string>;
  planned: ReadonlyArray<TeamTodayPlanned>;
  visits: ReadonlyArray<TeamTodayVisit>;
}): Map<string, TeamTodayFigures> {
  const out = new Map<string, TeamTodayFigures>();
  for (const seatId of input.seatIds) out.set(seatId, { ...EMPTY, planSent: input.seatsWithPlan.has(seatId) });

  const visited = new Set(input.visits.map((visit) => `${visit.seatId}|${visit.customerId}`));
  // A customer planned twice on one day (a stray duplicate row) is one stop, not two.
  const seenPlanned = new Set<string>();
  for (const stop of input.planned) {
    const figures = out.get(stop.seatId);
    const key = `${stop.seatId}|${stop.customerId}`;
    if (!figures || seenPlanned.has(key)) continue;
    seenPlanned.add(key);
    const done = visited.has(key);
    if (stop.listType === "AM") {
      figures.amPlanned += 1;
      if (done) figures.amPlannedDone += 1;
    } else {
      figures.pmPlanned += 1;
      if (done) figures.pmPlannedDone += 1;
    }
  }

  for (const visit of input.visits) {
    const figures = out.get(visit.seatId);
    if (!figures) continue;
    if (visit.listType === "AM") figures.amLogged += 1;
    else figures.pmLogged += 1;
    if (!figures.lastVisitAt || visit.capturedAt > figures.lastVisitAt) figures.lastVisitAt = visit.capturedAt;
  }
  return out;
}

/** The Cairo clock of a visit's server time — the server owns the timezone; the phone never states one. */
export function teamClockOf(capturedAt: string): string {
  return new Intl.DateTimeFormat("en-GB", { hour: "2-digit", hour12: false, minute: "2-digit", timeZone: "Africa/Cairo" }).format(new Date(capturedAt));
}

/** The one line a manager reads: the plan's progress AM and PM apart, then what was logged. */
export function teamTodayLine(figures: TeamTodayFigures, lastVisitClock: string | null): string {
  const logged =
    figures.amLogged === 0 && figures.pmLogged === 0
      ? "no visit logged yet"
      : `logged ${figures.amLogged} AM · ${figures.pmLogged} PM${lastVisitClock ? `, last at ${lastVisitClock}` : ""}`;
  if (!figures.planSent) return `No plan sent for today · ${logged}`;
  // A list with nothing planned says so, the way the rep's own Today does — never "0 of 0".
  const half = (list: "AM" | "PM", done: number, planned: number) => (planned === 0 ? `${list} none planned` : `${list} ${done} of ${planned}`);
  return `Planned ${half("AM", figures.amPlannedDone, figures.amPlanned)} · ${half("PM", figures.pmPlannedDone, figures.pmPlanned)} · ${logged}`;
}

/** Where the line sits on the card's colour rule: all planned done, some done, none done, no plan. */
export function teamTodayTone(figures: TeamTodayFigures): "good" | "progress" | "idle" | "none" {
  if (!figures.planSent) return "none";
  // Each half judged on its own — AM and PM are never summed, even for a colour.
  const hasPlanned = figures.amPlanned > 0 || figures.pmPlanned > 0;
  const allDone = figures.amPlannedDone === figures.amPlanned && figures.pmPlannedDone === figures.pmPlanned;
  if (hasPlanned && allDone) return "good";
  const anyActivity = figures.amPlannedDone > 0 || figures.pmPlannedDone > 0 || figures.amLogged > 0 || figures.pmLogged > 0;
  return anyActivity ? "progress" : "idle";
}
