// Login security for the System Audit page (/admin/system-audit, Super Admin only).
//
// It carries what the retired Monitoring and System Issues pages showed about sign-in, without
// their three silent failures: a count that stopped at 1,000 rows (failed sign-ins, failed IPs),
// a failed read that rendered as 0 (every tile, and "100%" for the auth bridge), and a security
// lens that turned a failed read into an empty table. Here every count is an exact count or a
// fully paged read, and a source that could not be read is NAMED in `unavailable` and its figure
// is `null` — the screen says "Unavailable", never zero.

import { getLoginSecuritySignals, type LoginSecuritySignals } from "@/lib/error-monitor/service";
import { canonicalHrIdKey } from "@/lib/hr-id";
import { logError } from "@/lib/observability/log";
import { fetchAllRows } from "@/lib/supabase/paginated";
import { ilikeAnyFilter, quotePostgrestValue } from "@/lib/supabase/search-filter";
import { getSupabaseAdmin } from "@/lib/supabase/server";

/** The audit_logs entity types that ARE sign-in and account activity. */
export const LOGIN_SECURITY_ACTIVITY_ENTITY_TYPES = ["auth_session", "user"] as const;
export const LOGIN_SECURITY_ACTIVITY_PAGE_SIZE = 25;
/** The security lens window, in days. */
export const LOGIN_SECURITY_WINDOW_DAYS = 7;

export type LoginSecurityActivityRow = {
  id: string;
  createdAt: string | null;
  /** "Sign-in" for auth_session rows, "Account" for user rows. */
  kindLabel: string;
  summary: string;
  actorLoginId: string | null;
  actorName: string | null;
};

export type LoginSecurityActivityPage = {
  rows: LoginSecurityActivityRow[];
  total: number;
  page: number;
  pageSize: number;
  pageCount: number;
  search: string;
};

export type LoginSecurityOverview = {
  generatedAt: string;
  /** Accounts locked right now. `null` = could not be read. */
  lockedAccounts: number | null;
  /** Accounts that must set a new password at next sign-in. */
  forcedPasswordResets: number | null;
  /** Failed sign-in attempts in the last 24 hours (exact count, no row cap). */
  failedSignIns24h: number | null;
  /** Distinct addresses those failures came from (fully paged). */
  distinctFailedIps24h: number | null;
  signals: LoginSecuritySignals;
  recentActivity: LoginSecurityActivityPage | null;
  /** Plain-words names of every source that could not be read. */
  unavailable: string[];
};

export type LoginSecurityOverviewOptions = {
  search?: string | null;
  page?: number | null;
};

function activityKindLabel(entityType: string | null | undefined): string {
  if (entityType === "auth_session") return "Sign-in";
  if (entityType === "user") return "Account";
  return "Other";
}

/**
 * Every login id whose account NAME or HR id matches the search, so "Ahmed" finds Ahmed's rows even
 * though audit_logs stores only the login id. Pure, so the matching is testable without a database.
 */
export function matchLoginIdsBySearch(
  accounts: ReadonlyArray<{ loginId: string; hrId: string | null; name: string | null }>,
  search: string,
): string[] {
  const term = search.trim().toLowerCase();
  if (!term) return [];
  const matched = new Set<string>();
  for (const account of accounts) {
    const haystack = [account.loginId, account.hrId ?? "", account.name ?? ""].map((value) => value.toLowerCase());
    if (haystack.some((value) => value.includes(term))) matched.add(account.loginId);
  }
  return Array.from(matched);
}

/** Exact count for one filtered read; throws on failure so the caller can name it. */
async function exactCount(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  build: () => any,
): Promise<number> {
  const { count, error } = await build();
  if (error) throw error;
  if (typeof count !== "number") throw new Error("The database returned no count.");
  return count;
}

/**
 * The one loader behind the System Audit login-security section and its refresh route
 * (GET /api/admin/system-audit/security). Never throws: each source settles on its own.
 */
export async function loadLoginSecurityOverview(options: LoginSecurityOverviewOptions = {}): Promise<LoginSecurityOverview> {
  const supabase = getSupabaseAdmin();
  const unavailable: string[] = [];
  const nowIso = new Date().toISOString();
  const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const search = String(options.search ?? "").trim().slice(0, 120);
  const page = Math.max(1, Math.floor(Number(options.page) || 1));
  const pageSize = LOGIN_SECURITY_ACTIVITY_PAGE_SIZE;

  async function settle<T>(label: string, read: () => Promise<T>): Promise<T | null> {
    try {
      return await read();
    } catch (error) {
      logError("Login security overview source could not be read", { labels: { event: "login_security_overview_source_failed", source: label }, error });
      unavailable.push(label);
      return null;
    }
  }

  const [lockedAccounts, forcedPasswordResets, failedSignIns24h, failedIpRows, accountRows, signals] = await Promise.all([
    settle("Locked accounts count", () =>
      exactCount(() => supabase.from("app_auth_users").select("login_id", { count: "exact", head: true }).gt("locked_until", nowIso))),
    settle("Forced password resets count", () =>
      exactCount(() => supabase.from("app_auth_users").select("login_id", { count: "exact", head: true }).eq("force_password_reset", true))),
    settle("Failed sign-ins (24 hours)", () =>
      exactCount(() =>
        supabase.from("auth_login_attempts").select("id", { count: "exact", head: true }).eq("success", false).gte("attempted_at", since24h))),
    settle("Failed sign-in addresses (24 hours)", () =>
      fetchAllRows<{ ip?: unknown }>(
        () => supabase.from("auth_login_attempts").select("id, ip").eq("success", false).gte("attempted_at", since24h),
        "id",
      )),
    settle("Account names", () =>
      fetchAllRows<{ login_id?: unknown; hr_id?: unknown; name?: unknown }>(
        () => supabase.from("app_auth_users").select("login_id, hr_id, name"),
        "login_id",
      )),
    getLoginSecuritySignals(LOGIN_SECURITY_WINDOW_DAYS),
  ]);

  // The lens names its own failed sources; carry them up so the section shows ONE list.
  for (const label of signals.unavailable) if (!unavailable.includes(label)) unavailable.push(label);

  const distinctFailedIps24h = failedIpRows
    ? new Set(failedIpRows.map((row) => (typeof row.ip === "string" ? row.ip.trim() : "")).filter(Boolean)).size
    : null;

  const accounts = (accountRows ?? [])
    .map((row) => ({
      hrId: typeof row.hr_id === "string" && row.hr_id.trim() ? row.hr_id.trim() : null,
      loginId: typeof row.login_id === "string" ? row.login_id.trim() : "",
      name: typeof row.name === "string" && row.name.trim() ? row.name.trim() : null,
    }))
    .filter((account) => account.loginId.length > 0);
  const nameByLoginKey = new Map<string, string | null>();
  for (const account of accounts) {
    const key = canonicalHrIdKey(account.loginId);
    if (key) nameByLoginKey.set(key, account.name);
  }

  const recentActivity = await settle("Recent security activity", async (): Promise<LoginSecurityActivityPage> => {
    const clauses: string[] = [];
    if (search) {
      const textFilter = ilikeAnyFilter(["actor_login_id", "summary"], search);
      if (textFilter) clauses.push(textFilter);
      // Bounded: a one-letter search can match most accounts, and the filter travels in the URL.
      const matchedLoginIds = matchLoginIdsBySearch(accounts, search).slice(0, 300);
      if (matchedLoginIds.length > 0) {
        clauses.push(`actor_login_id.in.(${matchedLoginIds.map(quotePostgrestValue).join(",")})`);
      }
    }
    let query = supabase
      .from("audit_logs")
      .select("id, actor_login_id, entity_type, summary, created_at", { count: "exact" })
      .in("entity_type", [...LOGIN_SECURITY_ACTIVITY_ENTITY_TYPES]);
    if (clauses.length > 0) query = query.or(clauses.join(","));
    const offset = (page - 1) * pageSize;
    const { data, count, error } = await query
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .range(offset, offset + pageSize - 1);
    if (error) throw error;
    const total = typeof count === "number" ? count : 0;
    const rows: LoginSecurityActivityRow[] = ((data ?? []) as Record<string, unknown>[]).map((row) => {
      const actorLoginId = typeof row.actor_login_id === "string" && row.actor_login_id.trim() ? row.actor_login_id.trim() : null;
      const key = actorLoginId ? canonicalHrIdKey(actorLoginId) : null;
      return {
        actorLoginId,
        actorName: key ? (nameByLoginKey.get(key) ?? null) : null,
        createdAt: typeof row.created_at === "string" ? row.created_at : null,
        id: String(row.id),
        kindLabel: activityKindLabel(row.entity_type as string | null),
        summary: typeof row.summary === "string" && row.summary.trim() ? row.summary : "No summary recorded",
      };
    });
    return { page, pageCount: Math.max(1, Math.ceil(total / pageSize)), pageSize, rows, search, total };
  });

  return {
    distinctFailedIps24h,
    failedSignIns24h,
    forcedPasswordResets,
    generatedAt: nowIso,
    lockedAccounts,
    recentActivity,
    signals,
    unavailable,
  };
}

/** Re-exported so the section can type its props without reaching into error-monitor. */
export type { LoginSecuritySignals };
