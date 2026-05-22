import { AppShell } from "@/components/layout/app-shell";
import { OutstationRequestsAdmin } from "@/components/outstation/outstation-requests-admin";
import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { listOutstationRequests } from "@/lib/outstation/service";

export const dynamic = "force-dynamic";

function firstSearchParam(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

export default async function AdminOutstationRequestsPage({
  searchParams,
}: {
  searchParams?: Promise<{ requestId?: string | string[] }>;
}) {
  const resolvedSearchParams = await searchParams;
  const initialRequestId = Number(firstSearchParam(resolvedSearchParams?.requestId));
  const access = await resolveAccessContextFromPage();
  await assertPermission(access, "outstation", "read");
  const requests = await listOutstationRequests({ includeCarEvidenceSignedUrls: true });

  return (
    <AppShell navigationMode="admin">
      <OutstationRequestsAdmin
        initialRequestId={Number.isFinite(initialRequestId) ? initialRequestId : null}
        requests={requests}
      />
    </AppShell>
  );
}
