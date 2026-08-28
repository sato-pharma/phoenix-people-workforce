// Doctor List — READ-ONLY board inside the Phoenix admin shell.
//
// The rep's assigned doctors as the CRM itself holds them: name, specialty, grade, address. Not
// visits — the owner's own wording when he specified this ("Not visits."). Activity lives on Rep
// Doctor Lists and Doctor Coverage next door.
//
// This is the ONLY board in Phoenix that can show a doctor who was assigned to a rep and never
// touched. Every other CRM board is built from visit or plan history and is blind to those — 448 of
// them company-wide on the first sweep, 2026-08-28.
//
// SUPER ADMIN ONLY for now. The role list is NOT maintained here — it lives in
// src/lib/crm/doctor-list-access.ts, which explains why it starts narrow and what has to land
// before it widens to district managers.
//
// The rep rides in the URL, so every change re-runs the gate server-side (same posture as the two
// boards beside it).
import { redirect } from "next/navigation";

import { DoctorListBoardView } from "@/components/crm/doctor-list-board";
import { canAccess } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { getDoctorListBoard } from "@/lib/crm/contact-lists";
import { canAccessDoctorList } from "@/lib/crm/doctor-list-access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type PageProps = {
  searchParams?: Promise<{ rep?: string }>;
};

export default async function DoctorListPage({ searchParams }: PageProps) {
  const access = await resolveAccessContextFromPage();
  // Two gates, both server-side: the explicit role list, then the permission matrix that is the
  // real security boundary. No access redirects rather than explaining — inside the admin shell an
  // unreachable page should behave as if it does not exist for that role.
  if (!canAccessDoctorList(access)) redirect("/admin");
  if (!(await canAccess(access, "crm_visits", "read"))) redirect("/admin");

  const params = await searchParams;
  // An unparseable ?rep= falls back to the loader's own default rather than erroring. A hand-typed
  // agent id that matches nobody lands on the first rep, which is a readable board, not a blank one.
  const parsed = Number.parseInt(params?.rep ?? "", 10);
  const agentCrmId = Number.isFinite(parsed) ? parsed : undefined;

  // Data fetch and JSX stay separated (react-hooks/error-boundaries: JSX must not be constructed
  // inside try/catch). A data failure renders a plain explanation, never a crash page.
  let board: Awaited<ReturnType<typeof getDoctorListBoard>> | null = null;
  let loadError: string | null = null;
  try {
    board = await getDoctorListBoard({ agentCrmId });
  } catch (error) {
    loadError = error instanceof Error ? error.message : "Doctor list data is unavailable.";
  }

  if (!board) {
    return (
      <div className="border border-rose-200 bg-rose-50 px-5 py-4">
        <p className="text-sm font-bold text-rose-800">Doctor lists could not load.</p>
        <p className="mt-1 text-xs text-rose-700">{loadError}</p>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <DoctorListBoardView basePath="/admin/doctor-list" board={board} />
    </div>
  );
}
