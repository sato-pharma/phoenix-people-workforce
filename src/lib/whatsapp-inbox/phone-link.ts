// The WhatsApp Inbox's automatic link: what marks one, and how a reader tells it from a person's.
// Its own file so the recruitment bot's code reads it without the store's service-role imports.
//
// An automatic link says who a chat is with, for the people reading the inbox. It never decides who
// the applicant bot resumes: a person's link does that ("Ask again" writes one), and a matching phone
// on a CV that arrived by email is not that person having asked to carry on on WhatsApp.

/** `linked_by_hr_id` on a link `whatsapp_inbox_link_chats_by_phone` made. Written in that function too. */
export const INBOX_PHONE_MATCH_LINKER = "phone-match";

export function isPhoneMatchLink(linkedBy: string | null | undefined): boolean {
  return linkedBy === INBOX_PHONE_MATCH_LINKER;
}

/** A PostgREST `or(...)`: every chat link except an automatic one. A blank linker is an old link. */
export const NOT_A_PHONE_MATCH_LINK = `linked_by_hr_id.is.null,linked_by_hr_id.neq.${INBOX_PHONE_MATCH_LINKER}`;
