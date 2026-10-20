import { NextResponse } from "next/server";
import { fenceCandidateIds } from "@/lib/recruitment/workspace/fence";

import { createCandidate, searchCandidates } from "@/lib/recruitment/candidates";
import type { CreateCandidateInput } from "@/lib/recruitment/types";
import {
  assertSameOriginMutation,
  num,
  readJsonObject,
  recruitmentApiError,
  requireRecruitmentAccess,
  str,
} from "@/app/api/recruitment/_lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const access = await requireRecruitmentAccess(request, "candidates", "read");
    const url = new URL(request.url);
    const found = await searchCandidates({
      q: url.searchParams.get("q"),
      status: url.searchParams.get("status"),
      source: url.searchParams.get("source"),
    });
    // The Talent Acquisition fence (owner, 2026-10-20): an HR applicant is not in her results at all.
    const visible = await fenceCandidateIds(access, found.map((candidate) => candidate.id));
    const candidates = found.filter((candidate) => visible.has(candidate.id));
    return NextResponse.json({ success: true, candidates });
  } catch (error) {
    return recruitmentApiError(error, "Failed to load candidates.");
  }
}

export async function POST(request: Request) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await requireRecruitmentAccess(request, "candidates", "create");
    const body = await readJsonObject(request);
    const input: CreateCandidateInput = {
      fullName: str(body.fullName) ?? "",
      nationalId: str(body.nationalId),
      email: str(body.email),
      phone: str(body.phone),
      governorate: str(body.governorate),
      currentEmployer: str(body.currentEmployer),
      yearsExperience: num(body.yearsExperience),
      expectedSalary: num(body.expectedSalary),
      noticePeriod: str(body.noticePeriod),
      source: str(body.source),
      cvReferenceName: str(body.cvReferenceName),
      cvExternalUrl: str(body.cvExternalUrl),
      notes: str(body.notes),
    };
    const result = await createCandidate(input, access);
    return NextResponse.json(
      { success: true, candidate: result.candidate, created: result.created, matchReason: result.matchReason ?? null },
      { status: result.created ? 201 : 200 },
    );
  } catch (error) {
    return recruitmentApiError(error, "Failed to create candidate.");
  }
}
