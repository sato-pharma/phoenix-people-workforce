// REP EXCEPTIONS AND POLYCLINIC CAPS ARE THE SUPER ADMIN'S ALONE — owner, 19 Nov 2026: "i want to make him
// when he goes to those pages the screen tell him server down". "Him" is the SFE Manager (Khaled Bedair, the
// only one), who had both pages from 3 Nov 2026. He keeps the two sidebar cards; opening either page, or a save
// sent from a page left open, answers that the server is down, never that he was refused.
//
// Plain constants with no imports, so the page, the two services and the client card share one wording.

/** The seat that is shown the server-down screen on the two pages instead of being redirected away. */
export const FIELD_CONTROL_OUTAGE_ROLE = "SFE Manager";

export const FIELD_CONTROL_OUTAGE_TITLE = "Server temporarily unavailable";

export const FIELD_CONTROL_OUTAGE_MESSAGE = "The server is temporarily unavailable. Please try again later.";

/** Whether this role is shown the server-down screen on Rep Exceptions and Polyclinic Caps. */
export function seesFieldControlOutage(role: string | null | undefined): boolean {
  return role === FIELD_CONTROL_OUTAGE_ROLE;
}
