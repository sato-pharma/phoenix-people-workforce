import { getEmployeeDirectoryRows } from "@/lib/employees/employee-directory";
import {
  privateCalendarHrIdKey,
  privateCalendarSourceLabels,
  type PrivateCalendarSeverity,
  type PrivateCalendarSource,
} from "@/lib/private-calendar/logic";
import type { PrivateCalendarDataDispute } from "@/lib/private-calendar/disputes";
import { getPrivateCalendarDayEvidence, type PrivateCalendarDayEvidence } from "@/lib/private-calendar/service";

// Everything a reviewer needs to answer "what is she disputing about?" without opening her
// calendar, her plan and the org chart in three other tabs.
//
// WHY (owner, 2026-10-08): the inbox showed `04 Oct 2026 · Weaam Mahmoud (ai-0013) · whole day` over
// three bare strings — "No Activity Recorded", "Traveling", "Manager Confirmation" — and his words
// were *"I don't know what is she disputing about. Make this thing more clear."* Every fact below
// already existed in Phoenix; none of it was on the screen where the decision is taken. Her approved
// plan for that very day said Travel, so the request was decidable in one glance and read as
// unanswerable instead.
//
// Nothing here judges. It is the record beside the claim; the Accept/Reject is still his.

export type DisputeDayFact = {
  /** Only on a `plan` item: the planned activity is itself the day's proof of work (Travel, Admin, Meeting…). */
  coversTheDay: boolean;
  detail: string | null;
  severity: PrivateCalendarSeverity;
  source: PrivateCalendarSource;
  sourceLabel: string;
  time: string | null;
  title: string;
};

export type DisputeContext = {
  areaName: string | null;
  /** The calendar record Phoenix already holds for the disputed day — empty when it genuinely holds none. */
  dayFacts: DisputeDayFact[];
  /**
   * The disputed day's own record could not be read in full. Without this flag an unreadable source
   * renders as "Phoenix holds nothing for this day", which is the confident blank that makes a
   * reviewer reject a true claim.
   */
  dayRecordIncomplete: boolean;
  /**
   * The human label for the ONE record the request targets ("Fingerprint", "CRM visit"…), or null
   * when the request is about the whole day.
   *
   * Resolved here rather than in the component so the inbox does not have to import
   * `private-calendar/logic.ts` into a client bundle — that module pulls in the attendance work
   * schedule and the vacation types behind it.
   */
  itemSourceLabel: string | null;
  jobTitle: string | null;
  lineName: string | null;
  managerName: string | null;
  /** Whole days since the request was raised, Cairo. */
  waitingDays: number;
  /** The disputed date's day of the week — a Friday reads very differently from a Tuesday. */
  weekday: string;
};

export type DisputeWithContext<T> = T & { context: DisputeContext };

const CAIRO = "Africa/Cairo";

/** Whole days between an instant and now, counted on Cairo calendar days so "today" is never -1. */
function cairoDaysSince(iso: string): number {
  const cairoDay = (date: Date) =>
    new Intl.DateTimeFormat("en-CA", { day: "2-digit", month: "2-digit", timeZone: CAIRO, year: "numeric" }).format(date);
  const raised = new Date(iso);
  if (Number.isNaN(raised.getTime())) return 0;
  const from = Date.parse(`${cairoDay(raised)}T00:00:00Z`);
  const to = Date.parse(`${cairoDay(new Date())}T00:00:00Z`);
  if (Number.isNaN(from) || Number.isNaN(to)) return 0;
  return Math.max(0, Math.round((to - from) / 86_400_000));
}

/**
 * The weekday of a DATE-ONLY value, read in UTC on purpose — the same rule the rest of the
 * private calendar follows, so a zone offset can never shift the day being argued about.
 */
function weekdayOf(date: string): string {
  const parsed = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return "";
  return new Intl.DateTimeFormat("en", { timeZone: "UTC", weekday: "long" }).format(parsed);
}

/**
 * Attach the employee's own identity and the day's existing calendar record to each dispute.
 *
 * Best-effort throughout: an employee missing from the directory, or a day whose sources would not
 * read, leaves those fields null/empty and the request still renders. The alternative — failing the
 * inbox — would hide a waiting decision behind a lookup that is only there to explain it.
 */
export async function attachDisputeContext<T extends PrivateCalendarDataDispute>(
  disputes: T[],
): Promise<Array<DisputeWithContext<T>>> {
  if (disputes.length === 0) return [];

  const [directory, evidence] = await Promise.all([
    getEmployeeDirectoryRows().catch(() => []),
    getPrivateCalendarDayEvidence(
      disputes.map((dispute) => ({ date: dispute.disputeDate, employeeHrId: dispute.employeeHrId })),
    ).catch(() => new Map<string, PrivateCalendarDayEvidence>()),
  ]);

  const employeeByKey = new Map(directory.map((employee) => [privateCalendarHrIdKey(employee.hrId), employee]));

  return disputes.map((dispute) => {
    const employee = employeeByKey.get(privateCalendarHrIdKey(dispute.employeeHrId)) ?? null;
    const day = evidence.get(`${privateCalendarHrIdKey(dispute.employeeHrId)}|${dispute.disputeDate}`) ?? null;
    return {
      ...dispute,
      context: {
        areaName: employee?.areaName ?? null,
        dayFacts: (day?.items ?? []).map((item) => ({
          coversTheDay: item.plannedActivityCoversTheDay === true,
          // One line, the richest the item carries — the chip's own stacked lines are for a 1-inch
          // grid cell, and this row has the width for the real sentence.
          detail: item.detailLines[0] ?? item.description ?? null,
          severity: item.severity,
          source: item.source,
          sourceLabel: item.sourceLabel,
          time: item.time,
          title: item.title,
        })),
        dayRecordIncomplete: day === null || (day.unreadableSources?.length ?? 0) > 0,
        itemSourceLabel: dispute.itemSource
          ? privateCalendarSourceLabels[dispute.itemSource] ?? dispute.itemSource
          : null,
        jobTitle: employee?.jobTitle ?? null,
        lineName: employee?.lineName ?? null,
        managerName: employee?.managerName ?? null,
        waitingDays: cairoDaysSince(dispute.createdAt),
        weekday: weekdayOf(dispute.disputeDate),
      },
    };
  });
}
