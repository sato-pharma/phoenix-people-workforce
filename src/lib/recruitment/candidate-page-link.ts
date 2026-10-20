// Recruitment / ATS — the address of one candidate's own page, in whichever shell the browser is in.
//
// The owner, 2026-09-18: "when I press on the name of the person, I am jumped to a new page which
// shows the full details on everything for this candidate." That page lives at
// `<recruitment>/candidate/<id>` under each of the three addresses the module is served from:
//
//   /recruitment                    the admin shell (Super Admin, HR Advisory)
//   /hr/recruitment                 the HR shell, which proxy.ts rewrites onto the admin page
//   /employee-portals/recruitment   the portal shell
//
// A link has to stay inside the shell it was pressed in. The (admin) layout sends a portal viewer
// who asks for an admin address to the portal home, and an HR seat taken from /hr/recruitment to
// /recruitment loses the HR sidebar mid-task (see `screeningShellPoolHref`). The server cannot see
// the /hr rewrite, so the browser's own path is the input.
//
// One import, the shared uuid check, which is itself pure: the pool, the WhatsApp Applicants list
// and the screening page are client components, and the tests call this without a database.

import { isUuid } from "@/lib/http/uuid";

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

/** The manager's own list — "My Candidates" — in the portal shell. Where every CV notice points. */
export const PORTAL_CANDIDATES_PATH = "/employee-portals/recruitment-candidates";

/** The query parameter that names the candidate a link to that list is about. */
export const CANDIDATE_LINK_PARAM = "candidate";

/**
 * The link a notification carries to "My Candidates", naming the candidate it is about.
 *
 * The owner, 2026-09-19, on a comment notice: pressing the link from Telegram opened the employee
 * portal and then dropped him in the command center. The list itself is the portal's and reads
 * nothing from the address, so a manager lands on the same list either way — the name is for
 * whoever opens the link from the ADMIN shell, who is sent on to that candidate's own page (see
 * `adminTwinOfPortalCandidatesHref`) instead of to a list that was never theirs.
 *
 * An id that is not a uuid is left off rather than sent: the receiving page would refuse it, and a
 * bare link is still a link that opens.
 */
export function portalCandidatesHref(candidateId?: string | null): string {
  const id = parseCandidatePageId(candidateId);
  return id ? `${PORTAL_CANDIDATES_PATH}?${CANDIDATE_LINK_PARAM}=${encodeURIComponent(id)}` : PORTAL_CANDIDATES_PATH;
}

/**
 * One candidate's page in the ADMIN shell, or the recruitment hub when the id cannot be one.
 *
 * For a link that is only ever opened by someone who lives in the admin shell — the in-app copy of a
 * comment that goes to the Super Admin — so it lands on the candidate without the hop through the
 * portal address.
 */
export function adminCandidateHref(candidateId: string | string[] | null | undefined): string {
  const id = parseCandidatePageId(candidateId);
  return id ? candidatePageHref("/recruitment", id) : "/recruitment";
}

/**
 * Where a viewer who lives in the ADMIN shell is sent when they open a portal "My Candidates" link,
 * or null when the admin shell has nothing better for them than its own landing page.
 *
 * Until 2026-09-19 the page answered every such viewer with `/overview`, so the Super Admin who
 * received a comment notice — by email, by the Telegram copy of it, or from the bell — pressed the
 * link and arrived at the command center. The answers, in order:
 *
 *   · can open the recruitment pages  → that candidate's own page when the link names one (it
 *     carries the notes and the history), the recruitment hub when it does not;
 *   · can open the personal inbox     → the admin twin of this very list, the one the CEO uses,
 *     opened on that candidate when the link names one (the page reads `?candidate=`);
 *   · anybody else                    → null, and the caller keeps its old `/overview`.
 *
 * `canOpenRecruitment` is the admin candidate page's own gate, passed in rather than re-derived, so
 * nobody is forwarded to a page that would bounce them a second time.
 */
export function adminTwinOfPortalCandidatesHref(input: {
  canOpenPersonalInbox: boolean;
  canOpenRecruitment: boolean;
  candidateId: string | string[] | null | undefined;
}): string | null {
  if (input.canOpenRecruitment) return adminCandidateHref(input.candidateId);
  if (!input.canOpenPersonalInbox) return null;
  const id = parseCandidatePageId(input.candidateId);
  return id ? `/recruitment/candidates?${CANDIDATE_LINK_PARAM}=${encodeURIComponent(id)}` : "/recruitment/candidates";
}

/**
 * The candidate id from the page's own address, or null when it cannot be one.
 *
 * Checked BEFORE the database is asked. `ats_candidates.id` is a uuid column, and a malformed id
 * does not come back as "no such row": Postgres refuses the whole query (22P02), which would put an
 * error page where "this candidate is not in the system" belongs. An edited or truncated link is a
 * normal thing to arrive with.
 *
 * The check is the shared `isUuid`, which deliberately does not trim. The trimming here happens
 * first and the trimmed text is what is returned, so the value handed to the database is exactly
 * the one that passed.
 */
export function parseCandidatePageId(value: string | string[] | null | undefined): string | null {
  const first = Array.isArray(value) ? value[0] : value;
  let text = typeof first === "string" ? first.trim() : "";
  try {
    text = decodeURIComponent(text);
  } catch {
    return null;
  }
  return isUuid(text) ? text.toLowerCase() : null;
}

/**
 * The page "Print record" opens: the candidate's whole page as a sheet of paper (owner, 2026-09-19).
 *
 * The same path in every shell, unlike the candidate page's own. It sits under /print, outside both
 * shells, so the paper holds the record and nothing else — and a link that never enters a shell has no
 * shell to stay inside. The id is encoded, so it cannot add a path.
 */
export function candidateRecordPrintHref(candidateId: string): string {
  return `/print/candidate-record/${encodeURIComponent(candidateId)}`;
}
