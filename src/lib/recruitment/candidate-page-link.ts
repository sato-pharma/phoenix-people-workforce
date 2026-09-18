// Recruitment / ATS — the address of one candidate's own page, in whichever shell the browser is in.
//
// The owner, 2026-09-18: "when I press on the name of the person, I am jumped to a new page which
// shows the full details on everything for this candidate." That page lives at
// `<recruitment>/candidate/<id>` under each of the three addresses the module is served from:
//
//   /recruitment                    the admin shell (Super Admin, HR Advisory)
//   /hr/recruitment                 the HR shell, which proxy.ts rewrites onto the admin page
//   /employee-portals/recruitment   the portal shell (Talent Acquisition)
//
// A link has to stay inside the shell it was pressed in. The (admin) layout sends a portal viewer
// who asks for an admin address to the portal home, and an HR seat taken from /hr/recruitment to
// /recruitment loses the HR sidebar mid-task (see `screeningShellPoolHref`). The server cannot see
// the /hr rewrite, so the browser's own path is the input.
//
// No imports at all: the pool, the WhatsApp Applicants list and the screening page are client
// components, and the tests call this without a database.

/** The three recruitment addresses, longest first so a shorter one can never claim a longer path. */
export const RECRUITMENT_ROOTS = ["/employee-portals/recruitment", "/hr/recruitment", "/recruitment"] as const;

/** The candidate page's own segment under a recruitment address. */
export const CANDIDATE_PAGE_SEGMENT = "/candidate";

/**
 * The recruitment address the browser is in, read off its own path.
 *
 * `/hr/recruitment/whatsapp-applicants` answers `/hr/recruitment`, and so does the candidate page
 * itself, so a link built on any recruitment page lands in the same shell. `/recruitmentx` is not
 * under `/recruitment`. Anything unexpected falls back to the admin address, which the (admin)
 * layout already forwards for anyone who belongs elsewhere.
 */
export function recruitmentRootFromPathname(pathname: string | null | undefined): string {
  const path = typeof pathname === "string" ? pathname : "";
  for (const root of RECRUITMENT_ROOTS) {
    if (path === root || path.startsWith(`${root}/`)) return root;
  }
  return "/recruitment";
}

/** One candidate's page under a recruitment address. The id is encoded, so it cannot add a path. */
export function candidatePageHref(root: string, candidateId: string): string {
  return `${root.replace(/\/+$/, "")}${CANDIDATE_PAGE_SEGMENT}/${encodeURIComponent(candidateId)}`;
}

/** The shape of a candidate id: `ats_candidates.id` is a uuid. */
const CANDIDATE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The candidate id from the page's own address, or null when it cannot be one.
 *
 * Checked BEFORE the database is asked. `ats_candidates.id` is a uuid column, and a malformed id
 * does not come back as "no such row": Postgres refuses the whole query (22P02), which would put an
 * error page where "this candidate is not in the system" belongs. An edited or truncated link is a
 * normal thing to arrive with.
 */
export function parseCandidatePageId(value: string | string[] | null | undefined): string | null {
  const first = Array.isArray(value) ? value[0] : value;
  let text = typeof first === "string" ? first.trim() : "";
  try {
    text = decodeURIComponent(text);
  } catch {
    return null;
  }
  return CANDIDATE_ID_PATTERN.test(text) ? text.toLowerCase() : null;
}
