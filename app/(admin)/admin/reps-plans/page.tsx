// MERGED INTO REPS LIST 2026-09-21, by the owner, in the conversation: "merge the 2 modules into 1
// module WHICH REPS LIST" — and "make sure you're not duplicating data".
//
// Reps Plans is now the Call rate tab of Reps List (/admin/reps-list?tab=call-rate), which this stub
// forwards to. The board, its rules and its scope are unchanged (src/lib/crm/reps-plans.ts, assembled
// by src/lib/crm/reps-list-call-rate.ts), and it keeps its own gate, canAccessRepsPlans, as the tab's.
// Nothing from Reps List's weekly plans tab was copied into it: this page never showed a plan — it
// scored the calls made — so the merge added the call rate and the drill-down and nothing else.
//
// UNLIKE THE DOCTOR LIST STUB, this one PRESERVES the old link's filters. Month, window, line, region
// and rep all mean the same thing on the tab as they did here, and the rep key is the board's own, so
// a bookmark lands on exactly the board it used to open.
import { redirect } from "next/navigation";

import { callRateHref } from "@/lib/crm/reps-list-call-rate-route";

export const dynamic = "force-dynamic";

type PageProps = {
  searchParams?: Promise<{ line?: string; month?: string; period?: string; region?: string; rep?: string }>;
};

export default async function RetiredRepsPlansPage({ searchParams }: PageProps) {
  redirect(callRateHref({ basePath: "/admin/reps-list", query: await searchParams }));
}
