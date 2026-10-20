import { redirect } from "next/navigation";

import {
  EmployeePortalEmptyState,
  EmployeePortalPageShell,
} from "@/components/employee-portal/enterprise-shell";
import { RecruitmentCandidatesPortal } from "@/components/employee-portal/recruitment-candidates-portal";
import {
  canAccess,
  canOpenPersonalCandidateInbox,
  isHrAuthorityRole,
  resolveNavigationMode,
} from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { listApplications } from "@/lib/recruitment/applications";
import { adminTwinOfPortalCandidatesHref, CANDIDATE_LINK_PARAM } from "@/lib/recruitment/candidate-page-link";
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
import { isUuid } from "@/lib/http/uuid";
import { fenceDistrictBoards, fenceRowsByCandidate } from "@/lib/recruitment/workspace/fence";
import { answerChipsByCandidate, loadAnswerChipContext } from "@/components/recruitment/workspace/manager-answer-chips";
import { cairoToday } from "@/lib/recruitment/workspace/filters";

export const dynamic = "force-dynamic";

export default async function EmployeePortalRecruitmentCandidatesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const access = await resolveAccessContextFromPage();

  if (resolveNavigationMode(access) !== "employee-portal") {
    // This list is the portal's own, and every notice about a CV points here — including the ones
    // the Super Admin receives as a copy. He used to be sent to /overview, the command center, which
    // is not where a comment on a candidate lives (owner, 2026-09-19). Send an admin-shell viewer to
    // the admin page for the same thing instead: the candidate's own page when the link names one.
    //
    // The Super Admin never reaches this line: proxy.ts answers him with a real 307 first, because a
    // redirect from here arrives after app/employee-portals/loading.tsx has painted the portal and
    // he watched it bounce. This stays the fallback for every other admin-shell role.
    const params = await searchParams;
    const adminTwin = adminTwinOfPortalCandidatesHref({
      canOpenPersonalInbox: canOpenPersonalCandidateInbox(access),
      canOpenRecruitment: isHrAuthorityRole(access.role) && (await canAccess(access, "recruitment", "read")),
      candidateId: params[CANDIDATE_LINK_PARAM],
    });
    if (adminTwin) redirect(adminTwin);
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
  //   • the question set — so each CV's answers read as the workspace's labelled chips (owner,
  //     2026-10-20: the manager portal draws the workspace's own rows). Started now, read later; a
  //     failed read leaves the rows saying they hold no answers, never a blank page.
  const chipContextLoad = loadAnswerChipContext().catch(() => null);
  const [everyApplication, everySentToMe, team, filings, areaOptions, everyDistrictBoard] = await Promise.all([
    listApplications(access),
    listCandidatesSentToManager(access.hrId),
    listViewerTeamManagers(access),
    listManagerFolderFilings(access.hrId),
    listCandidateFolderAreaOptions(),
    listDistrictBoardsForManager(access.hrId),
  ]);
  // The Talent Acquisition fence (owner, 2026-10-20): an HR applicant is on none of these lists, so no
  // card, file, claim or count below can name one. Free for every viewer it does not apply to.
  const [applications, sentToMe, districtBoards] = await Promise.all([
    fenceRowsByCandidate(access, everyApplication, (application) => application.candidateId),
    fenceRowsByCandidate(access, everySentToMe, (candidate) => candidate.id),
    fenceDistrictBoards(access, everyDistrictBoard),
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

  // The answer chips, read off the SAME candidates the cards draw — the redacted ones — so a chip can
  // never carry what the card itself hides.
  const chipContext = await chipContextLoad;
  const answerChips = chipContext
    ? answerChipsByCandidate(
        [
          ...visibleSentToMe,
          ...visibleApplications.flatMap((application) => (application.candidate ? [application.candidate] : [])),
          ...visibleDistrictBoards.flatMap((board) => board.folders.flatMap((folder) => folder.candidates)),
        ],
        chipContext,
      )
    : {};
  // A notification's `?candidate=` opens that CV on arrival, when it is one of his.
  const linked = (await searchParams)[CANDIDATE_LINK_PARAM];
  const initialOpenId = typeof linked === "string" && isUuid(linked) ? linked : null;

  return (
    <EmployeePortalPageShell
      badge="Hiring"
      description="CVs sent to you by the recruitment team, candidates assigned to your open positions, a folder for every area you hold, and the CVs sitting with the managers who report to you — read the CV, answer, comment, and keep the good ones in your own folders."
      title="My Candidates"
    >
      <RecruitmentCandidatesPortal
        areaOptions={areaOptions}
        initialAnswerChips={answerChips}
        initialApplications={visibleApplications}
        initialCallClaims={callClaims}
        initialDistrictBoards={visibleDistrictBoards}
        initialUnseenIds={unseenIds}
        initialFilings={filings}
        initialFiles={initialFiles}
        initialOpenId={initialOpenId}
        initialOpeners={openers}
        initialSentToMe={visibleSentToMe}
        initialTeam={team}
        today={cairoToday()}
        viewerHrId={access.hrId}
      />
    </EmployeePortalPageShell>
  );
}
