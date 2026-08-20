import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

// Consolidated into the single Weekly Mapping workspace. The Missing Products tab it used to
// land on was removed 2026-08-21 (it read a validation_state weekly never produces), so this
// keeps the old bookmark alive by landing on the workspace itself.
export default function WeeklyMissingProductsRedirect() {
  redirect("/sales/weekly/mapping");
}
