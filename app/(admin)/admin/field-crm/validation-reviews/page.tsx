import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { Building2, ChevronDown, MapPinCheck } from "lucide-react";

import { AdminStatCard } from "@/components/admin/admin-design-system";
import { PlaceChecksWithDeck } from "@/components/place-review-deck/place-checks-with-deck";
import { FullNameChecks } from "@/components/phoenix-crm/full-name-checks";
import { PlaceCheckRestoreProvider } from "@/components/phoenix-crm/place-check-restore";
import { PlaceChecksInUseFigures } from "@/components/phoenix-crm/place-checks/in-use-figures";
import { canAccess } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { GOOGLE_MATCH_METERS, GOOGLE_STALE_PIN_METERS } from "@/lib/phoenix-crm/google-place-rules";
import { placeCheckLayoutGuess } from "@/lib/phoenix-crm/place-check-layout";
import { placeChecksBoardSets } from "@/lib/phoenix-crm/place-checks-board-sets";
import { decidedSentWithPage, seatedPlacesInUse } from "@/lib/phoenix-crm/place-checks-on-demand";
import { canRestoreValidation, readsCompanyPlaceChecks, resolvePhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { SFE_RECOMMENDATIONS_PATH } from "@/lib/phoenix-crm/sfe-recommendations";
import { canCorrectHeldFullName, loadHeldFullNames } from "@/lib/phoenix-crm/server/full-name-reviews";
import { loadPlaceCheckIntegrity } from "@/lib/phoenix-crm/server/integrity-board";
import { loadPlaceNoteIndex } from "@/lib/phoenix-crm/server/place-notes";
import { loadFailingTimetables } from "@/lib/phoenix-crm/server/failing-timetables";
import { loadSharedPlaceBoard } from "@/lib/phoenix-crm/server/shared-places";
import { readSignWinsSwitch } from "@/lib/phoenix-crm/server/sign-wins";
import { loadPlaceCheckAgreement } from "@/lib/phoenix-crm/server/stored-advice";
import {
  canDecideValidationReviews,
  loadReopenedCustomers,
  loadValidatedPlaces,
  loadValidationReviews,
} from "@/lib/phoenix-crm/server/validation-reviews";
import { parseDeckTab } from "@/lib/place-review-deck/slides";

export const dynamic = "force-dynamic";

/**
 * Places the Google Maps check could not confirm — the Super Admin's queue (owner, 2026-10-03).
 *
 * Every AM validation is checked against the account's own Google Maps listing: the listing must BE the
 * account, and the rep must have stood within GOOGLE_MATCH_METERS of it. A mismatch is refused at the
 * door and never reaches this page. What reaches it is the hold — Google has no listing the system is
 * sure is this account, could not be asked, or holds the account's pin over GOOGLE_STALE_PIN_METERS away
 * (a moved hospital) — which the owner ruled "held for review and only system admin can approve or
 * reject".
 *
 * 🔴 THE SUPER ADMIN DECIDES, THE SFE MANAGER READS AND RECOMMENDS (owner, 2026-11-19: "make Khaled Bedair
 * only able to recommend validation or not recommend, never able to take a decision, and the recommended by
 * him goes separately in a separate page for admin decision"). `readsCompanyPlaceChecks` gates the page;
 * `canDecideValidationReviews` (the Super Admin alone) gates every decision route and every decision
 * control the board draws. A check the SFE Manager has recommended on leaves the Super Admin's lists here
 * and waits on `SFE_RECOMMENDATIONS_PATH` (`sfe-recommendations.ts`). From 2026-10-19 until that day the SFE
 * Manager decided here too ("show check place to sfe manager exactly as it in the admin account"). The gate here is `approve`, which both hold — the SFE Manager has no `update`
 * in this module and was not given one, because that would open every other `update` route to him. The
 * redirect rather than a message is the integrity board's shape — a page that does not describe itself to
 * somebody who may not read it.
 *
 * The SFE Manager is served exactly this board, with one thing held back by an earlier ruling of the
 * owner's that this one did not touch: he cannot SETTLE an integrity case (the deck says so itself). The
 * phone's mock-location answer and the position cases are in his evidence here since 2026-10-19 ("show
 * the mock-location evidence to the SFE Manager too"), as they are in the Super Admin's.
 */
export default async function PhoenixCrmValidationReviewsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const access = await resolveAccessContextFromPage();
  if (!(await canAccess(access, "phoenix_crm", "approve"))) redirect("/admin");
  const viewer = await resolvePhoenixCrmViewer(access).catch(() => null);
  if (!viewer || !readsCompanyPlaceChecks(viewer)) redirect("/admin");
  const decides = canDecideValidationReviews(viewer);

  // `loadSharedPlaceBoard` narrows by `placeChecksSeatScope`, which answers for exactly the viewers
  // `readsCompanyPlaceChecks` above admits — so it cannot 403 a viewer this page has already
  // admitted, and it needs no second redirect.
  // 🔴 THE COMMENTS AND THE EVIDENCE START THE MOMENT THE THREE LISTS THAT NAME THE SUBJECTS ARE IN
  // (owner, 2026-11-08: "places checks is … slow"). They used to wait for all five reads — the reopened
  // customers and the held full names too, which name no subject — and only then begin, one wave after
  // the other. The district manager's page has started them this way since 2026-10-31.
  // 🔴 THE PAGE READS WHAT IT SENDS, AND NOTHING ELSE (owner, 23 Nov 2026: "Fix speed next"). It read every
  // decision ever made (2,377) and every place in use (7,124, 13 MB) before it drew a row, to count the
  // figures on the tabs: 12.2 s to the first waiting place on production, 9.75 s of it those two reads. So:
  // the places waiting and the decisions of the last 14 days; the places SEATED in a building, which are the
  // only places in use the board draws on opening; and the buildings. The wide read is asked for by the
  // board once it is on screen (`server/place-checks-wide-read.ts`): it counts those figures, and "Decided
  // by" still answers for every decision, from the rows it leaves for the click.
  // 🔴 AND OF THE DECISIONS, ONLY THE ONES IT SENDS (owner, 23 Nov 2026: "Fix what is under 9.5"): the
  // decisions of customers seated in a building, picked by the database (`seatedDecisionsOnly`). It read all
  // 1,184 of the last 14 days to keep 404 of them and to count two cards; those cards are the wide read's now.
  const subjectReads = Promise.all([
    loadValidationReviews(viewer, { seatedDecisionsOnly: true }),
    loadValidatedPlaces(viewer, { seatedOnly: true }),
    loadSharedPlaceBoard(viewer),
  ]);
  const [[reviews, validatedRead, sharedRead], reopenedRead, failingTimetables, heldFullNames, [notes, integrity], signWins, agreement] = await Promise.all([
    subjectReads,
    loadReopenedCustomers(viewer),
    // Buildings whose timetable was refused on two or more days (owner, 14 Nov 2026) — one small read.
    loadFailingTimetables(viewer),
    // Doctors' full names that matched their board under 60% (owner, 2026-11-07).
    loadHeldFullNames(viewer),
    // Every comment, recommendation and integrity case on this page's subjects — two reads for the whole
    // page, both keyed by `placeNoteSubjectKey` (owner, 2026-10-13). The evidence read lives in
    // `server/integrity-board.ts`, which is where a read of the evidence belongs, and is merged in here.
    subjectReads.then(([reviewRows, validatedRows, sharedRows]) => {
      const subjects = {
        placeIds: [...reviewRows.rows.map((row) => row.placeId), ...validatedRows.rows.map((row) => row.placeId)],
        sharedPlaceIds: sharedRows.rows.map((row) => row.sharedPlaceId),
      };
      return Promise.all([loadPlaceNoteIndex(subjects, { viewerHrId: viewer.hrId }), loadPlaceCheckIntegrity(viewer, subjects)]);
    }),
    // The rule that approves by itself, and how often his decisions matched the advice (the rebuild, 23 Nov
    // 2026). A read that fails is handed on as null, and the header says it could not be read: never a zero.
    decides ? readSignWinsSwitch().catch(() => null) : null,
    decides ? loadPlaceCheckAgreement().catch(() => null) : null,
  ]);
  const validated = validatedRead.rows;
  const reopened = reopenedRead.rows;
  const capped = {
    reviews: reviews.capped,
    validated: validatedRead.capped,
    reopened: reopenedRead.capped,
    sharedPlaces: sharedRead.capped,
  };
  const noteIndex = { ...notes, integrity };
  // 🔴 WHAT THE SFE MANAGER RECOMMENDED WAITS ON ITS OWN PAGE, NOT HERE (owner, 2026-11-19), which building
  // is still held, and which decision note is already drawn as a comment: one rule, in
  // `place-checks-board-sets.ts`, which the read behind the click sorts its rows by as well.
  const { waiting, decided, sharedPlaces, sfeRecommendedCount } = placeChecksBoardSets({ decides, reviews: reviews.rows, sharedPlaces: sharedRead.rows, notes });
  // 🔴 THE CARDS COUNT WHAT THE BOARD DRAWS (owner, 2026-10-17: "is this a report that really shows me
  // data?"): a test entry is nobody's work and the board never draws one, and a rejected building is not
  // a polyclinic in use — the card read 98, four of them test entries and 36 rejected.
  const real = <Row extends { isTest: boolean }>(set: Row[]) => set.filter((row) => !row.isTest);
  const liveVenues = real(sharedPlaces).filter((row) => row.status !== "retired");
  // Customers seated across every live venue. The 3-a-day cap is about the DAY, never about this number.
  const seated = liveVenues.reduce((total, row) => total + row.seated, 0);
  const venuesWithoutTimetable = liveVenues.filter((row) => row.seated > 0 && !row.schedulePhotoPath).length;
  // `?review=<tab>` opens the one-by-one review on that tab — the Location integrity page links here so.
  const review = (await searchParams).review;
  const openOn = parseDeckTab(typeof review === "string" ? review : null);
  // 🔴 THE BOARD OPENS ON WHAT NEEDS YOU DRAWS, AND THE REST WAITS FOR THE CLICK (owner, 2026-11-14, "Load
  // lists on demand"; `place-checks-on-demand.ts`). The 5,807 places in use and the decisions older than 14
  // days were 8.7 of the page's 12.5 MB and froze the server building it. Every figure counted over them is
  // counted by the board's own functions in the read behind `PLACE_CHECKS_SUMMARY_ROUTE`, and the board
  // reads the rows themselves from `PLACE_CHECKS_EVERYTHING_ROUTE` when he opens Not confirmed, picks a
  // filter, or opens the review. Never hand the board every place in use or every decision again, and
  // never read them here: the page reads what it sends.
  // 🔴 NOR THE RECENT DECISIONS OF SINGLE CLINICS (23 Nov 2026): only History and "Approved by the system"
  // draw them, so they wait for those tabs. The seated ones go, because a building's card shows everybody.
  const sentDecided = decidedSentWithPage(decided.filter((row) => row.recent), sharedPlaces);
  // A place seated in a building that is not on this board is not drawn by it either.
  const seatedInUse = seatedPlacesInUse(validated, sharedPlaces);
  // The moment this page was read: the board asks for its figures once, and again when this changes.
  const onDemand = { readAt: new Date().toISOString() };

  // 🔴 NOTHING IS ABOVE THE FIRST WAITING PLACE BUT THE ONE LINE (the rebuild, 23 Nov 2026). The account of the
  // checks, the figures and the held full names were about 1,700 px of page before the first decision; each
  // is now a tab of the board (`slots`), drawn here so the board carries none of it into the portal.
  const heldNames = heldFullNames.filter((row) => !row.isTest).length;
  const slots = [
    // Drawn only while a name is held, with its count on the tab.
    ...(heldNames > 0
      ? [
          {
            key: "names",
            label: "Full names",
            count: heldNames,
            content: <FullNameChecks canCorrect={canCorrectHeldFullName(viewer)} decides={decides} rows={heldFullNames} />,
          },
        ]
      : []),
    {
      key: "figures",
      label: "Figures",
      count: null,
      content: (
        <>
          <details className="group min-w-0 border border-slate-200 bg-white">
            <summary className="flex min-h-10 cursor-pointer list-none items-center gap-2 px-4 py-2 text-xs font-black uppercase tracking-[0.12em] text-slate-500 hover:text-slate-700 [&::-webkit-details-marker]:hidden">
              <ChevronDown aria-hidden className="h-3.5 w-3.5 transition group-open:rotate-180" />
              How the checks work
            </summary>
            <p className="break-words border-t border-slate-100 px-4 py-3 text-sm text-slate-700">
              Every AM customer a rep validates is checked against its own Google Maps listing: the listing must be that customer, and they must
              have stood within {GOOGLE_MATCH_METERS} m of it. A place that does not match is refused at the door. Every new place also has its
              signboard read: the sign must name the customer (for an AM customer, the place; for a PM customer, the person). What reaches this
              page is what the system could not settle — Google had no listing for the customer, its pin is over{" "}
              {GOOGLE_STALE_PIN_METERS.toLocaleString("en-GB")} m away, or the signboard names somebody else or nobody.
            </p>
          </details>
          {/* The waiting number is the board's one line, in decisions; no card repeats it in another unit. */}
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-5">
            {/* The two "last 14 days" cards, "Validated, in use" and "Never looked at" are counted over every
                decision and every place in use, which this page no longer reads: the board's own summary
                read fills them (`in-use-figures.tsx`). */}
            <PlaceChecksInUseFigures />
            <AdminStatCard
              icon={<Building2 className="h-5 w-5" />}
              label="Polyclinics and centres"
              value={liveVenues.length}
              description={`${seated} ${seated === 1 ? "customer seated" : "customers seated"} in them${
                venuesWithoutTimetable > 0 ? `; ${venuesWithoutTimetable} with customers and no timetable on file` : ""
              }`}
              tone="blue"
              size="compact"
            />
          </div>
        </>
      ),
    },
  ];

  // Which of a list's two layouts this request will draw, so each row is rendered once
  // (`place-checks/layout.tsx`); the browser corrects a wrong guess from its own width.
  const requestHeaders = await headers();
  const layout = placeCheckLayoutGuess({ userAgent: requestHeaders.get("user-agent"), mobileHint: requestHeaders.get("sec-ch-ua-mobile") });

  return (
    <div className="space-y-5">
      {/* The title band is drawn by the board's wrapper, around the board's own top line, so "N decisions
          wait for you" stands beside the title (`PlaceChecksWithDeck`). */}
      {/* Taking a rejection back — the Super Admin alone, never the SFE Manager (owner, 2026-11-10). */}
      <PlaceCheckRestoreProvider canRestore={canRestoreValidation(viewer)}>
        <PlaceChecksWithDeck
          agreement={agreement}
          capped={capped}
          decides={decides}
          decided={sentDecided}
          failingTimetables={failingTimetables}
          layout={layout}
          noteIndex={noteIndex}
          onDemand={onDemand}
          openOn={openOn}
          pending={waiting}
          reopened={reopened}
          sfeRecommended={decides ? { count: sfeRecommendedCount, href: SFE_RECOMMENDATIONS_PATH } : undefined}
          sharedPlaces={sharedPlaces}
          signWins={decides ? signWins : undefined}
          slots={slots}
          title={{
            eyebrow: "CRM",
            title: "Place checks",
            description: decides
              ? "Decide the places the system could not settle by itself."
              : "Recommend on the places the system could not settle by itself. The administrator decides.",
            icon: <MapPinCheck className="h-3.5 w-3.5" />,
          }}
          validated={seatedInUse}
        />
      </PlaceCheckRestoreProvider>
    </div>
  );
}
