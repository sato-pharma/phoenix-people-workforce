import { NextResponse } from "next/server";

import { deleteCandidate, getCandidateProfile, updateCandidate } from "@/lib/recruitment/candidates";
import { recordAppliedExtractionFields } from "@/lib/recruitment/cv-extraction";
import type { UpdateCandidateInput } from "@/lib/recruitment/types";
import {
  assertSameOriginMutation,
  bool,
  num,
  readJsonObject,
  recruitmentApiError,
  requireRecruitmentAccess,
  str,
} from "@/app/api/recruitment/_lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireRecruitmentAccess(request, "candidates", "read");
    const { id } = await params;
    const profile = await getCandidateProfile(id);
    if (!profile) {
      return NextResponse.json({ error: "not_found", message: "Candidate not found.", success: false }, { status: 404 });
    }
    return NextResponse.json({ success: true, profile });
  } catch (error) {
    return recruitmentApiError(error, "Failed to load candidate profile.");
  }
}

// Partial edit of a candidate's own fields — an omitted key leaves that column untouched
// (see updateCandidate/UpdateCandidateInput). Also used by the CV-extraction review UI: an
// optional `extractionId` in the body logs what was actually saved onto the extraction's
// audit-trail row.
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    await requireRecruitmentAccess(request, "candidates", "update");
    const { id } = await params;
    const body = await readJsonObject(request);
    const has = (key: string) => Object.prototype.hasOwnProperty.call(body, key);

    const input: UpdateCandidateInput = {};
    if (has("fullName")) input.fullName = str(body.fullName) ?? "";
    if (has("nationalId")) input.nationalId = str(body.nationalId);
    if (has("email")) input.email = str(body.email);
    if (has("phone")) input.phone = str(body.phone);
    if (has("address")) input.address = str(body.address);
    if (has("governorate")) input.governorate = str(body.governorate);
    if (has("currentEmployer")) input.currentEmployer = str(body.currentEmployer);
    if (has("yearsExperience")) input.yearsExperience = num(body.yearsExperience);
    if (has("expectedSalary")) input.expectedSalary = num(body.expectedSalary);
    if (has("noticePeriod")) input.noticePeriod = str(body.noticePeriod);
    if (has("source")) input.source = str(body.source);
    if (has("cvReferenceName")) input.cvReferenceName = str(body.cvReferenceName);
    if (has("cvExternalUrl")) input.cvExternalUrl = str(body.cvExternalUrl);
    if (has("notes")) input.notes = str(body.notes);
    if (has("faculty")) input.faculty = str(body.faculty);
    if (has("university")) input.university = str(body.university);
    if (has("hasPriorWorkExperience")) input.hasPriorWorkExperience = bool(body.hasPriorWorkExperience);
    if (has("hasMedicalRepExperience")) input.hasMedicalRepExperience = bool(body.hasMedicalRepExperience);
    if (has("medicalRepEmployer")) input.medicalRepEmployer = str(body.medicalRepEmployer);
    if (has("medicalRepExperienceFrom")) input.medicalRepExperienceFrom = str(body.medicalRepExperienceFrom);
    if (has("medicalRepExperienceTo")) input.medicalRepExperienceTo = str(body.medicalRepExperienceTo);
    if (has("positionSpecificFields")) {
      const raw = body.positionSpecificFields;
      input.positionSpecificFields = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
    }

    const candidate = await updateCandidate(id, input);

    const extractionId = str(body.extractionId);
    if (extractionId) {
      await recordAppliedExtractionFields(extractionId, input as Record<string, unknown>);
    }

    return NextResponse.json({ success: true, candidate });
  } catch (error) {
    return recruitmentApiError(error, "Failed to update candidate.");
  }
}

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await requireRecruitmentAccess(request, "candidates", "delete");
    const { id } = await params;
    await deleteCandidate(access, id);
    return NextResponse.json({ success: true });
  } catch (error) {
    return recruitmentApiError(error, "Failed to delete candidate.");
  }
}
