import { getSupabaseAdmin } from "@/lib/supabase/server";
import { canonicalHrIdForDisplay, canonicalHrIdKey } from "@/lib/hr-id";

export type ErrorEventSource = "server" | "client";

const MAX_TEXT_LENGTH = 4000;
const MAX_USER_AGENT_LENGTH = 500;
const DEFAULT_ERROR_EVENT_RETENTION_DAYS = 90;

/**
 * Retention/cleanup for app_error_events so the table cannot grow unbounded on Cloud Run.
 * Deletes events older than the retention window (default 90 days, overridable via
 * PHOENIX_ERROR_EVENT_RETENTION_DAYS). Best-effort — never throws; returns the row count
 * where the driver reports it. Intended to be called from the daily cron.
 */
export async function pruneOldAppErrorEvents(): Promise<{ deleted: number | null; error?: string }> {
  try {
    const configured = Number(process.env.PHOENIX_ERROR_EVENT_RETENTION_DAYS);
    const retentionDays = Number.isFinite(configured) && configured > 0 ? Math.floor(configured) : DEFAULT_ERROR_EVENT_RETENTION_DAYS;
    const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();

    const { error, count } = await getSupabaseAdmin()
      .from("app_error_events")
      .delete({ count: "exact" })
      .lt("created_at", cutoff);

    if (error) return { deleted: null, error: error.message };
    return { deleted: count ?? null };
  } catch (error) {
    return { deleted: null, error: error instanceof Error ? error.message : "prune failed" };
  }
}

function truncate(value: string | null | undefined, max: number): string | null {
  if (!value) return null;
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

export type LogAppErrorInput = {
  source: ErrorEventSource;
  routeType?: string | null;
  hrId?: string | null;
  loginId?: string | null;
  role?: string | null;
  moduleKey?: string | null;
  moduleLabel?: string | null;
  route?: string | null;
  message: string;
  stack?: string | null;
  digest?: string | null;
  environment?: string | null;
  release?: string | null;
  userAgent?: string | null;
};

/**
 * Best-effort insert — must never throw. A logging failure should never turn
 * into a second, user-visible error on top of the one being reported.
 */
export async function logAppError(input: LogAppErrorInput): Promise<void> {
  try {
    const supabase = getSupabaseAdmin();
    const { error } = await supabase.from("app_error_events").insert({
      digest: input.digest ?? null,
      environment: input.environment ?? null,
      hr_id: input.hrId ?? null,
      login_id: input.loginId ?? null,
      message: truncate(input.message, MAX_TEXT_LENGTH) ?? "Unknown error",
      module_key: input.moduleKey ?? "other",
      module_label: input.moduleLabel ?? "Other",
      release: input.release ?? null,
      role: input.role ?? null,
      route: input.route ?? null,
      route_type: input.routeType ?? null,
      source: input.source,
      stack: truncate(input.stack, MAX_TEXT_LENGTH),
      user_agent: truncate(input.userAgent, MAX_USER_AGENT_LENGTH),
    });

    if (error) {
      console.error("Failed to persist app_error_events row:", error.message);
    }
  } catch (loggingError) {
    console.error(
      "logAppError threw:",
      loggingError instanceof Error ? loggingError.message : loggingError,
    );
  }
}

export type ErrorEventFilter = {
  hrId?: string | null;
  moduleKey?: string | null;
  source?: ErrorEventSource | null;
  dateFrom?: string | null;
  dateTo?: string | null;
  page?: number;
  pageSize?: number;
};

export type ErrorEventRow = {
  id: string;
  createdAt: string;
  source: ErrorEventSource;
  hrId: string | null;
  loginId: string | null;
  role: string | null;
  moduleKey: string;
  moduleLabel: string;
  route: string | null;
  message: string;
  stack: string | null;
  digest: string | null;
  environment: string | null;
};

export type ErrorEventPage = {
  events: ErrorEventRow[];
  total: number;
  page: number;
  pageSize: number;
  pageCount: number;
};

export async function getErrorEvents(filter: ErrorEventFilter = {}): Promise<ErrorEventPage> {
  const supabase = getSupabaseAdmin();
  const page = Math.max(1, filter.page ?? 1);
  const pageSize = Math.min(200, Math.max(1, filter.pageSize ?? 50));
  const offset = (page - 1) * pageSize;

  let query = supabase
    .from("app_error_events")
    .select(
      "id, created_at, source, hr_id, login_id, role, module_key, module_label, route, message, stack, digest, environment",
      { count: "exact" },
    )
    .order("created_at", { ascending: false })
    .range(offset, offset + pageSize - 1);

  if (filter.hrId) query = query.ilike("hr_id", `%${filter.hrId}%`);
  if (filter.moduleKey) {
    query = query.or(`module_key.ilike.%${filter.moduleKey}%,module_label.ilike.%${filter.moduleKey}%`);
  }
  if (filter.source) query = query.eq("source", filter.source);
  if (filter.dateFrom) query = query.gte("created_at", filter.dateFrom);
  if (filter.dateTo) query = query.lte("created_at", `${filter.dateTo}T23:59:59Z`);

  const { data, error, count } = await query;
  if (error) throw error;

  const total = count ?? 0;
  const events: ErrorEventRow[] = (data ?? []).map((row: Record<string, unknown>) => ({
    createdAt: row.created_at as string,
    digest: (row.digest as string | null) ?? null,
    environment: (row.environment as string | null) ?? null,
    hrId: (row.hr_id as string | null) ?? null,
    id: String(row.id),
    loginId: (row.login_id as string | null) ?? null,
    message: (row.message as string) ?? "",
    moduleKey: (row.module_key as string) ?? "other",
    moduleLabel: (row.module_label as string) ?? "Other",
    role: (row.role as string | null) ?? null,
    route: (row.route as string | null) ?? null,
    source: row.source as ErrorEventSource,
    stack: (row.stack as string | null) ?? null,
  }));

  return { events, page, pageCount: Math.max(1, Math.ceil(total / pageSize)), pageSize, total };
}

export type UserAttemptCategory = "app_error" | "failed_login";

export type UserAttemptRow = {
  hrId: string;
  category: UserAttemptCategory;
  moduleKey: string;
  moduleLabel: string;
  route: string | null;
  attemptCount: number;
  firstSeen: string;
  lastSeen: string;
  sampleMessage: string;
};

export type UserAttemptFilter = {
  hrId?: string | null;
  dateFrom?: string | null;
  dateTo?: string | null;
};

export type UserAttemptSummary = {
  rows: UserAttemptRow[];
  /** True if either source hit the per-fetch row cap — narrow the date range for full accuracy. */
  truncated: boolean;
};

const ATTEMPT_FETCH_PAGE_SIZE = 1000;
const ATTEMPT_FETCH_ROW_CAP = 20_000;

/**
 * Aggregates app_error_events + failed auth_login_attempts into per-HR_ID, per-module/route
 * attempt counts for the System Issues "Per-user" tab. Grouping runs in application code
 * (not SQL) so no migration is needed — retention already bounds app_error_events to 90 days,
 * keeping row counts fetchable. Both sources page in ATTEMPT_FETCH_PAGE_SIZE batches up to
 * ATTEMPT_FETCH_ROW_CAP; hitting the cap sets `truncated: true` rather than silently dropping rows.
 */
export async function getUserAttemptSummary(filter: UserAttemptFilter = {}): Promise<UserAttemptSummary> {
  const supabase = getSupabaseAdmin();
  const dateFrom = filter.dateFrom ?? null;
  const dateTo = filter.dateTo ? `${filter.dateTo}T23:59:59Z` : null;

  type Bucket = {
    hrId: string;
    category: UserAttemptCategory;
    moduleKey: string;
    moduleLabel: string;
    route: string | null;
    attemptCount: number;
    firstSeen: string;
    lastSeen: string;
    sampleMessage: string;
  };
  const buckets = new Map<string, Bucket>();
  let truncated = false;

  function record(input: {
    rawHrId: string | null | undefined;
    category: UserAttemptCategory;
    moduleKey: string;
    moduleLabel: string;
    route: string | null;
    timestamp: string;
    message: string;
  }) {
    const hrKey = canonicalHrIdKey(input.rawHrId);
    if (!hrKey) return;
    const key = `${hrKey}|${input.category}|${input.moduleKey}|${input.route ?? ""}`;
    const existing = buckets.get(key);
    if (existing) {
      existing.attemptCount += 1;
      if (input.timestamp < existing.firstSeen) existing.firstSeen = input.timestamp;
      if (input.timestamp > existing.lastSeen) existing.lastSeen = input.timestamp;
    } else {
      buckets.set(key, {
        attemptCount: 1,
        category: input.category,
        firstSeen: input.timestamp,
        hrId: canonicalHrIdForDisplay(input.rawHrId) ?? hrKey,
        lastSeen: input.timestamp,
        moduleKey: input.moduleKey,
        moduleLabel: input.moduleLabel,
        route: input.route,
        sampleMessage: input.message,
      });
    }
  }

  // App errors (server + client), tagged by hr_id at capture time.
  {
    let offset = 0;
    for (;;) {
      let query = supabase
        .from("app_error_events")
        .select("hr_id, module_key, module_label, route, message, created_at")
        .not("hr_id", "is", null)
        .order("created_at", { ascending: false })
        .range(offset, offset + ATTEMPT_FETCH_PAGE_SIZE - 1);

      if (filter.hrId) query = query.ilike("hr_id", `%${filter.hrId}%`);
      if (dateFrom) query = query.gte("created_at", dateFrom);
      if (dateTo) query = query.lte("created_at", dateTo);

      const { data, error } = await query;
      if (error) throw error;
      const rows = data ?? [];
      for (const row of rows as Record<string, unknown>[]) {
        record({
          category: "app_error",
          message: (row.message as string) ?? "",
          moduleKey: (row.module_key as string) ?? "other",
          moduleLabel: (row.module_label as string) ?? "Other",
          rawHrId: row.hr_id as string | null,
          route: (row.route as string | null) ?? null,
          timestamp: row.created_at as string,
        });
      }
      offset += ATTEMPT_FETCH_PAGE_SIZE;
      if (rows.length < ATTEMPT_FETCH_PAGE_SIZE) break;
      if (offset >= ATTEMPT_FETCH_ROW_CAP) {
        truncated = true;
        break;
      }
    }
  }

  // Failed login attempts. login_id is the HR_ID credential used to sign in.
  {
    let offset = 0;
    for (;;) {
      let query = supabase
        .from("auth_login_attempts")
        .select("login_id, attempted_at")
        .eq("success", false)
        .order("attempted_at", { ascending: false })
        .range(offset, offset + ATTEMPT_FETCH_PAGE_SIZE - 1);

      if (filter.hrId) query = query.ilike("login_id", `%${filter.hrId}%`);
      if (dateFrom) query = query.gte("attempted_at", dateFrom);
      if (dateTo) query = query.lte("attempted_at", dateTo);

      const { data, error } = await query;
      if (error) throw error;
      const rows = data ?? [];
      for (const row of rows as Record<string, unknown>[]) {
        record({
          category: "failed_login",
          message: "Failed login attempt",
          moduleKey: "auth",
          moduleLabel: "Login",
          rawHrId: row.login_id as string | null,
          route: "/login",
          timestamp: row.attempted_at as string,
        });
      }
      offset += ATTEMPT_FETCH_PAGE_SIZE;
      if (rows.length < ATTEMPT_FETCH_PAGE_SIZE) break;
      if (offset >= ATTEMPT_FETCH_ROW_CAP) {
        truncated = true;
        break;
      }
    }
  }

  const rowsOut = Array.from(buckets.values()).sort((a, b) => b.attemptCount - a.attemptCount);
  return { rows: rowsOut, truncated };
}
