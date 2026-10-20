import { AlertTriangle, MessageSquareText, ShieldAlert } from "lucide-react";
import { redirect } from "next/navigation";

import { AdminInsightChip } from "@/components/admin/admin-design-system";
import { adminSoftDepthClassName } from "@/components/admin/admin-design-tokens";
import { PageContainer } from "@/components/layout/page-container";
import {
  RecruitmentEmptyState,
  RecruitmentPageHeader,
  RecruitmentPanel,
} from "@/components/recruitment/recruitment-premium";
import { WhatsAppApplicantsSearch } from "@/components/recruitment/whatsapp-applicants-search";
import { WhatsAppCvArchive } from "@/components/recruitment/whatsapp-cv-archive";
import { canAccess, isHrAuthorityRole } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { loadWhatsAppApplicantsView } from "@/lib/recruitment/whatsapp-applicants-loader";
import { loadWhatsAppCvArchiveView } from "@/lib/recruitment/whatsapp-cv-archive-loader";

export const dynamic = "force-dynamic";

// WhatsApp Applicants — everyone who sent a CV on WhatsApp and started the bot's questions,
// searchable by the questions themselves.
//
// The owner, 2026-09-18: "a new page in recruitment module ... the first filter will be job position
// ... based on the title, the next questions of the WhatsApp appear as filters. For example, I want
// to search for an office coordinator that is living in Cairo and has 25 years. And don't edit any
// page currently available." So this is a page of its own, and no existing page was changed. What
// each row and filter means is in src/lib/recruitment/whatsapp-applicants.ts.
//
// Gated exactly as its sibling Returned CVs is, isHrAuthorityRole AND recruitment:read, and both nav
// rows carry the same recruitment clause, so a row is never offered to someone the page would turn
// away (tests/every-offered-link-opens.test.ts). Every row names a candidate and opens their CV, and
// that is the candidates grant. So a viewer without it is told so instead of being shown the list.
export default async function WhatsAppApplicantsPage() {
  const access = await resolveAccessContextFromPage();
  if (!isHrAuthorityRole(access.role) || !(await canAccess(access, "recruitment", "read"))) {
    redirect("/employee-portals");
  }
  const canViewCandidates = await canAccess(access, "candidates", "read");
  // Whether this reader may mark Shortlist / Reject / Pending straight from this page — the same
  // authority the screening page already requires to write a status
  // (PATCH /api/recruitment/candidates/[id]/status). The route re-checks it itself; this only
  // decides whether the buttons are worth drawing.
  const canDecide = await canAccess(access, "candidates", "update");
  // The Archive (owner, 2026-10-18): the old WhatsApp applicants kept when the CVs received before
  // 11 October were cleaned out. Not candidates, so it sits under the search, never inside it, and
  // takes the same candidates grant because every row opens a CV. Its read settles on its own: an
  // Archive that cannot be read says so, and never takes the applicants list down with it.
  const [view, archive] = canViewCandidates
    ? await Promise.all([
        // The Talent Acquisition fence (owner, 2026-10-20) rides in the viewer on both reads.
        loadWhatsAppApplicantsView({ access }),
        loadWhatsAppCvArchiveView({ access }).catch((error: unknown) => {
          console.error("[whatsapp-applicants] the WhatsApp CV Archive could not be read", error);
          return "unavailable" as const;
        }),
      ])
    : [null, null];

  // The header's chips count what the one read above already holds — nothing extra is fetched for them.
  const applications = view ? view.rows.length : null;
  const titles = view ? view.titles.length : null;
  const archived = archive && archive !== "unavailable" ? archive.people : null;

  return (
    <PageContainer>
      <RecruitmentPageHeader
        badges={
          applications !== null && titles !== null ? (
            <>
              <AdminInsightChip tone="orange">
                {applications === 1 ? "1 application" : `${applications} applications`}
              </AdminInsightChip>
              <AdminInsightChip>{titles === 1 ? "1 job title" : `${titles} job titles`}</AdminInsightChip>
              {archived ? (
                <AdminInsightChip tone="slate">
                  {archived === 1 ? "1 person in the Archive" : `${archived} people in the Archive`}
                </AdminInsightChip>
              ) : null}
            </>
          ) : undefined
        }
        description="Everyone who sent a CV on WhatsApp and answered at least the first question. Choose a job title, then narrow the list with the questions that title was asked."
        icon={<MessageSquareText aria-hidden="true" className="h-3.5 w-3.5" />}
        title="WhatsApp Applicants"
      />
      {view && archive ? (
        <>
          <WhatsAppApplicantsSearch canDecide={canDecide} view={view} />
          {archive === "unavailable" ? (
            <div
              className={`flex items-start gap-3 border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900 ${adminSoftDepthClassName}`}
              role="status"
            >
              <AlertTriangle aria-hidden="true" className="mt-0.5 h-4 w-4 flex-none text-amber-600" />
              <p className="min-w-0 break-words">
                <span className="font-bold">The Archive is unavailable.</span> The Archive of older WhatsApp CVs could
                not be read just now. Reload the page to try again.
              </p>
            </div>
          ) : (
            <WhatsAppCvArchive view={archive} />
          )}
        </>
      ) : (
        <RecruitmentPanel icon={<ShieldAlert aria-hidden="true" className="h-4 w-4" />} title="Candidates are not shared with you">
          <RecruitmentEmptyState
            icon={<ShieldAlert aria-hidden="true" className="h-5 w-5" />}
            message="This list names candidates and opens their CVs, and your account cannot view candidates."
            title="This list is not open to your account"
          />
        </RecruitmentPanel>
      )}
    </PageContainer>
  );
}
