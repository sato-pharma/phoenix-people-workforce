// Recruitment workspace — the one search box's CV-text half.
//
// The owner, 20 Oct 2026: ONE search box for "name, phone, email and the CV's text, across every tab
// the user can see". Name, phone and email are matched inside `ats_workspace_filter` itself; what the
// CV SAYS is not in that table, so it is found here — by the same database search the CV search
// already uses (`ats_search_candidate_cvs`, every term must match) — and handed to the filter as
// `search_ids`, OR-ed with the name/phone/email match. The filter still applies the viewer's allowed
// tabs and the Talent Acquisition fence to those ids, so a CV-text hit can never surface a person
// the viewer may not see.
//
// WHY NOT `searchCandidateCvs`. That service asserts `candidates: read`, which is the pool's gate. The
// workspace has its own named gate (`workspaceViewer` in role-tabs.ts): the CEO reads the workspace
// WITHOUT `candidates: read` (`tests/ceo-account-contract.test.ts` pins that he never gets it), so
// calling the pool's service would refuse his search while admitting his rows. The caller has already
// established `viewer.canRead`; the query rules (minimum length, AND across terms) are the shared ones.

import { recruitmentDb } from "@/lib/recruitment/db";
import { CV_SEARCH_MIN_LENGTH } from "@/lib/recruitment/cv-search";
import type { WorkspaceViewer } from "@/lib/recruitment/workspace/role-tabs";

/**
 * At most this many CV-text matches join one search. The database function allows up to 1,000; the
 * pool holds a few hundred people, so 500 is every realistic match while keeping `search_ids` — which
 * travels inside the filter's jsonb on every page and count — bounded.
 */
export const WORKSPACE_CV_SEARCH_CAP = 500;

/** Candidate ids whose CV reading contains every term of the query. Empty for a short or blank query. */
export async function workspaceCvSearchIds(viewer: WorkspaceViewer, query: string): Promise<string[]> {
  if (!viewer.canRead) return [];
  const cleaned = String(query ?? "").trim().replace(/\s+/g, " ");
  if (cleaned.length < CV_SEARCH_MIN_LENGTH) return [];

  const { data, error } = await recruitmentDb().rpc("ats_search_candidate_cvs", {
    p_limit: WORKSPACE_CV_SEARCH_CAP,
    p_query: cleaned,
  });
  if (error) throw error;

  const ids = new Set<string>();
  for (const row of (data ?? []) as Array<{ candidate_id?: string | null }>) {
    const id = String(row.candidate_id ?? "").trim();
    if (id) ids.add(id);
  }
  return [...ids];
}
