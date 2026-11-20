import { adminSoftDepthClassName } from "@/components/admin/admin-design-tokens";
import { LANDING_INK, LandingEmpty, LandingPanel } from "@/components/employee-portal/landing-kit";
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
      <div className={`min-w-0 border border-slate-200 bg-white ${adminSoftDepthClassName}`}>
        <LandingEmpty>No one currently routes their {moduleLabel} requests to you for approval.</LandingEmpty>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* One kit panel per role, its people on a hairline grid. The sentence that sat above the
          groups is gone (owner, 2026-11-20: no sentence under any header). */}
      {data.groups.map((group) => (
        <LandingPanel
          key={group.title}
          title={
            <>
              {group.title} <span className="tabular-nums text-slate-500">{group.people.length}</span>
            </>
          }
        >
          <div className="grid gap-px bg-slate-200 sm:grid-cols-2">
            {group.people.map((person) => (
              <div key={person.hrId} className="min-w-0 bg-white px-3 py-2.5 sm:px-4">
                {/* min-w-0 above so a long name cannot stretch this card's grid track; break-words
                    so it wraps rather than ending in an ellipsis. These are RECORD names. */}
                <p className={`break-words text-sm font-bold ${LANDING_INK}`} dir="auto">{person.name}</p>
                <p className="break-words text-xs text-slate-500">{person.jobTitle ?? "—"}</p>
              </div>
            ))}
          </div>
        </LandingPanel>
      ))}
    </div>
  );
}
