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

function validationError(message: string) {
  return NextResponse.json({ error: "validation", message, success: false }, { status: 400 });
}

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
    // Either an open vacancy, OR a typed job title with a named hiring manager. The service
    // enforces the same rule (it is the real boundary for anything that does not come through this
    // route), but a service throw is mapped to a 500 by recruitmentApiError — and "something went
    // wrong" is the wrong thing to tell someone who simply left a field empty.
    if (!input.vacancyId) {
      if (!input.jobTitle) {
        return validationError("Type the job title, or choose an open vacancy.");
      }
      if (!input.hiringManagerHrId) {
        return validationError(
          "Choose the hiring manager — with no vacancy behind it, nobody else can see this requisition.",
        );
      }
    }

    const requisition = await createRequisition(input, access);
    return NextResponse.json({ success: true, requisition }, { status: 201 });
  } catch (error) {
    return recruitmentApiError(error, "Failed to create requisition.");
  }
}
