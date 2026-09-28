import { redirect } from "next/navigation";

import { FieldActivityView } from "@/components/field-activity/field-activity-view";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { resolveFieldActivityAccess } from "@/lib/field-activity/access";
import { defaultPeriod } from "@/lib/field-activity/period";

export const dynamic = "force-dynamic";

/**
 * The page is a gate and a shell, nothing more — every figure on it arrives through the API, which
 * applies the scope again. Hiding the sidebar link is UX; this redirect and the route's own check
 * are the security boundary.
 */
export default async function FieldActivityPage() {
  const access = await resolveAccessContextFromPage();
  const resolved = await resolveFieldActivityAccess(access);
  if (!resolved) redirect("/employee-portals");

  const todayIso = new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Cairo" }).format(new Date());
  const period = defaultPeriod(todayIso);
  return <FieldActivityView defaultFrom={period.fromIso} defaultTo={period.toIso} />;
}
