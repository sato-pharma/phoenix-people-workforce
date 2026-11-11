import { BookUser, ChartColumnBig, Clock, Database, FileSpreadsheet, Network, Radar, Repeat2, ShieldCheck, Users, Wrench } from "lucide-react";
import { Suspense, type ReactNode } from "react";

import { CeoCommandCenter, QuickLinkCard, SectionShell } from "@/components/admin/ceo-command-center";
import { RetentionRiskColumnSection, RetentionRiskColumnSkeleton } from "@/components/admin/retention-risk-band";
import { FinanceAdminBands } from "@/components/admin/finance-command-center";
import { PhoenixIdentityStrip } from "@/components/phoenix-signature-card/PhoenixIdentityStrip";
import type { SystemAdminOverviewData } from "@/lib/admin/system-overview";
import type { AccessContext } from "@/lib/auth/permissions";
import { cairoTodayIso } from "@/lib/crm/dates";
import { adminTeamReportLinks, type RegionalTeamReportKey } from "@/lib/employee-portal/regional-team-reports";

/**
 * What the identity strip needs. A narrowed shape rather than `ViewerIdentity` itself, matching
 * `HrCommandCenterIdentity` on the HR overview — the two pages want the same four fields and
 * nothing else from the auth module.
 */
export type SystemAdminOverviewIdentity = {
  displayName: string;
  employeeCode: string | null;
  photoUrl: string | null;
  /** The seat's JOB TITLE, already resolved — never the raw permission key. */
  roleLabel: string;
};

/**
 * The System Administrator Overview.
 *
 * Built the way the owner asked for it on 2026-08-30: take the SFE Manager's overview — which is
 * itself the CEO command centre under a variant flag — as-is, then add features from Finance and
 * from the CEO. Concretely:
 *
 *   • The whole CEO layout, unfiltered. The SFE variant is a subset of it; the admin variant is
 *     not, because the Super Admin can action everything the CEO can and more. Cutting bands out
 *     of his copy would hide work only he can do.
 *   • Three Finance bands — money in motion, the payroll cycle, the workforce behind both — through
 *     the Finance Manager's own components, so the two pages cannot drift apart on a figure.
 *   • One band nobody else has: the system tools the Super Admin alone owns. This is the half the
 *     retired Admin Command Center did carry, and losing it in the swap would have made his new
 *     page prettier and less useful.
 *
 * There is no payroll figure of the VIEWER'S own anywhere on it — no amount, no month label — per
 * the standing rule for every overview and landing page. Company aggregates are a different thing
 * and are what a system administrator is here to watch.
 */
export function SystemAdminOverview({
  access,
  data,
  identity,
}: {
  access: AccessContext;
  data: SystemAdminOverviewData;
  /**
   * The signed-in seat, for the identity strip. Resolved by the page from
   * `resolveViewerIdentityFromPage` — the same source as the topbar chip, so the two cannot
   * disagree.
   */
  identity: SystemAdminOverviewIdentity;
}) {
  return (
    <>
      {/* THE IDENTITY, AS A 92px STRIP — and the size is the whole point.

          Both halves of the history below are the owner's own instruction, and a session that
          knows only one half will undo the other:

            1. This page opened with `AdminHeroFrame` + `CeoHeroIdentity` — a full-bleed dark band
               holding a photo, a badge, a greeting and a clock. It cost roughly a third of the
               first screen before one row of real work appeared, and on 2026-09-03 he removed it
               from here and from 131 other admin pages: "remove from all pages this dump block".
            2. Later the same day he asked for the identity back in the employee portal's idiom,
               thin: "I don't want it to be too thick, too many space in the page. I want it to be
               narrow, to have much space for the page to show data." He set the height himself,
               under 96px. It shipped on the HR overview first (#3037), and he then asked for this
               page too — "and /admin".

          So the rule that survived both instructions is HEIGHT, not presence: 88px on a phone,
          92px from `sm` up, both fixed. Anything added here later is measured against that.

          WHY IT IS MOUNTED HERE AND NOT IN `CeoCommandCenter`. That component hosts three
          variants (CEO, SFE and this one), so a strip inside it would draw the identity three
          times over. This file is imported by `/admin` alone.

          /admin IS ONE OF EXACTLY TWO SURFACES THAT WEAR THE STRIP. The other is the HR overview.
          The CEO, SFE and Finance boards wear the ORIGINAL BAND instead — owner, 2026-09-06: "I
          WANT THE SFE AND THE FINANCE AND CEO TO HAVE THEIR PREVIOUS IDENTITY BANNER, THE NEW ONE
          IS ONLY FOR HRs", after all three were briefly given the strip earlier the same day. He
          was asked directly whether /admin went back to the band too and said no: it keeps the
          strip he asked for on 2026-09-03 ("and /admin").

          That is why the `welcome={null}` below is not a tidy-up. `CeoCommandCenter` draws the
          band whenever `welcome` is non-null, so passing a profile here would put a band UNDER
          this strip — two identities on one page. tests/admin-landing-identity-strip.test.ts pins
          the split per surface, both directions. */}
      <PhoenixIdentityStrip
        employeeCode={identity.employeeCode}
        name={identity.displayName}
        photoSrc={identity.photoUrl}
        title={identity.roleLabel}
      />
      <CeoCommandCenter
        access={access}
        data={data.ceo}
        // NULL, deliberately: this page draws the thin strip above, so the band `CeoCommandCenter`
        // renders for the CEO and SFE variants must not also appear here — that would stack two
        // identities. The prop is required rather than optional precisely so this page has to say
        // so out loud. Owner, 2026-09-06, asked and answered: the CEO, SFE and Finance boards go
        // back to the band, "the new one is only for HRs", and /admin KEEPS the strip he asked for
        // on 2026-09-03 ("and /admin").
        welcome={null}
        // Owner instruction 2026-09-07: the resignation-risk reps sit in the Sales & marketing
        // row, in the column the empty Weekly Sales card used to occupy. The CEO variant is never
        // passed one, which is how it stays off his board without this component knowing anything.
        salesColumnSlot={
          <Suspense fallback={<RetentionRiskColumnSkeleton />}>
            <RetentionRiskColumnSection />
          </Suspense>
        }
        extraBands={
          <>
            {/* Omitted rather than zeroed when the finance aggregates did not answer — see
                getSystemAdminOverviewData. */}
            {data.finance ? <FinanceAdminBands view={data.finance} /> : null}
            {/* Dr. Hany Saad's team reports, over the whole company (owner, 2026-11-11). */}
            <TeamReportsBand />
            <SystemToolsBand />
          </>
        }
        variant="admin"
      />
    </>
  );
}

const TEAM_REPORT_ICONS: Record<RegionalTeamReportKey, ReactNode> = {
  "reps-plans": <BookUser className="h-3.5 w-3.5" />,
  "team-visits": <Clock className="h-3.5 w-3.5" />,
  coverage: <Radar className="h-3.5 w-3.5" />,
  "coverage-last-month": <Radar className="h-3.5 w-3.5" />,
  "frequency-last-month": <Repeat2 className="h-3.5 w-3.5" />,
  "district-manager-plans": <Users className="h-3.5 w-3.5" />,
  "region-plans": <Users className="h-3.5 w-3.5" />,
  "weekly-sheet": <FileSpreadsheet className="h-3.5 w-3.5" />,
  "roi-tracking": <ChartColumnBig className="h-3.5 w-3.5" />,
};

/**
 * The team reports built for Dr. Hany Saad, the Regional Sales Manager, one shortcut each, over the whole company
 * (owner, 2026-11-11: "add for the admin the reports u added to hany saad in his overview dashboard"). The list and
 * its addresses are `adminTeamReportLinks`; each page's own gate decides what it shows.
 */
function TeamReportsBand() {
  return (
    <SectionShell description="The reports built for the Regional Sales Manager, across the whole company." title="Team Reports">
      <div className="grid gap-2 p-5 sm:grid-cols-2 lg:grid-cols-4">
        {adminTeamReportLinks(cairoTodayIso()).map((link) => (
          <QuickLinkCard headline={link.headline} href={link.href} icon={TEAM_REPORT_ICONS[link.key]} key={link.key} sub={`Open ${link.label}`} title={link.label} />
        ))}
      </div>
    </SectionShell>
  );
}

/**
 * The Super Admin's own tools. Every href here is a hub that exists and that his sidebar already
 * offers him — this band is a shortcut to them, never a second route table, so a page retired from
 * the sidebar must be retired from here in the same change.
 */
function SystemToolsBand() {
  return (
    <SectionShell
      description="The tools this seat owns and no other role does."
      title="System administration"
    >
      <div className="grid gap-2 p-5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
        <QuickLinkCard
          headline="Diagnostics, imports & repairs"
          href="/admin/admin-tools"
          icon={<Wrench className="h-3.5 w-3.5" />}
          sub="Open Admin Tools"
          title="Admin Tools"
        />
        <QuickLinkCard
          headline="Roles, permissions & messaging"
          href="/admin/access-communication"
          icon={<ShieldCheck className="h-3.5 w-3.5" />}
          sub="Open Access & Comms"
          title="Access & Comms"
        />
        <QuickLinkCard
          headline="Areas, lines, products & seats"
          href="/admin/master-data"
          icon={<Network className="h-3.5 w-3.5" />}
          sub="Open Master Data"
          title="Master Data"
        />
        <QuickLinkCard
          headline="Errors, integrity checks & login security"
          href="/admin/system-audit"
          icon={<Database className="h-3.5 w-3.5" />}
          sub="Open the System Audit"
          title="System Audit"
        />
        <QuickLinkCard
          headline="Employees, lifecycle & org"
          href="/admin/people-management"
          icon={<Users className="h-3.5 w-3.5" />}
          sub="Open People Management"
          title="People"
        />
      </div>
    </SectionShell>
  );
}
