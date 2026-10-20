import { NextResponse } from "next/server";
import { assertCandidateVisible } from "@/lib/recruitment/workspace/fence";

import { deleteCandidate, getCandidateProfile, updateCandidate } from "@/lib/recruitment/candidates";
import { getLatestCvExtraction, recordAppliedExtractionFields } from "@/lib/recruitment/cv-extraction";
import { listJsonbCvFields, listWritableCvFields } from "@/lib/recruitment/cv-field-storage";
import { listScreeningQuestionLabels } from "@/lib/recruitment/screening-question-labels";
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
    const access = await requireRecruitmentAccess(request, "candidates", "read");
    const { id } = await params;
    await assertCandidateVisible(access, id);
    const profile = await getCandidateProfile(id);
    if (!profile) {
      return NextResponse.json({ error: "not_found", message: "Candidate not found.", success: false }, { status: 404 });
    }
    // Returned alongside the profile rather than inside it: the extraction audit trail is this
    // module's own record, not part of a candidate. Automated intake writes one per inbound CV
    // and nothing else ever read it back, so the fields the AI already found stayed invisible —
    // the UI now opens the review board on this instead of paying for a second extraction.
    const [latestCvExtraction, screeningQuestions] = await Promise.all([
      getLatestCvExtraction(id).catch(() => null),
      // The wording of the admin-defined WhatsApp questions, so each answer on the record can be
      // printed under the question it answers. Null — never a failed profile — when it cannot be read:
      // the answers still show, under a label that says their question could not be loaded.
      listScreeningQuestionLabels().catch(() => null),
    ]);
    return NextResponse.json({ latestCvExtraction, profile, screeningQuestions, success: true });
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
    const access = await requireRecruitmentAccess(request, "candidates", "update");
    const { id } = await params;
    await assertCandidateVisible(access, id);
    const body = await readJsonObject(request);
    const has = (key: string) => Object.prototype.hasOwnProperty.call(body, key);

    const input: UpdateCandidateInput = {};

    // Non-extraction fields — a human types these, no CV proposes them, so they stay listed here.
    if (has("source")) input.source = str(body.source);
    if (has("cvReferenceName")) input.cvReferenceName = str(body.cvReferenceName);
    if (has("cvExternalUrl")) input.cvExternalUrl = str(body.cvExternalUrl);
    if (has("notes")) input.notes = str(body.notes);

    // Extraction fields are driven from the schema registry rather than enumerated by hand.
    //
    // This used to be a hand-written list of all 21 keys, and it was the single biggest trap in
    // the module: the review board renders whatever cv-field-schemas.ts declares, so a field added
    // to the schema was rendered, edited, dragged and submitted — then silently dropped right
    // here, with no error anywhere and no way to tell from the UI. Reading the allow-list from
    // CV_FIELD_COLUMNS means the schema and the save path cannot drift apart again.
    //
    // The cast is the narrow escape hatch: field.key is a `string` at runtime but every key comes
    // from CV_FIELD_COLUMNS, which cvFieldStorageDrift() asserts against the schema and
    // tests/recruitment-cv-field-storage.test.ts pins — so an unknown key cannot reach here.
    const writable = input as Record<string, unknown>;
    for (const field of listWritableCvFields()) {
      if (!has(field.key)) continue;
      const raw = body[field.key];
      switch (field.type) {
        case "boolean":
          writable[field.key] = bool(raw);
          break;
        case "number":
          writable[field.key] = num(raw);
          break;
        // "date" values are YYYY-MM-DD strings; see cv-field-schemas.ts.
        default:
          writable[field.key] = str(raw);
      }
    }
    // fullName is the one extraction field that is never nullable — a candidate row must carry a
    // name — so it keeps the empty-string floor the hand-written version applied.
    if (has("fullName")) input.fullName = str(body.fullName) ?? "";

    // Repeating blocks (workHistory, educationHistory, certifications, skills, languages) are
    // storage:"jsonb", so the review board submits them as top-level keys but they belong inside
    // position_specific_fields. Collect them here; updateCandidate merges rather than replaces, so
    // saving work history alone does not wipe the candidate's skills.
    const blocks: Record<string, unknown> = {};
    for (const field of listJsonbCvFields()) {
      if (!has(field.key)) continue;
      const raw = body[field.key];
      blocks[field.key] = Array.isArray(raw) ? raw : [];
    }
    if (has("positionSpecificFields")) {
      const raw = body.positionSpecificFields;
      Object.assign(blocks, raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {});
    }
    if (Object.keys(blocks).length > 0) input.positionSpecificFields = blocks;

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
    await assertCandidateVisible(access, id);
    await deleteCandidate(access, id);
    return NextResponse.json({ success: true });
  } catch (error) {
    return recruitmentApiError(error, "Failed to delete candidate.");
  }
}
