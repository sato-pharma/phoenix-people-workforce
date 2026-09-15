// The WhatsApp Inbox — reading a webhook delivery into inbox rows. Pure: no I/O, no env.
//
// The recruitment parser (`recruitment/inbound/whatsapp-payload-parser.ts`) is deliberately left
// alone. It answers one question — "is there a CV in this?" — and throws away everything else: voice
// notes, stickers, locations, reactions, and every message the business itself sent. An inbox needs
// exactly those. Widening that parser would put the CV pipeline's behaviour at risk for a feature it
// does not serve, so the two read the same payload side by side.
//
// FOUR SHAPES ARRIVE ON THE ONE WEBHOOK.
//
//   value.messages[]         live messages FROM a contact.
//   value.history[]          coexistence replay of the handset's past chats, BOTH directions. A thread's
//                            `id` is the contact; a message whose `from` is the business number is one
//                            the handset sent.
//   value.message_echoes[]   the `smb_message_echoes` field: a message someone typed on the handset's
//                            WhatsApp Business app, live. `from` is the business, `to` the contact.
//   value.statuses[]         Meta's sent / delivered / read / failed ticks on messages sent through the
//                            Cloud API.
//
// Messages Phoenix itself sends are NOT read from here: Meta does not echo Cloud API sends. They are
// recorded at the moment of sending (store.ts, recordInboxOutbound).

export type InboxDirection = "inbound" | "outbound";
export type InboxOrigin = "contact" | "phoenix" | "handset";

export type InboxMedia = {
  id: string;
  mimeType: string | null;
  fileName: string | null;
};

export type InboxMessageRecord = {
  wamid: string;
  direction: InboxDirection;
  origin: InboxOrigin;
  phoneNumberId: string;
  lineDisplayNumber: string | null;
  contactWaId: string | null;
  contactUserId: string | null;
  contactName: string | null;
  contactUsername: string | null;
  messageType: string;
  body: string | null;
  media: InboxMedia | null;
  templateName: string | null;
  replyToWamid: string | null;
  historical: boolean;
  /** ISO. Meta's own timestamp; null only when Meta omitted it. */
  sentAt: string | null;
  /** A history replay reports how far a handset message got. Mapped to the inbox status vocabulary. */
  replayStatus: InboxOutboundStatus | null;
  payload: Record<string, unknown>;
};

export type InboxOutboundStatus = "accepted" | "sent" | "delivered" | "read" | "failed";

export type InboxStatusUpdate = {
  wamid: string;
  status: "sent" | "delivered" | "read" | "failed";
  at: string | null;
  failureDetail: string | null;
};

export type InboxDelivery = {
  messages: InboxMessageRecord[];
  statuses: InboxStatusUpdate[];
};

const MEDIA_TYPES = new Set(["image", "video", "audio", "document", "sticker"]);

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function asString(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function digitsOnly(value: string | null): string | null {
  const digits = value?.replace(/\D+/g, "") ?? "";
  return digits.length > 0 ? digits : null;
}

/** Same number, tolerating Meta's spaced display form and a missing country code. */
export function isSameWhatsAppNumber(a: string | null, b: string | null): boolean {
  const left = digitsOnly(a);
  const right = digitsOnly(b);
  if (!left || !right || left.length < 9 || right.length < 9) return false;
  return left.slice(-9) === right.slice(-9);
}

/** Meta sends unix SECONDS as a string. Anything else reads as null, never as 1970. */
export function unixSecondsToIso(value: unknown): string | null {
  const seconds = Number(asString(value));
  return Number.isFinite(seconds) && seconds > 0 ? new Date(seconds * 1000).toISOString() : null;
}

/**
 * What a person reads for one message node. A text is its words, a photo its caption, and a
 * structure — a location, a contact card, a reaction — a plain sentence describing it, so the chat
 * list never shows a type code.
 */
export function describeMessageNode(node: Record<string, unknown>): {
  messageType: string;
  body: string | null;
  media: InboxMedia | null;
  templateName: string | null;
  replyToWamid: string | null;
} {
  const messageType = asString(node.type) ?? "unknown";
  const contextNode = asRecord(node.context);
  let replyToWamid = asString(contextNode?.id);
  let body: string | null = null;
  let media: InboxMedia | null = null;
  let templateName: string | null = null;

  if (messageType === "text") {
    body = asString(asRecord(node.text)?.body);
  } else if (MEDIA_TYPES.has(messageType)) {
    const mediaNode = asRecord(node[messageType]);
    const id = asString(mediaNode?.id);
    body = asString(mediaNode?.caption);
    if (id) {
      media = {
        fileName: asString(mediaNode?.filename),
        id,
        mimeType: asString(mediaNode?.mime_type),
      };
    }
  } else if (messageType === "location") {
    const location = asRecord(node.location);
    const place = [asString(location?.name), asString(location?.address)].filter(Boolean).join(", ");
    const lat = asString(location?.latitude);
    const lng = asString(location?.longitude);
    const coordinates = lat && lng ? `${lat}, ${lng}` : null;
    body = `Shared a location${place ? `: ${place}` : ""}${coordinates ? ` (${coordinates})` : ""}`;
  } else if (messageType === "contacts") {
    const names = asArray(node.contacts)
      .map((contact) => {
        const name = asRecord(asRecord(contact)?.name);
        const phones = asArray(asRecord(contact)?.phones)
          .map((phone) => asString(asRecord(phone)?.phone))
          .filter(Boolean);
        const label = asString(name?.formatted_name) ?? asString(name?.first_name) ?? "a contact";
        return phones.length > 0 ? `${label} (${phones.join(", ")})` : label;
      })
      .filter(Boolean);
    body = names.length > 0 ? `Shared a contact: ${names.join("; ")}` : "Shared a contact";
  } else if (messageType === "interactive") {
    const interactive = asRecord(node.interactive);
    const reply = asRecord(interactive?.list_reply) ?? asRecord(interactive?.button_reply);
    const nfm = asRecord(interactive?.nfm_reply);
    body = asString(reply?.title) ?? asString(nfm?.body) ?? asString(asRecord(interactive?.body)?.text);
  } else if (messageType === "button") {
    body = asString(asRecord(node.button)?.text);
  } else if (messageType === "reaction") {
    const reaction = asRecord(node.reaction);
    replyToWamid = asString(reaction?.message_id) ?? replyToWamid;
    const emoji = asString(reaction?.emoji);
    body = emoji ? `Reacted ${emoji}` : "Removed a reaction";
  } else if (messageType === "template") {
    const template = asRecord(node.template);
    templateName = asString(template?.name);
    body = templateName ? `Template: ${templateName}` : null;
  } else if (messageType === "order") {
    body = "Sent an order";
  } else if (messageType === "system") {
    body = asString(asRecord(node.system)?.body);
  } else if (messageType === "unsupported") {
    body = "A message type WhatsApp does not pass to Phoenix";
  }

  return { body, media, messageType, replyToWamid, templateName };
}

function replayStatus(node: Record<string, unknown>): InboxOutboundStatus | null {
  const raw = asString(asRecord(node.history_context)?.status)?.toLowerCase();
  if (raw === "sent" || raw === "delivered" || raw === "read" || raw === "failed") return raw;
  if (raw === "played") return "read";
  return raw ? "sent" : null;
}

type Contact = { name: string | null; username: string | null; waId: string | null; userId: string | null };

function readContacts(value: Record<string, unknown>): Map<string, Contact> {
  const contacts = new Map<string, Contact>();
  for (const raw of asArray(value.contacts)) {
    const record = asRecord(raw);
    const profile = asRecord(record?.profile);
    const contact: Contact = {
      name: asString(profile?.name),
      userId: asString(record?.user_id),
      username: asString(profile?.username) ?? asString(record?.username),
      waId: asString(record?.wa_id),
    };
    if (contact.waId) contacts.set(`wa:${contact.waId}`, contact);
    if (contact.userId) contacts.set(`user:${contact.userId}`, contact);
  }
  return contacts;
}

function contactFor(contacts: Map<string, Contact>, waId: string | null, userId: string | null): Contact | null {
  return (waId ? contacts.get(`wa:${waId}`) : undefined) ?? (userId ? contacts.get(`user:${userId}`) : undefined) ?? null;
}

/**
 * Every inbox row and status tick in one delivery.
 *
 * `fallbackPhoneNumberId` files a change whose metadata Meta left out; without either, the change is
 * skipped, because a message that cannot be placed on a line cannot be answered from one.
 */
export function parseInboxDelivery(payload: unknown, options?: { fallbackPhoneNumberId?: string | null }): InboxDelivery {
  const messages: InboxMessageRecord[] = [];
  const statuses: InboxStatusUpdate[] = [];
  const seen = new Set<string>();

  const push = (record: InboxMessageRecord) => {
    if (seen.has(record.wamid)) return;
    seen.add(record.wamid);
    messages.push(record);
  };

  for (const entry of asArray(asRecord(payload)?.entry)) {
    for (const change of asArray(asRecord(entry)?.changes)) {
      const value = asRecord(asRecord(change)?.value);
      if (!value) continue;
      const metadata = asRecord(value.metadata);
      const phoneNumberId = asString(metadata?.phone_number_id) ?? options?.fallbackPhoneNumberId?.trim() ?? null;
      const lineDisplayNumber = asString(metadata?.display_phone_number);
      if (!phoneNumberId) continue;
      const contacts = readContacts(value);

      const build = (
        node: Record<string, unknown>,
        direction: InboxDirection,
        origin: InboxOrigin,
        contactWaIdRaw: string | null,
        contactUserIdRaw: string | null,
        historical: boolean,
      ): InboxMessageRecord | null => {
        const wamid = asString(node.id);
        const contact = contactFor(contacts, contactWaIdRaw, contactUserIdRaw);
        const contactWaId = contactWaIdRaw ?? contact?.waId ?? null;
        const contactUserId = contactUserIdRaw ?? contact?.userId ?? null;
        if (!wamid || (!contactWaId && !contactUserId)) return null;
        const described = describeMessageNode(node);
        return {
          ...described,
          contactName: contact?.name ?? null,
          contactUserId,
          contactUsername: contact?.username ?? null,
          contactWaId,
          direction,
          historical,
          lineDisplayNumber,
          origin,
          payload: node,
          phoneNumberId,
          replayStatus: direction === "outbound" ? replayStatus(node) : null,
          sentAt: unixSecondsToIso(node.timestamp),
          wamid,
        };
      };

      for (const raw of asArray(value.messages)) {
        const node = asRecord(raw);
        if (!node) continue;
        const from = asString(node.from);
        // A live `messages` entry sent BY the business number is not something Meta documents, but if
        // one ever arrives it must not become a chat with the company itself.
        if (from && isSameWhatsAppNumber(from, lineDisplayNumber)) continue;
        const record = build(node, "inbound", "contact", from, asString(node.from_user_id) ?? asString(node.user_id), false);
        if (record) push(record);
      }

      for (const raw of asArray(value.message_echoes)) {
        const node = asRecord(raw);
        if (!node) continue;
        const record = build(node, "outbound", "handset", asString(node.to), asString(node.to_user_id), false);
        if (record) push(record);
      }

      for (const chunk of asArray(value.history)) {
        for (const rawThread of asArray(asRecord(chunk)?.threads)) {
          const thread = asRecord(rawThread);
          const threadContact = asString(thread?.id);
          for (const raw of asArray(thread?.messages)) {
            const node = asRecord(raw);
            if (!node) continue;
            const from = asString(node.from);
            const fromBusiness = isSameWhatsAppNumber(from, lineDisplayNumber);
            const record = fromBusiness
              ? build(node, "outbound", "handset", asString(node.to) ?? threadContact, null, true)
              : build(node, "inbound", "contact", from ?? threadContact, asString(node.from_user_id), true);
            if (record) push(record);
          }
        }
      }

      for (const raw of asArray(value.statuses)) {
        const node = asRecord(raw);
        const wamid = asString(node?.id);
        const status = asString(node?.status)?.toLowerCase();
        if (!node || !wamid) continue;
        if (status !== "sent" && status !== "delivered" && status !== "read" && status !== "failed") continue;
        const firstError = asRecord(asArray(node.errors)[0]);
        const failureDetail =
          status === "failed"
            ? (asString(asRecord(firstError?.error_data)?.details) ??
              asString(firstError?.message) ??
              asString(firstError?.title) ??
              "WhatsApp could not deliver this message")
            : null;
        statuses.push({ at: unixSecondsToIso(node.timestamp), failureDetail, status, wamid });
      }
    }
  }

  return { messages, statuses };
}
