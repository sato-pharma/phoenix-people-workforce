import { NextResponse } from "next/server";
import { fenceCandidateIds } from "@/lib/recruitment/workspace/fence";

import { recruitmentApiError, requireRecruitmentAccess } from "@/app/api/recruitment/_lib/http";
import { CV_LOOKUP_MIN_LENGTH, recordCvLookupSearch, searchCvLookup } from "@/lib/recruitment/cv-lookup";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * CV LOOKUP — search the CV database and get back only what was searched for.
 *
 * `cv_lookup: read`, asserted here AND inside the service. Two assertions on purpose, the same
 * reason the recruiter's CV search gives one clause down: this endpoint returns candidate
 * identities, so a future caller reaching the service by another route must not be able to skip
 * the gate.
 *
 * NOT `candidates: read`. The seat this exists for (HR Operations) does not hold that grant and
 * must not: the owner's instruction on 2026-09-30 was that she can search the CVs and must NOT
 * have access to all of them, and `candidates:read` IS the pool. The whole reasoning is written
 * at the head of src/lib/recruitment/cv-lookup.ts.
 *
 * A GET, deliberately: it reads and returns nothing a POST would protect, and a probe of this path
 * answers 405 against a nonexistent route's 401 — which is how a new route's deploy is verified
 * here without an authenticated session.
 *
 * EVERY SEARCH IS RECORDED, readable by the Super Admin alone (the owner, asked directly). Written
 * from here rather than from the service so that no caller can decide not to record itself, and
 * best-effort so that a failing audit row cannot break the search it only observes.
 */
export async function GET(request: Request) {
  try {
    const access = await requireRecruitmentAccess(request, "cv_lookup", "read");
    const query = new URL(request.url).searchParams.get("q") ?? "";

    if (query.trim().length < CV_LOOKUP_MIN_LENGTH) {
      // Not an error, and not audited: an empty box is the screen's normal state, and a 400 would
      // put a red message in front of somebody who has simply not finished typing.
      return NextResponse.json({ hits: [], query: query.trim(), success: true, truncated: false });
    }

    const found = await searchCvLookup(access, query);
    // The Talent Acquisition fence (owner, 2026-10-20): an HR applicant is never a hit for her, nor counted.
    const visible = await fenceCandidateIds(access, found.hits.map((hit) => hit.candidateId));
    const result = { ...found, hits: found.hits.filter((hit) => visible.has(hit.candidateId)) };
    await recordCvLookupSearch({
      access,
      query: result.query,
      resultCount: result.hits.length,
      truncated: result.truncated,
    });
    return NextResponse.json({ ...result, success: true });
  } catch (error) {
    return recruitmentApiError(error, "Failed to search the CV database.");
  }
}
