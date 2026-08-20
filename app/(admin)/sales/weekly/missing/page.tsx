import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

// Consolidated into the single Weekly Mapping workspace. This pointed at `?tab=missing-labels`,
// which has never been a valid tab key — the workspace silently fell back to Branch → Region.
// Land on the workspace directly instead.
export default function WeeklyMissingRedirect() {
  redirect("/sales/weekly/mapping");
}
