// RETIRED. Reps Plans merged into Reps List as a Call rate tab on 2026-09-21, and the owner took the
// tab off Reps List the same day because KPIs already carries the call rate ("no need for it to be in
// the reps list tab"). This stub forwards a bookmark or a shared link to /employee-portals/kpis?tab=call-rate,
// carrying the month and the window. It renders nothing of its own — a second live copy of the board
// is exactly what the owner removed.
import { redirect } from "next/navigation";

import { kpisCallRateHref, PORTAL_KPIS_PATH } from "@/lib/crm/kpis-call-rate-route";

export const dynamic = "force-dynamic";

type PageProps = {
  searchParams?: Promise<{ month?: string; period?: string }>;
};

export default async function RetiredPortalRepsPlansPage({ searchParams }: PageProps) {
  redirect(kpisCallRateHref({ basePath: PORTAL_KPIS_PATH, query: await searchParams }));
}
