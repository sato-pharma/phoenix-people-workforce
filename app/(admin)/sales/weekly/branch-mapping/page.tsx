import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

// Consolidated into the single Weekly Mapping workspace (Branch → Region tab).
export default function WeeklyBranchMappingRedirect() {
  redirect("/sales/weekly/mapping?tab=branch");
}
