// Recruitment / ATS — who a WhatsApp message is addressed to: a phone number, or a username's id.
//
// A WhatsApp user who adopts a username reaches a business as a business-scoped user id (BSUID, e.g.
// "EG.1773524767077450") and Meta may omit the phone number. The bot's conversation is keyed on one
// string, `wa_id`; for such a person that string IS the BSUID (owner, 2026-10-20: a woman who wrote
// from a username was never asked the screening questions). Meta addresses a BSUID through the
// `recipient` field, and a phone through `to` — never both, because `to` wins when both are sent.

/** A BSUID: two capital letters (the country), a dot, then letters and digits. A phone is digits only. */
const BSUID_PATTERN = /^[A-Z]{2}\.[A-Za-z0-9]{1,128}$/;

export function isBusinessScopedUserId(value: string | null | undefined): boolean {
  return BSUID_PATTERN.test(String(value ?? "").trim());
}

/**
 * The payload as Meta wants it: a BSUID moves from `to` into `recipient`; a phone is left alone.
 * Pure, so the one rule that decides where a message goes is pinned without a network call.
 */
export function addressedForGraph(payload: Record<string, unknown>): Record<string, unknown> {
  const to = typeof payload.to === "string" ? payload.to.trim() : "";
  if (!isBusinessScopedUserId(to)) return payload;
  const { to: _phoneField, ...rest } = payload;
  return { ...rest, recipient: to };
}
