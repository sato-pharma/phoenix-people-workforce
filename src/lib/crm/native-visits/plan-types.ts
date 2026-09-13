/**
 * Native rep plans — the shapes the planner, the review screen and the server share. Types only, so a
 * "use client" component can import them without pulling the server service into a browser bundle.
 */

import type { NativePlanItemOutcome, NativePlanStatus } from "@/lib/crm/native-visits/plan-rules";
import type { NativeVisitShift } from "@/lib/crm/native-visits/rules";
import type { NativeVisitContactOption } from "@/lib/crm/native-visits/types";

/** A Double Visit a manager's own weekly plan puts on this rep's day. Read-only, shown beside the day. */
export type NativePlanDoubleVisit = {
  date: string;
  managerName: string;
  managerJobTitle: string | null;
  title: string;
};

export type NativePlanDayView = {
  date: string;
  shifts: NativeVisitShift[];
  editable: boolean;
  doubleVisits: NativePlanDoubleVisit[];
};

export type NativePlanItemView = {
  id: string;
  planDate: string;
  shift: NativeVisitShift;
  contactCrmId: number;
  contactName: string;
  speciality: string | null;
  grade: string | null;
  outcome: NativePlanItemOutcome;
};

export type NativePlanWeekView = {
  weekStart: string;
  weekEnd: string;
  planId: string | null;
  status: NativePlanStatus | null;
  /** The version on screen. A save, submit or reopen from a stale screen is refused. */
  revision: number;
  submittedAt: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
  verifierName: string | null;
  days: NativePlanDayView[];
  items: NativePlanItemView[];
  canEdit: boolean;
  canReopen: boolean;
};

export type NativePlannerView = {
  pilot: { lineName: string; startsOn: string; endsOn: string } | null;
  cairoToday: string;
  /** Who a submitted plan goes to: the rep's nearest active manager. */
  managerName: string | null;
  contacts: NativeVisitContactOption[];
  weeks: NativePlanWeekView[];
};

export type NativePlanSaveResult = {
  planId: string;
  status: NativePlanStatus;
  revision: number;
};

export type NativePlanReviewRow = {
  planId: string;
  repName: string;
  repJobTitle: string | null;
  areaName: string | null;
  weekStart: string;
  weekEnd: string;
  status: NativePlanStatus;
  revision: number;
  submittedAt: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
  canDecide: boolean;
  days: NativePlanDayView[];
  items: NativePlanItemView[];
};

export type NativePlanAvailability = {
  canPlan: boolean;
  canReview: boolean;
  pendingReviews: number;
};
