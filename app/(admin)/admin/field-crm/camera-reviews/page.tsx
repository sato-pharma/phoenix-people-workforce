import { redirect } from "next/navigation";
import { Camera } from "lucide-react";

import { AdminPageHero } from "@/components/admin/admin-design-system";
import { CameraReviewsBoard } from "@/components/phoenix-crm/camera-reviews-board";
import { canAccess } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { canEnterMissedRecords, resolvePhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { loadCameraPage } from "@/lib/phoenix-crm/server/camera-items";

export const dynamic = "force-dynamic";

/**
 * Camera reviews — every item the Phoenix Camera sent, and the Super Admin's decision on the ones that wait
 * (owner, 20 Nov 2026: "Every camera visit and validation lands there, even if from the first three").
 *
 * Four tabs: Waiting (his decision), Recorded (recorded at once or approved, still rejectable), Archive
 * (rejected, or over 36 hours old) and Daily limit (how many a rep's Phoenix day records at once).
 *
 * 🔴 THE SUPER ADMIN'S ALONE — `canEnterMissedRecords`, on the page and inside every service it calls; never the
 * SFE ("Exclude the SFE totally"). The redirect rather than a message is deliberate: a page that does not
 * describe itself to somebody who may not read it.
 */
export default async function PhoenixCrmCameraReviewsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const access = await resolveAccessContextFromPage();
  if (!(await canAccess(access, "phoenix_crm", "update"))) redirect("/admin");
  const viewer = await resolvePhoenixCrmViewer(access).catch(() => null);
  if (!viewer || !canEnterMissedRecords(viewer)) redirect("/admin");

  const raw = (await searchParams).tab;
  const tab = typeof raw === "string" ? raw : null;
  const showLimit = tab === "limit";
  const view = await loadCameraPage(viewer, showLimit ? "waiting" : tab);

  return (
    <div className="space-y-5">
      <AdminPageHero
        description="Every photo the Phoenix Camera sent. The first ones of a rep's day that pass every check are recorded at once; the rest wait here for your decision. The rep reads only that the photo was sent."
        eyebrow="CRM"
        icon={<Camera className="h-3.5 w-3.5" />}
        title="Camera reviews"
      />
      <CameraReviewsBoard showLimit={showLimit} view={view} />
    </div>
  );
}
