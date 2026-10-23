import { NextResponse } from "next/server";

import { assertScreeningQuestionsAccess } from "@/lib/recruitment/inbound/whatsapp-screening-questions-admin";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { afterResponse } from "@/lib/http/after-response";
import { recomputeCompletenessForRoles } from "@/lib/recruitment/workspace/completeness";
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
import { clientSafeErrorMessage } from "@/lib/http/api-errors";

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
  const message = clientSafeErrorMessage(error, "The question prompts could not be updated.");
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
      savedAppliesToRoleFamilies: saved?.appliesToRoleFamilies ?? null,
      savedButtonLabel: saved?.buttonLabel ?? null,
      savedHiddenOptions: saved?.hiddenOptions ?? [],
      savedOptionLabels: saved?.optionLabels ?? {},
      savedOptionOrder: saved?.optionOrder ?? [],
      savedSectionTitle: saved?.sectionTitle ?? null,
    };
  });
}

export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertScreeningQuestionsAccess(access);

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
    await assertScreeningQuestionsAccess(access);

    const body = (await request.json()) as {
      key?: string;
      bodyText?: string;
      optionLabels?: Record<string, OptionLabel>;
      hiddenOptions?: string[];
      optionOrder?: string[];
      appliesToRoleFamilies?: string[] | null;
      buttonLabel?: string | null;
      sectionTitle?: string | null;
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
    // WHO IS ASKED — four wire states, and the difference between the first two is the point.
    //   field ABSENT -> leave the stored audience alone. This is what a client that predates the
    //                   control sends, and what the screen's Reset-wording button sends, so a reset
    //                   cannot silently widen a question somebody narrowed.
    //   null         -> clear it, so the question goes back to its CODE default.
    //   []           -> asked to everyone. Beats the code default; the only way to widen `area`.
    //   [a, b]       -> asked to those job titles only.
    // Membership is NOT checked here: audienceViolations owns that vocabulary, so the admin gets one
    // message naming the bad job title rather than a generic 400 from this parser.
    const audience =
      body.appliesToRoleFamilies === undefined
        ? undefined
        : {
            value:
              body.appliesToRoleFamilies === null
                ? undefined
                : body.appliesToRoleFamilies.map((family) => String(family ?? "").trim()).filter(Boolean),
          };

    await saveQuestionPrompt({
      actorHrId: access.hrId ?? null,
      allowedValues,
      audience,
      bodyText: String(body.bodyText ?? ""),
      // Blank or absent is "keep the code's own" — the store reads both that way, so a client that
      // predates these two boxes sends nothing and changes nothing, and the reset button's empty
      // payload clears them along with the rest of the row.
      buttonLabel: typeof body.buttonLabel === "string" ? body.buttonLabel : null,
      defaultOfferedValues,
      hiddenOptions: Array.isArray(body.hiddenOptions) ? body.hiddenOptions : [],
      key,
      optionLabels: body.optionLabels ?? {},
      optionOrder: Array.isArray(body.optionOrder) ? body.optionOrder : [],
      sectionTitle: typeof body.sectionTitle === "string" ? body.sectionTitle : null,
    });

    // A built-in question re-scoped to other roles changes what each person still owes.
    await afterResponse("question_prompts_recompute_completeness", () => recomputeCompletenessForRoles(null));

    const overrides = await loadQuestionPromptOverrides();
    return NextResponse.json({ prompts: promptsWithOverrides(overrides) });
  } catch (error) {
    return failure(error, "question_prompt_save_failed");
  }
}
