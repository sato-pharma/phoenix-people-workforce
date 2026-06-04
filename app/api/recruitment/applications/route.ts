import { NextResponse } from "next/server";

import {
  createApplication,
  listApplications,
  type CreateApplicationInput,
} from "@/lib/recruitment/applications";
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
    const access = await requireRecruitmentAccess(request, "recruitment", "read");
    const applications = await listApplications(access);
    return NextResponse.json({ success: true, applications });
  } catch (error) {
    return recruitmentApiError(error, "Failed to load applications.");
  }
}

export async function POST(request: Request) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await requireRecruitmentAccess(request, "recruitment", "create");
    const body = await readJsonObject(request);
    const requisitionId = str(body.requisitionId);
    if (!requisitionId) {
      return NextResponse.json({ error: "invalid_request", message: "A requisition is required.", success: false }, { status: 400 });
    }

    let candidate: CreateCandidateInput | null = null;
    const candidateBody = body.candidate;
    if (candidateBody && typeof candidateBody === "object") {
      const c = candidateBody as Record<string, unknown>;
      candidate = {
        fullName: str(c.fullName) ?? "",
        nationalId: str(c.nationalId),
        email: str(c.email),
        phone: str(c.phone),
        governorate: str(c.governorate),
        currentEmployer: str(c.currentEmployer),
        yearsExperience: num(c.yearsExperience),
        expectedSalary: num(c.expectedSalary),
        noticePeriod: str(c.noticePeriod),
        source: str(c.source),
        cvReferenceName: str(c.cvReferenceName),
        cvExternalUrl: str(c.cvExternalUrl),
        notes: str(c.notes),
      };
    }

    const input: CreateApplicationInput = {
      requisitionId,
      candidateId: str(body.candidateId),
      candidate,
      source: str(body.source),
    };
    const application = await createApplication(input, access);
    return NextResponse.json({ success: true, application }, { status: 201 });
  } catch (error) {
    return recruitmentApiError(error, "Failed to create application.");
  }
}
