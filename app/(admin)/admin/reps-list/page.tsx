// Reps List — READ-ONLY board inside the Phoenix admin shell.
//
// The owner's specification, 2026-08-31: filter by line, then the line's regions appear, then the
// region, then the area and the medical rep; click the rep and "all his customers, his contact list"
// appear, "grouped by bricks". This page is the admin/SFE door; the portal twin at
// /employee-portals/reps-list is the same board scoped to a manager's own team.
//
// IT REPLACES /admin/doctor-list, which now redirects here. Same source (the CRM's own contact list,
// not visits), same access module, one board — the owner asked for the old one and its District
// Manager tab to be retired rather than left beside this as a second door onto the same data.
//
// Nothing about WHO may open this lives in this file. The role list and the scope that decides whose
// reps a viewer sees are in src/lib/crm/doctor-list-access.ts, and the assembly is in
// src/lib/crm/reps-list-board.ts — which restricts the cached company-wide cascade tree BEFORE it
// derives a single dropdown option, because a picker is never wider than its viewer.
//
// The whole selection rides in the URL, so every change re-runs both gates server-side.
import { redirect } from "next/navigation";

import { RepsListBoardView } from "@/components/crm/reps-list-board";
import { canAccess } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { canAccessDoctorList, getDoctorListScope } from "@/lib/crm/doctor-list-access";
import { getRepsListBoard } from "@/lib/crm/reps-list-board";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type PageProps = {
  searchParams?: Promise<{ area?: string; line?: string; region?: string; rep?: string }>;
};

export default async function RepsListPage({ searchParams }: PageProps) {
  const access = await resolveAccessContextFromPage();
  // Two gates, both server-side: the explicit role list, then the permission matrix that is the real
  // security boundary. No access redirects rather than explaining — inside the admin shell an
  // unreachable page should behave as if it does not exist for that role.
  if (!canAccessDoctorList(access)) redirect("/admin");
  if (!(await canAccess(access, "crm_visits", "read"))) redirect("/admin");

  const params = await searchParams;

  // Data fetch and JSX stay separated (react-hooks/error-boundaries: JSX must not be constructed
  // inside try/catch). A data failure renders a plain explanation, never a crash page.
  let board: Awaited<ReturnType<typeof getRepsListBoard>> | null = null;
  let loadError: string | null = null;
  try {
    // The scope comes from the live AccessContext, never from the query string — a role read off a
    // URL would let any viewer name himself Super Admin and take the company branch.
    const scope = await getDoctorListScope(access);
    board = await getRepsListBoard({
      params: { area: params?.area, line: params?.line, region: params?.region, rep: params?.rep },
      scope,
    });
  } catch (error) {
    loadError = error instanceof Error ? error.message : "Reps List data is unavailable.";
  }

  if (!board) {
    return (
      <div className="border border-rose-200 bg-rose-50 px-5 py-4">
        <p className="text-sm font-bold text-rose-800">Reps List could not load.</p>
        <p className="mt-1 text-xs text-rose-700">{loadError}</p>
      </div>
    );
  }

  return <RepsListBoardView basePath="/admin/reps-list" board={board} />;
}
