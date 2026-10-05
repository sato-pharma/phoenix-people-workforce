import { redirect } from "next/navigation";
import { CheckCircle2, Hourglass, MapPinCheck } from "lucide-react";

import { AdminPageHero, AdminStatCard } from "@/components/admin/admin-design-system";
import { ValidationReviewsBoard } from "@/components/phoenix-crm/validation-reviews-board";
import { canAccess } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { GOOGLE_MATCH_METERS, GOOGLE_STALE_PIN_METERS } from "@/lib/phoenix-crm/google-place-rules";
import { resolvePhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { canDecideValidationReviews, loadValidatedPlaces, loadValidationReviews } from "@/lib/phoenix-crm/server/validation-reviews";

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
 * 🔴 THE SUPER ADMIN'S ALONE, not the SFE Manager's: `canDecideValidationReviews` gates the page and the
 * route. The redirect rather than a message is the integrity board's shape — a page that does not
 * describe itself to somebody who may not read it.
 */
export default async function PhoenixCrmValidationReviewsPage() {
  const access = await resolveAccessContextFromPage();
  if (!(await canAccess(access, "phoenix_crm", "update"))) redirect("/admin");
  const viewer = await resolvePhoenixCrmViewer(access).catch(() => null);
  if (!viewer || !canDecideValidationReviews(viewer)) redirect("/admin");

  const [rows, validated] = await Promise.all([loadValidationReviews(viewer), loadValidatedPlaces(viewer)]);
  const waiting = rows.filter((row) => row.status === "pending");
  const decided = rows.filter((row) => row.status !== "pending");

  return (
    <div className="space-y-5">
      <AdminPageHero
        eyebrow="CRM"
        title="Place checks"
        description={`Every AM customer a rep validates is checked against its own Google Maps listing: the listing must be that customer, and they must have stood within ${GOOGLE_MATCH_METERS} m of it. A place that does not match is refused at the door. These are the ones the system could not settle — Google had no listing for the customer, or its pin is over ${GOOGLE_STALE_PIN_METERS.toLocaleString("en-GB")} m away — and each waits for you. The rep is told only that the system is checking.`}
        icon={<MapPinCheck className="h-3.5 w-3.5" />}
      />

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <AdminStatCard icon={<Hourglass className="h-5 w-5" />} label="Waiting for you" value={waiting.length} description="Saved at the door, not validated yet" tone="orange" size="compact" />
        <AdminStatCard
          icon={<CheckCircle2 className="h-5 w-5" />}
          label="Approved, last 14 days"
          value={decided.filter((row) => row.status === "approved").length}
          description="Validated in the rep's own name"
          tone="emerald"
          size="compact"
        />
        <AdminStatCard
          icon={<MapPinCheck className="h-5 w-5" />}
          label="Rejected, last 14 days"
          value={decided.filter((row) => row.status === "rejected").length}
          description="Sent back to To validate"
          tone="rose"
          size="compact"
        />
        <AdminStatCard
          icon={<MapPinCheck className="h-5 w-5" />}
          label="Validated, last 30 days"
          value={validated.length}
          description="In use, and refusable below"
          tone="blue"
          size="compact"
        />
      </div>

      <ValidationReviewsBoard pending={waiting} decided={decided} validated={validated} />
    </div>
  );
}
