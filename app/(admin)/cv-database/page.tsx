import { redirect } from "next/navigation";

import { CvDatabaseManager } from "@/components/cv/cv-database-manager";
import { canAccess, isHrAuthorityRole } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { cvLibraryRowsFromCandidates } from "@/lib/cv/cv-library";
import { listCandidates } from "@/lib/recruitment/candidates";
import { fenceRowsByCandidate } from "@/lib/recruitment/workspace/fence";
import { listScreeningQuestions } from "@/lib/recruitment/inbound/whatsapp-screening-questions-admin";

export const dynamic = "force-dynamic";

// The CV Database reads the SAME loader the Candidates pool reads, so the two screens can never
// disagree about who has applied. It used to hold nothing but whatever .xlsx the user had uploaded
// into React state that minute — 0 rows on load, forgotten on reload, sharing no data with the 562
// candidates next door.
//
// GATED ON `recruitment:read`, NOT `vacancies:read` — changed 2026-09-01 at the owner's instruction
// ("block the cv database for her too"). This screen shows the CANDIDATE POOL, so `recruitment` was
// always its real resource; it sat on `vacancies` only because until that day every role inside
// isHrAuthorityRole holding vacancies:read also held recruitment:read, which made the two
// indistinguishable. Granting HR Operations vacancies:read for the Vacancies Report split them
// apart and handed her a recruiting screen nobody asked for.
//
// Measured before the change: nine roles hold vacancies:read without recruitment:read, and
// isHrAuthorityRole already excludes every one of them — so the audience moves from
// {Super Admin, HR Advisory, HR Operations} to {Super Admin, HR Advisory} and nothing else moves.
//
// Hiding the sidebar row is NOT this. That is presentation, and a typed URL walks straight past it;
// this line is the revocation. tests/cv-database-recruiting-boundary.test.ts pins both halves.
export default async function CvDatabasePage() {
  const access = await resolveAccessContextFromPage();
  if (!isHrAuthorityRole(access.role) || !(await canAccess(access, "recruitment", "read"))) {
    redirect("/employee-portals");
  }

  // The slim read: no CV Database row reads the repeating CV blocks, which are 59% of the pool's bytes.
  const [everyone, screeningQuestions] = await Promise.all([listCandidates({ withRepeatingCvBlocks: false }), listScreeningQuestions()]);
  // The Talent Acquisition fence (owner, 2026-10-20): an HR applicant is not in her CV database.
  const candidates = await fenceRowsByCandidate(access, everyone, (candidate) => candidate.id);
  // Active AND retired — a retired question's already-recorded answers must still show a real label.
  const questionLabels = new Map(screeningQuestions.map((question) => [question.questionKey, question.bodyText]));
  const rows = cvLibraryRowsFromCandidates(candidates, questionLabels);

  return (
    <CvDatabaseManager rows={rows} />
  );
}
