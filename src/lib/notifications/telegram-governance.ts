import { getSupabaseAdmin } from "@/lib/supabase/server";

export type TelegramModulePolicy = {
  enabled: boolean;
  genericOnly: boolean;
  module: string;
  notes: string | null;
  optional: boolean;
};

export type TelegramGovernanceDecision = {
  enabled: boolean;
  genericOnly: boolean;
  globalEnabled: boolean;
  modulePolicy: TelegramModulePolicy;
  reason?: string;
};

const defaultTelegramPolicies: TelegramModulePolicy[] = [
  { enabled: true, genericOnly: true, module: "payroll", notes: "Sensitive payroll Telegram messages must be generic only.", optional: false },
  { enabled: true, genericOnly: true, module: "payslip", notes: "Payslip Telegram messages must only say the payslip is available.", optional: false },
  { enabled: true, genericOnly: true, module: "payslips", notes: "Payslip Telegram messages must only say the payslip is available.", optional: false },
  { enabled: false, genericOnly: false, module: "resignations", notes: "Disabled by default due resignation sensitivity.", optional: false },
  { enabled: true, genericOnly: false, module: "probation", notes: "Allowed only after governed recipient resolution.", optional: false },
  { enabled: true, genericOnly: false, module: "contract_renewal", notes: "Allowed for governed contract renewal recipients.", optional: false },
  { enabled: true, genericOnly: false, module: "contracts", notes: "Allowed for governed contract recipients.", optional: false },
  { enabled: true, genericOnly: false, module: "vacation", notes: "Allowed for direct manager governed vacation workflows.", optional: false },
  { enabled: true, genericOnly: false, module: "leave", notes: "Allowed for governed leave workflows.", optional: false },
  { enabled: true, genericOnly: false, module: "marketing_requests", notes: "Allowed only for assigned approvers/request owners resolved by policy.", optional: false },
  { enabled: true, genericOnly: false, module: "recruitment", notes: "Allowed for governed recruitment notifications.", optional: false },
  { enabled: true, genericOnly: false, module: "internal_messages", notes: "Optional Telegram channel for internal messages.", optional: true },
  { enabled: true, genericOnly: false, module: "system", notes: "Optional Telegram channel for system tests and announcements.", optional: true },
  // Additional modules that emit notifications. Sensitive ones are disabled or
  // generic-only by default so the unknown-module fail-safe never silently leaks them.
  { enabled: false, genericOnly: false, module: "offers", notes: "Disabled by default; offer/candidate data is sensitive.", optional: false },
  { enabled: false, genericOnly: false, module: "deductions", notes: "Disabled by default; payroll-adjacent deduction data is sensitive.", optional: false },
  { enabled: true, genericOnly: true, module: "coaching", notes: "Generic only; coaching feedback is sensitive performance data.", optional: false },
  { enabled: true, genericOnly: true, module: "coaching_report", notes: "Generic only; coaching feedback is sensitive performance data.", optional: false },
  { enabled: true, genericOnly: false, module: "excuses", notes: "Allowed for governed excuse/leave workflows.", optional: false },
  { enabled: true, genericOnly: false, module: "outstation", notes: "Allowed for governed outstation expense workflows.", optional: false },
  { enabled: true, genericOnly: false, module: "weekly_plans", notes: "Allowed for governed weekly plan notifications.", optional: false },
  { enabled: true, genericOnly: false, module: "support_requests", notes: "Allowed so the HR team is alerted when an employee opens a support ticket.", optional: false },
  { enabled: true, genericOnly: false, module: "birthdays", notes: "Non-sensitive celebratory reminders.", optional: true },
  { enabled: true, genericOnly: false, module: "anniversary", notes: "Non-sensitive celebratory reminders.", optional: true },
];

function cleanModule(value: unknown) {
  return String(value ?? "").trim().toLowerCase();
}

function tableMissing(error: unknown) {
  const text = (error instanceof Error ? error.message : `${String(error)} ${JSON.stringify(error)}`).toLowerCase();
  return (
    text.includes("notification_channel_settings") ||
    text.includes("notification_module_channel_policies") ||
    text.includes("schema cache") ||
    text.includes("does not exist") ||
    text.includes("could not find the table")
  );
}

function normalizePolicy(row: Record<string, unknown>): TelegramModulePolicy {
  return {
    enabled: row.enabled !== false,
    genericOnly: row.generic_only === true,
    module: cleanModule(row.module),
    notes: typeof row.notes === "string" ? row.notes : null,
    optional: row.optional === true,
  };
}

export function defaultTelegramModulePolicies() {
  return defaultTelegramPolicies.map((policy) => ({ ...policy }));
}

export function defaultTelegramPolicyFor(moduleName: string): TelegramModulePolicy {
  const moduleKey = cleanModule(moduleName);
  return defaultTelegramPolicies.find((policy) => policy.module === moduleKey) ?? {
    // Fail-safe: a module with no explicit policy is DISABLED for Telegram by default.
    // A future/unlisted module (or a typo'd module name) must never default to
    // "send full content to Telegram" — admins opt it in explicitly.
    enabled: false,
    genericOnly: false,
    module: moduleKey || "unknown",
    notes: "No explicit Telegram policy; disabled by default (fail-safe).",
    optional: false,
  };
}

// ── Governance read cache (mirrors the role-permission-matrix cache in
// src/lib/auth/permissions.ts). Telegram fan-out resolves governance once per
// recipient; without this, the global switch + module policies hit the DB N times
// per notification. Admin writes call clearTelegramGovernanceCache().
const governanceCacheSeconds = Number(process.env.PHOENIX_TELEGRAM_GOVERNANCE_CACHE_SECONDS ?? 30);
const governanceCacheMs = Math.max(5000, Number.isFinite(governanceCacheSeconds) ? governanceCacheSeconds * 1000 : 30000);

type GlobalEnabledCache = { fetchedAt: number; value: boolean };
type PoliciesCache = { fetchedAt: number; value: TelegramModulePolicy[] };
let globalEnabledCache: GlobalEnabledCache | null = null;
let policiesCache: PoliciesCache | null = null;

export function clearTelegramGovernanceCache() {
  globalEnabledCache = null;
  policiesCache = null;
}

async function fetchTelegramGlobalEnabled() {
  try {
    const { data, error } = await getSupabaseAdmin()
      .from("notification_channel_settings")
      .select("enabled_globally")
      .eq("channel", "telegram")
      .maybeSingle();
    if (error) throw error;
    return (data as { enabled_globally?: boolean } | null)?.enabled_globally === true;
  } catch (error) {
    if (tableMissing(error)) return false;
    throw error;
  }
}

export async function getTelegramGlobalEnabled() {
  if (globalEnabledCache && globalEnabledCache.fetchedAt + governanceCacheMs > Date.now()) {
    return globalEnabledCache.value;
  }
  const value = await fetchTelegramGlobalEnabled();
  globalEnabledCache = { fetchedAt: Date.now(), value };
  return value;
}

async function fetchTelegramModulePolicies() {
  const defaults = new Map(defaultTelegramModulePolicies().map((policy) => [policy.module, policy]));
  try {
    const { data, error } = await getSupabaseAdmin()
      .from("notification_module_channel_policies")
      .select("module,enabled,generic_only,optional,notes")
      .eq("channel", "telegram")
      .order("module", { ascending: true });
    if (error) throw error;
    for (const row of (data ?? []) as Record<string, unknown>[]) {
      const policy = normalizePolicy(row);
      if (policy.module) defaults.set(policy.module, policy);
    }
  } catch (error) {
    if (!tableMissing(error)) throw error;
  }
  return Array.from(defaults.values()).sort((left, right) => left.module.localeCompare(right.module));
}

export async function listTelegramModulePolicies() {
  if (policiesCache && policiesCache.fetchedAt + governanceCacheMs > Date.now()) {
    return policiesCache.value.map((policy) => ({ ...policy }));
  }
  const value = await fetchTelegramModulePolicies();
  policiesCache = { fetchedAt: Date.now(), value };
  return value.map((policy) => ({ ...policy }));
}

export async function resolveTelegramGovernance(input: { eventType?: string | null; module: string }): Promise<TelegramGovernanceDecision> {
  const globalEnabled = await getTelegramGlobalEnabled();
  const moduleKey = cleanModule(input.module);
  // Use the cached policy list (single DB round-trip per ~30s) and find this module,
  // instead of a fresh per-module query on every recipient in a fan-out.
  const policies = await listTelegramModulePolicies();
  const modulePolicy = policies.find((policy) => policy.module === moduleKey) ?? defaultTelegramPolicyFor(moduleKey);

  if (!globalEnabled) {
    return {
      enabled: false,
      genericOnly: modulePolicy.genericOnly,
      globalEnabled,
      modulePolicy,
      reason: "Telegram is disabled globally.",
    };
  }

  if (!modulePolicy.enabled) {
    return {
      enabled: false,
      genericOnly: modulePolicy.genericOnly,
      globalEnabled,
      modulePolicy,
      reason: `Telegram is disabled for ${modulePolicy.module}.`,
    };
  }

  return {
    enabled: true,
    genericOnly: modulePolicy.genericOnly,
    globalEnabled,
    modulePolicy,
  };
}

export async function saveTelegramGlobalEnabled(enabled: boolean) {
  const now = new Date().toISOString();
  const { error } = await getSupabaseAdmin()
    .from("notification_channel_settings")
    .upsert({
      channel: "telegram",
      enabled_globally: enabled,
      settings: { phase: "notification_only" },
      updated_at: now,
    }, { onConflict: "channel" });
  if (error) throw error;
  clearTelegramGovernanceCache();
  return enabled;
}

export async function saveTelegramModulePolicy(input: Pick<TelegramModulePolicy, "enabled" | "genericOnly" | "module" | "notes" | "optional">) {
  const moduleKey = cleanModule(input.module);
  if (!moduleKey) throw new Error("Module is required.");
  const { error } = await getSupabaseAdmin()
    .from("notification_module_channel_policies")
    .upsert({
      channel: "telegram",
      enabled: input.enabled,
      generic_only: input.genericOnly,
      module: moduleKey,
      notes: input.notes,
      optional: input.optional,
      updated_at: new Date().toISOString(),
    }, { onConflict: "module,channel" });
  if (error) throw error;
  clearTelegramGovernanceCache();
  return defaultTelegramPolicyFor(moduleKey);
}
