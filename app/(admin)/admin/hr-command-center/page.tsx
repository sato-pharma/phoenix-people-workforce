import { redirect } from "next/navigation";
import { Suspense } from "react";

import { HrCommandCenter } from "@/components/hr/hr-command-center";
import { AppRouteLoadingState } from "@/components/ui/loading-state";
import { resolveLandingPathForRole } from "@/lib/auth/landing";
import { resolveAccessContextFromPage, resolveViewerIdentityFromPage } from "@/lib/auth/server";
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
  const [viewer, data] = await Promise.all([
    resolveViewerIdentityFromPage(access),
    getHrCommandCenterData(access),
  ]);

  // Unreachable in practice — the page gate above already refused every role without a bundle,
  // and that is the only input that makes this null. Handled rather than asserted because a
  // non-null assertion here would be a lie the type system could not check.
  if (!data) {
    redirect(resolveLandingPathForRole(access.role));
  }

  return <HrCommandCenter data={data} viewerName={viewer.displayName} />;
}
