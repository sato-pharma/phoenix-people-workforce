// =============================================================================
// Backfill missing / stale user_access_profiles rows
// =============================================================================
// WHY THIS EXISTS: user_access_profiles is supposed to always exist for every
// app_auth_users row and stay in sync with that account's role. Two ways it drifted:
//
//   1. upsertAccessUserCore (src/lib/admin/access-control.ts) wrote the profile only
//      `if (authUserId)`, with no else — an account whose auth_user_id is NULL got its
//      app_auth_users row written and its user_access_profiles write silently skipped.
//      Now fixed to log (event: access_control_profile_write_skipped_no_auth_user_id),
//      but the accounts already in that state from before the fix are still broken.
//   2. A role changed on app_auth_users without the matching profile write running,
//      leaving the profile stale (phoenix_role/role/scope_type no longer match the
//      account). AI-0007 hit this and was already fixed by hand in production — this
//      script must never re-touch it.
//
// Known-affected accounts at authoring time (2026-08-15, verified against production):
//   - CN-0006 (Adel Srour) — ACTIVE Medical Rep, auth_user_id is NULL, no profile. Needs
//     a real GoTrue identity provisioned, then gets a normal working login + profile.
//   - PD-0007 (Bahaa Gamal) — RESIGNED/INACTIVE Medical Rep, auth_user_id is NULL, no
//     profile. Needs a profile that mirrors is_active=false, but MUST NOT receive a
//     usable login — see "Leaver safety" below.
//   - admin-HR / AI-0007 — already fully synced in production as of 2026-08-15; not
//     expected to appear in this script's discovered plan any more, but AI-0007 stays
//     hard-excluded below regardless, per the owner's explicit instruction never to
//     re-touch it.
//
// This script does NOT hard-code that list. It queries app_auth_users and
// user_access_profiles directly and discovers every account that is missing a profile
// or whose profile has drifted from its current role, so it also catches anything not
// already known about. A NULL auth_user_id account has no GoTrue identity at all — raw
// SQL cannot mint one (user_access_profiles.auth_user_id is a NOT NULL FK-shaped uuid),
// so for those accounts this script provisions the identity through the same
// provisionSupabaseAuthIdentity() the live app uses, THEN writes the profile.
//
// Employees-row guard: user_access_profiles.hr_id is NOT NULL and a case-sensitive FK to
// employees.hr_id — a profile CANNOT be created for an account with no matching employees
// row. This script loads the real employees.hr_id set first and only ever resolves an
// hr_id that actually exists there. Any account whose hr_id (or, as a fallback, whose
// login_id) has no matching employees row is SKIPPED — not written, and not allowed to
// fail the whole run — and is reported separately in the summary's `skipped` list so it
// stays visible instead of silently vanishing.
//
// Leaver safety: an inactive/resigned account (PD-0007's class) must never be handed a
// working login. provisionSupabaseAuthIdentity() already bans the GoTrue user at creation
// when isActive is false (ban_duration is set directly in the admin.createUser() call), so
// the identity this script mints for an inactive account is born already-banned — it can
// never authenticate. On top of that, this script additionally SKIPS minting a
// password-setup link for any inactive account: there is no reason to hand a resigned
// employee a link to set a password for a login they can never use. Active accounts (like
// CN-0006) get the full normal treatment, including a real setup link.
//
// This is the create-and-repair sibling of scripts/provision-missing-employee-accounts.ts
// (which provisions an entire missing LOGIN for an employee who never got one). This
// script assumes the login already exists on app_auth_users; it only backfills the
// user_access_profiles side, plus the auth identity when that is what's missing.
//
// Usage (dry-run discovers the plan and writes nothing):
//   pnpm run ops:backfill-access-profiles
//
// Apply (production only; the confirm token must be the account count the dry-run just
// printed, re-run immediately before applying — this refuses a stale plan rather than
// trusting a number copied from an earlier run):
//   pnpm run ops:backfill-access-profiles -- --apply --confirm-production=<N>
//
// Idempotent: re-running after a successful apply finds zero accounts needing action,
// because every account it touched now has a profile that matches its current role.
// =============================================================================

import crypto from "node:crypto";

import type { SupabaseClient } from "@supabase/supabase-js";
import bcrypt from "bcryptjs";

import { writeRequiredAuditLog } from "@/lib/admin/audit";
import { parseRoleStrict, type PhoenixRole } from "@/lib/auth/permissions";
import {
  mapPhoenixRoleToAccessScopeType,
  mapPhoenixRoleToCoarseAccessRole,
  provisionSupabaseAuthIdentity,
} from "@/lib/auth/supabase-identity";
import { canonicalHrIdKey, resolveStoredHrId, type StoredHrIdDirectoryEntry } from "@/lib/hr-id";
import { fetchAllRows } from "@/lib/supabase/paginated";
import { getSupabaseAdmin } from "@/lib/supabase/server";

import { refuseUnknownFlags } from "./lib/refuse-arguments.mjs";

// A flag this script does not know is refused, never ignored (scripts/lib/refuse-arguments.mjs).
refuseUnknownFlags({
  name: "backfill-missing-access-profiles",
  entry: import.meta.url,
  known: ["--apply", "--dry-run", "--confirm-production"],
});

const productionSupabaseRef = "ozucdzovmcqvepbozvqf";
const productionAppUrl = "https://phoenix-hr.satopharma.com";
const actorLoginId = process.env.PHOENIX_ACCOUNT_PROVISION_ACTOR ?? "system";
const passwordSetupExpiryMs = 48 * 60 * 60 * 1000;

// Already fixed by hand in production (2026-08-14/15). Hard-excluded regardless of what
// the discovery query finds — the owner's instruction was explicit: do not re-touch it.
const neverTouchLoginIds = new Set(["AI-0007"]);

type ScriptMode = "dry-run" | "apply";

type CliOptions = {
  confirm: string | null;
  mode: ScriptMode;
};

function parseArgs(argv: string[]): CliOptions {
  const hasApply = argv.includes("--apply");
  const hasDryRun = argv.includes("--dry-run");
  if (hasApply && hasDryRun) throw new Error("Choose either --dry-run or --apply, not both.");

  const readValue = (prefix: string) =>
    argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length).trim() ?? null;

  return { confirm: readValue("--confirm-production="), mode: hasApply ? "apply" : "dry-run" };
}

function requiredEnv(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function assertProductionTarget() {
  const supabaseUrl = requiredEnv("NEXT_PUBLIC_SUPABASE_URL");
  let host = "";
  try {
    host = new URL(supabaseUrl).hostname;
  } catch {
    throw new Error("NEXT_PUBLIC_SUPABASE_URL is not a valid URL.");
  }
  if (!host.startsWith(`${productionSupabaseRef}.`)) {
    throw new Error(
      `Refusing to run: NEXT_PUBLIC_SUPABASE_URL points to ${host}, not production ref ${productionSupabaseRef}.`,
    );
  }
}

function createToken() {
  return crypto.randomBytes(32).toString("base64url");
}

function hashToken(token: string) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function createTemporaryAuthPassword() {
  return `Px-${crypto.randomBytes(24).toString("base64url")}!9a`;
}

function text(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/**
 * `created_by_login_id` on password_setup_tokens is a FK to app_auth_users.login_id.
 * Validate it BEFORE any write — otherwise a bad actor value provisions an identity and
 * only then fails on the token, leaving a half-fixed account. (This is exactly what bit
 * scripts/provision-missing-employee-accounts.ts on its first run, with actor "system".)
 */
async function assertActorIsValid(supabase: SupabaseClient) {
  const { data, error } = await supabase
    .from("app_auth_users")
    .select("login_id")
    .eq("login_id", actorLoginId);
  if (error) throw new Error(`Actor lookup failed: ${error.message}`);
  if ((data ?? []).length !== 1) {
    throw new Error(
      `Actor "${actorLoginId}" is not an app_auth_users.login_id, so password_setup_tokens would ` +
      `violate its foreign key. Set PHOENIX_ACCOUNT_PROVISION_ACTOR to a real admin login ID.`,
    );
  }
}

type AppAuthUserRow = {
  auth_email: string | null;
  auth_user_id: string | null;
  email: string | null;
  hr_id: string | null;
  is_active: boolean;
  line: string | null;
  login_id: string;
  manager_hr_id: string | null;
  name: string | null;
  role: string;
};

type ProfileRow = {
  auth_user_id: string;
  hr_id: string | null;
  is_active: boolean | null;
  line: string | null;
  login_id: string | null;
  manager_hr_id: string | null;
  phoenix_role: string | null;
  role: string | null;
  scope_type: string | null;
};

type PlannedAction =
  | { account: AppAuthUserRow; hrId: string; kind: "provision_identity_and_profile"; role: PhoenixRole }
  | { account: AppAuthUserRow; hrId: string; kind: "create_profile"; role: PhoenixRole }
  | { account: AppAuthUserRow; drift: string[]; hrId: string; kind: "sync_profile"; profile: ProfileRow; role: PhoenixRole };

type SkippedAccount = { loginId: string; reason: string };

// The three loads below are paged: a single read stops silently at 1,000 rows, and an account whose
// profile or employee row went unread would be planned as "missing" and written a second time.
async function loadAppAuthUsers(supabase: SupabaseClient): Promise<AppAuthUserRow[]> {
  return fetchAllRows<AppAuthUserRow>(
    () =>
      supabase
        .from("app_auth_users")
        .select("login_id,hr_id,role,is_active,auth_user_id,auth_email,name,email,line,manager_hr_id"),
    "login_id",
  ).catch((error: { message?: string }) => {
    throw new Error(`app_auth_users load failed: ${error.message ?? String(error)}`);
  });
}

async function loadProfiles(supabase: SupabaseClient): Promise<ProfileRow[]> {
  return fetchAllRows<ProfileRow>(
    () =>
      supabase
        .from("user_access_profiles")
        .select("auth_user_id,login_id,hr_id,phoenix_role,role,scope_type,is_active,line,manager_hr_id"),
    "auth_user_id",
  ).catch((error: { message?: string }) => {
    throw new Error(`user_access_profiles load failed: ${error.message ?? String(error)}`);
  });
}

/**
 * user_access_profiles.hr_id is a NOT NULL, case-sensitive FK to employees.hr_id. Load the
 * real set of employees.hr_id values so this script can verify a match exists BEFORE ever
 * attempting a write, instead of guessing a casing and letting Postgres reject it with a
 * raw 23503 partway through a run.
 */
async function loadEmployeeHrIdDirectory(supabase: SupabaseClient): Promise<Map<string, StoredHrIdDirectoryEntry>> {
  const data = await fetchAllRows<{ hr_id: string | null }>(
    () => supabase.from("employees").select("hr_id"),
    "hr_id",
  ).catch((error: { message?: string }) => {
    throw new Error(`employees load failed: ${error.message ?? String(error)}`);
  });

  const byHrId = new Map<string, StoredHrIdDirectoryEntry>();
  for (const row of data) {
    const key = canonicalHrIdKey(row.hr_id);
    if (key) byHrId.set(key, { hrId: row.hr_id });
  }
  return byHrId;
}

/**
 * Resolve the account's hr_id to the ACTUAL stored employees.hr_id spelling, trying the
 * account's own hr_id first and falling back to its login_id (both are admin-typed fields,
 * same as the live provisioning code) — but only if the resolved value truly matches a row
 * in `byHrId`. Returns null when nothing matches, so the caller can skip instead of writing
 * a profile that would violate the FK.
 */
function resolveVerifiedHrId(account: AppAuthUserRow, byHrId: Map<string, StoredHrIdDirectoryEntry>): string | null {
  for (const candidate of [account.hr_id, account.login_id]) {
    const key = canonicalHrIdKey(candidate);
    if (key && byHrId.has(key)) return resolveStoredHrId(candidate, byHrId);
  }
  return null;
}

/** Same derivation upsertAccessUserCore uses when it writes the profile — kept in lockstep
 * on purpose so this script can never disagree with the live provisioning path about what
 * a role should resolve to. `hrId` must already be a VERIFIED employees.hr_id (see
 * resolveVerifiedHrId) — this function does not re-check existence. */
function expectedProfileFields(account: AppAuthUserRow, role: PhoenixRole, hrId: string) {
  return {
    hr_id: hrId,
    is_active: Boolean(account.is_active),
    line: account.line ?? null,
    login_id: account.login_id,
    manager_hr_id: account.manager_hr_id ?? null,
    phoenix_role: role as string,
    role: mapPhoenixRoleToCoarseAccessRole(role),
    scope_type: mapPhoenixRoleToAccessScopeType(role),
  };
}

function driftFields(account: AppAuthUserRow, role: PhoenixRole, hrId: string, profile: ProfileRow): string[] {
  const expected = expectedProfileFields(account, role, hrId);
  const drift: string[] = [];
  for (const key of Object.keys(expected) as Array<keyof typeof expected>) {
    const current = profile[key as keyof ProfileRow] ?? null;
    const wanted = expected[key] ?? null;
    if (String(current) !== String(wanted)) {
      drift.push(`${key}: ${JSON.stringify(current)} -> ${JSON.stringify(wanted)}`);
    }
  }
  return drift;
}

async function buildPlan(supabase: SupabaseClient): Promise<{ plan: PlannedAction[]; skipped: SkippedAccount[] }> {
  const [accounts, profiles, employeeHrIds] = await Promise.all([
    loadAppAuthUsers(supabase),
    loadProfiles(supabase),
    loadEmployeeHrIdDirectory(supabase),
  ]);
  const profileByAuthUserId = new Map(
    profiles.filter((profile) => profile.auth_user_id).map((profile) => [profile.auth_user_id, profile]),
  );

  const plan: PlannedAction[] = [];
  const skipped: SkippedAccount[] = [];
  for (const account of accounts) {
    const loginId = text(account.login_id);
    if (!loginId || neverTouchLoginIds.has(loginId.toUpperCase())) continue;

    let role: PhoenixRole;
    try {
      role = parseRoleStrict(account.role);
    } catch {
      // An account with an unparseable role is a separate, pre-existing data problem — this
      // script repairs a MISSING/STALE profile for a KNOWN role, it does not guess one.
      skipped.push({ loginId, reason: "unparseable_role" });
      continue;
    }

    // Guard first: user_access_profiles.hr_id is a NOT NULL, case-sensitive FK to
    // employees.hr_id. An account with no matching employees row can never get a profile —
    // skip and report it instead of failing the whole run on a 23503.
    const hrId = resolveVerifiedHrId(account, employeeHrIds);
    if (!hrId) {
      skipped.push({ loginId, reason: "no_matching_employee_row" });
      continue;
    }

    if (!account.auth_user_id) {
      plan.push({ account, hrId, kind: "provision_identity_and_profile", role });
      continue;
    }

    const profile = profileByAuthUserId.get(account.auth_user_id);
    if (!profile) {
      plan.push({ account, hrId, kind: "create_profile", role });
      continue;
    }

    const drift = driftFields(account, role, hrId, profile);
    if (drift.length > 0) {
      plan.push({ account, drift, hrId, kind: "sync_profile", profile, role });
    }
  }

  return { plan, skipped };
}

async function upsertProfile(
  supabase: SupabaseClient,
  account: AppAuthUserRow,
  role: PhoenixRole,
  hrId: string,
  authUserId: string,
) {
  const { error } = await supabase
    .from("user_access_profiles")
    .upsert(
      {
        auth_user_id: authUserId,
        ...expectedProfileFields(account, role, hrId),
        updated_at: new Date().toISOString(),
      },
      { onConflict: "auth_user_id" },
    );
  if (error) throw new Error(`user_access_profiles upsert failed for ${account.login_id}: ${error.message}`);
}

async function createSetupLink(supabase: SupabaseClient, loginId: string) {
  const token = createToken();
  const expiresAt = new Date(Date.now() + passwordSetupExpiryMs).toISOString();
  const now = new Date().toISOString();

  const { error } = await supabase.from("password_setup_tokens").insert({
    created_by_login_id: actorLoginId,
    expires_at: expiresAt,
    login_id: loginId,
    purpose: "setup",
    sent_to_email: null,
    token_hash: hashToken(token),
    updated_at: now,
  });
  if (error) throw new Error(`password_setup_tokens insert failed for ${loginId}: ${error.message}`);

  return { expiresAt, setupUrl: `${productionAppUrl}/password-setup/${token}` };
}

async function applyAction(supabase: SupabaseClient, action: PlannedAction) {
  if (action.kind === "provision_identity_and_profile") {
    const isActive = Boolean(action.account.is_active);
    const password = createTemporaryAuthPassword();
    const identity = await provisionSupabaseAuthIdentity({
      authUserId: null,
      email: text(action.account.email),
      hrId: action.account.hr_id,
      // Leaver safety: provisionSupabaseAuthIdentity sets ban_duration directly in the
      // admin.createUser() call — isActive: false bans the GoTrue user AT CREATION, so an
      // inactive/resigned account (PD-0007's class) never gets a live-access window. Never
      // pass a hard-coded true here.
      isActive,
      line: action.account.line,
      loginId: action.account.login_id,
      managerHrId: action.account.manager_hr_id,
      name: action.account.name ?? action.account.login_id,
      password,
      role: action.role,
    });

    const now = new Date().toISOString();
    const { error: appUserError } = await supabase
      .from("app_auth_users")
      .update({
        auth_email: identity.authEmail,
        auth_user_id: identity.authUserId,
        force_password_reset: true,
        password_hash: await bcrypt.hash(password, 12),
        updated_at: now,
      })
      .eq("login_id", action.account.login_id);
    if (appUserError) {
      throw new Error(`app_auth_users update failed for ${action.account.login_id}: ${appUserError.message}`);
    }

    await upsertProfile(supabase, action.account, action.role, action.hrId, identity.authUserId);

    // Leaver safety, second layer: even though the GoTrue identity is already banned for an
    // inactive account, do not also hand out a password-setup link — there is no legitimate
    // reason for a resigned employee to receive a "set your password" link for a login they
    // can never use. Only active accounts (e.g. CN-0006) get a real setup link.
    const setupLink = isActive ? await createSetupLink(supabase, action.account.login_id) : null;

    await writeRequiredAuditLog({
      actorLoginId,
      entityId: action.account.login_id,
      entityType: "user",
      newValues: {
        auth_email: identity.authEmail,
        auth_user_id: identity.authUserId,
        is_active: isActive,
        password_hash: "[managed]",
        reason: isActive
          ? "Backfilled a missing GoTrue identity and user_access_profiles row for an account created " +
            "before the always-sync fix; a fresh temporary password was minted and a one-time setup link generated."
          : "Backfilled a missing GoTrue identity and user_access_profiles row for an INACTIVE/resigned " +
            "account created before the always-sync fix; the identity was provisioned already-banned and " +
            "NO password-setup link was generated, so this account still cannot log in.",
        role: action.role,
      },
      oldValues: { auth_user_id: null, user_access_profiles: null },
      summary: `Backfilled missing auth identity + access profile for ${action.account.login_id}`,
    });

    return { setupLink };
  }

  if (action.kind === "create_profile") {
    await upsertProfile(supabase, action.account, action.role, action.hrId, action.account.auth_user_id as string);

    await writeRequiredAuditLog({
      actorLoginId,
      entityId: action.account.login_id,
      entityType: "user",
      newValues: { reason: "Backfilled a missing user_access_profiles row for an existing auth identity.", role: action.role },
      oldValues: { user_access_profiles: null },
      summary: `Backfilled missing access profile for ${action.account.login_id}`,
    });

    return { setupLink: null };
  }

  // sync_profile — the identity and the profile row both already exist; only the fields drifted.
  await upsertProfile(supabase, action.account, action.role, action.hrId, action.account.auth_user_id as string);

  await writeRequiredAuditLog({
    actorLoginId,
    entityId: action.account.login_id,
    entityType: "user",
    newValues: { drift: action.drift, reason: "Synced a stale user_access_profiles row to match the account's current role.", role: action.role },
    oldValues: {
      hr_id: action.profile.hr_id,
      is_active: action.profile.is_active,
      phoenix_role: action.profile.phoenix_role,
      role: action.profile.role,
      scope_type: action.profile.scope_type,
    },
    summary: `Synced stale access profile for ${action.account.login_id}`,
  });

  return { setupLink: null };
}

function summarize(plan: PlannedAction[], skipped: SkippedAccount[]) {
  return {
    accountsNeedingAction: plan.length,
    accountsSkipped: skipped.length,
    byAction: {
      create_profile: plan.filter((action) => action.kind === "create_profile").length,
      provision_identity_and_profile: plan.filter((action) => action.kind === "provision_identity_and_profile").length,
      sync_profile: plan.filter((action) => action.kind === "sync_profile").length,
    },
    skipped,
    targets: plan.map((action) => ({
      action: action.kind,
      hrId: action.hrId,
      isActive: Boolean(action.account.is_active),
      loginId: action.account.login_id,
      role: action.role,
      ...(action.kind === "sync_profile" ? { drift: action.drift } : {}),
    })),
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  assertProductionTarget();
  requiredEnv("SUPABASE_SERVICE_ROLE_KEY");

  const supabase = getSupabaseAdmin({ requestTimeoutMs: 30000 });
  const { plan, skipped } = await buildPlan(supabase);
  const summary = summarize(plan, skipped);

  if (options.mode === "dry-run") {
    console.log(JSON.stringify({
      ...summary,
      mode: "dry-run",
      nextRequiredApproval:
        plan.length === 0
          ? "Nothing to do — every app_auth_users row already has a matching, in-sync user_access_profiles row."
          : `Run with --apply --confirm-production=${plan.length} immediately after this dry-run, after explicit owner ` +
            `approval. The confirm token must equal the CURRENT plan size — if the count has changed by the time you ` +
            `apply, the script refuses to write rather than act on a stale plan.`,
      status: "dry_run_ok",
    }, null, 2));
    return;
  }

  if (plan.length === 0) {
    console.log(JSON.stringify({ ...summary, mode: "apply", results: [], status: "apply_ok_nothing_to_do" }, null, 2));
    return;
  }

  if (options.confirm !== String(plan.length)) {
    throw new Error(
      `Apply requires --confirm-production=${plan.length} (the plan size from THIS run, not an earlier one). ` +
      `Re-run the dry-run immediately before applying.`,
    );
  }

  await assertActorIsValid(supabase);

  const results: Array<{
    action: string;
    hrId: string;
    isActive: boolean;
    loginId: string;
    role: PhoenixRole;
    setupLink: { expiresAt: string; setupUrl: string } | null;
  }> = [];
  for (const action of plan) {
    const outcome = await applyAction(supabase, action);
    results.push({
      action: action.kind,
      hrId: action.hrId,
      isActive: Boolean(action.account.is_active),
      loginId: action.account.login_id,
      role: action.role,
      setupLink: outcome.setupLink,
    });
  }

  console.log(JSON.stringify({ ...summary, mode: "apply", results, status: "apply_ok" }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
