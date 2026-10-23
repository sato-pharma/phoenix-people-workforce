import { NextResponse } from "next/server";

import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { afterResponse } from "@/lib/http/after-response";
import {
  assertScreeningQuestionsAccess,
  deleteScreeningQuestion,
  listScreeningQuestions,
  saveScreeningQuestionSet,
  type ScreeningQuestionDraft,
} from "@/lib/recruitment/inbound/whatsapp-screening-questions-admin";
import type { ScreeningQuestionKind, ScreeningQuestionOption } from "@/lib/recruitment/inbound/whatsapp-screening-questions";
import { recomputeCompletenessForRoles } from "@/lib/recruitment/workspace/completeness";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The Super-Admin-only "full builder" for the extra questions the WhatsApp CV-intake bot asks after
 * its fixed six (role, background, region, area, experience, salary — never edited here).
 *
 * Gated on `admin:update`, the same hard boundary as Temporary Module Locks. That is the whole
 * authorization story and it is enforced here, server-side: the sidebar hiding the link is UX, this
 * is the boundary.
 */

function failure(error: unknown, code: string) {
  if (isForbiddenError(error)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const message = clientSafeErrorMessage(error, "The screening questions could not be updated.");
  return NextResponse.json({ error: code, message }, { status: 400 });
}

export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertScreeningQuestionsAccess(access);

    const questions = await listScreeningQuestions();
    return NextResponse.json({ questions });
  } catch (error) {
    return failure(error, "screening_questions_read_failed");
  }
}

type DraftBody = {
  id?: string | null;
  bodyText?: string;
  kind?: string;
  options?: { value?: string; title?: string; description?: string | null }[] | null;
  isActive?: boolean;
  appliesToRoleFamilies?: string[] | null;
  buttonLabel?: string | null;
  sectionTitle?: string | null;
};

function parseDraft(raw: DraftBody): ScreeningQuestionDraft {
  const kind = raw.kind === "free_text" ? "free_text" : ("tappable" as ScreeningQuestionKind);
  const options: ScreeningQuestionOption[] | null =
    kind === "tappable"
      ? (raw.options ?? []).map((option) => ({
          description: option.description?.trim() ? option.description.trim() : null,
          title: String(option.title ?? "").trim(),
          value: String(option.value ?? "").trim(),
        }))
      : null;
  // An ABSENT field and an EMPTY array both mean "ask everyone" here. Absent is what a client that
  // predates scoping sends, empty is what this screen sends once the admin clears every checkbox,
  // and both must land on null rather than on a stored [] — which the database refuses outright,
  // because an empty scope reads as "ask nobody" and would silently retire the question.
  // Membership itself is NOT checked here: screeningQuestionViolations owns that vocabulary, so the
  // admin gets one message naming the bad role rather than a generic 400 from this parser.
  const appliesToRoleFamilies = Array.isArray(raw.appliesToRoleFamilies)
    ? raw.appliesToRoleFamilies.map((family) => String(family ?? "").trim()).filter((family) => family.length > 0)
    : [];

  return {
    appliesToRoleFamilies: appliesToRoleFamilies.length > 0 ? appliesToRoleFamilies : null,
    bodyText: String(raw.bodyText ?? "").trim(),
    // Blank is "use the generic default", the same as absent — the store writes NULL for both.
    buttonLabel: typeof raw.buttonLabel === "string" ? raw.buttonLabel.trim() : null,
    id: raw.id ? String(raw.id) : null,
    isActive: raw.isActive !== false,
    kind,
    options,
    sectionTitle: typeof raw.sectionTitle === "string" ? raw.sectionTitle.trim() : null,
  };
}

export async function POST(request: Request) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;

    const access = await resolveAccessContext(request);
    await assertScreeningQuestionsAccess(access);

    const body = (await request.json()) as { questions?: DraftBody[] };
    if (!Array.isArray(body.questions)) {
      return NextResponse.json({ error: "questions must be an array" }, { status: 400 });
    }

    const result = await saveScreeningQuestionSet({
      actorHrId: access.hrId ?? null,
      questions: body.questions.map(parseDraft),
    });
    // A question added, removed or re-scoped changes what every person it reaches still owes, and the
    // workspace sorts and filters on the stored numbers. Past the response: the pool is a few hundred.
    await afterResponse("screening_questions_recompute_completeness", () => recomputeCompletenessForRoles(null));
    return NextResponse.json(result);
  } catch (error) {
    return failure(error, "screening_questions_save_failed");
  }
}

export async function DELETE(request: Request) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;

    const access = await resolveAccessContext(request);
    await assertScreeningQuestionsAccess(access);

    const id = new URL(request.url).searchParams.get("id")?.trim();
    if (!id) {
      return NextResponse.json({ error: "id is required" }, { status: 400 });
    }

    await deleteScreeningQuestion({ id });
    await afterResponse("screening_questions_recompute_completeness", () => recomputeCompletenessForRoles(null));
    return NextResponse.json({ success: true });
  } catch (error) {
    return failure(error, "screening_question_delete_failed");
  }
}
