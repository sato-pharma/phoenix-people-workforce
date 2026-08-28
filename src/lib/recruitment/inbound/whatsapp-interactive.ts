// Recruitment / ATS — sending an interactive LIST message over the WhatsApp Cloud API.
//
// This is deliberately separate from `whatsapp-reply.ts`, which sends a TEMPLATE. The two are not
// interchangeable and the difference is the whole reason this feature costs nothing:
//
//   template     — may start a conversation cold, at any time, and is BILLED.
//   interactive  — free-form; may only be sent inside an open 24h customer service window, and is
//                  FREE. Meta: "All non-template messages are free within an open customer service
//                  window", and service conversations have been free for all businesses since
//                  2026-11-01 [sic: 2024-11-01].
//
// Every message this module sends is a direct reply to a CV the applicant just sent us, so the
// window is always open and no message here is ever billable. If the window HAS closed (the
// applicant went quiet for 24h), Meta rejects it with error 131047 and we simply stop — deliberately
// no template fallback, because chasing a silent applicant is the one part of this flow that would
// cost money and the owner's standing rule is not to spend quota on people who did not reply.

import { logWarning } from "@/lib/observability/log";
import type { ClassifyMenu } from "@/lib/recruitment/inbound/whatsapp-classify-menus";
import { menuViolations } from "@/lib/recruitment/inbound/whatsapp-classify-menus";

const DEFAULT_GRAPH_API_VERSION = "v23.0";
const SEND_TIMEOUT_MS = 8_000;

/** Meta's "message outside the 24-hour customer service window" error. Expected, not an incident. */
export const WHATSAPP_WINDOW_CLOSED_CODE = 131047;

function graphApiVersion(): string {
  return process.env.WHATSAPP_GRAPH_API_VERSION?.trim() || DEFAULT_GRAPH_API_VERSION;
}

export type WhatsAppSendResult =
  | { ok: true; wamid: string | null }
  | { ok: false; reason: "disabled" | "invalid_menu" | "window_closed" | "failed"; detail: string | null };

function resolveCredentials(phoneNumberId: string | null): { token: string; phoneNumberId: string } | null {
  const token = process.env.WHATSAPP_ACCESS_TOKEN?.trim();
  // Reply FROM the line the applicant messaged. Once two lines feed one webhook (the coexistence
  // case), replying from the wrong one starts a conversation the applicant never opened.
  const resolved = phoneNumberId?.trim() || process.env.WHATSAPP_PHONE_NUMBER_ID?.trim();
  if (!token || !resolved) return null;
  return { phoneNumberId: resolved, token };
}

async function postToGraph(
  phoneNumberId: string,
  token: string,
  payload: Record<string, unknown>,
  event: string,
): Promise<WhatsAppSendResult> {
  try {
    const response = await fetch(`https://graph.facebook.com/${graphApiVersion()}/${phoneNumberId}/messages`, {
      body: JSON.stringify(payload),
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      method: "POST",
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });

    const body = (await response.json().catch(() => null)) as
      | { messages?: Array<{ id?: string }>; error?: { code?: number; message?: string } }
      | null;

    if (!response.ok) {
      const code = body?.error?.code ?? null;
      const detail = body?.error?.message ?? null;
      if (code === WHATSAPP_WINDOW_CLOSED_CODE) {
        // Not an error worth alarming on: the applicant simply did not answer within 24 hours.
        return { detail, ok: false, reason: "window_closed" };
      }
      logWarning("WhatsApp interactive message failed to send", {
        context: { error: detail, metaErrorCode: code },
        labels: { event, status: response.status },
      });
      return { detail, ok: false, reason: "failed" };
    }

    return { ok: true, wamid: body?.messages?.[0]?.id ?? null };
  } catch (error) {
    logWarning("WhatsApp interactive message threw", { error, labels: { event } });
    return { detail: error instanceof Error ? error.message : null, ok: false, reason: "failed" };
  }
}

/**
 * Sends one menu as an interactive list. NEVER throws — a failed prompt must not affect the CV that
 * was already captured, which is the only thing in this flow that actually matters.
 */
export async function sendClassifyMenu(input: {
  toWaId: string;
  phoneNumberId: string | null;
  menu: ClassifyMenu;
}): Promise<WhatsAppSendResult> {
  const credentials = resolveCredentials(input.phoneNumberId);
  if (!credentials) return { detail: "no token or phone number id", ok: false, reason: "disabled" };

  // Validate before the network call. Meta rejects an over-long row title with a 400 for the whole
  // message, which on the wire is indistinguishable from any other failure — so a menu that has
  // drifted past a limit gets named here instead of vanishing into a generic warning.
  const violations = menuViolations(input.menu);
  if (violations.length > 0) {
    logWarning("WhatsApp classify menu violates a Cloud API limit and was not sent", {
      context: { step: input.menu.step, violations },
      labels: { event: "whatsapp_classify_menu_invalid" },
    });
    return { detail: violations.join("; "), ok: false, reason: "invalid_menu" };
  }

  return postToGraph(
    credentials.phoneNumberId,
    credentials.token,
    {
      interactive: {
        action: {
          button: input.menu.buttonLabel,
          sections: [
            {
              rows: input.menu.rows.map((row) => ({
                description: row.description,
                id: row.id,
                title: row.title,
              })),
              title: input.menu.sectionTitle,
            },
          ],
        },
        body: { text: input.menu.body },
        type: "list",
      },
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: input.toWaId,
      type: "interactive",
    },
    "whatsapp_classify_menu_send",
  );
}

/** Sends a plain text message (the closing confirmation). Same window rules, same free pricing. */
export async function sendWhatsAppText(input: {
  toWaId: string;
  phoneNumberId: string | null;
  text: string;
}): Promise<WhatsAppSendResult> {
  const credentials = resolveCredentials(input.phoneNumberId);
  if (!credentials) return { detail: "no token or phone number id", ok: false, reason: "disabled" };

  return postToGraph(
    credentials.phoneNumberId,
    credentials.token,
    {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      text: { body: input.text, preview_url: false },
      to: input.toWaId,
      type: "text",
    },
    "whatsapp_classify_text_send",
  );
}
