import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import {
  deleteScreeningQuestion,
  listScreeningQuestions,
  saveScreeningQuestionSet,
  type ScreeningQuestionDraft,
} from "@/lib/recruitment/inbound/whatsapp-screening-questions-admin";
import type { ScreeningQuestionKind, ScreeningQuestionOption } from "@/lib/recruitment/inbound/whatsapp-screening-questions";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

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
  const message = error instanceof Error ? error.message : String(error);
  return NextResponse.json({ error: code, message }, { status: 400 });
}

export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "admin", "update");

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
  return {
    bodyText: String(raw.bodyText ?? "").trim(),
    id: raw.id ? String(raw.id) : null,
    isActive: raw.isActive !== false,
    kind,
    options,
  };
}

export async function POST(request: Request) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;

    const access = await resolveAccessContext(request);
    await assertPermission(access, "admin", "update");

    const body = (await request.json()) as { questions?: DraftBody[] };
    if (!Array.isArray(body.questions)) {
      return NextResponse.json({ error: "questions must be an array" }, { status: 400 });
    }

    const result = await saveScreeningQuestionSet({
      actorHrId: access.hrId ?? null,
      questions: body.questions.map(parseDraft),
    });
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
    await assertPermission(access, "admin", "update");

    const id = new URL(request.url).searchParams.get("id")?.trim();
    if (!id) {
      return NextResponse.json({ error: "id is required" }, { status: 400 });
    }

    await deleteScreeningQuestion({ id });
    return NextResponse.json({ success: true });
  } catch (error) {
    return failure(error, "screening_question_delete_failed");
  }
}
