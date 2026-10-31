import { redirect } from "next/navigation";

import { resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";

export const dynamic = "force-dynamic";

// The old coaching report form takes no new reports (owner, 2026-10-31): the Team Coaching Skills Survey
// replaced it. This address and every old link to it land on the survey. The 122 old reports stay
// readable at /coaching.
// A portal viewer is forwarded by the admin layout before this runs (src/lib/navigation/portal-twins.ts);
// the first redirect is the page's own declaration of that twin.
export default async function NewCoachingReportPage() {
  const access = await resolveAccessContextFromPage();
  if (resolveNavigationMode(access) === "employee-portal") redirect("/employee-portals/coaching-skills-survey");
  redirect("/coaching/skills-survey");
}
