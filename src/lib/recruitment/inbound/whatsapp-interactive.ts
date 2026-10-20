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
import type { OutboundLogContext } from "@/lib/recruitment/inbound/whatsapp-outbound-log";
import { buildOutboundLogRow, recordOutboundMessage } from "@/lib/recruitment/inbound/whatsapp-outbound-log";
import { addressedForGraph } from "@/lib/recruitment/inbound/whatsapp-recipient";
import { recordInboxOutbound, type InboxSendDetail } from "@/lib/whatsapp-inbox/record";

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

/**
 * Sends, then records what was sent. Every outbound WhatsApp message in this codebase funnels
 * through here, so this is the one place an audit row cannot be forgotten.
 *
 * WHY A WRAPPER rather than a log line before each `return`. `sendToGraph` below has four exits —
 * accepted, window closed, rejected, threw — and the failure mode of the obvious implementation is
 * that a fifth gets added later and silently sends a message nobody records. Wrapping makes the
 * audit structural: a new return inside `sendToGraph` is logged whether its author thought about it
 * or not.
 *
 * The audit is awaited, not floated. One insert on a path that runs at most three times per webhook
 * delivery is affordable, and a floating promise here would be a write that sometimes lands, which
 * is worse than no write at all — an audit trail with silent gaps invites exactly the false
 * confidence it exists to prevent.
 */
async function postToGraph(
  phoneNumberId: string,
  token: string,
  payload: Record<string, unknown>,
  event: string,
  context?: OutboundLogContext | null,
): Promise<WhatsAppSendResult> {
  const result = await sendToGraph(phoneNumberId, token, payload, event);

  // `to` is read back off the payload rather than passed separately: both callers set it from the
  // same value, and a second parameter is a second thing that can drift out of step with what was
  // actually addressed. recordOutboundMessage never throws, so nothing below can affect the send.
  await recordOutboundMessage(
    buildOutboundLogRow({
      context,
      event,
      payload,
      phoneNumberId,
      result,
      toWaId: typeof payload.to === "string" ? payload.to : "",
    }),
  );

  // The same send, filed into the WhatsApp Inbox thread for that person, so an automated menu and a
  // human's reply both show where they were said. Never throws either.
  const inboxDetail = context?.detail?.inbox;
  await recordInboxOutbound({
    event,
    inbox: inboxDetail && typeof inboxDetail === "object" ? (inboxDetail as InboxSendDetail) : null,
    payload,
    phoneNumberId,
    result,
  });

  return result;
}

async function sendToGraph(
  phoneNumberId: string,
  token: string,
  payload: Record<string, unknown>,
  event: string,
): Promise<WhatsAppSendResult> {
  try {
    const response = await fetch(`https://graph.facebook.com/${graphApiVersion()}/${phoneNumberId}/messages`, {
      // The audit and the inbox keep the payload as built (`to` = whoever the conversation is keyed
      // on); only the wire copy moves a username's id into `recipient`.
      body: JSON.stringify(addressedForGraph(payload)),
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
  logContext?: OutboundLogContext | null;
}): Promise<WhatsAppSendResult> {
  const credentials = resolveCredentials(input.phoneNumberId);
  // Deliberately NOT audited: the two refusals in this function and the one below happen before any
  // network call, so nothing was sent and there is no sending line to attribute a row to. The
  // outbound log answers "what did we say", not "what did we decline to say" — the caller already
  // sees the reason, and a text-only reply that never went out is reported to a human as
  // "Phoenix did NOT reply". Widening this table into non-sends would make an empty row mean two
  // different things.
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
    input.logContext,
  );
}

/**
 * Sends a plain text message (the closing confirmation). Same window rules, same free pricing.
 *
 * `event` names the row this write leaves in the outbound log, and defaults to the classify
 * confirmation so existing callers are unchanged. A human's own reply passes its own name: the log
 * is read to answer "what did we say to this person", and an answer that cannot tell a recruiter's
 * sentence from an automated one does not answer it.
 */
export async function sendWhatsAppText(input: {
  toWaId: string;
  phoneNumberId: string | null;
  text: string;
  event?: string;
  logContext?: OutboundLogContext | null;
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
    input.event?.trim() || "whatsapp_classify_text_send",
    input.logContext,
  );
}

/**
 * Sends an already-built Cloud API payload — a photo, a file, a template — from the WhatsApp Inbox.
 *
 * Exists so the inbox's sends go through `postToGraph` like every other message and are therefore
 * audited by construction, rather than growing a second Graph client that could forget the log.
 * The caller builds and validates the payload; `messaging_product` and `to` are set here so they
 * cannot be left out.
 */
export async function sendWhatsAppPayload(input: {
  toWaId: string;
  phoneNumberId: string;
  message: Record<string, unknown> & { type: string };
  event: string;
  logContext?: OutboundLogContext | null;
}): Promise<WhatsAppSendResult> {
  const credentials = resolveCredentials(input.phoneNumberId);
  if (!credentials) return { detail: "no token or phone number id", ok: false, reason: "disabled" };

  return postToGraph(
    credentials.phoneNumberId,
    credentials.token,
    {
      ...input.message,
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: input.toWaId,
    },
    input.event,
    input.logContext,
  );
}
