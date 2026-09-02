// RETIRED 2026-08-28, by the owner, in the conversation.
//
// Rep Doctor Lists — each rep's assigned doctor list from the CRM plan. Super Admin only.
//
// Both this board and Rep Doctor Lists read the same iReports360 plan mirror and answered the same
// question with two different, disagreeing measures. This one scored each doctor against the GRADE
// norm (A=2/B=1/C=1) instead of the number of calls the rep's own plan asked for. Measured on
// production for August 2026 that is the wrong target on 6,307 of 8,635 graded doctors — 73%. It
// flattered (a grade-B doctor turned green after one visit while the plan asked for more than one
// on 77% of them) and it punished (on 1,496 grade-A doctors the plan asked for a single visit and
// the board demanded two), and it passed over-visiting as green, which the owner has ruled is a
// deviation rather than a win.
//
// The owner's instruction was to retire both modules and rebuild from the beginning. Every
// navigation entry is withdrawn (src/config/system-navigation.ts) and the CEO Command Center embed
// is gone; this stub closes the last door — a bookmark or a browser-history hit.
//
// THE COMPONENTS ARE NOW DELETED TOO (2026-09-02, at the owner's instruction). The rebuild landed —
// the KPIs board (/admin/kpis) and Reps List (/admin/reps-list) — so the shells this route used to
// render had been unreachable for five days and were carrying the retired vocabulary forward as a
// style reference. Gone with them: rep-doctor-lists-board.tsx, rep-doctor-lists-tables.tsx,
// rep-doctor-trend-panel.tsx, rep-doctor-kpi-tone.ts, and src/lib/crm/rep-doctor-lists-trend.ts.
//
// src/lib/crm/rep-doctor-lists.ts SURVIVES and is load-bearing: the KPIs board and the Reps List
// activity chip both read it. It is the library the retirement note meant when it said the rebuild
// would draw on it — do not follow the deletions above into it.
//
// THIS STUB STAYS. It is not dead code: it is the redirect that catches a bookmark.
//
// DO NOT restore this page, and do not repair the scoring in place. The rebuild is the fix.
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function RepDoctorListsPage() {
  redirect("/admin/crm-tools");
}
