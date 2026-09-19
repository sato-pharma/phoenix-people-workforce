import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";

import { WhatsAppApplicationPrint } from "@/components/recruitment/whatsapp-application-print";
import { canAccess, isHrAuthorityRole } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { isUuid } from "@/lib/http/uuid";
import { whatsAppApplicationPrintPath } from "@/lib/recruitment/whatsapp-application-file";

export const dynamic = "force-dynamic";

// A printed application holds a person's name, phone, email and CV. It must never be indexed or cached
// by anything between the server and the reader.
export const metadata: Metadata = {
  robots: { follow: false, index: false, nocache: true },
  title: "WhatsApp application — Phoenix",
};

/**
 * The page "Print application" opens, from WhatsApp Applicants (the owner, 2026-09-19).
 *
 * DELIBERATELY OUTSIDE BOTH SHELLS. It sits under /print, not (admin), because the sheet of paper must
 * hold the application and nothing else: no sidebar, no top bar, no chat button to hide with print rules
 * one by one. The cost of leaving the shell is that the shell's own sign-in and role redirects are gone,
 * so they are repeated here, and they are the SAME gate as the list that offers the button: an HR
 * authority role with recruitment:read, plus the candidates grant, because the page names a person and
 * draws their CV. The route that builds the file (app/api/recruitment/whatsapp-applicants/[sessionId]/
 * application) enforces the same three, so a link opened without them draws nothing either way.
 *
 * The id is a WhatsApp conversation. It names nobody: the route finds the person from it and answers
 * "not found" for anything that is not a listed applicant.
 */
export default async function WhatsAppApplicationPrintPage({ params }: { params: Promise<{ sessionId: string }> }) {
  const { sessionId } = await params;
  if (!isUuid(sessionId)) notFound();

  const access = await resolveAccessContextFromPage();
  if (!access.loginId && !access.hrId) {
    redirect(`/login?returnUrl=${encodeURIComponent(whatsAppApplicationPrintPath(sessionId))}`);
  }
  if (
    !isHrAuthorityRole(access.role) ||
    !(await canAccess(access, "recruitment", "read")) ||
    !(await canAccess(access, "candidates", "read"))
  ) {
    redirect("/employee-portals");
  }

  return <WhatsAppApplicationPrint sessionId={sessionId} />;
}
