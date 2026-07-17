import type { ApprovalScopeData } from "@/lib/approvals-hub/service";

type Props = {
  data: ApprovalScopeData;
  // Wording for the explanatory copy — "vacation" or "excuse".
  moduleLabel: string;
  // Leave includes a manager-of-manager (second-level) step; excuse is direct-manager only.
  includesSecondLevel: boolean;
};

/**
 * "Who I Approve" — the people whose leave/excuse requests route to the viewer, grouped by
 * role/title. The data is computed live from the org directory (see buildApprovalScope); this
 * component only renders it, read-only. No hard-coded role list exists anywhere.
 */
export function ApprovalScopeList({ data, moduleLabel, includesSecondLevel }: Props) {
  if (!data || data.totalPeople === 0) {
    return (
      <p className="border border-[#e4e9ec] bg-white px-4 py-8 text-center text-sm text-slate-500">
        No one currently routes their {moduleLabel} requests to you for approval.
      </p>
    );
  }

  return (
    <div className="space-y-4">
      <p className="text-xs leading-5 text-slate-500">
        The people whose {moduleLabel} requests come to you for approval, grouped by role — derived live from the
        organization structure.{" "}
        {includesSecondLevel ? (
          <>
            Includes your <span className="font-semibold text-slate-600">direct</span> reports and{" "}
            <span className="font-semibold text-slate-600">second-level</span> reports (where you are the
            manager-of-manager).
          </>
        ) : (
          <>
            Excuses are a single-step approval, so this is your <span className="font-semibold text-slate-600">direct</span>{" "}
            reports only.
          </>
        )}
      </p>

      {data.groups.map((group) => (
        <section key={group.title} className="space-y-2">
          <div className="flex items-baseline gap-2">
            <h3 className="text-[11px] font-black uppercase tracking-[0.14em] text-slate-500">{group.title}</h3>
            <span className="text-[11px] font-bold text-slate-400">{group.people.length}</span>
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            {group.people.map((person) => (
              <div
                key={person.hrId}
                className="flex items-center justify-between gap-3 border border-[#e4e9ec] bg-white px-4 py-2.5"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-bold text-slate-900">{person.name}</p>
                  <p className="truncate text-xs text-slate-500">{person.jobTitle ?? "—"}</p>
                </div>
                <span
                  className={`shrink-0 whitespace-nowrap rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${
                    person.relation === "direct" ? "bg-orange-100 text-orange-700" : "bg-slate-100 text-slate-500"
                  }`}
                >
                  {person.relation === "direct" ? "Direct" : "2nd level"}
                </span>
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
