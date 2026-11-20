// Early Birds recommendations awaiting a decision.
//
// This is the DM's evidence page as much as his decision page: rejecting the top-ranked rep has to
// be justifiable to that rep, so the runners-up and the deterministic reasons are on screen next to
// the buttons, and every earlier rejection is shown as a chain rather than as a mystery.
import { EmployeePortalEmptyState, EmployeePortalPageShell } from "@/components/employee-portal/enterprise-shell";
import { DecisionActions } from "@/components/approvals-hub/decision-actions";
import { LANDING_INK, LandingPanel } from "@/components/employee-portal/landing-kit";
import { PersonPhoto } from "@/components/people/person-photo";
import { formatHireDate, formatPoints, formatStartClock } from "@/components/early-birds/early-birds-format";
import { resolveAuthenticatedPageAccess } from "@/lib/auth/page-access";
import { earlyBirdsReasonSummary, listPendingEarlyBirdsRecommendations } from "@/lib/early-birds/decisions";
import { getEmployeePhotoMap, resolveEmployeePhotoSrc } from "@/lib/employees/employee-photo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function EarlyBirdApprovalsPage() {
  const access = await resolveAuthenticatedPageAccess();

  const shell = (children: React.ReactNode) => (
    <EmployeePortalPageShell
      badge="Approvals Hub"
      description="Confirm the fortnight's Early Bird, or reject down to the next candidate."
      title="Early Bird"
    >
      {children}
    </EmployeePortalPageShell>
  );

  const pending = await listPendingEarlyBirdsRecommendations(access);

  if (pending.length === 0) {
    return shell(
      <EmployeePortalEmptyState
        message="Nothing is waiting on you. A recommendation appears here a day after each fortnight closes."
        title="No recommendation pending"
      />,
    );
  }

  const photoMap = await getEmployeePhotoMap().catch(() => new Map());

  return shell(
    <div className="space-y-4">
      {pending.map((candidate) => (
        // One kit panel per fortnight: the period as its title, the candidate's rank in small capitals
        // on the right — never a dark band.
        <LandingPanel
          key={candidate.snapshotId}
          title={candidate.periodLabel}
          right={
            <span className={`text-phx-xs font-bold uppercase tracking-[0.1em] tabular-nums ${LANDING_INK}`}>
              Rank {candidate.candidateRank}
            </span>
          }
        >
          <div className="flex items-center gap-4 px-3 py-4 sm:px-4">
            <PersonPhoto
              name={candidate.employeeName}
              size="md"
              src={resolveEmployeePhotoSrc(candidate.employeeHrId, photoMap)}
            />
            <div className="min-w-0">
              <p className={`break-words text-lg font-black ${LANDING_INK}`} dir="auto">
                {candidate.employeeName}
              </p>
              <p className="break-words text-phx-xs font-semibold uppercase tracking-[0.1em] text-slate-500" dir="auto">
                {candidate.areaName ?? "—"} · joined {formatHireDate(candidate.hireDate)}
              </p>
              <p className="mt-1 break-words text-xs font-semibold text-emerald-700">
                {earlyBirdsReasonSummary(candidate)}
              </p>
            </div>
            <span className={`ml-auto shrink-0 whitespace-nowrap text-xl font-black tabular-nums ${LANDING_INK}`}>
              {formatPoints(candidate.totalScore)}
              <span className="ml-1 text-phx-xs font-bold uppercase tracking-[0.1em] text-slate-500">pts</span>
            </span>
          </div>

          {candidate.rejectedSoFar.length > 0 && (
            // Without this a third recommendation arrives with no explanation of why the first two
            // are gone.
            <div className="border-t border-slate-200 px-3 py-3 sm:px-4">
              <p className="mb-1.5 text-phx-xs font-bold uppercase tracking-[0.1em] text-slate-500">
                Already rejected this fortnight
              </p>
              <div className="space-y-1 border-l-4 border-rose-500 pl-3">
                {candidate.rejectedSoFar.map((entry) => (
                  <p key={entry.name} className="break-words text-phx-xs text-slate-600" dir="auto">
                    <span className={`font-bold ${LANDING_INK}`}>{entry.name}</span>
                    {entry.reason ? ` — ${entry.reason}` : ""}
                  </p>
                ))}
              </div>
            </div>
          )}

          {candidate.runnersUp.length > 0 && (
            <div className="border-t border-slate-200 px-3 py-3 sm:px-4">
              <p className="mb-1.5 text-phx-xs font-bold uppercase tracking-[0.1em] text-slate-500">
                Who you would be choosing over
              </p>
              <div className="divide-y divide-slate-200">
                {candidate.runnersUp.map((runner) => (
                  <div key={runner.rank} className="flex items-center gap-3 py-1.5">
                    <span className="w-5 shrink-0 text-phx-xs font-black tabular-nums text-slate-500">{runner.rank}</span>
                    <span className={`min-w-0 break-words text-xs font-bold ${LANDING_INK}`} dir="auto">
                      {runner.name}
                    </span>
                    <span className="ml-auto shrink-0 whitespace-nowrap text-xs tabular-nums text-slate-500">
                      {formatStartClock(runner.medianStartMinutes)} · {formatPoints(runner.totalScore)} pts
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="border-t border-slate-200 px-3 py-3 sm:px-4">
            <DecisionActions
              actions={{ approve: true, reject: true }}
              backHref="/employee-portals/approvals-hub"
              commentField="comment"
              endpoint={`/api/approvals/early-bird/${candidate.snapshotId}/decision`}
              extraPayload={{ candidateId: candidate.candidateId }}
            />
          </div>
        </LandingPanel>
      ))}
    </div>,
  );
}
