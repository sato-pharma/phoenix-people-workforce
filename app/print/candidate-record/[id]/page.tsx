import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";

import { CandidateRecordPrint } from "@/components/recruitment/candidate-record-print";
import { canAccess, isHrAuthorityRole } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { candidateRecordPrintHref, parseCandidatePageId } from "@/lib/recruitment/candidate-page-link";
import { satoLogoDataUri } from "@/lib/offers/brand";
import { buildCandidateRecordBodyHtml } from "@/lib/recruitment/candidate-record-print";
import { candidateRecordPrintCss } from "@/lib/recruitment/candidate-record-print-css";
import { loadCandidateRecordPrint } from "@/lib/recruitment/candidate-record-print-loader";
import { candidateHiddenFrom } from "@/lib/recruitment/workspace/fence";

export const dynamic = "force-dynamic";

// A printed record holds a person's name, phone, email, salary and every note written about them. It
// must never be indexed or cached by anything between the server and the reader.
export const metadata: Metadata = {
  robots: { follow: false, index: false, nocache: true },
  title: "Candidate record — Phoenix",
};

/**
 * The page "Print record" opens, from a candidate's own page (the owner, 2026-09-19).
 *
 * DELIBERATELY OUTSIDE BOTH SHELLS, for the reason written on the WhatsApp application's print page
 * (app/print/whatsapp-application): the paper must hold the record and nothing else, and the cost of
 * leaving the shell is that its sign-in and role redirects are repeated here. They are the SAME gate as
 * the candidate page that offers the button — an HR authority role with recruitment:read, plus the
 * candidates grant, because the sheet is everything the system holds on a named person.
 *
 * READ-ONLY. Opening this page does not mark the CV as seen and does not write anything; the record is
 * read the way the candidate page reads it, and a part that cannot be read is named on the sheet
 * instead of being printed as though it were empty.
 */
export default async function CandidateRecordPrintPage({ params }: { params: Promise<{ id: string }> }) {
  const { id: rawId } = await params;
  const id = parseCandidatePageId(rawId);
  if (!id) notFound();

  const access = await resolveAccessContextFromPage();
  if (!access.loginId && !access.hrId) {
    redirect(`/login?returnUrl=${encodeURIComponent(candidateRecordPrintHref(id))}`);
  }
  if (
    !isHrAuthorityRole(access.role) ||
    !(await canAccess(access, "recruitment", "read")) ||
    !(await canAccess(access, "candidates", "read"))
  ) {
    redirect("/employee-portals");
  }

  // The Talent Acquisition fence (owner, 2026-10-20): an HR applicant's sheet is "not found", read or not.
  if (await candidateHiddenFrom(access, id)) notFound();
  const record = await loadCandidateRecordPrint(id);
  if (!record) notFound();

  return (
    <CandidateRecordPrint
      css={candidateRecordPrintCss(record.printedLabel)}
      html={buildCandidateRecordBodyHtml(record, satoLogoDataUri())}
      name={record.name}
    />
  );
}
