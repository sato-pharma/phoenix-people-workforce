import { AppShell } from "@/components/layout/app-shell";
import { OutstationRequestsAdmin } from "@/components/outstation/outstation-requests-admin";
import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { listOutstationRequests } from "@/lib/outstation/service";

export const dynamic = "force-dynamic";

export default async function AdminOutstationRequestsPage() {
  const access = await resolveAccessContextFromPage();
  await assertPermission(access, "outstation", "read");
  const requests = await listOutstationRequests();

  return (
    <AppShell showTopbar={false}>
      <OutstationRequestsAdmin requests={requests} />
    </AppShell>
  );
}
