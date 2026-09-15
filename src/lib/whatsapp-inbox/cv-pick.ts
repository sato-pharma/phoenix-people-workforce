// WhatsApp Inbox — which file the chat list's "Open CV" button opens.
//
// Applicants send their CV as a PDF or Word file, and a document is the one message type that is
// almost always a CV here — photos are mostly certificates, so they are left in the chat. The button
// opens the NEWEST document the person sent, and `count` says when there are several, so an updated
// CV replaces the old one and nobody is told there is only one file when there are three.
//
// Pure, so the choice is tested apart from the query that feeds it.

/** One inbound document message, as the list reads it. */
export type InboxDocumentMessage = {
  id: string;
  conversation_id: string;
  media_file_name: string | null;
  sent_at: string | null;
};

export type InboxCvSummary = { messageId: string; fileName: string | null; count: number };

function sentAtMs(value: string | null): number {
  const ms = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(ms) ? ms : Number.NEGATIVE_INFINITY;
}

/**
 * Each chat's CV: the newest document by the time it was sent, whatever order the rows arrive in, and
 * how many documents that chat holds. A document with no send time never outranks one that has one.
 */
export function pickInboxCvs(messages: Iterable<InboxDocumentMessage>): Map<string, InboxCvSummary> {
  const newest = new Map<string, { message: InboxDocumentMessage; count: number }>();
  for (const message of messages) {
    const existing = newest.get(message.conversation_id);
    if (!existing) {
      newest.set(message.conversation_id, { count: 1, message });
      continue;
    }
    existing.count += 1;
    if (sentAtMs(message.sent_at) > sentAtMs(existing.message.sent_at)) existing.message = message;
  }
  const result = new Map<string, InboxCvSummary>();
  for (const [conversationId, { count, message }] of newest) {
    result.set(conversationId, { count, fileName: message.media_file_name, messageId: message.id });
  }
  return result;
}
