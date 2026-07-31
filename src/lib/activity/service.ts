import { unstable_cache } from "next/cache.js";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { normalizeHrId, type AccessContext } from "@/lib/auth/permissions";
import {
  ACTIVE_VIEW_CAP_SECONDS,
  cappedDwellSeconds,
  computeEngagement,
} from "@/lib/activity/engagement";
import { resolveActivityModule } from "@/lib/activity/modules";
import { logError } from "@/lib/observability/log";
import type {
  ActivityAnomaly,
  ActivityIdentity,
  ActivityOverview,
  ActivityRange,
  AdoptionRow,
  AdoptionStatus,
  LiveActivity,
  LiveEvent,
  ModulePopularity,
  OnlineUser,
  RecordPageViewInput,
  RoleBenchmark,
  TimelineSession,
  UserActivitySummary,
  UserTimeline,
} from "@/lib/activity/types";

// Egypt operating timezone — used only to classify "odd-hour" logins.
const BUSINESS_TIMEZONE = "Africa/Cairo";
const DORMANT_AFTER_DAYS = 7;
const ADOPTION_LOOKBACK_DAYS = 90;
const PAGE_SIZE = 1000;
const EVENT_FETCH_CAP = 120_000;
const SESSION_FETCH_CAP = 60_000;
const TOP_USERS_LIMIT = 30;
const ANOMALY_LIMIT = 40;

type Row = Record<string, unknown>;

function str(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text.length ? text : null;
}

function num(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** True when a Supabase error means the table/relation doesn't exist yet. */
function isMissingRelationError(error: { code?: string | null; message?: string | null }): boolean {
  if (error?.code === "42P01") return true;
  const message = String(error?.message ?? "").toLowerCase();
  return message.includes("does not exist") || message.includes("could not find the table");
}

function minutesFromSeconds(seconds: number): number {
  return Math.round((seconds / 60) * 10) / 10;
}

function identityKey(hrId: string | null, loginId: string | null): string {
  const normalized = normalizeHrId(hrId);
  if (normalized) return `hr:${normalized}`;
  if (loginId) return `login:${loginId.trim().toLowerCase()}`;
  return "unknown";
}

function hourInBusinessTimezone(iso: string): number {
  try {
    const formatted = new Intl.DateTimeFormat("en-GB", {
      hour: "2-digit",
      hour12: false,
      timeZone: BUSINESS_TIMEZONE,
    }).format(new Date(iso));
    const hour = Number(formatted);
    return Number.isFinite(hour) ? hour % 24 : 12;
  } catch {
    return 12;
  }
}

function weekdayAndHourInBusinessTimezone(iso: string): { weekday: number; hour: number } {
  try {
    const d = new Date(iso);
    const parts = new Intl.DateTimeFormat("en-US", {
      weekday: "short",
      hour: "2-digit",
      hour12: false,
      timeZone: BUSINESS_TIMEZONE,
    }).formatToParts(d);
    const DAY_MAP: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
    const day = parts.find((p) => p.type === "weekday")?.value ?? "Mon";
    const hr = Number(parts.find((p) => p.type === "hour")?.value ?? "12") % 24;
    return { weekday: DAY_MAP[day] ?? 0, hour: Number.isFinite(hr) ? hr : 12 };
  } catch {
    return { weekday: 0, hour: 12 };
  }
}

function buildHourlyHeatmap(sessions: LogicalSession[]): number[][] {
  const heatmap: number[][] = Array.from({ length: 7 }, () => Array(24).fill(0));
  for (const session of sessions) {
    if (!session.startedAt) continue;
    const { weekday, hour } = weekdayAndHourInBusinessTimezone(session.startedAt);
    heatmap[weekday][hour]++;
  }
  return heatmap;
}

function buildRoleBenchmarks(aggByKey: Map<string, Agg>): RoleBenchmark[] {
  const groups = new Map<string, { sessionSeconds: number; activeSeconds: number; engTotal: number; engCount: number; users: number }>();
  for (const agg of aggByKey.values()) {
    const role = agg.identity.role;
    const g = groups.get(role) ?? { sessionSeconds: 0, activeSeconds: 0, engTotal: 0, engCount: 0, users: 0 };
    g.users++;
    g.sessionSeconds += agg.sessionSeconds;
    g.activeSeconds += agg.activeSeconds;
    if (agg.pageViews > 0) {
      const eng = computeEngagement({
        activeSeconds: agg.activeSeconds,
        sessionSeconds: agg.sessionSeconds,
        distinctModules: agg.moduleSeconds.size,
        pageViews: agg.pageViews,
      });
      g.engTotal += eng.score;
      g.engCount++;
    }
    groups.set(role, g);
  }
  return Array.from(groups.entries())
    .map(([role, g]) => ({
      role,
      userCount: g.users,
      avgSessionMinutes: minutesFromSeconds(g.sessionSeconds / Math.max(1, g.users)),
      avgActiveMinutes: minutesFromSeconds(g.activeSeconds / Math.max(1, g.users)),
      avgEngagementScore: g.engCount > 0 ? Math.round(g.engTotal / g.engCount) : 0,
    }))
    .filter((b) => b.userCount > 0)
    .sort((a, b) => b.avgActiveMinutes - a.avgActiveMinutes || b.userCount - a.userCount);
}

export function buildActivityRange(days: number): ActivityRange {
  const safeDays = [1, 7, 30, 90].includes(days) ? days : 7;
  const now = new Date();
  const from = new Date(now.getTime() - safeDays * 24 * 60 * 60 * 1000);
  return { fromIso: from.toISOString(), toIso: now.toISOString(), days: safeDays };
}

/** Page through a Supabase select until exhausted or the cap is reached. */
async function fetchAll(
  table: string,
  columns: string,
  apply: (query: any) => any, // eslint-disable-line @typescript-eslint/no-explicit-any
  cap: number,
): Promise<Row[]> {
  const supabase = getSupabaseAdmin();
  const rows: Row[] = [];
  for (let offset = 0; offset < cap; offset += PAGE_SIZE) {
    const query = apply(supabase.from(table).select(columns)).range(offset, offset + PAGE_SIZE - 1);
    const { data, error } = await query;
    if (error) {
      // Degrade gracefully when the activity_events table doesn't exist yet (its
      // migration is applied separately). The dashboard still works from sessions.
      if (isMissingRelationError(error)) {
        console.warn(`[activity] table ${table} not available yet; treating as empty`);
        return rows;
      }
      throw new Error(`Failed to read ${table}: ${error.message}`);
    }
    const batch = (data ?? []) as Row[];
    rows.push(...batch);
    if (batch.length < PAGE_SIZE) break;
  }
  return rows;
}

type IdentityMaps = {
  employeeByHrId: Map<string, { name: string; jobTitle: string | null; team: string | null; status: string | null }>;
  roleByHrId: Map<string, string>;
  hrIdByLoginId: Map<string, string>;
};

async function loadIdentityMaps(): Promise<IdentityMaps> {
  const [employees, accounts] = await Promise.all([
    fetchAll(
      "employees",
      "hr_id,full_name,job_title,region_name,employment_status",
      (q) => q,
      50_000,
    ),
    fetchAll(
      "app_auth_users",
      "login_id,hr_id,role,is_active",
      (q) => q,
      50_000,
    ),
  ]);

  const employeeByHrId = new Map<string, { name: string; jobTitle: string | null; team: string | null; status: string | null }>();
  for (const row of employees) {
    const hr = normalizeHrId(str(row.hr_id));
    if (!hr) continue;
    employeeByHrId.set(hr, {
      name: str(row.full_name) ?? hr,
      jobTitle: str(row.job_title),
      team: str(row.region_name),
      status: str(row.employment_status),
    });
  }

  const roleByHrId = new Map<string, string>();
  const hrIdByLoginId = new Map<string, string>();
  for (const row of accounts) {
    const login = str(row.login_id);
    const hr = normalizeHrId(str(row.hr_id));
    const role = str(row.role);
    if (login && hr) hrIdByLoginId.set(login.toLowerCase(), hr);
    if (hr && role) roleByHrId.set(hr, role);
  }

  return { employeeByHrId, roleByHrId, hrIdByLoginId };
}

function resolveIdentity(
  maps: IdentityMaps,
  hrIdRaw: string | null,
  loginIdRaw: string | null,
  roleHint: string | null,
): ActivityIdentity {
  let hrId = normalizeHrId(hrIdRaw);
  const loginId = loginIdRaw ? loginIdRaw.trim() : null;
  if (!hrId && loginId) {
    hrId = maps.hrIdByLoginId.get(loginId.toLowerCase()) ?? null;
  }

  const employee = hrId ? maps.employeeByHrId.get(hrId) : undefined;
  const role = roleHint ?? (hrId ? maps.roleByHrId.get(hrId) : null) ?? employee?.jobTitle ?? "Unknown";
  const name = employee?.name ?? (loginId ? loginId : hrId ?? "Unknown user");

  return {
    key: identityKey(hrId, loginId),
    hrId,
    loginId,
    name,
    role,
    team: employee?.team ?? null,
  };
}

// ── Recording (ingest) ───────────────────────────────────────────────────────

export async function recordPageView(input: RecordPageViewInput): Promise<void> {
  const path = String(input.path ?? "").trim();
  if (!path) return;
  const resolvedModule = resolveActivityModule(path);
  const duration = Math.max(0, Math.min(num(input.durationMs), ACTIVE_VIEW_CAP_SECONDS * 1000 * 4));

  const supabase = getSupabaseAdmin();
  const { error } = await supabase.from("activity_events").insert({
    login_id: input.loginId,
    hr_id: normalizeHrId(input.hrId),
    session_id: input.sessionId,
    event_type: "page_view",
    path: path.slice(0, 512),
    module_key: resolvedModule.key,
    module_label: resolvedModule.label,
    duration_ms: Math.round(duration),
    role: input.role,
    user_agent: input.userAgent ? input.userAgent.slice(0, 400) : null,
    entered_at: input.enteredAtIso,
  });

  if (error) {
    // Activity tracking must never break the user's navigation; swallow + log.
    // Stay quiet if the table simply isn't there yet (migration applied separately)
    // so we don't spam logs on every navigation before deploy ordering settles.
    if (!isMissingRelationError(error)) {
      logError("Activity page-view recording failed", {
        labels: { event: "activity_record_page_view_failed" },
        error,
      });
    }
  }
}

// ── Overview (dashboard) ─────────────────────────────────────────────────────

export type SessionRow = {
  id: string | null;
  loginId: string | null;
  hrId: string | null;
  role: string | null;
  createdAt: string | null;
  lastSeenAt: string | null;
  revokedAt: string | null;
  revokedReason: string | null;
  idleExpiresAt: string | null;
  absoluteExpiresAt: string | null;
  ip: string | null;
  userAgent: string | null;
};

function mapSession(row: Row): SessionRow {
  return {
    id: str(row.id),
    loginId: str(row.login_id),
    hrId: str(row.hr_id),
    role: str(row.role),
    createdAt: str(row.created_at),
    lastSeenAt: str(row.last_seen_at),
    revokedAt: str(row.revoked_at),
    revokedReason: str(row.revoked_reason),
    idleExpiresAt: str(row.idle_expires_at),
    absoluteExpiresAt: str(row.absolute_expires_at),
    ip: str(row.ip),
    userAgent: str(row.user_agent),
  };
}

// The auth layer writes a fresh app_sessions row on every re-auth / idle refresh,
// so one person can accumulate hundreds of rows in a week. Counting raw rows as
// "logins" massively overcounts. We collapse rows for the same person whose gaps
// are smaller than this into a single logical "presence" session.
export const SESSION_MERGE_GAP_SECONDS = 30 * 60;

export type LogicalSession = {
  hrId: string | null;
  loginId: string | null;
  role: string | null;
  startedAt: string;
  /** Effective end used for duration (revoked_at or last_seen_at of last merged row). */
  endIso: string;
  revokedAt: string | null;
  revokedReason: string | null;
  idleExpiresAt: string | null;
  ip: string | null;
  userAgent: string | null;
  durationSeconds: number;
  mergedRows: number;
};

function sessionEndIso(session: SessionRow): string {
  return session.revokedAt ?? session.lastSeenAt ?? session.createdAt ?? new Date().toISOString();
}

/** Merge a person's overlapping/adjacent app_sessions rows into logical sessions. */
export function collapseSessions(rows: SessionRow[]): LogicalSession[] {
  const byKey = new Map<string, SessionRow[]>();
  for (const row of rows) {
    if (!row.createdAt) continue;
    const key = identityKey(row.hrId, row.loginId);
    const list = byKey.get(key) ?? [];
    list.push(row);
    byKey.set(key, list);
  }

  const result: LogicalSession[] = [];
  for (const list of byKey.values()) {
    const sorted = [...list].sort((a, b) => (a.createdAt! < b.createdAt! ? -1 : 1));
    let current: LogicalSession | null = null;

    for (const row of sorted) {
      const startMs = new Date(row.createdAt!).getTime();
      const endIso = sessionEndIso(row);
      const endMs = new Date(endIso).getTime();

      if (current && startMs <= new Date(current.endIso).getTime() + SESSION_MERGE_GAP_SECONDS * 1000) {
        // Extend the current logical session.
        if (endMs > new Date(current.endIso).getTime()) {
          current.endIso = endIso;
          current.revokedAt = row.revokedAt;
          current.revokedReason = row.revokedReason;
          current.idleExpiresAt = row.idleExpiresAt;
        }
        current.ip = row.ip ?? current.ip;
        current.userAgent = row.userAgent ?? current.userAgent;
        current.mergedRows += 1;
        current.durationSeconds = Math.max(
          0,
          Math.round((new Date(current.endIso).getTime() - new Date(current.startedAt).getTime()) / 1000),
        );
      } else {
        if (current) result.push(current);
        current = {
          hrId: row.hrId,
          loginId: row.loginId,
          role: row.role,
          startedAt: row.createdAt!,
          endIso,
          revokedAt: row.revokedAt,
          revokedReason: row.revokedReason,
          idleExpiresAt: row.idleExpiresAt,
          ip: row.ip,
          userAgent: row.userAgent,
          durationSeconds: Math.max(0, Math.round((endMs - startMs) / 1000)),
          mergedRows: 1,
        };
      }
    }
    if (current) result.push(current);
  }

  return result;
}

function logicalSessionEndedReason(session: LogicalSession, nowMs: number): string {
  if (session.revokedReason) return session.revokedReason;
  if (session.revokedAt) return "ended";
  if (session.idleExpiresAt && new Date(session.idleExpiresAt).getTime() < nowMs) return "timeout";
  return "active";
}

type EventRow = {
  hrId: string | null;
  loginId: string | null;
  sessionId: string | null;
  moduleKey: string;
  moduleLabel: string;
  path: string;
  durationMs: number;
  role: string | null;
  createdAt: string;
};

function mapEvent(row: Row): EventRow {
  return {
    hrId: str(row.hr_id),
    loginId: str(row.login_id),
    sessionId: str(row.session_id),
    moduleKey: str(row.module_key) ?? "other",
    moduleLabel: str(row.module_label) ?? "Other",
    path: str(row.path) ?? "/",
    durationMs: num(row.duration_ms),
    role: str(row.role),
    createdAt: str(row.created_at) ?? new Date().toISOString(),
  };
}

type Agg = {
  identity: ActivityIdentity;
  sessions: number;
  sessionSeconds: number;
  activeSeconds: number;
  pageViews: number;
  moduleSeconds: Map<string, { label: string; seconds: number }>;
  lastSeen: string | null;
};

type ModuleTotal = { label: string; seconds: number; views: number; users: Set<string> };

/** Fold logical sessions + events into per-identity aggregates and module totals. */
function aggregateActivity(maps: IdentityMaps, sessions: LogicalSession[], events: EventRow[]) {
  const aggByKey = new Map<string, Agg>();

  function ensureAgg(hrId: string | null, loginId: string | null, role: string | null): Agg {
    const identity = resolveIdentity(maps, hrId, loginId, role);
    let agg = aggByKey.get(identity.key);
    if (!agg) {
      agg = {
        identity,
        sessions: 0,
        sessionSeconds: 0,
        activeSeconds: 0,
        pageViews: 0,
        moduleSeconds: new Map(),
        lastSeen: null,
      };
      aggByKey.set(identity.key, agg);
    }
    return agg;
  }

  for (const session of sessions) {
    const agg = ensureAgg(session.hrId, session.loginId, session.role);
    agg.sessions += 1;
    agg.sessionSeconds += session.durationSeconds;
    const seen = session.endIso;
    if (seen && (!agg.lastSeen || seen > agg.lastSeen)) agg.lastSeen = seen;
  }

  const moduleTotals = new Map<string, ModuleTotal>();
  let totalActiveSeconds = 0;

  for (const event of events) {
    const agg = ensureAgg(event.hrId, event.loginId, event.role);
    const dwell = cappedDwellSeconds(event.durationMs);
    agg.activeSeconds += dwell;
    agg.pageViews += 1;
    totalActiveSeconds += dwell;

    const perUserModule = agg.moduleSeconds.get(event.moduleKey) ?? { label: event.moduleLabel, seconds: 0 };
    perUserModule.seconds += dwell;
    agg.moduleSeconds.set(event.moduleKey, perUserModule);

    if (event.createdAt && (!agg.lastSeen || event.createdAt > agg.lastSeen)) agg.lastSeen = event.createdAt;

    const moduleTotal = moduleTotals.get(event.moduleKey) ?? { label: event.moduleLabel, seconds: 0, views: 0, users: new Set<string>() };
    moduleTotal.seconds += dwell;
    moduleTotal.views += 1;
    moduleTotal.users.add(agg.identity.key);
    moduleTotals.set(event.moduleKey, moduleTotal);
  }

  return { aggByKey, moduleTotals, totalActiveSeconds };
}

function summarize(agg: Agg): UserActivitySummary {
  const engagement = computeEngagement({
    activeSeconds: agg.activeSeconds,
    sessionSeconds: agg.sessionSeconds,
    distinctModules: agg.moduleSeconds.size,
    pageViews: agg.pageViews,
  });
  let topModule: string | null = null;
  let topModuleSeconds = -1;
  for (const value of agg.moduleSeconds.values()) {
    if (value.seconds > topModuleSeconds) {
      topModuleSeconds = value.seconds;
      topModule = value.label;
    }
  }
  return {
    ...agg.identity,
    sessions: agg.sessions,
    sessionMinutes: minutesFromSeconds(agg.sessionSeconds),
    activeMinutes: minutesFromSeconds(agg.activeSeconds),
    pageViews: agg.pageViews,
    distinctModules: agg.moduleSeconds.size,
    topModule,
    lastSeenAt: agg.lastSeen,
    engagement,
  };
}

async function getActivityOverviewUncached(days: number): Promise<ActivityOverview> {
  // range (via buildActivityRange) is computed INSIDE the cached function, keyed only
  // on `days`, rather than passed in as a pre-built range object. buildActivityRange
  // stamps toIso as new Date().toISOString() on every call, so a range object is
  // never identical between two calls even a millisecond apart — caching keyed on the
  // full range would defeat itself (every call gets a technically-unique key, so it
  // would never actually hit). Keying on `days` (one of 1/7/30/90) gives a real,
  // effective cache instead.
  const range = buildActivityRange(days);
  const nowIso = new Date().toISOString();
  const adoptionFromIso = new Date(Date.now() - ADOPTION_LOOKBACK_DAYS * 24 * 60 * 60 * 1000).toISOString();

  const [maps, sessionRowsRaw, eventRowsRaw, onlineRowsRaw, adoptionSessionRowsRaw] = await Promise.all([
    loadIdentityMaps(),
    fetchAll(
      "app_sessions",
      "id,login_id,hr_id,role,created_at,last_seen_at,revoked_at,revoked_reason,idle_expires_at,absolute_expires_at,ip,user_agent",
      (q) => q.gte("created_at", range.fromIso).lte("created_at", range.toIso).order("created_at", { ascending: false }),
      SESSION_FETCH_CAP,
    ),
    fetchAll(
      "activity_events",
      "hr_id,login_id,session_id,module_key,module_label,path,duration_ms,role,created_at",
      (q) => q.gte("created_at", range.fromIso).lte("created_at", range.toIso).order("created_at", { ascending: false }),
      EVENT_FETCH_CAP,
    ),
    fetchAll(
      "app_sessions",
      "id,login_id,hr_id,role,created_at,last_seen_at,revoked_at,revoked_reason,idle_expires_at,absolute_expires_at,ip,user_agent",
      (q) => q.is("revoked_at", null).gt("idle_expires_at", nowIso).gt("absolute_expires_at", nowIso).order("last_seen_at", { ascending: false }).limit(300),
      1,
    ),
    fetchAll(
      "app_sessions",
      "login_id,hr_id,last_seen_at,created_at",
      (q) => q.gte("created_at", adoptionFromIso).order("last_seen_at", { ascending: false }),
      SESSION_FETCH_CAP,
    ),
  ]);

  const sessions = sessionRowsRaw.map(mapSession);
  const logicalSessions = collapseSessions(sessions);
  const events = eventRowsRaw.map(mapEvent);
  const onlineSessions = onlineRowsRaw.map(mapSession);

  // Latest event per session (for "current module" of online users).
  const latestEventBySession = new Map<string, EventRow>();
  for (const event of events) {
    if (!event.sessionId) continue;
    if (!latestEventBySession.has(event.sessionId)) {
      latestEventBySession.set(event.sessionId, event);
    }
  }

  // ── Per-identity aggregation ───────────────────────────────────────────────
  const { aggByKey, moduleTotals, totalActiveSeconds } = aggregateActivity(maps, logicalSessions, events);

  // ── Module popularity ──────────────────────────────────────────────────────
  const modulePopularity: ModulePopularity[] = Array.from(moduleTotals.entries())
    .map(([key, value]) => ({
      key,
      label: value.label,
      pageViews: value.views,
      activeMinutes: minutesFromSeconds(value.seconds),
      distinctUsers: value.users.size,
      sharePct: totalActiveSeconds > 0 ? Math.round((value.seconds / totalActiveSeconds) * 1000) / 10 : 0,
    }))
    .sort((a, b) => b.activeMinutes - a.activeMinutes || b.pageViews - a.pageViews);

  // ── Top users + engagement ─────────────────────────────────────────────────
  const allSummaries = Array.from(aggByKey.values()).map(summarize);
  const topUsers = [...allSummaries]
    .sort(
      (a, b) =>
        b.activeMinutes - a.activeMinutes ||
        b.pageViews - a.pageViews ||
        b.sessionMinutes - a.sessionMinutes ||
        (a.lastSeenAt && b.lastSeenAt ? (a.lastSeenAt < b.lastSeenAt ? 1 : -1) : 0),
    )
    .slice(0, TOP_USERS_LIMIT);

  // ── Online now (deduplicated to distinct PEOPLE, not raw sessions) ──────────
  const onlineResolved = onlineSessions.map((session) => {
    const identity = resolveIdentity(maps, session.hrId, session.loginId, session.role);
    const latest = session.id ? latestEventBySession.get(session.id) : undefined;
    const lastSeen = session.lastSeenAt ?? session.createdAt ?? nowIso;
    const idleSeconds = Math.max(0, Math.round((Date.now() - new Date(lastSeen).getTime()) / 1000));
    return {
      ...identity,
      startedAt: session.createdAt ?? nowIso,
      lastSeenAt: lastSeen,
      idleSeconds,
      currentModule: latest?.moduleLabel ?? null,
      ip: session.ip,
    } as OnlineUser;
  });

  const onlineByKey = new Map<string, OnlineUser>();
  for (const user of onlineResolved) {
    const existing = onlineByKey.get(user.key);
    // Keep the most-recently-active session per person, but prefer one that has a
    // known current module.
    if (!existing || user.lastSeenAt > existing.lastSeenAt || (!existing.currentModule && user.currentModule)) {
      onlineByKey.set(user.key, { ...(existing ?? user), ...user, currentModule: user.currentModule ?? existing?.currentModule ?? null });
    }
  }
  const online: OnlineUser[] = Array.from(onlineByKey.values()).sort((a, b) => (a.lastSeenAt < b.lastSeenAt ? 1 : -1));

  // ── KPIs ───────────────────────────────────────────────────────────────────
  const activeUsers = aggByKey.size;
  const sessionDurations = logicalSessions.map((s) => s.durationSeconds).filter((s) => s > 0);
  const avgSessionMinutes = sessionDurations.length
    ? minutesFromSeconds(sessionDurations.reduce((sum, s) => sum + s, 0) / sessionDurations.length)
    : 0;

  const kpis = {
    activeUsers,
    onlineNow: online.length,
    sessions: logicalSessions.length,
    avgSessionMinutes,
    avgActiveMinutesPerUser: activeUsers ? minutesFromSeconds(totalActiveSeconds / activeUsers) : 0,
    totalPageViews: events.length,
    topModuleLabel: modulePopularity[0]?.label ?? null,
  };

  // ── Adoption (who never logs in) ───────────────────────────────────────────
  const lastSeenByKey = new Map<string, string>();
  function noteLastSeen(hrId: string | null, loginId: string | null, when: string | null) {
    if (!when) return;
    const identity = resolveIdentity(maps, hrId, loginId, null);
    const current = lastSeenByKey.get(identity.key);
    if (!current || when > current) lastSeenByKey.set(identity.key, when);
  }
  for (const row of adoptionSessionRowsRaw) {
    noteLastSeen(str(row.hr_id), str(row.login_id), str(row.last_seen_at) ?? str(row.created_at));
  }
  for (const agg of aggByKey.values()) {
    if (agg.lastSeen) noteLastSeen(agg.identity.hrId, agg.identity.loginId, agg.lastSeen);
  }

  const adoptionRows: AdoptionRow[] = [];
  const adoptionCounts: Record<AdoptionStatus, number> = { active: 0, dormant: 0, never: 0 };
  const seenAccountKeys = new Set<string>();

  for (const [loginId, hrId] of maps.hrIdByLoginId.entries()) {
    const employee = maps.employeeByHrId.get(hrId);
    // Only track accounts for employees who are currently active/on-leave.
    const status = (employee?.status ?? "active").toLowerCase();
    if (!["active", "on_leave", ""].includes(status)) continue;

    const identity = resolveIdentity(maps, hrId, loginId, null);
    if (seenAccountKeys.has(identity.key)) continue;
    seenAccountKeys.add(identity.key);

    const lastSeen = lastSeenByKey.get(identity.key) ?? null;
    let daysSinceSeen: number | null = null;
    let adoptionStatus: AdoptionStatus = "never";
    if (lastSeen) {
      daysSinceSeen = Math.floor((Date.now() - new Date(lastSeen).getTime()) / (24 * 60 * 60 * 1000));
      adoptionStatus = daysSinceSeen <= DORMANT_AFTER_DAYS ? "active" : "dormant";
    }
    adoptionCounts[adoptionStatus] += 1;
    adoptionRows.push({ ...identity, lastSeenAt: lastSeen, daysSinceSeen, status: adoptionStatus });
  }

  adoptionRows.sort((a, b) => {
    const order: Record<AdoptionStatus, number> = { never: 0, dormant: 1, active: 2 };
    if (order[a.status] !== order[b.status]) return order[a.status] - order[b.status];
    return (b.daysSinceSeen ?? 9999) - (a.daysSinceSeen ?? 9999);
  });

  // ── Anomalies ──────────────────────────────────────────────────────────────
  const anomalies: ActivityAnomaly[] = [];

  // Concurrent active sessions from distinct IPs (uses raw active sessions).
  const onlineByLogin = new Map<string, OnlineUser[]>();
  for (const user of onlineResolved) {
    const key = user.key;
    const list = onlineByLogin.get(key) ?? [];
    list.push(user);
    onlineByLogin.set(key, list);
  }
  for (const [, list] of onlineByLogin.entries()) {
    if (list.length < 2) continue;
    const ips = new Set(list.map((u) => u.ip ?? "unknown"));
    if (ips.size < 2) continue;
    const latest = list.reduce((a, b) => (a.lastSeenAt > b.lastSeenAt ? a : b));
    anomalies.push({
      id: `concurrent:${latest.key}`,
      type: "concurrent_sessions",
      severity: "warning",
      identity: latest,
      detail: `${list.length} active sessions from ${ips.size} different IP addresses`,
      occurredAt: latest.lastSeenAt,
    });
  }

  // Odd-hour logins (00:00–05:00 Cairo time) within the range. Uses collapsed
  // logical sessions so a single early-morning presence isn't flagged repeatedly.
  for (const session of logicalSessions) {
    const hour = hourInBusinessTimezone(session.startedAt);
    if (hour >= 0 && hour < 5) {
      const identity = resolveIdentity(maps, session.hrId, session.loginId, session.role);
      anomalies.push({
        id: `oddhour:${identity.key}:${session.startedAt}`,
        type: "odd_hour_login",
        severity: "info",
        identity,
        detail: `Logged in at ${String(hour).padStart(2, "0")}:00 (Cairo) — outside normal hours`,
        occurredAt: session.startedAt,
      });
    }
  }

  anomalies.sort((a, b) => (a.occurredAt < b.occurredAt ? 1 : -1));

  return {
    range,
    generatedAtIso: nowIso,
    kpis,
    online,
    modulePopularity,
    topUsers,
    adoption: { counts: adoptionCounts, rows: adoptionRows },
    anomalies: anomalies.slice(0, ANOMALY_LIMIT),
    hourlyHeatmap: buildHourlyHeatmap(logicalSessions),
    roleBenchmarks: buildRoleBenchmarks(aggByKey),
  };
}

// This diagnostic loads up to EVENT_FETCH_CAP (120k) events / SESSION_FETCH_CAP
// (60k) sessions into Node per call and aggregates them there — a real cost on
// every page load with no caching previously. Company-wide (no per-viewer
// scoping, page-level access-gated), so caching by `days` alone is scope-safe:
// every admin who can reach this page sees the same aggregate for the same
// window. Short TTL keeps the "online now" section reasonably live.
const ACTIVITY_OVERVIEW_CACHE_TTL_SECONDS = 60;

const getActivityOverviewCached = unstable_cache(
  getActivityOverviewUncached,
  ["activity-overview"],
  { revalidate: ACTIVITY_OVERVIEW_CACHE_TTL_SECONDS },
);

export async function getActivityOverview(range: ActivityRange): Promise<ActivityOverview> {
  return getActivityOverviewCached(range.days);
}

// ── Per-person timeline: who may view whose activity ─────────────────────────

/** Exact, normalized HR_ID equality (never substring — avoids B-1 vs B-10 leakage). */
function sameHrId(left: string | null | undefined, right: string | null | undefined): boolean {
  const a = normalizeHrId(left);
  const b = normalizeHrId(right);
  return Boolean(a) && a === b;
}

export type ActivityViewTarget = {
  hrId: string;
  managerHrId: string | null;
};

/**
 * Whether `context` may view the activity timeline of `target`.
 *
 *  - self — always.
 *  - whole-company viewers (Super Admin, CEO, or company/system scope) — anyone.
 *  - any other manager — their DIRECT reports only (target.managerHrId === caller).
 *
 * Defense-in-depth alongside the `user_activity:read` permission gate (currently
 * hardcoded Super-Admin-only): keeps per-employee access scoped even if that
 * resource permission is ever widened via role_permission_overrides.
 */
export function canViewEmployeeActivity(context: AccessContext, target: ActivityViewTarget): boolean {
  if (context.source === "guest" || context.scope === "none") return false;
  const caller = normalizeHrId(context.hrId);
  const targetHrId = normalizeHrId(target.hrId);
  if (!caller || !targetHrId) return false;

  if (sameHrId(caller, targetHrId)) return true; // self

  if (
    context.scope === "system" ||
    context.scope === "company" ||
    context.role === "Super Admin" ||
    context.role === "CEO"
  ) {
    return true;
  }

  return sameHrId(caller, target.managerHrId);
}

/**
 * Throws `Forbidden: ...` unless `context` may view `targetHrId`'s activity timeline.
 * Resolves the target's manager from the DB only when needed (not self / not
 * company-wide), so the common self path stays a single fast in-memory check.
 */
export async function assertCanViewEmployeeActivity(context: AccessContext, targetHrId: string): Promise<void> {
  const caller = normalizeHrId(context.hrId);
  const target = normalizeHrId(targetHrId);
  if (!caller || !target) {
    throw new Error("Forbidden: activity access denied.");
  }
  if (canViewEmployeeActivity(context, { hrId: target, managerHrId: null })) {
    return;
  }
  const supabase = getSupabaseAdmin();
  const { data } = await supabase
    .from("employees")
    .select("manager_hr_id")
    .eq("hr_id", target.toUpperCase())
    .maybeSingle();
  const managerHrId = (data as { manager_hr_id: string | null } | null)?.manager_hr_id ?? null;
  if (!canViewEmployeeActivity(context, { hrId: target, managerHrId })) {
    throw new Error(`Forbidden: ${context.role} cannot view activity for another employee.`);
  }
}

export async function getUserTimeline(targetHrId: string, range: ActivityRange): Promise<UserTimeline | null> {
  const hrId = normalizeHrId(targetHrId);
  if (!hrId) return null;

  const maps = await loadIdentityMaps();
  const identity = resolveIdentity(maps, hrId, null, null);

  const [sessionRowsRaw, eventRowsRaw] = await Promise.all([
    fetchAll(
      "app_sessions",
      "id,login_id,hr_id,role,created_at,last_seen_at,revoked_at,revoked_reason,idle_expires_at,absolute_expires_at,ip,user_agent",
      (q) => q.eq("hr_id", hrId).gte("created_at", range.fromIso).lte("created_at", range.toIso).order("created_at", { ascending: false }),
      SESSION_FETCH_CAP,
    ),
    fetchAll(
      "activity_events",
      "hr_id,login_id,session_id,module_key,module_label,path,duration_ms,role,created_at",
      (q) => q.eq("hr_id", hrId).gte("created_at", range.fromIso).lte("created_at", range.toIso).order("created_at", { ascending: true }),
      EVENT_FETCH_CAP,
    ),
  ]);

  const sessions = sessionRowsRaw.map(mapSession);
  const events = eventRowsRaw.map(mapEvent);

  const nowMs = Date.now();
  const logical = collapseSessions(sessions).sort((a, b) => (a.startedAt < b.startedAt ? -1 : 1));

  // Assign each event to the logical session whose time window contains it.
  const eventsForSession: EventRow[][] = logical.map(() => []);
  const looseEvents: EventRow[] = [];
  for (const event of events) {
    const t = new Date(event.createdAt).getTime();
    let placed = false;
    for (let i = 0; i < logical.length; i += 1) {
      const start = new Date(logical[i].startedAt).getTime();
      const end = new Date(logical[i].endIso).getTime() + SESSION_MERGE_GAP_SECONDS * 1000;
      if (t >= start && t <= end) {
        eventsForSession[i].push(event);
        placed = true;
        break;
      }
    }
    if (!placed) looseEvents.push(event);
  }

  const timelineSessions: TimelineSession[] = logical.map((session, i) => {
    const sessionEvents = eventsForSession[i];
    const moduleAgg = new Map<string, { label: string; seconds: number; views: number }>();
    let activeSeconds = 0;
    for (const event of sessionEvents) {
      const dwell = cappedDwellSeconds(event.durationMs);
      activeSeconds += dwell;
      const entry = moduleAgg.get(event.moduleKey) ?? { label: event.moduleLabel, seconds: 0, views: 0 };
      entry.seconds += dwell;
      entry.views += 1;
      moduleAgg.set(event.moduleKey, entry);
    }

    return {
      sessionId: null,
      startedAt: session.startedAt,
      endedAt: session.revokedAt ?? null,
      endedReason: logicalSessionEndedReason(session, nowMs),
      durationMinutes: minutesFromSeconds(session.durationSeconds),
      activeMinutes: minutesFromSeconds(activeSeconds),
      ip: session.ip,
      userAgent: session.userAgent,
      modules: Array.from(moduleAgg.values())
        .map((m) => ({ label: m.label, minutes: minutesFromSeconds(m.seconds), views: m.views }))
        .sort((a, b) => b.minutes - a.minutes),
      events: sessionEvents.map((event) => ({
        atIso: event.createdAt,
        moduleLabel: event.moduleLabel,
        path: event.path,
        dwellSeconds: cappedDwellSeconds(event.durationMs),
      })),
    };
  });

  // Build the aggregate summary across the range.
  const moduleSeconds = new Map<string, { label: string; seconds: number }>();
  let activeSeconds = 0;
  let pageViews = 0;
  for (const event of events) {
    const dwell = cappedDwellSeconds(event.durationMs);
    activeSeconds += dwell;
    pageViews += 1;
    const entry = moduleSeconds.get(event.moduleKey) ?? { label: event.moduleLabel, seconds: 0 };
    entry.seconds += dwell;
    moduleSeconds.set(event.moduleKey, entry);
  }
  const sessionSeconds = logical.reduce((sum, s) => sum + s.durationSeconds, 0);
  let topModule: string | null = null;
  let topModuleSeconds = -1;
  for (const value of moduleSeconds.values()) {
    if (value.seconds > topModuleSeconds) {
      topModuleSeconds = value.seconds;
      topModule = value.label;
    }
  }
  const lastSeen = logical.length
    ? logical.reduce((latest, s) => (s.endIso > latest ? s.endIso : latest), logical[0].endIso)
    : null;

  const summary: UserActivitySummary = {
    ...identity,
    sessions: logical.length,
    sessionMinutes: minutesFromSeconds(sessionSeconds),
    activeMinutes: minutesFromSeconds(activeSeconds),
    pageViews,
    distinctModules: moduleSeconds.size,
    topModule,
    lastSeenAt: lastSeen,
    engagement: computeEngagement({
      activeSeconds,
      sessionSeconds,
      distinctModules: moduleSeconds.size,
      pageViews,
    }),
  };

  // Surface session-less events (rare) as a synthetic session for completeness.
  if (looseEvents.length) {
    const moduleAgg = new Map<string, { label: string; seconds: number; views: number }>();
    let looseActive = 0;
    for (const event of looseEvents) {
      const dwell = cappedDwellSeconds(event.durationMs);
      looseActive += dwell;
      const entry = moduleAgg.get(event.moduleKey) ?? { label: event.moduleLabel, seconds: 0, views: 0 };
      entry.seconds += dwell;
      entry.views += 1;
      moduleAgg.set(event.moduleKey, entry);
    }
    timelineSessions.push({
      sessionId: null,
      startedAt: looseEvents[0]?.createdAt ?? range.fromIso,
      endedAt: looseEvents[looseEvents.length - 1]?.createdAt ?? null,
      endedReason: "unlinked",
      durationMinutes: 0,
      activeMinutes: minutesFromSeconds(looseActive),
      ip: null,
      userAgent: null,
      modules: Array.from(moduleAgg.values())
        .map((m) => ({ label: m.label, minutes: minutesFromSeconds(m.seconds), views: m.views }))
        .sort((a, b) => b.minutes - a.minutes),
      events: looseEvents.map((event) => ({
        atIso: event.createdAt,
        moduleLabel: event.moduleLabel,
        path: event.path,
        dwellSeconds: cappedDwellSeconds(event.durationMs),
      })),
    });
  }

  timelineSessions.sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));

  return { identity, range, summary, sessions: timelineSessions };
}

// ── All-user summaries (Excel export) ────────────────────────────────────────

export async function getActivityUserSummaries(range: ActivityRange): Promise<UserActivitySummary[]> {
  const [maps, sessionRowsRaw, eventRowsRaw] = await Promise.all([
    loadIdentityMaps(),
    fetchAll(
      "app_sessions",
      "id,login_id,hr_id,role,created_at,last_seen_at,revoked_at,revoked_reason,idle_expires_at,absolute_expires_at,ip,user_agent",
      (q) => q.gte("created_at", range.fromIso).lte("created_at", range.toIso),
      SESSION_FETCH_CAP,
    ),
    fetchAll(
      "activity_events",
      "hr_id,login_id,session_id,module_key,module_label,path,duration_ms,role,created_at",
      (q) => q.gte("created_at", range.fromIso).lte("created_at", range.toIso),
      EVENT_FETCH_CAP,
    ),
  ]);

  const { aggByKey } = aggregateActivity(
    maps,
    collapseSessions(sessionRowsRaw.map(mapSession)),
    eventRowsRaw.map(mapEvent),
  );
  return Array.from(aggByKey.values())
    .map(summarize)
    .sort((a, b) => b.activeMinutes - a.activeMinutes || b.pageViews - a.pageViews || b.sessionMinutes - a.sessionMinutes);
}

// ── Admin actions ─────────────────────────────────────────────────────────────

/** Revoke every active session for an HR ID immediately (force-logout). */
export async function forceLogoutUser(hrId: string, reason: string): Promise<{ revokedCount: number }> {
  const normalized = normalizeHrId(hrId);
  if (!normalized) throw new Error("Invalid HR ID");
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("app_sessions")
    .update({ revoked_at: new Date().toISOString(), revoked_reason: `admin_force_logout: ${reason}` })
    .eq("hr_id", normalized)
    .is("revoked_at", null)
    .select("id");
  if (error) throw new Error(`Force logout failed: ${error.message}`);
  return { revokedCount: data?.length ?? 0 };
}

// ── Live feed (lightweight — online users + last 15 min events) ───────────────

export async function getLiveActivity(): Promise<LiveActivity> {
  const nowIso = new Date().toISOString();
  const fifteenAgo = new Date(Date.now() - 15 * 60 * 1000).toISOString();

  const maps = await loadIdentityMaps();

  const [onlineRowsRaw, recentEventsRaw] = await Promise.all([
    fetchAll(
      "app_sessions",
      "id,login_id,hr_id,role,created_at,last_seen_at,revoked_at,revoked_reason,idle_expires_at,absolute_expires_at,ip,user_agent",
      (q) => q.is("revoked_at", null).gt("idle_expires_at", nowIso).gt("absolute_expires_at", nowIso).order("last_seen_at", { ascending: false }).limit(100),
      1,
    ),
    fetchAll(
      "activity_events",
      "hr_id,login_id,module_label,created_at",
      (q) => q.gte("created_at", fifteenAgo).order("created_at", { ascending: false }).limit(20),
      1,
    ),
  ]);

  const onlineSessions = onlineRowsRaw.map(mapSession);
  const onlineByKey = new Map<string, OnlineUser>();
  for (const session of onlineSessions) {
    const identity = resolveIdentity(maps, session.hrId, session.loginId, session.role);
    const lastSeen = session.lastSeenAt ?? session.createdAt ?? nowIso;
    const existing = onlineByKey.get(identity.key);
    if (!existing || lastSeen > existing.lastSeenAt) {
      onlineByKey.set(identity.key, {
        ...identity,
        startedAt: session.createdAt ?? nowIso,
        lastSeenAt: lastSeen,
        idleSeconds: Math.max(0, Math.round((Date.now() - new Date(lastSeen).getTime()) / 1000)),
        currentModule: existing?.currentModule ?? null,
        ip: session.ip,
      });
    }
  }

  const recentEvents: LiveEvent[] = recentEventsRaw.map((row) => {
    const identity = resolveIdentity(maps, str(row.hr_id), str(row.login_id), null);
    return {
      hrId: str(row.hr_id),
      name: identity.name,
      moduleLabel: str(row.module_label) ?? "Unknown",
      occurredAtIso: str(row.created_at) ?? nowIso,
    };
  });

  const online = Array.from(onlineByKey.values()).sort((a, b) => (a.lastSeenAt < b.lastSeenAt ? 1 : -1));
  return { online, recentEvents, generatedAtIso: nowIso };
}

// ── Inactivity check (called by the daily cron) ───────────────────────────────

export async function getInactiveUsers(thresholdDays = 7): Promise<{ hrId: string | null; name: string; role: string; daysSinceSeen: number }[]> {
  const maps = await loadIdentityMaps();
  const lookbackIso = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
  const sessionRowsRaw = await fetchAll(
    "app_sessions",
    "login_id,hr_id,last_seen_at,created_at",
    (q) => q.gte("created_at", lookbackIso).order("last_seen_at", { ascending: false }),
    SESSION_FETCH_CAP,
  );

  const lastSeenByKey = new Map<string, { iso: string; hrId: string | null; loginId: string | null }>();
  for (const row of sessionRowsRaw) {
    const when = str(row.last_seen_at) ?? str(row.created_at);
    if (!when) continue;
    const identity = resolveIdentity(maps, str(row.hr_id), str(row.login_id), null);
    const existing = lastSeenByKey.get(identity.key);
    if (!existing || when > existing.iso) {
      lastSeenByKey.set(identity.key, { iso: when, hrId: str(row.hr_id), loginId: str(row.login_id) });
    }
  }

  const results: { hrId: string | null; name: string; role: string; daysSinceSeen: number }[] = [];
  const seen = new Set<string>();
  for (const [loginId, hrId] of maps.hrIdByLoginId.entries()) {
    const employee = maps.employeeByHrId.get(hrId);
    const status = (employee?.status ?? "active").toLowerCase();
    if (!["active", "on_leave", ""].includes(status)) continue;
    const identity = resolveIdentity(maps, hrId, loginId, null);
    if (seen.has(identity.key)) continue;
    seen.add(identity.key);
    const last = lastSeenByKey.get(identity.key);
    const days = last
      ? Math.floor((Date.now() - new Date(last.iso).getTime()) / (24 * 60 * 60 * 1000))
      : 999;
    if (days >= thresholdDays) {
      results.push({ hrId: last?.hrId ?? hrId, name: identity.name, role: identity.role, daysSinceSeen: days });
    }
  }
  return results.sort((a, b) => b.daysSinceSeen - a.daysSinceSeen);
}

// ── Retention cleanup (called by the daily scheduled job) ────────────────────

export async function purgeOldActivityEvents(retentionDays = 90): Promise<{ cutoffIso: string; ok: boolean }> {
  const cutoff = new Date(Date.now() - Math.max(1, retentionDays) * 24 * 60 * 60 * 1000).toISOString();
  try {
    const supabase = getSupabaseAdmin();
    const { error } = await supabase.from("activity_events").delete().lt("created_at", cutoff);
    if (error) {
      logError("Activity retention purge failed", {
        labels: { event: "activity_purge_old_events_failed", retentionDays },
        error,
      });
      return { cutoffIso: cutoff, ok: false };
    }
    return { cutoffIso: cutoff, ok: true };
  } catch (error) {
    logError("Activity retention purge threw", {
      labels: { event: "activity_purge_old_events_threw", retentionDays },
      error,
    });
    return { cutoffIso: cutoff, ok: false };
  }
}
