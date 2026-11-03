import { AlertTriangle, Wallet } from "lucide-react";
import { Suspense } from "react";

import { Card } from "@/components/ui/card";
import type { AccessContext } from "@/lib/auth/permissions";
import type { Employee360Scope, Employee360SubjectRow } from "@/lib/employee-360/access";
import { loadEmployee360PersonIncentive, type SubjectSignIn } from "@/lib/employee-360/personnel-records";
import type { PersonIncentiveFigures } from "@/lib/employee-360/person-incentive";
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

export function IncentiveFigures({ figures }: { figures: PersonIncentiveFigures | null }) {
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
  return <IncentiveFigures figures={figures} />;
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
