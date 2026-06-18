import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

// Consolidated into the single Weekly Mapping workspace (Missing Products tab).
export default function WeeklyMissingProductsRedirect() {
  redirect("/sales/weekly/mapping?tab=missing-products");
}
