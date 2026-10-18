import { ListChecks } from "lucide-react";

import { AdminInsightChip } from "@/components/admin/admin-design-system";
import { BuiltInQuestionsEditor, type BuiltInPromptRow } from "@/components/admin/built-in-questions-editor";
import { ScreeningQuestionsManager } from "@/components/admin/screening-questions-manager";
import {
  WhatsAppAutoRepliesEditor,
  type AutoReplyEditorRow,
} from "@/components/admin/whatsapp-auto-replies-editor";
import { RecruitmentPageHeader } from "@/components/recruitment/recruitment-premium";
import { resolveAuthenticatedPageAccess } from "@/lib/auth/page-access";
import { listAutoReplies } from "@/lib/recruitment/inbound/whatsapp-auto-replies-catalogue";
import { builtInPrompts } from "@/lib/recruitment/inbound/whatsapp-question-prompts";
import { loadQuestionPromptOverrides } from "@/lib/recruitment/inbound/whatsapp-question-prompts-store";
import {
  assertScreeningQuestionsAccess,
  listScreeningQuestions,
  type ScreeningQuestionAdminRow,
} from "@/lib/recruitment/inbound/whatsapp-screening-questions-admin";

export const dynamic = "force-dynamic";

/**
 * One screen, the whole WhatsApp conversation, in the order an applicant meets it:
 *
 *   1. the SIX BUILT-IN questions — question and answers both reworded here, never re-VALUED;
 *   2. the EXTRA questions — created here from scratch, asked after those six;
 *   3. the AUTOMATIC REPLIES the bot sends by itself — the ask-for-a-CV messages that come before
 *      any question, and the first and last lines of the closing summary that comes after them.
 *
 * Three stores on purpose. Copying the six into the extra-question table would have asked every
 * applicant all six a second time, and the automatic replies are not questions at all — nothing is
 * asked and no answer is recorded, so they carry no audience and no options.
 *
 * SECTION 3 EXISTS BECAUSE OF THE OWNER'S 2026-10-03 RULING. Asked which of the WhatsApp messages he
 * wanted reworded, he answered "i want to be in control to freely edit them through phoenix
 * anytime". Before that, those four messages lived in three source files, so changing one sentence a
 * member of the public reads meant a pull request, a CI round and a deploy.
 */
export default async function ScreeningQuestionsPage() {
  let questions: ScreeningQuestionAdminRow[] = [];
  let prompts: BuiltInPromptRow[] = [];
  let autoReplies: AutoReplyEditorRow[] = [];
  let initialError: string | null = null;

  try {
    const access = await resolveAuthenticatedPageAccess();
    // `recruitment:update`, falling back to `admin:update` — see assertScreeningQuestionsAccess.
    // Asserted here as well as in the three routes behind it, because a page that renders the
    // builder and then fails on save is worse than one that never renders it.
    await assertScreeningQuestionsAccess(access);
    questions = await listScreeningQuestions();

    const overrides = await loadQuestionPromptOverrides();
    prompts = builtInPrompts().map((prompt) => {
      const saved = overrides.get(prompt.key);
      return {
        ...prompt,
        isCustomised: Boolean(saved),
        savedAppliesToRoleFamilies: saved?.appliesToRoleFamilies ?? null,
        savedBody: saved?.body ?? null,
        savedButtonLabel: saved?.buttonLabel ?? null,
        savedHiddenOptions: saved?.hiddenOptions ?? [],
        savedOptionLabels: saved?.optionLabels ?? {},
        savedOptionOrder: saved?.optionOrder ?? [],
        savedSectionTitle: saved?.sectionTitle ?? null,
      };
    });

    // Its own read, not inside the try's earlier awaits by accident: the catalogue's saved half is
    // best-effort in the store, so the editor renders on the code defaults even when the table is
    // unreachable or not yet migrated.
    autoReplies = await listAutoReplies();
  } catch (error) {
    initialError = error instanceof Error ? error.message : "Screening questions failed to load.";
  }

  return (
    <div className="space-y-8 p-4 sm:p-6">
      {/* The chips name only what cannot change while the page is open — the six built-in questions
          and the automatic replies are fixed sets; the extra questions are counted by their own
          editor, which is the one that adds and removes them. */}
      <RecruitmentPageHeader
        badges={
          prompts.length > 0 || autoReplies.length > 0 ? (
            <>
              {prompts.length > 0 ? (
                <AdminInsightChip tone="orange">
                  {prompts.length === 1 ? "1 built-in question" : `${prompts.length} built-in questions`}
                </AdminInsightChip>
              ) : null}
              {autoReplies.length > 0 ? (
                <AdminInsightChip>
                  {autoReplies.length === 1 ? "1 automatic reply" : `${autoReplies.length} automatic replies`}
                </AdminInsightChip>
              ) : null}
              <AdminInsightChip tone="slate">Saved wording goes out on the next reply</AdminInsightChip>
            </>
          ) : undefined
        }
        description="The whole WhatsApp conversation an applicant has with the bot, in the order they meet it: the six built-in questions, the extra questions you add, and the messages the bot sends by itself."
        icon={<ListChecks aria-hidden="true" className="h-3.5 w-3.5" />}
        title="Screening Questions"
      />
      {prompts.length > 0 ? <BuiltInQuestionsEditor initialPrompts={prompts} /> : null}
      <ScreeningQuestionsManager embedded initialError={initialError} initialQuestions={questions} />
      {autoReplies.length > 0 ? <WhatsAppAutoRepliesEditor initialReplies={autoReplies} /> : null}
    </div>
  );
}
