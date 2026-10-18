import { redirect } from "next/navigation";
import { Suspense } from "react";
import { Users } from "lucide-react";

import { PageContainer } from "@/components/layout/page-container";
import { AdminInsightChip } from "@/components/admin/admin-design-system";
import { RecruitmentPageHeader } from "@/components/recruitment/recruitment-premium";
import { AppRouteLoadingState } from "@/components/ui/loading-state";
import { RecruitmentCandidatesPortal } from "@/components/employee-portal/recruitment-candidates-portal";
import { canAccess, canOpenPersonalCandidateInbox } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { listApplications } from "@/lib/recruitment/applications";
import {
  redactCandidateContact,
  revealPhoneToViewer,
} from "@/lib/recruitment/candidate-call-claims";
import { loadCallClaims } from "@/lib/recruitment/candidate-call-claims-db";
import { loadCandidateOpeners } from "@/lib/recruitment/candidate-openers-db";
import { listCandidateFolderAreaOptions } from "@/lib/recruitment/candidate-folder-options";
import { listCandidateViews } from "@/lib/recruitment/candidate-views";
import { listCandidatesSentToManager } from "@/lib/recruitment/candidates";
import { unseenIdsOnBoards } from "@/lib/recruitment/manager-cv-folders";
import {
  districtBoardCandidateIds,
  listDistrictBoardsForManager,
} from "@/lib/recruitment/district-manager-folders-db";
import { listCandidateCardFiles } from "@/lib/recruitment/files";
import { listViewerTeamManagers } from "@/lib/recruitment/hiring-manager-team";
import { listManagerFolderFilings } from "@/lib/recruitment/manager-folders";

export const dynamic = "force-dynamic";

// CEO's entry point onto the same candidate-tracking surface District Manager/Regional
// Manager/National Sales Manager reach via the employee portal — CEO's primary surface is
// the admin shell, not the employee portal, so this is a thin admin-shell wrapper around
// the exact same RecruitmentCandidatesPortal component, not a new UI.
export default async function AdminRecruitmentCandidatesPage() {
  const access = await resolveAccessContextFromPage();

  if (!canOpenPersonalCandidateInbox(access) || !(await canAccess(access, "hiring_interviews", "read"))) {
    redirect("/overview");
  }

  return (
    <Suspense
      fallback={
        <AppRouteLoadingState
          description="Preparing your candidates and interview rounds."
          title="Loading Candidates"
        />
      }
    >
      <AdminRecruitmentCandidatesContent />
    </Suspense>
  );
}

async function AdminRecruitmentCandidatesContent() {
  const access = await resolveAccessContextFromPage();
  // Already scoped: listApplications() filters to only the requisitions this caller is
  // the hiring manager (or recruitment owner) for — see canSeeApplication in
  // src/lib/recruitment/access.ts. A candidate outside the CEO's own round never appears.
  //
  // The second list is the direct push, scoped by the caller's own HR_ID. It is loaded here as well
  // as on the portal twin because the CEO's job title matches the manager list a recruiter picks
  // from, so a CV can be sent straight to them — and this admin page is where the CEO would look.
  // The third list is the team picker the owner asked for on 2026-08-30 for the National Sales
  // Manager. It is loaded here too, and that is not scope creep: it is derived from where the caller
  // sits on the org chart rather than from their role, and the CEO sits directly above both people
  // holding an NSM seat. Restricting it to the portal twin would mean the one person above them
  // could not do what they can.
  // The fourth and fifth are this caller's own CV shelf and the picker that fills it — the folders
  // the owner asked for on 2026-08-30. Loaded here for the same reason the team picker is: this page
  // is the same component, and a CEO who could file on the portal but not here would have two
  // inboxes that disagree about which CVs are still waiting on him.
  // The sixth is the district boards — one folder per area this caller holds in the organogram.
  // Loaded here for the third time on the same argument the two paragraphs above make: this page
  // renders the identical component, and the component treats an empty board list as "this caller
  // holds no areas". Leaving it out here would not hide the folders politely — it would tell a
  // manager who holds ten areas that he has no candidates at all, over folders that are full.
  const [applications, sentToMe, team, filings, areaOptions, districtBoards] = await Promise.all([
    listApplications(access),
    listCandidatesSentToManager(access.hrId),
    listViewerTeamManagers(access),
    listManagerFolderFilings(access.hrId),
    listCandidateFolderAreaOptions(),
    listDistrictBoardsForManager(access.hrId),
  ]);
  const myCandidates = applications.filter((application) => application.candidate && application.requisition);

  // One query for every card's CV file, rather than one request per card after it mounts. Same
  // reason as the portal page: the owner's rule for this screen is that the CV must be openable, and
  // a View/Download control that turns up seconds after the card is one he reported as missing.
  const cardCandidateIds = [
    ...sentToMe.map((candidate) => candidate.id),
    ...myCandidates.map((application) => application.candidate?.id ?? ""),
    // The folders' CVs too. A View CV button that is absent because its file was never fetched is
    // the same defect as no button at all, and the owner reported that one by name.
    ...districtBoardCandidateIds(districtBoards),
  ];

  const initialFiles = await listCandidateCardFiles(cardCandidateIds);

  // The hidden phone number and the "I will call" reservation, exactly as on the portal twin — and
  // for the fourth time on the same argument every paragraph above makes: this page renders the
  // IDENTICAL component. Loading the claims there and not here would leave one copy of this screen
  // where a reserved CV looks free and the number is printed to somebody who never asked for it.
  const callClaims = await loadCallClaims(cardCandidateIds);
  // Who ELSE has already opened each of these CVs (owner, 2026-09-20). Loaded here beside the claims,
  // for the same reason: the banner sits at the top of every card, and a card that had to ask for it
  // would show it late. The viewer's own opens are left out.
  const openers = await loadCandidateOpeners(cardCandidateIds, access.hrId);
  // NO REDACTION ON A CV SENT TO THIS MANAGER (owner, 2026-10-16): once Talent Acquisition has sent
  // it, the number, the file and everything else are his to use. His folders ARE his sends, so both
  // lists below are exactly the CVs that were sent to him. Only the applications he reaches through a
  // requisition he owns, which no person sent him, keep the "I will call" rule.
  const visibleSentToMe = sentToMe;
  const visibleDistrictBoards = districtBoards;
  // Which folder CVs he has not opened since they were sent: the folders pulse for these, and the
  // first folder holding one is open when the page does.
  const views = await listCandidateViews(access.hrId);
  const unseenIds = unseenIdsOnBoards(districtBoards, (candidateId) => views[candidateId]?.lastSeenAt);
  const visibleApplications = myCandidates.map((application) =>
    application.candidate
      ? {
          ...application,
          candidate: redactCandidateContact(
            application.candidate,
            revealPhoneToViewer(callClaims[application.candidate.id] ?? null, access.hrId),
          ),
        }
      : application,
  );

  return (
    <PageContainer>
      <div className="mx-auto max-w-5xl space-y-6">
        <RecruitmentPageHeader
          badges={
            <>
              <AdminInsightChip tone="orange">
                {visibleSentToMe.length === 1 ? "1 CV sent to you" : `${visibleSentToMe.length} CVs sent to you`}
              </AdminInsightChip>
              <AdminInsightChip tone="slate">
                {visibleApplications.length === 1
                  ? "1 in your final round"
                  : `${visibleApplications.length} in your final round`}
              </AdminInsightChip>
              {unseenIds.length > 0 ? (
                <AdminInsightChip tone="emerald">
                  {unseenIds.length === 1 ? "1 not opened yet" : `${unseenIds.length} not opened yet`}
                </AdminInsightChip>
              ) : null}
            </>
          }
          description="CVs sent to you, and candidates in your final hiring round — read the CV, answer, and record your interview outcome."
          eyebrow="Hiring"
          icon={<Users aria-hidden="true" className="h-3.5 w-3.5" />}
          title="My Candidates"
        />
        <RecruitmentCandidatesPortal
          areaOptions={areaOptions}
          initialApplications={visibleApplications}
          initialCallClaims={callClaims}
          initialDistrictBoards={visibleDistrictBoards}
        initialUnseenIds={unseenIds}
          initialFilings={filings}
          initialFiles={initialFiles}
          initialOpeners={openers}
          initialSentToMe={visibleSentToMe}
          initialTeam={team}
          viewerHrId={access.hrId}
        />
      </div>
    </PageContainer>
  );
}
