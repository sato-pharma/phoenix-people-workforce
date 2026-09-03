import { redirect } from "next/navigation";
import { Suspense } from "react";

import { HrCommandCenter } from "@/components/hr/hr-command-center";
import { AppRouteLoadingState } from "@/components/ui/loading-state";
import { resolveLandingPathForRole } from "@/lib/auth/landing";
import { resolveAccessContextFromPage, resolveViewerIdentityFromPage } from "@/lib/auth/server";
import { formatHrIdForDisplay } from "@/lib/hr-id";
import { getHrCommandCenterData, hrBundleForRole } from "@/lib/hr/command-center";

export const dynamic = "force-dynamic";

/**
 * The landing dashboard for the two HR seats, served at /hr/admin/hr-command-center.
 *
 * The gate is `hrBundleForRole`, which is the same lookup that decides the seat's PERMISSIONS —
 * so the set of people who can open this page and the set of people it has anything to say to are
 * the same set by construction, not by two lists agreeing. Anyone else is sent to their own
 * landing rather than shown an empty shell: this page is composed entirely from one seat's
 * function bundle, and a role with no bundle has no version of it to render.
 *
 * That redirect cannot loop. `resolveLandingPathForRole` returns THIS page only for the two roles
 * `hrBundleForRole` accepts, and they never reach the redirect.
 */
export default async function HrCommandCenterPage() {
  const access = await resolveAccessContextFromPage();
  if (!hrBundleForRole(access.role)) {
    redirect(resolveLandingPathForRole(access.role));
  }

  return (
    <Suspense
      fallback={
        <AppRouteLoadingState
          description="Preparing your recruitment, people and compliance signals."
          title="Loading your HR overview"
        />
      }
    >
      <HrCommandCenterContent access={access} />
    </Suspense>
  );
}

async function HrCommandCenterContent({
  access,
}: {
  access: Awaited<ReturnType<typeof resolveAccessContextFromPage>>;
}) {
  // Both in parallel: neither needs the other, and the identity is a Storage lookup for the
  // uploaded photo on top of one row read — serialising them would put that latency in front of
  // the page's own data for no reason. `resolveViewerIdentityFromPage` is `cache()`d per request,
  // so the topbar's own call in the shell costs nothing extra.
  const [data, viewer] = await Promise.all([
    getHrCommandCenterData(access),
    resolveViewerIdentityFromPage(access),
  ]);

  // Unreachable in practice — the page gate above already refused every role without a bundle,
  // and that is the only input that makes this null. Handled rather than asserted because a
  // non-null assertion here would be a lie the type system could not check.
  if (!data) {
    redirect(resolveLandingPathForRole(access.role));
  }

  return (
    <HrCommandCenter
      data={data}
      identity={{
        displayName: viewer.displayName,
        // `access.hrId`, not the login id: the strip prints an HR ID and an account name is not
        // one. Null when the account has no linked employee, which the strip draws as nothing
        // rather than as an empty slot.
        employeeCode: formatHrIdForDisplay(access.hrId),
        photoUrl: viewer.imageUrl ?? null,
        // Already the JOB TITLE — the resolver maps the seat key through HR_SEAT_JOB_TITLES, so
        // this reads "HR Business Partner", never "HR Advisory".
        roleLabel: viewer.roleLabel,
      }}
    />
  );
}
