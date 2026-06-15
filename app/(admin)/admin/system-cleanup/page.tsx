import { redirect } from "next/navigation";

import { SystemCleanupCenter } from "@/components/admin/system-cleanup-center";
import {
  assertSystemCleanupAccess,
  listCleanupRecords,
  type SystemCleanupRecordsResponse,
} from "@/lib/admin/system-cleanup";
import { resolveAccessContextFromPage, isForbiddenError } from "@/lib/auth/server";

export const dynamic = "force-dynamic";

// Lives inside the (admin) route group so it inherits the shared AppShell + login
// guard from app/(admin)/layout.tsx (no per-page shell). URL stays /admin/system-cleanup.
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
    <SystemCleanupCenter
      initialData={initialData}
      initialError={initialError}
    />
  );
}
