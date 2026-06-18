import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

// Consolidated into the single Weekly Mapping workspace (Products tab). Carries through any
// ?distributor= hint from older "Add Alias" deep-links so the Products tab pre-selects it.
export default async function WeeklyProductMappingRedirect({ searchParams }: { searchParams: Promise<{ distributor?: string }> }) {
  const distributor = (await searchParams)?.distributor;
  const suffix = distributor ? `&distributor=${encodeURIComponent(distributor)}` : "";
  redirect(`/sales/weekly/mapping?tab=products${suffix}`);
}
