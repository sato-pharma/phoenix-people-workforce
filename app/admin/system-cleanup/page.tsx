import { redirect } from "next/navigation";

import { SystemCleanupCenter } from "@/components/admin/system-cleanup-center";
import { AppShell } from "@/components/layout/app-shell";
import {
  assertSystemCleanupAccess,
  listCleanupRecords,
  type SystemCleanupRecordsResponse,
} from "@/lib/admin/system-cleanup";
import { resolveAccessContextFromPage, isForbiddenError } from "@/lib/auth/server";

export const dynamic = "force-dynamic";

export default async function SystemCleanupPage() {
  const access = await resolveAccessContextFromPage();
  let initialData: SystemCleanupRecordsResponse | null = null;
  let initialError: string | null = null;

  try {
    await assertSystemCleanupAccess(access, "read");
    initialData = await listCleanupRecords(access, {});
  } catch (error) {
    if (isForbiddenError(error)) {
      redirect("/admin/access");
    }
    initialError = error instanceof Error ? error.message : "System cleanup failed to load.";
  }

  return (
    <AppShell accessContext={access} navigationMode="admin">
      <SystemCleanupCenter
        initialData={initialData}
        initialError={initialError}
      />
    </AppShell>
  );
}
