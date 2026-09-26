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

export type RoleBenchmark = {
  role: string;
  userCount: number;
  avgSessionMinutes: number;
  avgActiveMinutes: number;
  avgEngagementScore: number;
};

export type LiveEvent = {
  hrId: string | null;
  name: string;
  moduleLabel: string;
  occurredAtIso: string;
};

export type LiveActivity = {
  online: OnlineUser[];
  recentEvents: LiveEvent[];
  generatedAtIso: string;
};

export type ActivityOverview = {
  range: ActivityRange;
  generatedAtIso: string;
  kpis: ActivityKpis;
  online: OnlineUser[];
  modulePopularity: ModulePopularity[];
  /**
   * EVERY person with activity in the range, most active first — not a top-N
   * slice. It was `topUsers`, capped at 30, until 2026-09-26: the owner asked to
   * "know EVERYONE entered which module", and a cap silently answers a different
   * question. The section is searchable by name, which a truncated list cannot
   * serve at all — the person searched for is the one most likely to be missing.
   */
  people: UserActivitySummary[];
  adoption: {
    counts: Record<AdoptionStatus, number>;
    rows: AdoptionRow[];
  };
  anomalies: ActivityAnomaly[];
  /** [weekday 0=Sun … 6=Sat][hour 0–23] session-start counts in Cairo time. */
  hourlyHeatmap: number[][];
  roleBenchmarks: RoleBenchmark[];
  /**
   * Service logins left out of every figure above (they are not people). Carried
   * through and shown as a footnote so the number is never silently dropped.
   */
  excludedAccounts: ExcludedAccount[];
  /**
   * True when the event read hit its cap and older events in the window were
   * left behind. The figures built from events — engagement, module popularity,
   * top users — are then partial, and the page says so rather than presenting a
   * short count as a measurement.
   */
  eventsTruncated: boolean;
};

export type ExcludedAccount = {
  /** The login as it appears in app_auth_users, e.g. "admin-HR". */
  name: string;
  sessions: number;
  pageViews: number;
};

export type TimelineEvent = {
  atIso: string;
  moduleLabel: string;
  path: string;
  dwellSeconds: number;
};

export type TimelineSession = {
  /** app_sessions.id of the first row merged in, or "unlinked" for loose events. */
  sessionId: string | null;
  startedAt: string;
  endedAt: string | null;
  endedReason: string;
  durationMinutes: number;
  activeMinutes: number;
  ip: string | null;
  userAgent: string | null;
  /** "iPhone (Safari)" — resolved server-side from the user agent. */
  deviceLabel: string | null;
  modules: { label: string; minutes: number; views: number }[];
  events: TimelineEvent[];
};

/**
 * Logins per Cairo day over a FIXED window, bucketed on the server. It does not
 * follow the range picker: the calendar is a months-long habit view, and feeding
 * it the picker's 1/7/30 days drew a 90-day grid whose empty remainder read as
 * "never logged in".
 */
export type LoginCalendar = {
  days: number;
  /** Today in Cairo, as YYYY-MM-DD — so the client needs no clock of its own. */
  todayKey: string;
  counts: { dateIso: string; logins: number }[];
};

/**
 * One unbroken run of consecutive page views inside the SAME module — the unit
 * the journey is drawn from, and the reason a module can appear many times.
 *
 * A run is what the owner means by "stayed how much": opening Payroll, working
 * for twenty minutes, leaving for CRM and coming back is TWO Payroll runs, not
 * one forty-minute block. Collapsing them would hide the switching that the
 * journey exists to show.
 */
export type ModuleVisit = {
  moduleLabel: string;
  startedAtIso: string;
  endedAtIso: string;
  /** Credited seconds — overlapping windows already deduplicated, so runs sum to Active. */
  seconds: number;
  views: number;
};

/** A module's whole footprint for one person over the range. */
export type ModuleTotal = {
  moduleLabel: string;
  /** Credited seconds, so the column sums to the person's own Active time. */
  seconds: number;
  views: number;
  /** Separate runs — how many times they came BACK, not how many pages they opened. */
  visits: number;
  firstAtIso: string;
  lastAtIso: string;
  /** Share of this person's own credited active time, 0–100 with one decimal. */
  sharePct: number;
};

/** A move from one module straight into another, counted over the range. */
export type ModuleTransition = {
  fromLabel: string;
  toLabel: string;
  count: number;
};

/**
 * Where one person's time went, and in what order. Built from the same credited
 * seconds as every other active figure on the page, so the totals reconcile with
 * the Active column instead of being a second, disagreeing measurement.
 */
export type ModuleJourney = {
  totals: ModuleTotal[];
  /** Newest first — the order the drawer reads them in. */
  visits: ModuleVisit[];
  /** Most frequent first. */
  transitions: ModuleTransition[];
};

export type UserTimeline = {
  identity: ActivityIdentity;
  range: ActivityRange;
  summary: UserActivitySummary;
  sessions: TimelineSession[];
  loginCalendar: LoginCalendar;
  /** Module totals, the ordered run list, and the moves between them. */
  journey: ModuleJourney;
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
