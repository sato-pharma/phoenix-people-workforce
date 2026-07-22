import { redirect } from "next/navigation";

// Calendar Review Requests moved into the Approvals Hub as its "Disputes Inbox" tab —
// canonicalize any old bookmark/deep link onto that one URL instead of maintaining two
// working surfaces for the same decision.
export const dynamic = "force-dynamic";

export default function AdminPrivateCalendarDisputesPage() {
  redirect("/admin/approvals-hub?tab=disputes");
}
