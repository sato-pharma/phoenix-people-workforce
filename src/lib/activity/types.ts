import type { EngagementResult } from "@/lib/activity/engagement";

export type ActivityRange = {
  /** Inclusive ISO start timestamp. */
  fromIso: string;
  /** Exclusive/now ISO end timestamp. */
  toIso: string;
  /** Window length in days (for labels). */
  days: number;
};

export type ActivityIdentity = {
  /** Stable key — hr_id when known, otherwise login_id. */
  key: string;
  hrId: string | null;
  loginId: string | null;
  name: string;
  role: string;
  team: string | null;
};

export type OnlineUser = ActivityIdentity & {
  startedAt: string;
  lastSeenAt: string;
  idleSeconds: number;
  currentModule: string | null;
  ip: string | null;
};

export type ModulePopularity = {
  key: string;
  label: string;
  pageViews: number;
  activeMinutes: number;
  distinctUsers: number;
  sharePct: number;
};

export type UserActivitySummary = ActivityIdentity & {
  sessions: number;
  sessionMinutes: number;
  activeMinutes: number;
  pageViews: number;
  distinctModules: number;
  topModule: string | null;
  lastSeenAt: string | null;
  engagement: EngagementResult;
};

export type AdoptionStatus = "active" | "dormant" | "never";

export type AdoptionRow = ActivityIdentity & {
  lastSeenAt: string | null;
  daysSinceSeen: number | null;
  status: AdoptionStatus;
};

export type ActivityAnomaly = {
  id: string;
  type: "concurrent_sessions" | "odd_hour_login";
  severity: "info" | "warning";
  identity: ActivityIdentity;
  detail: string;
  occurredAt: string;
};

export type ActivityKpis = {
  activeUsers: number;
  onlineNow: number;
  sessions: number;
  avgSessionMinutes: number;
  avgActiveMinutesPerUser: number;
  totalPageViews: number;
  topModuleLabel: string | null;
};

export type ActivityOverview = {
  range: ActivityRange;
  generatedAtIso: string;
  kpis: ActivityKpis;
  online: OnlineUser[];
  modulePopularity: ModulePopularity[];
  topUsers: UserActivitySummary[];
  adoption: {
    counts: Record<AdoptionStatus, number>;
    rows: AdoptionRow[];
  };
  anomalies: ActivityAnomaly[];
};

export type TimelineEvent = {
  atIso: string;
  moduleLabel: string;
  path: string;
  dwellSeconds: number;
};

export type TimelineSession = {
  sessionId: string | null;
  startedAt: string;
  endedAt: string | null;
  endedReason: string;
  durationMinutes: number;
  activeMinutes: number;
  ip: string | null;
  userAgent: string | null;
  modules: { label: string; minutes: number; views: number }[];
  events: TimelineEvent[];
};

export type UserTimeline = {
  identity: ActivityIdentity;
  range: ActivityRange;
  summary: UserActivitySummary;
  sessions: TimelineSession[];
};

export type RecordPageViewInput = {
  loginId: string | null;
  hrId: string | null;
  sessionId: string | null;
  role: string | null;
  path: string;
  durationMs: number;
  enteredAtIso: string | null;
  userAgent: string | null;
};
