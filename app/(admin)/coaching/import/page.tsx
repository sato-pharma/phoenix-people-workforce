import { FileUp } from "lucide-react";
import { redirect } from "next/navigation";

import { AdminInsightChip, AdminPageHero } from "@/components/admin/admin-design-system";
import { CoachingImportWorkspace } from "@/components/coaching/coaching-import-workspace";
import { canAccess, canManageCoachingReports } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";

export const dynamic = "force-dynamic";

export default async function CoachingImportPage() {
  const access = await resolveAccessContextFromPage();
  if (!access.loginId && !access.hrId) {
    redirect("/login");
  }
  if (!(await canAccess(access, "coaching", "read"))) {
    redirect("/admin/access");
  }
  if (!(canManageCoachingReports(access) && (await canAccess(access, "coaching", "create")))) {
    redirect("/coaching");
  }

  return (
    <div className="space-y-6">
      <AdminPageHero
        badges={
          <div className="flex flex-wrap gap-2">
            <AdminInsightChip>Coaching</AdminInsightChip>
            <AdminInsightChip tone="orange">Historical Import</AdminInsightChip>
            <AdminInsightChip tone="slate">Scores entered as-is (0–5)</AdminInsightChip>
          </div>
        }
        description="Upload past Field Coaching Report workbooks to backfill the coaching history. Matched reps become submitted reports; resigned reps are archived so the coach's effort is preserved."
        eyebrow="Coaching"
        icon={<FileUp className="h-3.5 w-3.5" />}
        title="Import Coaching History"
      />
      <CoachingImportWorkspace />
    </div>
  );
}
