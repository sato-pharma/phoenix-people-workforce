import { NextResponse } from "next/server";

import { getCandidate } from "@/lib/recruitment/candidates";
import { buildCvHireFacts, describeCvHireFacts } from "@/lib/recruitment/cv-hire-facts";
import { assertCandidateVisible } from "@/lib/recruitment/workspace/fence";
import { recruitmentApiError, recruitmentProblem, requireRecruitmentAccess } from "@/app/api/recruitment/_lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The person half of Add Employee for a hire started in the recruitment workspace
 * (`/employees?hireVacancy=1&…&fromCandidate=<id>`). The SEAT half came across in the URL; this is
 * who sits in it.
 *
 * `employees: update`, the grant of the form that reads it — the same seat that can save the
 * employee is the one that may see the identity laid into it.
 *
 * Built only from `cv-hire-facts.ts`, the one mapping from a candidate to the form's boxes. NO WORK
 * EMAIL: that module's rule is that no new door starts filling `employees.work_email` from a personal
 * CV address (it is a unique company column, opened later by the new-hire mailbox task). No money,
 * no seat, no title — the seat link carries those. Read-only; creates nothing.
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const access = await requireRecruitmentAccess(request, "employees", "update");
    const { id } = await params;
    await assertCandidateVisible(access, id);

    const candidate = await getCandidate(id);
    if (!candidate) return recruitmentProblem("Candidate not found.", 404);

    const facts = buildCvHireFacts(candidate);
    return NextResponse.json({
      candidateName: candidate.fullName,
      carriedFromCv: describeCvHireFacts(facts),
      draft: { fullName: candidate.fullName, ...facts },
      success: true,
    });
  } catch (error) {
    return recruitmentApiError(error, "Could not load the candidate's details.");
  }
}
