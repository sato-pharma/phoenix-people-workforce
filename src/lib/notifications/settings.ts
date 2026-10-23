import crypto from "crypto";

import { writeAuditLog } from "@/lib/admin/audit";
import type { AccessContext } from "@/lib/auth/permissions";
import { afterResponse } from "@/lib/http/after-response";
import { hrIdLookupKeys } from "@/lib/hr-id";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { deleteOneSignalSubscription, onesignalAppId, onesignalRestApiKey } from "@/lib/notifications/push";
import { TELEGRAM_CONNECT_TOKEN_TTL_MINUTES, buildTelegramDeepLinkFromToken, hashTelegramToken, resolveTelegramBotUsername } from "@/lib/notifications/telegram";
import { withPushOptInNudgeDismissed } from "@/lib/notifications/push-opt-in-nudge-rules";
import { logError } from "@/lib/observability/log";
// Re-exported for existing callers/tests — the rules themselves live in push-opt-in-nudge-rules.ts
// (no server-only imports) so the "use client" nudge card can depend on the RULE without pulling
// this whole server module (getSupabaseAdmin, writeAuditLog, `crypto`) into the browser bundle.
export {
  PUSH_OPT_IN_NUDGE_DISMISSED_KEY,
  isPushOptInNudgeDismissed,
  shouldShowPushOptInNudge,
  withPushOptInNudgeDismissed,
} from "@/lib/notifications/push-opt-in-nudge-rules";

export type NotificationPreferences = {
  emailEnabled: boolean;
  inAppEnabled: boolean;
  modulePreferences: Record<string, unknown>;
  preferredChannel: "in_app" | "email" | "telegram";
  pushEnabled: boolean;
  quietHoursEnd: string | null;
  quietHoursStart: string | null;
  telegramEnabled: boolean;
};

export type PushSubscriptionState = {
  deviceCount: number;
  desktopCount: number;
  mobileCount: number;
};

export type TelegramConnectionState = {
  connectedAt: string | null;
  status: "pending" | "connected" | "disabled" | "failed" | "not_connected";
  telegramUsername: string | null;
};

export type NotificationSettings = {
  preferences: NotificationPreferences;
  push: PushSubscriptionState;
  telegram: TelegramConnectionState;
};

const defaultPreferences: NotificationPreferences = {
  emailEnabled: true,
  inAppEnabled: true,
  modulePreferences: {},
  preferredChannel: "email",
  pushEnabled: true,
  quietHoursEnd: null,
  quietHoursStart: null,
  telegramEnabled: false,
};

const defaultPushState: PushSubscriptionState = { deviceCount: 0, desktopCount: 0, mobileCount: 0 };

function userIdFromAccess(access: Pick<AccessContext, "hrId" | "loginId">) {
  return access.loginId ?? access.hrId ?? "";
}

// Uppercased to match system.ts's cleanHrId() convention (the form used for
// include_aliases.external_id / hasActivePushSubscription's query) — must stay identical to
// what /api/notifications/push/context hands the client for OneSignal.login(), or the stored
// row silently never matches a real send/lookup.
function normalizedPushHrId(hrId: string | null | undefined) {
  const trimmed = hrId ? hrId.trim().toUpperCase() : "";
  return trimmed ? trimmed : null;
}

export type PushSubscriptionSkipReason = "no-user" | "no-subscription-id" | "no-hr-id";

/**
 * Why this caller's browser cannot be recorded in `push_subscriptions`, or null when it can.
 *
 * `no-hr-id` is the one that is easy to get wrong, so it is worth stating plainly: an HR ID is
 * not optional here, it is the ONLY handle a push send has. Every notification targets
 * `include_aliases.external_id` built from it, `hasActivePushSubscription` queries by it, and
 * `push_subscriptions.hr_id` is NOT NULL with no default. So a session with no employee behind
 * it — the `admin-HR` system-administrator console login, which carries `hr_id = NULL` by design
 * and cannot be given one — has nothing storable: the insert is rejected by the schema, and even
 * if it landed the row could never be targeted by anything.
 *
 * Until 2026-08-24 the guard asked only for `loginId ?? hrId`, which such a session satisfies on
 * its login id alone. It then wrote `hr_id: null` and every single page load ended in
 * `23502 null value in column "hr_id" ... violates not-null constraint`, surfacing as a 500 from
 * POST /api/notifications/push/register. Skipping is the honest answer, not a workaround: there
 * is no row this caller could usefully store.
 */
export function pushSubscriptionSkipReason(
  access: Pick<AccessContext, "hrId" | "loginId">,
  onesignalSubscriptionId: string | null | undefined,
): PushSubscriptionSkipReason | null {
  if (!userIdFromAccess(access)) return "no-user";
  if (!onesignalSubscriptionId || !onesignalSubscriptionId.trim()) return "no-subscription-id";
  if (!normalizedPushHrId(access.hrId)) return "no-hr-id";
  return null;
}

function tableMissing(error: unknown) {
  const text = (error instanceof Error ? error.message : `${String(error)} ${JSON.stringify(error)}`).toLowerCase();
  return text.includes("does not exist") || text.includes("schema cache") || text.includes("notification_preferences") || text.includes("telegram_connections");
}

function mapPreferences(row: Record<string, unknown> | null | undefined): NotificationPreferences {
  return {
    emailEnabled: row?.email_enabled !== false,
    inAppEnabled: row?.in_app_enabled !== false,
    modulePreferences: row?.module_preferences && typeof row.module_preferences === "object" && !Array.isArray(row.module_preferences)
      ? row.module_preferences as Record<string, unknown>
      : {},
    preferredChannel: ["in_app", "email", "telegram"].includes(String(row?.preferred_channel))
      ? row?.preferred_channel as NotificationPreferences["preferredChannel"]
      : "email",
    pushEnabled: row?.push_enabled !== false,
    quietHoursEnd: typeof row?.quiet_hours_end === "string" ? row.quiet_hours_end : null,
    quietHoursStart: typeof row?.quiet_hours_start === "string" ? row.quiet_hours_start : null,
    telegramEnabled: row?.telegram_enabled === true,
  };
}

function mapPushState(rows: Array<Record<string, unknown>> | null | undefined): PushSubscriptionState {
  const active = (rows ?? []).filter((row) => row.status === "subscribed");
  return {
    deviceCount: active.length,
    desktopCount: active.filter((row) => row.device_type === "desktop").length,
    mobileCount: active.filter((row) => row.device_type === "mobile").length,
  };
}

function mapTelegram(row: Record<string, unknown> | null | undefined): TelegramConnectionState {
  if (!row) return { connectedAt: null, status: "not_connected", telegramUsername: null };
  const status = ["pending", "connected", "disabled", "failed"].includes(String(row.status))
    ? row.status as TelegramConnectionState["status"]
    : "failed";
  return {
    connectedAt: typeof row.linked_at === "string" ? row.linked_at : null,
    status,
    telegramUsername: typeof row.telegram_username === "string" ? row.telegram_username : null,
  };
}

export async function getNotificationSettings(access: Pick<AccessContext, "hrId" | "loginId">): Promise<NotificationSettings> {
  const userId = userIdFromAccess(access);
  if (!userId) return { preferences: defaultPreferences, push: defaultPushState, telegram: mapTelegram(null) };

  try {
    const supabase = getSupabaseAdmin();
    const [preferences, telegram, push] = await Promise.all([
      supabase.from("notification_preferences").select("*").eq("user_id", userId).maybeSingle(),
      supabase
        .from("telegram_connections")
        .select("*")
        .eq("user_id", userId)
        .order("updated_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
      // Uppercased to match how upsertPushSubscription stores hr_id — see normalizedPushHrId
      // for why the casing must be kept identical everywhere.
      access.hrId
        ? supabase.from("push_subscriptions").select("device_type,status").eq("hr_id", access.hrId.trim().toUpperCase())
        : Promise.resolve({ data: [], error: null }),
    ]);
    if (preferences.error) throw preferences.error;
    if (telegram.error) throw telegram.error;
    if (push.error && !tableMissing(push.error)) throw push.error;
    return {
      preferences: mapPreferences(preferences.data as Record<string, unknown> | null),
      push: mapPushState(push.data as Array<Record<string, unknown>> | null),
      telegram: mapTelegram(telegram.data as Record<string, unknown> | null),
    };
  } catch (error) {
    if (tableMissing(error)) return { preferences: defaultPreferences, push: defaultPushState, telegram: mapTelegram(null) };
    throw error;
  }
}

/**
 * Whether this person's Telegram is connected — the very row `getNotificationSettings` reads for the
 * Notification Settings panel, so a card that asks him to connect and the panel that says "Connected"
 * can never disagree. One narrow read for a page that only needs the yes or no (Phoenix CRM's
 * "Get Phoenix CRM messages on Telegram" card, owner 2026-10-02).
 */
export async function isTelegramConnected(access: Pick<AccessContext, "hrId" | "loginId">): Promise<boolean> {
  const userId = userIdFromAccess(access);
  if (!userId) return false;
  try {
    const { data, error } = await getSupabaseAdmin()
      .from("telegram_connections")
      .select("status")
      .eq("user_id", userId)
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    return mapTelegram(data as Record<string, unknown> | null).status === "connected";
  } catch (error) {
    if (tableMissing(error)) return false;
    throw error;
  }
}

export async function saveNotificationPreferences(
  access: Pick<AccessContext, "hrId" | "loginId">,
  input: Partial<Pick<NotificationPreferences, "emailEnabled" | "inAppEnabled" | "preferredChannel" | "pushEnabled" | "quietHoursEnd" | "quietHoursStart" | "telegramEnabled">>,
) {
  const userId = userIdFromAccess(access);
  if (!userId) throw new Error("Authentication is required.");

  const payload = {
    email_enabled: input.emailEnabled,
    hr_id: access.hrId ?? null,
    in_app_enabled: input.inAppEnabled,
    preferred_channel: input.preferredChannel,
    push_enabled: input.pushEnabled,
    quiet_hours_end: input.quietHoursEnd || null,
    quiet_hours_start: input.quietHoursStart || null,
    telegram_enabled: input.telegramEnabled,
    updated_at: new Date().toISOString(),
    user_id: userId,
  };

  const supabase = getSupabaseAdmin();
  const { error } = await supabase
    .from("notification_preferences")
    .upsert(payload, { onConflict: "user_id" });
  if (error) throw error;

  await writeAuditLog({
    actorLoginId: access.loginId ?? userId,
    entityId: userId,
    entityType: "notification",
    newValues: payload,
    summary: "Notification preferences updated.",
  });

  return getNotificationSettings(access);
}

/**
 * Records that this person dismissed the push opt-in nudge, so it never asks again on any
 * device. Read-modify-write on `module_preferences` — a plain upsert with only this key would
 * overwrite (not merge into) the stored jsonb and could silently erase another feature's
 * preference living in the same column.
 */
export async function dismissPushOptInNudge(access: Pick<AccessContext, "hrId" | "loginId">): Promise<NotificationSettings> {
  const userId = userIdFromAccess(access);
  if (!userId) throw new Error("Authentication is required.");

  const supabase = getSupabaseAdmin();
  const existing = await supabase
    .from("notification_preferences")
    .select("module_preferences")
    .eq("user_id", userId)
    .maybeSingle();
  if (existing.error) throw existing.error;

  const currentModule = (existing.data as { module_preferences?: unknown } | null)?.module_preferences;
  const payload = {
    hr_id: access.hrId ?? null,
    module_preferences: withPushOptInNudgeDismissed(
      currentModule && typeof currentModule === "object" && !Array.isArray(currentModule)
        ? (currentModule as Record<string, unknown>)
        : {},
      new Date().toISOString(),
    ),
    updated_at: new Date().toISOString(),
    user_id: userId,
  };

  const { error } = await supabase.from("notification_preferences").upsert(payload, { onConflict: "user_id" });
  if (error) throw error;

  return getNotificationSettings(access);
}

export async function createTelegramConnectionToken(access: Pick<AccessContext, "hrId" | "loginId">) {
  const userId = userIdFromAccess(access);
  if (!userId) throw new Error("Authentication is required.");

  // Build the connect deep link FIRST. The link is the whole deliverable, and
  // resolveTelegramBotUsername() returns null when the bot is unreachable / the token is
  // missing (it never falls back to the env username for a credential link). Failing here
  // — before writing any DB row — gives the employee a clear, actionable error instead of
  // a silent 200 with a null link, and avoids leaving a dangling pending token row that
  // can never be completed.
  const token = crypto.randomBytes(32).toString("base64url");
  if (!(await resolveTelegramBotUsername())) {
    throw new Error("Telegram bot is temporarily unreachable; cannot create a connect link. Please try again in a moment or contact an administrator.");
  }
  const link = await buildTelegramDeepLinkFromToken(token);
  if (!link) {
    throw new Error("Telegram bot username is not available; cannot create a connect link. Please try again in a moment or contact an administrator.");
  }

  const now = new Date();
  const expires = new Date(now.getTime() + TELEGRAM_CONNECT_TOKEN_TTL_MINUTES * 60 * 1000);
  const supabase = getSupabaseAdmin();
  const existing = await supabase
    .from("telegram_connections")
    .select("id")
    .eq("user_id", userId)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (existing.error) throw existing.error;

  const payload = {
    connect_token_expires_at: expires.toISOString(),
    connect_token_hash: hashTelegramToken(token),
    connect_token_used_at: null,
    disabled_at: null,
    failure_reason: null,
    hr_id: access.hrId ?? null,
    status: "pending",
    telegram_chat_id: null,
    updated_at: now.toISOString(),
    user_id: userId,
  };

  const result = existing.data?.id
    ? await supabase.from("telegram_connections").update(payload).eq("id", existing.data.id)
    : await supabase.from("telegram_connections").insert(payload);
  if (result.error) throw result.error;

  await writeAuditLog({
    actorLoginId: access.loginId ?? userId,
    entityId: userId,
    entityType: "notification",
    summary: "Telegram connection token created.",
  });

  return {
    expiresAt: expires.toISOString(),
    link,
    token,
  };
}

export async function linkTelegramConnection(input: {
  chatId: string;
  telegramUsername?: string | null;
  token: string;
}) {
  const tokenHash = hashTelegramToken(input.token);
  const now = new Date();
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("telegram_connections")
    .select("*")
    .eq("connect_token_hash", tokenHash)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new Error("Telegram connection token is invalid.");
  const row = data as Record<string, unknown>;
  if (row.connect_token_used_at) throw new Error("Telegram connection token was already used.");
  if (row.connect_token_expires_at && new Date(String(row.connect_token_expires_at)).getTime() < now.getTime()) {
    await supabase
      .from("telegram_connections")
      .update({ failure_reason: "Token expired.", status: "failed", updated_at: now.toISOString() })
      .eq("id", row.id);
    throw new Error("Telegram connection token expired.");
  }

  const { error: updateError } = await supabase
    .from("telegram_connections")
    .update({
      // Consume the token: null the hash + expiry so the credential is single-use and
      // not left at rest on the row after linking.
      connect_token_expires_at: null,
      connect_token_hash: null,
      connect_token_used_at: now.toISOString(),
      failure_reason: null,
      linked_at: now.toISOString(),
      status: "connected",
      telegram_chat_id: input.chatId,
      telegram_username: input.telegramUsername ?? null,
      updated_at: now.toISOString(),
    })
    .eq("id", row.id);
  if (updateError) throw updateError;

  await supabase
    .from("notification_preferences")
    .upsert({
      hr_id: row.hr_id ?? null,
      telegram_enabled: true,
      updated_at: now.toISOString(),
      user_id: row.user_id,
    }, { onConflict: "user_id" });

  await writeAuditLog({
    actorLoginId: String(row.user_id ?? "telegram"),
    entityId: String(row.user_id ?? ""),
    entityType: "notification",
    newValues: { telegramUsername: input.telegramUsername ?? null },
    summary: "Telegram linked.",
  });

  // Security alert: tell the employee (in-app + email, NEVER telegram) that their
  // account was just linked, so a leaked-connect-link hijack is detectable. Best-effort
  // — a notification failure must not break linking. After the reply (afterResponse): the link is
  // saved, and the webhook's "connected" answer in Telegram used to wait for this fan-out.
  await afterResponse("telegram_notice:connection_linked", () =>
    notifyTelegramConnectionLinked({
      hrId: row.hr_id ? String(row.hr_id) : null,
      userId: String(row.user_id ?? ""),
    }),
  );

  return { ok: true };
}

async function notifyTelegramConnectionLinked(input: { hrId: string | null; userId: string }) {
  if (!input.userId && !input.hrId) return;
  try {
    // Dynamic import avoids a static cycle between settings.ts and system.ts.
    const { createSystemNotification } = await import("@/lib/notifications/system");
    await createSystemNotification({
      actionUrl: "/employee-portals/profile",
      category: "security",
      channels: ["in_app", "email", "push"],
      eventType: "telegram_connection_linked",
      message:
        "Your Telegram account was just connected to Phoenix Workforce notifications. If this was not you, open your portal Notification Settings and disconnect Telegram immediately, then contact HR.",
      module: "system",
      priority: "high",
      recipientHrId: input.hrId,
      recipientUserId: input.userId || null,
      title: "Telegram connected to your Phoenix account",
    });
  } catch {
    // Alert is best-effort; never block the connection.
  }
}

export async function disconnectTelegram(access: Pick<AccessContext, "hrId" | "loginId">) {
  const userId = userIdFromAccess(access);
  if (!userId) throw new Error("Authentication is required.");
  const now = new Date().toISOString();
  const supabase = getSupabaseAdmin();
  const { error } = await supabase
    .from("telegram_connections")
    .update({
      connect_token_expires_at: null,
      connect_token_hash: null,
      disabled_at: now,
      status: "disabled",
      telegram_chat_id: null,
      updated_at: now,
    })
    .eq("user_id", userId);
  if (error) throw error;

  await supabase
    .from("notification_preferences")
    .upsert({
      hr_id: access.hrId ?? null,
      telegram_enabled: false,
      updated_at: now,
      user_id: userId,
    }, { onConflict: "user_id" });

  await writeAuditLog({
    actorLoginId: access.loginId ?? userId,
    entityId: userId,
    entityType: "notification",
    summary: "Telegram unlinked.",
  });

  return getNotificationSettings(access);
}

export async function disableTelegramForIdentity(input: {
  actorLoginId?: string | null;
  hrId?: string | null;
  reason?: string | null;
  userId?: string | null;
}) {
  const userId = userIdFromAccess({ hrId: input.hrId ?? null, loginId: input.userId ?? null });
  const hrId = input.hrId ?? null;
  if (!userId && !hrId) return { skipped: true as const };

  const now = new Date().toISOString();
  const supabase = getSupabaseAdmin();
  try {
    let query = supabase
      .from("telegram_connections")
      .update({
        connect_token_expires_at: null,
        connect_token_hash: null,
        disabled_at: now,
        failure_reason: input.reason ?? "User or employee was deactivated.",
        status: "disabled",
        telegram_chat_id: null,
        updated_at: now,
      });
    query = userId ? query.eq("user_id", userId) : query.eq("hr_id", hrId);
    const { error } = await query;
    if (error) throw error;

    await supabase
      .from("notification_preferences")
      .upsert({
        hr_id: hrId,
        telegram_enabled: false,
        updated_at: now,
        user_id: userId ?? hrId,
      }, { onConflict: "user_id" });

    await writeAuditLog({
      actorLoginId: input.actorLoginId ?? "system",
      entityId: userId ?? hrId ?? "",
      entityType: "notification",
      summary: "Telegram disabled during deactivation.",
    });

    return { skipped: false as const };
  } catch (error) {
    if (tableMissing(error)) return { reason: "Telegram notification tables unavailable.", skipped: true as const };
    throw error;
  }
}

// Records the current OneSignal Web Push subscription state for one browser/device. Called
// by the client whenever OneSignal reports a subscription change (granted, revoked, or a
// fresh page load reporting its current state) — this is the ONLY way Phoenix learns whether
// a recipient is actually reachable by push, since OneSignal (not Phoenix) owns the
// subscribe/unsubscribe flow. Keyed on the device's own onesignal_subscription_id so a
// recipient can have any number of rows (desktop + mobile + multiple browsers).
export async function upsertPushSubscription(
  access: Pick<AccessContext, "hrId" | "loginId">,
  input: {
    deviceType: "desktop" | "mobile" | "unknown";
    onesignalSubscriptionId: string;
    optedIn: boolean;
    userAgent?: string | null;
  },
): Promise<{ skipped: boolean }> {
  if (pushSubscriptionSkipReason(access, input.onesignalSubscriptionId)) return { skipped: true };

  const userId = userIdFromAccess(access);
  const subscriptionId = input.onesignalSubscriptionId.trim();
  const now = new Date().toISOString();
  const normalizedHrId = normalizedPushHrId(access.hrId);
  const payload: Record<string, unknown> = {
    device_type: input.deviceType,
    hr_id: normalizedHrId,
    last_seen_at: now,
    onesignal_subscription_id: subscriptionId,
    status: input.optedIn ? "subscribed" : "unsubscribed",
    updated_at: now,
    user_agent: input.userAgent ?? null,
    user_id: userId,
  };
  if (input.optedIn) payload.subscribed_at = now;
  else payload.unsubscribed_at = now;

  try {
    const { error } = await getSupabaseAdmin()
      .from("push_subscriptions")
      .upsert(payload, { onConflict: "onesignal_subscription_id" });
    if (error) throw error;
    return { skipped: false };
  } catch (error) {
    if (tableMissing(error)) return { skipped: true };
    throw error;
  }
}

// How the Phoenix app names itself in `push_subscriptions.user_agent` (describeThisDevice in
// mobile/src/lib/push.tsx). A phone browser records `device_type = 'mobile'` too, so this prefix
// is what tells the app's subscription apart from one.
const PHOENIX_APP_DEVICE_PREFIX = "Phoenix Workforce app";

export function isPhoenixAppPushSubscription(row: { device_type?: unknown; user_agent?: unknown }) {
  return row.device_type === "mobile" && String(row.user_agent ?? "").startsWith(PHOENIX_APP_DEVICE_PREFIX);
}

export type PhoneAppPushStopResult = {
  /** App subscriptions OneSignal would not delete. Their rows are left as they were. */
  failed: number;
  /** Phones where the app was receiving Phoenix notifications and no longer is. */
  stopped: number;
};

/**
 * Stops Phoenix notifications in the Phoenix app on every phone this employee has, by deleting
 * each app subscription at OneSignal. Force logout calls it.
 *
 * Revoking the sessions does not do this by itself. To the app, a revoked session looks exactly
 * like one that lapsed, so the app leaves push alone and a lost phone would keep showing this
 * employee's notifications. A deleted subscription stops delivery at once, and the app cannot
 * bring it back without a sign-in: it starts OneSignal only after the server accepts its session.
 * When the employee signs in again, the OneSignal SDK creates a new subscription, the app reports
 * it, and notifications resume.
 *
 * Browsers are left alone, phone browsers included. OneSignal's web SDK re-creates a deleted
 * subscription only when that subscription changes, and signing in again as the same person
 * changes nothing, so a deleted one would stay silent after the person came back.
 *
 * Every app row is deleted whatever its status here; `stopped` counts the ones marked as
 * receiving. A row is marked unsubscribed only once OneSignal confirms, so running this again
 * after a failure retries exactly what is left.
 */
export async function stopPhoneAppPushForEmployee(
  hrId: string,
  client: Pick<ReturnType<typeof getSupabaseAdmin>, "from"> = getSupabaseAdmin(),
): Promise<PhoneAppPushStopResult> {
  const result: PhoneAppPushStopResult = { failed: 0, stopped: 0 };
  const hrIdKeys = hrIdLookupKeys(hrId);
  // Without OneSignal this server sends no push either, so there is nothing to stop.
  if (hrIdKeys.length === 0 || !onesignalAppId() || !onesignalRestApiKey()) return result;

  const { data, error } = await client
    .from("push_subscriptions")
    .select("onesignal_subscription_id,status,device_type,user_agent")
    .in("hr_id", hrIdKeys)
    .eq("device_type", "mobile");
  if (error) {
    if (tableMissing(error)) return result;
    throw new Error(`Could not read the phone push subscriptions: ${error.message}`);
  }

  const receiving = new Map<string, boolean>();
  for (const row of (data ?? []) as Array<Record<string, unknown>>) {
    const subscriptionId = String(row.onesignal_subscription_id ?? "").trim();
    if (!subscriptionId || !isPhoenixAppPushSubscription(row)) continue;
    receiving.set(subscriptionId, receiving.get(subscriptionId) === true || row.status === "subscribed");
  }

  const subscriptionIds = [...receiving.keys()];
  const outcomes = await Promise.allSettled(subscriptionIds.map((subscriptionId) => deleteOneSignalSubscription(subscriptionId)));
  const stoppedIds: string[] = [];
  outcomes.forEach((outcome, index) => {
    if (outcome.status === "rejected") {
      result.failed += 1;
      logError("Phone app push subscription could not be deleted", {
        error: outcome.reason,
        labels: { event: "phone_app_push_stop_failed" },
      });
    } else if (receiving.get(subscriptionIds[index])) {
      stoppedIds.push(subscriptionIds[index]);
    }
  });

  if (stoppedIds.length > 0) {
    const now = new Date().toISOString();
    const { error: updateError } = await client
      .from("push_subscriptions")
      .update({ status: "unsubscribed", unsubscribed_at: now, updated_at: now })
      .in("onesignal_subscription_id", stoppedIds);
    if (updateError) throw new Error(`Phone app push was stopped at OneSignal but not recorded here: ${updateError.message}`);
  }
  result.stopped = stoppedIds.length;
  return result;
}
