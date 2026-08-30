import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { EmployeePortalChrome } from "@/components/employee-portal/employee-portal-layout";
import { EmployeePortalEmptyState } from "@/components/employee-portal/enterprise-shell";
import { ModuleLockedNotice } from "@/components/layout/module-locked-notice";
import { employeeHasActiveDeviceMapping } from "@/lib/attendance/device-user-mapping";
import { resolveModuleLocksForAccess } from "@/lib/auth/module-locks";
import { assertPermission, type AccessContext } from "@/lib/auth/permissions";
import { isForbiddenError } from "@/lib/auth/server";
import { resolveEmployeePortalNavVisibility } from "@/lib/employee-portal/navigation";
import { getEmployeePortalShellData } from "@/lib/employee-portal/service";
import { resolveLockedModuleForPath } from "@/lib/navigation/module-catalog";
import { layoutOwnerKey, type PersonalNavigationLayout } from "@/lib/navigation/personal-layout";
import { loadEffectiveLayout } from "@/lib/navigation/personal-layout-store";
import { PATH_HEADER } from "@/lib/navigation/shell-headers";
import { logPortalFailure } from "@/lib/observability/portal-logging";

type EmployeePortalServerShellProps = {
  access: AccessContext;
  children: React.ReactNode;
  disableSessionGuard?: boolean;
  unavailableMessage?: string;
  unavailableTitle?: string;
};

export async function EmployeePortalServerShell({
  access,
  children,
  disableSessionGuard = false,
  unavailableMessage = "Your command center is temporarily unavailable. Please try again in a moment.",
  unavailableTitle = "Portal Unavailable",
}: EmployeePortalServerShellProps) {
  try {
    await assertPermission(access, "employee_profile", "read");
  } catch (error) {
    if (isForbiddenError(error)) {
      console.warn("[portal-shell] employee_profile:read denied — redirecting to login", {
        role: access.role,
        scope: access.scope,
        source: access.source,
      });
      redirect("/login");
    }
    throw error;
  }

  // ── Temporary module locks ─────────────────────────────────────────────────────────────────
  // Started here so it overlaps the shell payload below rather than adding a round trip of its own
  // — every query from this machine crosses to Frankfurt, and this runs on every portal render.
  //
  // Deliberately OUTSIDE the Promise.all that loads the portal: a lock is a restriction laid on top
  // of normal access, so a lock read that goes wrong must never be able to take the whole portal
  // away from an employee. It already fails open internally; the `.catch` is the second belt.
  const locksPromise = resolveModuleLocksForAccess(access).catch(() => []);

  let data = null;
  let hasDeviceMapping = false;
  // The viewer's saved row arrangement, or the company default when they have saved nothing.
  // Read INSIDE the existing Promise.all rather than after it: every query from here crosses the
  // Atlantic to Frankfurt, and this runs on every portal page render. loadEffectiveLayout resolves
  // both keys in ONE round trip and never rejects — a failed read degrades to "nothing arranged",
  // which is the same thing every account sees today.
  let navLayout: PersonalNavigationLayout | null = null;
  try {
    [data, hasDeviceMapping, navLayout] = await Promise.all([
      getEmployeePortalShellData(access),
      access.hrId ? employeeHasActiveDeviceMapping(access.hrId).catch(() => false) : Promise.resolve(false),
      loadEffectiveLayout(layoutOwnerKey(access)).then((result) => result.layout),
    ]);
  } catch (error) {
    logPortalFailure(
      { route: "/employee-portals", module: "employee-portal-shell", role: access.role, hrId: access.hrId },
      error,
    );
    data = null;
  }

  if (!data) {
    return (
      <EmployeePortalEmptyState
        message={unavailableMessage}
        title={unavailableTitle}
      />
    );
  }

  const visibility = resolveEmployeePortalNavVisibility(
    data.employee.roleLabel,
    access.role,
    data.employee.line,
    data.employee.department,
    data.employee.hrId,
    hasDeviceMapping,
  );

  // The tab stays in the sidebar wearing a padlock — taking it away would say "this was removed",
  // which is a harsher message than the administrator chose to send. Opening it lands on the notice
  // instead of the page.
  //
  // CHROME ONLY. The page behind this still refuses a locked module on its own, because `canAccess`
  // consults the same locks; being wrong here shows a blunter refusal, never access.
  const activeLocks = await locksPromise;
  const lockedModuleKeys = Array.from(new Set(activeLocks.map((lock) => lock.moduleKey)));
  // Written by proxy.ts on every matched request. Absent only when the proxy did not run, and then
  // there is no address to match — the page renders and refuses itself.
  const requestedPath = (await headers()).get(PATH_HEADER) ?? "";
  const lockedModuleForPage = lockedModuleKeys.length
    ? resolveLockedModuleForPath(requestedPath, lockedModuleKeys)
    : null;
  const pageLock = lockedModuleForPage
    ? activeLocks.find((lock) => lock.moduleKey === lockedModuleForPage) ?? null
    : null;

  return (
    <EmployeePortalChrome
      data={data}
      disableSessionGuard={disableSessionGuard}
      lockedModuleKeys={lockedModuleKeys}
      personalLayout={navLayout}
      visibility={visibility}
    >
      {lockedModuleForPage ? (
        <ModuleLockedNotice
          homeHref="/employee-portals"
          lock={pageLock}
          moduleKey={lockedModuleForPage}
        />
      ) : (
        children
      )}
    </EmployeePortalChrome>
  );
}
