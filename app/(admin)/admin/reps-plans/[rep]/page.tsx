// RETIRED. The Reps Plans rep drill-down moved under Reps List on 2026-09-21, and off it again the same
// day: the owner took the call rate off Reps List because KPIs already carries it ("no need for it to
// be in the reps list tab"), and chose "Open it from KPIs" for the visits page. It lives at
// /admin/kpis/call-rate/[rep] now, and this stub forwards there with the same rep key, month and window.
// That page runs every KPIs gate; this one renders nothing.
import { redirect } from "next/navigation";

import { ADMIN_KPIS_PATH, kpisCallRateHref } from "@/lib/crm/kpis-call-rate-route";

export const dynamic = "force-dynamic";

type PageProps = {
  params: Promise<{ rep: string }>;
  searchParams?: Promise<{ month?: string; period?: string }>;
};

export default async function RetiredRepVisitsPage({ params, searchParams }: PageProps) {
  const { rep } = await params;
  redirect(kpisCallRateHref({ basePath: ADMIN_KPIS_PATH, query: await searchParams, rep }));
}
