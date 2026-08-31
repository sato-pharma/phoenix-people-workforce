import { redirect } from "next/navigation";

import { CvDatabaseManager } from "@/components/cv/cv-database-manager";
import { canAccess, isHrAuthorityRole } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { cvLibraryRowsFromCandidates } from "@/lib/cv/cv-library";
import { listCandidates } from "@/lib/recruitment/candidates";
import { listScreeningQuestions } from "@/lib/recruitment/inbound/whatsapp-screening-questions-admin";

export const dynamic = "force-dynamic";

// The CV Database reads the SAME loader the Candidates pool reads, so the two screens can never
// disagree about who has applied. It used to hold nothing but whatever .xlsx the user had uploaded
// into React state that minute — 0 rows on load, forgotten on reload, sharing no data with the 562
// candidates next door.
export default async function CvDatabasePage() {
  const access = await resolveAccessContextFromPage();
  if (!isHrAuthorityRole(access.role) || !(await canAccess(access, "vacancies", "read"))) {
    redirect("/employee-portals");
  }

  const [candidates, screeningQuestions] = await Promise.all([listCandidates(), listScreeningQuestions()]);
  // Active AND retired — a retired question's already-recorded answers must still show a real label.
  const questionLabels = new Map(screeningQuestions.map((question) => [question.questionKey, question.bodyText]));
  const rows = cvLibraryRowsFromCandidates(candidates, questionLabels);

  return (
    <CvDatabaseManager rows={rows} />
  );
}
