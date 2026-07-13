import dynamic from "next/dynamic";

import type { PayrollDashboardData } from "@/lib/payroll/types";

type PayrollDashboardProps = {
  initialData: PayrollDashboardData | null;
  initialError: string | null;
};

export const PayrollDashboard = dynamic<PayrollDashboardProps>(() =>
  import("@/components/payroll/payroll-dashboard").then((mod) => mod.PayrollDashboard),
);
