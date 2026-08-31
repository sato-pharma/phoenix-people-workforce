// RETIRED 2026-08-31, by the owner, in the conversation.
//
// Doctor List — replaced by Reps List (/admin/reps-list), which this stub redirects to.
//
// His words when he specified the replacement: "if you have another one named rep list, then retire
// it — retire it and build instead of it this one." Both halves were done: this route, and the
// District Manager tab strip that carried it (src/components/crm/district-manager-tabs.tsx, now
// deleted — Plan Verification stands on its own).
//
// NOTHING WAS LOST. Reps List reads the same source (the CRM's own contact list, not visits), uses
// the same access module (src/lib/crm/doctor-list-access.ts) and the same reps-per-manager scope. It
// adds the Line -> Region -> Area -> Rep cascade the owner asked for, and groups each rep's contacts
// by the brick they sit in instead of listing them flat. So this is a rename plus a rebuild, not a
// withdrawal, and the two boards must not both exist — a second door onto the same data is how the
// two diverge on the first edit.
//
// The redirect deliberately PRESERVES nothing from the old URL. Its only parameter was `?rep=<CRM
// agent id>`, and Reps List keys reps by the cascade's own seat-derived key instead. Carrying the
// number across would land a bookmark on the wrong person, which is worse than landing on the board.
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function RetiredDoctorListPage() {
  redirect("/admin/reps-list");
}
