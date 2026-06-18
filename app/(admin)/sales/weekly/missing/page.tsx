import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

// Consolidated into the single Weekly Mapping workspace (Missing Labels tab).
export default function WeeklyMissingRedirect() {
  redirect("/sales/weekly/mapping?tab=missing-labels");
}
