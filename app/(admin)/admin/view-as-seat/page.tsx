import { redirect } from "next/navigation";
import { ScanEye } from "lucide-react";

import { AdminPageHero } from "@/components/admin/admin-design-system";
import { SeatViewPicker } from "@/components/admin/seat-view-picker";
import { listDevPreviewCandidatesByRole } from "@/lib/auth/dev-preview-picker";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { seatViewPortalRoles } from "@/lib/auth/seat-view";
import { seatViewChoices } from "@/lib/auth/seat-view-service";

export const dynamic = "force-dynamic";

// VIEW AS SEAT (src/lib/auth/seat-view.ts). Owner, 2026-10-20: "View as seat … finish it and merge for me
// to use". Super Admin only — the start route checks it again, on his own live session.
export default async function ViewAsSeatPage() {
  const access = await resolveAccessContextFromPage();
  if (access.role !== "Super Admin") {
    redirect("/admin/admin-tools");
  }

  const [choices, candidatesByRole] = await Promise.all([
    Promise.resolve(seatViewChoices()),
    listDevPreviewCandidatesByRole(seatViewPortalRoles()),
  ]);

  return (
    <div className="space-y-6">
      <AdminPageHero
        description="Pick a seat and see the live site exactly as it does — its menu, its pages, its data. An office seat opens by its title, even while it is empty; a field or portal seat opens as one person holding it. Read only, for one hour at most."
        eyebrow="Admin Tools · My Tools"
        icon={<ScanEye className="h-3.5 w-3.5" />}
        title="View as Seat"
      />
      <SeatViewPicker candidatesByRole={candidatesByRole} choices={choices} />
    </div>
  );
}
