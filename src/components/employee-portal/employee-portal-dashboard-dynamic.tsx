import dynamic from "next/dynamic";

import type { MedicalRepPortalData } from "@/lib/employee-portal/service";

type PortalDashboardPageProps = {
  data: MedicalRepPortalData;
};

export const ContactHRSupportPage = dynamic<PortalDashboardPageProps>(() =>
  import("@/components/employee-portal/employee-portal-dashboard").then((mod) => mod.ContactHRSupportPage),
);

export const EmployeePortalIncentivePage = dynamic<PortalDashboardPageProps>(() =>
  import("@/components/employee-portal/employee-portal-dashboard").then((mod) => mod.EmployeePortalIncentivePage),
);

export const MedicalRepOverviewPage = dynamic<PortalDashboardPageProps>(() =>
  import("@/components/employee-portal/employee-portal-dashboard").then((mod) => mod.MedicalRepOverviewPage),
);

export const MedicalRepSalesPage = dynamic<PortalDashboardPageProps>(() =>
  import("@/components/employee-portal/employee-portal-dashboard").then((mod) => mod.MedicalRepSalesPage),
);

export const MedicalRepPayrollPage = dynamic<PortalDashboardPageProps>(() =>
  import("@/components/employee-portal/employee-portal-dashboard").then((mod) => mod.MedicalRepPayrollPage),
);
