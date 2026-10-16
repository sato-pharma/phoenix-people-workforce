// Phoenix Ranks — who the admin twin (/admin/ranks) is open to. ONE list, read by the page that shows
// the board AND by the certificate route that prints another rep's certificate, so a role that can
// open the page can never be refused the certificate button on it (HR Resourcing was: the page let
// it in and the route answered 403, which the browser saved as a file named certificate.json).

/** HR Resourcing — the Talent Acquisition seat, ticked by the owner on 2026-10-08. */
export const RANK_ADMIN_ROLES: ReadonlySet<string> = new Set(["Super Admin", "CEO", "SFE Manager", "HR Resourcing"]);
