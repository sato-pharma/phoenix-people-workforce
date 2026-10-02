import { redirect } from "next/navigation";
import { CopyCheck, ListChecks, Users } from "lucide-react";

import { AdminCallout, AdminPageHero, AdminStatCard, AdminTableShell } from "@/components/admin/admin-design-system";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { resolvePhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { canReadIntegrityBoard } from "@/lib/phoenix-crm/server/integrity-board";
import { loadDuplicateCustomers, type DuplicateCustomerGroup } from "@/lib/phoenix-crm/server/duplicate-customers";

export const dynamic = "force-dynamic";

/**
 * One doctor entered twice on one rep's own list — the Super Admin's and the SFE Manager's page.
 *
 * 🔒 IT IS NOT THE INTEGRITY BOARD AND MUST NEVER BE FOLDED INTO IT. That board exists because
 * somebody may have been dishonest. This exists because somebody typed a name twice. They share
 * two readers and nothing else, and putting a clerical double-entry under a heading about
 * integrity would put a rep under suspicion for a typing mistake — which is the shape of harm the
 * owner's own rule is about: a false positive accuses a real person. Every word on this page is
 * housekeeping, and none of it implies intent.
 *
 * 🔴 IT SITS UNDER /admin FOR A STRUCTURAL REASON, not a tidy one. Golden Rule #1 says the rep is
 * never shown what judges his work, and the Phoenix CRM tabs are the same component tree the field
 * app renders — one wrong role check there would put this list in front of the one person it is
 * about. There is no such tree here: a rep cannot open /admin at all.
 *
 * 🔴 NOTHING HERE ACTS. Removing a duplicate is the two-step request the owner set — the district
 * manager, then SFE — and a button on this page would be a third way into a decision he gave to
 * those two seats. Reading it is the whole feature.
 */

function GroupNames({ group }: { group: DuplicateCustomerGroup }) {
  return (
    <ul className="space-y-1">
      {group.entries.map((entry) => (
        <li key={entry.customerId} className="flex items-start gap-2 text-sm leading-6 text-slate-700">
          <span aria-hidden className="mt-2 h-1.5 w-1.5 shrink-0 bg-slate-400" />
          {/* A customer name is free text and nearly always Arabic — single-language, which is the
              case block-level dir="auto" is house style for. The grade beside it is ours. */}
          <span dir="auto" className="min-w-0 break-words">
            {entry.name}
            {entry.speciality || entry.grade ? (
              <span className="text-slate-500"> · {[entry.speciality, entry.grade].filter(Boolean).join(" · ")}</span>
            ) : null}
          </span>
        </li>
      ))}
    </ul>
  );
}

export default async function PhoenixCrmDuplicateCustomersPage() {
  const access = await resolveAccessContextFromPage();
  const viewer = await resolvePhoenixCrmViewer(access).catch(() => null);
  // The same refusal shape as the integrity board: a redirect rather than a message, so the page
  // does not describe itself to somebody who may not read it.
  if (!viewer || !canReadIntegrityBoard(viewer)) redirect("/admin");

  const view = await loadDuplicateCustomers(viewer);
  const reps = new Set(view.groups.map((group) => group.seatId)).size;

  return (
    <div className="space-y-5">
      <AdminPageHero
        eyebrow="CRM"
        title="One doctor, two rows"
        description="Where one rep's own list holds the same customer twice — the same name spelled one way or two, on one seat. It is housekeeping, not a flag: nobody is accused of anything, and the rep is never shown it. Removing one is still the district manager's and SFE's two-step request."
        icon={<CopyCheck className="h-3.5 w-3.5" />}
      />

      <div className="grid gap-3 sm:grid-cols-3">
        <AdminStatCard
          icon={<CopyCheck className="h-5 w-5" />}
          label="Customers held twice"
          value={view.groups.length}
          description="Each one is a name on a single rep's list"
          tone="orange"
          size="compact"
        />
        <AdminStatCard
          icon={<ListChecks className="h-5 w-5" />}
          label="Rows involved"
          value={view.rows}
          description="Always more than the names above"
          tone="blue"
          size="compact"
        />
        <AdminStatCard
          icon={<Users className="h-5 w-5" />}
          label="Reps involved"
          value={reps}
          description="A list with none of these is the normal state"
          tone="violet"
          size="compact"
        />
      </div>

      {view.groups.length === 0 ? (
        <AdminCallout tone="success">
          <span>
            No rep&rsquo;s list holds the same customer twice. The check reads every list in the company, and a name is only counted when the
            spelling matches and the specialities do not disagree.
          </span>
        </AdminCallout>
      ) : (
        <AdminTableShell
          title="The same customer, twice on one list"
          description="Two rows a rep cannot be asked to visit separately. Each group is one seat and one name; the spellings are shown exactly as they were typed, because the difference between them is usually the whole story."
        >
          {/* Desktop: the full table. `table-fixed` with a colgroup, never a min-width in a scroller. */}
          <div className="hidden lg:block">
            <table className="w-full table-fixed border-collapse">
              <colgroup>
                <col className="w-[22%]" />
                <col className="w-[26%]" />
                <col className="w-[52%]" />
              </colgroup>
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50 text-left text-xs font-bold uppercase tracking-wide text-slate-500">
                  <th className="px-5 py-3">Rep</th>
                  <th className="px-5 py-3">Territory</th>
                  <th className="px-5 py-3">The rows</th>
                </tr>
              </thead>
              <tbody>
                {view.groups.map((group) => (
                  <tr key={`${group.seatId}:${group.nameKey}`} className="border-b border-slate-100 align-top even:bg-slate-50/60">
                    <td className="break-words px-5 py-4 text-sm font-semibold text-slate-900">{group.repName ?? "Seat vacant"}</td>
                    <td className="break-words px-5 py-4 text-sm text-slate-700">{group.territoryName ?? "—"}</td>
                    <td className="px-5 py-4">
                      <GroupNames group={group} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Mobile: the same groups as cards. */}
          <div className="space-y-3 px-5 py-4 sm:px-6 lg:hidden">
            {view.groups.map((group) => (
              <div key={`${group.seatId}:${group.nameKey}`} className="border border-slate-200 bg-white p-4">
                <p className="break-words text-sm font-black text-slate-900">{group.repName ?? "Seat vacant"}</p>
                <p className="mt-0.5 break-words text-xs font-semibold text-slate-500">{group.territoryName ?? "—"}</p>
                <div className="mt-2">
                  <GroupNames group={group} />
                </div>
              </div>
            ))}
          </div>
        </AdminTableShell>
      )}
    </div>
  );
}
