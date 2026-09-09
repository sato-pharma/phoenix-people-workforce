import { redirect } from "next/navigation";

import {
  EmployeePortalEmptyState,
  EmployeePortalPageShell,
} from "@/components/employee-portal/enterprise-shell";
import { RecruitmentCandidatesPortal } from "@/components/employee-portal/recruitment-candidates-portal";
import { canAccess, resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { listApplications } from "@/lib/recruitment/applications";
import {
  redactCandidateContact,
  redactCandidateListContact,
  redactDistrictBoardsContact,
  revealPhoneToViewer,
} from "@/lib/recruitment/candidate-call-claims";
import { loadCallClaims } from "@/lib/recruitment/candidate-call-claims-db";
import { loadOutstandingFeedback } from "@/lib/recruitment/cv-feedback-lock-db";
import { listCandidateFolderAreaOptions } from "@/lib/recruitment/candidate-folder-options";
import { listCandidatesSentToManager } from "@/lib/recruitment/candidates";
import {
  districtBoardCandidateIds,
  listDistrictBoardsForManager,
} from "@/lib/recruitment/district-manager-folders-db";
import { listCandidateCardFiles } from "@/lib/recruitment/files";
import { listViewerTeamManagers } from "@/lib/recruitment/hiring-manager-team";
import { listManagerFolderFilings } from "@/lib/recruitment/manager-folders";

export const dynamic = "force-dynamic";

export default async function EmployeePortalRecruitmentCandidatesPage() {
  const access = await resolveAccessContextFromPage();

  if (resolveNavigationMode(access) !== "employee-portal") {
    redirect("/overview");
  }

  if (!(await canAccess(access, "hiring_interviews", "read"))) {
    return (
      <EmployeePortalEmptyState
        message="Candidate review is available for roles that own a hiring seat (District Manager and other line/area managers) once the recruitment team sends them a CV or assigns a candidate to one of their open positions."
        title="Candidates Unavailable"
      />
    );
  }

  // Two lists, two routes into this screen, and the second one is the reason it now works.
  //
  //   • applications — already scoped: listApplications() filters to only the requisitions this
  //     caller is the hiring manager (or recruitment owner) for, see canSeeApplication in
  //     src/lib/recruitment/access.ts. Taken 7 times in the module's history.
  //   • sentToMe — the CVs a recruiter pushed straight to this caller with no requisition in
  //     between. Scoped by the caller's own HR_ID inside listCandidatesSentToManager. This is the
  //     flow the owner actually asked for, and until now the notification for it deep-linked to the
  //     CV database, which answers a District Manager with "available to Talent Acquisition and
  //     Super Admin only".
  //   • team — the managers who report to this caller, and how many CVs sit with each. Added
  //     2026-08-30 at the owner's request: "the National Sales Manager can choose any of these
  //     district managers and see all the CVs in his portal". Empty for anybody who manages nobody,
  //     which is most callers who reach this screen, and the component renders nothing at all then.
  //   • filings — what THIS manager has kept for later, on his own shelf. The owner, 2026-08-30:
  //     "and I want him to have a folders like like me". Read from ats_candidate_manager_folders,
  //     never from the candidate row: the recruitment team's own filing hides a CV from every
  //     recruiter, and a District Manager tidying his inbox must not do that. See
  //     manager-folder-shelf.ts.
  //   • areaOptions — the area list for the folder picker, tagged with each area's RECRUITMENT
  //     region (which is not always its sales region — the Delta (3) split). Loaded here because it
  //     reads the org chart and the portal component is "use client".
  //   • districtBoards — one folder per area this caller holds in the organogram, filled with the
  //     CVs of applicants who asked for that area. The owner, 2026-08-31: "you will make a folder
  //     per district manager. Each folder has his areas ... he click the folder and open he find all
  //     CVs." Scoped to his own seats, and empty for anybody who holds none.
  const [applications, sentToMe, team, filings, areaOptions, districtBoards] = await Promise.all([
    listApplications(access),
    listCandidatesSentToManager(access.hrId),
    listViewerTeamManagers(access),
    listManagerFolderFilings(access.hrId),
    listCandidateFolderAreaOptions(),
    listDistrictBoardsForManager(access.hrId),
  ]);
  const myCandidates = applications.filter((application) => application.candidate && application.requisition);

  // The CV files for every card on this page, in one query, before anything renders.
  //
  // "He must be able to screen and must have a button to download the CV or to view it. It is a
  // must." — the owner, 2026-08-30. The button existed before this and still failed that test: each
  // card asked for its own files after mounting, and eleven cards meant eleven requests, so the
  // control appeared long after the card it belongs to. A control that arrives that late is missing.
  //
  // Nothing is widened by loading it here. Both lists are already scoped — `sentToMe` by this
  // caller's own HR_ID, `myCandidates` by listApplications' own hiring-manager filter — so these are
  // the files of CVs this caller was already entitled to open, fetched once instead of one by one.
  const cardCandidateIds = [
    ...sentToMe.map((candidate) => candidate.id),
    ...myCandidates.map((application) => application.candidate?.id ?? ""),
    // The district folders' CVs too, and for the same reason: a folder whose cards have no View CV
    // button is a folder a manager cannot use. Deduplicated — one applicant can sit in three
    // managers' folders and in this caller's own sent list at once.
    ...districtBoardCandidateIds(districtBoards),
  ];

  const initialFiles = await listCandidateCardFiles(cardCandidateIds);

  // ── WHO HAS SAID "I WILL CALL", AND THE PHONE NUMBERS THAT GO WITH IT ─────────────────────────
  //
  // The owner, 2026-09-09: *"on every cv i want the phone number to be hidden ... if pressed I will
  // call then every other manager receiving this CV when open the same CV shows that Ahmed will call
  // this CV."*
  //
  // THE REDACTION HAPPENS HERE, ON THE SERVER, and that is the whole security of it. Hiding a field
  // in JSX leaves the number sitting in the page payload for anyone who opens the network tab, which
  // is not hiding it. Every list this page renders goes through the same redactor, against the same
  // claims, so a number can only reach the browser of the ONE manager holding the reservation.
  //
  // All three lists, and the third is the one that is easy to forget: the district folders carry
  // their candidates nested two levels down, so they get their own redactor rather than a hand-
  // written map that would eventually cover the cards and miss the folders.
  const callClaims = await loadCallClaims(cardCandidateIds);

  // THE CV HE OPENED AND HAS NOT WRITTEN ABOUT. Owner, 2026-09-09: candidates are being telephoned
  // twice because nothing records that anyone called, so a manager must write what he found before
  // he may open another CV. Read once here rather than per card; it fails open on any error, so a
  // database problem can never lock a manager out of every CV in the company.
  const outstandingFeedback = await loadOutstandingFeedback(access.hrId);
  const visibleSentToMe = redactCandidateListContact(sentToMe, callClaims, access.hrId);
  const visibleDistrictBoards = redactDistrictBoardsContact(districtBoards, callClaims, access.hrId);
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
    <EmployeePortalPageShell
      badge="Hiring"
      description="CVs sent to you by the recruitment team, candidates assigned to your open positions, a folder for every area you hold, and the CVs sitting with the managers who report to you — read the CV, answer, comment, and keep the good ones in your own folders."
      title="My Candidates"
    >
      <RecruitmentCandidatesPortal
        areaOptions={areaOptions}
        initialApplications={visibleApplications}
        initialCallClaims={callClaims}
        initialOutstandingFeedback={outstandingFeedback}
        initialDistrictBoards={visibleDistrictBoards}
        initialFilings={filings}
        initialFiles={initialFiles}
        initialSentToMe={visibleSentToMe}
        initialTeam={team}
        viewerHrId={access.hrId}
      />
    </EmployeePortalPageShell>
  );
}
