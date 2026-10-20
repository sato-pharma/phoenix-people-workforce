import { NextResponse } from "next/server";

import { buildCandidateHireHref, loadHireOptions } from "@/lib/recruitment/workspace/hire";
import { assertCandidateVisible } from "@/lib/recruitment/workspace/fence";
import {
  assertSameOriginMutation,
  readJsonObject,
  recruitmentApiError,
  recruitmentProblem,
  requireRecruitmentAccess,
  str,
} from "@/app/api/recruitment/_lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * "Mark as hired" in the recruitment workspace — which open seats this person could take, and the
 * Add Employee link for the one chosen.
 *
 * GET is a `candidates: read`: anyone working the workspace may SEE the dialog, and a viewer without
 * `employees: update` (the Talent Acquisition seat) gets `canHire: false` with the reason to show on
 * the greyed button. POST is `employees: update` itself, because what it hands back is a door into
 * Employee Master.
 *
 * NEITHER WRITES ANYTHING. The hire is the employee record Add Employee saves; the candidate moves to
 * Hired, and the seat's requisition closes, in that same save (`recordHireFromCandidate`). A link
 * that marked someone hired before the form was saved would leave the funnel saying hired and the
 * organogram saying vacant the moment somebody closed the form.
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const access = await requireRecruitmentAccess(request, "candidates", "read");
    const { id } = await params;
    await assertCandidateVisible(access, id);
    const options = await loadHireOptions(access, id);
    return NextResponse.json({ ...options, success: true });
  } catch (error) {
    return recruitmentApiError(error, "Could not load the open seats.");
  }
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await requireRecruitmentAccess(request, "employees", "update");
    const { id } = await params;
    await assertCandidateVisible(access, id);

    const body = await readJsonObject(request);
    const vacancyId = str(body.vacancyId);
    if (!vacancyId) return recruitmentProblem("Choose the seat they are taking.", 400);

    const href = await buildCandidateHireHref(id, vacancyId);
    return NextResponse.json({ href, success: true });
  } catch (error) {
    return recruitmentApiError(error, "Could not open Add Employee for this hire.");
  }
}
