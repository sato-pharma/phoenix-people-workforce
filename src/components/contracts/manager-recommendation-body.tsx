import Link from "next/link";

import { PortalEmptyState } from "@/components/employee-portal/portal-primitives";
import { ManagerRecommendationPanel } from "@/components/contracts/manager-recommendation-panel";
import { contractRecommendationLabels, type ManagerRecommendationContext } from "@/lib/contracts/manager-recommendation-labels";
import type { TeamRenewal } from "@/lib/contracts/manager-recommendation";
import { formatDateOnly } from "@/lib/date-only";
import { Badge } from "@/components/ui/badge";

/** What /contracts/recommend/<hrId> shows, in either shell — the shell around it is the page's. */
export function ManagerRecommendationBody({
  boardHref,
  context,
  teamHref,
}: {
  boardHref: string;
  context: ManagerRecommendationContext;
  teamHref: string;
}) {
  if (context.state === "not_found") {
    return (
      <PortalEmptyState
        action={<Link className="text-sm font-bold text-orange-700 underline" href={teamHref}>See your team&apos;s renewals</Link>}
        message="This employee is no longer active, or the link is out of date."
        title="No contract renewal to recommend on"
      />
    );
  }
  if (context.state === "forbidden") {
    return (
      <PortalEmptyState
        action={<Link className="text-sm font-bold text-orange-700 underline" href={teamHref}>See your team&apos;s renewals</Link>}
        message="Only a manager above this employee in the reporting line, or HR, can open this renewal."
        title="This renewal is not in your team"
      />
    );
  }
  return <ManagerRecommendationPanel boardHref={boardHref} initialContext={context} />;
}

/**
 * A manager's own list: everyone below them whose contract renews in the next 90 days, each with the
 * way to recommend. Shown on the portal's Contract Renewal page to a manager who cannot open the
 * board, so the 177 reminders already sent with the old /contracts button land somewhere useful.
 */
export function TeamRenewalsList({ renewals }: { renewals: TeamRenewal[] }) {
  if (renewals.length === 0) {
    return (
      <PortalEmptyState
        message="When someone in your team is within 90 days of a contract renewal, they appear here for your recommendation."
        title="No contract renewals coming up in your team"
      />
    );
  }
  return (
    <ul className="divide-y divide-slate-200 border border-slate-200 bg-white">
      {renewals.map((renewal) => (
        <li className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between" key={renewal.hrId}>
          <div className="min-w-0 space-y-0.5">
            <p className="break-words text-sm font-bold text-slate-900">{renewal.name}</p>
            <p className="break-words text-xs text-slate-600">
              {[renewal.jobTitle, renewal.line, renewal.area].filter(Boolean).join(" · ")}
            </p>
            <p className="text-xs text-slate-600">
              Renews {formatDateOnly(renewal.renewalDate, "en", { day: "2-digit", month: "short", year: "numeric" })}
              {renewal.daysUntil === 0 ? " (today)" : ` (in ${renewal.daysUntil} days)`}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {renewal.mine ? (
              <Badge tone={renewal.mine.recommendation === "renew" ? "ok" : "danger"}>
                You said: {contractRecommendationLabels[renewal.mine.recommendation]}
              </Badge>
            ) : (
              <Badge tone="warn">Waiting for you</Badge>
            )}
            <Link
              className="inline-flex items-center border border-slate-900 bg-slate-900 px-3 py-1.5 text-xs font-bold text-white hover:bg-slate-800"
              href={`/employee-portals${renewal.href}`}
            >
              {renewal.mine ? "Change" : "Recommend"}
            </Link>
          </div>
        </li>
      ))}
    </ul>
  );
}
