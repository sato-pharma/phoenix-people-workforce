import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";

import { CandidateApplicationPrint } from "@/components/recruitment/whatsapp-application-print";
import { canAccess, isHrAuthorityRole } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { isUuid } from "@/lib/http/uuid";
import { candidateApplicationPrintPath } from "@/lib/recruitment/whatsapp-application-file";
import { candidateHiddenFrom } from "@/lib/recruitment/workspace/fence";

export const dynamic = "force-dynamic";

// A printed application holds a person's name, phone, email and CV. It must never be indexed or cached by
// anything between the server and the reader.
export const metadata: Metadata = {
  robots: { follow: false, index: false, nocache: true },
  title: "Application — Phoenix",
};

/**
 * The page "Print application" opens from the SCREENING page (the owner, 2026-09-26: on any CV, not only the
 * WhatsApp applicants). It is the candidate-keyed twin of /print/whatsapp-application/[sessionId].
 *
 * DELIBERATELY OUTSIDE BOTH SHELLS, under /print, so the paper holds the application and nothing else — no
 * sidebar, no top bar. The cost is that the shell's sign-in and role redirects are gone, so they are
 * repeated here, and they are the SAME gate as the screening page that offers the button: an HR authority
 * role with recruitment:read, plus the candidates grant, because the page names a person and draws their CV.
 * The route that builds the file (app/api/recruitment/candidates/[id]/application) enforces the same three, so
 * a link opened without them draws nothing either way.
 *
 * The id is a candidate. The route finds the person and answers "not found" for anything that is not one.
 */
export default async function CandidateApplicationPrintPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isUuid(id)) notFound();

  const access = await resolveAccessContextFromPage();
  if (!access.loginId && !access.hrId) {
    redirect(`/login?returnUrl=${encodeURIComponent(candidateApplicationPrintPath(id))}`);
  }
  if (
    !isHrAuthorityRole(access.role) ||
    !(await canAccess(access, "recruitment", "read")) ||
    !(await canAccess(access, "candidates", "read"))
  ) {
    redirect("/employee-portals");
  }

  // The Talent Acquisition fence (owner, 2026-10-20): the route behind this sheet answers 404 for an HR
  // applicant; the page says the same before it draws anything.
  if (await candidateHiddenFrom(access, id)) notFound();

  return <CandidateApplicationPrint candidateId={id} />;
}
