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

// Module strings here must match the literal `module` value each domain actually passes to
// createSystemNotification (verified 2026-07-11 by grepping every call site in src/ and
// app/) — not a guessed or pluralized name. Two real bugs from that audit: "birthdays" was
// enabled here but every real send uses singular "birthday", so birthday Telegram messages
// silently never fired; "attendance" and "field_workforce_compliance" had no policy row at
// all despite being live senders, so they fail-closed by the unknown-module safety net below.
const defaultTelegramPolicies: TelegramModulePolicy[] = [
  { enabled: true, genericOnly: true, module: "payroll", notes: "Sensitive payroll Telegram messages must be generic only.", optional: false },
  { enabled: false, genericOnly: false, module: "resignations", notes: "Disabled by default due resignation sensitivity.", optional: false },
  { enabled: true, genericOnly: true, module: "probation", notes: "Generic only; probation carries sensitive HR-decision performance data (names, scores, pass/terminate readiness) — full content stays on in-app + email, matching coaching.", optional: false },
  { enabled: true, genericOnly: false, module: "contract_renewal", notes: "Allowed for governed contract renewal recipients.", optional: false },
  { enabled: true, genericOnly: false, module: "vacation", notes: "Allowed for direct manager governed vacation workflows.", optional: false },
  { enabled: true, genericOnly: false, module: "marketing_requests", notes: "Allowed only for assigned approvers/request owners resolved by policy.", optional: false },
  { enabled: true, genericOnly: false, module: "recruitment", notes: "Allowed for governed recruitment notifications.", optional: false },
  { enabled: true, genericOnly: false, module: "internal_messages", notes: "Optional Telegram channel for internal messages.", optional: true },
  { enabled: true, genericOnly: false, module: "system", notes: "Optional Telegram channel for system tests and announcements.", optional: true },
  // Additional modules that emit notifications. Sensitive ones are disabled or
  // generic-only by default so the unknown-module fail-safe never silently leaks them.
  { enabled: false, genericOnly: false, module: "offers", notes: "Disabled by default; offer/candidate data is sensitive.", optional: false },
  { enabled: true, genericOnly: true, module: "coaching", notes: "Generic only; coaching feedback is sensitive performance data.", optional: false },
  { enabled: true, genericOnly: false, module: "excuse", notes: "Allowed for governed excuse/leave workflows.", optional: false },
  // "excuses" (plural) has no real caller under the current codebase (verified 2026-07-11 —
  // every excuses/service.ts call uses singular "excuse"), but an existing test
  // (tests/excuses.test.ts) explicitly pins this alias as intentional defensive coverage.
  // Kept rather than removed: unlike the other orphans cleaned up in this same audit, this
  // one is a documented, deliberate decision from a prior session, not accidental cruft.
  { enabled: true, genericOnly: false, module: "excuses", notes: "Allowed for governed excuse/leave workflows.", optional: false },
  { enabled: true, genericOnly: false, module: "outstation", notes: "Allowed for governed outstation expense workflows.", optional: false },
  { enabled: true, genericOnly: false, module: "weekly_plans", notes: "Allowed for governed weekly plan notifications.", optional: false },
  { enabled: true, genericOnly: false, module: "support_requests", notes: "Allowed so the HR team is alerted when an employee opens a support ticket.", optional: false },
  { enabled: true, genericOnly: false, module: "business_card_requests", notes: "Allowed so the owner and HR Operations are alerted when an employee requests business cards.", optional: false },
  { enabled: true, genericOnly: false, module: "birthday", notes: "Non-sensitive celebratory reminders. (Real module string is singular; see note above.)", optional: true },
  { enabled: true, genericOnly: false, module: "attendance", notes: "Attendance digest, disputes, and missing-punch workflow alerts.", optional: false },
  { enabled: true, genericOnly: false, module: "field_workforce_compliance", notes: "Monthly field workforce compliance digest to compliance reviewers.", optional: false },
  // direct_orders had no policy entry at all, so every direct-order Telegram message — submitted,
  // approved, held, expired, cancelled — was dropped by the unknown-module fail-safe while
  // service.ts carefully asked for the channel. It bites hardest on cancellation, which drops
  // email ON PURPOSE ("not news worth an inbox entry") on the assumption that in-app AND Telegram
  // still carry it; with Telegram dead the requester was left with the in-app bell alone.
  // Not genericOnly: the pharmacy, product, quantity and value ARE the content an approver acts on,
  // and a generic "you have a notification" ping cannot be approved or rejected.
  { enabled: true, genericOnly: false, module: "direct_orders", notes: "Live sender that had no policy until 2026-09-01; full content so approvers and requesters can act.", optional: false },
  { enabled: false, genericOnly: false, module: "holiday_confirmation", notes: "Disabled by default; low-volume admin confirmation reminder, email is sufficient today.", optional: true },
  // Early Birds is in-app + Telegram ONLY (owner rule 2026-08-09; email is hard-blocked in
  // early-birds-channel-guard.ts). Telegram is therefore not optional garnish here — with email
  // gone it is one of only two ways the recommendation reaches a manager, so leaving this module
  // to the unknown-module fail-safe would silently cut delivery in half.
  // Not genericOnly: the recommendation IS the content. A generic "you have a notification" ping
  // cannot be approved or rejected, which is the entire point of sending it.
  { enabled: true, genericOnly: false, module: "early_birds", notes: "In-app and Telegram only; email is permanently blocked for this module.", optional: false },
  // Weekly attendance review (owner rule 2026-09-17): email, Telegram and in-app — see
  // attendance-digest-channels.ts. Without this row the unknown-module fail-safe drops Telegram. Two
  // notices use it — a week released for an answer, and a dispute decided. Both name only the week or
  // the day, the number of days, the deadline and the outcome, never an amount, so full content is
  // safe to send.
  { enabled: true, genericOnly: false, module: "attendance_digest", notes: "Weekly attendance review release and dispute-decision notices; email, Telegram and in-app.", optional: false },
  // Phoenix CRM (owner rule 2026-09-16): in-app + Telegram only, email hard-blocked in
  // phoenix-crm-channel-guard.ts. Same reasoning as early_birds: without this row the unknown-module
  // fail-safe drops Telegram and a manager in the field is left with the in-app bell alone. Not
  // genericOnly: the customer, the proposed grade or drop reason and the week ARE what a manager
  // decides on; the notices carry no money and no personal data beyond the rep's name.
  { enabled: true, genericOnly: false, module: "phoenix_crm", notes: "Grade and drop requests and weekly plans waiting for the reviewing manager, and their decisions; in-app, Telegram and the phone; NEVER email (owner, 2026-10-13 — ended every earlier email exception).", optional: false },
  // Deductions per-line push (owner rule 2026-09-22): when the Super Admin pushes ONE employee's
  // ONE deduction, the employee gets in-app + Telegram, cc'ing the manager chain — never email
  // (deductions notices carry no email path; see notify-deduction.ts). Not genericOnly, but the
  // notices deliberately carry NO amount and NO category, only "a payroll deduction was recorded
  // for <month>" — so full content is safe on a lock screen. genericOnly would force the shared
  // "Your payslip is available." literal, which is a payslip message, not a deduction one, and
  // would mislead. Without this row the unknown-module fail-safe drops Telegram silently.
  { enabled: true, genericOnly: false, module: "deductions", notes: "Per-line deduction push notice to the employee and their manager chain; in-app and Telegram only, and the message carries no amount and no category.", optional: false },
  // Market Awareness had no row here AND no row in policy.ts — the same two-gate miss this file
  // already records for direct_orders and attendance, and it has to be closed in both places or in
  // neither. policy.ts decides whether Telegram is REQUESTED; this table decides whether it is
  // ALLOWED, and the unknown-module fail-safe below refuses anything not listed. Measured on
  // production 2026-09-28: 10 market_awareness events since 2026-09-07, zero Telegram deliveries,
  // while all four notifiers were passing a `telegram` block on every call.
  // Not genericOnly: the activity, the area, the line and the requested value ARE what an approver
  // decides on, and a generic "you have a notification" ping cannot be approved or rejected — the
  // same reasoning direct_orders carries. These notices hold no salary and no personal data.
  { enabled: true, genericOnly: false, module: "market_awareness", notes: "Awareness activity waiting for a decision, held, returned or approved; full content so the approver and the CEO can act from the message.", optional: false },
  // Monthly Closing published (owner, 2026-10-10): the whole line is told in-app, by Telegram and by one
  // shared email. Without this row the unknown-module fail-safe drops the Telegram message silently —
  // the same miss direct_orders and market_awareness carry above. Not genericOnly: the message names the
  // line and the month and carries no figure.
  { enabled: true, genericOnly: false, module: "sales", notes: "Monthly Closing published to everyone seated on the line; names the line and the month, no sales figure.", optional: false },
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
//
// That clear reaches only the process that saved — the website. The background worker holds its own
// copy and keeps it until the TTL runs out, so a switch-off (global or per module) stops the worker's
// Telegram sends up to PHOENIX_TELEGRAM_GOVERNANCE_CACHE_SECONDS (30 s) later. Accepted on purpose
// (2026-10-26 cache audit, P3): the bound is short, and a cross-process signal would cost more than
// it saves. Lower the env value if a switch-off must bite sooner; the floor is 5 s.
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
