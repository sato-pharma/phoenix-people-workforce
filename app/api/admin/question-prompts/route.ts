import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import {
  builtInPrompts,
  type OptionLabel,
  type PromptOverride,
} from "@/lib/recruitment/inbound/whatsapp-question-prompts";
import {
  loadQuestionPromptOverrides,
  saveQuestionPrompt,
} from "@/lib/recruitment/inbound/whatsapp-question-prompts-store";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The Super-Admin-only editor for the SIX BUILT-IN questions the WhatsApp CV-intake bot asks
 * (role, background, region, area, experience, salary) — their wording, and the labels on the
 * answers an applicant taps.
 *
 * Sibling of /api/admin/screening-questions, which owns the EXTRA questions asked after these six.
 * Two routes because they edit two different things: this one changes the words on questions that
 * already exist in code, that one creates new ones. Same hard boundary — `admin:update`, enforced
 * here server-side on every verb, the sidebar hiding the link being UX and not the boundary.
 *
 * WHAT IS WRITABLE: the wording, the answer labels, and WHICH of the answers are offered and in what
 * order. What is not is the code under each answer — it stays in code deliberately, because it is
 * what the CV pool filters, candidate folders and manager routing read. Both the full answer list
 * and the default-offered subset are taken from the catalogue on THIS side rather than from the
 * request, so a client cannot widen what it may relabel, nor add an answer nothing understands.
 */

function failure(error: unknown, code: string) {
  if (isForbiddenError(error)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const message = error instanceof Error ? error.message : String(error);
  return NextResponse.json({ error: code, message }, { status: 400 });
}

/**
 * Every prompt with BOTH its defaults and whatever is saved, so the screen can show the live
 * wording, mark which questions are customised, and offer a reset without a second request.
 */
function promptsWithOverrides(overrides: ReadonlyMap<string, PromptOverride>) {
  return builtInPrompts().map((prompt) => {
    const saved = overrides.get(prompt.key);
    return {
      ...prompt,
      isCustomised: Boolean(saved),
      savedBody: saved?.body ?? null,
      savedHiddenOptions: saved?.hiddenOptions ?? [],
      savedOptionLabels: saved?.optionLabels ?? {},
      savedOptionOrder: saved?.optionOrder ?? [],
    };
  });
}

export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "admin", "update");

    const overrides = await loadQuestionPromptOverrides();
    return NextResponse.json({ prompts: promptsWithOverrides(overrides) });
  } catch (error) {
    return failure(error, "question_prompts_read_failed");
  }
}

export async function POST(request: Request) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;

    const access = await resolveAccessContext(request);
    await assertPermission(access, "admin", "update");

    const body = (await request.json()) as {
      key?: string;
      bodyText?: string;
      optionLabels?: Record<string, OptionLabel>;
      hiddenOptions?: string[];
      optionOrder?: string[];
    };
    const key = String(body.key ?? "").trim();
    if (!key) {
      return NextResponse.json({ error: "key is required" }, { status: 400 });
    }

    // What this question COULD offer, and what it offers by default — both resolved server-side from
    // the code catalogue. A label, a hide, or an add naming anything outside these is refused: the
    // client never gets to say which answers exist, only which of them to show and in what order.
    const options = builtInPrompts().find((prompt) => prompt.key === key)?.options ?? [];
    const allowedValues = options.map((option) => option.value);
    const defaultOfferedValues = options
      .filter((option) => option.offeredByDefault)
      .map((option) => option.value);

    // A blank bodyText with no labels and no answer changes is the RESET gesture, handled inside
    // saveQuestionPrompt — the row is dropped and the question goes back to its code defaults rather
    // than being saved empty.
    await saveQuestionPrompt({
      actorHrId: access.hrId ?? null,
      allowedValues,
      bodyText: String(body.bodyText ?? ""),
      defaultOfferedValues,
      hiddenOptions: Array.isArray(body.hiddenOptions) ? body.hiddenOptions : [],
      key,
      optionLabels: body.optionLabels ?? {},
      optionOrder: Array.isArray(body.optionOrder) ? body.optionOrder : [],
    });

    const overrides = await loadQuestionPromptOverrides();
    return NextResponse.json({ prompts: promptsWithOverrides(overrides) });
  } catch (error) {
    return failure(error, "question_prompt_save_failed");
  }
}
