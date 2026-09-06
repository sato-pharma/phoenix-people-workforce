/**
 * Retention risk — the "took the salary and vanished" early warning.
 *
 * WHY THIS EXISTS. Payroll pays part 1 at the start of the month and part 2 the day after, and a
 * recurring pattern is that a rep collects both and resigns immediately. Measured on production
 * 2026-09-06: 23 of 59 recorded resignations (39%) land in the first ten days of a month, and FIVE
 * medical reps resigned on 9 August alone. Four of those five had already stopped logging CRM
 * entries five or more days earlier — the system knew, and told nobody.
 *
 * Backtest of the five-working-day rule over the 106 silent runs since 2026-04-01: 19 were followed
 * by a resignation inside 30 days. Roughly one in five. That is an early warning, not a verdict, and
 * every string this module produces is written that way — it reports the measured fact ("no CRM
 * entry for six working days, last entry 31 August"), never an accusation. Someone silent for a
 * week may be ill, may have a broken phone, or may be leaving; deciding which is HR's job.
 */

/** Which of the two owner-specified rules produced a signal. */
export type RetentionRiskTrigger =
  /** Five or more consecutive working days of recorded leave (Phoenix request or CRM-recorded). */
  | "extended_leave"
  /** Five or more consecutive working days with no CRM entry of any kind. */
  | "crm_silence";

/**
 * One person, as the detector needs to see them.
 *
 * `watchCrmSilence` is the whole reason this is a per-subject flag rather than a global rule.
 * Only a Medical Rep owns a CRM contact list and enters their own visits, so a rep's silence is
 * that rep's own signal. A manager appears in the CRM only when one of their reps remembers to
 * tag them, so a silent manager measures the reps' data entry and nothing else — measured
 * 2026-09-06, the SFE Manager read 26 days silent, the Finance & Admin Manager 52, and the
 * National Sales Manager, Marketing Manager, Group Product Manager and Training Manager all 10.
 * None of them was leaving. This is the same line `logsOwnCrmVisitsTitle` already draws for
 * payroll deductions (src/lib/field-workforce-compliance/eligibility.ts), and it is drawn here
 * for the same reason: charging a manager for a row somebody else forgot to write cost 131,741
 * EGP in July 2026.
 *
 * The leave trigger has no such restriction and applies to everyone — an approved leave record is
 * HR's own writing, not a by-product of somebody else's data entry.
 */
export type RetentionRiskSubject = {
  areaName: string | null;
  /**
   * Earliest date this person's CRM account has ever produced an entry, or null when it never has.
   *
   * A null subject is skipped by the CRM-silence rule entirely: "never logged anything" cannot be
   * told apart from "has no CRM account yet", and a new joiner whose account is still being set up
   * must not be reported as having disappeared. Unmapped CRM accounts are a different problem with
   * its own tripwire — see src/lib/crm/unmapped-alert.ts.
   */
  firstCrmActivityDate: string | null;
  hireDate: string | null;
  hrId: string;
  displayName: string;
  jobTitle: string | null;
  /** Set when the person has already left — no day after it is measured. */
  lastWorkingDate: string | null;
  lineName: string | null;
  managerHrId: string | null;
  managerName: string | null;
  positionTitle: string | null;
  watchCrmSilence: boolean;
};

/** A detected run of consecutive days, already past the threshold. */
export type RetentionRiskSignal = {
  areaName: string | null;
  /**
   * Weekly offs, public holidays and (for `crm_silence`) recorded leave days that fall INSIDE the
   * run. They are bridged rather than counted — see `buildRetentionRiskSignals` — and are carried
   * here so a reader can see the calendar span the run really covers.
   */
  bridgedDates: string[];
  displayName: string;
  /** Last working day of the run. */
  endDate: string;
  hrId: string;
  jobTitle: string | null;
  /** The CRM's most recent entry for this person on or before the window end, null if none. */
  lastCrmActivityDate: string | null;
  lineName: string | null;
  managerHrId: string | null;
  managerName: string | null;
  /** True while the run reaches the last day the data can answer for — it has not ended yet. */
  ongoing: boolean;
  /** First working day of the run. */
  startDate: string;
  trigger: RetentionRiskTrigger;
  /**
   * Working days in the run. Weekly offs and public holidays are never counted, so this is the
   * number the five-day threshold is measured against — never the calendar span, which is longer.
   */
  workingDays: number;
};

export type RetentionRiskDetectionInput = {
  /** Dates on which the CRM holds ANY entry for this person, keyed by canonical hr-id. */
  crmActivityByHrId: ReadonlyMap<string, ReadonlySet<string>>;
  /** Dates this person is recorded as on leave, keyed by canonical hr-id. */
  leaveByHrId: ReadonlyMap<string, ReadonlySet<string>>;
  /**
   * The most recent date CRM data can be trusted for.
   *
   * Never today: reps enter visits through and after the working day, and the mirror syncs three
   * times a day, so a same-day read is empty for everyone and would flag the entire field force
   * every morning.
   */
  measurableThrough: string;
  publicHolidays: ReadonlySet<string>;
  subjects: readonly RetentionRiskSubject[];
  /** Consecutive working days needed to raise a signal. The owner's rule is 5. */
  thresholdWorkingDays: number;
  /** Inclusive last date of the scan. Leave may legitimately run past `measurableThrough`. */
  windowEnd: string;
  /** Inclusive first date of the scan. */
  windowStart: string;
};
