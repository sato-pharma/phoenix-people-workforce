// MERGED INTO REPS LIST 2026-09-21, by the owner, in the conversation: "merge the 2 modules into 1
// module WHICH REPS LIST" — and "make sure you're not duplicating data".
//
// Reps Plans is now the Call rate tab of the portal's Reps List
// (/employee-portals/reps-list?tab=call-rate), which this stub forwards to with every filter the old
// link carried. Same board, same scope (getDoctorCoverageScope), same gate (canAccessRepsPlans); the
// Reps List page runs all three, and a seat without the tab lands on its contact list.
import { redirect } from "next/navigation";

import { callRateHref } from "@/lib/crm/reps-list-call-rate-route";

export const dynamic = "force-dynamic";

type PageProps = {
  searchParams?: Promise<{ line?: string; month?: string; period?: string; region?: string; rep?: string }>;
};

export default async function RetiredPortalRepsPlansPage({ searchParams }: PageProps) {
  redirect(callRateHref({ basePath: "/employee-portals/reps-list", query: await searchParams }));
}
