// Recruitment / ATS — optional applicant acknowledgement over WhatsApp ("we received your CV").
//
// OFF by default and inert until deliberately enabled. Outbound messaging is what drives a WhatsApp
// quality rating and, done wrong, invites a Meta block — the exact failure this whole module is
// hardening against — so this ships dormant behind a flag AND requires a Meta-APPROVED template:
//   RECRUITMENT_WHATSAPP_AUTOREPLY_ENABLED = "true"
//   RECRUITMENT_WHATSAPP_AUTOREPLY_TEMPLATE = "<approved template name>"
//   RECRUITMENT_WHATSAPP_AUTOREPLY_LANG = "<template language code>"   (optional, default "en")
// With any of those unset it is a strict no-op (no network call). A template — not free-form text —
// is used on purpose: it is always policy-compliant, including outside the 24h customer-service
// window, and keeps the quality-rating exposure bounded to content Meta has already approved.

import { logWarning } from "@/lib/observability/log";

const DEFAULT_GRAPH_API_VERSION = "v23.0";

function graphApiVersion(): string {
  return process.env.WHATSAPP_GRAPH_API_VERSION?.trim() || DEFAULT_GRAPH_API_VERSION;
}

export type AutoReplyConfig = { enabled: boolean; templateName: string | null; languageCode: string };

export function autoReplyConfig(): AutoReplyConfig {
  return {
    enabled: String(process.env.RECRUITMENT_WHATSAPP_AUTOREPLY_ENABLED ?? "").trim().toLowerCase() === "true",
    languageCode: process.env.RECRUITMENT_WHATSAPP_AUTOREPLY_LANG?.trim() || "en",
    templateName: process.env.RECRUITMENT_WHATSAPP_AUTOREPLY_TEMPLATE?.trim() || null,
  };
}

/** True only when the flag is on, a template is named, AND a token exists — else auto-reply is inert. */
export function isWhatsAppAutoReplyEnabled(): boolean {
  const cfg = autoReplyConfig();
  return cfg.enabled && Boolean(cfg.templateName) && Boolean(process.env.WHATSAPP_ACCESS_TOKEN?.trim());
}

/**
 * Sends the acknowledgement template to an applicant. Returns true on a sent message, false on a
 * no-op (disabled/misconfigured) or a delivery failure. NEVER throws — an acknowledgement is a
 * nicety and must never affect the CV that was already captured. The reply is sent FROM the line the
 * applicant messaged (phoneNumberId), falling back to WHATSAPP_PHONE_NUMBER_ID.
 */
export async function sendWhatsAppCvAcknowledgement(input: { toWaId: string; phoneNumberId: string | null }): Promise<boolean> {
  const cfg = autoReplyConfig();
  const token = process.env.WHATSAPP_ACCESS_TOKEN?.trim();
  const phoneNumberId = input.phoneNumberId?.trim() || process.env.WHATSAPP_PHONE_NUMBER_ID?.trim();
  if (!cfg.enabled || !cfg.templateName || !token || !phoneNumberId) return false;

  try {
    const response = await fetch(`https://graph.facebook.com/${graphApiVersion()}/${phoneNumberId}/messages`, {
      body: JSON.stringify({
        messaging_product: "whatsapp",
        template: { language: { code: cfg.languageCode }, name: cfg.templateName },
        to: input.toWaId,
        type: "template",
      }),
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      method: "POST",
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as { error?: { message?: string } } | null;
      logWarning("WhatsApp CV acknowledgement failed to send", {
        labels: { event: "whatsapp_autoreply_failed", status: response.status },
        context: { error: body?.error?.message ?? null },
      });
      return false;
    }
    return true;
  } catch (error) {
    logWarning("WhatsApp CV acknowledgement threw", {
      error,
      labels: { event: "whatsapp_autoreply_error" },
    });
    return false;
  }
}
