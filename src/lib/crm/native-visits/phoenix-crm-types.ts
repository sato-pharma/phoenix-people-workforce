/**
 * Phoenix CRM — the shapes its pages share. Types only, so a "use client" component can import them
 * without pulling the server service into a browser bundle.
 */

import type { NativePlanStatus } from "@/lib/crm/native-visits/plan-rules";
import type { PhoenixCrmKpiResult } from "@/lib/crm/native-visits/phoenix-crm-kpi-rules";

/** Who is looking: the Super Admin, a manager of pilot reps, or a pilot rep. */
export type PhoenixCrmSeat = "admin" | "manager" | "rep";

export type PhoenixCrmTab = "visits" | "planning" | "kpis" | "pilot-reps";

export type PhoenixCrmAccessView = {
  /** Null: this viewer does not see Phoenix CRM at all. */
  seat: PhoenixCrmSeat | null;
  /** Visits to confirm and plans to verify still waiting for this manager. */
  waiting: number;
};

export type PhoenixCrmRosterRow = {
  hrId: string;
  name: string;
  jobTitle: string | null;
  lineName: string | null;
  areaName: string | null;
  managerName: string | null;
  onRoster: boolean;
  /** The first day the rep enters in Phoenix CRM; null while not on the roster. */
  startsOn: string | null;
  /** Who last added or removed the rep, by name, and when. */
  changedBy: string | null;
  changedAt: string | null;
};

export type PhoenixCrmRosterView = {
  cairoToday: string;
  onRosterCount: number;
  rows: PhoenixCrmRosterRow[];
};

export type PhoenixCrmKpiRow = PhoenixCrmKpiResult & {
  hrId: string;
  name: string;
  detail: string;
  startsOn: string;
  /** The days counted this month; null when the rep joined after it or it has not begun. */
  window: { from: string; to: string } | null;
  /** "1.5 AM · 8.2 PM" — never one averaged figure. */
  callRateText: string;
};

export type PhoenixCrmKpiView = {
  month: string;
  /** The months a viewer may choose, newest first. */
  months: string[];
  audience: "self" | "team" | "all";
  cairoToday: string;
  /** False when a month's holiday calendar could not be read: working days may be too many. */
  holidaysComplete: boolean;
  rows: PhoenixCrmKpiRow[];
};

export type PhoenixCrmPlanOverviewRow = {
  key: string;
  repName: string;
  repDetail: string;
  weekStart: string;
  /** Null: no plan saved for that week yet. */
  status: NativePlanStatus | null;
  statusLabel: string;
  plannedCalls: number;
  managerName: string | null;
  decidedAt: string | null;
};

export type PhoenixCrmPlanOverview = {
  weeks: string[];
  rows: PhoenixCrmPlanOverviewRow[];
};
