import type { ApprovalScopeData } from "@/lib/approvals-hub/service";

type Props = {
  data: ApprovalScopeData;
  // Wording for the explanatory copy — "vacation" or "excuse".
  moduleLabel: string;
};

/**
 * "Who I Approve" — the viewer's DIRECT reports (the people they are personally responsible for
 * approving), grouped by role/title. Computed live from the org directory (see buildApprovalScope);
 * this component only renders it, read-only. No hard-coded role list exists anywhere.
 */
export function ApprovalScopeList({ data, moduleLabel }: Props) {
  if (!data || data.totalPeople === 0) {
    return (
      <p className="border border-phx-line bg-white px-4 py-8 text-center text-sm text-slate-500">
        No one currently routes their {moduleLabel} requests to you for approval.
      </p>
    );
  }

  return (
    <div className="space-y-4">
      <p className="text-xs leading-5 text-slate-500">
        Your direct reports — the people whose {moduleLabel} requests you are responsible for approving, grouped by
        role. Derived live from the organization structure.
      </p>

      {data.groups.map((group) => (
        <section key={group.title} className="space-y-2">
          <div className="flex items-baseline gap-2">
            <h3 className="text-[11px] font-black uppercase tracking-[0.14em] text-slate-500">{group.title}</h3>
            <span className="text-[11px] font-bold text-slate-400">{group.people.length}</span>
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            {group.people.map((person) => (
              <div key={person.hrId} className="border border-phx-line bg-white px-4 py-2.5">
                <p className="truncate text-sm font-bold text-slate-900">{person.name}</p>
                <p className="truncate text-xs text-slate-500">{person.jobTitle ?? "—"}</p>
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
