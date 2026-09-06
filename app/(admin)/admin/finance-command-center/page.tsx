import { redirect } from "next/navigation";
import { Suspense } from "react";

import { FinanceCommandCenter } from "@/components/admin/finance-command-center";
import { PhoenixIdentityStrip } from "@/components/phoenix-signature-card/PhoenixIdentityStrip";
import { AppRouteLoadingState } from "@/components/ui/loading-state";
import {
  canAccessSystemAdministratorWorkspace,
  resolveNavigationMode,
  type AccessContext,
} from "@/lib/auth/permissions";
import { resolveAccessContextFromPage, resolveViewerIdentityFromPage } from "@/lib/auth/server";
import { getFinanceCommandCenterData } from "@/lib/finance/command-center";
import { formatHrIdForDisplay } from "@/lib/hr-id";

export const dynamic = "force-dynamic";

export default async function FinanceCommandPage() {
  const access = await resolveAccessContextFromPage();

  if (resolveNavigationMode(access) === "employee-portal") {
    redirect("/employee-portals");
  }

  // Gated on the ROLE, exactly like the CEO and SFE command centers, and deliberately not on a
  // permission resource: the Finance Manager holds no `overview` grant at all, so a
  // permissions-based gate would lock him out of his own landing page. Super Admin keeps access
  // so the page can be supported without borrowing his account.
  const allowed = access.role === "Finance Manager" || canAccessSystemAdministratorWorkspace(access);
  if (!allowed) {
    redirect("/admin");
  }

  // Auth and redirects resolve OUTSIDE the boundary so the shell paints immediately and a
  // denied viewer is bounced before any data work starts.
  return (
    <Suspense
      fallback={
        <AppRouteLoadingState
          description="Preparing your payroll cycle, action queues, and committed cost figures."
          title="Loading Finance Command Center"
        />
      }
    >
      <FinanceCommandContent access={access} />
    </Suspense>
  );
}

async function FinanceCommandContent({ access }: { access: AccessContext }) {
  // getFinanceCommandCenterData never throws — it degrades to named unavailable sources so a
  // single failing source cannot take down a landing page.
  //
  // Both in parallel: neither needs the other, and the identity is a Storage lookup for the
  // uploaded photo on top of one row read. `resolveViewerIdentityFromPage` is `cache()`d per
  // request, so the topbar's own call in the shell costs nothing extra. Same shape as /admin.
  const [view, viewer] = await Promise.all([
    getFinanceCommandCenterData(access),
    resolveViewerIdentityFromPage(access),
  ]);

  // THE IDENTITY IS BACK ON THIS PAGE, AS THE 92px STRIP — owner, 2026-09-06: "yes recover the ceo
  // and finance banners too."
  //
  // Three instructions in sequence, and a session holding only one of them will undo another:
  //
  //   1. 2026-09-03 — the full-bleed black band (`AdminHeroFrame` + `CeoHeroIdentity`) went from
  //      here and from 131 other admin pages: "remove from all pages this dump block". `welcome`
  //      and its prop chain were deleted with it.
  //   2. Later the same day he asked for the identity back in the employee portal's idiom, thin —
  //      "I want it to be narrow" — and set the height himself, under 96px. That is
  //      `PhoenixIdentityStrip`: 88px on a phone, 92px from `sm`, both fixed. It shipped on the HR
  //      overview (#3037) and /admin (#3070), and in the same breath he said the other three
  //      boards were to be left alone: "you will keep the CEO and the SFE and the finance as they
  //      are today."
  //   3. 2026-09-06 — he asked for the SFE Manager's back, then for the CEO's and this one. That
  //      retires the 2026-09-03 exclusion completely.
  //
  // WHAT IS STILL FORBIDDEN, because it is a different thing: the BLACK BAND. The note in
  // ceo-command-center.tsx is about that, and it stands. A thin strip is not the band.
  //
  // MOUNTED IN THE PAGE, NOT IN `FinanceCommandCenter`. That component's bands are reused by the
  // Super Admin overview through `FinanceAdminBands`, which already carries its own strip one
  // level up — a strip inside the component would stack two identities on his page. All five
  // admin landing surfaces mount their own for the same reason.
  return (
    <>
      <PhoenixIdentityStrip
        employeeCode={formatHrIdForDisplay(access.hrId)}
        name={viewer.displayName}
        photoSrc={viewer.imageUrl ?? null}
        title={viewer.roleLabel}
      />
      <FinanceCommandCenter view={view} />
    </>
  );
}
