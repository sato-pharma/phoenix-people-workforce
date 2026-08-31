import { ScreeningQuestionsManager } from "@/components/admin/screening-questions-manager";
import { resolveAuthenticatedPageAccess } from "@/lib/auth/page-access";
import { assertPermission } from "@/lib/auth/permissions";
import {
  listScreeningQuestions,
  type ScreeningQuestionAdminRow,
} from "@/lib/recruitment/inbound/whatsapp-screening-questions-admin";

export const dynamic = "force-dynamic";

export default async function ScreeningQuestionsPage() {
  let questions: ScreeningQuestionAdminRow[] = [];
  let initialError: string | null = null;

  try {
    const access = await resolveAuthenticatedPageAccess();
    // `admin:update` — the Super Admin alone. Asserted here as well as in the route behind it,
    // because a page that renders the builder and then fails on save is worse than one that never
    // renders it.
    await assertPermission(access, "admin", "update");
    questions = await listScreeningQuestions();
  } catch (error) {
    initialError = error instanceof Error ? error.message : "Screening questions failed to load.";
  }

  return <ScreeningQuestionsManager initialError={initialError} initialQuestions={questions} />;
}
