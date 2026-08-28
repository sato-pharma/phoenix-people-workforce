import { redirect } from "next/navigation";

import { RetentionWorkspace } from "@/components/retention/retention-workspace";
import { canAccess } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import {
  getRetentionDashboardData,
  isRetentionSchemaMissing,
  retentionErrorMessage,
} from "@/lib/retention/service";
import type { RetentionDashboardData } from "@/lib/retention/types";

export const dynamic = "force-dynamic";

function retentionPageError(error: unknown) {
  if (isRetentionSchemaMissing(error)) {
    return "Retention schema is not ready. Run the Supabase migration for hr_retention_conversations.";
  }
  return retentionErrorMessage(error);
}

export default async function RetentionPage() {
  const access = await resolveAccessContextFromPage();
  if (!(await canAccess(access, "retention", "read"))) {
    redirect("/employee-portals");
  }

  // The CEO reads the roll-up; HR Advisory records the conversations. The composer is hidden when
  // this is false, and the route handler asserts `create` again — the page check is UX only.
  const canRecord = await canAccess(access, "retention", "create");
  // Separate from canRecord on purpose. Recording a conversation and closing the follow-up it
  // produced are different actions, and the route asserts "update" for the second one — passing
  // the create answer for both would be a UI that offers a control the API then refuses.
  const canUpdate = await canAccess(access, "retention", "update");

  let initialData: RetentionDashboardData | null = null;
  let initialError: string | null = null;

  try {
    initialData = await getRetentionDashboardData(access);
  } catch (error) {
    initialError = retentionPageError(error);
  }

  return (
    <RetentionWorkspace
      canRecord={canRecord}
      canUpdate={canUpdate}
      initialData={initialData}
      initialError={initialError}
    />
  );
}
