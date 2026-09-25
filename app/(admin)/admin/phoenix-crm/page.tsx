import { redirect } from "next/navigation";

import { resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { retiredPilotTabPassThrough, retiredPilotTabQuery } from "@/lib/phoenix-crm/retired-pilot";

export const dynamic = "force-dynamic";

/** Only the pilot's own tab crosses to the portal twin, which maps it; matches src/lib/navigation/portal-twins.ts. */
function preservedQuery(params: Record<string, string | string[] | undefined>) {
  return retiredPilotTabPassThrough(params.tab);
}

// The 2026-09-14 Phoenix CRM pilot is retired (the owner, 2026-09-25): its admin page forwards to the
// live field app, on the tab doing the same work. A portal viewer goes by the pilot's portal twin,
// which maps the tab the same way and forwards to the portal field app.
export default async function RetiredAdminPhoenixCrmPilotPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const access = await resolveAccessContextFromPage();
  const params = await searchParams;
  // The admin layout already sends a portal viewer to this twin; the literal path is what
  // tests/portal-twin-forwarding.test.ts reads to keep that table honest.
  if (resolveNavigationMode(access) === "employee-portal") {
    redirect(`/employee-portals/phoenix-crm${preservedQuery(params)}`);
  }
  redirect(`/admin/field-crm${retiredPilotTabQuery(params.tab)}`);
}
