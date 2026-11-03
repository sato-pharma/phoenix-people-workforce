import { redirect } from "next/navigation";

import { EmployeePortalPageShell } from "@/components/employee-portal/enterprise-shell";
import { EmptySeatsBoard } from "@/components/reports/empty-seats-board";
import { resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { canViewEmptySeatsBoard, getEmptySeatsBoard } from "@/lib/reports/empty-seats";

export const dynamic = "force-dynamic";

export default async function EmployeePortalEmptySeatsPage() {
  const access = await resolveAccessContextFromPage();
  if (resolveNavigationMode(access) !== "employee-portal") {
    redirect("/reports/vacancies/empty-seats");
  }
  if (!(await canViewEmptySeatsBoard(access))) {
    redirect("/employee-portals/vacancies");
  }

  const board = await getEmptySeatsBoard(access);

  return (
    <EmployeePortalPageShell
      badge="Team Operations"
      description="Every empty rep seat beside what its area sold in the newest published Monthly Closing, to see which to fill first."
      title="Empty Seats"
    >
      <EmptySeatsBoard backHref="/employee-portals/vacancies" board={board} />
    </EmployeePortalPageShell>
  );
}
