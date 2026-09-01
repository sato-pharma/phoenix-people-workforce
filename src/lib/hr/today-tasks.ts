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
 * IT MUST COVER THE SEAT'S OWN FUNCTIONS, AND FOR ONE DAY IT DID NOT. The first version emitted
 * tasks for `performance_probation`, `engagement_retention`, `recruiting` and `workforce_insight`
 * only. HR Advisory holds four of those five and got a full panel; HR Operations holds exactly ONE
 * of them, so the panel that answers "what do I do today" answered it for one fifth of her job and
 * said nothing about attendance exceptions, settlements or contract renewals — the work she
 * actually opens this page to do. Fixed 2026-09-01 by adding `time_attendance` and `people_records`.
 *
 * THE TWO REMAINING GAPS ARE DECISIONS, NOT OMISSIONS, and each is argued at its own place in
 * buildHrTodayTasks: `payroll_inputs` is read-only for this seat and its source carries no names,
 * and `hr_governance` has no source at all because its grants are a library and a landing
 * permission. Both are written out below so the next reader does not "finish the set".
 *
 * WHY THE RECRUITING TASKS ARE SHAPED THE WAY THEY ARE. `openRequisitions` and open organogram
 * seats are two different populations, and on the day this was written they did not overlap at all:
 * 45 seats stood open with no requisition raised against any of them, while all three "open"
 * requisitions pointed at seats that had already been filled. A board that prints "Open Vacancies 3"
 * over that state is not merely using a narrow definition — it is reporting zero real recruiting
 * work while 45 empty seats go unmentioned. So the two facts get their own tasks, in her own words:
 * seats with nobody recruiting for them, and requisitions still open on filled seats.
 */

import type { HrFunctionKey } from "@/lib/auth/hr-functions";
import {
  isActiveDirectoryEmployee,
  type EmployeeDirectoryData,
} from "@/lib/employees/employee-directory";
import { isMissingRequiredManager } from "@/lib/employees/hierarchy-governance";
import type { HrCommandSources } from "@/lib/hr/command-center";
import { listUnoccupiedWorkforceSeats } from "@/lib/platform/metrics";
import { isProbationDecisionOutstanding } from "@/lib/probation/service";
import { applicationStageLabels } from "@/lib/recruitment/labels";

/** How many named rows a task shows before it says how many more there are. */
export const ITEM_PREVIEW_LIMIT = 6;

/** Anything waiting this long stops being a queue and becomes a problem. Matches `queueTone`. */
const OVERDUE_DAYS = 5;

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
 * The recruiting picture, split the one way that makes it honest.
 *
 * ONE FUNCTION, TWO READERS — the task list and the Recruiting tiles both call this, so the board
 * and the tasks under it cannot print two different answers to "how much recruiting is live".
 * That is the defect this whole page was rebuilt to remove: on 2026-09-01 the board read
 * "Open Vacancies 3" while 45 seats stood empty, because the tile counted REQUISITIONS and the
 * organogram counted SEATS, and no screen put the two beside each other.
 *
 * Generic on purpose. It needs one field from each row and nothing else, so it can be driven
 * directly by a test with plain literals rather than by a full recruitment dashboard.
 */
export function splitVacanciesByRequisition<
  R extends { status: string; vacancyId: number | null },
  V extends { vacancyId: number },
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
    unrecruitedSeats: vacancies.filter((vacancy) => !requisitionedSeatIds.has(vacancy.vacancyId)),
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

function pluralise(count: number, singular: string, plural: string): string {
  return count === 1 ? singular : plural;
}

/**
 * A date-only column as "05 Sep 2026". Cairo, because the owner reports every time in Cairo.
 *
 * `timeZone: "UTC"` against a `T00:00:00Z` instant is what makes that true rather than ironic: the
 * value is a calendar DAY with no time in it, so re-projecting it into Africa/Cairo would shift a
 * midnight-anchored date and print the day before. The Cairo rule is honoured by NOT converting a
 * value that has no instant to convert. Matches cairoDate in hr-my-record.tsx exactly.
 */
function cairoDay(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const parsed = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return null;
  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "short",
    timeZone: "UTC",
    year: "numeric",
  }).format(parsed);
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
 * task reading zero — "nothing waiting on you" and "this could not be read" are different
 * sentences, and printing the first when the second is true is the one unrecoverable answer a
 * queue can give.
 */
export function buildHrTodayTasks(loaded: HrCommandSources): HrTask[] {
  const tasks: HrTask[] = [];

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

  // ── Time & attendance ──────────────────────────────────────────────────────
  // HR Operations' actual daily queue, and until 2026-09-01 it produced no task at all. Her bundle
  // is people_records / time_attendance / payroll_inputs / performance_probation / hr_governance,
  // and only the fourth of those emitted anything here — so a panel whose whole job is to answer
  // "what do I do today" could speak about exactly one fifth of her job, and stayed silent about
  // the exception queue she works every morning. The tiles knew about it; "Your day" did not.
  if (loaded.attendanceExceptions) {
    const pending = loaded.attendanceExceptions.filter((row) => row.status === "pending");
    tasks.push(
      task({
        action: "Review",
        clearLabel: "Every attendance exception has been decided.",
        detail:
          "A day the attendance rules could not settle on their own. It stays unresolved on the record until you review it.",
        functionKey: "time_attendance",
        href: "/hr/attendance",
        hrefLabel: "Open Attendance",
        items: pending.map((row) => {
          const days = daysSince(row.createdAt);
          return {
            age: waitingLabel(days),
            href: "/hr/attendance",
            id: String(row.id),
            // The DAY in question, then why it was raised. An exception is only meaningful
            // alongside the date it belongs to, and that date is not the date it was raised.
            meta: [cairoDay(row.exceptionDate), row.reason].filter(Boolean).join(" · "),
            // `employeeHrId` is the fallback and never the first choice — the owner's standing
            // rule is a human-readable name, never a raw code.
            name: row.employeeName ?? row.employeeHrId,
            sortKey: days,
            urgent: days >= OVERDUE_DAYS,
          };
        }),
        key: "attendance-exceptions",
        subject: "Attendance exceptions",
        title: (count) =>
          `Review ${count} attendance ${pluralise(count, "exception", "exceptions")}`,
      }),
    );
  }

  // ── People records ─────────────────────────────────────────────────────────
  if (loaded.contracts) {
    // `hr_review` ONLY. The other live statuses are waiting on somebody else — `requested` on the
    // queue, `manager_review` on the line manager — and a task is only a task when the person
    // reading it is the one holding it up.
    const atHrReview = loaded.contracts.rows.flatMap((row) =>
      row.workflow && row.workflow.status === "hr_review" ? [row.workflow] : [],
    );
    tasks.push(
      task({
        action: "Review",
        clearLabel: "No contract renewal is waiting on HR.",
        detail: "The line manager has had their say and the renewal is now sitting on your review.",
        functionKey: "people_records",
        href: "/hr/contracts",
        hrefLabel: "Open Contracts",
        items: atHrReview.map((row) => {
          // Since it REACHED HR, not since the request was raised — the age that matters is how
          // long it has been hers.
          const days = daysSince(row.managerReviewedAt ?? row.createdAt);
          const renewal = cairoDay(row.requestedRenewalDate);
          return {
            age: waitingLabel(days),
            href: "/hr/contracts",
            id: row.id,
            meta: [row.jobTitle, row.lineName, renewal ? `renewal ${renewal}` : null]
              .filter(Boolean)
              .join(" · "),
            name: row.employeeName,
            sortKey: days,
            urgent: days >= OVERDUE_DAYS,
          };
        }),
        key: "contracts-hr-review",
        subject: "Contract renewals",
        title: (count) => `Review ${count} contract ${pluralise(count, "renewal", "renewals")}`,
      }),
    );
  }

  // ── Payroll inputs: NO TASK, deliberately ──────────────────────────────────
  // This is the same decision `hr_governance` takes in TILES_BY_FUNCTION, for a sharper reason.
  // `payroll_inputs` grants `deductions:read` and nothing else: approving a disciplinary penalty
  // is a JD boundary (HR_ROLE_BOUNDARIES), and the owner's standing rule is that the system FLAGS
  // an expense and never decides one. A task is an instruction to ACT, so "Decide 12 deductions"
  // would be this panel telling her to do something she has no grant to do and no authority over.
  // The month's counts stay where they belong — as tiles that report, linking to Payroll
  // Management where she reconciles them.
  //
  // The second reason is narrower and would block it anyway: the loaded source here is
  // getCompanyMonthSummaryByCategory, which returns per-category buckets and no employee names at
  // all. Every row in this panel is a real named record (see the file header); a task built from
  // that source could only list categories, which is a count wearing a row's clothes.

  // ── HR governance: NO TASK ─────────────────────────────────────────────────
  // No source, by construction — SOURCES_BY_FUNCTION.hr_governance is empty because its grants are
  // a document library and a landing permission, neither of which is a queue.

  // ── Engagement & retention ─────────────────────────────────────────────────
  if (loaded.supportRequests) {
    const untouched = loaded.supportRequests.filter((row) => row.status === "Pending");
    tasks.push(
      task({
        action: "Answer",
        clearLabel: "No employee is waiting on a first reply.",
        detail: "An employee has written to HR and nobody has picked it up yet.",
        functionKey: "engagement_retention",
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
    const applications = loaded.recruitment.applications;

    const screening = applications.filter((row) => SCREENING_STAGES.has(row.stage));
    tasks.push(
      task({
        action: "Screen",
        clearLabel: "No CV is waiting to be read.",
        detail: "A candidate has applied and is waiting on your read of the CV.",
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

    const interviews = applications.filter((row) => INTERVIEW_STAGES.has(row.stage));
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
  if (loaded.directory) {
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
        functionKey: "workforce_insight",
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

