// MERGED INTO REPS LIST 2026-09-21 (owner: "merge the 2 modules into 1 module WHICH REPS LIST").
//
// The portal's Reps Plans rep drill-down now lives under the Call rate tab, at
// /employee-portals/reps-list/call-rate/[rep], which this stub forwards to with the same rep key and
// the same month, window, line and region. That page runs every gate this one did.
import { redirect } from "next/navigation";

import { callRateHref } from "@/lib/crm/reps-list-call-rate-route";

export const dynamic = "force-dynamic";

type PageProps = {
  params: Promise<{ rep: string }>;
  searchParams?: Promise<{ line?: string; month?: string; period?: string; region?: string }>;
};

export default async function RetiredPortalRepVisitsPage({ params, searchParams }: PageProps) {
  const { rep } = await params;
  redirect(callRateHref({ basePath: "/employee-portals/reps-list", query: await searchParams, rep }));
}
