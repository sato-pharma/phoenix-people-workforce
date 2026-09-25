import { redirect } from "next/navigation";

import { retiredPilotTabQuery } from "@/lib/phoenix-crm/retired-pilot";

export const dynamic = "force-dynamic";

// The 2026-09-14 Phoenix CRM pilot is retired (the owner, 2026-09-25). This address, the old
// notifications that name it and the admin pilot page's portal twin all land on the live field app,
// on the tab doing the same work. The field app turns away anyone it does not serve and sends an
// admin-shell viewer on to its own admin twin.
export default async function RetiredPhoenixCrmPilotPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  redirect(`/employee-portals/field-crm${retiredPilotTabQuery((await searchParams).tab)}`);
}
