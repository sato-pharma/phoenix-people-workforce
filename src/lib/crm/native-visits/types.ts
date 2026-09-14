/**
 * Native visits — the shapes the pages and the phone form share. Types only, so a "use client"
 * component can import them without pulling the server service into a browser bundle.
 */

import type {
  NativePartnerStatus,
  NativeVisitContactRule,
  NativeVisitGpsStatus,
  NativeVisitShift,
  NativeVisitTypeKey,
} from "@/lib/crm/native-visits/rules";
import type {
  VacationDayDecision,
  VacationDayDeciderRole,
  VacationDayRequestStatus,
} from "@/lib/crm/native-visits/vacation-day-rules";

export type NativeVisitContactOption = {
  contactCrmId: number;
  name: string;
  speciality: string | null;
  grade: string | null;
  /** This rep's open lists holding the contact. One list decides the half-day; two leave it to him. */
  lists: NativeVisitShift[];
};

export type NativeVisitPartnerOption = {
  hrId: string;
  name: string;
  jobTitle: string | null;
  isDirectManager: boolean;
};

export type NativeVisitFormOptions = {
  pilot: { lineName: string; startsOn: string; endsOn: string } | null;
  /** crm_cutover.cutover_date: from it every rep of every line enters visits here. Null before it is set. */
  cutoverDate: string | null;
  /** Today is on or after the cutover date, so what is saved here is the record pay and reports read. */
  phoenixIsRecord: boolean;
  entryDays: { today: string; yesterday: string };
  /** Which of the two entry days are open: a pilot day of the rep's line, or on or after the cutover date. */
  openDays: string[];
  types: Array<{ key: NativeVisitTypeKey; label: string; contact: NativeVisitContactRule }>;
  contacts: NativeVisitContactOption[];
  partners: NativeVisitPartnerOption[];
  /** The CRM cutover date is set, so a visit on an approved vacation day needs a request (rule 9). */
  vacationDayRuleInForce?: boolean;
  /**
   * "manager": a district manager's rare single visit without his rep — his reps' doctors, nobody
   * accompanying, no plan rule. "on_behalf": the Super Admin enters it for the chosen rep — any open
   * day up to today, any doctor on the rep's list, no location. "rep": everyone else.
   */
  entryAs: "rep" | "manager" | "on_behalf";
  /** The rep the Super Admin is entering for; null on a rep's or a manager's own form. */
  rep?: NativeVisitRepOption | null;
  /**
   * Per open day on or after the cutover date, the doctors planned that day in a verified week plan —
   * the only doctors a regular visit saves for. Null while the plan rule reaches none of the open days.
   */
  plannedContactIdsByDay: Record<string, number[]> | null;
};

export type NativeVisitPartnerView = {
  name: string;
  jobTitle: string | null;
  isDirectManager: boolean;
  status: NativePartnerStatus;
};

export type NativeVisitRow = {
  id: string;
  visitDate: string;
  shift: NativeVisitShift;
  visitType: NativeVisitTypeKey;
  typeLabel: string;
  contactName: string | null;
  prospectName: string | null;
  gpsStatus: NativeVisitGpsStatus;
  gpsAddress: string | null;
  comment: string | null;
  serverReceivedAt: string;
  deletedAt: string | null;
  deleteReason: string | null;
  canDelete: boolean;
  partners: NativeVisitPartnerView[];
  /** The Super Admin entered this visit for the rep. */
  enteredOnBehalf: boolean;
};

export type NativeVisitRepOption = {
  hrId: string;
  name: string;
  /** Job title, line and area, for telling two reps of the same name apart. */
  detail: string;
};

/** One saved visit, as the Super Admin's all-reps list shows it. */
export type NativeVisitAdminRow = {
  id: string;
  repName: string;
  repDetail: string;
  visitDate: string;
  shift: NativeVisitShift;
  typeLabel: string;
  contactName: string | null;
  prospectName: string | null;
  gpsStatus: NativeVisitGpsStatus;
  comment: string | null;
  serverReceivedAt: string;
  deletedAt: string | null;
  deleteReason: string | null;
  partners: NativeVisitPartnerView[];
  /** Who entered it for the rep, by name; null when the rep entered it himself. */
  enteredBy: string | null;
};

export type NativeVisitAdminView = {
  from: string;
  to: string;
  /** The reps the Super Admin may enter for: active medical reps on a line with a pilot or a cutover date. */
  reps: NativeVisitRepOption[];
  rows: NativeVisitAdminRow[];
  /** More visits matched than the list shows; narrow the days or choose a rep. */
  truncated: boolean;
};

export type NativeVisitConfirmationRow = {
  partnerId: number;
  status: NativePartnerStatus;
  repName: string;
  visitDate: string;
  shift: NativeVisitShift;
  typeLabel: string;
  contactName: string | null;
  prospectName: string | null;
  gpsStatus: NativeVisitGpsStatus;
  comment: string | null;
  isDirectManager: boolean;
  decidedAt: string | null;
  decisionNote: string | null;
  canDecide: boolean;
};

export type NativeVisitEntryAvailability = {
  canLog: boolean;
  canConfirm: boolean;
  pendingConfirmations: number;
  /** Phoenix is not yet this viewer's record (no cutover reached), so the links say "pilot". */
  pilotOnly: boolean;
};

/** One request to work on an approved vacation day (phase 6, rule 9), as a page shows it. */
export type NativeVacationDayRequestRow = {
  id: string;
  repName: string;
  visitDate: string;
  reason: string;
  status: VacationDayRequestStatus;
  managerName: string;
  managerDecision: VacationDayDecision;
  managerNote: string | null;
  managerDecidedAt: string | null;
  hrDecision: VacationDayDecision;
  hrDeciderName: string | null;
  hrNote: string | null;
  hrDecidedAt: string | null;
  createdAt: string;
  /** Which decision this viewer may still record on it, or null. */
  decideAs: VacationDayDeciderRole | null;
  /** The rep may withdraw his own request while it is waiting or approved. */
  canCancel: boolean;
};

export type NativeVacationDayView = {
  /** The CRM cutover date is set. Before that the page explains the rule is not in force yet. */
  ruleInForce: boolean;
  canRequest: boolean;
  canDecideAsManager: boolean;
  canDecideAsHr: boolean;
  mine: NativeVacationDayRequestRow[];
  toDecide: NativeVacationDayRequestRow[];
};

export type NativeVacationDayAvailability = {
  /** Link the requests page. False before the CRM cutover date is set. */
  show: boolean;
  /** Requests this viewer can still answer, as manager or as HR. */
  waitingForYou: number;
};

export type NativeVisitSaveResult = {
  visitId: string;
  duplicate: boolean;
  gpsStatus: NativeVisitGpsStatus;
};
