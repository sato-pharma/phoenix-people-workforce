// =============================================================================
// Provision a login account for an active employee who never got one
// =============================================================================
// WHY THIS EXISTS: employee creation auto-provisions an app_auth_users row via
// provisionNewHireAccess(), but only on the "manual employee add" route
// (app/api/employees/route.ts). An employee created through any other path —
// notably the vacancy/onboarding flow — lands in `employees` with no login at
// all, and nothing reports the gap. AI-0005 and AI-0006 (created 2026-08-01)
// were both found in that state: active Medical Representatives who could not
// sign in.
//
// This is the CREATE-ONLY sibling of scripts/rebuild-a9-marketing-manager-account.ts.
// It refuses to touch an HR_ID that already has an app_auth_users row, so it can
// never overwrite a working account or reset someone's password by accident.
//
// Usage (dry-run prints the plan and writes nothing):
//   pnpm run ops:provision-accounts -- --hr-ids=AI-0005,AI-0006 --role="Medical Rep"
//   pnpm run ops:provision-accounts -- --hr-ids=AI-0005,AI-0006 --role="Medical Rep" --apply --confirm-production=AI-0005,AI-0006
//
// Each provisioned account gets a one-time password-setup link (48h). The temporary
// password is never printed — the setup URL is the only handoff channel.
// =============================================================================

import crypto from "node:crypto";

import type { SupabaseClient } from "@supabase/supabase-js";
import bcrypt from "bcryptjs";

import { writeRequiredAuditLog } from "@/lib/admin/audit";
import { phoenixRoles, type PhoenixRole } from "@/lib/auth/permissions";
import {
  mapPhoenixRoleToAccessScopeType,
  mapPhoenixRoleToCoarseAccessRole,
  provisionSupabaseAuthIdentity,
} from "@/lib/auth/supabase-identity";
import { getSupabaseAdmin } from "@/lib/supabase/server";

import { refuseUnknownFlags } from "./lib/refuse-arguments.mjs";

// A flag this script does not know is refused, never ignored (scripts/lib/refuse-arguments.mjs).
refuseUnknownFlags({
  name: "provision-missing-employee-accounts",
  entry: import.meta.url,
  known: ["--apply", "--dry-run", "--hr-ids", "--role", "--confirm-production"],
});

const productionSupabaseRef = "ozucdzovmcqvepbozvqf";
const productionAppUrl = "https://phoenix-hr.satopharma.com";
const actorLoginId = process.env.PHOENIX_ACCOUNT_PROVISION_ACTOR ?? "system";
const passwordSetupExpiryMs = 48 * 60 * 60 * 1000;

type AnyRow = Record<string, unknown>;
type ScriptMode = "dry-run" | "apply";

type CliOptions = {
  confirm: string | null;
  hrIds: string[];
  mode: ScriptMode;
  role: PhoenixRole;
};

function parseArgs(argv: string[]): CliOptions {
  const hasApply = argv.includes("--apply");
  const hasDryRun = argv.includes("--dry-run");
  if (hasApply && hasDryRun) throw new Error("Choose either --dry-run or --apply, not both.");

  const readValue = (prefix: string) =>
    argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length).trim() ?? null;

  const hrIdsRaw = readValue("--hr-ids=");
  if (!hrIdsRaw) throw new Error("--hr-ids=<HR_ID[,HR_ID...]> is required.");
  const hrIds = Array.from(
    new Set(hrIdsRaw.split(",").map((value) => value.trim().toUpperCase()).filter(Boolean)),
  );
  if (hrIds.length === 0) throw new Error("--hr-ids resolved to an empty list.");

  const roleRaw = readValue("--role=");
  if (!roleRaw) throw new Error('--role="<Phoenix role>" is required.');
  const role = phoenixRoles.find((candidate) => candidate.toLowerCase() === roleRaw.toLowerCase());
  if (!role) throw new Error(`Unknown role "${roleRaw}". Valid: ${phoenixRoles.join(", ")}`);

  return { confirm: readValue("--confirm-production="), hrIds, mode: hasApply ? "apply" : "dry-run", role };
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

async function selectEq(supabase: SupabaseClient, table: string, column: string, value: string) {
  const { data, error } = await supabase.from(table).select("*").eq(column, value);
  if (error) throw new Error(`${table}.${column} lookup failed: ${error.message}`);
  return (data ?? []) as AnyRow[];
}

async function resolveLineName(supabase: SupabaseClient, lineId: unknown) {
  if (typeof lineId !== "number") return "Other";
  const { data, error } = await supabase.from("lines").select("name").eq("id", lineId).maybeSingle();
  if (error) throw new Error(`Line lookup failed for line_id ${lineId}: ${error.message}`);
  return text((data as { name?: string | null } | null)?.name) ?? "Other";
}

/**
 * `created_by_login_id` on password_setup_tokens is a FK to app_auth_users.login_id.
 * Validate it BEFORE any write — otherwise a bad actor value creates the account and
 * only then fails on the token, leaving a real account with no way to set a password.
 * (That is exactly what happened to AI-0005 on the first run, with actor "system".)
 */
async function assertActorIsValid(supabase: SupabaseClient) {
  const rows = await selectEq(supabase, "app_auth_users", "login_id", actorLoginId);
  if (rows.length !== 1) {
    throw new Error(
      `Actor "${actorLoginId}" is not an app_auth_users.login_id, so password_setup_tokens would ` +
      `violate its foreign key. Set PHOENIX_ACCOUNT_PROVISION_ACTOR to a real admin login ID.`,
    );
  }
}

/**
 * Read the employee and decide what this HR_ID still needs.
 *   "create"    — no account yet: provision identity, account, profile, then a setup link.
 *   "link-only" — account already exists but has no usable setup link: only mint the link.
 * Never rewrites a working account, and never resets a password that someone may already use.
 */
async function inspectTarget(supabase: SupabaseClient, hrId: string) {
  const employees = await selectEq(supabase, "employees", "hr_id", hrId);
  if (employees.length !== 1) {
    throw new Error(`Expected exactly one employees row for ${hrId}; found ${employees.length}.`);
  }

  const employee = employees[0];
  const status = String(employee.employment_status ?? "active").trim().toLowerCase();
  if (status !== "active" && status !== "on_leave") {
    throw new Error(`${hrId} is ${status}; refusing to provision a login for a non-active employee.`);
  }

  // An account normally matches BOTH lookups (login_id == hr_id), so dedupe by
  // login_id before counting — otherwise one healthy row reads as a duplicate.
  const existing = Array.from(
    new Map(
      [
        ...(await selectEq(supabase, "app_auth_users", "login_id", hrId)),
        ...(await selectEq(supabase, "app_auth_users", "hr_id", hrId)),
      ].map((row) => [String(row.login_id ?? ""), row]),
    ).values(),
  );

  let action: "create" | "link-only" = "create";
  if (existing.length > 1) {
    throw new Error(`Unsafe duplicate app_auth_users rows for ${hrId}: ${existing.length}.`);
  }
  if (existing.length === 1) {
    const unusedTokens = (await selectEq(supabase, "password_setup_tokens", "login_id", hrId))
      .filter((row) => !row.used_at);
    if (unusedTokens.length > 0) {
      throw new Error(`${hrId} already has an account and a pending setup link. Nothing to do.`);
    }
    if (existing[0].is_active !== true) {
      throw new Error(`${hrId} has an INACTIVE account; reactivate it deliberately rather than here.`);
    }
    action = "link-only";
  }

  return {
    action,
    email: text(employee.work_email)?.toLowerCase() ?? null,
    hrId,
    jobTitle: text(employee.job_title),
    line: await resolveLineName(supabase, employee.line_id),
    managerHrId: text(employee.manager_hr_id),
    name: text(employee.full_name) ?? hrId,
  };
}

type Target = Awaited<ReturnType<typeof inspectTarget>>;

async function createAccount(supabase: SupabaseClient, target: Target, role: PhoenixRole) {
  const password = createTemporaryAuthPassword();
  const now = new Date().toISOString();

  const identity = await provisionSupabaseAuthIdentity({
    authUserId: null,
    email: target.email,
    hrId: target.hrId,
    isActive: true,
    line: target.line,
    loginId: target.hrId,
    managerHrId: target.managerHrId,
    name: target.name,
    password,
    role,
  });

  const { error: appUserError } = await supabase.from("app_auth_users").insert({
    auth_email: identity.authEmail,
    auth_user_id: identity.authUserId,
    email: target.email,
    force_password_reset: true,
    hr_id: target.hrId,
    is_active: true,
    line: target.line,
    login_id: target.hrId,
    manager_hr_id: target.managerHrId,
    name: target.name,
    password_hash: await bcrypt.hash(password, 12),
    role,
    sales_scope_override: null,
    session_version: 1,
    updated_at: now,
  });
  if (appUserError) throw new Error(`app_auth_users insert failed for ${target.hrId}: ${appUserError.message}`);

  const profilePayload = {
    auth_user_id: identity.authUserId,
    hr_id: target.hrId,
    is_active: true,
    line: target.line,
    login_id: target.hrId,
    manager_hr_id: target.managerHrId,
    phoenix_role: role,
    role: mapPhoenixRoleToCoarseAccessRole(role),
    scope_type: mapPhoenixRoleToAccessScopeType(role),
    updated_at: now,
  };
  const { error: profileError } = identity.authUserId
    ? await supabase.from("user_access_profiles").upsert(profilePayload, { onConflict: "auth_user_id" })
    : await supabase.from("user_access_profiles").insert(profilePayload);
  if (profileError) {
    throw new Error(`user_access_profiles insert failed for ${target.hrId}: ${profileError.message}`);
  }

  await writeRequiredAuditLog({
    actorLoginId,
    entityId: target.hrId,
    entityType: "user",
    newValues: {
      auth_email: identity.authEmail,
      auth_user_id: identity.authUserId,
      email: target.email,
      hr_id: target.hrId,
      is_active: true,
      line: target.line,
      login_id: target.hrId,
      manager_hr_id: target.managerHrId,
      name: target.name,
      password_hash: "[managed]",
      reason: "Provisioned a missing login for an active employee created outside the manual-add route.",
      role,
    },
    oldValues: null,
    summary: `Created missing login account ${target.hrId}`,
  });

  return { authBridgeAvailable: Boolean(identity.authUserId), authUserId: identity.authUserId };
}

async function createSetupLink(supabase: SupabaseClient, hrId: string) {
  const token = createToken();
  const expiresAt = new Date(Date.now() + passwordSetupExpiryMs).toISOString();
  const now = new Date().toISOString();

  const { error: insertError } = await supabase.from("password_setup_tokens").insert({
    created_by_login_id: actorLoginId,
    expires_at: expiresAt,
    login_id: hrId,
    purpose: "setup",
    sent_to_email: null,
    token_hash: hashToken(token),
    updated_at: now,
  });
  if (insertError) throw new Error(`password_setup_tokens insert failed for ${hrId}: ${insertError.message}`);

  await writeRequiredAuditLog({
    actorLoginId,
    entityId: hrId,
    entityType: "user",
    newValues: {
      action: "password_setup_link_generated",
      delivery: "link_generated_only",
      expiresAt,
      reason: "Initial setup link for a newly provisioned account.",
      token: "[redacted]",
      url: "[redacted]",
    },
    oldValues: null,
    summary: `Generated setup link for ${hrId}`,
  });

  return { expiresAt, setupUrl: `${productionAppUrl}/password-setup/${token}` };
}

async function verifyAccount(supabase: SupabaseClient, hrId: string, role: PhoenixRole) {
  const appUsers = (await selectEq(supabase, "app_auth_users", "login_id", hrId)).filter(
    (row) => row.is_active === true,
  );
  if (appUsers.length !== 1) {
    throw new Error(`Expected one active app_auth_users row for ${hrId}; found ${appUsers.length}.`);
  }
  if (String(appUsers[0].role) !== role) {
    throw new Error(`${hrId} role is ${String(appUsers[0].role)}, expected ${role}.`);
  }

  const profiles = (await selectEq(supabase, "user_access_profiles", "login_id", hrId)).filter(
    (row) => row.is_active === true,
  );
  if (profiles.length !== 1) {
    throw new Error(`Expected one active user_access_profiles row for ${hrId}; found ${profiles.length}.`);
  }

  const { data: tokens, error: tokenError } = await supabase
    .from("password_setup_tokens")
    .select("id")
    .eq("login_id", hrId)
    .is("used_at", null);
  if (tokenError) throw new Error(`password_setup_tokens verification failed: ${tokenError.message}`);
  if ((tokens ?? []).length !== 1) {
    throw new Error(`Expected one unused setup token for ${hrId}; found ${(tokens ?? []).length}.`);
  }

  return {
    authUserId: text(appUsers[0].auth_user_id),
    hasPasswordHash: Boolean(appUsers[0].password_hash),
    role: String(appUsers[0].role),
    scopeType: String(profiles[0].scope_type),
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  assertProductionTarget();
  requiredEnv("SUPABASE_SERVICE_ROLE_KEY");

  const supabase = getSupabaseAdmin({ requestTimeoutMs: 30000 });
  await assertActorIsValid(supabase);
  const targets: Target[] = [];
  for (const hrId of options.hrIds) {
    targets.push(await inspectTarget(supabase, hrId));
  }

  const plan = {
    actorLoginId,
    mode: options.mode,
    role: options.role,
    targets: targets.map((target) => ({
      action: target.action,
      email: target.email,
      hrId: target.hrId,
      jobTitle: target.jobTitle,
      line: target.line,
      managerHrId: target.managerHrId,
      name: target.name,
    })),
  };

  if (options.mode === "dry-run") {
    console.log(JSON.stringify({
      ...plan,
      nextRequiredApproval:
        `Run with --apply --confirm-production=${options.hrIds.join(",")} after explicit owner approval.`,
      status: "dry_run_ok",
    }, null, 2));
    return;
  }

  if (options.confirm !== options.hrIds.join(",")) {
    throw new Error(`Apply requires --confirm-production=${options.hrIds.join(",")}.`);
  }

  const results = [];
  for (const target of targets) {
    const created = target.action === "create"
      ? await createAccount(supabase, target, options.role)
      : { authBridgeAvailable: true };
    const setupLink = await createSetupLink(supabase, target.hrId);
    const verification = await verifyAccount(supabase, target.hrId, options.role);
    results.push({
      action: target.action,
      authBridgeAvailable: created.authBridgeAvailable,
      hrId: target.hrId,
      loginId: target.hrId,
      name: target.name,
      setupLink,
      verification,
    });
  }

  console.log(JSON.stringify({ ...plan, results, status: "apply_ok" }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
