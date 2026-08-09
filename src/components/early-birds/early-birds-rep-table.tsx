// Deliberately NOT using PortalResponsiveDataList, and deliberately NOT a client component.
//
// This rendered nothing but the shell's "Loading workspace" spinner in every environment, from the
// day it shipped. PortalResponsiveDataList is "use client" and takes getKey/renderCard/renderTable
// as props; functions cannot cross the server→client boundary, so the RSC payload failed to
// serialize and the page never mounted.
//
// "use client" here is NOT the fix — every other caller of that helper can do it, this file cannot.
// It needs SectionHead from portal-command-center (a server hub that imports every command center)
// and SOURCE_BADGE from crm-first-visit-board (which imports the Supabase-backed
// nsm-crm-compliance), so the directive drags rls-server.ts into the client bundle and the route
// 500s on `Can't resolve 'child_process' / 'fs' / 'net' / 'tls'`. Verified both ways.
//
// So the responsive split is inlined below — the same markup PortalResponsiveDataList produces
// (`divide-y divide-slate-100 md:hidden` cards, then the desktop table), with nothing but elements
// crossing the boundary.
//
// Nothing catches this class of bug without opening the page: typecheck and `next build` pass, and
// the route still answers HTTP 200 because the static shell streams before the boundary fails.

import { SectionHead } from "@/components/employee-portal/portal-command-center";
import { PortalDesktopTable } from "@/components/employee-portal/portal-primitives";
import { SOURCE_BADGE } from "@/components/employee-portal/dashboards/crm-first-visit-board";
import type { EarlyBirdsRepProfile, EarlyBirdsRepScore } from "@/lib/early-birds/types";
import { formatPercent, formatPoints, formatStartClock } from "./early-birds-format";

// The evidence table. Desktop gets the full table, mobile gets cards — never a squeezed table.
//
// "GPS-verified days" is a visible column on purpose: the ranking mixes GPS check-in times with
// rep-controlled save times, and a competition that hides which is which is one reps learn to game.

const TH = "px-3 py-2.5 text-left text-[10px] font-black uppercase tracking-[0.12em] text-white";
const TD = "whitespace-nowrap px-3 py-2 text-xs text-slate-700";

const REASON_LABEL: Record<string, string> = {
  insufficient_active_days: "Too few active days",
  insufficient_period_coverage: "Joined mid-fortnight",
  no_start_time_evidence: "No start time recorded",
  not_active_at_period_end: "Not active at period end",
  no_submissions: "No visits submitted",
};

function reasonText(reasons: readonly string[]): string {
  if (reasons.length === 0) return "";
  return reasons.map((reason) => REASON_LABEL[reason] ?? reason).join(" · ");
}

function dominantSource(score: EarlyBirdsRepScore): keyof typeof SOURCE_BADGE {
  if (score.gpsVerifiedVisits > 0) return "gps_checkin";
  if (score.totalVisits > 0) return "save_time";
  return "none";
}

export function EarlyBirdsRepTable({
  scores,
  profiles,
}: {
  scores: EarlyBirdsRepScore[];
  profiles: Map<string, EarlyBirdsRepProfile>;
}) {
  return (
    <div className="overflow-hidden border border-slate-200 bg-white" role="region" aria-label="Early Birds detail">
      <SectionHead
        title="Every rep, in detail"
        right={
          <span className="whitespace-nowrap text-[10px] font-bold uppercase tracking-widest text-slate-400">
            {scores.length} rows
          </span>
        }
      />
      {scores.length === 0 ? (
        <p className="bg-white px-5 py-6 text-sm text-slate-500">No reps in scope for this fortnight.</p>
      ) : (
        <>
          <div className="divide-y divide-slate-100 md:hidden">
            {scores.map((score, index) => {
              const badge = SOURCE_BADGE[dominantSource(score)];
              return (
                <div className="bg-white px-4 py-3" key={score.hrIdKey}>
              <div className="flex items-center gap-2">
                <span className="text-[11px] font-black text-slate-400">{index + 1}</span>
                <p className="whitespace-nowrap text-sm font-bold text-slate-900" dir="auto">
                  {score.name}
                </p>
                <span
                  className={`ml-auto rounded px-1 py-0.5 text-[9px] font-bold uppercase tracking-wide ${badge.className}`}
                  title={badge.title}
                >
                  {badge.label}
                </span>
              </div>
              <div className="mt-2 grid grid-cols-2 gap-2">
                {[
                  ["Median start", formatStartClock(score.medianStartMinutes)],
                  ["Days", `${score.daysWithSubmission}/${score.expectedWorkingDays}`],
                  ["Regular visits", String(score.regularVisits)],
                  ["GPS-verified", `${score.gpsVerifiedVisits}/${score.gpsEligibleVisits}`],
                  ["First places", String(score.dailyWins)],
                  ["Points", score.eligible ? formatPoints(score.totalScore) : "—"],
                ].map(([label, value]) => (
                  <div key={label} className="border border-slate-200 px-2 py-1.5">
                    <p className="whitespace-nowrap text-[9px] font-black uppercase tracking-wider text-slate-400">{label}</p>
                    <p className="whitespace-nowrap text-xs font-bold tabular-nums text-slate-900">{value}</p>
                  </div>
                ))}
              </div>
                  {!score.eligible && (
                    <p className="mt-2 whitespace-nowrap text-[11px] font-semibold text-amber-700">
                      {reasonText(score.ineligibleReasons)}
                    </p>
                  )}
                </div>
              );
            })}
          </div>
          <PortalDesktopTable minWidth="1100px">
            <table className="w-full border-collapse text-xs">
              <thead>
                <tr className="bg-slate-900">
                  <th className={TH}>#</th>
                  <th className={TH}>Rep</th>
                  <th className={TH}>Area</th>
                  <th className={TH}>Days</th>
                  <th className={TH}>Median start</th>
                  <th className={TH}>Visits</th>
                  <th className={TH}>Regular</th>
                  <th className={TH}>GPS-verified</th>
                  <th className={TH}>1st places</th>
                  <th className={TH}>Points</th>
                  <th className={TH}>Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {scores.map((score, index) => {
                  const profile = profiles.get(score.hrIdKey);
                  return (
                    <tr key={score.hrIdKey} className="bg-white hover:bg-slate-50">
                      <td className={`${TD} font-black text-slate-400`}>{index + 1}</td>
                      <td className={`${TD} font-bold text-slate-900`} dir="auto">
                        {score.name}
                      </td>
                      <td className={TD} dir="auto">
                        {profile?.areaName ?? "—"}
                      </td>
                      <td className={`${TD} tabular-nums`}>
                        {score.daysWithSubmission}/{score.expectedWorkingDays}
                      </td>
                      <td className={`${TD} font-bold tabular-nums`}>{formatStartClock(score.medianStartMinutes)}</td>
                      <td className={`${TD} tabular-nums`}>{score.totalVisits}</td>
                      <td className={`${TD} tabular-nums`}>{score.regularVisits}</td>
                      <td className={`${TD} tabular-nums`}>
                        {score.gpsVerifiedVisits}/{score.gpsEligibleVisits}
                        {score.gpsShare !== null && (
                          <span className="ml-1 text-slate-400">({formatPercent(score.gpsShare)})</span>
                        )}
                      </td>
                      <td className={`${TD} tabular-nums`}>{score.dailyWins}</td>
                      <td className={`${TD} font-black tabular-nums text-slate-900`}>
                        {score.eligible ? formatPoints(score.totalScore) : "—"}
                      </td>
                      <td className={TD}>
                        {score.eligible ? (
                          <span className="whitespace-nowrap text-emerald-700">Eligible</span>
                        ) : (
                          <span className="whitespace-nowrap text-amber-700">{reasonText(score.ineligibleReasons)}</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </PortalDesktopTable>
        </>
      )}
    </div>
  );
}
