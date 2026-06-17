import { Archive } from "lucide-react";
import { redirect } from "next/navigation";

import { AdminInsightChip, AdminPageHero } from "@/components/admin/admin-design-system";
import { CoachingArchivedList } from "@/components/coaching/coaching-archived-list";
import { canAccess, canManageCoachingReports } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { listArchivedCoachingEvaluations } from "@/lib/coaching/archived";

export const dynamic = "force-dynamic";

export default async function CoachingArchivedPage() {
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

  const rows = await listArchivedCoachingEvaluations({});

  return (
    <div className="space-y-6">
      <AdminPageHero
        badges={
          <div className="flex flex-wrap gap-2">
            <AdminInsightChip>Coaching</AdminInsightChip>
            <AdminInsightChip tone="orange">Resigned Evaluations</AdminInsightChip>
            <AdminInsightChip tone="slate">{rows.length} archived</AdminInsightChip>
          </div>
        }
        description="Field coaching evaluations for reps who have resigned (or could not be matched at import). Preserved verbatim so the coach's scoring and written notes are never lost."
        eyebrow="Coaching"
        icon={<Archive className="h-3.5 w-3.5" />}
        title="Resigned Coaching Evaluations"
      />
      <CoachingArchivedList rows={rows} />
    </div>
  );
}
