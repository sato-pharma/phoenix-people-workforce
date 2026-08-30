import { AlertCircle } from "lucide-react";
import { redirect } from "next/navigation";
import { Suspense } from "react";

import { AdminCommandCenter } from "@/components/admin/admin-command-center";
import { CeoPhaseBSkeleton, CeoPhaseBWidgets } from "@/components/admin/ceo-phase-b";
import { SystemAdminOverview } from "@/components/admin/system-admin-overview";
import { Card } from "@/components/ui/card";
import { AppRouteLoadingState } from "@/components/ui/loading-state";
import { resolveLandingPathForRole } from "@/lib/auth/landing";
import { canAccess, resolveNavigationMode, type AccessContext, type PhoenixRole } from "@/lib/auth/permissions";
import { getAdminCommandCenterData, loadDirectManagerName } from "@/lib/admin/command-center";
import { getSystemAdminOverviewData } from "@/lib/admin/system-overview";
import { resolveAccessContextFromPage, resolveViewerIdentityFromPage } from "@/lib/auth/server";
import { uploadedEmployeePhotoUrl } from "@/lib/employees/employee-photo";
import { formatHrIdForDisplay } from "@/lib/hr-id";

export const dynamic = "force-dynamic";

/** Keep in step with the dedicated command-center entries in system-navigation.ts. */
const DEDICATED_COMMAND_CENTER_ROLES = new Set<PhoenixRole>(["CEO", "SFE Manager", "Finance Manager"]);

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

  // The Super Admin's landing page is the System Administrator Overview: the CEO's own command
  // centre, plus Finance's money bands, plus the system tools only this seat owns. The generic
  // AdminCommandCenter below still serves the remaining admin-shell roles that reach /admin
  // (HR Advisory, HR Operations, Financial Advisor) until the owner rules on retiring it for them
  // too — swapping their page over is a separate decision with its own role sweep, and shipping it
  // silently inside this change is exactly how a role loses a tool nobody noticed it used.
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

  return (
    <Suspense
      fallback={
        <AppRouteLoadingState
          title="Loading Admin Command Center"
          description="Preparing operational KPIs and executive attention queues."
        />
      }
    >
      <AdminCommandContent access={access} />
    </Suspense>
  );
}

async function SystemAdminOverviewContent({ access }: { access: AccessContext }) {
  const [viewer, result] = await Promise.all([
    resolveViewerIdentityFromPage(access),
    getSystemAdminOverviewData(access)
      .then((data) => ({ data, error: null as string | null }))
      .catch((error) => {
        console.error("Failed to load System Administrator Overview:", error);
        return { data: null, error: error instanceof Error ? error.message : "Unknown error occurred" };
      }),
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

  // The hero falls back to the initials medallion when no portrait resolves (CeoHeroIdentity's
  // onError), so this renders correctly whether or not a photo has been uploaded for the seat.
  const welcome = {
    fullName: viewer.displayName,
    hrId: access.hrId,
    imageUrl: await uploadedEmployeePhotoUrl(formatHrIdForDisplay(access.hrId) ?? access.hrId),
    initials: viewer.initials,
    roleLabel: viewer.roleLabel,
  };

  return (
    <div className="min-w-0 max-w-full overflow-x-hidden">
      <SystemAdminOverview access={access} data={result.data} welcome={welcome} />
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

async function AdminCommandContent({ access }: { access: AccessContext }) {
  const [viewer, dataResult] = await Promise.all([
    resolveViewerIdentityFromPage(access),
    getAdminCommandCenterData(access)
      .then((value) => ({ data: value, error: null as string | null }))
      .catch((error) => {
        console.error("Failed to load Admin Command Center:", error);
        return {
          data: null,
          error: error instanceof Error ? error.message : "Unknown error occurred",
        };
      }),
  ]);
  const data = dataResult.data;
  const loadError = dataResult.error;

  const viewerHrId = formatHrIdForDisplay(access.hrId);
  const [managerName, profilePhotoUrl] = await Promise.all([
    loadDirectManagerName(viewerHrId ?? access.hrId),
    uploadedEmployeePhotoUrl(viewerHrId ?? access.hrId),
  ]);
  const welcomeProfile = {
    fullName: viewer.displayName,
    hrId: viewerHrId,
    managerName,
    systemRoleLabel: viewer.roleLabel,
    titleLabel: viewer.roleLabel,
  };

  return (
    data ? (
      <AdminCommandCenter data={data} profilePhotoUrl={profilePhotoUrl} welcomeProfile={welcomeProfile} />
    ) : (
      <div className="p-8">
        <Card className="mx-auto max-w-2xl rounded-none border-rose-100 bg-rose-50 p-6 shadow-[0_2px_8px_rgba(15,23,42,0.06)]">
          <div className="mb-4 flex items-center gap-3 text-rose-600">
            <AlertCircle aria-hidden="true" className="h-6 w-6" />
            <h2 className="text-lg font-bold">Command Center Error</h2>
          </div>
          <p className="mb-4 text-sm text-rose-700">
            There was a problem loading operational data from Supabase. Please ensure your database views and tables are correctly configured.
          </p>
          <div className="border border-rose-200 bg-white/50 p-3">
            <p className="break-all font-mono text-xs text-rose-800">
              {loadError ?? "Unknown error occurred"}
            </p>
          </div>
        </Card>
      </div>
    )
  );
}
