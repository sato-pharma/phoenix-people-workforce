import { redirect } from "next/navigation";
import { MessageSquareQuote, ThumbsDown, ThumbsUp } from "lucide-react";

import { AdminCallout, AdminPageHero, AdminStatCard } from "@/components/admin/admin-design-system";
import { PlaceCheckRestoreProvider } from "@/components/phoenix-crm/place-check-restore";
import { SharedPlaceList } from "@/components/phoenix-crm/shared-place-list";
import { CrmSurfaceProvider } from "@/components/phoenix-crm/surface";
import { ValidationReviewQueue } from "@/components/phoenix-crm/validation-review-queue";
import { canAccess } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { placeNoteSubjectKey } from "@/lib/phoenix-crm/place-note-rules";
import { withoutDecisionNotesThatAreComments } from "@/lib/phoenix-crm/place-checks-on-demand";
import { canDecideValidationReviews, canRestoreValidation, resolvePhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { loadPlaceCheckIntegrity } from "@/lib/phoenix-crm/server/integrity-board";
import { loadPlaceNoteIndex } from "@/lib/phoenix-crm/server/place-notes";
import { loadSharedPlaceBoard } from "@/lib/phoenix-crm/server/shared-places";
import { loadValidationReviews } from "@/lib/phoenix-crm/server/validation-reviews";
import { splitBySfeRecommendation } from "@/lib/phoenix-crm/sfe-recommendations";
import { narrowVenueGroups, seatedCustomersByVenue, withoutSeated } from "@/lib/phoenix-crm/shared-place-groups";
import { EMPTY_VALIDATION_REVIEW_FILTERS } from "@/lib/phoenix-crm/validation-review-filters";
import type { SharedPlaceBoardRow, ValidationReviewRow } from "@/lib/phoenix-crm/view-types";

export const dynamic = "force-dynamic";

/**
 * SFE recommendations — the place checks the SFE Manager recommended, waiting for the Super Admin.
 *
 * Owner, 19 November 2026: "in place checks make Khaled Bedair only able to recommend validation or not
 * recommend, never able to take a decision, and the recommended by him goes separately in a separate page
 * for admin decision."
 *
 * The Super Admin's alone (`canDecideValidationReviews`). Every check here — a place waiting for a decision,
 * or a held polyclinic — carries the SFE Manager's recommendation, and has left the Place checks board's
 * Needs you list by the same rule (`sfe-recommendations.ts`), so it is on exactly one of the two pages. The
 * controls are the Place checks board's own, so a decision made here is the same decision, through the same
 * routes, with the same comment reaching the rep.
 */
export default async function SfeRecommendationsPage() {
  const access = await resolveAccessContextFromPage();
  if (!(await canAccess(access, "phoenix_crm", "update"))) redirect("/admin");
  const viewer = await resolvePhoenixCrmViewer(access).catch(() => null);
  if (!viewer || !canDecideValidationReviews(viewer)) redirect("/admin");

  const [reviews, venues] = await Promise.all([loadValidationReviews(viewer), loadSharedPlaceBoard(viewer)]);
  const pending = reviews.rows.filter((row) => row.status === "pending");
  const held = venues.rows.filter((row) => row.status === "held");
  const subjects = { placeIds: pending.map((row) => row.placeId), sharedPlaceIds: held.map((row) => row.sharedPlaceId) };
  const [notes, integrity] = await Promise.all([loadPlaceNoteIndex(subjects, { viewerHrId: viewer.hrId }), loadPlaceCheckIntegrity(viewer, subjects)]);
  const noteIndex = { ...notes, integrity };

  const placeKey = (row: ValidationReviewRow) => placeNoteSubjectKey("place", row.placeId);
  const venueKey = (row: SharedPlaceBoardRow) => placeNoteSubjectKey("shared_place", row.sharedPlaceId);
  const places = splitBySfeRecommendation(withoutDecisionNotesThatAreComments(pending, notes.notes), placeKey, notes.recommendations);
  const buildings = splitBySfeRecommendation(held, venueKey, notes.recommendations);

  // A customer seated in a held building on this page is drawn under it, not a second time as a place.
  const venueIds = new Set([...buildings.validate, ...buildings.reject].map((row) => row.sharedPlaceId));
  const seated = seatedCustomersByVenue({ pending, decided: [], validated: [], reopened: [], venueIds });
  const groupsOf = (rows: SharedPlaceBoardRow[]) => narrowVenueGroups({ venues: rows, seated, filters: EMPTY_VALIDATION_REVIEW_FILTERS, cutoff: null });
  const lists = {
    validate: { places: withoutSeated(places.validate, venueIds), buildings: groupsOf(buildings.validate) },
    reject: { places: withoutSeated(places.reject, venueIds), buildings: groupsOf(buildings.reject) },
  };
  const real = <Row extends { isTest: boolean }>(rows: Row[]) => rows.filter((row) => !row.isTest).length;
  const counts = {
    validate: real(places.validate) + real(buildings.validate),
    reject: real(places.reject) + real(buildings.reject),
  };
  const capped = reviews.capped || venues.capped;

  return (
    <div className="space-y-5">
      <AdminPageHero
        eyebrow="CRM"
        title="SFE recommendations"
        description="The place checks the SFE Manager recommended to validate or not. Each waits for your decision; the rep is told only that the system is checking."
        icon={<MessageSquareQuote className="h-3.5 w-3.5" />}
      />
      {capped ? (
        <AdminCallout tone="warning">
          <span>There are more place checks than one read holds, so this page may not show every recommendation.</span>
        </AdminCallout>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2">
        <AdminStatCard
          icon={<ThumbsUp className="h-5 w-5" />}
          label="Recommended to validate"
          value={counts.validate}
          description="The SFE Manager recommends approving"
          tone="emerald"
          size="compact"
        />
        <AdminStatCard
          icon={<ThumbsDown className="h-5 w-5" />}
          label="Not recommended"
          value={counts.reject}
          description="The SFE Manager recommends rejecting"
          tone="rose"
          size="compact"
        />
      </div>

      <CrmSurfaceProvider surface="admin">
        <PlaceCheckRestoreProvider canRestore={canRestoreValidation(viewer)}>
          {(["validate", "reject"] as const).map((side) => {
            const title = side === "validate" ? "Recommended to validate" : "Not recommended";
            const list = lists[side];
            const empty = list.places.length === 0 && list.buildings.length === 0;
            return (
              <section className="min-w-0 space-y-3" key={side}>
                <h2 className="text-sm font-black uppercase tracking-[0.12em] text-slate-600">{title}</h2>
                {empty ? (
                  <AdminCallout tone="neutral">
                    <span>Nothing is waiting here.</span>
                  </AdminCallout>
                ) : null}
                {/* Each list draws its own desktop table and phone cards; this is only its heading. */}
                {list.places.length > 0 ? (
                  <div className="min-w-0 border border-slate-200 bg-white">
                    <p className="border-b border-slate-100 px-4 py-2 text-sm font-black text-slate-900">Places ({list.places.length})</p>
                    <ValidationReviewQueue mode="company" noteIndex={noteIndex} rows={list.places} section="waiting" />
                  </div>
                ) : null}
                {list.buildings.length > 0 ? (
                  <div className="min-w-0 border border-slate-200 bg-white">
                    <p className="border-b border-slate-100 px-4 py-2 text-sm font-black text-slate-900">Polyclinics and centres ({list.buildings.length})</p>
                    <SharedPlaceList groups={list.buildings} mode="company" noteIndex={noteIndex} />
                  </div>
                ) : null}
              </section>
            );
          })}
        </PlaceCheckRestoreProvider>
      </CrmSurfaceProvider>
    </div>
  );
}
