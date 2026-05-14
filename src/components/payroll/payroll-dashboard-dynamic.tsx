import dynamic from "next/dynamic";

import type { PayrollDashboardData } from "@/lib/payroll/types";

type PayrollDashboardProps = {
  initialData: PayrollDashboardData | null;
  initialError: string | null;
  initialSheetTab?: "salary" | "expenses";
};

export const PayrollDashboard = dynamic<PayrollDashboardProps>(() =>
  import("@/components/payroll/payroll-dashboard").then((mod) => mod.PayrollDashboard),
);
