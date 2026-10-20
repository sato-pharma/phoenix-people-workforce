import { redirect } from "next/navigation";

import { CvDatabaseManager } from "@/components/cv/cv-database-manager";
import {
  EmployeePortalEmptyState,
  EmployeePortalPageShell,
} from "@/components/employee-portal/enterprise-shell";
import { canAccess, isHrAuthorityRole, resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { cvLibraryRowsFromCandidates } from "@/lib/cv/cv-library";
import { listCandidates } from "@/lib/recruitment/candidates";
import { fenceRowsByCandidate } from "@/lib/recruitment/workspace/fence";
import { listScreeningQuestions } from "@/lib/recruitment/inbound/whatsapp-screening-questions-admin";

export const dynamic = "force-dynamic";

// Portal mirror of app/(admin)/cv-database/page.tsx — same loader, same rows, so the two shells
// cannot show different candidates.
export default async function EmployeePortalCvDatabasePage() {
  const access = await resolveAccessContextFromPage();
  if (resolveNavigationMode(access) !== "employee-portal") {
    redirect("/cv-database");
  }
  // recruitment:read, not vacancies:read — the admin copy's header carries the reasoning and the
  // measurement. The two gates must stay identical, or this shell becomes the way around that one.
  if (!isHrAuthorityRole(access.role) || !(await canAccess(access, "recruitment", "read"))) {
    return (
      <EmployeePortalEmptyState
        message="The CV database is available to the Talent Acquisition seat and the Super Admin only."
        title="CV Database Unavailable"
      />
    );
  }

  // The slim read: no CV Database row reads the repeating CV blocks, which are 59% of the pool's bytes.
  const [everyone, screeningQuestions] = await Promise.all([listCandidates({ withRepeatingCvBlocks: false }), listScreeningQuestions()]);
  // The Talent Acquisition fence (owner, 2026-10-20): an HR applicant is not in her CV database.
  const candidates = await fenceRowsByCandidate(access, everyone, (candidate) => candidate.id);
  const questionLabels = new Map(screeningQuestions.map((question) => [question.questionKey, question.bodyText]));
  const rows = cvLibraryRowsFromCandidates(candidates, questionLabels);

  return (
    <EmployeePortalPageShell
      badge="Recruitment & Hiring"
      description="Browse and search the candidate CV database."
      errorBoundaryTitle="CV Database unavailable"
      title="CV Database"
    >
      <CvDatabaseManager rows={rows} />
    </EmployeePortalPageShell>
  );
}
