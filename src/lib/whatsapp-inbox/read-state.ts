// The WhatsApp Inbox's Read / Unread filter (owner, 2026-10-28). Its own file so the list route and
// the tests read it without the store's service-role imports.

export type InboxReadState = "unread" | "read";

/** The list's Read / Unread filter from its query value; anything else shows every chat. */
export function parseInboxReadState(value: string | null | undefined): InboxReadState | null {
  return value === "unread" || value === "read" ? value : null;
}
