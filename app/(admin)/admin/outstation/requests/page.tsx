import { OutstationRequestsAdmin } from "@/components/outstation/outstation-requests-admin";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { assertOutstationAdminAccess } from "@/lib/outstation/admin-access";
import { listOutstationRequests } from "@/lib/outstation/service";

export const dynamic = "force-dynamic";

export default async function AdminOutstationRequestsPage() {
  const access = await resolveAccessContextFromPage();
  await assertOutstationAdminAccess(access, "approve");
  const requests = await listOutstationRequests({ includeCarEvidenceSignedUrls: true });

  return <OutstationRequestsAdmin requests={requests} />;
}
