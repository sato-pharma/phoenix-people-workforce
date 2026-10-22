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
 *
 * 🔴 "LOGGED" COUNTS WHAT THE KPIs COUNT, AND SAYS WHAT IT HELD BACK (re-audit, 2026-10-22). It used to
 * count every saved row, so the 18 October off-plan visits still waiting for approval — in no KPI —
 * stood in a manager's "logged" figure and made it disagree with the calendar and the day page, which
 * count `visitCountsInKpi`. Each visit now carries its `holdBack` (`kpiHoldBackOf`); the held-back
 * ones are counted apart and named on the line, because a visit waiting on somebody is work the rep
 * really did. A refused visit is in neither. "Planned done" still reads any visit: it is the plan's
 * progress, and a planned stop is never an off-plan one.
 */

import type { KpiHoldBack } from "@/lib/phoenix-crm/unplanned-rules";
import type { PhoenixCrmDoctorListType } from "@/lib/phoenix-crm/types";

export type TeamTodayPlanned = { seatId: string; customerId: string; listType: PhoenixCrmDoctorListType };
export type TeamTodayVisit = {
  seatId: string;
  customerId: string;
  listType: PhoenixCrmDoctorListType;
  capturedAt: string;
  /** Why it is in no KPI (`kpiHoldBackOf`); absent or null when it counts. */
  holdBack?: KpiHoldBack | null;
};

export type TeamTodayFigures = {
  /** A plan for this week was sent (submitted or approved) — else there is nothing planned to finish. */
  planSent: boolean;
  amPlanned: number;
  amPlannedDone: number;
  pmPlanned: number;
  pmPlannedDone: number;
  amLogged: number;
  pmLogged: number;
  /** Visits saved today that count in nothing yet: an off-plan visit waiting for the manager and SFE. */
  awaitingApproval: number;
  /** Visits saved today that count in nothing yet: the customer is not validated. */
  awaitingValidation: number;
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
  awaitingApproval: 0,
  awaitingValidation: 0,
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
    // The clock is his activity, so it reads every visit he saved, counted or not.
    if (!figures.lastVisitAt || visit.capturedAt > figures.lastVisitAt) figures.lastVisitAt = visit.capturedAt;
    if (visit.holdBack === "approval") figures.awaitingApproval += 1;
    else if (visit.holdBack === "validation") figures.awaitingValidation += 1;
    if (visit.holdBack) continue;
    if (visit.listType === "AM") figures.amLogged += 1;
    else figures.pmLogged += 1;
  }
  return out;
}

/** The Cairo clock of a visit's server time — the server owns the timezone; the phone never states one. */
export function teamClockOf(capturedAt: string): string {
  return new Intl.DateTimeFormat("en-GB", { hour: "2-digit", hour12: false, minute: "2-digit", timeZone: "Africa/Cairo" }).format(new Date(capturedAt));
}

/**
 * The one line a manager reads: when the rep said he started, then the plan's progress AM and PM
 * apart, then what was logged.
 *
 * 🔴 THE START OPENS THE LINE ONLY WHEN HE PRESSED IT (owner, 2026-10-03). There is deliberately no
 * "not started yet" half: the press never blocks a visit and was never required, so printing its
 * absence would put an alarm on every rep's row at seven in the morning and on every day that passed
 * before the button existed. Absence is read as nothing — the same rule the day page keeps
 * (`day-start-rules.ts`).
 */
export function teamTodayLine(figures: TeamTodayFigures, lastVisitClock: string | null, startedClock?: string | null): string {
  // What is held back is named, never folded in: "waiting" is not yet, and it is not a verdict on him.
  const waiting = [
    figures.awaitingApproval > 0 ? `${figures.awaitingApproval} waiting for approval` : null,
    figures.awaitingValidation > 0 ? `${figures.awaitingValidation} waiting for customer validation` : null,
  ]
    .filter(Boolean)
    .join(", ");
  const held = waiting ? ` · ${waiting}, not counted yet` : "";
  const logged =
    figures.amLogged === 0 && figures.pmLogged === 0 && !waiting
      ? "no visit logged yet"
      : `logged ${figures.amLogged} AM · ${figures.pmLogged} PM${lastVisitClock ? `, last at ${lastVisitClock}` : ""}${held}`;
  const started = startedClock ? `Started ${startedClock} · ` : "";
  if (!figures.planSent) return `${started}No plan sent for today · ${logged}`;
  // A list with nothing planned says so, the way the rep's own Today does — never "0 of 0".
  const half = (list: "AM" | "PM", done: number, planned: number) => (planned === 0 ? `${list} none planned` : `${list} ${done} of ${planned}`);
  return `${started}Planned ${half("AM", figures.amPlannedDone, figures.amPlanned)} · ${half("PM", figures.pmPlannedDone, figures.pmPlanned)} · ${logged}`;
}

/** Where the line sits on the card's colour rule: all planned done, some done, none done, no plan. */
export function teamTodayTone(figures: TeamTodayFigures): "good" | "progress" | "idle" | "none" {
  if (!figures.planSent) return "none";
  // Each half judged on its own — AM and PM are never summed, even for a colour.
  const hasPlanned = figures.amPlanned > 0 || figures.pmPlanned > 0;
  const allDone = figures.amPlannedDone === figures.amPlanned && figures.pmPlannedDone === figures.pmPlanned;
  if (hasPlanned && allDone) return "good";
  const anyActivity =
    figures.amPlannedDone > 0 ||
    figures.pmPlannedDone > 0 ||
    figures.amLogged > 0 ||
    figures.pmLogged > 0 ||
    figures.awaitingApproval > 0 ||
    figures.awaitingValidation > 0;
  return anyActivity ? "progress" : "idle";
}
