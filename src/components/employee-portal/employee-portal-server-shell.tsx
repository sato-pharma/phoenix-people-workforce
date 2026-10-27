import { cookies, headers } from "next/headers";
import { Suspense } from "react";
import { redirect } from "next/navigation";

import { EmployeePortalChrome } from "@/components/employee-portal/employee-portal-layout";
import { EmployeePortalEmptyState } from "@/components/employee-portal/enterprise-shell";
import { DocumentTitleSync } from "@/components/layout/document-title-sync";
import { SeatViewBanner } from "@/components/layout/seat-view-banner";
import { ModuleLockedNotice } from "@/components/layout/module-locked-notice";
import { employeeHasActiveDeviceMapping } from "@/lib/attendance/device-user-mapping";
import { resolveModuleLocksForAccess } from "@/lib/auth/module-locks";
import { displayTitleForAccount } from "@/lib/auth/account-job-titles";
import { assertPermission, type AccessContext } from "@/lib/auth/permissions";
import { isForbiddenError } from "@/lib/auth/server";
import { resolveEmployeePortalNavVisibility } from "@/lib/employee-portal/navigation";
import { getEmployeePortalShellData } from "@/lib/employee-portal/service";
import { resolveLockedModuleForPath } from "@/lib/navigation/module-catalog";
import { phoenixNativeClientUserAgentMarker } from "@/lib/auth/native-session";
import { NATIVE_WEB_APP_SHELL_COOKIE } from "@/lib/auth/native-web-handoff";
import { PATH_HEADER } from "@/lib/navigation/shell-headers";
import { logPortalFailure } from "@/lib/observability/portal-logging";
import { NO_PHOENIX_CRM_ENTRIES, phoenixCrmSidebarEntries } from "@/lib/phoenix-crm/server/sidebar-entries";
import { hasInterviewCalendarAccess } from "@/lib/recruitment/interview-calendar";

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
  // Whether the owner shared his interview calendar with this person. One small read of the shares
  // table, in the same round trip as the rest; it fails closed to "no row", never to an error.
  let sharedInterviewCalendar = false;
  // Whether Phoenix CRM has anything open for this person today — the module's own gate, the same
  // one the My Visits button asks, so the sidebar row and that button can never disagree. It fails
  // closed and never throws, so a CRM outage costs the row, never the portal. Its forecast half is
  // the Daily Forecast row under Forecast & Target, answered by the same lookup.
  let phoenixCrm = NO_PHOENIX_CRM_ENTRIES;
  // The saved nav-row arrangement used to be read here, in this same Promise.all. The portal has
  // no horizontal rows any more (owner rule, 2026-09-03 — see EmployeePortalChrome), so the read
  // went with them: it crossed the Atlantic to Frankfurt on every portal page render.
  try {
    [data, hasDeviceMapping, sharedInterviewCalendar, phoenixCrm] = await Promise.all([
      getEmployeePortalShellData(access),
      access.hrId ? employeeHasActiveDeviceMapping(access.hrId).catch(() => false) : Promise.resolve(false),
      access.hrId ? hasInterviewCalendarAccess(access).catch(() => false) : Promise.resolve(false),
      access.hrId ? phoenixCrmSidebarEntries(access).catch(() => NO_PHOENIX_CRM_ENTRIES) : Promise.resolve(NO_PHOENIX_CRM_ENTRIES),
    ]);
  } catch (error) {
    logPortalFailure(
      { route: "/employee-portals", module: "employee-portal-shell", role: access.role, hrId: access.hrId },
      error,
    );
    data = null;
  }

  // VIEW AS SEAT (src/lib/auth/seat-view.ts): said on every page of a view, the empty state included.
  const seatViewBanner = access.seatView ? (
    <SeatViewBanner
      expiresAt={access.seatView.expiresAt}
      personName={access.seatView.personName}
      seatTitle={displayTitleForAccount(access.hrId, access.role)}
    />
  ) : null;

  if (!data) {
    return (
      <>
        {seatViewBanner}
        <EmployeePortalEmptyState
          message={unavailableMessage}
          title={unavailableTitle}
        />
      </>
    );
  }

  const visibility = resolveEmployeePortalNavVisibility(
    data.employee.roleLabel,
    access.role,
    data.employee.line,
    data.employee.department,
    data.employee.hrId,
    hasDeviceMapping,
    sharedInterviewCalendar,
    phoenixCrm.crm,
    phoenixCrm.forecast,
    phoenixCrm.placeChecks,
    phoenixCrm.doubleVisitRequests,
    phoenixCrm.myMap,
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
  const requestHeaders = await headers();
  const requestedPath = requestHeaders.get(PATH_HEADER) ?? "";

  // App mode drops the portal's own header + bottom nav, because the native app supplies them. Two
  // signals, either one is enough, and BOTH are things only the native shell has:
  //   - the user-agent marker the WebView sets (`applicationNameForUserAgent`), which rides every
  //     request including a direct web /login, and
  //   - the hand-off cookie (the bearer→cookie module-open path sets it).
  // An ordinary browser carries neither, so the web portal renders exactly as before. This is a
  // display hint, never a credential — see NATIVE_WEB_APP_SHELL_COOKIE and
  // phoenixNativeClientUserAgentMarker.
  const appShell =
    (await cookies()).get(NATIVE_WEB_APP_SHELL_COOKIE)?.value === "1" ||
    (requestHeaders.get("user-agent") ?? "").includes(phoenixNativeClientUserAgentMarker);
  const lockedModuleForPage = lockedModuleKeys.length
    ? resolveLockedModuleForPath(requestedPath, lockedModuleKeys)
    : null;
  const pageLock = lockedModuleForPage
    ? activeLocks.find((lock) => lock.moduleKey === lockedModuleForPage) ?? null
    : null;

  return (
    <>
      {/* The portal had NO tab naming at all until 2026-09-04: all 118 of its routes
          rendered the bare brand, so every open portal tab read "Phoenix Workforce"
          and none could be told apart. Names the tab on in-app navigation; the FIRST
          paint is named by generateMetadata in app/employee-portals/layout.tsx,
          through the same resolver. Suspense because it reads useSearchParams. */}
      <Suspense fallback={null}>
        <DocumentTitleSync mode="employee-portal" role={access.role} />
      </Suspense>
      <EmployeePortalChrome
        appShell={appShell}
        data={data}
        disableSessionGuard={disableSessionGuard}
        lockedModuleKeys={lockedModuleKeys}
        visibility={visibility}
      >
        {seatViewBanner ? <div className="mb-4">{seatViewBanner}</div> : null}
        {access.testPersona ? (
          // A TEST ACCOUNT (src/lib/auth/test-persona.ts) reads a real person's portal. Said on every
          // page, so a test session can never be taken for the real one — by him, or over his shoulder.
          <div className="mb-4 border border-orange-300 bg-orange-50 px-4 py-2.5 text-sm text-orange-900" role="status">
            <span className="font-black">Test account.</span>{" "}
            {`You are seeing ${data.employee.fullName}'s portal with the real data. Only Phoenix CRM saves, as test entries; every other save is refused.`}
          </div>
        ) : null}
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
    </>
  );
}
