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
  | "future";

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
  dayType: "working" | "weekly_off" | "holiday" | "future";
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
  /** True when this employee has neither an active fingerprint device mapping nor a resolved
   * CRM identity — "no signal available" is a distinct state from "nothing happened", never
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
};
