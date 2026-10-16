/**
 * "Your day" — the HR seat's real work, as named rows rather than dials.
 *
 * WHY THIS EXISTS. The command centre's first version opened on a ring reading "5 of 18 waiting".
 * Both numbers were true and neither was useful: the 18 counted TILES, not work, and the 5 counted
 * how many of those tiles happened to be coloured — one of which was lit because it was zero. The
 * owner's verdict on 2026-09-01 was that the panel showed nothing, and he was right. A seat opening
 * her landing page needs the answer to "what do I do today", and the only honest form of that
 * answer is a list of the actual items: this candidate, that probation case, those seats.
 *
 * EVERY ROW IS A REAL RECORD. Nothing here is derived from a count. Each task carries the rows it
 * counted — a candidate with a name, a seat with an area and a manager, an employee whose probation
 * ends on a date — read from the same services the linked pages call, so a task and the page behind
 * it cannot disagree. That is the same rule the tiles follow, applied one level deeper: a tile can
 * be wrong by a definition, a named row can only be wrong by being absent.
 *
 * NOTHING IS SILENTLY CAPPED. A task renders at most `ITEM_PREVIEW_LIMIT` rows, and when it holds
 * more it says so and how many (`totalItems`), because a list that quietly stops at six reads as
 * "there are six" — the misleading truncation AGENTS.md §7 forbids.
 *
 * A TASK WITH NOTHING IN IT STILL RENDERS. The owner's rule for this class of page is "relevant
 * even if empty" — an HR seat that opens on a blank screen learns nothing about what the screen is
 * for. A clear task shows its `clearLabel` in the emerald tone; it never disappears.
 *
 * WHY THE RECRUITING TASKS ARE SHAPED THE WAY THEY ARE. `openRequisitions` and open organogram
 * seats are two different populations, and on the day this was written they did not overlap at all:
 * 45 seats stood open with no requisition raised against any of them, while all three "open"
 * requisitions pointed at seats that had already been filled. A board that prints "Open Vacancies 3"
 * over that state is not merely using a narrow definition — it is reporting zero real recruiting
 * work while 45 empty seats go unmentioned. So the two facts get their own tasks, in her own words:
 * seats with nobody recruiting for them, and requisitions still open on filled seats.
 */

import { HR_ROLE_BUNDLES, type HrBundleName, type HrFunctionKey } from "@/lib/auth/hr-functions";
import {
  isActiveDirectoryEmployee,
  type EmployeeDirectoryData,
} from "@/lib/employees/employee-directory";
import { isMissingRequiredManager } from "@/lib/employees/hierarchy-governance";
import type { HrCommandSources } from "@/lib/hr/command-center";
import { currentCairoDateOnlyIso, formatDateValue } from "@/lib/i18n/format";
import { listUnoccupiedWorkforceSeats } from "@/lib/platform/metrics";
import { isProbationDecisionOutstanding } from "@/lib/probation/service";
import {
  isUnreviewedCandidateStatus,
  normalizeCandidateStatus,
} from "@/lib/recruitment/candidate-status";
import { applicationStageLabels } from "@/lib/recruitment/labels";

/** How many named rows a task shows before it says how many more there are. */
export const ITEM_PREVIEW_LIMIT = 6;

/** Anything waiting this long stops being a queue and becomes a problem. Matches `queueTone`. */
const OVERDUE_DAYS = 5;

/**
 * How far ahead the expiring-contracts task looks, and the point inside that window at which a
 * contract with no renewal request stops being a diary note and becomes a problem.
 *
 * Two numbers rather than one because a renewal is a two-step workflow with a manager in the
 * middle: raising it on the day it lapses is not a renewal, it is a gap in somebody's employment.
 */
const RENEWAL_HORIZON_DAYS = 60;
const RENEWAL_NOTICE_DAYS = 14;

export type HrTaskUrgency = "clear" | "due" | "overdue";

export type HrTaskItem = {
  /** "waiting 6 days", "ends in 3 days", "overdue by 2 days". Null when age says nothing here. */
  age: string | null;
  href: string;
  id: string;
  /** Job title, area, stage — enough context to act without opening the row. */
  meta: string;
  /** The person or the seat, as a human reads it. Never a code (owner's standing rule). */
  name: string;
  /** Sorts the list, oldest and most urgent first. */
  sortKey: number;
  urgent: boolean;
};

export type HrTask = {
  /** The imperative verb this task is. What she DOES, not what the number IS. */
  action: string;
  /** Shown in place of the row list when the count is zero. Never hidden. */
  clearLabel: string;
  count: number;
  /** One line saying what the task means, for a seat that has held the job four days. */
  detail: string;
  functionKey: HrFunctionKey;
  href: string;
  hrefLabel: string;
  items: HrTaskItem[];
  key: string;
  /**
   * The queue's own short name — "Employee requests", "Interviews". Used when the task is CLEAR
   * and collapses out of the row list: a clear queue must still be named, or "nobody has written
   * to HR" and "we do not track that" look the same. See ClearStrip in hr-today-panel.tsx.
   */
  subject: string;
  /** The full row heading: "Screen 2 candidates". */
  title: string;
  /** The true number behind `items`, which is capped at ITEM_PREVIEW_LIMIT. */
  totalItems: number;
  urgency: HrTaskUrgency;
};

/** The statuses that mean a requisition is live recruiting rather than history. */
const OPEN_REQUISITION_STATUSES = new Set(["req_open", "req_published"]);

/** The statuses after which nobody can be moved forward on a requisition any more. */
const DEAD_REQUISITION_STATUSES = new Set(["req_filled", "req_closed", "req_cancelled"]);

/**
 * The directory's open seats, deduped the one way every other seat surface does it.
 *
 * `position_vacancies` stores one row per vacancy EVENT, not one per seat, so the raw lookup
 * reads 45 where the Organogram, the Vacancy Report, the CEO landing and the Admin Data Health
 * card all read 33 — see listUnoccupiedWorkforceSeats for why. Both readers on the HR landing
 * page come through here (the "Vacant Seats" and "Seats Not Recruited" tiles, and the
 * close-the-stale-requisition task), and every one of them LINKS to /hr/reports/vacancies, so a
 * second way of counting seats would put a different number on each of them.
 *
 * Only ACTIVE employees close a seat — a resigned person's seat is still vacant — which is why
 * that filter lives here rather than in each caller.
 */
export function openWorkforceSeats(directory: EmployeeDirectoryData) {
  return listUnoccupiedWorkforceSeats({
    employees: directory.employees.filter((employee) => isActiveDirectoryEmployee(employee)),
    vacancies: directory.lookups.workforceVacancies,
  });
}

/**
 * Seats the owner has ruled to leave empty until he hires into them, so no recruiting queue may ask
 * anyone to "raise a requisition" for them (owner, 2026-09-30: "we will hire soon neglect cairo
 * pedia dm and reps now"; Anti Infective Menoufia 1 is parked the same way). They are still EMPTY
 * seats — the Vacant Seats count and the Vacancy Report keep listing them — they are just not
 * recruiting nobody has started. Matched by line and area NAME, because `position_vacancies` is one
 * row per vacancy EVENT and a seat that empties again gets a new code and a new row id.
 */
const PARKED_SEATS: ReadonlyArray<{ areaNames: readonly string[]; lineName: string }> = [
  { areaNames: ["Cairo", "Heliopolis", "Nasr City", "Cairo East 1", "Cairo East 2", "Cairo West"], lineName: "Pedia" },
  { areaNames: ["Menoufia 1"], lineName: "Anti Infective" },
];

export function isParkedSeat(seat: { areaName?: string | null; lineName?: string | null }): boolean {
  const line = String(seat.lineName ?? "").trim().toLowerCase();
  const area = String(seat.areaName ?? "").trim().toLowerCase();
  if (!line || !area) return false;
  return PARKED_SEATS.some(
    (parked) =>
      parked.lineName.toLowerCase() === line && parked.areaNames.some((name) => name.toLowerCase() === area),
  );
}

/**
 * The recruiting picture, split the one way that makes it honest.
 *
 * ONE FUNCTION, TWO READERS — the task list and the Recruiting tiles both call this, so the board
 * and the tasks under it cannot print two different answers to "how much recruiting is live".
 * That is the defect this whole page was rebuilt to remove: on 2026-09-01 the board read
 * "Open Vacancies 3" while 45 seats stood empty, because the tile counted REQUISITIONS and the
 * organogram counted SEATS, and no screen put the two beside each other.
 *
 * Generic on purpose. It needs one field from each row and nothing else, so it can be driven
 * directly by a test with plain literals rather than by a full recruitment dashboard. A seat's
 * area and line names are read only when the row carries them, to leave the PARKED_SEATS out of
 * `unrecruitedSeats` — and only there: a requisition raised against one still counts as live.
 */
export function splitVacanciesByRequisition<
  R extends { status: string; vacancyId: number | null },
  V extends { areaName?: string | null; lineName?: string | null; vacancyId: number },
>(
  requisitions: readonly R[],
  vacancies: readonly V[],
): {
  /** Requisitions in an open status, whatever the seat behind them says. */
  openRequisitions: R[];
  /** Open requisitions whose seat is already filled — recruiting that is already done. */
  staleRequisitions: R[];
  /** Open seats with no open requisition raised against them — recruiting nobody has started. */
  unrecruitedSeats: V[];
} {
  const openRequisitions = requisitions.filter((row) => OPEN_REQUISITION_STATUSES.has(row.status));
  const openSeatIds = new Set(vacancies.map((vacancy) => vacancy.vacancyId));
  const requisitionedSeatIds = new Set(
    openRequisitions.map((row) => row.vacancyId).filter((id): id is number => typeof id === "number"),
  );
  return {
    openRequisitions,
    staleRequisitions: openRequisitions.filter(
      (row) => row.vacancyId !== null && !openSeatIds.has(row.vacancyId),
    ),
    unrecruitedSeats: vacancies.filter(
      (vacancy) => !requisitionedSeatIds.has(vacancy.vacancyId) && !isParkedSeat(vacancy),
    ),
  };
}

/** Whole days between an ISO timestamp and now, floored at 0. Null input means "no age". */
function daysSince(iso: string | null | undefined): number {
  if (!iso) return 0;
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return 0;
  return Math.max(0, Math.floor((Date.now() - then) / 86_400_000));
}

function waitingLabel(days: number): string {
  if (days <= 0) return "arrived today";
  if (days === 1) return "waiting 1 day";
  return `waiting ${days} days`;
}

/**
 * Whole days from today until a date-only value. NEGATIVE once the date has passed, which is the
 * opposite sign to `daysSince` and deliberately so: every queue added below is measured from a
 * DEADLINE rather than from an arrival, and a lapsed contract or a passed last working day is the
 * thing that needs saying first. Null when there is no date - never 0, which would read as "today".
 *
 * Both ends are pinned to Cairo midnight (the owner reports every time in Africa/Cairo, never raw
 * UTC), so "renews in 1 day" cannot become "renews today" because the server happened to be an
 * hour behind.
 */
function daysUntil(dateOnly: string | null | undefined): number | null {
  if (!dateOnly) return null;
  const target = Date.parse(`${dateOnly.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(target)) return null;
  const today = Date.parse(`${currentCairoDateOnlyIso()}T00:00:00Z`);
  return Math.round((target - today) / 86_400_000);
}

/** "renews in 12 days" / "renews today" / "lapsed 4 days ago". Null input says nothing at all. */
function renewalLabel(days: number | null): string | null {
  if (days === null) return null;
  if (days === 0) return "renews today";
  if (days > 0) return `renews in ${days} ${pluralise(days, "day", "days")}`;
  const late = Math.abs(days);
  return `lapsed ${late} ${pluralise(late, "day", "days")} ago`;
}

/** "last day in 3 days" / "last day is today" / "last day was 9 days ago". */
function lastDayLabel(days: number | null): string | null {
  if (days === null) return null;
  if (days === 0) return "last day is today";
  if (days > 0) return `last day in ${days} ${pluralise(days, "day", "days")}`;
  const past = Math.abs(days);
  return `last day was ${past} ${pluralise(past, "day", "days")} ago`;
}

function pluralise(count: number, singular: string, plural: string): string {
  return count === 1 ? singular : plural;
}

/**
 * Builds one task. `urgency` is derived from the rows themselves rather than passed in, so a task
 * can never be styled as calm while holding something that has waited a fortnight.
 */
function task(input: {
  action: string;
  clearLabel: string;
  detail: string;
  functionKey: HrFunctionKey;
  href: string;
  hrefLabel: string;
  items: HrTaskItem[];
  key: string;
  /** The queue's short name, for when it is clear. See HrTask.subject. */
  subject: string;
  /** Given the count, the heading. Takes the count so the noun can agree with it. */
  title: (count: number) => string;
}): HrTask {
  const sorted = [...input.items].sort((a, b) => b.sortKey - a.sortKey);
  const count = sorted.length;
  const urgency: HrTaskUrgency =
    count === 0 ? "clear" : sorted.some((item) => item.urgent) ? "overdue" : "due";

  return {
    action: input.action,
    clearLabel: input.clearLabel,
    count,
    detail: input.detail,
    functionKey: input.functionKey,
    href: input.href,
    hrefLabel: input.hrefLabel,
    items: sorted.slice(0, ITEM_PREVIEW_LIMIT),
    key: input.key,
    subject: input.subject,
    title: input.title(count),
    totalItems: count,
    urgency,
  };
}

/** The stages that are waiting on HER to read a CV, not on a candidate or a manager to reply. */
const SCREENING_STAGES = new Set(["application_received", "cv_screening", "phone_screening"]);

/** The two candidate statuses that end a person's pipeline: no interview is waiting on either. */
function isClosedCandidateStatus(status: string | null | undefined): boolean {
  const normalized = normalizeCandidateStatus(status);
  return normalized === "rejected" || normalized === "hired";
}

/** Stages where an interview is booked or under way. */
const INTERVIEW_STAGES = new Set([
  "hiring_manager_interview",
  "hr_interview",
  "interview_scheduling",
]);

/**
 * Every task the seat's loaded sources can honestly answer, in the order a working day runs:
 * people first, then the pipeline, then the structure behind it.
 *
 * Returns only the tasks whose SOURCE loaded. A failed source contributes no task rather than a
 * task reading zero - "nothing waiting on you" and "this could not be read" are different
 * sentences, and printing the first when the second is true is the one unrecoverable answer a
 * queue can give.
 *
 * DRIVEN BY THE SOURCES, NOT BY THE SEAT, and that is not an accident: `sourcesFor` in
 * command-center.ts already loads exactly the sources the seat's function bundle justifies, so a
 * task appears if and only if its function is in the bundle. Re-testing the bundle here would be a
 * second copy of that rule, and a second copy is how a seat ends up with a task it cannot action.
 * `seat` is passed for the ONE question the sources genuinely cannot answer - see
 * `directoryFunctionKey` below - and tests/hr-today-tasks.test.ts asserts the equivalence holds by
 * checking every emitted task against `HR_ROLE_BUNDLES[seat]`.
 */
export function buildHrTodayTasks(loaded: HrCommandSources, seat: HrBundleName): HrTask[] {
  const tasks: HrTask[] = [];
  const holds = (functionKey: HrFunctionKey) =>
    (HR_ROLE_BUNDLES[seat] as readonly HrFunctionKey[]).includes(functionKey);

  /**
   * The directory is loaded by TWO different functions - `workforce_insight` for HR Advisory and
   * `people_records` for HR Operations - so the one task built from it belongs to a different
   * function depending on who is looking. Reading `loaded` cannot tell them apart, which is the
   * whole reason `seat` is a parameter. Before 2026-09-01 this was hard-coded to
   * `workforce_insight`, a function HR Operations does not hold, so her only directory task was
   * filed under someone else's heading and drew someone else's icon.
   */
  const directoryFunctionKey: HrFunctionKey = holds("workforce_insight")
    ? "workforce_insight"
    : "people_records";
  /**
   * The same problem for the support desk, which two functions work: `engagement_retention` on HR
   * Advisory and `employee_requests` on the Talent Acquisition seat (2026-10-08).
   */
  const supportFunctionKey: HrFunctionKey = holds("engagement_retention")
    ? "engagement_retention"
    : "employee_requests";

  // ── Performance & probation ────────────────────────────────────────────────
  // First because it is the only one of these with a legal clock on it: a probation decision not
  // taken by the end date is a decision taken by default, in the employee's favour, silently.
  if (loaded.probation) {
    const outstanding = loaded.probation.filter((row) => isProbationDecisionOutstanding(row));
    tasks.push(
      task({
        action: "Decide",
        clearLabel: "Every probation case in the window has a verdict.",
        detail:
          "A probation window that closes without a recorded verdict confirms the employee by default.",
        functionKey: "performance_probation",
        href: "/hr/probation",
        hrefLabel: "Open Probation",
        items: outstanding.map((row) => {
          const remaining = row.days_remaining;
          const overdue = remaining < 0;
          return {
            age: overdue
              ? `overdue by ${Math.abs(remaining)} ${pluralise(Math.abs(remaining), "day", "days")}`
              : remaining === 0
                ? "ends today"
                : `ends in ${remaining} ${pluralise(remaining, "day", "days")}`,
            href: "/hr/probation",
            id: row.hr_id,
            meta: [row.job_title, row.area_name, row.line_name].filter(Boolean).join(" · "),
            name: row.full_name,
            // Most overdue first, then closest to its end date.
            sortKey: 10_000 - remaining,
            urgent: remaining <= 0,
          };
        }),
        key: "probation-verdicts",
        subject: "Probation verdicts",
        title: (count) => `Decide ${count} probation ${pluralise(count, "verdict", "verdicts")}`,
      }),
    );
  }

  // ── The leaver desk: resignations ──────────────────────────────────────────
  // THE OTHER SEAT'S DAY BEGINS HERE. Everything from "Engagement & retention" down was HR
  // Advisory's work — the support inbox, the retention register, the recruiting pipeline — and
  // everything in this block is HR Operations': the leavers, the contracts and the attendance
  // desk. Until 2026-09-01 only the first half existed, and the consequence was not a gap in a
  // list but a broken page: HR Operations holds seven sources, this page already fetched every
  // one of them for her tiles, and exactly two of them (probation and the directory) answered
  // anything here. She opened her own landing page on a two-row panel over a wall of counters —
  // precisely the "reports a number, never the work" failure this panel was built to remove.
  // Each task below reads a source the page ALREADY loads for her: no new fetch, no new grant,
  // no new page, just the named rows behind a figure that was already on the screen.
  //
  // `payroll_inputs` deliberately contributes NO task, and that absence is a decision. Its grant
  // is deductions:READ; the month's decisions are a JD boundary that belongs elsewhere, and a
  // task is an imperative verb. A row she cannot action is not work — it is a reminder that
  // somebody else has some, which is what the Payroll tiles already say, correctly, as figures.
  if (loaded.resignations) {
    const awaitingHr = loaded.resignations.records.filter(
      (row) => row.status === "submitted" || row.status === "under_review",
    );
    tasks.push(
      task({
        action: "Process",
        clearLabel: "No resignation is waiting on HR.",
        detail:
          "A resignation has been submitted and is waiting on HR. Nothing downstream of it can start until it moves — not the final settlement, not the seat going back on the organogram.",
        functionKey: "people_records",
        href: "/hr/resignations",
        hrefLabel: "Open Resignations",
        items: awaitingHr.map((row) => {
          const until = daysUntil(row.effectiveDate);
          return {
            age: lastDayLabel(until),
            href: "/hr/resignations",
            id: row.id,
            meta: [row.jobTitle, row.lineName].filter(Boolean).join(" · "),
            name: row.employeeName,
            // Closest to its effective date first, anything already past it above that. The
            // offset keeps the key positive, so it sorts the same way every other task's does.
            sortKey: until === null ? 0 : 10_000 - until,
            // The LAST WORKING DAY is the deadline here, not the submission date: a resignation
            // still unprocessed a week out is what strands a leaver's pay and their mailbox.
            urgent: until !== null && until <= 7,
          };
        }),
        key: "process-resignations",
        subject: "Resignations",
        title: (count) => `Process ${count} ${pluralise(count, "resignation", "resignations")}`,
      }),
    );
  }

  // NO CLEARANCE TASKS HERE, DELIBERATELY. The Clearance module is being removed (owner,
  // 2026-09-01), so this panel must not grow a dependency on it. Three tasks were written
  // against it and taken back out before merge: Release final settlements, Chase unfinished
  // clearances, and Open a clearance for a departure that never got one.
  //
  // Do NOT re-add them from the clearance source when this list reads thin. Once the module
  // goes, that source stops existing and the reference is a type error, not a missing feature.

  // ── Contracts ──────────────────────────────────────────────────────────────
  if (loaded.contracts) {
    const rows = loaded.contracts.rows;

    // The renewal request has cleared the manager and is sitting on HR.
    const atHrReview = rows.filter((row) => row.workflow?.status === "hr_review");
    tasks.push(
      task({
        action: "Sign off",
        clearLabel: "No contract renewal is waiting on HR.",
        detail:
          "The manager has reviewed this renewal and it is waiting on HR before the new contract can be issued.",
        functionKey: "people_records",
        href: "/hr/contracts",
        hrefLabel: "Open Contract Renewal",
        items: atHrReview.map((row) => {
          const days = daysSince(row.workflow?.managerReviewedAt ?? row.workflow?.createdAt);
          return {
            age: waitingLabel(days),
            href: "/hr/contracts",
            id: row.workflow?.id ?? row.hr_id,
            meta: [row.job_title, row.area].filter(Boolean).join(" · "),
            name: row.full_name,
            sortKey: days,
            urgent: days >= OVERDUE_DAYS,
          };
        }),
        key: "sign-off-contract-renewals",
        subject: "Contract sign-off",
        title: (count) =>
          `Sign off ${count} contract ${pluralise(count, "renewal", "renewals")}`,
      }),
    );

    // THE CONTRACT VERSION OF "SEATS NOT RECRUITED", and the same shape of honesty. The renewal
    // page counts REQUESTS; a contract that reaches its date with no request raised appears in no
    // figure anywhere and simply lapses, with nobody notified. Two populations, one of them
    // invisible — exactly the disagreement the recruiting tasks above this block exist to surface.
    const expiring = rows.filter((row) => {
      if (row.workflow) return false;
      const until = daysUntil(row.contract_renewal_date);
      return until !== null && until <= RENEWAL_HORIZON_DAYS;
    });
    tasks.push(
      task({
        action: "Raise",
        clearLabel: `Every contract due in the next ${RENEWAL_HORIZON_DAYS} days has a renewal behind it.`,
        detail: `The contract reaches its renewal date within ${RENEWAL_HORIZON_DAYS} days and no renewal request has been raised, so it appears in no renewal figure and lapses with nobody notified.`,
        functionKey: "people_records",
        href: "/hr/contracts",
        hrefLabel: "Open Contract Renewal",
        items: expiring.map((row) => {
          const until = daysUntil(row.contract_renewal_date);
          return {
            age: renewalLabel(until),
            href: "/hr/contracts",
            id: row.hr_id,
            meta: [row.job_title, row.area, formatDateValue(row.contract_renewal_date)]
              .filter(Boolean)
              .join(" · "),
            name: row.full_name,
            sortKey: until === null ? 0 : 10_000 - until,
            // Already lapsed, or inside the notice a two-step renewal needs to be issued in.
            urgent: until !== null && until <= RENEWAL_NOTICE_DAYS,
          };
        }),
        key: "raise-contract-renewals",
        subject: "Expiring contracts",
        title: (count) =>
          `Raise a renewal for ${count} expiring ${pluralise(count, "contract", "contracts")}`,
      }),
    );
  }

  // ── The attendance desk ────────────────────────────────────────────────────
  if (loaded.attendanceExceptions) {
    const pending = loaded.attendanceExceptions.filter((row) => row.status === "pending");
    tasks.push(
      task({
        action: "Review",
        clearLabel: "No attendance correction is waiting on a decision.",
        detail:
          "An attendance record has been challenged and the correction is waiting on a decision. Until it is taken the day stands as the device recorded it, and payroll reads that day.",
        functionKey: "time_attendance",
        href: "/hr/attendance",
        hrefLabel: "Open Attendance",
        items: pending.map((row) => {
          const days = daysSince(row.createdAt);
          return {
            age: waitingLabel(days),
            href: "/hr/attendance",
            id: String(row.id),
            meta: [formatDateValue(row.exceptionDate), row.reason].filter(Boolean).join(" · "),
            // The name comes from a join on employees; null means that employee row is gone.
            // Named the way the candidate tasks name a nameless record rather than falling back
            // to a raw HR id — the owner's standing rule is that a screen shows people, never
            // codes. The date and reason in `meta` are what make such a row findable on the page.
            name: row.employeeName ?? "Employee record with no name",
            sortKey: days,
            urgent: days >= OVERDUE_DAYS,
          };
        }),
        key: "review-attendance-exceptions",
        subject: "Attendance exceptions",
        title: (count) =>
          `Review ${count} attendance ${pluralise(count, "exception", "exceptions")}`,
      }),
    );
  }

  // ── Engagement & retention ─────────────────────────────────────────────────
  if (loaded.supportRequests) {
    const untouched = loaded.supportRequests.filter((row) => row.status === "Pending");
    tasks.push(
      task({
        action: "Answer",
        clearLabel: "No employee is waiting on a first reply.",
        detail: "An employee has written to HR and nobody has picked it up yet.",
        functionKey: supportFunctionKey,
        href: "/hr/admin/support-requests",
        hrefLabel: "Open HR Support Requests",
        items: untouched.map((row) => {
          const days = daysSince(row.createdAt);
          return {
            age: waitingLabel(days),
            href: "/hr/admin/support-requests",
            id: row.id,
            meta: [row.category, row.subject].filter(Boolean).join(" · "),
            name: row.employeeName,
            sortKey: days,
            urgent: days >= OVERDUE_DAYS,
          };
        }),
        key: "answer-support-requests",
        subject: "Employee requests",
        title: (count) =>
          `Answer ${count} employee ${pluralise(count, "request", "requests")}`,
      }),
    );
  }

  if (loaded.retention) {
    const overdue = loaded.retention.conversations.filter((row) => row.followUpOverdue);
    tasks.push(
      task({
        action: "Close",
        clearLabel: "Every promise made in a stay discussion is still on time.",
        detail:
          "Something was promised in a stay or exit discussion, the date has passed, and nothing is recorded against it.",
        functionKey: "engagement_retention",
        href: "/hr/retention",
        hrefLabel: "Open Retention Register",
        items: overdue.map((row) => {
          const days = daysSince(row.followUpDue);
          return {
            age: days > 0 ? `overdue by ${days} ${pluralise(days, "day", "days")}` : "due today",
            href: "/hr/retention",
            id: row.id,
            meta: [row.jobTitle, row.followUpAction].filter(Boolean).join(" · "),
            name: row.employeeName,
            sortKey: days,
            urgent: true,
          };
        }),
        key: "retention-follow-ups",
        subject: "Retention follow-ups",
        title: (count) =>
          `Close ${count} overdue ${pluralise(count, "follow-up", "follow-ups")}`,
      }),
    );
  }

  // ── Recruiting ─────────────────────────────────────────────────────────────
  if (loaded.recruitment) {
    // An application on a requisition that is already FILLED, closed or cancelled is waiting on
    // nothing — the seat it was for is gone — so it is not work for her. Measured 2026-10-16: the one
    // "Move 1 interview forward" row was an application sitting at HR interview for 61 days on a
    // requisition whose status was `req_filled`, with no interview booking ever made. No requisition
    // at all (a candidate pooled before one was raised) stays in, as before.
    const applications = loaded.recruitment.applications.filter(
      (row) => !row.requisition || !DEAD_REQUISITION_STATUSES.has(row.requisition.status),
    );

    // THE CANDIDATE'S OWN STATUS DECIDES WHETHER A CV IS STILL WAITING, NOT THE APPLICATION'S STAGE.
    // Every screen that decides on a CV (the pool, shortlist, reject, push to a manager, the offer
    // sync) writes `ats_candidates.status` and none of them moves the application row, so an
    // application stays at "CV screening" for ever after the person is shortlisted, rejected or
    // hired. Measured on production 2026-10-16: all three applications at this stage were decided
    // candidates (shortlisted, rejected, hired) and read "waiting 61 days" on her board. A row with
    // no candidate record at all cannot be judged either way, so it stays on the list.
    const screening = applications.filter(
      (row) =>
        SCREENING_STAGES.has(row.stage) &&
        (!row.candidate || isUnreviewedCandidateStatus(row.candidate.status)),
    );
    tasks.push(
      task({
        action: "Screen",
        clearLabel: "No application against a requisition is waiting on a CV read.",
        detail:
          "A candidate applied against a requisition and nobody has decided on the CV yet — not shortlisted, rejected or sent to a manager.",
        functionKey: "recruiting",
        href: "/hr/cv-database",
        hrefLabel: "Open CV Database",
        items: screening.map((row) => {
          const days = daysSince(row.lastStageChangedAt);
          return {
            age: waitingLabel(days),
            href: "/hr/cv-database",
            id: row.id,
            meta: [
              applicationStageLabels[row.stage],
              row.requisition?.jobTitle ?? null,
            ]
              .filter(Boolean)
              .join(" · "),
            name: row.candidate?.fullName ?? "Candidate record with no name",
            sortKey: days,
            urgent: days >= OVERDUE_DAYS,
          };
        }),
        key: "screen-candidates",
        subject: "CV screening",
        title: (count) => `Screen ${count} ${pluralise(count, "candidate", "candidates")}`,
      }),
    );

    // Same defect as the screening list above: the application's stage is never moved by the
    // screens that decide on a person, so a candidate rejected or hired stays "at interview" on the
    // application for ever. Only those two are CLOSED — shortlisted, backup and with-a-manager are
    // still live piles, so a person there who is genuinely mid-interview stays on the list. A row
    // with no candidate record cannot be judged, so it stays.
    const interviews = applications.filter(
      (row) =>
        INTERVIEW_STAGES.has(row.stage) &&
        (!row.candidate || !isClosedCandidateStatus(row.candidate.status)),
    );
    tasks.push(
      task({
        action: "Move",
        clearLabel: "No interview is sitting still.",
        detail: "An interview is booked or done and the candidate is waiting on the next step.",
        functionKey: "recruiting",
        href: "/hr/recruitment",
        hrefLabel: "Open Recruitment",
        items: interviews.map((row) => {
          const days = daysSince(row.lastStageChangedAt);
          return {
            age: waitingLabel(days),
            href: "/hr/recruitment",
            id: row.id,
            meta: [
              applicationStageLabels[row.stage],
              row.requisition?.jobTitle ?? null,
            ]
              .filter(Boolean)
              .join(" · "),
            name: row.candidate?.fullName ?? "Candidate record with no name",
            sortKey: days,
            urgent: days >= OVERDUE_DAYS,
          };
        }),
        key: "advance-interviews",
        subject: "Interviews",
        title: (count) =>
          `Move ${count} ${pluralise(count, "interview", "interviews")} forward`,
      }),
    );

    // Requisitions still open against a seat that is no longer open. Three of these stood on the
    // board the day this was written, and they were the entire content of "Open Vacancies 3" —
    // one of them Aya's own seat, raised before she was hired and never closed behind her.
    if (loaded.directory) {
      const { staleRequisitions: stale, unrecruitedSeats: unrecruited } =
        splitVacanciesByRequisition(
          loaded.recruitment.requisitions,
          openWorkforceSeats(loaded.directory),
        );
      tasks.push(
        task({
          action: "Close",
          clearLabel: "Every open requisition is against a seat that is genuinely empty.",
          detail:
            "The requisition is still open but the seat behind it has already been filled, so it counts as live recruiting that nobody is doing.",
          functionKey: "recruiting",
          href: "/hr/recruitment",
          hrefLabel: "Open Recruitment",
          items: stale.map((row) => {
            const days = daysSince(row.createdAt);
            return {
              age: `open ${days} ${pluralise(days, "day", "days")}`,
              href: "/hr/recruitment",
              id: row.id,
              meta: [row.requisitionCode, row.hiringManagerName].filter(Boolean).join(" · "),
              name: row.jobTitle,
              sortKey: days,
              urgent: days >= OVERDUE_DAYS,
            };
          }),
          key: "close-filled-requisitions",
          subject: "Filled-seat requisitions",
          title: (count) =>
            `Close ${count} ${pluralise(count, "requisition", "requisitions")} on a filled seat`,
        }),
      );

      // The other half of the same disagreement: seats standing empty with nobody recruiting.
      tasks.push(
        task({
          action: "Raise",
          clearLabel: "Every empty seat has a requisition behind it.",
          detail:
            "The seat is empty in the organogram and no requisition has been raised, so it appears in no recruitment figure at all.",
          functionKey: "recruiting",
          href: "/hr/reports/vacancies",
          hrefLabel: "Open Vacancies Report",
          items: unrecruited.map((vacancy) => ({
            age: null,
            href: "/hr/reports/vacancies",
            id: String(vacancy.vacancyId),
            meta: [vacancy.areaName, vacancy.lineName, vacancy.managerName]
              .filter(Boolean)
              .join(" · "),
            // Both halves are nullable on the lookup row. A seat with neither is a real state and
            // must still be listed — it is the emptiest seat of all — so it is named, not dropped.
            name: vacancy.positionTitle || vacancy.jobTitle || `Seat ${vacancy.vacancyCode}`,
            sortKey: 0,
            urgent: false,
          })),
          key: "raise-requisitions",
          subject: "Empty seats",
          title: (count) =>
            `Raise a requisition for ${count} empty ${pluralise(count, "seat", "seats")}`,
        }),
      );
    }
  }

  if (loaded.offers) {
    const awaiting = loaded.offers.filter((offer) => offer.status === "sent");
    tasks.push(
      task({
        action: "Chase",
        clearLabel: "No offer is waiting on a reply.",
        detail: "The offer has gone out and the candidate has not answered yet.",
        functionKey: "recruiting",
        href: "/hr/offers",
        hrefLabel: "Open Job Offers",
        items: awaiting.map((offer) => {
          const days = daysSince(offer.sentAt);
          return {
            age: waitingLabel(days),
            href: "/hr/offers",
            id: offer.id,
            meta: [offer.title, offer.territory].filter(Boolean).join(" · ") || "Offer sent",
            name: offer.candidateName,
            sortKey: days,
            urgent: days >= OVERDUE_DAYS,
          };
        }),
        key: "chase-offers",
        subject: "Offers out",
        title: (count) => `Chase ${count} unanswered ${pluralise(count, "offer", "offers")}`,
      }),
    );
  }

  // ── Workforce insight ──────────────────────────────────────────────────────
  // Only for the seats whose job a missing manager is. The Talent Acquisition seat loads the
  // directory too — `recruiting` compares requisitions against open seats — but fixing somebody's
  // reporting line is personnel-record work her seat was not given, so the row is not hers to carry.
  if (loaded.directory && (holds("workforce_insight") || holds("people_records"))) {
    // `isMissingRequiredManager`, not a bare `!managerHrId` — the same predicate the No Manager Set
    // tile counts with. A plain null test also catches the seats for which a manager is OPTIONAL
    // (the top of the tree reports to nobody by definition), which put a permanent, unfixable task
    // on her board and made the panel disagree with the tile beside it about the same fact.
    const orphaned = loaded.directory.employees.filter(
      (employee) => isActiveDirectoryEmployee(employee) && isMissingRequiredManager(employee),
    );
    tasks.push(
      task({
        action: "Assign",
        clearLabel: "Every active employee reports to somebody.",
        detail:
          "An employee with no manager is outside every approval chain — their leave, expenses and coaching reach nobody.",
        functionKey: directoryFunctionKey,
        href: "/hr/employee-360",
        hrefLabel: "Open Employee 360",
        items: orphaned.map((employee) => ({
          age: null,
          href: "/hr/employee-360",
          id: employee.hrId,
          meta: [employee.jobTitle, employee.areaName].filter(Boolean).join(" · "),
          name: employee.displayName,
          sortKey: 0,
          urgent: true,
        })),
        key: "assign-managers",
        subject: "Manager assignments",
        title: (count) =>
          `Assign a manager to ${count} ${pluralise(count, "employee", "employees")}`,
      }),
    );
  }

  return tasks;
}

