// Rep Doctor Lists — READ-ONLY board inside the Phoenix admin shell.
//
// SUPER ADMIN ONLY, on the owner's instruction 2026-08-21 ("in admin account only for now"). There
// is deliberately no portal twin: until the owner decides who else should see a rep-by-rep list of
// the doctors they never reached, there is nowhere else for it to appear.
//
// The role list is NOT maintained here — it lives in src/lib/crm/rep-doctor-lists-access.ts, which
// this page and the sync route both ask, so they cannot drift apart on who may open it.
//
// Month and filters ride in the URL, so every change re-runs the gate server-side (same posture as
// the Doctor Coverage board next door).
import { redirect } from "next/navigation";

import { RepDoctorListsBoardView } from "@/components/crm/rep-doctor-lists-board";
import { canAccess } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { getRepDoctorLists, resolveRepDoctorListMonth } from "@/lib/crm/rep-doctor-lists";
import { canAccessRepDoctorLists } from "@/lib/crm/rep-doctor-lists-access";
import { getRepDoctorTrend, REP_DOCTOR_TREND_FIRST_MONTH } from "@/lib/crm/rep-doctor-lists-trend";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

type PageProps = {
  searchParams?: Promise<{
    frequency?: string;
    from?: string;
    kind?: string;
    month?: string;
    rep?: string;
    search?: string;
    status?: string;
  }>;
};

export default async function RepDoctorListsPage({ searchParams }: PageProps) {
  const access = await resolveAccessContextFromPage();
  // Two gates, both server-side: the explicit role list, then the permission matrix that is the
  // real security boundary. No access redirects rather than explaining — inside the admin shell an
  // unreachable page should behave as if it does not exist for that role.
  if (!canAccessRepDoctorLists(access)) redirect("/admin");
  if (!(await canAccess(access, "crm_visits", "read"))) redirect("/admin");

  const params = await searchParams;
  const month = resolveRepDoctorListMonth(params?.month);
  const filters = {
    frequency: params?.frequency,
    kind: params?.kind,
    repKey: params?.rep,
    search: params?.search,
    status: params?.status,
  };
  // The trend's start month is adjustable, because January is the range's weakest month — 32 of its
  // 58 planning agents have since left — and starting at February gives a materially larger
  // like-for-like cohort. Anything unparseable falls back to the mirror's first month.
  const trendFrom = params?.from && MONTH_PATTERN.test(params.from) ? params.from : REP_DOCTOR_TREND_FIRST_MONTH;

  // Data fetch and JSX stay separated (react-hooks/error-boundaries: JSX must not be constructed
  // inside try/catch). A data failure renders a plain explanation, never a crash page.
  let board: Awaited<ReturnType<typeof getRepDoctorLists>> | null = null;
  let loadError: string | null = null;
  try {
    board = await getRepDoctorLists({ filters, month });
  } catch (error) {
    loadError = error instanceof Error ? error.message : "Rep doctor list data is unavailable.";
  }

  // The trend is eight months of scanning and is NOT allowed to take the month board down with it:
  // the month board is the answer to "how is this rep doing now", and it must render even when the
  // history behind it cannot. A null trend simply hides that one section.
  let trend: Awaited<ReturnType<typeof getRepDoctorTrend>> | null = null;
  try {
    trend = await getRepDoctorTrend({ from: trendFrom, to: month });
  } catch {
    trend = null;
  }

  if (!board) {
    return (
      <div className="border border-rose-200 bg-rose-50 px-5 py-4">
        <p className="text-sm font-bold text-rose-800">Rep doctor lists could not load.</p>
        <p className="mt-1 text-xs text-rose-700">{loadError}</p>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <RepDoctorListsBoardView basePath="/admin/rep-doctor-lists" board={board} trend={trend} />
    </div>
  );
}
