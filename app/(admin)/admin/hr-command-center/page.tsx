import { redirect } from "next/navigation";
import { Suspense } from "react";

import { HrCommandCenter } from "@/components/hr/hr-command-center";
import { HrOperationsOverview } from "@/components/hr/hr-operations-overview";
import { TalentAcquisitionOverview } from "@/components/hr/talent-acquisition-overview";
import { AppRouteLoadingState } from "@/components/ui/loading-state";
import { resolveLandingPathForRole } from "@/lib/auth/landing";
import { resolveAccessContextFromPage, resolveViewerIdentityFromPage } from "@/lib/auth/server";
import { HR_OPERATIONS_SPECIALIST_SEAT } from "@/lib/auth/hr-functions";
import { formatHrIdForDisplay } from "@/lib/hr-id";
import { getHrCommandCenterData, hrBundleForRole } from "@/lib/hr/command-center";
import { getHrOperationsOverview } from "@/lib/hr/hr-operations-overview";
import {
  getTalentAcquisitionOverview,
  TALENT_ACQUISITION_SEAT,
} from "@/lib/hr/talent-acquisition-overview";

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
 *
 * TWO PAGES BEHIND ONE ADDRESS since 2026-10-13. The Talent Acquisition seat gets
 * `TalentAcquisitionOverview`, built from her handbook's KPI families rather than from her function
 * bundle, at the owner's instruction that morning: *"donot touch photo or identity banner and from
 * scratch build her overview landing page"*. Every other HR seat still gets `HrCommandCenter`,
 * unchanged, and the split is `hrBundleForRole(access.role) === TALENT_ACQUISITION_SEAT` — the same
 * lookup that already gates the address, so the two branches cannot disagree about who is who.
 *
 * THREE SINCE 2026-11-03. The HR Operations Specialist gets `HrOperationsOverview`, the same page
 * built from her own work (owner: "design it to be identical in design and identy to the talnt
 * acqyuisition"), split the same way on her bundle.
 *
 * It is one ROUTE and not two on purpose: the address is what `resolveLandingPathForRole` returns
 * for her and what the sidebar links, and giving her seat its own path would have meant teaching
 * the landing resolver, the navigation config and every "go home" link about it. Only the component
 * and the loader differ, so only they branch.
 */
export default async function HrCommandCenterPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const access = await resolveAccessContextFromPage();
  if (!hrBundleForRole(access.role)) {
    redirect(resolveLandingPathForRole(access.role));
  }

  // The Hired window travels in the URL, not in client state, because the count is made on the
  // server over every application the seat can see — not over a subset already on the page. It
  // also makes a chosen range shareable and survivable across a reload. Anything malformed is
  // normalised back to the running Cairo month by `resolveHiredWindow`, never counted as zero.
  const params = (await searchParams) ?? {};
  const one = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);
  const hiredWindow = { from: one(params.hiredFrom) ?? null, to: one(params.hiredTo) ?? null };

  // The Talent Acquisition overview's calendar travels in the URL for the same reason the Hired
  // window does: a different week or month is a SERVER read (six weeks of bookings and the company
  // calendar), and rebuilding the month's marks in the browser would be a second implementation of
  // `buildMonthMarks`. Prefixed `ta` so they cannot collide with the company calendar's own params
  // if this page ever embeds one. Anything malformed is ignored and the current week/month is shown
  // — never counted as an empty week.
  const monthNumber = Number(one(params.taMonth));
  const yearNumber = Number(one(params.taYear));
  const calendarMonth =
    Number.isInteger(monthNumber) &&
    monthNumber >= 1 &&
    monthNumber <= 12 &&
    Number.isInteger(yearNumber) &&
    yearNumber >= 2000 &&
    yearNumber <= 2100
      ? { month: monthNumber, year: yearNumber }
      : null;

  return (
    <Suspense
      fallback={
        <AppRouteLoadingState
          description="Preparing your recruitment, people and compliance signals."
          title="Loading your HR overview"
        />
      }
    >
      <HrCommandCenterContent
        access={access}
        calendarMonth={calendarMonth}
        hiredWindow={hiredWindow}
        week={one(params.taWeek) ?? null}
      />
    </Suspense>
  );
}

async function HrCommandCenterContent({
  access,
  calendarMonth,
  hiredWindow,
  week,
}: {
  access: Awaited<ReturnType<typeof resolveAccessContextFromPage>>;
  calendarMonth: { month: number; year: number } | null;
  hiredWindow: { from: string | null; to: string | null };
  week: string | null;
}) {
  // Which of the two landing pages this seat gets. Decided once, here, so only ONE of the two
  // loaders runs — they overlap heavily (offers, the recruitment dashboard, the directory) and
  // running both to pick a component afterwards would double every read on somebody's home page.
  const isTalentAcquisition = hrBundleForRole(access.role) === TALENT_ACQUISITION_SEAT;
  const isHrOperationsSpecialist = hrBundleForRole(access.role) === HR_OPERATIONS_SPECIALIST_SEAT;

  // Both in parallel: neither needs the other, and the identity is a Storage lookup for the
  // uploaded photo on top of one row read — serialising them would put that latency in front of
  // the page's own data for no reason. `resolveViewerIdentityFromPage` is `cache()`d per request,
  // so the topbar's own call in the shell costs nothing extra.
  const [data, viewer] = await Promise.all([
    isTalentAcquisition
      ? getTalentAcquisitionOverview(access, { hiredWindow, month: calendarMonth, week })
      : isHrOperationsSpecialist
        ? getHrOperationsOverview(access, { month: calendarMonth, week })
        : getHrCommandCenterData(access, { hiredWindow }),
    resolveViewerIdentityFromPage(access),
  ]);

  // Unreachable in practice — the page gate above already refused every role without a bundle,
  // and that is the only input that makes this null. Handled rather than asserted because a
  // non-null assertion here would be a lie the type system could not check.
  if (!data) {
    redirect(resolveLandingPathForRole(access.role));
  }

  // ONE identity for both branches, built once. The strip is the thing the owner said not to touch
  // ("donot touch photo or identity banner", 2026-10-13), so the two pages are handed the same four
  // props from the same resolver rather than each assembling its own.
  const identity = {
    displayName: viewer.displayName,
    // `access.hrId`, not the login id: the strip prints an HR ID and an account name is not
    // one. Null when the account has no linked employee, which the strip draws as nothing
    // rather than as an empty slot.
    employeeCode: formatHrIdForDisplay(access.hrId),
    photoUrl: viewer.imageUrl ?? null,
    // Already the JOB TITLE, not the seat key — the resolver maps it through
    // HR_SEAT_JOB_TITLES, so this reads "HR Business Partner" rather than the raw seat name.
    //
    // That seat name is deliberately not written out here. `hr-function-governance.test.ts`
    // Rule 10 pins every file containing one, because such a string is usually a gate the
    // permission matrix cannot see. This page's gate is `hrBundleForRole` above, so listing it
    // would dilute a tripwire whose whole value is that each entry is a real by-name grant.
    roleLabel: viewer.roleLabel,
  };

  // `isTalentAcquisition` chose the loader above, so the shape that came back is the one this
  // branch wants — asserted with a `"calendar" in data` narrowing rather than a cast, so a loader
  // that ever returned the other shape would be a type error here instead of a blank page.
  if (isHrOperationsSpecialist && "scoreboard" in data) {
    return <HrOperationsOverview data={data} identity={identity} />;
  }
  if (isTalentAcquisition && "cvToday" in data) {
    return <TalentAcquisitionOverview data={data} identity={identity} />;
  }
  if ("groups" in data) {
    return <HrCommandCenter data={data} identity={identity} />;
  }
  redirect(resolveLandingPathForRole(access.role));
}
