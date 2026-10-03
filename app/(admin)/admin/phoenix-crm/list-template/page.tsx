import { redirect } from "next/navigation";
import { ClipboardList } from "lucide-react";

import { AdminCallout, AdminPageHero } from "@/components/admin/admin-design-system";
import { PhoenixCrmListTemplateWorkspace } from "@/components/phoenix-crm/list-template-workspace";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { resolvePhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { canReadIntegrityBoard } from "@/lib/phoenix-crm/server/integrity-board";
import { listTemplateTerritories } from "@/lib/phoenix-crm/server/list-template";

export const dynamic = "force-dynamic";

/**
 * Phoenix CRM — load a territory's customer list from a sheet. The SFE Manager's and the Super Admin's.
 *
 * Owner's ask, 2026-10-02, when he was asked who grades an add on a territory with no district manager:
 * a third option, where SFE sends the rep a sheet, the rep fills in his list, and SFE uploads it so the
 * list appears. The ordinary path — the rep proposes, the district manager grades, SFE admits — is
 * untouched and remains the normal one; this is for the list that cannot travel that way: a territory
 * whose manager chain is vacant, a seat being staffed from scratch, a whole list at once.
 *
 * 🔴 IT SITS UNDER /admin FOR A STRUCTURAL REASON, not a tidy one. Golden Rule #1 says the rep is never
 * shown what judges his work, and the Phoenix CRM tabs are the same component tree the field app
 * renders — one wrong role check there would put the grades somebody set for him in front of him. There
 * is no such tree here: a rep cannot open /admin at all.
 *
 * 🔴 AND IT NEVER SKIPS THE DOOR. A customer loaded here lands as `pending`: the rep still validates him
 * at his clinic with a live photo and the location captured on the spot, because that is the one thing a
 * spreadsheet cannot carry and the one thing the place rule is about.
 */
export default async function PhoenixCrmListTemplatePage() {
  const access = await resolveAccessContextFromPage();
  const viewer = await resolvePhoenixCrmViewer(access).catch(() => null);
  // The same refusal shape as the integrity board: a redirect rather than a message, so the page does
  // not describe itself to somebody who may not read it.
  if (!viewer || !canReadIntegrityBoard(viewer) || !viewer.canApprove) redirect("/admin");

  const territories = await listTemplateTerritories(viewer);

  return (
    <div className="space-y-5">
      <AdminPageHero
        description="Send a territory's medical representative a sheet, and load his list back from it. Each customer appears under To validate on his own list, with the grade and the potential you set here — and he validates each one at the clinic, which is the part no sheet can carry."
        eyebrow="CRM"
        icon={<ClipboardList className="h-3.5 w-3.5" />}
        title="Load a customer list"
      />

      <AdminCallout tone="neutral">
        <span>
          The ordinary way onto a list is unchanged: the rep asks, his district manager confirms the grade and sets the potential, then SFE
          approves. Use this where that cannot run — a territory with no district manager, or a seat whose whole list has to be loaded at
          once. Either way a rep never sets his own grades.
        </span>
      </AdminCallout>

      <PhoenixCrmListTemplateWorkspace territories={territories} />
    </div>
  );
}
