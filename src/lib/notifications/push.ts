export type PushSendInput = {
  actionUrl?: string | null;
  externalId: string;
  message: string;
  title: string;
};

export type PushSendResult =
  | { providerMessageId?: string; skipped?: false }
  | { reason: string; skipped: true };

export type OneSignalEnvironmentStatus = {
  onesignalAppId: boolean;
  onesignalRestApiKey: boolean;
};

// NEXT_PUBLIC_ONESIGNAL_APP_ID is not a secret (OneSignal's own Web SDK ships it to every
// browser) so the server send path reuses the same public env var instead of needing a
// second server-only copy kept in sync with it.
export function onesignalAppId() {
  return process.env.NEXT_PUBLIC_ONESIGNAL_APP_ID?.trim() || null;
}

export function onesignalRestApiKey() {
  return process.env.ONESIGNAL_REST_API_KEY?.trim() || null;
}

function onesignalTimeoutMs() {
  const value = Number.parseInt(process.env.ONESIGNAL_SEND_TIMEOUT_MS ?? "8000", 10);
  return Number.isFinite(value) && value > 0 ? value : 8000;
}

export function onesignalEnvironmentStatus(): OneSignalEnvironmentStatus {
  return {
    onesignalAppId: Boolean(onesignalAppId()),
    onesignalRestApiKey: Boolean(onesignalRestApiKey()),
  };
}

function cleanPushText(value: string) {
  return value.replace(/\s+/g, " ").trim().slice(0, 900);
}

function cleanErrorText(value: unknown) {
  return String(value ?? "")
    .replace(/[<>]/g, "")
    .trim()
    .slice(0, 300) || null;
}

function errorMessageFromPayload(payload: { errors?: unknown } | null, status: number) {
  const errors = payload?.errors;
  if (Array.isArray(errors)) return cleanErrorText(errors.join("; ")) ?? `OneSignal request failed with ${status}.`;
  if (errors && typeof errors === "object") {
    // Object.values(...).flat().join(...) previously produced the literal string
    // "[object Object]" for nested error shapes like { invalid_aliases: { external_id: [...] } }
    // — this walks one level of nesting so a genuine error still logs something readable.
    const flattened = Object.entries(errors)
      .map(([key, value]) => `${key}: ${Array.isArray(value) ? value.join(",") : typeof value === "object" ? JSON.stringify(value) : String(value)}`)
      .join("; ");
    return cleanErrorText(flattened) ?? `OneSignal request failed with ${status}.`;
  }
  return `OneSignal request failed with ${status}.`;
}

function isNotSubscribedMessage(message: string) {
  return /not subscribed/i.test(message);
}

// A recipient with zero reachable devices returns HTTP 200 with an `errors` array like
// ["All included players are not subscribed"] — a normal "not subscribed yet" outcome,
// not a failure. Checked before the generic error branch, or it gets misclassified as a
// hard failure.
function isNotSubscribedPayload(payload: { errors?: unknown } | null) {
  if (!payload) return false;
  const errors = payload.errors;
  if (Array.isArray(errors) && errors.some((entry) => isNotSubscribedMessage(String(entry)))) return true;
  return false;
}

// Send a web push via OneSignal's REST API, targeting the recipient by External ID (the
// Phoenix HR_ID, set client-side via OneSignal.login()) rather than a stored player/device
// id — OneSignal fans this out to every device (desktop + mobile browser) the recipient has
// ever opted in on, so Phoenix never needs to track individual subscription ids to send.
//
// Uses the legacy /api/v1/notifications endpoint (include_external_user_ids) rather than
// the newer api.onesignal.com/notifications alias-based endpoint (include_aliases). Verified
// live against production 2026-07-23: for a recipient whose OneSignal history mixes
// subscribed and unsubscribed devices (e.g. re-enabled push after a prior failed browser
// registration — an expected, common pattern given the AbortError issue some browsers hit),
// the alias-based endpoint spuriously reports the whole alias as `invalid_aliases` and
// delivers nothing, even though the still-subscribed devices are perfectly reachable. The
// legacy endpoint delivered correctly to those same devices in the same test. Do not switch
// back to include_aliases without re-confirming that quirk is gone.
export async function sendPushNotification(input: PushSendInput): Promise<PushSendResult> {
  const appId = onesignalAppId();
  const apiKey = onesignalRestApiKey();
  if (!appId || !apiKey) return { reason: "OneSignal is not configured.", skipped: true };
  if (!input.externalId.trim()) return { reason: "Push external id is missing.", skipped: true };

  const title = cleanPushText(input.title);
  const message = cleanPushText(input.message);
  if (!title && !message) return { reason: "Push message is empty.", skipped: true };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), onesignalTimeoutMs());
  let response: Response;
  try {
    response = await fetch("https://onesignal.com/api/v1/notifications", {
      body: JSON.stringify({
        app_id: appId,
        channel_for_external_user_ids: "push",
        contents: { en: message || title },
        headings: { en: title || "Phoenix Workforce" },
        include_external_user_ids: [input.externalId.trim()],
        ...(input.actionUrl ? { url: input.actionUrl } : {}),
      }),
      headers: {
        "Authorization": `Key ${apiKey}`,
        "Content-Type": "application/json",
      },
      method: "POST",
      signal: controller.signal,
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error("OneSignal request timed out.");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }

  const payload = await response.json().catch(() => null) as { errors?: unknown; id?: string } | null;

  if (isNotSubscribedPayload(payload)) {
    return { reason: "No active push subscription for recipient.", skipped: true };
  }
  if (!response.ok || payload?.errors) {
    throw new Error(errorMessageFromPayload(payload, response.status));
  }

  return { providerMessageId: payload?.id || undefined };
}
