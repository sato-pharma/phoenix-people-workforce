// The WhatsApp Inbox's chat filter: Read / Unread (owner, 2026-10-28) and Waiting for us. Its own file
// so the list route and the tests read it without the store's service-role imports.

export type InboxReadState = "unread" | "read" | "waiting";

/** The list's chat filter from its query value; anything else shows every chat. */
export function parseInboxReadState(value: string | null | undefined): InboxReadState | null {
  return value === "unread" || value === "read" || value === "waiting" ? value : null;
}
