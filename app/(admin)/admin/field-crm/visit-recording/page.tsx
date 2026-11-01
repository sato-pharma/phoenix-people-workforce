import { redirect } from "next/navigation";
import { Mic } from "lucide-react";

import { AdminPageHero } from "@/components/admin/admin-design-system";
import { VisitRecordingAdmin } from "@/components/phoenix-crm/visit-recording-admin";
import { canAccess } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { resolvePhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { canManageVisitRecording, loadVisitRecordingAdmin } from "@/lib/phoenix-crm/server/visit-recordings";

export const dynamic = "force-dynamic";

/**
 * Visit recording — the Super Admin chooses which reps record the conversation before logging a visit.
 *
 * Owner, 2026-10-16: "i want to build a feature is that admin have page listed in it all reps with a
 * toggle beside evryone … this only works to who the admin chooose not everyone". His answers the same
 * day: doctor AND pharmacy visits, 30 seconds to 15 minutes, a blocked microphone blocks the visit, and
 * the Super Admin downloads and deletes recordings at any time.
 *
 * 🔴 THE SUPER ADMIN'S ALONE — `canManageVisitRecording`, on the page and inside every service it calls.
 * The redirect rather than a message is deliberate: a page that does not describe itself to
 * somebody who may not read it.
 */
export default async function PhoenixCrmVisitRecordingPage() {
  const access = await resolveAccessContextFromPage();
  if (!(await canAccess(access, "phoenix_crm", "update"))) redirect("/admin");
  const viewer = await resolvePhoenixCrmViewer(access).catch(() => null);
  if (!viewer || !canManageVisitRecording(viewer)) redirect("/admin");

  const view = await loadVisitRecordingAdmin(viewer);

  return (
    <div className="space-y-5">
      <AdminPageHero
        description="Choose the reps who record each visit. A switched-on rep opens the recorder before going in, records the conversation, and only then logs the visit. Every other rep logs visits exactly as before. Listen to, download or delete any recording here."
        eyebrow="CRM"
        icon={<Mic className="h-3.5 w-3.5" />}
        title="Visit recording"
      />
      <VisitRecordingAdmin view={view} />
    </div>
  );
}
