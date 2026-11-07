// Recruitment workspace — every link INTO the workspace, and the two links OUT of it (the offer
// composer and Add Employee), built in one place.
//
// WHY ONE FILE. Before the rebuild, eleven places wrote "/recruitment?..." by hand — the notices, the
// 18:00 digest, the Command Center tiles, the stale-send escalation, today's tasks — and each spelled
// its query differently, so a renamed parameter silently broke the ones nobody re-read. Every link
// now goes through `serializeWorkspaceFilters` (filters.ts), the same writer the page itself uses to
// put its filters in the URL, so a link can only say what the page can read back.
//
// THE OFFER LINK CARRIES IDS AND A TITLE, NEVER A NAME. The composer fetches the candidate's name and
// email itself, from the candidate route — a name in a URL ends up in browser history and server logs
// (`tests/candidate-offer-pointer.test.ts` keeps the offers code from importing recruitment, so the
// link is the only bridge, and it stays thin).
//
// Pure and client-safe: no database, no process.env.

import { emptyWorkspaceFilters, serializeWorkspaceFilters, type WorkspaceFilters } from "@/lib/recruitment/workspace/filters";
import type { WorkspaceRoleTab, WorkspaceTabKey } from "@/lib/recruitment/workspace/role-tabs";

/** The workspace's own page. HR-namespace surfaces (Talent Acquisition's panel) pass `/hr/recruitment`. */
export const WORKSPACE_BASE_PATH = "/recruitment";
export const HR_WORKSPACE_BASE_PATH = "/hr/recruitment";

type LinkOptions = { basePath?: string };

/** A workspace link with these filters set and every other filter clean. */
export function workspaceHref(overrides: Partial<WorkspaceFilters> = {}, options: LinkOptions = {}): string {
  const filters: WorkspaceFilters = { ...emptyWorkspaceFilters(), ...overrides };
  const query = serializeWorkspaceFilters(filters).toString();
  const base = options.basePath ?? WORKSPACE_BASE_PATH;
  return query ? `${base}?${query}` : base;
}

/** One tab, optionally one region (or "unspecified") and one area inside it. */
export function workspaceTabHref(
  tab: WorkspaceTabKey,
  place: { region?: string | null; area?: string | null } = {},
  options: LinkOptions = {},
): string {
  return workspaceHref({ tab, region: place.region ?? null, area: place.area ?? null }, options);
}

/** One CV, opened in the tab it sits in (or the viewer's first tab when none is named). */
export function workspaceCandidateHref(candidateId: string, tab?: WorkspaceTabKey | null, options: LinkOptions = {}): string {
  return workspaceHref({ tab: tab ?? null, candidate: candidateId }, options);
}

/**
 * The offer title a role tab maps to — only where the mapping is certain. Every value here is a live
 * `offer_job_titles` row (read 2026-10-20), so the composer's own `chooseTitle` fills reports-to.
 * The shared RM/AM + NSM tab is National Sales Manager only when the applicant tapped NSM; an Area or
 * Regional Manager has no offer title yet, so the composer is left for him to pick.
 */
export function offerTitleForRoleTab(tab: WorkspaceRoleTab | null | undefined, botRoleFamily?: string | null): string | null {
  switch (tab) {
    case "medical_rep":
      return "Medical Representative";
    case "district_manager":
      return "District Sales Manager";
    case "product_manager":
      return "Product Manager";
    case "rm_am_nsm":
      return botRoleFamily === "national_sales_manager" ? "National Sales Manager" : null;
    case "hr_section_head":
      return "HR Section Head";
    case "talent_acquisition":
      return "Talent Acquisition Specialist";
    case "office_coordinator":
      return "Office Coordinator";
    // Both grades share the tab; the plain grade is the default and the composer can switch it.
    case "personnel":
      return "Personnel Specialist";
    default:
      return null;
  }
}

/** The offer composer, pre-filled for this candidate (and seat, and title, when known). */
export function offerComposerHref(
  candidateId: string,
  vacancyId?: string | null,
  roleTab?: WorkspaceRoleTab | null,
  botRoleFamily?: string | null,
  /** The proposed joining date (YYYY-MM-DD) — the Medical Rep workflow carries the NSM's. Never money. */
  startDate?: string | null,
): string {
  const params = new URLSearchParams();
  params.set("candidate", candidateId);
  if (vacancyId) params.set("vacancy", vacancyId);
  const title = offerTitleForRoleTab(roleTab ?? null, botRoleFamily ?? null);
  if (title) params.set("title", title);
  if (startDate && /^\d{4}-\d{2}-\d{2}$/.test(startDate)) params.set("start", startDate);
  return `/offers?${params.toString()}`;
}

/** Add Employee with this candidate's identity pre-filled (the seat is chosen by the hire route). */
export const FROM_CANDIDATE_PARAM = "fromCandidate";
