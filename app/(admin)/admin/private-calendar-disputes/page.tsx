import { redirect } from "next/navigation";
import { FileSearch } from "lucide-react";

import { AdminInsightChip, AdminPageHero } from "@/components/admin/admin-design-system";
import { PrivateCalendarDisputesWorkspace } from "@/components/admin/private-calendar-disputes-workspace";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { attachDisputeContext } from "@/lib/private-calendar/dispute-context";
import { attachDisputeMessages } from "@/lib/private-calendar/dispute-messages";
import { listPendingPrivateCalendarDataDisputes } from "@/lib/private-calendar/disputes";

// THE CALENDAR DISPUTES INBOX — its own mailbox since 2026-10-08 (owner: *"separate the disputes
// inbox into a separate dispute inbox"*). It was the fifth tab of /admin/approvals-hub, which is the
// residual "Other Approvals" queue for resignations and contract renewals: a calendar-accuracy
// review is neither, it is decided by one person only (Super Admin — assertDisputeDecisionActor),
// and mixing it in is what made that hub read as a dumping ground. The hub now bounces
// ?tab=disputes here, so every notification link already in the wild still lands on the decision.
export const dynamic = "force-dynamic";

export default async function AdminPrivateCalendarDisputesPage() {
  const access = await resolveAccessContextFromPage();
  // Super Admin end to end — the same gate the list and the decision assert for themselves. Checked
  // here as well so another role lands somewhere useful instead of on a thrown error.
  if (access.role !== "Super Admin") redirect("/admin/approvals-hub");

  // Each pending request carries its reply thread (so the conversation can be read before deciding)
  // and its context: who the employee is, who she reports to, and what Phoenix ALREADY holds for the
  // disputed day. Both are best-effort — a failed lookup must never hide a waiting decision.
  const disputes = await listPendingPrivateCalendarDataDisputes(access, { withExplanation: true })
    .then(attachDisputeMessages)
    .then(attachDisputeContext)
    .catch(() => []);

  return (
    <div className="space-y-5">
      <AdminPageHero
        badges={(
          <AdminInsightChip tone={disputes.length > 0 ? "orange" : "slate"}>
            {disputes.length} waiting on you
          </AdminInsightChip>
        )}
        description="An employee explains a day their Private Calendar shows with no record — training, a meeting, a double visit or something else — and names who can confirm it. The person they name answers first; then it is yours to decide. Requests with the same reason are grouped, so a confirmed training week is one decision."
        eyebrow="Private Calendar"
        icon={<FileSearch className="h-3.5 w-3.5" />}
        title="Calendar Disputes"
      />
      <PrivateCalendarDisputesWorkspace initialDisputes={disputes} initialError={null} viewerHrId={access.hrId} />
    </div>
  );
}
