import { redirect } from "next/navigation";

import { AdminPageHero } from "@/components/admin/admin-design-system";
import { EmptySeatsBoard } from "@/components/reports/empty-seats-board";
import { resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { canViewEmptySeatsBoard, getEmptySeatsBoard } from "@/lib/reports/empty-seats";

export const dynamic = "force-dynamic";

export default async function EmptySeatsPage() {
  const access = await resolveAccessContextFromPage();
  if (resolveNavigationMode(access) === "employee-portal") {
    redirect("/employee-portals/vacancies/empty-seats");
  }
  if (!(await canViewEmptySeatsBoard(access))) {
    redirect("/reports/vacancies");
  }

  const board = await getEmptySeatsBoard(access);

  return (
    <div className="space-y-6">
      <AdminPageHero
        description="Every empty rep seat beside what its area sold in the newest published Monthly Closing, to see which to fill first."
        eyebrow="Vacancies"
        title="Empty Seats"
      />
      <EmptySeatsBoard backHref="/reports/vacancies" board={board} />
    </div>
  );
}
