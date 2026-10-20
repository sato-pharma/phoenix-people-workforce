import { AlertCircle } from "lucide-react";
import { redirect } from "next/navigation";
import { Suspense } from "react";

import { CeoPhaseBSkeleton, CeoPhaseBWidgets } from "@/components/admin/ceo-phase-b";
import { SystemAdminOverview } from "@/components/admin/system-admin-overview";
import { Card } from "@/components/ui/card";
import { AppRouteLoadingState } from "@/components/ui/loading-state";
import { resolveLandingPathForRole } from "@/lib/auth/landing";
import { canAccess, resolveNavigationMode, type AccessContext, type PhoenixRole } from "@/lib/auth/permissions";
import { getSystemAdminOverviewData } from "@/lib/admin/system-overview";
import { resolveAccessContextFromPage, resolveViewerIdentityFromPage } from "@/lib/auth/server";
import { formatHrIdForDisplay } from "@/lib/hr-id";

export const dynamic = "force-dynamic";

/**
 * Every role that has a landing page of its own. Keep in step with the dedicated command-center
 * entries in system-navigation.ts.
 *
 * The two HR seats joined on 2026-08-30. They always had their own page — /hr/admin/hr-command-center
 * is what resolveLandingPathForRole returns for both — but they were never redirected off /admin,
 * so the generic dashboard stayed reachable through a "Command Center" row in their sidebar. A role
 * sweep that day measured what they actually got there, against production: HR Advisory saw EGP 0
 * payroll, EGP 0 sales and EGP 0 expenses, and HR Operations EGP 0 sales and EGP 0 expenses. Those
 * are not outages — the tiles render unconditionally while the scopes behind them resolve to
 * nothing, so the page could only ever answer zero for these seats.
 */
const DEDICATED_COMMAND_CENTER_ROLES = new Set<PhoenixRole>([
  "CEO",
  "SFE Manager",
  "Finance Manager",
  // HR Advisory left when the owner retired the HR Business Partner seat on 2026-10-08.
  "HR Operations",
  // The Talent Acquisition seat (2026-10-08) — same redirect to her own HR command centre.
  "HR Resourcing",
  // The HR Operations Specialist seat (2026-10-20) — same redirect to her own HR command centre,
  // named here so it happens before any grant is read rather than by the fall-through below.
  "HR Administration",
]);

export default async function AdminCommandPage() {
  const access = await resolveAccessContextFromPage();

  if (resolveNavigationMode(access) === "employee-portal") {
    redirect("/employee-portals");
  }

  // Roles with a dedicated, branded command center never land on the generic admin surface —
  // a direct /admin hit (typed, bookmarked, or from a stale link) goes to theirs instead.
  // Hiding the nav entry is UX only; this is the half that actually enforces it. Destinations
  // come from resolveLandingPathForRole so this and the sidebar cannot drift apart.
  // Super Admin keeps /admin.
  if (DEDICATED_COMMAND_CENTER_ROLES.has(access.role)) {
    redirect(resolveLandingPathForRole(access.role));
  }

  const [canReadAdmin, canReadOverview, canReadEmployeeProfile] = await Promise.all([
    canAccess(access, "admin", "read"),
    canAccess(access, "overview", "read"),
    canAccess(access, "employee_profile", "read"),
  ]);

  if (!canReadAdmin && !canReadOverview) {
    if (canReadEmployeeProfile) {
      redirect("/employee-portals");
    }

    return <AccessUnavailableCard />;
  }

  // /admin is the System Administrator Overview and nothing else: the CEO's own command centre,
  // plus Finance's money bands, plus the system tools only this seat owns.
  //
  // The generic Admin Command Center that used to render below is RETIRED (2026-08-30). The role
  // sweep that authorised it asked the question the other way round — not "may these roles see the
  // overview" but "who actually lands on the generic page" — and the answer was nobody. Every
  // admin-shell role resolves to a landing page of its own, so the only way to reach the generic
  // dashboard was the sidebar row that pointed at it, and what it rendered for the two seats that
  // could follow that row was mostly EGP 0. Retiring it removed a page, a component and a sidebar
  // row without taking a single working tool off anyone.
  //
  // Not swapped over to this overview, deliberately: it reads company sales that neither HR seat
  // holds `sales:read` for, and its System Tools band links to three hubs that redirect them
  // straight back out. A role losing a tool nobody noticed it used is one failure; a role gaining
  // a figure nobody meant it to see is the worse one.
  if (access.role === "Super Admin") {
    return (
      <Suspense
        fallback={
          <AppRouteLoadingState
            title="Loading System Administrator Overview"
            description="Preparing executive, financial, and system signals."
          />
        }
      >
        <SystemAdminOverviewContent access={access} />
      </Suspense>
    );
  }

  // Unreachable today: every role except Super Admin either runs on the employee portal, holds a
  // dedicated landing page, or fails the grant check above. It is handled rather than asserted
  // because the thing that would make it reachable — a new role granted `overview:read` — is a
  // routine matrix edit, and the right answer for such a role is its own landing page, not a crash
  // and not a page written for somebody else.
  //
  // The `!== "/admin"` guard is load-bearing, not defensive noise. resolveLandingPathForRole ENDS
  // in `: "/admin"`, so it answers this very address for any role it does not enumerate — which is
  // exactly the unenumerated role that reaches this line. Redirecting unconditionally would turn a
  // harmless fall-through into an infinite redirect, and it would appear for the first time on
  // whoever added the new role, not on whoever wrote this.
  const landing = resolveLandingPathForRole(access.role);
  if (landing !== "/admin") {
    redirect(landing);
  }

  return <AccessUnavailableCard />;
}

/**
 * Shown to a signed-in account that /admin has nothing to render for. Two callers: the grant check
 * above, and the fall-through for a role whose own landing path is /admin but which is not the
 * Super Admin. One component because the second caller exists only to avoid a redirect loop, and a
 * blank screen there would read as a broken page rather than a missing permission.
 */
function AccessUnavailableCard() {
  return (
    <div className="px-4 py-10 text-slate-900">
      <Card className="mx-auto max-w-xl rounded-none border-amber-200 bg-white p-6 shadow-[0_2px_8px_rgba(15,23,42,0.06)]">
        <div className="mb-4 flex items-center gap-3 text-amber-600">
          <AlertCircle aria-hidden="true" className="h-6 w-6" />
          <h1 className="text-lg font-bold">Access unavailable</h1>
        </div>
        <p className="text-sm leading-6 text-slate-600">
          Your account is signed in, but it is not authorized for the admin workspace or employee portal yet. Ask your Phoenix admin to review your role and HR ID setup.
        </p>
      </Card>
    </div>
  );
}

async function SystemAdminOverviewContent({ access }: { access: AccessContext }) {
  // Both in parallel: neither needs the other, and the identity is a Storage lookup for the
  // uploaded photo on top of one row read — serialising them would put that latency in front of
  // the page's own data for no reason. `resolveViewerIdentityFromPage` is `cache()`d per request,
  // so the topbar's own call in the shell costs nothing extra.
  const [result, viewer] = await Promise.all([
    getSystemAdminOverviewData(access)
      .then((data) => ({ data, error: null as string | null }))
      .catch((error) => {
        console.error("Failed to load System Administrator Overview:", error);
        return { data: null, error: error instanceof Error ? error.message : "Unknown error occurred" };
      }),
    resolveViewerIdentityFromPage(access),
  ]);

  if (!result.data) {
    return (
      <div className="p-8">
        <Card className="mx-auto max-w-2xl rounded-none border-rose-100 bg-rose-50 p-6">
          <div className="flex items-center gap-3 text-rose-600">
            <AlertCircle aria-hidden="true" className="h-6 w-6" />
            <h2 className="text-lg font-bold">System Administrator Overview Error</h2>
          </div>
          <p className="mt-4 text-sm text-rose-700">
            The overview could not load its executive and workforce data.
          </p>
          <p className="mt-3 break-all border border-rose-200 bg-white/50 p-3 font-mono text-xs text-rose-800">
            {result.error ?? "Unknown error occurred"}
          </p>
        </Card>
      </div>
    );
  }

  // The identity is BACK, but as a 92px strip and not as the band that was removed. The full-bleed
  // `AdminHeroFrame` + `CeoHeroIdentity` block went on 2026-09-03 — "remove from all pages this
  // dump block" — and later the same day the owner asked for the identity back in the employee
  // portal's idiom, thin, under 96px. It shipped on the HR overview first and he then named this
  // page: "and /admin". The mount and the full history are in system-admin-overview.tsx.
  return (
    <div className="min-w-0 max-w-full overflow-x-hidden">
      <SystemAdminOverview
        access={access}
        data={result.data}
        identity={{
          displayName: viewer.displayName,
          // `access.hrId`, not the login id: the strip prints an HR ID and an account name is not
          // one. Null when the account has no linked employee — a real case for an administrative
          // account, and one the strip draws as nothing rather than as an empty slot.
          employeeCode: formatHrIdForDisplay(access.hrId),
          photoUrl: viewer.imageUrl ?? null,
          // Already the JOB TITLE, not the permission key — the resolver maps it before returning.
          roleLabel: viewer.roleLabel,
        }}
      />
      <Suspense fallback={<CeoPhaseBSkeleton variant="admin" />}>
        <CeoPhaseBWidgets
          access={access}
          adminSignalsPrefetched={result.data.ceo.adminSignals}
          sosPrefetched={result.data.ceo.sos}
          variant="admin"
        />
      </Suspense>
    </div>
  );
}
