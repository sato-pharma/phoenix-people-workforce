// RETIRED 2026-08-28, by the owner, in the conversation.
//
// Doctor Coverage & Frequency — the portal twin of the admin board.
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
// THE COMPONENTS ARE NOW DELETED (2026-09-02, at the owner's instruction): doctor-coverage-board.tsx,
// doctor-coverage-tables.tsx, doctor-coverage-filter-bar.tsx and doctor-coverage-norms-editor.tsx.
// Nothing had imported them since the retirement, so they were shells no route could render, and
// they were carrying an obsolete scoring vocabulary forward as a style reference for new boards.
//
// THE LIBRARY STAYS, exactly as this note originally said, and is deleted with the replacement —
// not before it: src/lib/crm/sfe-doctor-coverage.ts, doctor-coverage-scope.ts,
// doctor-coverage-config.ts and doctor-coverage-roles.ts, with their four registered test suites.
// sfe-doctor-coverage.ts is still imported by src/lib/ceo/command-center.ts behind an
// `includeDoctorCoverage` flag that no caller sets today.
//
// THIS STUB STAYS. It is not dead code: it is the redirect that catches a bookmark.
//
// DO NOT restore this page, and do not repair the scoring in place. The rebuild is the fix.
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function PortalDoctorCoveragePage() {
  redirect("/employee-portals");
}
