import { NextResponse } from "next/server";
import { fenceCandidateIds } from "@/lib/recruitment/workspace/fence";

import { searchCandidateCvs, CV_SEARCH_MIN_LENGTH } from "@/lib/recruitment/cv-search";
import { recruitmentApiError, requireRecruitmentAccess } from "@/app/api/recruitment/_lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Search inside CV contents.
 *
 * A GET, and deliberately so: this reads and returns nothing that a POST would protect. It also
 * means a probe of this path answers 405 against a nonexistent route's 401, which is how the deploy
 * of a new route is verified here without an authenticated session.
 *
 * `candidates: read` — asserted twice on purpose. Once here, so an unauthorised caller is refused
 * before any query is built, and once inside the service, so a future caller that reaches the
 * service by another route cannot skip it. Search must never become a way around the gate on the
 * pool: "who has cardiology on their CV" returns candidate ids, which is the pool by another name.
 */
export async function GET(request: Request) {
  try {
    const access = await requireRecruitmentAccess(request, "candidates", "read");
    const query = new URL(request.url).searchParams.get("q") ?? "";

    if (query.trim().length < CV_SEARCH_MIN_LENGTH) {
      // Not an error — an empty box is the normal state, and a 400 here would put a red message on
      // screen for somebody who has simply not finished typing.
      return NextResponse.json({ hits: [], query: query.trim(), success: true, truncated: false });
    }

    const result = await searchCandidateCvs(access, query);
    // The Talent Acquisition fence (owner, 2026-10-20): an HR applicant's CV text is not searched for her.
    const visible = await fenceCandidateIds(access, result.hits.map((hit) => hit.candidateId));
    const hits = result.hits.filter((hit) => visible.has(hit.candidateId));
    return NextResponse.json({ ...result, hits, success: true });
  } catch (error) {
    return recruitmentApiError(error, "Failed to search CV contents.");
  }
}
