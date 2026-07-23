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
  if (errors && typeof errors === "object") return cleanErrorText(Object.values(errors).flat().join("; ")) ?? `OneSignal request failed with ${status}.`;
  return `OneSignal request failed with ${status}.`;
}

function isNotSubscribedMessage(message: string) {
  return /not subscribed/i.test(message);
}

// Send a web push via OneSignal's REST API, targeting the recipient by External ID (the
// Phoenix HR_ID, set client-side via OneSignal.login()) rather than a stored player/device
// id — OneSignal fans this out to every device (desktop + mobile browser) the recipient has
// ever opted in on, so Phoenix never needs to track individual subscription ids to send.
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
    response = await fetch("https://api.onesignal.com/notifications", {
      body: JSON.stringify({
        app_id: appId,
        contents: { en: message || title },
        headings: { en: title || "Phoenix Workforce" },
        include_aliases: { external_id: [input.externalId.trim()] },
        target_channel: "push",
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

  const payload = await response.json().catch(() => null) as { errors?: unknown; id?: string; recipients?: number } | null;

  if (!response.ok) {
    const message = errorMessageFromPayload(payload, response.status);
    if (isNotSubscribedMessage(message)) return { reason: "No active push subscription for recipient.", skipped: true };
    throw new Error(message);
  }
  if (payload?.errors) {
    const message = errorMessageFromPayload(payload, response.status);
    if (isNotSubscribedMessage(message)) return { reason: "No active push subscription for recipient.", skipped: true };
    throw new Error(message);
  }
  if (typeof payload?.recipients === "number" && payload.recipients === 0) {
    return { reason: "No active push subscription for recipient.", skipped: true };
  }

  return { providerMessageId: payload?.id || undefined };
}
