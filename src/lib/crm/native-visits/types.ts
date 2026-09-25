/**
 * Native visits — the shapes the CRM contact-list service and the vacation-day-work pages share.
 * Types only, so a "use client" component can import them without pulling a server service into a
 * browser bundle.
 */

import type {
  VacationDayDecision,
  VacationDayDeciderRole,
  VacationDayRequestStatus,
} from "@/lib/crm/native-visits/vacation-day-rules";

export type NativeVisitPartnerOption = {
  hrId: string;
  name: string;
  jobTitle: string | null;
  isDirectManager: boolean;
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
