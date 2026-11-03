/**
 * The HR Operations Specialist's own landing page — the server half. The owner, 2026-11-03: "in aya
 * the office coordinator account design it to be identical in design and identy to the talnt
 * acqyuisition and godmode premium polish it and add hr calen dars and interview calendar".
 *
 * EVERY FIGURE IS THE REPO'S OWN. The tiles come from the same builders her old page drew
 * (`buildHrCommandGroups`), the tasks from `buildHrTodayTasks` through her seat's fence, the personal
 * record from `loadPersonalRecord`, and the calendar from the Talent Acquisition page's own
 * `loadCalendar`. Her Interview Calendar is a viewer's: the calendar's own services decide that.
 *
 * SHE NEVER SEES A SALARY, AND THIS FILE IS WHERE THAT HAS TO HOLD. The directory rows and the
 * resignations are read on the server and only counts, names, titles and dates leave it. The offers
 * are NEVER read here: `listOffers` selects `*`, which carries the letter's money, so the joiners come
 * from Hiring Documents' narrow `getHiringJoiners`, the same read her Hiring Documents page makes.
 *
 * A READ THAT FAILED IS SAID. Each source fails alone, its card or panel is left out or says so, and
 * the notice at the top of the page names it. Nothing is drawn as a zero.
 */

import type { AccessContext } from "@/lib/auth/permissions";
import { HR_OPERATIONS_SPECIALIST_SEAT, type HrBundleName } from "@/lib/auth/hr-functions";
import { hrefOutsideSeatFence } from "@/lib/auth/seat-page-fences";
import { getContractRenewalDashboardData } from "@/lib/contracts/service";
import { hasMissingEmployeeRecordData } from "@/lib/employees/employee-record-health";
import { getEmployeeDirectory, isActiveDirectoryEmployee } from "@/lib/employees/employee-directory";
import { getHiringJoiners } from "@/lib/hiring-documents/joiners";
import { loadHrOpsReportsQueue } from "@/lib/hr-ops-reports/queue";
import {
  buildHrCommandGroups,
  hrBundleForRole,
  loadPersonalRecord,
  safe,
  SOURCE_LABELS,
  sourcesFor,
  type HrCommandSources,
  type HrCommandTile,
  type HrPersonalRecord,
  type SourceKey,
} from "@/lib/hr/command-center";
import {
  buildHrOperationsScoreboard,
  groupHrOperationsTiles,
  joinerMarks,
  joinersDue,
  peopleLeaving,
  type HrOperationsTileGroup,
} from "@/lib/hr/hr-operations-overview-logic";
import {
  type TalentCalendar,
  type TalentJoiners,
  type TalentKpi,
  type TalentToday,
} from "@/lib/hr/talent-acquisition-logic";
import { loadCalendar } from "@/lib/hr/talent-acquisition-overview";
import { buildHrTodayTasks, type HrTask } from "@/lib/hr/today-tasks";
import { getResignationsDashboardData } from "@/lib/resignations/service";
import { listOnVacationToday, type OnVacationTodayRow } from "@/lib/vacation/on-vacation-today";

export type HrOperationsOverviewData = {
  calendar: TalentCalendar;
  groups: HrOperationsTileGroup<HrCommandTile>[];
  joiners: TalentJoiners & {
    /** Everyone due to join, and how many have had their papers confirmed. Null when the read failed. */
    papers: { confirmed: number; total: number } | null;
  };
  leaving: TalentJoiners;
  onVacationToday: OnVacationTodayRow[] | null;
  personal: HrPersonalRecord;
  scoreboard: TalentKpi[];
  seat: HrBundleName;
  tasks: HrTask[];
  today: TalentToday;
  unavailableSources: string[];
};

export async function getHrOperationsOverview(
  access: AccessContext,
  options: {
    month?: { month: number; year: number } | null;
    now?: Date;
    week?: string | null;
  } = {},
): Promise<HrOperationsOverviewData | null> {
  const seat = hrBundleForRole(access.role);
  if (seat !== HR_OPERATIONS_SPECIALIST_SEAT) return null;

  const now = options.now ?? new Date();

  // Gated on her bundle, exactly as every HR landing page is.
  const needed = new Set(sourcesFor(seat));
  const failures: SourceKey[] = [];
  const loaded: HrCommandSources = {};
  const personalPromise = loadPersonalRecord(access);

  const [joinersData] = await Promise.all([
    getHiringJoiners().catch(() => null),
    needed.has("directory")
      ? safe("directory", () => getEmployeeDirectory(), failures).then((value) => {
          loaded.directory = value;
        })
      : null,
    needed.has("contracts")
      ? safe("contracts", () => getContractRenewalDashboardData(access), failures).then((value) => {
          loaded.contracts = value;
        })
      : null,
    needed.has("resignations")
      ? safe("resignations", () => getResignationsDashboardData(access), failures).then((value) => {
          loaded.resignations = value;
        })
      : null,
    needed.has("hrOpsReports")
      ? safe("hrOpsReports", () => loadHrOpsReportsQueue(), failures).then((value) => {
          loaded.hrOpsReports = value;
        })
      : null,
    needed.has("vacationsToday")
      ? safe("vacationsToday", () => listOnVacationToday(), failures).then((value) => {
          loaded.vacationsToday = value;
        })
      : null,
  ]);

  const marks = joinersData ? joinerMarks(joinersData.joiners) : null;
  const [personal, { calendar, failedMonthWeeks, today }] = await Promise.all([
    personalPromise,
    loadCalendar(access, undefined, {
      joiners: marks ?? [],
      month: options.month ?? null,
      now,
      week: options.week ?? null,
    }),
  ]);

  const pageUnavailable: string[] = [];
  if (!joinersData) pageUnavailable.push("Joiners");
  if (!calendar.interviewCalendar) pageUnavailable.push("Interview calendar");
  if (!calendar.mineLoaded) pageUnavailable.push("Your own interviews");
  if (!calendar.monthItemsLoaded) pageUnavailable.push("Company calendar");
  if (!today.loaded) pageUnavailable.push("Today's interviews");
  if (failedMonthWeeks > 0) pageUnavailable.push("Month interviews");

  const activeEmployees = loaded.directory?.employees.filter((employee) => isActiveDirectoryEmployee(employee));
  const reportsInReview = loaded.hrOpsReports?.reports.filter((report) => report.status === "in_review");
  const papers = joinersData
    ? {
        confirmed: joinersData.joiners.filter((joiner) => joiner.papersConfirmed).length,
        total: joinersData.joiners.length,
      }
    : null;

  return {
    calendar,
    // The figures her old page drew, through its own builder and her seat's fence.
    groups: groupHrOperationsTiles(buildHrCommandGroups(seat, loaded).flatMap((group) => group.tiles)),
    joiners: { ...joinersDue(marks, calendar.todayKey), papers },
    leaving: peopleLeaving(loaded.resignations?.records ?? null, calendar.todayKey),
    onVacationToday: loaded.vacationsToday ?? null,
    personal,
    scoreboard: buildHrOperationsScoreboard({
      joiners: papers,
      records: activeEmployees
        ? {
            active: activeEmployees.length,
            incomplete: activeEmployees.filter((employee) => hasMissingEmployeeRecordData(employee)).length,
          }
        : null,
      reports: reportsInReview
        ? {
            reviewed: reportsInReview.reduce((total, report) => total + report.progress.reviewed, 0),
            toReview: reportsInReview.reduce((total, report) => total + report.progress.toReview, 0),
          }
        : null,
    }),
    seat,
    tasks: buildHrTodayTasks(loaded, seat).flatMap((task) => {
      const href = hrefOutsideSeatFence(seat, task.href);
      if (!href) return [];
      return [
        {
          ...task,
          href,
          items: task.items.map((item) => ({ ...item, href: hrefOutsideSeatFence(seat, item.href) ?? href })),
        },
      ];
    }),
    today,
    unavailableSources: [...new Set([...failures.map((key) => SOURCE_LABELS[key]), ...pageUnavailable])].sort(),
  };
}
