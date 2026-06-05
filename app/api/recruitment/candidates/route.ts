import { NextResponse } from "next/server";

import { createCandidate, listCandidates } from "@/lib/recruitment/candidates";
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
    await requireRecruitmentAccess(request, "candidates", "read");
    const candidates = await listCandidates();
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
