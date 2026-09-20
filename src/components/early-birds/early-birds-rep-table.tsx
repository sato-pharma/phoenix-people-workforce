// Deliberately NOT using PortalResponsiveDataList, and deliberately NOT a client component.
//
// This rendered nothing but the shell's "Loading workspace" spinner in every environment, from the
// day it shipped. PortalResponsiveDataList is "use client" and takes getKey/renderCard/renderTable
// as props; functions cannot cross the server-to-client boundary, so the RSC payload failed to
// serialize and the page never mounted.
//
// "use client" here is NOT the fix. It needs SectionHead from portal-command-center (a server hub
// that imports every command center) and SOURCE_BADGE from crm-first-visit-board (which imports the
// Supabase-backed nsm-crm-compliance), so the directive drags rls-server.ts into the client bundle
// and the route 500s on a missing child_process / fs / net / tls. Verified both ways.
//
// So the responsive split is inlined below, with nothing but elements crossing the boundary.
//
// Nothing catches this class of bug without opening the page: typecheck and `next build` pass, and
// the route still answers HTTP 200 because the static shell streams before the boundary fails.

import { SectionHead } from "@/components/employee-portal/portal-command-center";
import { SOURCE_BADGE } from "@/components/employee-portal/dashboards/crm-first-visit-board";
import type { EarlyBirdsRepProfile, EarlyBirdsRepScore } from "@/lib/early-birds/types";
import { formatPercent, formatPoints, formatStartClock } from "./early-birds-format";
import { EarlyBirdsRepLink, type EarlyBirdsRepLinkContext } from "./early-birds-rep-link";

// The evidence table. Desktop gets the full table, mobile gets cards - never a squeezed table.
//
// "GPS-verified days" is a visible column on purpose: the ranking mixes GPS check-in times with
// rep-controlled save times, and a competition that hides which is which is one reps learn to game.
//
// ## Why this is no longer a PortalDesktopTable (changed 2026-09-18)
//
// It was twelve nowrap columns inside that primitive's overflow-x-auto over a 1100px min-width
// floor - the exact shape the owner's fits-the-screen golden rule names as THE BUG rather than the
// fix. Inside the admin shell's rail the content column is well under 1100px on a normal laptop, so
// the one table on this page a manager actually reads across was the one that pushed sideways.
//
// The remedy the rule allows is MERGING columns, never shrinking type and never an ellipsis. Four
// merges take it to eight, each pair being one fact read two ways rather than two facts:
//
//   Rep    + Area           - who, and where he works
//   Median + source badge   - the time, and what evidence stands behind it
//   Visits + Regular/Campaign split
//   Rep    + the ineligibility reason, which belongs beside the name it explains
//
// table-fixed with a colgroup is what makes it hold: without it the browser sizes columns by
// content and one five-part Egyptian name re-widens the whole table.

const TH = "break-words px-3 py-2.5 text-left text-phx-2xs font-black uppercase tracking-[0.12em] text-white";
const TD = "break-words px-3 py-2 align-top text-xs text-slate-700";

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
  repLink,
  openRepHrIdKey,
}: {
  scores: EarlyBirdsRepScore[];
  profiles: Map<string, EarlyBirdsRepProfile>;
  /** Where a name links to. Omitted leaves the names as plain text, never as dead anchors. */
  repLink?: EarlyBirdsRepLinkContext | null;
  openRepHrIdKey?: string | null;
}) {
  return (
    <div className="overflow-hidden border border-slate-200 bg-white" role="region" aria-label="Early Birds detail">
      <SectionHead
        title="Every rep, in detail"
        right={
          <span className="text-phx-2xs font-bold uppercase tracking-widest text-slate-400">
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
                  {/* The phone card. The name wraps (a five-part Egyptian name is the normal case
                      here) and the source badge is square, per the square-edge golden rule; it
                      carried `rounded` from the day it shipped. */}
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="shrink-0 text-phx-xs font-black text-slate-400">{index + 1}</span>
                    <p className="min-w-0 flex-1 break-words text-sm font-bold text-slate-900">
                      <EarlyBirdsRepLink
                        active={score.hrIdKey === openRepHrIdKey}
                        hrId={score.hrId}
                        link={repLink}
                        name={score.name}
                      />
                    </p>
                    <span
                      className={`ml-auto shrink-0 px-1 py-0.5 text-phx-3xs font-bold uppercase tracking-wide ${badge.className}`}
                      title={badge.title}
                    >
                      {badge.label}
                    </span>
                  </div>
                  <div className="mt-2 grid grid-cols-2 gap-2">
                    {[
                      ["Median start", formatStartClock(score.medianStartMinutes)],
                      ["Days", `${score.daysWithSubmission}/${score.expectedWorkingDays}`],
                      [
                        "Regular visits",
                        score.regularVisitsNoCheckin > 0
                          ? `${score.regularVisits} (${score.regularVisitsNoCheckin} no check-in)`
                          : String(score.regularVisits),
                      ],
                      ["Campaign visits", String(score.campaignVisits)],
                      ["GPS days", `${score.gpsVerifiedDays}/${score.daysWithSubmission}`],
                      ["First places", String(score.dailyWins)],
                      ["Points", score.eligible ? formatPoints(score.totalScore) : "—"],
                    ].map(([label, value]) => (
                      <div key={label} className="min-w-0 border border-slate-200 px-2 py-1.5">
                        <p className="break-words text-phx-3xs font-black uppercase tracking-wider text-slate-400">{label}</p>
                        <p className="break-words text-xs font-bold tabular-nums text-slate-900">{value}</p>
                      </div>
                    ))}
                  </div>
                  {!score.eligible && (
                    // A sentence, not a token, so it wraps. On nowrap two joined reasons ran off a
                    // 375px card.
                    <p className="mt-2 break-words text-phx-xs font-semibold text-amber-700">
                      {reasonText(score.ineligibleReasons)}
                    </p>
                  )}
                </div>
              );
            })}
          </div>

          {/* Desktop. `hidden md:block` is the gate the portal's mobile-table rule looks for; the
              table itself is `w-full table-fixed`, so it can never be wider than this column. */}
          <div className="hidden md:block">
            <table className="w-full table-fixed border-collapse text-left text-xs">
              <colgroup>
                <col className="w-[5%]" />
                <col className="w-[27%]" />
                <col className="w-[15%]" />
                <col className="w-[10%]" />
                <col className="w-[14%]" />
                <col className="w-[14%]" />
                <col className="w-[8%]" />
                <col className="w-[7%]" />
              </colgroup>
              <thead>
                <tr className="bg-slate-900">
                  <th className={TH}>#</th>
                  <th className={TH}>Rep</th>
                  <th className={TH}>Median start</th>
                  <th className={TH}>Days</th>
                  <th className={TH}>Visits</th>
                  <th className={TH}>GPS days</th>
                  <th className={TH}>1st</th>
                  <th className={TH}>Points</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {scores.map((score, index) => {
                  const profile = profiles.get(score.hrIdKey);
                  const badge = SOURCE_BADGE[dominantSource(score)];
                  return (
                    <tr key={score.hrIdKey} className="bg-white hover:bg-slate-50">
                      <td className={`${TD} font-black text-slate-400`}>{index + 1}</td>
                      <td className={TD}>
                        <p className="break-words text-xs font-bold text-slate-900">
                          <EarlyBirdsRepLink
                            active={score.hrIdKey === openRepHrIdKey}
                            hrId={score.hrId}
                            link={repLink}
                            name={score.name}
                          />
                        </p>
                        <p
                          className="break-words text-phx-3xs font-semibold uppercase tracking-wide text-slate-400"
                          dir="auto"
                        >
                          {profile?.areaName ?? "—"}
                        </p>
                        {!score.eligible && (
                          <p className="break-words text-phx-3xs font-semibold text-amber-700">
                            {reasonText(score.ineligibleReasons)}
                          </p>
                        )}
                      </td>
                      <td className={TD}>
                        <p className="break-words font-bold tabular-nums text-slate-900">
                          {formatStartClock(score.medianStartMinutes)}
                        </p>
                        {/* The badge moved into this cell rather than being dropped: a clock with
                            no GPS behind it is not proof of being on site, and the column that
                            says so must sit beside the clock it qualifies. */}
                        <span
                          className={`mt-0.5 inline-block max-w-full break-words px-1 py-0.5 text-phx-3xs font-bold uppercase tracking-wide ${badge.className}`}
                          title={badge.title}
                        >
                          {badge.label}
                        </span>
                      </td>
                      <td className={`${TD} tabular-nums`}>
                        {score.daysWithSubmission}/{score.expectedWorkingDays}
                      </td>
                      <td className={TD}>
                        <p className="break-words font-bold tabular-nums text-slate-900">{score.totalVisits}</p>
                        <p className="break-words text-phx-3xs font-semibold text-slate-400">
                          Regular {score.regularVisits} · Campaign {score.campaignVisits}
                          {score.regularVisitsNoCheckin > 0
                            ? ` · ${score.regularVisitsNoCheckin} no check-in`
                            : ""}
                        </p>
                      </td>
                      {/* DAYS, not visits - a day is what the ranking scores, and a day with no
                          check-in has no start time at all. */}
                      <td className={`${TD} tabular-nums`}>
                        {score.gpsVerifiedDays}/{score.daysWithSubmission}
                        {score.gpsShare !== null && (
                          <span className="ml-1 text-slate-400">({formatPercent(score.gpsShare)})</span>
                        )}
                      </td>
                      <td className={`${TD} tabular-nums`}>{score.dailyWins}</td>
                      <td className={`${TD} font-black tabular-nums text-slate-900`}>
                        {score.eligible ? formatPoints(score.totalScore) : "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
