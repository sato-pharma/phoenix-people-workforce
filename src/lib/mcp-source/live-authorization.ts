import type { SupabaseClient } from "@supabase/supabase-js";

import { canonicalHrIdKey } from "@/lib/hr-id";
import { isEmploymentAccessRevoked } from "@/lib/auth/session-lifecycle";

/**
 * Owner-only LIVE authorization for the MCP source host.
 *
 * Phoenix's own session path caches the permission matrix, serves the last-known-good matrix when a
 * load fails, and treats an unreadable module-lock table as "no locks" (fail open, by design, so one
 * timeout cannot take the application away from everyone). None of that is acceptable for a bridge
 * that lets an external assistant read company data: here every input is read from the database on
 * EVERY call, and ANY source error is an error — never an empty permission list, never "no locks".
 *
 * Returning `null` means the owner is definitively not authorized (no account, Auth user missing,
 * banned or deleted, role moved off the two allowed roles). Throwing means "could not decide", which
 * the route turns into a 503 so the reader fails closed without revoking anything.
 */

export const LIVE_ROLES = ["Super Admin", "CEO"] as const;
/** The resources the five MCP tools are gated on. */
export const LIVE_RESOURCES = ["employees", "vacancies", "organogram", "sales"] as const;
/** Never lockable on anyone (see module-locks.ts). A row naming one is ignored there, so it is here. */
const NEVER_LOCKABLE = new Set(["employee_profile"]);

export type LiveAccountRow = {
  login_id: string | null;
  role: string | null;
  hr_id: string | null;
  is_active: boolean | null;
  is_test_persona: boolean | null;
  session_version: number | null;
};
export type LiveAuthUser = { exists: boolean; bannedUntil: string | null; deletedAt: string | null };
export type LiveEmployeeRow = { employment_status: string | null; last_working_date: string | null };
export type LiveLockRow = { login_id: string | null; hr_id: string | null; module_key: string | null; unlock_at: string | null };
export type LiveMatrix = Record<string, Partial<Record<string, readonly string[]>>>;

export type LiveInputs = {
  subject: string;
  accounts: readonly LiveAccountRow[];
  authUser: LiveAuthUser;
  /** Required whenever the account carries an HR id; absent for an account with none. */
  employee: LiveEmployeeRow | null;
  matrix: LiveMatrix;
  /** Every UNRELEASED lock in the table; expiry is judged here against `now`. */
  locks: readonly LiveLockRow[];
  now: Date;
};

export type LiveIdentity = {
  subject: string;
  loginId: string;
  hrId: string | null;
  role: (typeof LIVE_ROLES)[number];
  active: boolean;
  sessionVersion: number;
  employmentStatus: string | null;
  lastWorkingDate: string | null;
  testPersona: boolean;
  permissions: { resource: string; allowed: boolean }[];
  locks: string[];
};

export class LiveAuthorizationError extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(`Live authorization could not be decided: ${reason}`);
    this.name = "LiveAuthorizationError";
    this.reason = reason;
  }
}

const cairoToday = (now: Date) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Cairo", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);

/** Pure decision over rows already read live. Throws only for ambiguity; `null` is a clean denial. */
export function decideLiveIdentity(input: LiveInputs): LiveIdentity | null {
  if (input.accounts.length === 0) return null;
  if (input.accounts.length > 1) throw new LiveAuthorizationError("ambiguous_account");
  if (!input.authUser.exists || input.authUser.deletedAt) return null;
  if (input.authUser.bannedUntil && Date.parse(input.authUser.bannedUntil) > input.now.getTime()) return null;

  const account = input.accounts[0];
  const loginId = String(account.login_id ?? "").trim();
  if (!loginId) throw new LiveAuthorizationError("account_without_login");
  const role = LIVE_ROLES.find((allowed) => allowed === account.role);
  if (!role) return null;

  const hrId = String(account.hr_id ?? "").trim() || null;
  if (hrId && !input.employee) throw new LiveAuthorizationError("employee_row_missing");
  const employmentStatus = hrId ? (input.employee?.employment_status ?? null) : null;
  const lastWorkingDate = hrId ? (input.employee?.last_working_date ?? null) : null;
  // The same predicate the web session gate uses. A departed employee is a denial, not an error.
  const departed = isEmploymentAccessRevoked({ employmentStatus, lastWorkingDate, todayCairo: cairoToday(input.now) });

  const granted = input.matrix[role];
  if (!granted) throw new LiveAuthorizationError("role_missing_from_matrix");
  const locked = new Set<string>();
  const loginKey = loginId.toLowerCase();
  const hrKey = canonicalHrIdKey(hrId);
  for (const lock of input.locks) {
    const moduleKey = String(lock.module_key ?? "").trim();
    if (!moduleKey || NEVER_LOCKABLE.has(moduleKey)) continue;
    if (lock.unlock_at && Date.parse(lock.unlock_at) <= input.now.getTime()) continue;
    const lockLogin = String(lock.login_id ?? "").trim().toLowerCase();
    const lockHr = canonicalHrIdKey(lock.hr_id);
    if ((lockLogin && lockLogin === loginKey) || (lockHr && hrKey && lockHr === hrKey)) locked.add(moduleKey);
  }

  return {
    subject: input.subject,
    loginId,
    hrId,
    role,
    active: account.is_active === true && !departed,
    sessionVersion: Number.isInteger(account.session_version) && (account.session_version as number) >= 0 ? (account.session_version as number) : 1,
    employmentStatus,
    lastWorkingDate,
    testPersona: account.is_test_persona === true,
    permissions: LIVE_RESOURCES.map((resource) => ({ resource, allowed: granted[resource]?.includes("read") ?? false })),
    locks: [...locked].sort(),
  };
}

export type LiveSources = {
  accounts(subject: string): Promise<LiveAccountRow[]>;
  authUser(subject: string): Promise<LiveAuthUser>;
  employee(hrId: string): Promise<LiveEmployeeRow | null>;
  matrix(): Promise<LiveMatrix>;
  locks(): Promise<LiveLockRow[]>;
  now(): Date;
};

/** Reads every input afresh and decides. No cache, no fallback: a rejected read rejects the call. */
export async function loadLiveIdentity(subject: string, sources: LiveSources): Promise<LiveIdentity | null> {
  const [accounts, authUser, matrix, locks] = await Promise.all([
    sources.accounts(subject),
    sources.authUser(subject),
    sources.matrix(),
    sources.locks(),
  ]);
  const hrId = accounts.length === 1 ? String(accounts[0].hr_id ?? "").trim() : "";
  const employee = hrId ? await sources.employee(hrId) : null;
  return decideLiveIdentity({ subject, accounts, authUser, employee, matrix, locks, now: sources.now() });
}

const escapeLike = (value: string) => value.replace(/[\\%_]/g, (char) => `\\${char}`);

/** The production sources: service-role reads that throw on any error, including a missing table. */
export function createSupabaseLiveSources(
  db: SupabaseClient,
  loadMatrix: () => Promise<LiveMatrix>,
  now: () => Date = () => new Date(),
): LiveSources {
  return {
    now,
    matrix: loadMatrix,
    async accounts(subject) {
      const { data, error } = await db
        .from("app_auth_users")
        .select("login_id,role,hr_id,is_active,is_test_persona,session_version")
        .eq("auth_user_id", subject)
        .limit(2);
      if (error) throw new LiveAuthorizationError("account_read_failed");
      return (data ?? []) as LiveAccountRow[];
    },
    async authUser(subject) {
      const { data, error } = await db.auth.admin.getUserById(subject);
      if (error) {
        if ((error as { status?: number }).status === 404) return { exists: false, bannedUntil: null, deletedAt: null };
        throw new LiveAuthorizationError("auth_user_read_failed");
      }
      const user = data?.user as ({ banned_until?: string | null; deleted_at?: string | null } | null | undefined);
      if (!user) return { exists: false, bannedUntil: null, deletedAt: null };
      return { exists: true, bannedUntil: user.banned_until ?? null, deletedAt: user.deleted_at ?? null };
    },
    async employee(hrId) {
      const { data, error } = await db
        .from("employees")
        .select("employment_status,last_working_date")
        .ilike("hr_id", escapeLike(hrId))
        .limit(2);
      if (error) throw new LiveAuthorizationError("employee_read_failed");
      if ((data ?? []).length > 1) throw new LiveAuthorizationError("ambiguous_employee");
      return ((data ?? [])[0] as LiveEmployeeRow | undefined) ?? null;
    },
    async locks() {
      const { data, error } = await db.from("user_module_locks").select("login_id,hr_id,module_key,unlock_at").is("released_at", null);
      // Unlike the web app, a missing table is NOT "no locks" here.
      if (error) throw new LiveAuthorizationError("lock_read_failed");
      return (data ?? []) as LiveLockRow[];
    },
  };
}
