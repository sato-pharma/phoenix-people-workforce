import { AlertTriangle, Wallet } from "lucide-react";
import { Suspense } from "react";

import { Card } from "@/components/ui/card";
import type { AccessContext } from "@/lib/auth/permissions";
import type { Employee360Scope, Employee360SubjectRow } from "@/lib/employee-360/access";
import { loadEmployee360PersonIncentive, type SubjectSignIn } from "@/lib/employee-360/personnel-records";
import type { PersonIncentiveFigures } from "@/lib/employee-360/person-incentive";
import { cairoDateTime } from "@/lib/format/cairo-datetime";
import { loadShownIncentiveHistory, type ShownIncentiveHistoryRow } from "@/lib/incentives/shown-figures-store";
import { logPortalFailure } from "@/lib/observability/portal-logging";
import { KpiTile, PREMIUM_CARD, SectionHeader } from "./employee-360-view";

const egp = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const SUB = "The same figure this person's own Incentive tab shows. An estimate until the semester closes.";

function Frame({ sub, children }: { sub: string; children: React.ReactNode }) {
  return (
    <Card className={PREMIUM_CARD}>
      <SectionHeader icon={Wallet} tone="emerald" sub={sub}>
        Incentive
      </SectionHeader>
      {children}
    </Card>
  );
}

/**
 * The figures this person's own tab showed them, newest first (REC-066). The Super Admin's read alone:
 * the loader below asks for it only for him, and a manager or the CEO never receives a row.
 */
export function ShownIncentiveHistory({ rows }: { rows: ShownIncentiveHistoryRow[] | null }) {
  if (rows === null) {
    return <p className="mt-4 text-sm font-semibold text-amber-800">The figures this person was shown could not be read just now.</p>;
  }
  return (
    <div className="mt-5 border-t border-slate-200 pt-4">
      <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Figures this person was shown</p>
      <p className="mt-1 text-sm text-slate-600">
        Stored the first time their own Incentive tab showed each figure, and kept unchanged. Only you see this list.
      </p>
      {rows.length === 0 ? (
        <p className="mt-3 text-sm text-slate-600">No figure has been stored yet. One is stored the next time they open their Incentive tab.</p>
      ) : (
        <ul className="mt-3 divide-y divide-slate-200 border-y border-slate-200">
          {rows.map((row) => (
            <li key={`${row.firstShownAt}-${row.payoutEgp}`} className="grid grid-cols-1 gap-1 py-3 text-sm sm:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_minmax(0,1fr)] sm:gap-3">
              <div className="min-w-0 break-words">
                <p className="font-semibold text-slate-900">{row.semesterLabel}</p>
                <p className="text-slate-600">
                  {row.periods.length} {row.periods.length === 1 ? "month" : "months"} counted
                  {row.periods.length ? `: ${row.periods.join(", ")}` : ""}
                </p>
              </div>
              <div className="min-w-0 break-words text-slate-700">
                <p>Achievement {row.achievementPercent.toFixed(1)}%</p>
                {row.pediaSplit ? (
                  <p>
                    Sato {row.pediaSplit.satoAchievementPercent.toFixed(1)}%
                    {row.pediaSplit.satoHalfWithheld ? ", Sato half withheld" : ""}
                  </p>
                ) : null}
                <p className="font-semibold text-slate-900">EGP {egp.format(row.payoutEgp)}</p>
              </div>
              <div className="min-w-0 break-words text-slate-600">
                <p>First shown {cairoDateTime(row.firstShownAt)}</p>
                <p>Last shown {cairoDateTime(row.lastShownAt)}</p>
                {row.windowNotice ? <p className="text-amber-800">{row.windowNotice}</p> : null}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function IncentiveFigures({
  figures,
  shownHistory,
}: {
  figures: PersonIncentiveFigures | null;
  /** The Super Admin's stored history, or undefined for every other viewer (nothing is drawn). */
  shownHistory?: ShownIncentiveHistoryRow[] | null;
}) {
  if (figures?.state === "none") return null;
  if (!figures || figures.state === "unread") {
    return (
      <Frame sub={SUB}>
        <p className="flex items-start gap-2 text-sm font-semibold text-amber-800">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          Could not be read just now. Reload the page to try again.
        </p>
      </Frame>
    );
  }
  const { achievementPercent, incentiveEgp, satoAchievementPercent, semesterLabel, notice } = figures;
  return (
    <Frame sub={semesterLabel ? `${semesterLabel}. ${SUB}` : SUB}>
      <div className="@container">
        <div className="grid grid-cols-2 border-l border-t border-slate-200 @lg:grid-cols-3">
          <KpiTile
            label="Semester achievement"
            value={achievementPercent == null ? "No target yet" : `${achievementPercent.toFixed(1)}%`}
            explain="Sales against target over the semester the incentive is paid on."
          />
          {satoAchievementPercent != null ? (
            <KpiTile
              label="Sato achievement"
              value={`${satoAchievementPercent.toFixed(1)}%`}
              explain="A Pedia seat is paid on two achievements in this semester. This is the second one."
            />
          ) : null}
          <KpiTile
            label="Estimated incentive"
            value={incentiveEgp == null ? "—" : `EGP ${egp.format(incentiveEgp)}`}
            explain="What the incentive scheme pays at this achievement. Nothing here is paid or decided on this page."
          />
        </div>
      </div>
      {notice ? <p className="mt-3 break-words text-sm font-semibold text-amber-800">{notice}</p> : null}
      {shownHistory !== undefined ? <ShownIncentiveHistory rows={shownHistory} /> : null}
    </Frame>
  );
}

async function LoadedIncentive(props: {
  access: AccessContext;
  target: Employee360SubjectRow;
  scope: Employee360Scope;
  signIn: SubjectSignIn;
}) {
  let figures: PersonIncentiveFigures | null = null;
  try {
    figures = await loadEmployee360PersonIncentive(props);
  } catch (error) {
    logPortalFailure({ route: "/employee-360", module: "employee-360-incentive", role: props.access.role, hrId: props.access.hrId }, error);
  }
  // The stored figures (REC-066) are the Super Admin's read alone (owner, 14 Nov 2026).
  let shownHistory: ShownIncentiveHistoryRow[] | null | undefined;
  if (props.access.role === "Super Admin" && figures !== null) {
    shownHistory = await loadShownIncentiveHistory(props.target.hrId).catch((error: unknown) => {
      logPortalFailure({ route: "/employee-360", module: "incentive-shown-figures", role: props.access.role, hrId: props.access.hrId }, error);
      return null;
    });
  }
  return <IncentiveFigures figures={figures} shownHistory={shownHistory} />;
}

/**
 * The incentive section, streamed: the rest of the report is on screen while this one reads. The page
 * passes it to the view only for a viewer the gate admitted, and the loader asks the gate again.
 */
export function Employee360IncentiveSection(props: {
  access: AccessContext;
  target: Employee360SubjectRow;
  scope: Employee360Scope;
  signIn: SubjectSignIn;
}) {
  return (
    <Suspense
      fallback={
        <Frame sub={SUB}>
          <p className="text-sm text-slate-500">Reading the incentive.</p>
        </Frame>
      }
    >
      <LoadedIncentive {...props} />
    </Suspense>
  );
}
