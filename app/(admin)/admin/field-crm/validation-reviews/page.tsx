import { redirect } from "next/navigation";
import { Building2, CheckCircle2, EyeOff, Hourglass, MapPinCheck } from "lucide-react";

import { AdminPageHero, AdminStatCard } from "@/components/admin/admin-design-system";
import { PlaceChecksWithDeck } from "@/components/place-review-deck/place-checks-with-deck";
import { canAccess } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { GOOGLE_MATCH_METERS, GOOGLE_STALE_PIN_METERS } from "@/lib/phoenix-crm/google-place-rules";
import { resolvePhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { loadPlaceCheckIntegrity } from "@/lib/phoenix-crm/server/integrity-board";
import { loadPlaceNoteIndex } from "@/lib/phoenix-crm/server/place-notes";
import { loadSharedPlaceBoard } from "@/lib/phoenix-crm/server/shared-places";
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
 * 🔴 THE SUPER ADMIN'S AND THE SFE MANAGER'S (owner, 2026-10-19: "show check place to sfe manager exactly
 * as it in the admin account to be able validate approve and refuse"): `canDecideValidationReviews` gates
 * the page and the routes. The gate here is `approve`, which both hold — the SFE Manager has no `update`
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
  if (!viewer || !canDecideValidationReviews(viewer)) redirect("/admin");

  // `loadSharedPlaceBoard` narrows by `placeChecksSeatScope`, which answers for exactly the viewers
  // `canDecideValidationReviews` above admits — so it cannot 403 a viewer this page has already
  // admitted, and it needs no second redirect.
  const [reviews, validatedRead, reopenedRead, sharedRead] = await Promise.all([
    // Every decision, so "Decided by" can answer for all of them; the cards and the board's default stay
    // on the recent ones (`recent`).
    loadValidationReviews(viewer, { everyDecision: true }),
    loadValidatedPlaces(viewer),
    loadReopenedCustomers(viewer),
    loadSharedPlaceBoard(viewer),
  ]);
  const rows = reviews.rows;
  const validated = validatedRead.rows;
  const reopened = reopenedRead.rows;
  const sharedPlaces = sharedRead.rows;
  const capped = {
    reviews: reviews.capped,
    validated: validatedRead.capped,
    reopened: reopenedRead.capped,
    sharedPlaces: sharedRead.capped,
  };
  const subjects = {
    placeIds: [...rows.map((row) => row.placeId), ...validated.map((row) => row.placeId)],
    sharedPlaceIds: sharedPlaces.map((row) => row.sharedPlaceId),
  };
  // Every comment, recommendation and integrity case on this page's subjects — two reads for the whole
  // page, both keyed by `placeNoteSubjectKey` (owner, 2026-10-13). The evidence read lives in
  // `server/integrity-board.ts`, which is where a read of the evidence belongs, and is merged in here.
  const [notes, integrity] = await Promise.all([loadPlaceNoteIndex(subjects), loadPlaceCheckIntegrity(viewer, subjects)]);
  const noteIndex = { ...notes, integrity };
  const waiting = rows.filter((row) => row.status === "pending");
  const decided = rows.filter((row) => row.status !== "pending");
  // 🔴 THE CARDS COUNT WHAT THE BOARD DRAWS (owner, 2026-10-17: "is this a report that really shows me
  // data?"): a test entry is nobody's work and the board never draws one, and a rejected building is not
  // a polyclinic in use — the card read 98, four of them test entries and 36 rejected.
  const real = <Row extends { isTest: boolean }>(set: Row[]) => set.filter((row) => !row.isTest);
  const realWaiting = real(waiting);
  const realDecided = real(decided).filter((row) => row.recent);
  const realValidated = real(validated);
  // Nobody has ever looked at these — no review row of any status (598 of the first 643, 2026-10-08).
  const unseen = realValidated.filter((row) => !row.reviewed).length;
  const liveVenues = real(sharedPlaces).filter((row) => row.status !== "retired");
  // Customers seated across every live venue. The 3-a-day cap is about the DAY, never about this number.
  const seated = liveVenues.reduce((total, row) => total + row.seated, 0);
  const venuesWithoutTimetable = liveVenues.filter((row) => row.seated > 0 && !row.schedulePhotoPath).length;
  // `?review=<tab>` opens the one-by-one review on that tab — the Location integrity page links here so.
  const review = (await searchParams).review;
  const openOn = parseDeckTab(typeof review === "string" ? review : null);

  return (
    <div className="space-y-5">
      <AdminPageHero
        eyebrow="CRM"
        title="Place checks"
        description={`Every AM customer a rep validates is checked against its own Google Maps listing: the listing must be that customer, and they must have stood within ${GOOGLE_MATCH_METERS} m of it. A place that does not match is refused at the door. Every new place also has its signboard read: the sign must name the customer (for an AM customer, the place; for a PM customer, the person). These are the ones the system could not settle — Google had no listing for the customer, its pin is over ${GOOGLE_STALE_PIN_METERS.toLocaleString("en-GB")} m away, or the signboard names somebody else or nobody — and each waits for you. The rep is told only that the system is checking.`}
        icon={<MapPinCheck className="h-3.5 w-3.5" />}
      />

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-6">
        <AdminStatCard icon={<Hourglass className="h-5 w-5" />} label="Waiting for you" value={realWaiting.length} description="Saved at the door, not validated yet" tone="orange" size="compact" />
        <AdminStatCard
          icon={<CheckCircle2 className="h-5 w-5" />}
          label="Approved, last 14 days"
          value={realDecided.filter((row) => row.status === "approved").length}
          description="Validated in the rep's own name"
          tone="emerald"
          size="compact"
        />
        <AdminStatCard
          icon={<MapPinCheck className="h-5 w-5" />}
          label="Rejected, last 14 days"
          value={realDecided.filter((row) => row.status === "rejected").length}
          description="Sent back to To validate"
          tone="rose"
          size="compact"
        />
        <AdminStatCard
          icon={<MapPinCheck className="h-5 w-5" />}
          label="Validated, in use"
          value={realValidated.length}
          description="Every place still in use, and refusable below"
          tone="blue"
          size="compact"
        />
        <AdminStatCard
          icon={<EyeOff className="h-5 w-5" />}
          label="Never looked at"
          value={unseen}
          description="In use, and no review of any kind yet"
          tone="violet"
          size="compact"
        />
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

      <PlaceChecksWithDeck
        capped={capped}
        decided={decided}
        noteIndex={noteIndex}
        openOn={openOn}
        pending={waiting}
        reopened={reopened}
        sharedPlaces={sharedPlaces}
        validated={validated}
      />
    </div>
  );
}
