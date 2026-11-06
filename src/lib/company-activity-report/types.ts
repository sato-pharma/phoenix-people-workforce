import type { PhoenixVisitDetail } from "@/lib/crm/phoenix-visit-detail";
/**
 * Company Activity Report — day-by-day account of what every employee actually did over a freely
 * chosen date range: CRM field/campaign visits, office attendance, leave activity, and days with
 * nothing recorded. Owner-confirmed 2026-08-28: this is NOT a payroll report — it exists purely for
 * awareness/accuracy, so leave is shown with its real status (including pending) rather than
 * collapsed to a payroll-style approved-only yes/no, and a day where CRM shows real activity AND a
 * leave request covers it is flagged as a CONFLICT rather than silently resolved either way.
 *
 * Deliberately separate from Private Calendar (owner instruction) and from the payroll digest
 * engine — it reuses that engine's FACT SOURCES (classifyAttendanceDay, getCompanyWideOutageDates,
 * crmDayVisitTypeStatus) but never its payroll-only judgment (flex-hour tiers, deduction brackets),
 * because this report answers a different question: not "should this day be judged for a
 * deduction" but "what actually happened".
 */

export type CompanyActivityMultiSelectMode = "include" | "exclude";

export type CompanyActivityFilters = {
  lineNames: string[];
  lineMode: CompanyActivityMultiSelectMode;
  teamNames: string[];
  teamMode: CompanyActivityMultiSelectMode;
  areaNames: string[];
  areaMode: CompanyActivityMultiSelectMode;
  regionNames: string[];
  regionMode: CompanyActivityMultiSelectMode;
  /** Single-select. "All" means unfiltered. */
  jobTitle: string;
  /** Free-text match against employee name / HR ID. */
  query: string;
};

/**
 * What a single day resolves to, for display/coloring/counting. `conflict` is layered
 * independently (see reconcile.ts) — a conflicted day still gets a real primary outcome, it is
 * never hidden behind a generic "conflict" bucket.
 */
export type CompanyActivityDayOutcome =
  | "office_present"
  | "crm_field_visit"
  | "crm_leave"
  | "leave_approved"
  | "leave_pending"
  | "device_outage"
  | "no_signal"
  | "no_entry"
  | "weekly_off"
  | "holiday"
  | "future"
  /** A day strictly after a TERMINAL employee's own lastWorkingDate — see reconcile.ts. Distinct
   * from no_entry/no_signal on purpose: those read as "nothing recorded" or "no way to observe
   * them", both of which wrongly imply this person still works here. This outcome says plainly
   * that they do not, and it is excluded from every working-day rollup (summary.ts), never counted
   * as an absence or a gap. */
  | "after_exit";

export type CompanyActivityVisitDetail = {
  visitType: number | null;
  /** Display label, from resolveVisitTypeLabel — never a raw numeric code shown to a reader. */
  label: string;
  bucket: "regular" | "campaign" | "training" | "admin";
  /** visitType === -8 exactly (classifyVisit's "campaign" bucket) — the owner's specific
   * "campaign visits" ask, deliberately narrower than the CP/field-work bucket used to explain
   * office-punch absences. */
  isCampaign: boolean;
  session: string | null;
  contactName: string | null;
  customerName: string | null;
  comment: string | null;
  /** True when this visit has neither agent_hr_id nor double_hr_id resolved — part of this
   * report's activity only by virtue of appearing in a wanted-id fetch; see crm-detail.ts. */
  attributionUncertain: boolean;
  /** A chain visit's SECOND manager. Phoenix-only — the vendor feed had one partner column. */
  partner2Name: string | null;
  /** The Phoenix field set, shaped to THIS reader's tier (`phoenix-visit-detail.ts`). Null on a vendor
   * row, where there is nothing behind it: the cell then reads exactly as it always did. */
  phoenix: PhoenixVisitDetail | null;
};

export type CompanyActivityLeaveDetail = {
  id: string;
  vacationType: string | null;
  /** Raw v2_vacation_requests.status — shown as-is, never collapsed to approved/not. */
  status: string;
  managerDecision: string | null;
  covered: boolean;
  dayPart: string | null;
  notes: string | null;
};

export type CompanyActivityDayRow = {
  employeeHrId: string;
  dateIso: string;
  weekday: string;
  /** "after_exit" — a day strictly after a terminal employee's own lastWorkingDate — is excluded
   * from working-day rollups exactly like weekly_off/holiday/future are, via the same `dayType !==
   * "working"` check every consumer already uses (summary.ts, reconcile.ts's conflict flag). */
  dayType: "working" | "weekly_off" | "holiday" | "future" | "after_exit";
  outcome: CompanyActivityDayOutcome;
  /** Human-readable explanation — always populated, including for no_entry. */
  reason: string;
  crmVisits: CompanyActivityVisitDetail[];
  crmVisitCount: number;
  crmCampaignVisitCount: number;
  hasOfficePunch: boolean;
  firstPunchMinutes: number | null;
  lastPunchMinutes: number | null;
  leave: CompanyActivityLeaveDetail | null;
  /** True when this employee has neither an active fingerprint device mapping nor a Phoenix
   * CRM seat — "no signal available" is a distinct state from "nothing happened", never
   * silently merged into no_entry. */
  hasNoSignal: boolean;
  /** True when this day shows evidence of BOTH physical presence (office punch or a real CRM
   * field visit) AND a leave request/CRM-leave signal covering the same date — surfaced, never
   * auto-resolved, per the owner's explicit "not payroll, show what actually happened" ruling. */
  conflict: boolean;
};

export type CompanyActivityEmployeeSummary = {
  employeeHrId: string;
  employeeName: string;
  jobTitle: string | null;
  lineName: string | null;
  areaName: string | null;
  teamName: string | null;
  regionName: string | null;
  hasAttendanceChannel: boolean;
  hasCrmChannel: boolean;
  workingDays: number;
  officePresentDays: number;
  crmFieldVisitDays: number;
  totalCrmVisits: number;
  campaignVisits: number;
  /** Distinct days with >=1 campaign visit — NOT the same number as campaignVisits, which sums
   * every visit. Both are shown together so a reader can see density (visits per campaign day),
   * not just a single total that hides whether it came from many days or a few heavy ones. */
  campaignVisitDays: number;
  leaveApprovedDays: number;
  leavePendingDays: number;
  noEntryDays: number;
  noSignalDays: number;
  conflictDays: number;
};

export type CompanyActivityReport = {
  startDate: string;
  endDate: string;
  summaries: CompanyActivityEmployeeSummary[];
  days: CompanyActivityDayRow[];
  /** CRM visits in the date range with neither agent_hr_id nor double_hr_id resolved at all — a
   * company-wide blind-spot count, not scoped to the requested roster (an unattributed visit
   * cannot be scoped to anyone). Null when not computed for this query shape (see crm-detail.ts) —
   * never a fabricated 0. */
  unmappedCrmVisitCount: number | null;
  /** False when Google's holiday calendar could not be read for a month in the range: a Google Calendar outage keeps holidaySourceConnected true for any month holding a company or fixed-date public holiday (1 May, say) while both Eids, Islamic New Year, the Prophet's Birthday and Coptic Easter are missing (owner, 2026-09-16).
   * Those days then show as ordinary working days here. */
  holidayCalendarReachable: boolean;
};
