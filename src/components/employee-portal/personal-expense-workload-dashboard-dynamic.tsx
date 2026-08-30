import dynamic from "next/dynamic";

import type { MedicalRepPortalData } from "@/lib/employee-portal/service";
import type { WorkloadAdminKeyCards } from "@/components/employee-portal/personal-expense-workload-dashboard";

type PersonalExpenseWorkloadDashboardProps = {
  adminKeyCards?: WorkloadAdminKeyCards | null;
  data: Pick<MedicalRepPortalData, "workload">;
  showHero?: boolean;
  submitExpenseHref?: string;
  ticketCountsByRequestId?: Record<number, number>;
  viewerHrId?: string | null;
};

export const PersonalExpenseWorkloadDashboard = dynamic<PersonalExpenseWorkloadDashboardProps>(() =>
  import("@/components/employee-portal/personal-expense-workload-dashboard").then((mod) => mod.PersonalExpenseWorkloadDashboard),
);
