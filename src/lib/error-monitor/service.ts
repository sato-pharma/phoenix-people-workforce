import { getSupabaseAdmin } from "@/lib/supabase/server";
import { canonicalHrIdForDisplay, canonicalHrIdKey, hrIdLookupKeys } from "@/lib/hr-id";
import { getBlockedIps, type BlockedIp } from "@/lib/auth/ip-blocklist";
import { deriveAppErrorStatus, getCurrentReleaseTag, shouldPersistErrorEvents, signatureKey, type IssueStatus } from "@/lib/error-monitor/derived-status";
import { redactSecretsFromRoute } from "@/lib/error-monitor/redact-route";
import { classifySupabaseUnreachable } from "@/lib/error-monitor/supabase-unreachable";
import { logError } from "@/lib/observability/log";
import { ilikeAnyFilter } from "@/lib/supabase/search-filter";

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

/**
 * EVERY read of app_error_events must exclude this environment — add it to any new query.
 *
 * `.env.local` on the maintainer machines points at the PRODUCTION Supabase project, so until
 * shouldPersistErrorEvents() started gating writes (2026-07-30) a local `next dev` server wrote
 * its normal iterate-and-reload churn straight into the production error table. 275 of that
 * table's 903 rows are `environment='development'`, spanning 2026-07-06..07-30, and they read
 * exactly like an outage — bursts of `X is not defined` on whatever page was being built that
 * day. Those historical rows still exist (deleting production data needs owner approval), so
 * filtering them out on READ is what makes /admin/error-monitor and /admin/system-issues
 * truthful. The write-side gate only stops new ones accumulating.
 *
 * NOT safe as a plain `neq` — that was the bug (2026-08-13). The paragraph here used to claim the
 * column has no NULLs because logAppError "always sets" it. It does not: the insert below took
 * `input.environment ?? null`, so the stamp was only ever as good as each caller. When
 * /api/admin/outstation/expenses started logging its own 500s directly (2026-08-12) it passed no
 * environment, and `NULL != 'development'` is NULL rather than true, so PostgREST's `neq` dropped
 * those rows from EVERY read. Sixteen production errors — twelve unreadable ones and four real
 * `permission denied for table expense_claims` — existed in the table and appeared on neither
 * /admin/error-monitor nor /admin/system-issues. A dashboard that silently hides errors is worse
 * than no dashboard.
 *
 * Fixed at both ends: the writer below now stamps `environment`/`release` itself so a caller
 * cannot omit them, and reads use the NULL-safe filter so the rows already written stay visible.
 * Staging is unaffected — it builds with NODE_ENV=production and writes to its own project.
 */
const DEVELOPMENT_ENVIRONMENT = "development";

/** NULL-safe form of "not development", for `.or(...)`. A bare `.neq` drops NULL-stamped rows. */
const NON_DEVELOPMENT_ENVIRONMENT_FILTER = `environment.is.null,environment.neq.${DEVELOPMENT_ENVIRONMENT}`;

/** The stamp every row gets when its caller does not supply one. Matches /api/errors/client. */
function currentEnvironmentLabel(): string {
  return process.env.APP_ENV || process.env.NODE_ENV || DEVELOPMENT_ENVIRONMENT;
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
  // Which component tree threw (from a React error boundary's errorInfo). Appended to
  // `stack` under a separator so no schema change is needed. Must stay in sync with
  // COMPONENT_STACK_SEPARATOR in message-decode.ts (extractTopComponent reads it).
  componentStack?: string | null;
  // Browser state at throw time (readyState, visibility, connection, sequence) from
  // report-client-error.ts. PREPENDED to `stack` under its own separator — see
  // combineStack for why it leads rather than trails.
  clientContext?: string | null;
};

/** Kept identical to the separator in message-decode.ts's extractTopComponent. */
const COMPONENT_STACK_SEPARATOR = "— Component stack —";
const CLIENT_CONTEXT_SEPARATOR = "— Client context —";

/**
 * The client context leads deliberately. `stack` is truncated to MAX_TEXT_LENGTH from the
 * END, and a React component stack alone can run past that, so appending the context would
 * silently drop exactly the diagnostic the row was captured for. Leading also keeps
 * extractTopComponent correct, since it seeks COMPONENT_STACK_SEPARATOR by index rather
 * than assuming an offset.
 */
function combineStack(
  stack: string | null | undefined,
  componentStack: string | null | undefined,
  clientContext?: string | null,
): string | null {
  const base = stack ? `${stack}\n\n` : "";
  const withComponent = componentStack ? `${base}${COMPONENT_STACK_SEPARATOR}\n${componentStack}` : (stack ?? null);
  if (!clientContext) return withComponent;
  const contextBlock = `${CLIENT_CONTEXT_SEPARATOR}\n${clientContext}`;
  return withComponent ? `${contextBlock}\n\n${withComponent}` : contextBlock;
}

/**
 * Best-effort insert — must never throw. A logging failure should never turn
 * into a second, user-visible error on top of the one being reported.
 */
export async function logAppError(input: LogAppErrorInput): Promise<void> {
  // Local dev: keep the signal on the developer's own console and leave the shared
  // (production) table alone. Returning here rather than at the API route covers every
  // caller — the client reporter and instrumentation.ts's onRequestError both funnel
  // through /api/errors/client into this one function.
  if (!shouldPersistErrorEvents()) {
    console.error(
      `[app-error:not-persisted] ${redactSecretsFromRoute(input.route) ?? "(no route)"} — ${input.message}`,
      input.stack ?? "",
    );
    return;
  }

  // Cloudflare's whole "521: Web server is down" page is what a Supabase outage used to leave in this column —
  // thousands of characters of markup per row. It is stored as the one readable line the Sentry issue carries.
  const message = classifySupabaseUnreachable(input.message)?.line ?? input.message;

  try {
    const supabase = getSupabaseAdmin();
    const { error } = await supabase.from("app_error_events").insert({
      digest: input.digest ?? null,
      // Defaulted HERE, not left to the caller. A row with no environment is invisible to every
      // read filter, and a row with no release cannot be told apart from one on the live build.
      environment: input.environment ?? currentEnvironmentLabel(),
      hr_id: input.hrId ?? null,
      login_id: input.loginId ?? null,
      message: truncate(message, MAX_TEXT_LENGTH) ?? "Unknown error",
      module_key: input.moduleKey ?? "other",
      module_label: input.moduleLabel ?? "Other",
      release: input.release ?? getCurrentReleaseTag(),
      role: input.role ?? null,
      // Redacted at CAPTURE. Ten route families carry a live credential in the path, and the row
      // is written the moment the page opens — while the token still works. See redact-route.ts.
      route: redactSecretsFromRoute(input.route),
      route_type: input.routeType ?? null,
      source: input.source,
      stack: truncate(combineStack(input.stack, input.componentStack, input.clientContext), MAX_TEXT_LENGTH),
      user_agent: truncate(input.userAgent, MAX_USER_AGENT_LENGTH),
    });

    if (error) {
      logError("Failed to persist app_error_events row", { labels: { event: "app_error_insert_failed" }, error });
    }
  } catch (loggingError) {
    logError("logAppError threw", { labels: { event: "log_app_error_threw" }, error: loggingError });
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
    .or(NON_DEVELOPMENT_ENVIRONMENT_FILTER)
    .order("created_at", { ascending: false })
    .range(offset, offset + pageSize - 1);

  if (filter.hrId) query = query.ilike("hr_id", `%${filter.hrId}%`);
  if (filter.moduleKey) {
    const moduleFilter = ilikeAnyFilter(["module_key", "module_label"], filter.moduleKey);
    if (moduleFilter) query = query.or(moduleFilter);
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

/**
 * Returns the set of error signatures (`module_key|route`) that have occurred on the
 * given release — i.e. the errors still happening on the currently-deployed build.
 * Used by the System Issues dashboard to derive Active vs Resolved status with no manual
 * action. Queries only two small columns (indexed on release-adjacent access) and dedups
 * in memory. Best-effort: on query failure returns an empty set (everything reads
 * Resolved) rather than throwing and breaking the dashboard.
 */
export async function getActiveErrorSignatures(currentRelease: string): Promise<Set<string>> {
  try {
    const { data, error } = await getSupabaseAdmin()
      .from("app_error_events")
      .select("module_key, route")
      .or(NON_DEVELOPMENT_ENVIRONMENT_FILTER)
      .eq("release", currentRelease);
    if (error) throw error;

    const signatures = new Set<string>();
    for (const row of (data ?? []) as Record<string, unknown>[]) {
      const moduleKey = (row.module_key as string) ?? "other";
      const route = (row.route as string | null) ?? null;
      signatures.add(`${moduleKey}|${route ?? ""}`);
    }
    return signatures;
  } catch (error) {
    logError("Failed to load active error signatures (all will read Resolved)", { labels: { event: "active_error_signatures_load_failed" }, error });
    return new Set();
  }
}

export type ErrorClusterAggregate = {
  moduleLabel: string;
  route: string | null;
  count: number;
  firstSeen: string;
  lastSeen: string;
  releases: string[];
  sampleMessage: string;
};

/**
 * Aggregates app_error_events over the last `days` into one row per signature
 * (module + route), for the AI cluster summary: occurrence count, first/last seen, the
 * distinct deploy releases it appeared in, and a representative message. Grouped in
 * application code (small, retention-bounded table). Best-effort — returns [] on failure.
 */
export async function getErrorClusterAggregates(days = 7): Promise<ErrorClusterAggregate[]> {
  try {
    const since = new Date(Date.now() - Math.max(1, days) * 24 * 60 * 60 * 1000).toISOString();
    const { data, error } = await getSupabaseAdmin()
      .from("app_error_events")
      .select("module_label, route, release, message, created_at")
      .or(NON_DEVELOPMENT_ENVIRONMENT_FILTER)
      .gte("created_at", since)
      .order("created_at", { ascending: false });
    if (error) throw error;

    const bySignature = new Map<string, ErrorClusterAggregate & { releaseSet: Set<string> }>();
    for (const row of (data ?? []) as Record<string, unknown>[]) {
      const moduleLabel = (row.module_label as string) ?? "Other";
      const route = (row.route as string | null) ?? null;
      const createdAt = row.created_at as string;
      const key = `${moduleLabel}|${route ?? ""}`;
      const existing = bySignature.get(key);
      if (existing) {
        existing.count += 1;
        if (createdAt < existing.firstSeen) existing.firstSeen = createdAt;
        if (createdAt > existing.lastSeen) existing.lastSeen = createdAt;
        const rel = row.release as string | null;
        if (rel) existing.releaseSet.add(rel);
      } else {
        const releaseSet = new Set<string>();
        const rel = row.release as string | null;
        if (rel) releaseSet.add(rel);
        bySignature.set(key, {
          count: 1,
          firstSeen: createdAt,
          lastSeen: createdAt,
          moduleLabel,
          releaseSet,
          releases: [],
          route,
          sampleMessage: (row.message as string) ?? "",
        });
      }
    }

    return Array.from(bySignature.values())
      .map(({ releaseSet, ...rest }) => ({ ...rest, releases: Array.from(releaseSet) }))
      .sort((a, b) => b.count - a.count);
  } catch (error) {
    logError("Failed to load error cluster aggregates", { labels: { event: "error_cluster_aggregates_load_failed" }, error });
    return [];
  }
}

export type WeeklyHealthTopError = {
  label: string;
  route: string | null;
  count: number;
  status: IssueStatus;
};

export type WeeklyHealthSummary = {
  windowDays: number;
  totalErrors: number;
  distinctSignatures: number;
  activeSignatures: number;
  resolvedSignatures: number;
  newSignatures: number;
  topErrors: WeeklyHealthTopError[];
};

/**
 * One roll-up of app_error_events for the weekly health digest, keyed on the SAME
 * signature (module_key|route) the dashboard's deploy-aware status uses — so its
 * active/resolved counts match what an admin sees when they open the tab. "New" signatures
 * are those with no occurrence before the window (one extra indexed baseline query on the
 * retention-bounded table). Best-effort: returns an all-zero summary on failure so the
 * digest can never throw inside the daily cron's Promise.all.
 */
export async function getWeeklyHealthSummary(days = 7): Promise<WeeklyHealthSummary> {
  const windowDays = Math.min(30, Math.max(1, days));
  const empty: WeeklyHealthSummary = {
    activeSignatures: 0,
    distinctSignatures: 0,
    newSignatures: 0,
    resolvedSignatures: 0,
    topErrors: [],
    totalErrors: 0,
    windowDays,
  };

  try {
    const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000).toISOString();
    const supabase = getSupabaseAdmin();
    const [windowRes, baselineRes, activeSignatures] = await Promise.all([
      supabase
        .from("app_error_events")
        .select("module_key, module_label, route")
        .or(NON_DEVELOPMENT_ENVIRONMENT_FILTER)
        .gte("created_at", since),
      // Signatures seen BEFORE the window — anything not here is genuinely new this week.
      supabase
        .from("app_error_events")
        .select("module_key, route")
        .or(NON_DEVELOPMENT_ENVIRONMENT_FILTER)
        .lt("created_at", since),
      getActiveErrorSignatures(getCurrentReleaseTag()),
    ]);
    if (windowRes.error) throw windowRes.error;

    const baselineKeys = new Set<string>();
    for (const row of (baselineRes.data ?? []) as Record<string, unknown>[]) {
      baselineKeys.add(signatureKey((row.module_key as string) ?? "other", (row.route as string | null) ?? null));
    }

    const bySig = new Map<string, { key: string; label: string; route: string | null; count: number }>();
    let totalErrors = 0;
    for (const row of (windowRes.data ?? []) as Record<string, unknown>[]) {
      totalErrors += 1;
      const moduleKey = (row.module_key as string) ?? "other";
      const route = (row.route as string | null) ?? null;
      const key = signatureKey(moduleKey, route);
      const existing = bySig.get(key);
      if (existing) existing.count += 1;
      else bySig.set(key, { count: 1, key, label: (row.module_label as string) ?? "Other", route });
    }

    let active = 0;
    let fresh = 0;
    for (const agg of bySig.values()) {
      if (deriveAppErrorStatus(agg.key, activeSignatures) === "active") active += 1;
      if (!baselineKeys.has(agg.key)) fresh += 1;
    }

    const topErrors: WeeklyHealthTopError[] = Array.from(bySig.values())
      .sort((a, b) => b.count - a.count)
      .slice(0, 5)
      .map((agg) => ({
        count: agg.count,
        label: agg.label,
        route: agg.route,
        status: deriveAppErrorStatus(agg.key, activeSignatures),
      }));

    return {
      activeSignatures: active,
      distinctSignatures: bySig.size,
      newSignatures: fresh,
      resolvedSignatures: bySig.size - active,
      topErrors,
      totalErrors,
      windowDays,
    };
  } catch (error) {
    logError("Failed to build weekly health summary", { labels: { event: "weekly_health_summary_failed" }, error });
    return empty;
  }
}

export type ReproTrailEntry = {
  createdAt: string;
  moduleLabel: string;
  path: string;
  durationMs: number;
};

/**
 * The last `limit` navigation events the given user made BEFORE an error — the "what was
 * the user doing right before it crashed" repro trail. Reads pre-stored module_label/path
 * from activity_events (page-view tracking) and hits the (hr_id, created_at DESC) index.
 * Best-effort: returns [] if the user has no hr_id, or on failure. Note: activity_events
 * is pruned at 90 days, so an older error yields an empty trail.
 *
 * Matches EVERY accepted spelling of the id, not just the canonical one. The write path
 * canonicalizes today, but the table holds 11,934 rows spelled `B-10` alongside 51,024
 * lower-cased ones (measured on production 2026-09-26), so an `.eq(canonical)` returned an
 * empty repro trail for the owner's own errors while reporting nothing wrong.
 */
export async function getReproTrail(hrId: string | null | undefined, beforeIso: string, limit = 5): Promise<ReproTrailEntry[]> {
  const hrKey = canonicalHrIdKey(hrId);
  if (!hrKey) return [];
  try {
    const { data, error } = await getSupabaseAdmin()
      .from("activity_events")
      .select("created_at, module_label, path, duration_ms")
      .in("hr_id", hrIdLookupKeys(hrId))
      .lt("created_at", beforeIso)
      .order("created_at", { ascending: false })
      .limit(Math.min(20, Math.max(1, limit)));
    if (error) throw error;

    return (data ?? []).map((row: Record<string, unknown>) => ({
      createdAt: row.created_at as string,
      durationMs: Number(row.duration_ms ?? 0),
      moduleLabel: (row.module_label as string) ?? "Other",
      path: (row.path as string) ?? "",
    }));
  } catch (error) {
    logError("Failed to load repro trail", { labels: { event: "repro_trail_load_failed", hrId: hrKey }, error });
    return [];
  }
}

// ── Login security lens (Tab 2) ─────────────────────────────────────────────────
// Thresholds aligned to the real lockout policy in src/lib/auth/login-throttle-policy.ts:
//   account ≥10 failures / 15min → 30min lock; IP ≥15 failures / 15min → blocked, except that an IP
//   different accounts signed in from in the last 24h (a shared office) gets 10 per account, capped at 150.
// Over a 7-day window we surface cumulative "notable" activity, not the per-15min gate.
const SECURITY_WINDOW_FETCH_CAP = 20_000;
const BRUTE_FORCE_IP_MIN_FAILS = 10;
const HAMMERED_ACCOUNT_MIN_FAILS = 5;
const CREDENTIAL_STUFFING_MIN_ACCOUNTS = 3;
const DISTRIBUTED_ATTACK_MIN_IPS = 3;

export type BruteForceIp = { ip: string; failCount: number; distinctAccounts: number; lastSeen: string; credentialStuffing: boolean; blocked: boolean };
export type HammeredAccount = { hrId: string; name: string | null; failCount: number; distinctIps: number; lastSeen: string; distributed: boolean };
export type LockedAccount = { hrId: string; name: string | null; failedAttempts: number; lockedUntil: string; lastFailedAt: string | null };
export type NewLocationLogin = { hrId: string; name: string | null; ip: string; at: string };

export type LoginSecuritySignals = {
  windowDays: number;
  bruteForceIps: BruteForceIp[];
  hammeredAccounts: HammeredAccount[];
  lockedAccounts: LockedAccount[];
  newLocationLogins: NewLocationLogin[];
  blockedIps: BlockedIp[];
  truncated: boolean;
};

export type AccountIdentity = { name: string | null; role: string | null };

/** Row shape read from app_auth_users to build the account directory. */
export type AccountDirectoryRow = { login_id?: unknown; hr_id?: unknown; name?: unknown; role?: unknown };

/**
 * Builds the canonical-id → identity map, indexing each account by BOTH its login_id and its
 * hr_id. Attempts are keyed by login_id (failed logins) OR hr_id (app errors), and for some
 * accounts those differ — e.g. the Super Admin logs in as "admin-HR" but has hr_id "PHX-1".
 * Keying by only one (as this did before) silently dropped the other's rows from the per-user
 * view AND made the real-account filter treat that account's errors as unknown. Pure +
 * injectable so the dual-key behavior is unit-testable without a live DB.
 */
export function buildAccountDirectory(rows: AccountDirectoryRow[]): Map<string, AccountIdentity> {
  const map = new Map<string, AccountIdentity>();
  for (const row of rows) {
    const identity: AccountIdentity = {
      name: (row.name as string | null) ?? null,
      role: (row.role as string | null) ?? null,
    };
    const loginKey = canonicalHrIdKey(row.login_id as string);
    const hrKey = canonicalHrIdKey(row.hr_id as string);
    if (loginKey) map.set(loginKey, identity);
    if (hrKey) map.set(hrKey, identity);
  }
  return map;
}

/**
 * Small directory mapping canonical login_id/hr_id → display name + role (app_auth_users is
 * ~150 rows, so fetching all is cheap). Used to show "Ahmed Hassan (Medical Rep)" instead of
 * a bare hr_id, and to resolve names in the security lens. Best-effort — empty on failure.
 */
export async function getAccountDirectory(): Promise<Map<string, AccountIdentity>> {
  try {
    const { data } = await getSupabaseAdmin().from("app_auth_users").select("login_id, hr_id, name, role");
    return buildAccountDirectory((data ?? []) as AccountDirectoryRow[]);
  } catch (error) {
    logError("Failed to load account directory", { labels: { event: "account_directory_load_failed" }, error });
    return new Map();
  }
}

/**
 * Turns auth_login_attempts (which carries an ip + success per attempt) into a security
 * lens: brute-force IPs, hammered accounts, currently-locked accounts, and new-location
 * logins. Both successes and failures are recorded, so new-location detection compares a
 * window's successful-login IPs against each account's earlier known IPs. Aggregated in
 * app code (mirrors getUserAttemptSummary); best-effort — returns empty signals on error.
 */
export async function getLoginSecuritySignals(days = 7): Promise<LoginSecuritySignals> {
  const supabase = getSupabaseAdmin();
  const windowDays = Math.min(30, Math.max(1, days));
  const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000).toISOString();
  const nowIso = new Date().toISOString();
  const empty: LoginSecuritySignals = { blockedIps: [], bruteForceIps: [], hammeredAccounts: [], lockedAccounts: [], newLocationLogins: [], truncated: false, windowDays };

  try {
    const [directory, windowRes, baselineRes, lockedRes, blockedIps] = await Promise.all([
      getAccountDirectory(),
      supabase
        .from("auth_login_attempts")
        .select("login_id, ip, success, attempted_at")
        .gte("attempted_at", since)
        .order("attempted_at", { ascending: false })
        .limit(SECURITY_WINDOW_FETCH_CAP),
      // Known-location baseline: distinct (account, ip) from successful logins BEFORE the window.
      supabase
        .from("auth_login_attempts")
        .select("login_id, ip")
        .eq("success", true)
        .lt("attempted_at", since)
        .limit(SECURITY_WINDOW_FETCH_CAP),
      supabase
        .from("app_auth_users")
        .select("login_id, hr_id, name, failed_login_attempts, locked_until, last_failed_login_at")
        .gt("locked_until", nowIso),
      getBlockedIps(),
    ]);

    const windowRows = (windowRes.data ?? []) as Record<string, unknown>[];
    const truncated = windowRows.length >= SECURITY_WINDOW_FETCH_CAP;
    const blockedIpSet = new Set(blockedIps.map((b) => b.ip));

    // Baseline known (account|ip) pairs.
    const knownPairs = new Set<string>();
    for (const row of (baselineRes.data ?? []) as Record<string, unknown>[]) {
      const acct = canonicalHrIdKey(row.login_id as string);
      const ip = (row.ip as string | null) ?? "";
      if (acct && ip) knownPairs.add(`${acct}|${ip}`);
    }

    const ipAgg = new Map<string, { failCount: number; accounts: Set<string>; lastSeen: string }>();
    const acctAgg = new Map<string, { failCount: number; ips: Set<string>; lastSeen: string }>();
    const newLocations: NewLocationLogin[] = [];
    const seenWindowPairs = new Set<string>();

    for (const row of windowRows) {
      const acct = canonicalHrIdKey(row.login_id as string);
      const ip = (row.ip as string | null) ?? "";
      const at = row.attempted_at as string;
      const success = Boolean(row.success);
      if (!acct) continue;

      if (!success) {
        if (ip) {
          const e = ipAgg.get(ip) ?? { accounts: new Set<string>(), failCount: 0, lastSeen: at };
          e.failCount += 1;
          e.accounts.add(acct);
          if (at > e.lastSeen) e.lastSeen = at;
          ipAgg.set(ip, e);
        }
        const a = acctAgg.get(acct) ?? { failCount: 0, ips: new Set<string>(), lastSeen: at };
        a.failCount += 1;
        if (ip) a.ips.add(ip);
        if (at > a.lastSeen) a.lastSeen = at;
        acctAgg.set(acct, a);
      } else if (ip) {
        const pairKey = `${acct}|${ip}`;
        // First success on a (account, ip) not in the pre-window baseline = a new location.
        if (!knownPairs.has(pairKey) && !seenWindowPairs.has(pairKey)) {
          seenWindowPairs.add(pairKey);
          newLocations.push({ at, hrId: canonicalHrIdForDisplay(acct) ?? acct, ip, name: directory.get(acct)?.name ?? null });
        }
      }
    }

    const bruteForceIps: BruteForceIp[] = Array.from(ipAgg.entries())
      .filter(([, e]) => e.failCount >= BRUTE_FORCE_IP_MIN_FAILS || e.accounts.size >= CREDENTIAL_STUFFING_MIN_ACCOUNTS)
      .map(([ip, e]) => ({ blocked: blockedIpSet.has(ip), credentialStuffing: e.accounts.size >= CREDENTIAL_STUFFING_MIN_ACCOUNTS, distinctAccounts: e.accounts.size, failCount: e.failCount, ip, lastSeen: e.lastSeen }))
      .sort((a, b) => b.failCount - a.failCount)
      .slice(0, 25);

    const hammeredAccounts: HammeredAccount[] = Array.from(acctAgg.entries())
      .filter(([, e]) => e.failCount >= HAMMERED_ACCOUNT_MIN_FAILS)
      .map(([acct, e]) => ({ distinctIps: e.ips.size, distributed: e.ips.size >= DISTRIBUTED_ATTACK_MIN_IPS, failCount: e.failCount, hrId: canonicalHrIdForDisplay(acct) ?? acct, lastSeen: e.lastSeen, name: directory.get(acct)?.name ?? null }))
      .sort((a, b) => b.failCount - a.failCount)
      .slice(0, 25);

    const lockedAccounts: LockedAccount[] = ((lockedRes.data ?? []) as Record<string, unknown>[]).map((row) => {
      const acct = canonicalHrIdKey(row.login_id as string) ?? canonicalHrIdKey(row.hr_id as string) ?? "";
      return {
        failedAttempts: Number(row.failed_login_attempts ?? 0),
        hrId: canonicalHrIdForDisplay(acct) ?? String(row.login_id ?? ""),
        lastFailedAt: (row.last_failed_login_at as string | null) ?? null,
        lockedUntil: row.locked_until as string,
        name: directory.get(acct)?.name ?? (row.name as string | null) ?? null,
      };
    });

    return {
      blockedIps,
      bruteForceIps,
      hammeredAccounts,
      lockedAccounts,
      newLocationLogins: newLocations.slice(0, 25),
      truncated,
      windowDays,
    };
  } catch (error) {
    logError("Failed to load login security signals", { labels: { event: "login_security_signals_load_failed" }, error });
    return empty;
  }
}

// ── Deploy timeline + regression detection ──────────────────────────────────────
export type TimelineBucket = { day: string; count: number };
export type DeployMarker = { release: string; firstSeen: string };
export type Regression = { moduleLabel: string; route: string | null; currentRelease: string; earliestRelease: string; gapReleases: number; count: number };

export type DeployTimeline = {
  windowDays: number;
  buckets: TimelineBucket[];
  markers: DeployMarker[];
  regressions: Regression[];
};

// Revision names sort by their numeric segment (phoenix-hr-00066-toh → 66). Falls back to
// string compare for non-standard release tags (commit SHAs / "unknown").
function releaseOrdinal(release: string): number {
  const m = release.match(/-(\d{3,})-/) ?? release.match(/(\d{3,})/);
  return m ? Number(m[1]) : NaN;
}

/**
 * Errors-per-day over `days`, the deploy revisions that produced errors (as timeline
 * markers), and regressions — signatures that occur on the current release AND on an
 * earlier release with at least one intervening error-producing release where they did
 * NOT appear (i.e. they went quiet across a deploy, then came back). Aggregated in app
 * code; best-effort — returns empty timeline on failure.
 */
export async function getDeployTimeline(currentRelease: string, days = 14): Promise<DeployTimeline> {
  const windowDays = Math.min(60, Math.max(1, days));
  const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000).toISOString();
  const empty: DeployTimeline = { buckets: [], markers: [], regressions: [], windowDays };

  try {
    const { data, error } = await getSupabaseAdmin()
      .from("app_error_events")
      .select("module_key, module_label, route, release, created_at")
      .or(NON_DEVELOPMENT_ENVIRONMENT_FILTER)
      .gte("created_at", since)
      .order("created_at", { ascending: true });
    if (error) throw error;
    const rows = (data ?? []) as Record<string, unknown>[];

    // Per-day counts.
    const dayCounts = new Map<string, number>();
    // release → earliest created_at (for markers) and the full set of error-producing releases.
    const releaseFirstSeen = new Map<string, string>();
    // signature → set of releases it appeared on.
    const sigReleases = new Map<string, Set<string>>();
    const sigMeta = new Map<string, { moduleLabel: string; route: string | null; count: number }>();

    for (const row of rows) {
      const createdAt = row.created_at as string;
      const day = createdAt.slice(0, 10);
      dayCounts.set(day, (dayCounts.get(day) ?? 0) + 1);

      const release = (row.release as string | null) ?? null;
      if (release) {
        const prev = releaseFirstSeen.get(release);
        if (!prev || createdAt < prev) releaseFirstSeen.set(release, createdAt);
      }

      const moduleKey = (row.module_key as string) ?? "other";
      const route = (row.route as string | null) ?? null;
      const sig = `${moduleKey}|${route ?? ""}`;
      if (release) {
        const set = sigReleases.get(sig) ?? new Set<string>();
        set.add(release);
        sigReleases.set(sig, set);
      }
      const meta = sigMeta.get(sig) ?? { count: 0, moduleLabel: (row.module_label as string) ?? "Other", route };
      meta.count += 1;
      sigMeta.set(sig, meta);
    }

    const buckets: TimelineBucket[] = Array.from(dayCounts.entries())
      .map(([day, count]) => ({ count, day }))
      .sort((a, b) => (a.day < b.day ? -1 : 1));

    const markers: DeployMarker[] = Array.from(releaseFirstSeen.entries())
      .map(([release, firstSeen]) => ({ firstSeen, release }))
      .sort((a, b) => (a.firstSeen < b.firstSeen ? -1 : 1));

    // Globally-ordered list of error-producing releases (by revision ordinal, else first-seen).
    const orderedReleases = markers
      .map((m) => m.release)
      .filter((r) => Number.isFinite(releaseOrdinal(r)))
      .sort((a, b) => releaseOrdinal(a) - releaseOrdinal(b));
    const currentOrdinal = releaseOrdinal(currentRelease);
    const releaseIndex = new Map(orderedReleases.map((r, i) => [r, i]));

    const regressions: Regression[] = [];
    if (Number.isFinite(currentOrdinal)) {
      for (const [sig, releases] of sigReleases.entries()) {
        if (!releases.has(currentRelease)) continue; // must be active on the current release
        const sigOrdinals = Array.from(releases)
          .filter((r) => Number.isFinite(releaseOrdinal(r)))
          .map((r) => releaseIndex.get(r))
          .filter((i): i is number => i !== undefined)
          .sort((a, b) => a - b);
        if (sigOrdinals.length < 2) continue;
        const earliestIdx = sigOrdinals[0];
        const latestIdx = sigOrdinals[sigOrdinals.length - 1];
        // Gap = intervening error-producing releases where this signature did NOT appear.
        const gap = latestIdx - earliestIdx - (sigOrdinals.length - 1);
        if (gap >= 1) {
          const meta = sigMeta.get(sig);
          regressions.push({
            count: meta?.count ?? 0,
            currentRelease,
            earliestRelease: orderedReleases[earliestIdx],
            gapReleases: gap,
            moduleLabel: meta?.moduleLabel ?? "Other",
            route: meta?.route ?? null,
          });
        }
      }
    }
    regressions.sort((a, b) => b.count - a.count);

    return { buckets, markers, regressions, windowDays };
  } catch (error) {
    logError("Failed to load deploy timeline", { labels: { event: "deploy_timeline_load_failed", currentRelease }, error });
    return empty;
  }
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
  /** ISO timestamp of the lower bound actually applied to both sources (default window or the caller's dateFrom). */
  windowFrom: string;
};

/** Aggregated "everything that didn't resolve to a real app_auth_users account" bucket. */
export type UnknownAttemptsSummary = {
  attemptCount: number;
  distinctCount: number;
};

/**
 * Default lookback for the System Issues "Per-User Attempts" tab. All-time history (retention
 * keeps ~90 days) makes stale/one-off failures dominate the view, so we default to the last
 * 30 days; an explicit dateFrom from the UI still overrides it.
 */
export const DEFAULT_ATTEMPT_WINDOW_DAYS = 30;

const ATTEMPT_FETCH_PAGE_SIZE = 1000;
const ATTEMPT_FETCH_ROW_CAP = 20_000;

/**
 * Resolves the effective lower-bound timestamp for the attempts query: the caller's explicit
 * dateFrom when provided, otherwise DEFAULT_ATTEMPT_WINDOW_DAYS ago. Pure + injectable `now`
 * so the windowing is unit-testable without a live DB.
 */
export function resolveAttemptWindowFrom(dateFrom: string | null | undefined, now: number = Date.now()): string {
  if (dateFrom) return dateFrom;
  return new Date(now - DEFAULT_ATTEMPT_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();
}

/**
 * Partitions aggregated attempt rows into rows tied to a real account (predicate true) and an
 * aggregate of everything else (test/synthetic/probe/typo login ids). Distinct unknown users
 * are counted by canonical HR_ID key so the same fake login across many modules counts once.
 * Pure — the caller injects `isRealAccount` so this is testable without a live directory/DB.
 */
export function partitionUserAttempts<T extends { hrId: string; attemptCount: number }>(
  rows: T[],
  isRealAccount: (hrId: string) => boolean,
): { realRows: T[]; unknownAttempts: UnknownAttemptsSummary } {
  const realRows: T[] = [];
  const unknownKeys = new Set<string>();
  let attemptCount = 0;
  for (const row of rows) {
    if (isRealAccount(row.hrId)) {
      realRows.push(row);
    } else {
      attemptCount += row.attemptCount;
      unknownKeys.add(canonicalHrIdKey(row.hrId) ?? row.hrId);
    }
  }
  return { realRows, unknownAttempts: { attemptCount, distinctCount: unknownKeys.size } };
}

/**
 * Aggregates app_error_events + failed auth_login_attempts into per-HR_ID, per-module/route
 * attempt counts for the System Issues "Per-user" tab. Grouping runs in application code
 * (not SQL) so no migration is needed — retention already bounds app_error_events to 90 days,
 * keeping row counts fetchable. Both sources page in ATTEMPT_FETCH_PAGE_SIZE batches up to
 * ATTEMPT_FETCH_ROW_CAP; hitting the cap sets `truncated: true` rather than silently dropping rows.
 */
export async function getUserAttemptSummary(filter: UserAttemptFilter = {}): Promise<UserAttemptSummary> {
  const supabase = getSupabaseAdmin();
  // Default to a recent window so the tab reflects live activity, not ~90 days of retained
  // history; an explicit filter.dateFrom still overrides. Applied to BOTH sources below.
  const windowFrom = resolveAttemptWindowFrom(filter.dateFrom);
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
        .or(NON_DEVELOPMENT_ENVIRONMENT_FILTER)
        .not("hr_id", "is", null)
        .order("created_at", { ascending: false })
        .range(offset, offset + ATTEMPT_FETCH_PAGE_SIZE - 1);

      if (filter.hrId) query = query.ilike("hr_id", `%${filter.hrId}%`);
      query = query.gte("created_at", windowFrom);
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
      query = query.gte("attempted_at", windowFrom);
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
  return { rows: rowsOut, truncated, windowFrom };
}
