/**
 * Temporary per-account module locks.
 *
 * The system administrator suspends ONE module for ONE account. The person keeps their role and
 * every grant that comes with it; the module is simply closed until the lock is released. Their
 * sidebar still shows the tab — carrying a padlock — and opening it lands on a page that says so.
 *
 * Owner's instruction, 2026-08-30: "choose an account and then choose a module he have access on it
 * normally … temporary lock it, so when he opens he finds a lock on its tab in the sidebar, and if
 * pressed or tried to access a page it says locked temporarily by system admin."
 *
 * WHERE THIS BITES. `canAccess` in ./permissions.ts consults this module, so every route handler
 * that calls `assertPermission` refuses a locked module without any of them being edited. The two
 * shells (AppShell and the employee-portal layout) additionally intercept the page render, so the
 * locked person gets the sentence above rather than a raw "Forbidden" — but the SECURITY boundary
 * is `canAccess`, exactly as it is for every other access rule in this app. The sidebar padlock is
 * UX.
 *
 * FAIL-OPEN, DELIBERATELY. Every failure path here returns "no locks": an unreadable table, a
 * missing table (the deploy-before-migration window), a malformed row. A lock is a restriction ON
 * TOP of normal access, so the safe direction when this subsystem is broken is that everybody keeps
 * what their role already gives them. Failing closed here would take the whole application away
 * from every employee the first time one query timed out.
 */

import { canonicalHrIdKey } from "@/lib/hr-id";
import { logError } from "@/lib/observability/log";
import { getSupabaseAdmin } from "@/lib/supabase/server";

import type { AccessContext, PermissionResource } from "./permissions";

/** The sentence the locked-out person reads. The owner's own wording. */
export const MODULE_LOCK_HEADLINE = "Locked temporarily by the system administrator.";

/**
 * The four modules that can never be locked on a Super Admin account.
 *
 * Locking `permission_admin` or `user_admin` on the only system administrator removes the screen
 * that releases the lock, and the release path is then the database. There is no legitimate use for
 * that, so it is refused at the service rather than warned about in the UI — a warning is something
 * a tired person clicks past at 4am, which is exactly when this would be used.
 */
export const UNLOCKABLE_ADMIN_RESOURCES: readonly PermissionResource[] = [
  "admin",
  "admin_access",
  "permission_admin",
  "user_admin",
];

/**
 * Modules that can never be locked for ANYBODY, because they are not modules — they are the door.
 *
 * `employee_profile:read` is the employee portal's own entry gate: EmployeePortalServerShell
 * asserts it and REDIRECTS TO /login when it is denied. Locking it would not close a tab, it would
 * bounce the person to the login screen, which signs them straight back in and bounces them
 * again — a loop with no page anywhere in it that could say what happened. It is also a floor
 * permission for every role (`portalMinimumPermissions`), which is the same judgement already made
 * about role overrides: this one is not the administrator's to take away.
 *
 * Enforced in THREE places on purpose — the picker does not offer it, the write refuses it, and the
 * read ignores it even if a row somehow exists. The third is what protects against a row inserted
 * by hand in the database, which is the only way the first two can be bypassed.
 */
export const NEVER_LOCKABLE_RESOURCES: readonly PermissionResource[] = ["employee_profile"];

export function isLockableModule(resource: PermissionResource): boolean {
  return !NEVER_LOCKABLE_RESOURCES.includes(resource);
}

export type ModuleLock = {
  id: string;
  loginId: string;
  hrId: string | null;
  moduleKey: string;
  note: string | null;
  lockedAt: string;
  lockedByName: string | null;
  lockedByLoginId: string | null;
  unlockAt: string | null;
  releasedAt: string | null;
  releasedByName: string | null;
};

type ModuleLockRow = {
  id: string;
  login_id: string;
  hr_id: string | null;
  module_key: string;
  note: string | null;
  locked_at: string;
  locked_by_name: string | null;
  locked_by_login_id: string | null;
  unlock_at: string | null;
  released_at: string | null;
  released_by_name: string | null;
};

const LOCK_COLUMNS =
  "id,login_id,hr_id,module_key,note,locked_at,locked_by_name,locked_by_login_id,unlock_at,released_at,released_by_name";

function toModuleLock(row: ModuleLockRow): ModuleLock {
  return {
    id: row.id,
    loginId: row.login_id,
    hrId: row.hr_id ?? null,
    moduleKey: row.module_key,
    note: row.note ?? null,
    lockedAt: row.locked_at,
    lockedByName: row.locked_by_name ?? null,
    lockedByLoginId: row.locked_by_login_id ?? null,
    unlockAt: row.unlock_at ?? null,
    releasedAt: row.released_at ?? null,
    releasedByName: row.released_by_name ?? null,
  };
}

/**
 * The table not existing yet is a NORMAL state, not an incident: the code deploy and the migration
 * are two separate events and either can land first. PostgREST answers a missing table with
 * PGRST205 out of its schema cache rather than Postgres's 42P01, so both spellings are one case.
 */
function isMissingLockTable(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code ?? "";
  const message = String((error as { message?: string } | null)?.message ?? error ?? "").toLowerCase();
  return (
    code === "42P01" ||
    code === "PGRST205" ||
    message.includes("schema cache") ||
    (message.includes("user_module_locks") && message.includes("does not exist"))
  );
}

// ── The live-lock cache ───────────────────────────────────────────────────────
//
// The whole table is loaded in one query and held for a few seconds, the same shape the permission
// matrix cache uses. The table holds one row per live lock — a handful at most — so caching the set
// rather than per-account answers means one round trip covers every viewer, and a lock or release
// reaches every server within the window. The write path clears the cache in-process so an
// administrator sees their own change immediately.

const cacheSeconds = Number(process.env.PHOENIX_MODULE_LOCK_CACHE_SECONDS ?? 10);
const cacheMs = Math.max(2000, Number.isFinite(cacheSeconds) ? cacheSeconds * 1000 : 10000);

type CacheState = { fetchedAt: number; locks: ModuleLock[] };

let cache: CacheState | null = null;
let inFlight: Promise<ModuleLock[]> | null = null;

export function clearModuleLockCache() {
  cache = null;
}

async function fetchActiveModuleLocks(): Promise<ModuleLock[]> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("user_module_locks")
    .select(LOCK_COLUMNS)
    .is("released_at", null);

  if (error) {
    if (isMissingLockTable(error)) return [];
    throw error;
  }

  const now = Date.now();
  return ((data ?? []) as ModuleLockRow[])
    .map(toModuleLock)
    // Expiry is evaluated HERE rather than by a scheduled job. A job that fails leaves someone
    // locked out past their own unlock time, and nothing would report it.
    .filter((lock) => !lock.unlockAt || new Date(lock.unlockAt).getTime() > now)
    // A row on a never-lockable module is ignored rather than obeyed — see NEVER_LOCKABLE_RESOURCES.
    // The write path refuses to create one; this is what makes a hand-inserted row harmless too.
    .filter((lock) => !NEVER_LOCKABLE_RESOURCES.includes(lock.moduleKey as PermissionResource));
}

/** Every lock that is in force right now, cached. Returns [] on any failure — see the header. */
export async function loadActiveModuleLocks(): Promise<ModuleLock[]> {
  if (cache && cache.fetchedAt + cacheMs > Date.now()) return cache.locks;

  if (!inFlight) {
    inFlight = fetchActiveModuleLocks()
      .then((locks) => {
        cache = { fetchedAt: Date.now(), locks };
        return locks;
      })
      .catch((error) => {
        logError("user_module_locks load failed; treating as no locks", {
          labels: { event: "module_locks_load_failed" },
          error,
        });
        // Not cached: the next call retries. Fail-open is a degraded state, not a new policy.
        return cache?.locks ?? [];
      })
      .finally(() => {
        inFlight = null;
      });
  }

  return inFlight;
}

/**
 * Does this lock apply to this viewer?
 *
 * login_id is the primary key of an account and is compared case-insensitively, because the login
 * screen accepts either casing. hr_id is the second path, for sessions that carry an HR_ID and no
 * login_id — and HR_IDs in this database are MIXED CASE, so both sides are canonicalised. A bare
 * `.eq` on an HR_ID has already hidden real rows here more than once.
 */
function lockAppliesTo(lock: ModuleLock, access: Pick<AccessContext, "hrId" | "loginId">): boolean {
  const viewerLogin = String(access.loginId ?? "").trim().toLowerCase();
  const lockLogin = String(lock.loginId ?? "").trim().toLowerCase();
  if (viewerLogin && lockLogin && viewerLogin === lockLogin) return true;

  const viewerHr = canonicalHrIdKey(access.hrId);
  const lockHr = canonicalHrIdKey(lock.hrId);
  return Boolean(viewerHr && lockHr && viewerHr === lockHr);
}

/** Every module locked for this viewer right now. */
export async function resolveModuleLocksForAccess(
  access: Pick<AccessContext, "hrId" | "loginId" | "scope" | "source">,
): Promise<ModuleLock[]> {
  // The system context is cron, migrations and internal jobs — never a person with a sidebar.
  // Locking it would stop payroll runs and notification drains on a UI action, which is not what
  // "lock this person out of Payroll" means.
  if (access.scope === "system" || access.source === "system") return [];
  if (!access.loginId && !access.hrId) return [];

  const locks = await loadActiveModuleLocks();
  return locks.filter((lock) => lockAppliesTo(lock, access));
}

/** The set of locked module keys for this viewer — what the sidebar renders padlocks from. */
export async function resolveLockedModuleKeysForAccess(
  access: Pick<AccessContext, "hrId" | "loginId" | "scope" | "source">,
): Promise<string[]> {
  const locks = await resolveModuleLocksForAccess(access);
  return Array.from(new Set(locks.map((lock) => lock.moduleKey)));
}

/** The lock standing between this viewer and this module, or null. */
export async function findActiveModuleLock(
  access: Pick<AccessContext, "hrId" | "loginId" | "scope" | "source">,
  resource: PermissionResource,
): Promise<ModuleLock | null> {
  const locks = await resolveModuleLocksForAccess(access);
  return locks.find((lock) => lock.moduleKey === resource) ?? null;
}

/** True when this viewer's access to this module is suspended. Consulted by `canAccess`. */
export async function isModuleLockedForAccess(
  access: Pick<AccessContext, "hrId" | "loginId" | "scope" | "source">,
  resource: PermissionResource,
): Promise<boolean> {
  return Boolean(await findActiveModuleLock(access, resource));
}

// ── Administration ────────────────────────────────────────────────────────────

export type ModuleLockAdminRow = ModuleLock & {
  fullName: string | null;
  role: string | null;
};

/**
 * Locks for the admin screen: every live lock, plus the most recent released ones so the screen can
 * answer "what was locked last week" without a second page.
 */
export async function listModuleLocks(options?: { historyLimit?: number }): Promise<{
  active: ModuleLock[];
  history: ModuleLock[];
}> {
  const historyLimit = options?.historyLimit ?? 50;
  const supabase = getSupabaseAdmin();

  const { data, error } = await supabase
    .from("user_module_locks")
    .select(LOCK_COLUMNS)
    .order("locked_at", { ascending: false })
    .limit(500);

  if (error) {
    if (isMissingLockTable(error)) return { active: [], history: [] };
    throw error;
  }

  const now = Date.now();
  const rows = ((data ?? []) as ModuleLockRow[]).map(toModuleLock);
  const active = rows.filter(
    (lock) => !lock.releasedAt && (!lock.unlockAt || new Date(lock.unlockAt).getTime() > now),
  );
  const activeIds = new Set(active.map((lock) => lock.id));
  const history = rows.filter((lock) => !activeIds.has(lock.id)).slice(0, historyLimit);

  return { active, history };
}

export type LockModuleInput = {
  loginId: string;
  hrId?: string | null;
  moduleKey: PermissionResource;
  note?: string | null;
  unlockAt?: string | null;
  /** The administrator performing the lock — never the target. */
  actor: { loginId?: string | null; hrId?: string | null; name?: string | null };
};

/**
 * The target account as the DATABASE spells it — never as the caller spelled it.
 *
 * THIS EXISTS BECAUSE THE GUARD WAS ONCE ONLY AS GOOD AS THE REQUEST BODY. The Super Admin refusal
 * below used to read the target's role out of the POST payload, so a request that simply omitted it
 * sailed past — measured on staging 2026-08-30, which happily locked `admin` on a live Super Admin
 * account. A guard against locking somebody out of the release screen cannot be advisory, and it
 * cannot trust the caller to describe its own target.
 *
 * Returns null when there is no such active account.
 */
export async function loadLockTargetAccount(loginId: string): Promise<{
  loginId: string;
  role: string | null;
  hrId: string | null;
} | null> {
  const wanted = String(loginId ?? "").trim();
  if (!wanted) return null;

  const supabase = getSupabaseAdmin();
  // ilike, not eq: login ids are mixed case here and an exact match silently under-returns.
  const { data, error } = await supabase
    .from("app_auth_users")
    .select("login_id, role, hr_id, is_active")
    .ilike("login_id", wanted)
    .limit(1);

  if (error) throw error;
  const row = (data ?? [])[0] as { login_id?: string; role?: string; hr_id?: string | null; is_active?: boolean } | undefined;
  if (!row || row.is_active === false) return null;

  return {
    loginId: String(row.login_id ?? wanted),
    role: row.role ?? null,
    hrId: canonicalHrIdKey(row.hr_id) || null,
  };
}

/**
 * The refusal, with the target's role read from the database rather than taken on trust.
 *
 * Fails CLOSED, unlike everything on the read side of this file: if the account cannot be found or
 * the lookup itself fails, the answer is a refusal. The read path degrades to "no locks" because a
 * broken lock table must not take the application away from everybody; the WRITE path is the
 * opposite case — an unverified write here is what locks an administrator out of the only screen
 * that can undo it.
 */
export async function describeModuleLockRefusalForAccount(input: {
  loginId: string;
  moduleKey: PermissionResource;
  actorLoginId?: string | null;
}): Promise<string | null> {
  let target: Awaited<ReturnType<typeof loadLockTargetAccount>> = null;
  try {
    target = await loadLockTargetAccount(input.loginId);
  } catch (error) {
    logError("module lock target lookup failed; refusing the lock", {
      labels: { event: "module_lock_target_lookup_failed", loginId: input.loginId },
      error,
    });
    return "That account could not be checked just now, so the lock was not applied. Try again in a moment.";
  }
  if (!target) {
    return "There is no active account with that login id.";
  }
  return describeModuleLockRefusal({
    loginId: target.loginId,
    moduleKey: input.moduleKey,
    actorLoginId: input.actorLoginId,
    targetRole: target.role,
  });
}

/**
 * Two refusals, both structural rather than advisory.
 *
 * 1. Nobody locks their own account. The person who does it is the person who cannot undo it.
 * 2. The four administration modules are never locked on a Super Admin account — that is the screen
 *    the release is performed from.
 */
export function describeModuleLockRefusal(input: {
  loginId: string;
  moduleKey: PermissionResource;
  actorLoginId?: string | null;
  targetRole?: string | null;
}): string | null {
  const target = String(input.loginId ?? "").trim().toLowerCase();
  const actor = String(input.actorLoginId ?? "").trim().toLowerCase();
  if (target && actor && target === actor) {
    return "You cannot lock a module on your own account.";
  }
  if (!isLockableModule(input.moduleKey)) {
    return "Employee Profile is the portal's own entry gate and cannot be locked — locking it would bounce the person between the portal and the login screen.";
  }
  if (
    String(input.targetRole ?? "").trim().toLowerCase() === "super admin" &&
    UNLOCKABLE_ADMIN_RESOURCES.includes(input.moduleKey)
  ) {
    return "Administration modules cannot be locked on a Super Admin account — that is the screen this lock is released from.";
  }
  return null;
}

export async function lockModuleForAccount(input: LockModuleInput): Promise<ModuleLock> {
  // The boundary, and it resolves its own facts. The route asks the same question first so it can
  // answer with a 400 the administrator can read, but this call is what actually decides — an API
  // client that skips the screen entirely still meets the guard here.
  const refusal = await describeModuleLockRefusalForAccount({
    loginId: input.loginId,
    moduleKey: input.moduleKey,
    actorLoginId: input.actor.loginId,
  });
  if (refusal) throw new Error(refusal);

  const target = await loadLockTargetAccount(input.loginId);
  if (!target) throw new Error("There is no active account with that login id.");

  const supabase = getSupabaseAdmin();
  const nowIso = new Date().toISOString();

  const fields = {
    // The account's OWN hr_id, not one the caller supplied. A wrong hr_id here is a lock that
    // silently fails to recognise the very session it was placed on.
    hr_id: target.hrId ?? (canonicalHrIdKey(input.hrId) || null),
    note: input.note?.trim() ? input.note.trim() : null,
    unlock_at: input.unlockAt ?? null,
    locked_at: nowIso,
    locked_by_login_id: input.actor.loginId ?? null,
    locked_by_hr_id: input.actor.hrId ?? null,
    locked_by_name: input.actor.name ?? null,
    released_at: null,
    released_by_login_id: null,
    released_by_hr_id: null,
    released_by_name: null,
    updated_at: nowIso,
  };

  // Re-locking an already-locked module updates the standing row rather than stacking a second one:
  // two live locks on one module make "release it" ambiguous.
  //
  // Deliberately UPDATE-then-INSERT rather than an upsert. The uniqueness this relies on is a
  // PARTIAL index (`where released_at is null`, so a released row never blocks a fresh lock), and
  // PostgREST's `on_conflict=` emits a bare `ON CONFLICT (login_id, module_key)` with no predicate
  // — which infers no partial index and fails outright with "no unique or exclusion constraint
  // matching the ON CONFLICT specification". Two statements are the honest way to get the same
  // result; this is an administrator pressing a button, so the extra round trip costs nothing.
  //
  // Matched case-insensitively because login ids are entered by hand and the readers already treat
  // them that way. An exact-case duplicate would otherwise become a second live lock that the
  // release button can only take off one row at a time.
  const { data: updated, error: updateError } = await supabase
    .from("user_module_locks")
    .update(fields)
    .ilike("login_id", input.loginId)
    .eq("module_key", input.moduleKey)
    .is("released_at", null)
    .select(LOCK_COLUMNS);

  if (updateError) throw updateError;
  if (updated && updated.length > 0) {
    clearModuleLockCache();
    return toModuleLock(updated[0] as ModuleLockRow);
  }

  const { data, error } = await supabase
    .from("user_module_locks")
    .insert({ login_id: input.loginId, module_key: input.moduleKey, ...fields })
    .select(LOCK_COLUMNS)
    .single();

  if (error) throw error;
  clearModuleLockCache();
  return toModuleLock(data as ModuleLockRow);
}

export type ReleaseModuleLockInput = {
  id: string;
  actor: { loginId?: string | null; hrId?: string | null; name?: string | null };
};

/** Releases a lock. The row STAYS — released, not deleted — so the history survives. */
export async function releaseModuleLock(input: ReleaseModuleLockInput): Promise<void> {
  const supabase = getSupabaseAdmin();
  const nowIso = new Date().toISOString();

  const { error } = await supabase
    .from("user_module_locks")
    .update({
      released_at: nowIso,
      released_by_login_id: input.actor.loginId ?? null,
      released_by_hr_id: input.actor.hrId ?? null,
      released_by_name: input.actor.name ?? null,
      updated_at: nowIso,
    })
    .eq("id", input.id)
    .is("released_at", null);

  if (error) throw error;
  clearModuleLockCache();
}
