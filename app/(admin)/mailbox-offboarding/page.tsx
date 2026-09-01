import { redirect } from "next/navigation";

import { MailboxOffboardingWorkspace } from "@/components/mailbox-offboarding/mailbox-offboarding-workspace";
import { canAccess } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import {
  getMailboxOffboardingDashboardData,
  isMailboxOffboardingSchemaMissing,
  mailboxOffboardingErrorMessage,
} from "@/lib/mailbox-offboarding/service";
import type { MailboxOffboardingDashboardData } from "@/lib/mailbox-offboarding/types";

export const dynamic = "force-dynamic";

function mailboxPageError(error: unknown) {
  if (isMailboxOffboardingSchemaMissing(error)) {
    return "The mailbox offboarding register is not ready. Run the Supabase migration for mailbox_offboarding_tasks.";
  }
  return mailboxOffboardingErrorMessage(error);
}

export default async function MailboxOffboardingPage() {
  const access = await resolveAccessContextFromPage();
  if (!(await canAccess(access, "mailbox_offboarding", "read"))) {
    redirect("/employee-portals");
  }

  // Read and write are separate gates: the CEO reads this
  // register, HR Operations acts on it. The workspace hides every control when this is false and
  // the route handler asserts the same permission again — the page check is UX, the route is the
  // security boundary.
  const canRecord = await canAccess(access, "mailbox_offboarding", "update");
  const canOpen = await canAccess(access, "mailbox_offboarding", "create");

  let initialData: MailboxOffboardingDashboardData | null = null;
  let initialError: string | null = null;

  try {
    initialData = await getMailboxOffboardingDashboardData();
  } catch (error) {
    initialError = mailboxPageError(error);
  }

  return (
    <MailboxOffboardingWorkspace
      canOpen={canOpen}
      canRecord={canRecord}
      initialData={initialData}
      initialError={initialError}
    />
  );
}
