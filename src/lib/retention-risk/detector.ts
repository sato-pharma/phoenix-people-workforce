/**
 * The pure half of retention-risk detection: calendars in, signals out, no I/O.
 *
 * Everything here is unit-tested in tests/retention-risk-detector.test.ts. The service layer
 * (./service.ts) does the reading; this file owns every rule about what counts.
 */

import { canonicalHrIdKey } from "@/lib/hr-id";
import { isFieldWorkforceWeeklyOff } from "@/lib/field-workforce-compliance/weekend-policy";
import type {
  RetentionRiskDetectionInput,
  RetentionRiskSignal,
  RetentionRiskSubject,
  RetentionRiskTrigger,
} from "@/lib/retention-risk/types";

/**
 * THREE consecutive days. Owner, 2026-09-07: "if an employee not submitting any crm records for 3
 * days until the current day or 3 vacation days until the current".
 *
 * It opened at five, and five turned out to be too slow to be worth anything. The two reps the
 * board caught on 2026-09-07 had stopped working on 31 August; counting from 1 September with the
 * Friday bridged, the fifth working day was the 6th, so the earliest the sweep could speak was
 * 07:40 on the 7th — and HR recorded both resignations at 03:37 that morning. The warning lost to
 * the paperwork by four hours.
 *
 * WORKING days, not calendar days, and that is what makes three usable rather than noisy: a Friday
 * neither counts nor resets, so three means three days a rep was expected in the field and left no
 * trace. Measured against production the moment it changed: two reps, at three and four days.
 */
export const RETENTION_RISK_THRESHOLD_WORKING_DAYS = 3;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function isIsoDateOnly(value: string): boolean {
  return ISO_DATE.test(value);
}

export function addDays(dateIso: string, days: number): string {
  const date = new Date(`${dateIso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** Every date from `start` to `end` inclusive. Empty when the range is inverted. */
export function eachDate(start: string, end: string): string[] {
  if (!isIsoDateOnly(start) || !isIsoDateOnly(end) || start > end) return [];
  const dates: string[] = [];
  for (let date = start; date <= end; date = addDays(date, 1)) dates.push(date);
  return dates;
}

/**
 * How one calendar day is treated when walking a person's timeline.
 *
 *  - `counts`  — a working day that matches the rule being measured; it extends the run.
 *  - `bridges` — a day the rule has nothing to say about; it neither extends nor ends a run.
 *  - `breaks`  — proof the run is over.
 *  - `outside` — before hire, after the last working day, or past what the data can answer.
 *                Ends any open run, exactly like `breaks`, but is named apart because the reason
 *                is "we cannot see" rather than "we saw them working".
 */
type DayVerdict = "breaks" | "bridges" | "counts" | "outside";

/**
 * WHY WEEKLY OFFS AND HOLIDAYS BRIDGE RATHER THAN BREAK.
 *
 * The company week is Saturday to Wednesday full days, Thursday morning, Friday off (and Saturday
 * off for anyone whose title is not field-only) — see weekend-policy.ts. If Friday BROKE a run,
 * every streak would be capped at the Saturday-to-Wednesday block it started in, and a rep who went
 * quiet on Sunday would reset every single week. The longer thresholds would be unreachable and the
 * feature would report nothing, quietly. So a non-working day is skipped: it adds nothing to the
 * count and it does not reset it.
 *
 * The same argument applies to a confirmed public holiday, which is why both are bridged here.
 */
function isNonWorkingDay(dateIso: string, title: string | null, publicHolidays: ReadonlySet<string>): boolean {
  if (publicHolidays.has(dateIso)) return true;
  return isFieldWorkforceWeeklyOff({ dateIso, title });
}

/**
 * The first date a subject can be measured from.
 *
 * The CRM-silence rule needs all three floors. Hire date keeps a new joiner from being reported
 * for the days before they existed; `firstCrmActivityDate` keeps them from being reported for the
 * days before their CRM account produced anything, which is a separate and later date — account
 * setup lags the start date. Without that second floor every new rep is flagged in their first
 * fortnight, which is the fastest way to teach HR to ignore the whole board.
 */
function measurementFloor(subject: RetentionRiskSubject, windowStart: string, trigger: RetentionRiskTrigger): string {
  let floor = windowStart;
  if (subject.hireDate && isIsoDateOnly(subject.hireDate) && subject.hireDate > floor) floor = subject.hireDate;
  if (trigger === "crm_silence" && subject.firstCrmActivityDate && subject.firstCrmActivityDate > floor) {
    floor = subject.firstCrmActivityDate;
  }
  return floor;
}

/** The last date a subject can be measured to. */
function measurementCeiling(subject: RetentionRiskSubject, windowEnd: string, measurableThrough: string, trigger: RetentionRiskTrigger): string {
  // Leave is a record HR wrote, so an approved block dated into next week is readable today and is
  // exactly the signal wanted before payroll. CRM silence is an ABSENCE of rows, so it can only be
  // read up to the last day the mirror can answer for.
  let ceiling = trigger === "crm_silence" ? (windowEnd < measurableThrough ? windowEnd : measurableThrough) : windowEnd;
  if (subject.lastWorkingDate && isIsoDateOnly(subject.lastWorkingDate) && subject.lastWorkingDate < ceiling) {
    ceiling = subject.lastWorkingDate;
  }
  return ceiling;
}

function verdictForLeave(dateIso: string, onLeave: boolean, title: string | null, publicHolidays: ReadonlySet<string>): DayVerdict {
  if (isNonWorkingDay(dateIso, title, publicHolidays)) return "bridges";
  return onLeave ? "counts" : "breaks";
}

/**
 * WHY A LEAVE DAY BRIDGES A SILENCE RUN INSTEAD OF ENDING IT.
 *
 * Approved leave explains the missing rows, so it must not count as silence. But if it also RESET
 * the count, three days of leave in the middle of a fortnight away would split one 10-day
 * disappearance into two 4-day runs and neither would reach the threshold — leave would become the
 * way to hide. Bridging keeps the run whole while counting only the days that are genuinely
 * unexplained, and the leave itself is not lost: a long enough run of leave days raises the
 * `extended_leave` signal in its own right.
 */
function verdictForSilence(
  dateIso: string,
  onLeave: boolean,
  hasCrmEntry: boolean,
  title: string | null,
  publicHolidays: ReadonlySet<string>,
): DayVerdict {
  if (isNonWorkingDay(dateIso, title, publicHolidays)) return "bridges";
  if (onLeave) return "bridges";
  return hasCrmEntry ? "breaks" : "counts";
}

type OpenRun = { bridged: string[]; endDate: string; pendingBridges: string[]; startDate: string; workingDays: number };

type CollectedRun = Pick<RetentionRiskSignal, "bridgedDates" | "endDate" | "startDate" | "workingDays"> & {
  /**
   * True when the run ended because the person was seen again (a CRM entry, or a working day not
   * on leave). False when it ran out of measurable calendar instead — which is what "still going"
   * means, and is the only honest way to compute it: a run whose last counted day is a Wednesday
   * followed by a bridged Thursday and Friday is STILL open, so comparing its end date against the
   * ceiling would call it finished.
   */
  closedByBreak: boolean;
};

/**
 * Walks one subject's calendar for one trigger and returns every run that reached the threshold.
 *
 * `pendingBridges` exists so a run never ends on a weekend. A bridged day after the last counted
 * day is only part of the run if another counted day follows it; otherwise the run's `endDate`
 * would be a Friday nobody was expected to work, which reads as an error on screen.
 */
function collectRuns(input: {
  ceiling: string;
  floor: string;
  publicHolidays: ReadonlySet<string>;
  subject: RetentionRiskSubject;
  threshold: number;
  verdict: (dateIso: string) => DayVerdict;
}): CollectedRun[] {
  const runs: CollectedRun[] = [];
  let open: OpenRun | null = null;

  const close = (closedByBreak: boolean) => {
    if (open && open.workingDays >= input.threshold) {
      runs.push({
        bridgedDates: open.bridged,
        closedByBreak,
        endDate: open.endDate,
        startDate: open.startDate,
        workingDays: open.workingDays,
      });
    }
    open = null;
  };

  for (const dateIso of eachDate(input.floor, input.ceiling)) {
    const verdict = input.verdict(dateIso);
    if (verdict === "counts") {
      if (open) {
        open.bridged.push(...open.pendingBridges);
        open.pendingBridges = [];
        open.endDate = dateIso;
        open.workingDays += 1;
      } else {
        open = { bridged: [], endDate: dateIso, pendingBridges: [], startDate: dateIso, workingDays: 1 };
      }
      continue;
    }
    if (verdict === "bridges") {
      if (open) open.pendingBridges.push(dateIso);
      continue;
    }
    // `breaks` means they were seen; `outside` cannot occur here because the floor/ceiling already
    // clipped the walk to the measurable range.
    close(true);
  }
  close(false);
  return runs;
}

/**
 * Every retention-risk signal in the window, newest and longest first.
 *
 * Hr ids are mixed case throughout this system, so every lookup goes through `canonicalHrIdKey` —
 * a plain equality check silently under-returns and would report a working rep as silent.
 */
export function buildRetentionRiskSignals(input: RetentionRiskDetectionInput): RetentionRiskSignal[] {
  const threshold = Math.max(1, Math.trunc(input.thresholdWorkingDays));
  const signals: RetentionRiskSignal[] = [];

  for (const subject of input.subjects) {
    const key = canonicalHrIdKey(subject.hrId);
    if (!key) continue;
    const activity = input.crmActivityByHrId.get(key) ?? new Set<string>();
    const leave = input.leaveByHrId.get(key) ?? new Set<string>();
    const title = subject.jobTitle ?? subject.positionTitle ?? null;


    const triggers: RetentionRiskTrigger[] = subject.watchCrmSilence
      ? ["crm_silence", "extended_leave"]
      : ["extended_leave"];

    for (const trigger of triggers) {
      // A subject whose CRM account has never produced a row cannot be measured for silence —
      // see RetentionRiskSubject.firstCrmActivityDate.
      if (trigger === "crm_silence" && !subject.firstCrmActivityDate) continue;

      const floor = measurementFloor(subject, input.windowStart, trigger);
      const ceiling = measurementCeiling(subject, input.windowEnd, input.measurableThrough, trigger);
      if (floor > ceiling) continue;

      const runs = collectRuns({
        ceiling,
        floor,
        publicHolidays: input.publicHolidays,
        subject,
        threshold,
        verdict: (dateIso) =>
          trigger === "extended_leave"
            ? verdictForLeave(dateIso, leave.has(dateIso), title, input.publicHolidays)
            : verdictForSilence(dateIso, leave.has(dateIso), activity.has(dateIso), title, input.publicHolidays),
      });

      for (const run of runs) {
        // "didn't return to work yet or seen" — a run the person ended by being seen again is not a
        // resignation risk, it is somebody who came back.
        if (input.openRunsOnly && run.closedByBreak) continue;
        // The last entry BEFORE this run began — never the newest entry overall. Computed per run
        // because a subject can have several: on the first live board a rep whose gap ran 3 to 17
        // August was shown "Last CRM entry 6 September", which is the max across the window and
        // reads as though nothing was ever wrong.
        let lastCrmActivityDate: string | null = null;
        for (const dateIso of activity) {
          if (dateIso < run.startDate && (lastCrmActivityDate === null || dateIso > lastCrmActivityDate)) {
            lastCrmActivityDate = dateIso;
          }
        }

        signals.push({
          areaName: subject.areaName,
          bridgedDates: run.bridgedDates,
          displayName: subject.displayName,
          endDate: run.endDate,
          hrId: subject.hrId,
          jobTitle: subject.jobTitle,
          lastCrmActivityDate,
          lineName: subject.lineName,
          managerHrId: subject.managerHrId,
          managerName: subject.managerName,
          // "Still going" is the absence of a day that ended it — never a date comparison against
          // today. See CollectedRun.closedByBreak.
          ongoing: !run.closedByBreak,
          startDate: run.startDate,
          trigger,
          workingDays: run.workingDays,
        });
      }
    }
  }

  // Ongoing before closed, then longest, then most recent — the order HR should work them in.
  return signals.sort((left, right) => {
    if (left.ongoing !== right.ongoing) return left.ongoing ? -1 : 1;
    if (left.workingDays !== right.workingDays) return right.workingDays - left.workingDays;
    if (left.endDate !== right.endDate) return right.endDate.localeCompare(left.endDate);
    return left.displayName.localeCompare(right.displayName);
  });
}

/**
 * The stable identity of one run, for de-duplicating notifications.
 *
 * Keyed on the run's START date, never its end: an ongoing run grows a day at a time, and keying
 * on the end would re-announce the same person every morning for as long as they stayed away.
 */
export function retentionRiskSignalKey(signal: Pick<RetentionRiskSignal, "hrId" | "startDate" | "trigger">): string {
  return `${signal.trigger}:${canonicalHrIdKey(signal.hrId) ?? signal.hrId}:${signal.startDate}`;
}
