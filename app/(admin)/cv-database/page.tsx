import { redirect } from "next/navigation";

import { CvDatabaseManager } from "@/components/cv/cv-database-manager";
import { canAccess, isHrAuthorityRole } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { cvLibraryRowsFromCandidates } from "@/lib/cv/cv-library";
import { listCandidates } from "@/lib/recruitment/candidates";

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

  const rows = cvLibraryRowsFromCandidates(await listCandidates());

  return (
    <CvDatabaseManager rows={rows} />
  );
}
