import { NextResponse } from "next/server";

import {
  createRequisition,
  listOpenVacanciesForRequisition,
  listRequisitions,
} from "@/lib/recruitment/requisitions";
import type {
  CreateRequisitionInput,
  HeadcountType,
  RequisitionPriority,
} from "@/lib/recruitment/types";
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
    const url = new URL(request.url);
    if (url.searchParams.get("view") === "open-vacancies") {
      const vacancies = await listOpenVacanciesForRequisition();
      return NextResponse.json({ success: true, vacancies });
    }
    const requisitions = await listRequisitions(access);
    return NextResponse.json({ success: true, requisitions });
  } catch (error) {
    return recruitmentApiError(error, "Failed to load requisitions.");
  }
}

export async function POST(request: Request) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await requireRecruitmentAccess(request, "recruitment", "create");
    const body = await readJsonObject(request);
    const input: CreateRequisitionInput = {
      vacancyId: num(body.vacancyId),
      jobTitle: str(body.jobTitle),
      hiringManagerHrId: str(body.hiringManagerHrId),
      recruitmentOwnerHrId: str(body.recruitmentOwnerHrId),
      grade: str(body.grade),
      salaryBandMin: num(body.salaryBandMin),
      salaryBandMax: num(body.salaryBandMax),
      headcountType: str(body.headcountType) as HeadcountType | null,
      headcount: num(body.headcount),
      priority: str(body.priority) as RequisitionPriority | null,
      recruitmentDeadline: str(body.recruitmentDeadline),
      notes: str(body.notes),
    };
    const requisition = await createRequisition(input, access);
    return NextResponse.json({ success: true, requisition }, { status: 201 });
  } catch (error) {
    return recruitmentApiError(error, "Failed to create requisition.");
  }
}
