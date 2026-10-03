import { redirect } from "next/navigation";
import { CheckCircle2, Hourglass, MapPinCheck } from "lucide-react";

import { AdminCallout, AdminPageHero, AdminStatCard, AdminTableShell } from "@/components/admin/admin-design-system";
import { ValidatedPlaceList } from "@/components/phoenix-crm/validated-place-list";
import { ValidationReviewQueue } from "@/components/phoenix-crm/validation-review-queue";
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
        description={`Every AM customer a rep validates is checked against its own Google Maps listing: the listing must be that customer, and he must have stood within ${GOOGLE_MATCH_METERS} m of it. A place that does not match is refused at the door. These are the ones the system could not settle — Google had no listing for the customer, or its pin is over ${GOOGLE_STALE_PIN_METERS.toLocaleString("en-GB")} m away — and each waits for you. The rep is told only that the system is checking.`}
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

      {waiting.length === 0 ? (
        <AdminCallout tone="success">
          <span>Nothing is waiting. Every place validated since the check started has either matched its Google Maps listing, been refused at the door, or been decided by you.</span>
        </AdminCallout>
      ) : (
        <AdminTableShell
          title="Waiting for your decision"
          description="Approve validates the customer in the rep's name and his visits start counting. Reject retires the place; when it was his only one, the customer goes back to To validate. The rep reads either as the system's answer."
        >
          <ValidationReviewQueue rows={waiting} />
        </AdminTableShell>
      )}

      {decided.length > 0 ? (
        <AdminTableShell title="Decided in the last 14 days" description="What was approved or rejected, by whom, with the note kept on the record.">
          <ValidationReviewQueue rows={decided} />
        </AdminTableShell>
      ) : null}

      <AdminTableShell
        title="Validations the system did not question"
        description="Only AM customers are checked against Google, so a doctor's validation is never held — and an AM one that matched its listing is not either. These are the places validated in the last 30 days and still in use. Refusing one retires the place and, when it is the customer's only place, sends him back to To validate; he reads the system's own wording and never that a person looked at him."
      >
        {validated.length === 0 ? (
          <AdminCallout tone="neutral">
            <span>Nothing has been validated in the last 30 days.</span>
          </AdminCallout>
        ) : (
          <ValidatedPlaceList rows={validated} />
        )}
      </AdminTableShell>
    </div>
  );
}
