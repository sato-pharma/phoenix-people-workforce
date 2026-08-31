import { BuiltInQuestionsEditor, type BuiltInPromptRow } from "@/components/admin/built-in-questions-editor";
import { ScreeningQuestionsManager } from "@/components/admin/screening-questions-manager";
import { resolveAuthenticatedPageAccess } from "@/lib/auth/page-access";
import { assertPermission } from "@/lib/auth/permissions";
import { builtInPrompts } from "@/lib/recruitment/inbound/whatsapp-question-prompts";
import { loadQuestionPromptOverrides } from "@/lib/recruitment/inbound/whatsapp-question-prompts-store";
import {
  listScreeningQuestions,
  type ScreeningQuestionAdminRow,
} from "@/lib/recruitment/inbound/whatsapp-screening-questions-admin";

export const dynamic = "force-dynamic";

/**
 * One screen, the whole WhatsApp conversation, in the order an applicant meets it:
 *
 *   1. the SIX BUILT-IN questions — question and answers both reworded here, never re-VALUED;
 *   2. the EXTRA questions — created here from scratch, asked after those six.
 *
 * They are two stores on purpose. Copying the six into the extra-question table would have asked
 * every applicant all six a second time.
 */
export default async function ScreeningQuestionsPage() {
  let questions: ScreeningQuestionAdminRow[] = [];
  let prompts: BuiltInPromptRow[] = [];
  let initialError: string | null = null;

  try {
    const access = await resolveAuthenticatedPageAccess();
    // `admin:update` — the Super Admin alone. Asserted here as well as in the two routes behind it,
    // because a page that renders the builder and then fails on save is worse than one that never
    // renders it.
    await assertPermission(access, "admin", "update");
    questions = await listScreeningQuestions();

    const overrides = await loadQuestionPromptOverrides();
    prompts = builtInPrompts().map((prompt) => {
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
  } catch (error) {
    initialError = error instanceof Error ? error.message : "Screening questions failed to load.";
  }

  return (
    <div className="space-y-8 p-6">
      {prompts.length > 0 ? <BuiltInQuestionsEditor initialPrompts={prompts} /> : null}
      <ScreeningQuestionsManager embedded initialError={initialError} initialQuestions={questions} />
    </div>
  );
}
