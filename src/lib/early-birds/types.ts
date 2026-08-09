import type { VisitTimeSource } from "@/lib/crm/reads";
import type { EarlyBirdsPeriod } from "@/lib/early-birds/period";

/** One real field visit, reduced to only what the scorer needs. */
export type EarlyBirdsVisitFact = {
  /** `normalizeHrIdForAccess` of the visiting agent — lowercased AND symbol-stripped, so canonical
   * "B100" and stored "B-100" are one person. `canonicalHrIdKey` keeps hyphens and would not. */
  hrIdKey: string;
  /**
   * The visit's OWN `visit_date`, never the day implied by its timestamp. A rep saving the 10th's
   * visit at 00:30 on the 11th submitted on the 10th; keying off the timestamp files that work
   * under the wrong day and hands the 11th a 00:30 "start time".
   */
  dateIso: string;
  /** Minutes past Cairo midnight of the resolved visit time, or null when no real clock exists. */
  startMinutes: number | null;
  timeSource: VisitTimeSource;
  /** Raw vendor code: 0 Regular, -8 Campaign. */
  visitType: number;
  /**
   * True only when a GPS check-in COULD have matched this visit — i.e. it carries a real contact.
   * Campaign rows never can (pickCheckinForVisit returns null by construction), so they must not
   * sit in the GPS denominator or Campaign work would be punished for lacking evidence it can
   * never have.
   */
  gpsEligible: boolean;
};

/** A rep's period context — everything the scorer needs that is NOT a visit. */
export type EarlyBirdsRepContext = {
  hrIdKey: string;
  /** Stored casing, for writes back to `employees.hr_id`. */
  hrId: string;
  name: string;
  /** Σ fieldWorkforceDeductionDayWeight over the days this rep was expected to work. */
  expectedWorkingDayWeight: number;
  /** Count of those days with weight > 0. */
  expectedWorkingDays: number;
  activeAtPeriodEnd: boolean;
};

/** Directory facts about a rep, for the announcement card and the detail table. */
export type EarlyBirdsRepProfile = {
  hrIdKey: string;
  hrId: string;
  name: string;
  areaName: string | null;
  regionName: string | null;
  lineName: string | null;
  hireDate: string | null;
  hasPhoto: boolean;
  managerHrId: string | null;
  managerName: string | null;
};

export type EarlyBirdsIneligibleReason =
  | "insufficient_active_days"
  | "insufficient_period_coverage"
  | "no_start_time_evidence"
  | "not_active_at_period_end"
  | "no_submissions";

export type EarlyBirdsComponentScores = {
  start: number;
  consistency: number;
  regular: number;
  volume: number;
  firstPlace: number;
};

/** One day of a rep's fortnight, for the timeline the winner panel renders. */
export type EarlyBirdsDayFact = {
  dateIso: string;
  startMinutes: number | null;
  timeSource: VisitTimeSource;
  visits: number;
  /** True when this rep was the day's #1 on the DM's daily board. */
  wonDay: boolean;
  /** 0 on a weekly off — renders as an inert cell rather than a missed day. */
  expectedWeight: number;
};

export type EarlyBirdsRepScore = {
  hrIdKey: string;
  hrId: string;
  name: string;
  totalScore: number;
  baseScore: number;
  qualityWeight: number;
  components: EarlyBirdsComponentScores;
  medianStartMinutes: number | null;
  daysWithSubmission: number;
  expectedWorkingDays: number;
  expectedWorkingDayWeight: number;
  totalVisits: number;
  regularVisits: number;
  campaignVisits: number;
  gpsEligibleVisits: number;
  gpsVerifiedVisits: number;
  /** Days with a real GPS check-in — the days this rep has a verified start at all. The rest are
   * worked-but-unverified, never 'late'. */
  gpsVerifiedDays: number;
  /** null when the rep had no GPS-eligible visit at all — NOT zero. */
  gpsShare: number | null;
  dailyWins: number;
  eligible: boolean;
  ineligibleReasons: EarlyBirdsIneligibleReason[];
  timeline: EarlyBirdsDayFact[];
};

export type EarlyBirdsRanking = {
  period: EarlyBirdsPeriod;
  /** Every rep, eligible first, then ineligible. `rank` is this array's 1-based index. */
  scores: EarlyBirdsRepScore[];
  /** Eligible reps only, in the same order — this is what the DM is offered. */
  candidates: EarlyBirdsRepScore[];
  contestedDays: number;
};
