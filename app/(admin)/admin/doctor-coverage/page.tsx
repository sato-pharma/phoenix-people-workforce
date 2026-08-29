// RETIRED 2026-08-28, by the owner, in the conversation.
//
// Doctor Coverage & Frequency — the admin board.
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
// is gone; this stub closes the last door — a bookmark or a browser-history hit. The library code
// under src/lib/crm/ is deliberately left in place for the rebuild to draw on, and is deleted with
// the replacement.
//
// DO NOT restore this page, and do not repair the scoring in place. The rebuild is the fix.
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function DoctorCoveragePage() {
  redirect("/admin/crm-tools");
}
