import { redirect } from "next/navigation";
import { Building2, Hourglass, MapPinCheck } from "lucide-react";

import { AdminStatCard } from "@/components/admin/admin-design-system";
import { EmployeePortalPageShell } from "@/components/employee-portal/enterprise-shell";
import { ValidationReviewsBoard } from "@/components/phoenix-crm/validation-reviews-board";
import { canAccess } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { GOOGLE_MATCH_METERS } from "@/lib/phoenix-crm/google-place-rules";
import { readsTeamPlaceChecks, resolvePhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { loadPlaceCheckIntegrity } from "@/lib/phoenix-crm/server/integrity-board";
import { loadPlaceNoteIndex } from "@/lib/phoenix-crm/server/place-notes";
import { loadSharedPlaceBoard } from "@/lib/phoenix-crm/server/shared-places";
import { loadReopenedCustomers, loadValidatedPlaces, loadValidationReviews } from "@/lib/phoenix-crm/server/validation-reviews";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Place checks — the DISTRICT MANAGER's own tab, his team and nobody else's.
 *
 * Owner, 13 October 2026: "In every district manager account, build a tab in his sidebar that shows
 * the check places only for his team and make him able to comment. And when he comes to comment, he
 * can choose the rep see the comment or the rep doesn't see the comment. He can recommend to validate,
 * or he can recommend to not validate. But the final is for the system administrator only. But don't
 * show this on the screen."
 *
 * So this page is the Super Admin's own Place checks board, in `mode="team"`:
 *   · the four sections are the same, each read narrowed to his territories SERVER-SIDE
 *     (`placeChecksSeatScope`) — never a filter applied in the browser over a company-wide payload;
 *   · he comments on a place or a polyclinic, choosing per comment whether the rep may read it, and
 *     recommends validating it or not validating it;
 *   · NO decision control is rendered and NO sentence on the page says who decides, that a
 *     recommendation is only a recommendation, or that anything is waiting for anybody. His last
 *     instruction of the three is the one that is easiest to break by accident, and the board's
 *     `team` flag is where every sentence it governs lives.
 *
 * 🔴 THE REDIRECT RATHER THAN A MESSAGE is the integrity board's shape and the Super Admin's own Place
 * checks page's: a page that does not describe itself to somebody who may not read it.
 *
 * 🔴 AND IT IS A PORTAL PAGE, NOT AN `(admin)` ONE. A District Manager's navigation mode is
 * `employee-portal` (`resolveNavigationMode`), so an admin-shell address would bounce him. The board
 * itself is shared — `src/components/admin/admin-design-system.tsx` is not admin-only despite its
 * name, and 52 of the portal's pages already render it; the warm `.admin-shell` palette remap is
 * scoped to that class and never reaches here, which is what `tests/admin-shell-palette-scope.test.ts`
 * exists to keep true.
 */
export default async function TeamPlaceChecksPage() {
  const access = await resolveAccessContextFromPage();
  if (!(await canAccess(access, "phoenix_crm", "read"))) redirect("/employee-portals");
  const viewer = await resolvePhoenixCrmViewer(access).catch(() => null);
  if (!viewer || !readsTeamPlaceChecks(viewer)) redirect("/employee-portals");

  // Each of these four narrows itself to this viewer's own seats. They are the SAME functions the
  // Super Admin's page calls: one board, one set of reads, and no second copy to drift.
  const [reviews, validatedRead, reopenedRead, sharedRead] = await Promise.all([
    loadValidationReviews(viewer),
    loadValidatedPlaces(viewer),
    loadReopenedCustomers(viewer),
    loadSharedPlaceBoard(viewer),
  ]);
  const rows = reviews.rows;
  const validated = validatedRead.rows;
  const sharedPlaces = sharedRead.rows;
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
  // The cards count what the board draws, as on the Super Admin's page: no test entry, and no building
  // that is no longer in use.
  const realWaiting = waiting.filter((row) => !row.isTest);
  const realValidated = validated.filter((row) => !row.isTest);
  const liveVenues = sharedPlaces.filter((row) => !row.isTest && row.status !== "retired");
  const seated = liveVenues.reduce((total, row) => total + row.seated, 0);

  return (
    <EmployeePortalPageShell
      badge="CRM"
      description={`Every place one of your reps validates is checked by the system before it counts: an AM customer against their own Google Maps listing — the listing must be that customer, and the rep must have stood within ${GOOGLE_MATCH_METERS} m of it — and every new place by reading the sign on the building, which must name the customer. These are your team's places, with what the system read on each one. A place that did not match is refused at the door and the rep is told what is wrong with the photograph, and never that anybody looked at it.`}
      title="Place checks"
    >
      <div className="min-w-0 space-y-5">
        <div className="grid min-w-0 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <AdminStatCard
            description="Saved at the door, not validated yet"
            icon={<Hourglass className="h-5 w-5" />}
            label="Still being checked"
            size="compact"
            tone="orange"
            value={realWaiting.length}
          />
          <AdminStatCard
            description="Every place of yours still in use"
            icon={<MapPinCheck className="h-5 w-5" />}
            label="Validated, in use"
            size="compact"
            tone="blue"
            value={realValidated.length}
          />
          <AdminStatCard
            description="In use, and nobody has looked at it yet"
            icon={<MapPinCheck className="h-5 w-5" />}
            label="Never looked at"
            size="compact"
            tone="violet"
            value={realValidated.filter((row) => !row.reviewed).length}
          />
          <AdminStatCard
            description={`${seated} ${seated === 1 ? "customer seated" : "customers seated"} in them`}
            icon={<Building2 className="h-5 w-5" />}
            label="Polyclinics and centres"
            size="compact"
            tone="blue"
            value={liveVenues.length}
          />
        </div>

        <ValidationReviewsBoard
          capped={{
            reopened: reopenedRead.capped,
            reviews: reviews.capped,
            sharedPlaces: sharedRead.capped,
            validated: validatedRead.capped,
          }}
          decided={rows.filter((row) => row.status !== "pending")}
          mode="team"
          noteIndex={noteIndex}
          pending={waiting}
          reopened={reopenedRead.rows}
          sharedPlaces={sharedPlaces}
          validated={validated}
        />
      </div>
    </EmployeePortalPageShell>
  );
}
