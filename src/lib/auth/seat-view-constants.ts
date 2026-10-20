// VIEW AS SEAT — the plain constants, with no imports at all, so the client banner and proxy.ts can
// read them without pulling `crypto` (seat-view-token.ts) or the permission matrix (seat-view.ts) in.

export const phoenixSeatViewCookieName = "phoenix_seat_view";
/** One hour, fixed, never refreshed: a view nobody remembers to leave ends by itself. */
export const SEAT_VIEW_TTL_SECONDS = 60 * 60;
export const SEAT_VIEW_START_PATH = "/api/admin/seat-view/start";
/** The ONE write a seat view may send. */
export const SEAT_VIEW_EXIT_PATH = "/api/admin/seat-view/exit";
/** Where the owner picks a seat, and where Exit returns him. */
export const SEAT_VIEW_PAGE_PATH = "/admin/view-as-seat";
/**
 * The login id every seat view carries. Never the owner's (his mailbox, layouts, title and actor would
 * bleed into the seat) and never the viewed person's (nothing must act as them). Not a `TEST-` login, and
 * free of the characters a PostgREST `or()` filter splits on.
 */
export const SEAT_VIEW_LOGIN_ID = "SEAT-VIEW";
/** What a refused save reads during a view. */
export const SEAT_VIEW_REFUSAL =
  "You are viewing another seat, read only. Nothing here is saved, sent or decided — leave the view to work as yourself.";
