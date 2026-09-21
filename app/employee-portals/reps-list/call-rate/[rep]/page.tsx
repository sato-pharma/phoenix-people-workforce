// RETIRED 2026-09-21. The owner took the call rate off Reps List the same day it arrived there
// ("since the call rate is already in the KPIs tab ... no need for it to be in the reps list tab"),
// and chose "Open it from KPIs" for the per-rep visits page. It lives at
// /employee-portals/kpis/call-rate/[rep] now, behind the KPIs gates, and this address forwards there
// with the same rep key, month and window. That page runs every gate; this one renders nothing.
import { redirect } from "next/navigation";

import { kpisCallRateHref, PORTAL_KPIS_PATH } from "@/lib/crm/kpis-call-rate-route";

export const dynamic = "force-dynamic";

type PageProps = {
  params: Promise<{ rep: string }>;
  searchParams?: Promise<{ month?: string; period?: string }>;
};

export default async function RetiredPortalRepsListRepVisitsPage({ params, searchParams }: PageProps) {
  const { rep } = await params;
  redirect(kpisCallRateHref({ basePath: PORTAL_KPIS_PATH, query: await searchParams, rep }));
}
