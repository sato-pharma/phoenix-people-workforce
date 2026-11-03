import { unstable_cache } from "next/cache.js";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { normalizeHrId, type AccessContext } from "@/lib/auth/permissions";
import { resolveEmployeeDisplayName } from "@/lib/employees/display-name";
import { hrIdLookupKeys } from "@/lib/hr-id";
import {
  ACTIVE_VIEW_CAP_SECONDS,
  cappedDwellSeconds,
  computeEngagement,
} from "@/lib/activity/engagement";
import { creditUncoveredSeconds, dwellIntervalForEvent, type DwellInterval } from "@/lib/activity/dwell-union";
import {
  cairoDateKey,
  createWorkingDayBaseline,
  expectedWorkingDaysInRange,
  listCairoDatesInRange,
} from "@/lib/activity/working-baseline";
import { forgetRememberedBundlesForSessions } from "@/lib/auth/session-bundle-cache";
import { describeDeviceLabel } from "@/lib/auth/webauthn";
import { resolveActivityModule } from "@/lib/activity/modules";
import { buildModuleJourney } from "@/lib/activity/module-journey";
import { stopPhoneAppPushForEmployee, type PhoneAppPushStopResult } from "@/lib/notifications/settings";
import { logError } from "@/lib/observability/log";
import type {
  ActivityAnomaly,
  ActivityIdentity,
  ActivityOverview,
  ActivityRange,
  AdoptionRow,
  AdoptionStatus,
  ExcludedAccount,
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
// 68,734 event rows existed on 2026-09-26 and ~9,000 more arrive each week, but
// purgeOldActivityEvents(90) deletes anything older than 90 days, so the table's
// steady state is ≈117,000 rows — against the old 120,000 cap, which would have
// started silently dropping the oldest events within weeks. Raised, AND the
// truncation is now reported (ActivityOverview.eventsTruncated): raising a cap
// on its own only moves a silent cliff, it does not remove one.
const EVENT_FETCH_CAP = 200_000;
const SESSION_FETCH_CAP = 60_000;
// No cap on the People list. It was TOP_USERS_LIMIT = 30 until 2026-09-26; the
// section is now searchable by name, and a capped list answers a search for the
// 31st person with "not found" rather than with their row. ~55 people at a few
// dozen bytes each is not a payload worth truncating for.

const ANOMALY_LIMIT = 40;
// The live feed's 15-minute window. One page is plenty (it held ~200 rows at the
// busiest hour measured); the feed shows the newest few, the rest only resolve
// each online person's current module. A .limit() here would be silently
// overwritten by fetchAll's .range(), which is why the old .limit(20) shipped
// up to 1000 events to the browser on every 30-second poll.
const LIVE_EVENT_FETCH_CAP = PAGE_SIZE;
const LIVE_EVENT_DISPLAY_LIMIT = 20;
// "Who is online now" reads live sessions the same way, and the same trap had
// been sprung twice: a .limit(300) on the page read and a .limit(100) on the
// 30-second poll, both overwritten by fetchAll's .range(), so both shipped a
// full 1,000-row page. ONE pair of numbers for both reads on purpose — honouring
// 300 on the page and 100 on the poll would make the online list shrink a second
// after the page loaded. The display limit is applied AFTER the per-person
// de-duplication, so it means 300 PEOPLE, not 300 session rows.
const ONLINE_SESSION_FETCH_CAP = PAGE_SIZE;
const ONLINE_SESSION_DISPLAY_LIMIT = 300;

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

/**
 * Logins that are a machine, not a colleague. `admin-HR` is the HR canary
 * account (`app_auth_users.hr_id` is NULL by design and it has no employee row);
 * its auth layer writes a fresh session constantly, so on 2026-09-26 it owned
 * 165 of the 382 logical sessions in a 7-day window — 43% — with zero page
 * views, which halved the "Avg session" KPI (183 min against 319 for humans)
 * and filled the odd-hour anomaly list with 36 entries of its own. Owner's
 * instruction the same day: drop it from the activity figures.
 *
 * Kept as an explicit list rather than a rule ("no HR_ID and no employee row"),
 * so a real person whose account is mis-wired shows up as a finding instead of
 * quietly vanishing from the numbers.
 */
const MACHINE_LOGIN_IDS = new Set(["admin-hr"]);

/** Whether this session / event belongs to a service login rather than a person. */
export function isMachineAccount(hrId: string | null | undefined, loginId: string | null | undefined): boolean {
  const login = String(loginId ?? "").trim().toLowerCase();
  if (login && MACHINE_LOGIN_IDS.has(login)) return true;
  const hr = normalizeHrId(hrId ?? null);
  return Boolean(hr) && MACHINE_LOGIN_IDS.has(hr!);
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

/**
 * Role averages, built from the SAME summaries the People table renders — not
 * re-scored from the aggregates. Scoring twice meant two places to keep in step
 * with the engagement rules, and only one of them ever got updated.
 */
function buildRoleBenchmarks(summaries: UserActivitySummary[]): RoleBenchmark[] {
  const groups = new Map<string, { sessionMinutes: number; activeMinutes: number; engTotal: number; engCount: number; users: number }>();
  for (const summary of summaries) {
    const role = summary.role;
    const g = groups.get(role) ?? { sessionMinutes: 0, activeMinutes: 0, engTotal: 0, engCount: 0, users: 0 };
    g.users++;
    g.sessionMinutes += summary.sessionMinutes;
    g.activeMinutes += summary.activeMinutes;
    if (summary.pageViews > 0) {
      g.engTotal += summary.engagement.score;
      g.engCount++;
    }
    groups.set(role, g);
  }
  const round1 = (value: number) => Math.round(value * 10) / 10;
  return Array.from(groups.entries())
    .map(([role, g]) => ({
      role,
      userCount: g.users,
      avgSessionMinutes: round1(g.sessionMinutes / Math.max(1, g.users)),
      avgActiveMinutes: round1(g.activeMinutes / Math.max(1, g.users)),
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

/**
 * Page through a Supabase select until exhausted or the cap is reached.
 *
 * `truncated` says the cap stopped the read with more rows still waiting — the
 * caller must either report that or be certain its cap cannot be reached. A
 * caller's own `.limit()` CANNOT survive here: `.range()` is appended after
 * `apply`, and PostgREST lets the later one win. Cap the fetch instead.
 */
async function fetchAll(
  table: string,
  columns: string,
  apply: (query: any) => any, // eslint-disable-line @typescript-eslint/no-explicit-any
  cap: number,
): Promise<{ rows: Row[]; truncated: boolean }> {
  const supabase = getSupabaseAdmin();
  const rows: Row[] = [];
  let truncated = false;
  for (let offset = 0; offset < cap; offset += PAGE_SIZE) {
    const query = apply(supabase.from(table).select(columns)).range(offset, offset + PAGE_SIZE - 1);
    const { data, error } = await query;
    if (error) {
      // Degrade gracefully when the activity_events table doesn't exist yet (its
      // migration is applied separately). The dashboard still works from sessions.
      if (isMissingRelationError(error)) {
        console.warn(`[activity] table ${table} not available yet; treating as empty`);
        return { rows, truncated: false };
      }
      throw new Error(`Failed to read ${table}: ${error.message}`);
    }
    const batch = (data ?? []) as Row[];
    rows.push(...batch);
    if (batch.length < PAGE_SIZE) break;
    // A full last page that lands exactly on the cap means there may be more.
    if (rows.length >= cap) truncated = true;
  }
  return { rows, truncated };
}

/**
 * `fetchAll`, but paged by KEYSET on (created_at, id) instead of by OFFSET.
 *
 * WHY. An offset page makes Postgres walk and discard every row before it, so page 200 of a
 * 200,000-row activity_events read scanned ~200,000 rows to return 1,000 — the whole read was
 * quadratic. And without a total order an offset page is not even stable: rows sharing one
 * `created_at` can swap between two page reads, so a row is read twice and its neighbour never.
 * A keyset seek starts each page exactly after the last row of the previous one, entering the
 * created_at indexes at the cursor, and the `id` tie-break makes the order total.
 *
 * Same contract as `fetchAll`: the same `{ rows, truncated }` cap semantics (a full page landing on
 * the cap reports `truncated`), the same missing-relation degrade, and the same row shape — `id` is
 * selected for the cursor when the caller did not ask for it, and taken off again before returning.
 * The caller's `apply` adds FILTERS only; this orders. `options` exists for the test's fake client.
 */
export async function fetchAllKeysetByTime(
  table: string,
  columns: string,
  apply: (query: any) => any, // eslint-disable-line @typescript-eslint/no-explicit-any
  direction: "asc" | "desc",
  cap: number,
  options: { client?: { from: (table: string) => any }; pageSize?: number } = {}, // eslint-disable-line @typescript-eslint/no-explicit-any
): Promise<{ rows: Row[]; truncated: boolean }> {
  const client = options.client ?? getSupabaseAdmin();
  const pageSize = options.pageSize ?? PAGE_SIZE;
  const ascending = direction === "asc";
  const seek = ascending ? "gt" : "lt";
  const callerSelectsId = columns.split(",").some((column) => column.trim() === "id");
  const selectColumns = callerSelectsId ? columns : `${columns},id`;
  const rows: Row[] = [];
  let truncated = false;
  let cursor: { createdAt: string; id: string } | null = null;
  for (let fetched = 0; fetched < cap; fetched += pageSize) {
    let query = apply(client.from(table).select(selectColumns));
    if (cursor !== null) {
      // The timestamp is double-quoted: it carries `:`, `.` and `+`, which PostgREST's or-grammar
      // would otherwise read as its own punctuation.
      query = query.or(
        `created_at.${seek}."${cursor.createdAt}",and(created_at.eq."${cursor.createdAt}",id.${seek}.${cursor.id})`,
      );
    }
    query = query.order("created_at", { ascending }).order("id", { ascending }).limit(pageSize);
    const { data, error } = await query;
    if (error) {
      if (isMissingRelationError(error)) {
        console.warn(`[activity] table ${table} not available yet; treating as empty`);
        return { rows: callerSelectsId ? rows : rows.map(withoutCursorId), truncated: false };
      }
      throw new Error(`Failed to read ${table}: ${error.message}`);
    }
    const batch = (data ?? []) as Row[];
    rows.push(...batch);
    if (batch.length < pageSize) break;
    // A full last page that lands exactly on the cap means there may be more.
    if (rows.length >= cap) truncated = true;
    const last = batch[batch.length - 1];
    cursor = { createdAt: String(last.created_at), id: String(last.id) };
  }
  return { rows: callerSelectsId ? rows : rows.map(withoutCursorId), truncated };
}

function withoutCursorId(row: Row): Row {
  const { id: _cursorId, ...rest } = row;
  return rest;
}

type IdentityMaps = {
  employeeByHrId: Map<string, { name: string; jobTitle: string | null; team: string | null; status: string | null }>;
  roleByHrId: Map<string, string>;
  hrIdByLoginId: Map<string, string>;
  /**
   * Lower-cased login ids whose account is still enabled. `is_active` was being
   * SELECTed and then never read, so a deactivated account stayed on the
   * adoption list and in the inactivity digest for ever, as a person who had
   * "stopped using Phoenix" — when in fact Phoenix had stopped letting them in.
   *
   * This deliberately does NOT prune `hrIdByLoginId`: that map is how a session
   * row gets a name, and pruning it would render a deactivated colleague's past
   * sessions as a raw login code.
   */
  activeLoginIds: Set<string>;
};

async function loadIdentityMaps(): Promise<IdentityMaps> {
  const [employees, accounts] = await Promise.all([
    fetchAll(
      "employees",
      "hr_id,full_name,nickname,job_title,region_name,employment_status",
      (q) => q,
      50_000,
    ).then((result) => result.rows),
    fetchAll(
      "app_auth_users",
      "login_id,hr_id,role,is_active",
      (q) => q,
      50_000,
    ).then((result) => result.rows),
  ]);

  const employeeByHrId = new Map<string, { name: string; jobTitle: string | null; team: string | null; status: string | null }>();
  for (const row of employees) {
    const hr = normalizeHrId(str(row.hr_id));
    if (!hr) continue;
    const fullName = str(row.full_name);
    employeeByHrId.set(hr, {
      name: fullName ? resolveEmployeeDisplayName(fullName, str(row.nickname), hr) : hr,
      jobTitle: str(row.job_title),
      team: str(row.region_name),
      status: str(row.employment_status),
    });
  }

  const roleByHrId = new Map<string, string>();
  const hrIdByLoginId = new Map<string, string>();
  const activeLoginIds = new Set<string>();
  for (const row of accounts) {
    const login = str(row.login_id);
    const hr = normalizeHrId(str(row.hr_id));
    const role = str(row.role);
    if (login && hr) hrIdByLoginId.set(login.toLowerCase(), hr);
    if (hr && role) roleByHrId.set(hr, role);
    // A legacy NULL counts as active, so this changes nobody's status today.
    if (login && row.is_active !== false) activeLoginIds.add(login.toLowerCase());
  }

  return { employeeByHrId, roleByHrId, hrIdByLoginId, activeLoginIds };
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
  /** app_sessions.id of the earliest row merged in — a stable identifier for the UI. */
  firstRowId: string | null;
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
          firstRowId: row.id,
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
  /** When the page became visible. Populated on 100% of rows measured over 30 days. */
  enteredAt: string | null;
};

/** An event plus the seconds of wall clock no other page view of the same person covers. */
type CreditedEvent = EventRow & { creditedSeconds: number };

function mapEvent(row: Row): EventRow {
  const path = str(row.path) ?? "/";
  // Re-resolve the module from the PATH instead of trusting module_key /
  // module_label, which were frozen at insert time. A row written before a
  // route had a rule carries the catch-all bucket for ever, so every map fix
  // used to need a backfill; resolving on read re-labels history as well as
  // new traffic. The stored columns stay for other consumers.
  const resolved = resolveActivityModule(path);
  return {
    hrId: str(row.hr_id),
    loginId: str(row.login_id),
    sessionId: str(row.session_id),
    moduleKey: resolved.key,
    moduleLabel: resolved.label,
    path,
    durationMs: num(row.duration_ms),
    role: str(row.role),
    createdAt: str(row.created_at) ?? new Date().toISOString(),
    enteredAt: str(row.entered_at),
  };
}

/**
 * Credit every event only for wall clock no OTHER page view of the same person
 * already covered.
 *
 * Two open browser windows are both `visible`, so both record dwell over the
 * same minute; summing them counted that minute twice, and one person's summed
 * dwell reached 111% of their own logged-in time. The union is run ONCE per
 * person across the whole window — never per session, which would split an
 * interval at the boundary and then credit both halves.
 */
function creditEventDwell(events: EventRow[], keyFor: (event: EventRow, index: number) => string): CreditedEvent[] {
  const intervals: DwellInterval[] = new Array(events.length);
  const indicesByPerson = new Map<string, number[]>();

  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    intervals[index] = dwellIntervalForEvent({
      createdAtIso: event.createdAt,
      enteredAtIso: event.enteredAt,
      // The per-view cap is applied BEFORE the union, so a forgotten tab cannot
      // swallow a whole day of somebody else's real page views.
      dwellSeconds: cappedDwellSeconds(event.durationMs),
    }) ?? { startMs: 0, endMs: 0 };
    const key = keyFor(event, index);
    const list = indicesByPerson.get(key);
    if (list) list.push(index);
    else indicesByPerson.set(key, [index]);
  }

  const credited = new Array<number>(events.length).fill(0);
  for (const indices of indicesByPerson.values()) {
    const seconds = creditUncoveredSeconds(indices.map((index) => intervals[index]));
    for (let position = 0; position < indices.length; position += 1) {
      credited[indices[position]] = seconds[position];
    }
  }

  return events.map((event, index) => ({ ...event, creditedSeconds: credited[index] }));
}

type Agg = {
  identity: ActivityIdentity;
  /** The employee's job title — decides whether Saturday is a working day. */
  jobTitle: string | null;
  sessions: number;
  sessionSeconds: number;
  activeSeconds: number;
  pageViews: number;
  moduleSeconds: Map<string, { label: string; seconds: number }>;
  /** Distinct Cairo dates carrying at least one page view — the regularity signal. */
  activeDays: Set<string>;
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
        jobTitle: identity.hrId ? maps.employeeByHrId.get(identity.hrId)?.jobTitle ?? null : null,
        sessions: 0,
        sessionSeconds: 0,
        activeSeconds: 0,
        pageViews: 0,
        moduleSeconds: new Map(),
        activeDays: new Set<string>(),
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

  // Resolve each event's person first, then run the overlap sweep per person, so
  // the credited seconds every tile below adds up are already de-duplicated.
  // Resolving identity here (rather than inside creditEventDwell) matters: an
  // event carrying only a login id and one carrying the HR id belong to the same
  // colleague, and bucketing on the raw columns would let their windows overlap
  // unnoticed.
  const aggForEvent = events.map((event) => ensureAgg(event.hrId, event.loginId, event.role));
  const creditedEvents = creditEventDwell(events, (_event, index) => aggForEvent[index].identity.key);

  for (let index = 0; index < creditedEvents.length; index += 1) {
    const event = creditedEvents[index];
    const agg = aggForEvent[index];
    const credited = event.creditedSeconds;
    agg.activeSeconds += credited;
    agg.pageViews += 1;
    totalActiveSeconds += credited;

    const perUserModule = agg.moduleSeconds.get(event.moduleKey) ?? { label: event.moduleLabel, seconds: 0 };
    perUserModule.seconds += credited;
    agg.moduleSeconds.set(event.moduleKey, perUserModule);

    const dayKey = cairoDateKey(event.createdAt);
    if (dayKey) agg.activeDays.add(dayKey);

    if (event.createdAt && (!agg.lastSeen || event.createdAt > agg.lastSeen)) agg.lastSeen = event.createdAt;

    const moduleTotal = moduleTotals.get(event.moduleKey) ?? { label: event.moduleLabel, seconds: 0, views: 0, users: new Set<string>() };
    moduleTotal.seconds += credited;
    moduleTotal.views += 1;
    moduleTotal.users.add(agg.identity.key);
    moduleTotals.set(event.moduleKey, moduleTotal);
  }

  return { aggByKey, moduleTotals, totalActiveSeconds };
}

function summarize(agg: Agg, expectedWorkingDaysFor: (jobTitle: string | null) => number): UserActivitySummary {
  const engagement = computeEngagement({
    activeSeconds: agg.activeSeconds,
    expectedWorkingDays: expectedWorkingDaysFor(agg.jobTitle),
    distinctModules: agg.moduleSeconds.size,
    daysActive: agg.activeDays.size,
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

  const [maps, sessionRead, eventRead, onlineRead, adoptionRead] = await Promise.all([
    loadIdentityMaps(),
    fetchAll(
      "app_sessions",
      "id,login_id,hr_id,role,created_at,last_seen_at,revoked_at,revoked_reason,idle_expires_at,absolute_expires_at,ip,user_agent",
      (q) => q.gte("created_at", range.fromIso).lte("created_at", range.toIso).order("created_at", { ascending: false }),
      SESSION_FETCH_CAP,
    ),
    fetchAllKeysetByTime(
      "activity_events",
      "hr_id,login_id,session_id,module_key,module_label,path,duration_ms,role,created_at,entered_at",
      (q) => q.gte("created_at", range.fromIso).lte("created_at", range.toIso),
      "desc",
      EVENT_FETCH_CAP,
    ),
    fetchAll(
      "app_sessions",
      "id,login_id,hr_id,role,created_at,last_seen_at,revoked_at,revoked_reason,idle_expires_at,absolute_expires_at,ip,user_agent",
      (q) => q.is("revoked_at", null).gt("idle_expires_at", nowIso).gt("absolute_expires_at", nowIso).order("last_seen_at", { ascending: false }),
      ONLINE_SESSION_FETCH_CAP,
    ),
    fetchAll(
      "app_sessions",
      "login_id,hr_id,last_seen_at,created_at",
      (q) => q.gte("created_at", adoptionFromIso).order("last_seen_at", { ascending: false }),
      SESSION_FETCH_CAP,
    ),
  ]);
  const sessionRowsRaw = sessionRead.rows;
  const eventRowsRaw = eventRead.rows;
  const onlineRowsRaw = onlineRead.rows;
  const adoptionSessionRowsRaw = adoptionRead.rows;

  // Machine logins are dropped BEFORE anything is counted — sessions, events,
  // online, anomalies, benchmarks and every KPI derived from them. Their volume
  // is kept so the page can say what it left out.
  const allSessions = sessionRowsRaw.map(mapSession);
  const sessions = allSessions.filter((row) => !isMachineAccount(row.hrId, row.loginId));
  const logicalSessions = collapseSessions(sessions);
  const allEvents = eventRowsRaw.map(mapEvent);
  const events = allEvents.filter((row) => !isMachineAccount(row.hrId, row.loginId));
  const onlineSessions = onlineRowsRaw.map(mapSession).filter((row) => !isMachineAccount(row.hrId, row.loginId));

  const excludedTally = new Map<string, ExcludedAccount>();
  function excludedEntry(hrId: string | null, loginId: string | null): ExcludedAccount {
    const name = (loginId ?? hrId ?? "unknown").trim();
    const key = name.toLowerCase();
    const entry = excludedTally.get(key) ?? { name, sessions: 0, pageViews: 0 };
    excludedTally.set(key, entry);
    return entry;
  }
  // Counted the same way the KPI counts them: collapsed logical sessions, not
  // raw app_sessions rows, so the footnote is comparable to the tile above it.
  for (const session of collapseSessions(allSessions.filter((row) => isMachineAccount(row.hrId, row.loginId)))) {
    excludedEntry(session.hrId, session.loginId).sessions += 1;
  }
  for (const row of allEvents) {
    if (isMachineAccount(row.hrId, row.loginId)) excludedEntry(row.hrId, row.loginId).pageViews += 1;
  }
  const excludedAccounts = Array.from(excludedTally.values()).sort((a, b) => b.sessions - a.sessions);

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
  const expectedWorkingDaysFor = createWorkingDayBaseline(range.fromIso, range.toIso);
  const allSummaries = Array.from(aggByKey.values()).map((agg) => summarize(agg, expectedWorkingDaysFor));
  const people = [...allSummaries].sort(
    (a, b) =>
      b.activeMinutes - a.activeMinutes ||
      b.pageViews - a.pageViews ||
      b.sessionMinutes - a.sessionMinutes ||
      (a.lastSeenAt && b.lastSeenAt ? (a.lastSeenAt < b.lastSeenAt ? 1 : -1) : 0),
  );

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
  const online: OnlineUser[] = Array.from(onlineByKey.values())
    .sort((a, b) => (a.lastSeenAt < b.lastSeenAt ? 1 : -1))
    .slice(0, ONLINE_SESSION_DISPLAY_LIMIT);

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
    // A disabled login cannot sign in, so it is not a person who stopped using
    // Phoenix — it is an account Phoenix stopped admitting. Leaving it here
    // reported a revoked account as a dormant colleague for ever.
    if (!maps.activeLoginIds.has(loginId)) continue;

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
    people,
    adoption: { counts: adoptionCounts, rows: adoptionRows },
    anomalies: anomalies.slice(0, ANOMALY_LIMIT),
    hourlyHeatmap: buildHourlyHeatmap(logicalSessions),
    roleBenchmarks: buildRoleBenchmarks(allSummaries),
    excludedAccounts,
    eventsTruncated: eventRead.truncated,
  };
}

// This diagnostic loads up to EVENT_FETCH_CAP (200k) events / SESSION_FETCH_CAP
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

  const loginCalendarFromIso = new Date(Date.now() - ADOPTION_LOOKBACK_DAYS * 24 * 60 * 60 * 1000).toISOString();

  const [sessionRead, eventRead, loginCalendarRead] = await Promise.all([
    fetchAll(
      "app_sessions",
      "id,login_id,hr_id,role,created_at,last_seen_at,revoked_at,revoked_reason,idle_expires_at,absolute_expires_at,ip,user_agent",
      // app_sessions stores the display spelling, not the lower-cased key — see
      // forceLogoutUser. Filtering it by `hrId` (lower-cased) returned zero rows,
      // so this timeline showed a user's events with no sessions at all.
      (q) => q.in("hr_id", hrIdLookupKeys(targetHrId)).gte("created_at", range.fromIso).lte("created_at", range.toIso).order("created_at", { ascending: false }),
      SESSION_FETCH_CAP,
    ),
    fetchAllKeysetByTime(
      "activity_events",
      "hr_id,login_id,session_id,module_key,module_label,path,duration_ms,role,created_at,entered_at",
      // Every accepted spelling, exactly like the session read above. This was an
      // `.eq(hrId)` on the lower-cased key until 2026-09-26, and activity_events
      // does NOT store one spelling: 51,024 rows are lower-cased across 56 people,
      // and 11,934 are `B-10` — the owner's own history, invisible on his own
      // timeline for every window reaching before 19 Aug 2026.
      (q) => q.in("hr_id", hrIdLookupKeys(targetHrId)).gte("created_at", range.fromIso).lte("created_at", range.toIso),
      "asc",
      EVENT_FETCH_CAP,
    ),
    // The login-frequency calendar's OWN window. It is labelled in months and
    // must not follow the range picker: fed from `sessions` it drew a 90-day grid
    // out of 1, 7 or 30 days of rows and called the empty remainder "no login".
    fetchAll(
      "app_sessions",
      "created_at",
      (q) => q.in("hr_id", hrIdLookupKeys(targetHrId)).gte("created_at", loginCalendarFromIso).order("created_at", { ascending: true }),
      SESSION_FETCH_CAP,
    ),
  ]);

  const sessions = sessionRead.rows.map(mapSession);
  const events = eventRead.rows.map(mapEvent);
  const creditedEvents = creditEventDwell(events, () => identity.key);
  const creditedSecondsByEvent = new Map<EventRow, number>();
  for (let index = 0; index < events.length; index += 1) {
    creditedSecondsByEvent.set(events[index], creditedEvents[index].creditedSeconds);
  }
  const creditedFor = (event: EventRow) => creditedSecondsByEvent.get(event) ?? 0;

  // Bucket logins by Cairo day, server-side. The client then owns no clock at
  // all: it used to key on the UTC date and grid from browser-local Dates, so
  // between 00:00 and 03:00 Cairo the "today" ring landed on yesterday.
  const loginCountsByDay = new Map<string, number>();
  for (const row of loginCalendarRead.rows) {
    const dayKey = cairoDateKey(str(row.created_at));
    if (!dayKey) continue;
    loginCountsByDay.set(dayKey, (loginCountsByDay.get(dayKey) ?? 0) + 1);
  }
  const loginCalendarDays = listCairoDatesInRange(loginCalendarFromIso, new Date().toISOString());
  const loginCalendar = {
    days: ADOPTION_LOOKBACK_DAYS,
    todayKey: loginCalendarDays[loginCalendarDays.length - 1] ?? "",
    counts: loginCalendarDays.map((dateIso) => ({ dateIso, logins: loginCountsByDay.get(dateIso) ?? 0 })),
  };

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
      const credited = creditedFor(event);
      activeSeconds += credited;
      const entry = moduleAgg.get(event.moduleKey) ?? { label: event.moduleLabel, seconds: 0, views: 0 };
      entry.seconds += credited;
      entry.views += 1;
      moduleAgg.set(event.moduleKey, entry);
    }

    return {
      sessionId: session.firstRowId,
      startedAt: session.startedAt,
      endedAt: session.revokedAt ?? null,
      endedReason: logicalSessionEndedReason(session, nowMs),
      durationMinutes: minutesFromSeconds(session.durationSeconds),
      activeMinutes: minutesFromSeconds(activeSeconds),
      ip: session.ip,
      userAgent: session.userAgent,
      // Resolved on the server: describeDeviceLabel lives in the WebAuthn module,
      // which pulls @simplewebauthn/server and the admin client, so a "use client"
      // component can never import it.
      deviceLabel: describeDeviceLabel(session.userAgent),
      modules: Array.from(moduleAgg.values())
        .map((m) => ({ label: m.label, minutes: minutesFromSeconds(m.seconds), views: m.views }))
        .sort((a, b) => b.minutes - a.minutes),
      events: sessionEvents.map((event) => ({
        atIso: event.createdAt,
        moduleLabel: event.moduleLabel,
        path: event.path,
        // The page's OWN dwell, not its credited share: a page opened in a second
        // window is real, and rendering it as "0s" on the trail would read as a
        // bug rather than as overlap.
        dwellSeconds: cappedDwellSeconds(event.durationMs),
      })),
    };
  });

  // Build the aggregate summary across the range.
  const moduleSeconds = new Map<string, { label: string; seconds: number }>();
  const activeDays = new Set<string>();
  let activeSeconds = 0;
  let pageViews = 0;
  for (const event of events) {
    const credited = creditedFor(event);
    activeSeconds += credited;
    pageViews += 1;
    const entry = moduleSeconds.get(event.moduleKey) ?? { label: event.moduleLabel, seconds: 0 };
    entry.seconds += credited;
    moduleSeconds.set(event.moduleKey, entry);
    const dayKey = cairoDateKey(event.createdAt);
    if (dayKey) activeDays.add(dayKey);
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
      expectedWorkingDays: expectedWorkingDaysInRange(
        range.fromIso,
        range.toIso,
        identity.hrId ? maps.employeeByHrId.get(identity.hrId)?.jobTitle ?? null : null,
      ),
      distinctModules: moduleSeconds.size,
      daysActive: activeDays.size,
    }),
  };

  // Surface session-less events (rare) as a synthetic session for completeness.
  if (looseEvents.length) {
    const moduleAgg = new Map<string, { label: string; seconds: number; views: number }>();
    let looseActive = 0;
    for (const event of looseEvents) {
      const credited = creditedFor(event);
      looseActive += credited;
      const entry = moduleAgg.get(event.moduleKey) ?? { label: event.moduleLabel, seconds: 0, views: 0 };
      entry.seconds += credited;
      entry.views += 1;
      moduleAgg.set(event.moduleKey, entry);
    }
    timelineSessions.push({
      // Not a real app_sessions row — these events carry no session that survived
      // the window. A stable literal so React still has a key.
      sessionId: "unlinked",
      startedAt: looseEvents[0]?.createdAt ?? range.fromIso,
      endedAt: looseEvents[looseEvents.length - 1]?.createdAt ?? null,
      endedReason: "unlinked",
      durationMinutes: 0,
      activeMinutes: minutesFromSeconds(looseActive),
      ip: null,
      userAgent: null,
      deviceLabel: null,
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

  // Ascending by created_at, which is how the read above is ordered — the run
  // collapse inside buildModuleJourney is meaningless on unsorted rows.
  const journey = buildModuleJourney(
    events.map((event) => ({
      moduleKey: event.moduleKey,
      moduleLabel: event.moduleLabel,
      createdAt: event.createdAt,
      enteredAt: event.enteredAt,
      creditedSeconds: creditedFor(event),
    })),
  );

  return { identity, range, summary, sessions: timelineSessions, loginCalendar, journey };
}


// ── All-user summaries (Excel export) ────────────────────────────────────────

export async function getActivityUserSummaries(range: ActivityRange): Promise<UserActivitySummary[]> {
  const [maps, sessionRead, eventRead] = await Promise.all([
    loadIdentityMaps(),
    fetchAll(
      "app_sessions",
      "id,login_id,hr_id,role,created_at,last_seen_at,revoked_at,revoked_reason,idle_expires_at,absolute_expires_at,ip,user_agent",
      (q) => q.gte("created_at", range.fromIso).lte("created_at", range.toIso),
      SESSION_FETCH_CAP,
    ),
    // Keyset-paged like the screen's read, in the screen's order: the offset pages had no order at
    // all here, so rows could repeat or vanish between two pages of the same export.
    fetchAllKeysetByTime(
      "activity_events",
      "hr_id,login_id,session_id,module_key,module_label,path,duration_ms,role,created_at,entered_at",
      (q) => q.gte("created_at", range.fromIso).lte("created_at", range.toIso),
      "desc",
      EVENT_FETCH_CAP,
    ),
  ]);

  // Same exclusion as the screen, so the CSV export and the page agree.
  const { aggByKey } = aggregateActivity(
    maps,
    collapseSessions(sessionRead.rows.map(mapSession).filter((row) => !isMachineAccount(row.hrId, row.loginId))),
    eventRead.rows.map(mapEvent).filter((row) => !isMachineAccount(row.hrId, row.loginId)),
  );
  const expectedWorkingDaysFor = createWorkingDayBaseline(range.fromIso, range.toIso);
  return Array.from(aggByKey.values())
    .map((agg) => summarize(agg, expectedWorkingDaysFor))
    .sort((a, b) => b.activeMinutes - a.activeMinutes || b.pageViews - a.pageViews || b.sessionMinutes - a.sessionMinutes);
}

// ── Admin actions ─────────────────────────────────────────────────────────────

/**
 * Revoke every active session for an HR ID immediately (force-logout), then stop
 * the Phoenix app's notifications on their phones.
 *
 * The phone half (stopPhoneAppPushForEmployee) runs after the sessions are
 * revoked and never undoes them. If it fails, the logout still stands,
 * `phonePush` comes back null, and pressing Force logout again retries it.
 *
 * `app_sessions.hr_id` stores the value VERBATIM as it was supplied at login
 * (see createAppSession in @/lib/auth/app-sessions), which in production means
 * the uppercase display spelling — measured 2026-08-09: 2,627 uppercase rows,
 * 549 mixed-case, and NOT ONE lowercase row out of 3,176.
 *
 * `normalizeHrId` lower-cases, and PostgREST `.eq` is case-sensitive, so the
 * previous `.eq("hr_id", normalized)` matched ZERO rows for EVERY user. Force
 * logout returned `{ revokedCount: 0 }` alongside a success response: the admin
 * saw the action succeed, and ~1,900 live sessions across 34 users stayed valid.
 * A security control that reports success while doing nothing is worse than one
 * that is missing, because nobody goes looking for a second way to do it.
 *
 * Matching every accepted spelling (raw / lower / upper / canonical, via the
 * shared hrIdLookupKeys) fixes it without assuming a casing convention this
 * table has never actually enforced.
 *
 * activity_events needs the SAME treatment, and the note that used to sit here
 * said the opposite. It claimed that table stores the lowercase form "23,967 of
 * 23,967 rows", so an `.eq(normalized)` on it was already correct. Re-measured
 * on production 2026-09-26: 51,024 rows are lower-cased across 56 people, and
 * 11,934 are spelled `B-10` — the owner's own history, written 29 Jun to 19 Aug
 * 2026. His timeline showed none of it. The write path lower-cases today
 * (recordPageView), so nothing new arrives mis-spelled and the last of the old
 * block ages out of the 90-day retention purge around 17 Nov 2026; both reads
 * match every accepted spelling in the meantime, and no repair UPDATE is run —
 * that class of write is what left ~37,000 bad actor ids across 52 columns.
 */
export type ForceLogoutResult = {
  phonePush: PhoneAppPushStopResult | null;
  revokedCount: number;
};

export async function forceLogoutUser(hrId: string, reason: string): Promise<ForceLogoutResult> {
  const normalized = normalizeHrId(hrId);
  if (!normalized) throw new Error("Invalid HR ID");
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("app_sessions")
    .update({ revoked_at: new Date().toISOString(), revoked_reason: `admin_force_logout: ${reason}` })
    .in("hr_id", hrIdLookupKeys(hrId))
    .is("revoked_at", null)
    .select("id");
  if (error) throw new Error(`Force logout failed: ${error.message}`);
  // These sessions are revoked: drop this process's last-accepted copy of each (session-bundle-cache.ts).
  forgetRememberedBundlesForSessions((data ?? []).map((row) => String((row as { id?: unknown }).id ?? "")));

  let phonePush: PhoneAppPushStopResult | null = null;
  try {
    phonePush = await stopPhoneAppPushForEmployee(hrId);
  } catch (pushError) {
    logError("Force logout could not stop the phone app's notifications", {
      error: pushError,
      labels: { event: "force_logout_phone_app_push_failed" },
    });
  }
  return { phonePush, revokedCount: data?.length ?? 0 };
}

// ── Live feed (lightweight — online users + last 15 min events) ───────────────

export async function getLiveActivity(): Promise<LiveActivity> {
  const nowIso = new Date().toISOString();
  const fifteenAgo = new Date(Date.now() - 15 * 60 * 1000).toISOString();

  const maps = await loadIdentityMaps();

  const [onlineRead, recentEventsRead] = await Promise.all([
    fetchAll(
      "app_sessions",
      "id,login_id,hr_id,role,created_at,last_seen_at,revoked_at,revoked_reason,idle_expires_at,absolute_expires_at,ip,user_agent",
      (q) => q.is("revoked_at", null).gt("idle_expires_at", nowIso).gt("absolute_expires_at", nowIso).order("last_seen_at", { ascending: false }),
      ONLINE_SESSION_FETCH_CAP,
    ),
    fetchAll(
      "activity_events",
      "hr_id,login_id,path,created_at",
      (q) => q.gte("created_at", fifteenAgo).order("created_at", { ascending: false }),
      LIVE_EVENT_FETCH_CAP,
    ),
  ]);
  const onlineRowsRaw = onlineRead.rows;

  const recentRows = recentEventsRead.rows.filter((row) => !isMachineAccount(str(row.hr_id), str(row.login_id)));

  // Newest event per person in the last 15 minutes — this is what fills the
  // "Current module" column. The poll replaces the server-rendered online list
  // wholesale, so without this the column blanked a second after the page
  // loaded and never came back.
  const latestModuleByKey = new Map<string, string>();
  for (const row of recentRows) {
    const identity = resolveIdentity(maps, str(row.hr_id), str(row.login_id), null);
    if (latestModuleByKey.has(identity.key)) continue; // rows arrive newest-first
    latestModuleByKey.set(identity.key, resolveActivityModule(str(row.path)).label);
  }

  const onlineSessions = onlineRowsRaw.map(mapSession).filter((row) => !isMachineAccount(row.hrId, row.loginId));
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
        currentModule: latestModuleByKey.get(identity.key) ?? existing?.currentModule ?? null,
        ip: session.ip,
      });
    }
  }

  const recentEvents: LiveEvent[] = recentRows.slice(0, LIVE_EVENT_DISPLAY_LIMIT).map((row) => {
    const identity = resolveIdentity(maps, str(row.hr_id), str(row.login_id), null);
    return {
      hrId: str(row.hr_id),
      name: identity.name,
      moduleLabel: resolveActivityModule(str(row.path)).label,
      occurredAtIso: str(row.created_at) ?? nowIso,
    };
  });

  const online = Array.from(onlineByKey.values())
    .sort((a, b) => (a.lastSeenAt < b.lastSeenAt ? 1 : -1))
    .slice(0, ONLINE_SESSION_DISPLAY_LIMIT);
  return { online, recentEvents, generatedAtIso: nowIso };
}

// ── Inactivity check (called by the daily cron) ───────────────────────────────

export type InactiveUser = {
  hrId: string | null;
  name: string;
  role: string;
  daysSinceSeen: number;
  /** Their last sign-in, or null when they have never signed in at all. */
  lastSeenIso: string | null;
};

export async function getInactiveUsers(thresholdDays = 7): Promise<InactiveUser[]> {
  const maps = await loadIdentityMaps();
  const lookbackIso = new Date(Date.now() - ADOPTION_LOOKBACK_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const sessionRowsRaw = (await fetchAll(
    "app_sessions",
    "login_id,hr_id,last_seen_at,created_at",
    (q) => q.gte("created_at", lookbackIso).order("last_seen_at", { ascending: false }),
    SESSION_FETCH_CAP,
  )).rows;

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

  const results: InactiveUser[] = [];
  const seen = new Set<string>();
  for (const [loginId, hrId] of maps.hrIdByLoginId.entries()) {
    const employee = maps.employeeByHrId.get(hrId);
    const status = (employee?.status ?? "active").toLowerCase();
    if (!["active", "on_leave", ""].includes(status)) continue;
    // A disabled login cannot sign in; reporting it as inactive is reporting the
    // deactivation, every day, for ever.
    if (!maps.activeLoginIds.has(loginId)) continue;
    const identity = resolveIdentity(maps, hrId, loginId, null);
    if (seen.has(identity.key)) continue;
    seen.add(identity.key);
    const last = lastSeenByKey.get(identity.key);
    // 999 is a sentinel for "never signed in", not a measurement. lastSeenIso is
    // null in that case so the digest can say so in words.
    const days = last
      ? Math.floor((Date.now() - new Date(last.iso).getTime()) / (24 * 60 * 60 * 1000))
      : 999;
    if (days >= thresholdDays) {
      results.push({
        hrId: last?.hrId ?? hrId,
        name: identity.name,
        role: identity.role,
        daysSinceSeen: days,
        lastSeenIso: last?.iso ?? null,
      });
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
