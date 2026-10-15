import crypto from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import type { SupabaseClient, User } from "@supabase/supabase-js";
import bcrypt from "bcryptjs";

import { writeRequiredAuditLog } from "@/lib/admin/audit";
import {
  canAccess,
  createAccessContext,
  getSalesScope,
  resolveNavigationMode,
} from "@/lib/auth/permissions";
import { resolveLandingPathForRole } from "@/lib/auth/landing";
import {
  buildPhoenixAuthEmail,
  mapPhoenixRoleToAccessScopeType,
  mapPhoenixRoleToCoarseAccessRole,
  provisionSupabaseAuthIdentity,
} from "@/lib/auth/supabase-identity";
import { getSupabaseAdmin } from "@/lib/supabase/server";

import { refuseUnknownFlags } from "./lib/refuse-arguments.mjs";

// A flag this script does not know is refused, never ignored (scripts/lib/refuse-arguments.mjs).
refuseUnknownFlags({
  name: "rebuild-a9-marketing-manager-account",
  entry: import.meta.url,
  known: ["--apply", "--dry-run", "--confirm-production-hard-delete", "--backup"],
});

const targetHrId = "A-9";
const targetRole = "Marketing Manager";
const productionSupabaseRef = "ozucdzovmcqvepbozvqf";
const productionAppUrl = "https://phoenix-hr.satopharma.com";
const outputBase = path.join("outputs", "account-rebuild");
const actorLoginId = process.env.PHOENIX_ACCOUNT_REBUILD_ACTOR ?? "system";
const passwordSetupExpiryMs = 48 * 60 * 60 * 1000;

type AnyRow = Record<string, unknown>;

type ScriptMode = "dry-run" | "apply";

type CliOptions = {
  backup: boolean;
  confirm: string | null;
  mode: ScriptMode;
};

type Snapshot = {
  appAuthUsers: AnyRow[];
  appSessions: AnyRow[];
  auditLogs: AnyRow[];
  authEmail: string;
  authUsers: Array<{
    appMetadata: unknown;
    aud: string;
    createdAt: string | undefined;
    email: string | undefined;
    id: string;
    lastSignInAt: string | undefined;
    userMetadata: unknown;
  }>;
  employees: AnyRow[];
  notificationPreferences: AnyRow[];
  passwordSetupTokens: AnyRow[];
  telegramConnections: AnyRow[];
  userAccessProfiles: AnyRow[];
};

function parseArgs(argv: string[]): CliOptions {
  const hasApply = argv.includes("--apply");
  const hasDryRun = argv.includes("--dry-run");
  if (hasApply && hasDryRun) {
    throw new Error("Choose either --dry-run or --apply, not both.");
  }

  const confirmArg = argv.find((arg) => arg.startsWith("--confirm-production-hard-delete="));
  return {
    backup: argv.includes("--backup") || hasApply,
    confirm: confirmArg?.split("=").slice(1).join("=") ?? null,
    mode: hasApply ? "apply" : "dry-run",
  };
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

function isoStamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function rowId(row: AnyRow) {
  return String(row.id ?? row.auth_user_id ?? row.login_id ?? row.hr_id ?? JSON.stringify(row));
}

function uniqueRows(rows: AnyRow[]) {
  const seen = new Set<string>();
  const unique: AnyRow[] = [];
  for (const row of rows) {
    const key = rowId(row);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(row);
  }
  return unique;
}

function uniqueStrings(values: Array<string | null | undefined>) {
  return Array.from(new Set(values.map((value) => value?.trim()).filter((value): value is string => Boolean(value))));
}

function redactRow(row: AnyRow) {
  const clone: AnyRow = { ...row };
  for (const key of Object.keys(clone)) {
    if (/password|token|secret|hash/i.test(key)) {
      clone[key] = "[redacted]";
    }
  }
  return clone;
}

function hashToken(token: string) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function createToken() {
  return crypto.randomBytes(32).toString("base64url");
}

function createTemporaryAuthPassword() {
  return `Px-${crypto.randomBytes(24).toString("base64url")}!9a`;
}

function sanitizeSnapshot(snapshot: Snapshot): Snapshot {
  return {
    ...snapshot,
    appAuthUsers: snapshot.appAuthUsers.map(redactRow),
    appSessions: snapshot.appSessions.map(redactRow),
    auditLogs: snapshot.auditLogs.map(redactRow),
    notificationPreferences: snapshot.notificationPreferences.map(redactRow),
    passwordSetupTokens: snapshot.passwordSetupTokens.map(redactRow),
    telegramConnections: snapshot.telegramConnections.map(redactRow),
    userAccessProfiles: snapshot.userAccessProfiles.map(redactRow),
  };
}

async function selectEq(supabase: SupabaseClient, table: string, column: string, value: string) {
  const { data, error } = await supabase.from(table).select("*").eq(column, value);
  if (error) throw new Error(`${table}.${column} lookup failed: ${error.message}`);
  return (data ?? []) as AnyRow[];
}

async function selectIn(supabase: SupabaseClient, table: string, column: string, values: string[]) {
  if (values.length === 0) return [];
  const { data, error } = await supabase.from(table).select("*").in(column, values);
  if (error) throw new Error(`${table}.${column} lookup failed: ${error.message}`);
  return (data ?? []) as AnyRow[];
}

async function deleteEq(supabase: SupabaseClient, table: string, column: string, value: string) {
  const { data, error } = await supabase.from(table).delete().eq(column, value).select("*");
  if (error) throw new Error(`${table}.${column} delete failed: ${error.message}`);
  return ((data ?? []) as AnyRow[]).length;
}

async function deleteIn(supabase: SupabaseClient, table: string, column: string, values: string[]) {
  if (values.length === 0) return 0;
  const { data, error } = await supabase.from(table).delete().in(column, values).select("*");
  if (error) throw new Error(`${table}.${column} delete failed: ${error.message}`);
  return ((data ?? []) as AnyRow[]).length;
}

async function findAuthUserById(supabase: SupabaseClient, id: string) {
  const { data, error } = await supabase.auth.admin.getUserById(id);
  if (error || !data.user) return null;
  return data.user;
}

async function findAuthUsersByEmail(supabase: SupabaseClient, email: string) {
  const normalizedEmail = email.trim().toLowerCase();
  const matches: User[] = [];

  for (let page = 1; page <= 20; page += 1) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw error;
    for (const user of data.users) {
      if (user.email?.trim().toLowerCase() === normalizedEmail) matches.push(user);
    }
    if (data.users.length < 1000) break;
    if (page === 20) throw new Error("Auth user scan exceeded 20,000 users; refusing an incomplete search.");
  }

  return matches;
}

async function collectSnapshot(supabase: SupabaseClient): Promise<Snapshot> {
  const authEmail = buildPhoenixAuthEmail(targetHrId);
  const appAuthUsers = uniqueRows([
    ...(await selectEq(supabase, "app_auth_users", "login_id", targetHrId)),
    ...(await selectEq(supabase, "app_auth_users", "hr_id", targetHrId)),
  ]);

  const appAuthUserAuthIds = uniqueStrings(appAuthUsers.map((row) => row.auth_user_id as string | null));
  const authUsersById = (await Promise.all(appAuthUserAuthIds.map((id) => findAuthUserById(supabase, id))))
    .filter((user): user is User => Boolean(user));
  const authUsersByEmail = await findAuthUsersByEmail(supabase, authEmail);
  const authUsers = Array.from(
    new Map([...authUsersById, ...authUsersByEmail].map((user) => [user.id, user])).values(),
  );
  const authUserIds = uniqueStrings(authUsers.map((user) => user.id));
  const profileLookupAuthIds = uniqueStrings([...appAuthUserAuthIds, ...authUserIds]);

  return {
    appAuthUsers,
    appSessions: uniqueRows([
      ...(await selectEq(supabase, "app_sessions", "login_id", targetHrId)),
      ...(await selectEq(supabase, "app_sessions", "hr_id", targetHrId)),
    ]),
    auditLogs: await recentAuditLogs(supabase),
    authEmail,
    authUsers: authUsers.map((user) => ({
      appMetadata: user.app_metadata,
      aud: user.aud,
      createdAt: user.created_at,
      email: user.email,
      id: user.id,
      lastSignInAt: user.last_sign_in_at,
      userMetadata: user.user_metadata,
    })),
    employees: await selectEq(supabase, "employees", "hr_id", targetHrId),
    notificationPreferences: uniqueRows([
      ...(await selectEq(supabase, "notification_preferences", "user_id", targetHrId)),
      ...(await selectEq(supabase, "notification_preferences", "hr_id", targetHrId)),
    ]),
    passwordSetupTokens: await selectEq(supabase, "password_setup_tokens", "login_id", targetHrId),
    telegramConnections: uniqueRows([
      ...(await selectEq(supabase, "telegram_connections", "user_id", targetHrId)),
      ...(await selectEq(supabase, "telegram_connections", "hr_id", targetHrId)),
    ]),
    userAccessProfiles: uniqueRows([
      ...(await selectEq(supabase, "user_access_profiles", "login_id", targetHrId)),
      ...(await selectEq(supabase, "user_access_profiles", "hr_id", targetHrId)),
      ...(await selectIn(supabase, "user_access_profiles", "auth_user_id", profileLookupAuthIds)),
    ]),
  };
}

async function recentAuditLogs(supabase: SupabaseClient) {
  const { data, error } = await supabase
    .from("audit_logs")
    .select("*")
    .eq("entity_id", targetHrId)
    .order("created_at", { ascending: false })
    .limit(50);
  if (error) throw new Error(`audit_logs lookup failed: ${error.message}`);
  return (data ?? []) as AnyRow[];
}

function assertSafeSnapshot(snapshot: Snapshot) {
  const activeEmployees = snapshot.employees.filter((row) => {
    const status = String(row.employment_status ?? "active").trim().toLowerCase();
    return status === "active" || status === "on_leave";
  });

  if (activeEmployees.length !== 1) {
    throw new Error(`Expected exactly one active employees row for ${targetHrId}; found ${activeEmployees.length}.`);
  }

  if (snapshot.appAuthUsers.length > 1) {
    throw new Error(`Unsafe duplicate app_auth_users rows for ${targetHrId}: ${snapshot.appAuthUsers.length}.`);
  }

  const activeProfiles = snapshot.userAccessProfiles.filter((row) => row.is_active !== false);
  if (activeProfiles.length > 1) {
    throw new Error(`Unsafe duplicate active user_access_profiles rows for ${targetHrId}: ${activeProfiles.length}.`);
  }

  if (snapshot.authUsers.length > 1) {
    throw new Error(`Unsafe duplicate Supabase Auth users for ${targetHrId}: ${snapshot.authUsers.length}.`);
  }

  for (const row of [...snapshot.appAuthUsers, ...snapshot.userAccessProfiles]) {
    const hrId = String(row.hr_id ?? targetHrId).trim();
    const loginId = String(row.login_id ?? targetHrId).trim();
    if (hrId && hrId !== targetHrId) throw new Error(`Identity row points to unexpected HR_ID ${hrId}.`);
    if (loginId && loginId !== targetHrId) throw new Error(`Identity row points to unexpected login_id ${loginId}.`);
  }
}

async function writeBackup(snapshot: Snapshot) {
  const dir = path.join(outputBase, `${targetHrId}-${isoStamp()}`);
  await mkdir(dir, { recursive: true });
  const filePath = path.join(dir, "before.json");
  await writeFile(
    filePath,
    JSON.stringify({
      generatedAt: new Date().toISOString(),
      productionRef: productionSupabaseRef,
      snapshot: sanitizeSnapshot(snapshot),
      targetHrId,
      targetRole,
    }, null, 2),
    "utf8",
  );
  return filePath;
}

async function revokeSessions(supabase: SupabaseClient) {
  const now = new Date().toISOString();
  const updates = await Promise.all([
    supabase
      .from("app_sessions")
      .update({ revoked_at: now, revoked_reason: "A-9 Marketing Manager hard identity rebuild" })
      .eq("login_id", targetHrId)
      .is("revoked_at", null)
      .select("id"),
    supabase
      .from("app_sessions")
      .update({ revoked_at: now, revoked_reason: "A-9 Marketing Manager hard identity rebuild" })
      .eq("hr_id", targetHrId)
      .is("revoked_at", null)
      .select("id"),
  ]);

  for (const result of updates) {
    if (result.error) throw new Error(`app_sessions revoke failed: ${result.error.message}`);
  }

  return uniqueRows(updates.flatMap((result) => (result.data ?? []) as AnyRow[])).length;
}

async function invalidatePasswordSetupTokens(supabase: SupabaseClient) {
  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from("password_setup_tokens")
    .update({ updated_at: now, used_at: now })
    .eq("login_id", targetHrId)
    .is("used_at", null)
    .select("id");
  if (error) throw new Error(`password_setup_tokens invalidation failed: ${error.message}`);
  return ((data ?? []) as AnyRow[]).length;
}

async function hardDeleteIdentity(supabase: SupabaseClient, snapshot: Snapshot) {
  const authUserIds = uniqueStrings([
    ...snapshot.authUsers.map((user) => user.id),
    ...snapshot.appAuthUsers.map((row) => row.auth_user_id as string | null),
    ...snapshot.userAccessProfiles.map((row) => row.auth_user_id as string | null),
  ]);

  for (const authUserId of authUserIds) {
    const { error } = await supabase.auth.admin.deleteUser(authUserId);
    if (error && !/user not found/i.test(error.message)) {
      throw new Error(`Supabase Auth delete failed for ${authUserId}: ${error.message}`);
    }
  }

  const deletedProfiles = (
    await Promise.all([
      deleteEq(supabase, "user_access_profiles", "login_id", targetHrId),
      deleteEq(supabase, "user_access_profiles", "hr_id", targetHrId),
      deleteIn(supabase, "user_access_profiles", "auth_user_id", authUserIds),
    ])
  ).reduce((sum, count) => sum + count, 0);

  const deletedAppUsers = (
    await Promise.all([
      deleteEq(supabase, "app_auth_users", "login_id", targetHrId),
      deleteEq(supabase, "app_auth_users", "hr_id", targetHrId),
      deleteIn(supabase, "app_auth_users", "auth_user_id", authUserIds),
    ])
  ).reduce((sum, count) => sum + count, 0);

  return {
    deletedAppUsers,
    deletedAuthUsers: authUserIds.length,
    deletedProfiles,
  };
}

async function resolveLineName(supabase: SupabaseClient, snapshot: Snapshot) {
  const existingLine = snapshot.appAuthUsers.find((row) => typeof row.line === "string")?.line;
  if (typeof existingLine === "string" && existingLine.trim()) return existingLine.trim();

  const employee = snapshot.employees[0];
  const lineId = employee.line_id;
  if (typeof lineId !== "number") return "Other";

  const { data, error } = await supabase
    .from("lines")
    .select("name")
    .eq("id", lineId)
    .maybeSingle();
  if (error) throw new Error(`Line lookup failed for line_id ${lineId}: ${error.message}`);

  const lineName = (data as { name?: string | null } | null)?.name?.trim();
  return lineName || "Other";
}

async function recreateAccount(supabase: SupabaseClient, snapshot: Snapshot) {
  const employee = snapshot.employees[0];
  const line = await resolveLineName(supabase, snapshot);
  const email = typeof employee.work_email === "string" && employee.work_email.trim()
    ? employee.work_email.trim().toLowerCase()
    : null;
  const managerHrId = typeof employee.manager_hr_id === "string" && employee.manager_hr_id.trim()
    ? employee.manager_hr_id.trim()
    : null;
  const name = typeof employee.full_name === "string" && employee.full_name.trim()
    ? employee.full_name.trim()
    : targetHrId;
  const password = createTemporaryAuthPassword();
  const now = new Date().toISOString();
  let authEmail: string | null = null;
  let authUserId: string | null = null;
  const supabaseIdentity = await provisionSupabaseAuthIdentity({
    authUserId: null,
    email,
    hrId: targetHrId,
    isActive: true,
    line,
    loginId: targetHrId,
    managerHrId,
    name,
    password,
    role: targetRole,
  });
  authEmail = supabaseIdentity.authEmail;
  authUserId = supabaseIdentity.authUserId;

  const passwordHash = await bcrypt.hash(password, 12);
  const { error: appUserError } = await supabase
    .from("app_auth_users")
    .upsert({
      auth_email: authEmail,
      auth_user_id: authUserId,
      email,
      force_password_reset: true,
      hr_id: targetHrId,
      is_active: true,
      line,
      login_id: targetHrId,
      manager_hr_id: managerHrId,
      name,
      password_hash: passwordHash,
      role: targetRole,
      sales_scope_override: null,
      session_version: 1,
      updated_at: now,
    }, { onConflict: "login_id" });
  if (appUserError) throw new Error(`app_auth_users recreate failed: ${appUserError.message}`);

  const profilePayload = {
    auth_user_id: authUserId,
    hr_id: targetHrId,
    is_active: true,
    line,
    login_id: targetHrId,
    manager_hr_id: managerHrId,
    phoenix_role: targetRole,
    role: mapPhoenixRoleToCoarseAccessRole(targetRole),
    scope_type: mapPhoenixRoleToAccessScopeType(targetRole),
    updated_at: now,
  };
  const profileWrite = authUserId
    ? supabase.from("user_access_profiles").upsert(profilePayload, { onConflict: "auth_user_id" })
    : supabase.from("user_access_profiles").insert(profilePayload);
  const { error: profileError } = await profileWrite;
  if (profileError) throw new Error(`user_access_profiles recreate failed: ${profileError.message}`);

  await writeRequiredAuditLog({
    actorLoginId,
    entityId: targetHrId,
    entityType: "user",
    newValues: {
      auth_email: authEmail,
      auth_user_id: authUserId,
      email,
      force_password_reset: true,
      hr_id: targetHrId,
      is_active: true,
      line,
      login_id: targetHrId,
      manager_hr_id: managerHrId,
      name,
      password_hash: "[managed]",
      reason: "Production hard-delete/recreate A-9 Marketing Manager account identity.",
      role: targetRole,
      sales_scope_override: null,
      session_version: 1,
    },
    oldValues: null,
    summary: `Created ${targetHrId}`,
  });

  return {
    authBridgeAvailable: Boolean(authUserId),
  };
}

async function createSetupLinkForSecureHandoff(supabase: SupabaseClient) {
  const userRows = await selectEq(supabase, "app_auth_users", "login_id", targetHrId);
  const user = userRows.find((row) => row.is_active === true);
  if (!user) throw new Error(`Active recreated ${targetHrId} app_auth_users row was not found.`);

  const token = createToken();
  const tokenHash = hashToken(token);
  const expiresAt = new Date(Date.now() + passwordSetupExpiryMs).toISOString();
  const setupUrl = `${productionAppUrl}/password-setup/${token}`;
  const now = new Date().toISOString();
  const currentVersion = Number.isFinite(Number(user.session_version)) ? Number(user.session_version) : 1;

  const { error: invalidateError } = await supabase
    .from("password_setup_tokens")
    .update({ updated_at: now, used_at: now })
    .eq("login_id", targetHrId)
    .is("used_at", null);
  if (invalidateError) throw new Error(`Existing setup token invalidation failed: ${invalidateError.message}`);

  const { error: insertError } = await supabase
    .from("password_setup_tokens")
    .insert({
      created_by_login_id: actorLoginId,
      expires_at: expiresAt,
      login_id: targetHrId,
      purpose: "setup",
      sent_to_email: null,
      token_hash: tokenHash,
      updated_at: now,
    });
  if (insertError) throw new Error(`Password setup token insert failed: ${insertError.message}`);

  const { error: updateError } = await supabase
    .from("app_auth_users")
    .update({
      force_password_reset: true,
      session_version: currentVersion + 1,
      updated_at: now,
    })
    .eq("login_id", targetHrId);
  if (updateError) throw new Error(`Password setup account update failed: ${updateError.message}`);

  await writeRequiredAuditLog({
    actorLoginId,
    entityId: targetHrId,
    entityType: "user",
    newValues: {
      action: "password_setup_link_generated",
      delivery: "link_generated_only",
      deliveryMode: "copy",
      expiresAt,
      reason: "A-9 Marketing Manager account hard rebuild.",
      sentTo: null,
      token: "[redacted]",
      url: "[redacted]",
    },
    oldValues: null,
    summary: `Generated setup link for ${targetHrId}`,
  });

  return {
    deliveryMessage: "Password setup link generated for secure manual handoff.",
    deliveryMode: "copy" as const,
    expiresAt,
    fallbackUsed: true,
    loginId: targetHrId,
    setupUrl,
  };
}

async function verifyRecreatedAccount(supabase: SupabaseClient) {
  const appUsers = await selectEq(supabase, "app_auth_users", "login_id", targetHrId);
  const activeAppUsers = appUsers.filter((row) => row.is_active === true);
  if (activeAppUsers.length !== 1) {
    throw new Error(`Expected one active app_auth_users row after rebuild; found ${activeAppUsers.length}.`);
  }

  const profiles = await selectEq(supabase, "user_access_profiles", "login_id", targetHrId);
  const activeProfiles = profiles.filter((row) => row.is_active === true);
  if (activeProfiles.length !== 1) {
    throw new Error(`Expected one active user_access_profiles row after rebuild; found ${activeProfiles.length}.`);
  }

  const authUserId = String(activeAppUsers[0].auth_user_id ?? "");
  let authBridgeAvailable = false;
  if (authUserId) {
    const authUser = await findAuthUserById(supabase, authUserId);
    if (authUser && authUser.app_metadata?.phoenix_role !== targetRole) {
      throw new Error(`Supabase Auth metadata role is ${String(authUser.app_metadata?.phoenix_role)}, not ${targetRole}.`);
    }
    authBridgeAvailable = Boolean(authUser);
  }

  const { data: activeSessions, error: sessionError } = await supabase
    .from("app_sessions")
    .select("id")
    .eq("login_id", targetHrId)
    .is("revoked_at", null);
  if (sessionError) throw new Error(`app_sessions verification failed: ${sessionError.message}`);
  if ((activeSessions ?? []).length > 0) {
    throw new Error(`Expected no active stale app_sessions; found ${(activeSessions ?? []).length}.`);
  }

  const { data: tokens, error: tokenError } = await supabase
    .from("password_setup_tokens")
    .select("id")
    .eq("login_id", targetHrId)
    .is("used_at", null);
  if (tokenError) throw new Error(`password_setup_tokens verification failed: ${tokenError.message}`);
  if ((tokens ?? []).length !== 1) {
    throw new Error(`Expected one unused password setup token; found ${(tokens ?? []).length}.`);
  }

  const access = createAccessContext({ hrId: targetHrId, role: targetRole });
  const accessChecks = {
    coachingRead: await canAccess(access, "coaching", "read"),
    doubleVisitRead: await canAccess(access, "double_visit_analytics", "read"),
    landingPath: resolveLandingPathForRole(targetRole),
    navigationMode: resolveNavigationMode(access),
    salesRead: await canAccess(access, "sales", "read"),
    salesScope: getSalesScope(access),
    weeklySalesRead: await canAccess(access, "weekly_sales", "read"),
  };

  if (
    accessChecks.navigationMode !== "employee-portal" ||
    accessChecks.landingPath !== "/employee-portals" ||
    accessChecks.salesScope !== "COMPANY" ||
    !accessChecks.salesRead ||
    !accessChecks.weeklySalesRead ||
    !accessChecks.coachingRead ||
    !accessChecks.doubleVisitRead
  ) {
    throw new Error(`Marketing Manager permission verification failed: ${JSON.stringify(accessChecks)}`);
  }

  return {
    accessChecks,
    appAuthUsers: activeAppUsers.length,
    authBridgeAvailable,
    authUserId: authUserId || null,
    passwordSetupTokens: (tokens ?? []).length,
    userAccessProfiles: activeProfiles.length,
  };
}

function summarize(snapshot: Snapshot) {
  return {
    appAuthUsers: snapshot.appAuthUsers.length,
    appSessions: snapshot.appSessions.length,
    auditLogs: snapshot.auditLogs.length,
    authEmail: snapshot.authEmail,
    authUsers: snapshot.authUsers.length,
    employees: snapshot.employees.length,
    notificationPreferences: snapshot.notificationPreferences.length,
    passwordSetupTokens: snapshot.passwordSetupTokens.length,
    telegramConnections: snapshot.telegramConnections.length,
    userAccessProfiles: snapshot.userAccessProfiles.length,
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  assertProductionTarget();
  requiredEnv("SUPABASE_SERVICE_ROLE_KEY");

  if (options.mode === "apply" && options.confirm !== targetHrId) {
    throw new Error(`Apply requires --confirm-production-hard-delete=${targetHrId}.`);
  }

  const supabase = getSupabaseAdmin({ requestTimeoutMs: 30000 });
  const snapshot = await collectSnapshot(supabase);
  assertSafeSnapshot(snapshot);
  const backupPath = options.backup ? await writeBackup(snapshot) : null;

  const baseSummary = {
    backupPath,
    mode: options.mode,
    plan: {
      deleteOnlyIdentityTables: ["app_sessions revoke", "password_setup_tokens invalidate", "user_access_profiles", "app_auth_users", "Supabase Auth user"],
      preserveBusinessTables: ["employees", "sales", "coaching", "marketing requests", "reports"],
      recreateAs: { hrId: targetHrId, loginId: targetHrId, role: targetRole },
    },
    snapshot: summarize(snapshot),
    targetHrId,
    targetRole,
  };

  if (options.mode === "dry-run") {
    console.log(JSON.stringify({
      ...baseSummary,
      nextRequiredApproval: `Run with --apply --confirm-production-hard-delete=${targetHrId} after explicit owner approval.`,
      status: "dry_run_ok",
    }, null, 2));
    return;
  }

  await writeRequiredAuditLog({
    actorLoginId,
    entityId: targetHrId,
    entityType: "user",
    newValues: {
      action: "production_hard_identity_rebuild_started",
      backupPath,
      snapshot: summarize(snapshot),
    },
    oldValues: sanitizeSnapshot(snapshot) as unknown as Record<string, unknown>,
    summary: "Started production hard identity rebuild for A-9 Marketing Manager",
  });

  const revokedSessions = await revokeSessions(supabase);
  const invalidatedTokens = await invalidatePasswordSetupTokens(supabase);
  const deleteSummary = await hardDeleteIdentity(supabase, snapshot);
  const recreateSummary = await recreateAccount(supabase, snapshot);
  const setupLink = await createSetupLinkForSecureHandoff(supabase);
  const verification = await verifyRecreatedAccount(supabase);

  await writeRequiredAuditLog({
    actorLoginId,
    entityId: targetHrId,
    entityType: "user",
    newValues: {
      action: "production_hard_identity_rebuild_completed",
      deleteSummary,
      invalidatedTokens,
      recreateSummary,
      revokedSessions,
      setupLinkDelivery: {
        deliveryMode: setupLink.deliveryMode,
        expiresAt: setupLink.expiresAt,
        fallbackUsed: setupLink.fallbackUsed,
        hasCopyUrl: Boolean(setupLink.setupUrl),
        message: setupLink.deliveryMessage,
      },
      verification,
    },
    oldValues: null,
    summary: "Completed production hard identity rebuild for A-9 Marketing Manager",
  });

  console.log(JSON.stringify({
    ...baseSummary,
    deleteSummary,
    invalidatedTokens,
    recreateSummary,
    revokedSessions,
    setupLink: {
      deliveryMode: setupLink.deliveryMode,
      deliveryMessage: setupLink.deliveryMessage,
      expiresAt: setupLink.expiresAt,
      fallbackUsed: setupLink.fallbackUsed,
      setupUrl: setupLink.setupUrl ?? undefined,
    },
    status: "apply_ok",
    verification,
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
