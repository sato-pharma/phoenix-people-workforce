import { getSupabaseAdmin } from "@/lib/supabase/server";
import { canonicalHrIdForDisplay, canonicalHrIdKey, hrIdLookupKeys } from "@/lib/hr-id";
import { getBlockedIps, type BlockedIp } from "@/lib/auth/ip-blocklist";
import { getCurrentReleaseTag, shouldPersistErrorEvents } from "@/lib/error-monitor/derived-status";
import { redactSecretsFromRoute } from "@/lib/error-monitor/redact-route";
import { ERROR_SCREENSHOT_BUCKET } from "@/lib/error-monitor/screenshot-intake";
import { classifySupabaseUnreachable } from "@/lib/error-monitor/supabase-unreachable";
import { logError } from "@/lib/observability/log";
import { fetchAllRows } from "@/lib/supabase/paginated";

export type ErrorEventSource = "server" | "client";

const MAX_TEXT_LENGTH = 4000;
const MAX_USER_AGENT_LENGTH = 500;
const DEFAULT_ERROR_EVENT_RETENTION_DAYS = 90;
/** Crash pictures removed per run, at most — exactly the 1,000 rows one PostgREST read returns. */
const ERROR_SCREENSHOT_PRUNE_BATCH = 1_000;
/** Paths per Storage call, and ids per row delete: both travel in the request. */
const ERROR_SCREENSHOT_REMOVE_CHUNK = 100;

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
    const supabase = getSupabaseAdmin();

    // PICTURES FIRST (review of #6358, 23 Oct 2026). A crash picture is an unmasked screenshot of an
    // employee's screen — a payslip, a bank form — and until this its row was deleted here and its
    // file never was: from day 91 it sat in the bucket for ever, with nothing pointing at it and no
    // screen able to show it. Each file goes through the Storage API (a delete on storage.objects is
    // refused by storage.protect_delete), and a row that has a picture is deleted only once its
    // picture is gone; one that will not go keeps its row, and is tried again the next day.
    const { data: shots, error: shotsError } = await supabase
      .from("app_error_events")
      .select("id, screenshot_path")
      .lt("created_at", cutoff)
      .not("screenshot_path", "is", null)
      .order("created_at", { ascending: true })
      .limit(ERROR_SCREENSHOT_PRUNE_BATCH);
    if (shotsError) return { deleted: null, error: shotsError.message };

    const removedIds: string[] = [];
    const withPictures = (shots ?? []) as Array<{ id: string; screenshot_path: string }>;
    for (let start = 0; start < withPictures.length; start += ERROR_SCREENSHOT_REMOVE_CHUNK) {
      const chunk = withPictures.slice(start, start + ERROR_SCREENSHOT_REMOVE_CHUNK);
      const { error: removeError } = await supabase.storage
        .from(ERROR_SCREENSHOT_BUCKET)
        .remove(chunk.map((row) => row.screenshot_path));
      if (removeError) break;
      removedIds.push(...chunk.map((row) => row.id));
    }

    // Rows with no picture, then the rows whose picture is now gone. A row whose picture is still
    // there (over the batch, or a removal that failed) is left for the next run.
    const { error, count } = await supabase
      .from("app_error_events")
      .delete({ count: "exact" })
      .lt("created_at", cutoff)
      .is("screenshot_path", null);
    if (error) return { deleted: null, error: error.message };

    let deleted = count ?? 0;
    for (let start = 0; start < removedIds.length; start += ERROR_SCREENSHOT_REMOVE_CHUNK) {
      const { error: idsError, count: idsCount } = await supabase
        .from("app_error_events")
        .delete({ count: "exact" })
        .in("id", removedIds.slice(start, start + ERROR_SCREENSHOT_REMOVE_CHUNK));
      if (idsError) return { deleted, error: idsError.message };
      deleted += idsCount ?? 0;
    }
    return { deleted };
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
 * filtering them out on READ is what makes any reader of this table (today the System Audit
 * detectors behind /admin/system-audit) truthful. The write-side gate only stops new ones accumulating.
 *
 * NOT safe as a plain `neq` — that was the bug (2026-08-13). The paragraph here used to claim the
 * column has no NULLs because logAppError "always sets" it. It does not: the insert below took
 * `input.environment ?? null`, so the stamp was only ever as good as each caller. When
 * /api/admin/outstation/expenses started logging its own 500s directly (2026-08-12) it passed no
 * environment, and `NULL != 'development'` is NULL rather than true, so PostgREST's `neq` dropped
 * those rows from EVERY read. Sixteen production errors — twelve unreadable ones and four real
 * `permission denied for table expense_claims` — existed in the table and appeared on neither of
 * the two error dashboards of the day (both retired 23 Oct 2026 for /admin/system-audit). A
 * dashboard that silently hides errors is worse than no dashboard.
 *
 * Fixed at both ends: the writer below now stamps `environment`/`release` itself so a caller
 * cannot omit them, and reads use the NULL-safe filter so the rows already written stay visible.
 * Staging is unaffected — it builds with NODE_ENV=production and writes to its own project.
 */
const DEVELOPMENT_ENVIRONMENT = "development";

/**
 * NULL-safe form of "not development", for `.or(...)`. A bare `.neq` drops NULL-stamped rows.
 * Exported so every reader of app_error_events applies the same rule.
 */
export const NON_DEVELOPMENT_ENVIRONMENT_FILTER = `environment.is.null,environment.neq.${DEVELOPMENT_ENVIRONMENT}`;

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
/**
 * Writes one row and returns its id, so a caller that has something to attach to it — the client
 * reporter's screenshot, through the ticket the route hands back — can name the row it belongs to.
 * Null whenever nothing was written: local dev, a refused insert, an outage. Every existing caller
 * ignores the value, and none may depend on it being present.
 */
export async function logAppError(input: LogAppErrorInput): Promise<string | null> {
  // Local dev: keep the signal on the developer's own console and leave the shared
  // (production) table alone. Returning here rather than at the API route covers every
  // caller — the client reporter and instrumentation.ts's onRequestError both funnel
  // through /api/errors/client into this one function.
  if (!shouldPersistErrorEvents()) {
    console.error(
      `[app-error:not-persisted] ${redactSecretsFromRoute(input.route) ?? "(no route)"} — ${input.message}`,
      input.stack ?? "",
    );
    return null;
  }

  // Cloudflare's whole "521: Web server is down" page is what a Supabase outage used to leave in this column —
  // thousands of characters of markup per row. It is stored as the one readable line the Sentry issue carries.
  const message = classifySupabaseUnreachable(input.message)?.line ?? input.message;

  try {
    const supabase = getSupabaseAdmin();
    const { data, error } = await supabase.from("app_error_events").insert({
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
    })
      // The id only — this row is written on the error path, and a `select *` here would read the
      // whole stack and message straight back out for nothing.
      .select("id")
      .single();

    if (error) {
      logError("Failed to persist app_error_events row", { labels: { event: "app_error_insert_failed" }, error });
      return null;
    }
    return typeof data?.id === "string" ? data.id : null;
  } catch (loggingError) {
    logError("logAppError threw", { labels: { event: "log_app_error_threw" }, error: loggingError });
    return null;
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

// ── Login security lens ─────────────────────────────────────────────────────────
// Thresholds aligned to the real lockout policy in src/lib/auth/login-throttle-policy.ts:
//   account ≥10 failures / 15min → 30min lock; IP ≥15 failures / 15min → blocked, except that an IP
//   different accounts signed in from in the last 24h (a shared office) gets 10 per account, capped at 150.
// Over a 7-day window we surface cumulative "notable" activity, not the per-15min gate.
const BRUTE_FORCE_IP_MIN_FAILS = 10;
const HAMMERED_ACCOUNT_MIN_FAILS = 5;
const CREDENTIAL_STUFFING_MIN_ACCOUNTS = 3;
const DISTRIBUTED_ATTACK_MIN_IPS = 3;
/**
 * How far back "a place this account has signed in from before" reaches. It used to be all of
 * history in one unpaged select — which PostgREST cut at 1,000 arbitrary rows, so most known
 * locations were never read and an ordinary sign-in from the office read as a new location. A
 * bounded, fully paged window is the honest version: "new" means "not seen in the 90 days before".
 */
export const KNOWN_LOCATION_BASELINE_DAYS = 90;

export type BruteForceIp = { ip: string; failCount: number; distinctAccounts: number; lastSeen: string; credentialStuffing: boolean; blocked: boolean };
export type HammeredAccount = { hrId: string; name: string | null; failCount: number; distinctIps: number; lastSeen: string; distributed: boolean };
export type LockedAccount = { hrId: string; name: string | null; failedAttempts: number; lockedUntil: string; lastFailedAt: string | null };
export type NewLocationLogin = { hrId: string; name: string | null; ip: string; at: string };

export type LoginSecuritySignals = {
  windowDays: number;
  baselineDays: number;
  bruteForceIps: BruteForceIp[];
  hammeredAccounts: HammeredAccount[];
  lockedAccounts: LockedAccount[];
  newLocationLogins: NewLocationLogin[];
  blockedIps: BlockedIp[];
  /**
   * The sources that could NOT be read, in plain words. A list fed by a source named here is empty
   * because it was never read — the screen must say "Unavailable" for it, never "none".
   */
  unavailable: string[];
};

export type AccountIdentity = { name: string | null; role: string | null };

/** Row shape read from app_auth_users to build the account directory. */
export type AccountDirectoryRow = { login_id?: unknown; hr_id?: unknown; name?: unknown; role?: unknown };

/**
 * Builds the canonical-id → identity map, indexing each account by BOTH its login_id and its
 * hr_id. Attempts are keyed by login_id (failed logins) OR hr_id (app errors), and for some
 * accounts those differ — e.g. the Super Admin logs in as "admin-HR" but has hr_id "PHX-1".
 * Keying by only one (as this did before) silently dropped the other's rows. Pure + injectable so
 * the dual-key behavior is unit-testable without a live DB.
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
 * Directory mapping canonical login_id/hr_id → display name + role, so the security screens show
 * "Ahmed Hassan (Medical Rep)" instead of a bare id. Paged (the table passed 200 rows in October
 * 2026 and nothing stops it passing 1,000), and it THROWS on a failed read: it used to ignore the
 * error and return an empty map, which made every account in the lens read as nameless.
 */
export async function getAccountDirectory(): Promise<Map<string, AccountIdentity>> {
  const supabase = getSupabaseAdmin();
  const rows = await fetchAllRows<AccountDirectoryRow>(
    () => supabase.from("app_auth_users").select("login_id, hr_id, name, role"),
    "login_id",
  );
  return buildAccountDirectory(rows);
}

/**
 * Turns auth_login_attempts (which carries an ip + success per attempt) into a security lens:
 * brute-force IPs, hammered accounts, currently-locked accounts, and new-location logins.
 *
 * Every source is PAGED — the 7-day window alone held 949 rows on 23 Oct 2026, one week short of
 * the 1,000-row cut the old single select hit without saying so. And a source that fails is
 * NAMED in `unavailable` instead of quietly becoming an empty list: an empty brute-force table
 * must mean "nobody is hammering the login", never "the read failed".
 */
export async function getLoginSecuritySignals(days = 7): Promise<LoginSecuritySignals> {
  const supabase = getSupabaseAdmin();
  const windowDays = Math.min(30, Math.max(1, days));
  const sinceMs = Date.now() - windowDays * 24 * 60 * 60 * 1000;
  const since = new Date(sinceMs).toISOString();
  const baselineSince = new Date(sinceMs - KNOWN_LOCATION_BASELINE_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const nowIso = new Date().toISOString();
  const unavailable: string[] = [];

  async function settle<T>(label: string, read: () => Promise<T>): Promise<T | null> {
    try {
      return await read();
    } catch (error) {
      logError("Login security source could not be read", { labels: { event: "login_security_source_failed", source: label }, error });
      unavailable.push(label);
      return null;
    }
  }

  const [directory, windowRows, baselineRows, lockedRows, blockedIps] = await Promise.all([
    settle("Account names", () => getAccountDirectory()),
    settle(`Sign-in attempts (last ${windowDays} days)`, () =>
      fetchAllRows<Record<string, unknown>>(
        () => supabase.from("auth_login_attempts").select("id, login_id, ip, success, attempted_at").gte("attempted_at", since),
        "id",
      )),
    // Known-location baseline: (account, ip) pairs with a successful sign-in before the window.
    settle("Known sign-in locations", () =>
      fetchAllRows<Record<string, unknown>>(
        () =>
          supabase
            .from("auth_login_attempts")
            .select("id, login_id, ip")
            .eq("success", true)
            .gte("attempted_at", baselineSince)
            .lt("attempted_at", since),
        "id",
      )),
    settle("Locked accounts", () =>
      fetchAllRows<Record<string, unknown>>(
        () =>
          supabase
            .from("app_auth_users")
            .select("login_id, hr_id, name, failed_login_attempts, locked_until, last_failed_login_at")
            .gt("locked_until", nowIso),
        "login_id",
      )),
    settle("Blocked IP list", () => getBlockedIps()),
  ]);

  const nameOf = (acct: string) => directory?.get(acct)?.name ?? null;
  const blockedIpSet = new Set((blockedIps ?? []).map((b) => b.ip));

  // Baseline known (account|ip) pairs.
  const knownPairs = new Set<string>();
  for (const row of baselineRows ?? []) {
    const acct = canonicalHrIdKey(row.login_id as string);
    const ip = (row.ip as string | null) ?? "";
    if (acct && ip) knownPairs.add(`${acct}|${ip}`);
  }

  const ipAgg = new Map<string, { failCount: number; accounts: Set<string>; lastSeen: string }>();
  const acctAgg = new Map<string, { failCount: number; ips: Set<string>; lastSeen: string }>();
  const newLocations: NewLocationLogin[] = [];
  const seenWindowPairs = new Set<string>();

  // Oldest first, so the FIRST success on a new (account, ip) pair is the one reported.
  const orderedWindowRows = [...(windowRows ?? [])].sort((a, b) =>
    String(a.attempted_at ?? "").localeCompare(String(b.attempted_at ?? "")),
  );
  for (const row of orderedWindowRows) {
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
    } else if (ip && baselineRows) {
      // Without the baseline every success would read as a new location — so none is reported,
      // and "Known sign-in locations" is already named in `unavailable`.
      const pairKey = `${acct}|${ip}`;
      if (!knownPairs.has(pairKey) && !seenWindowPairs.has(pairKey)) {
        seenWindowPairs.add(pairKey);
        newLocations.push({ at, hrId: canonicalHrIdForDisplay(acct) ?? acct, ip, name: nameOf(acct) });
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
    .map(([acct, e]) => ({ distinctIps: e.ips.size, distributed: e.ips.size >= DISTRIBUTED_ATTACK_MIN_IPS, failCount: e.failCount, hrId: canonicalHrIdForDisplay(acct) ?? acct, lastSeen: e.lastSeen, name: nameOf(acct) }))
    .sort((a, b) => b.failCount - a.failCount)
    .slice(0, 25);

  const lockedAccounts: LockedAccount[] = (lockedRows ?? []).map((row) => {
    const acct = canonicalHrIdKey(row.login_id as string) ?? canonicalHrIdKey(row.hr_id as string) ?? "";
    return {
      failedAttempts: Number(row.failed_login_attempts ?? 0),
      hrId: canonicalHrIdForDisplay(acct) ?? String(row.login_id ?? ""),
      lastFailedAt: (row.last_failed_login_at as string | null) ?? null,
      lockedUntil: row.locked_until as string,
      name: nameOf(acct) ?? (row.name as string | null) ?? null,
    };
  });

  return {
    baselineDays: KNOWN_LOCATION_BASELINE_DAYS,
    blockedIps: blockedIps ?? [],
    bruteForceIps,
    hammeredAccounts,
    lockedAccounts,
    newLocationLogins: newLocations.sort((a, b) => (a.at < b.at ? 1 : -1)).slice(0, 25),
    unavailable,
    windowDays,
  };
}
