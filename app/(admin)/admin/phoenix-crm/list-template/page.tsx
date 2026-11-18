import { redirect } from "next/navigation";
import { ClipboardList, Download } from "lucide-react";

import { AdminCallout, AdminPageHero } from "@/components/admin/admin-design-system";
import { PhoenixCrmListTemplateWorkspace } from "@/components/phoenix-crm/list-template-workspace";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { resolvePhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { canReadIntegrityBoard } from "@/lib/phoenix-crm/server/integrity-board";
import { lineCustomerListLines } from "@/lib/phoenix-crm/server/line-customer-list";
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
  const lines = lineCustomerListLines(viewer);

  return (
    <div className="space-y-5">
      <AdminPageHero
        description="Send a territory's medical representative a sheet, and load their list back from it. Each customer appears under To validate on their own list, with the grade and the potential you set here — and the rep validates each one at the clinic, which is the part no sheet can carry."
        eyebrow="CRM"
        icon={<ClipboardList className="h-3.5 w-3.5" />}
        title="Load a customer list"
      />

      <AdminCallout tone="neutral">
        <span>
          The ordinary way onto a list is unchanged: the rep asks, their district manager confirms the grade and sets the potential, then SFE
          approves. Use this where that cannot run — a territory with no district manager, or a seat whose whole list has to be loaded at
          once. Either way a rep never sets their own grades.
        </span>
      </AdminCallout>

      <PhoenixCrmListTemplateWorkspace territories={territories} />

      {/* A whole line's list in one workbook (owner, 2026-11-18): region by region, rep by rep. Plain
          links — the file is built on the server, so there is nothing for a client component to hold. */}
      <section className="border border-slate-200 bg-white">
        <div className="border-b border-slate-200 px-5 py-4">
          <h2 className="text-sm font-black uppercase tracking-wide text-slate-900">Export a whole line</h2>
          <p className="mt-1 text-sm font-medium leading-6 text-slate-600">
            Every customer on every rep&rsquo;s list for one line, in one Excel file: a summary by region, a sheet per region with a table per
            rep, and one flat sheet to filter. Validated customers and those waiting to be validated are included; the Archive is not.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3 px-5 py-4">
          {lines.length === 0 ? (
            <span className="text-sm font-semibold text-slate-500">No line is in your scope.</span>
          ) : (
            lines.map((line) => (
              <a
                className="inline-flex min-h-10 items-center justify-center gap-2 rounded-none border border-slate-300 bg-white px-4 py-2 text-sm font-bold text-slate-800 transition hover:border-slate-500"
                href={`/api/phoenix-crm/list/line-export?line=${encodeURIComponent(line.lineCode)}`}
                key={line.lineCode}
              >
                <Download aria-hidden className="h-4 w-4 shrink-0" />
                <span className="break-words">
                  {line.lineName} line · {line.territories} {line.territories === 1 ? "territory" : "territories"} · {line.regions}{" "}
                  {line.regions === 1 ? "region" : "regions"}
                </span>
              </a>
            ))
          )}
        </div>
      </section>
    </div>
  );
}
