import dynamic from "next/dynamic";

import type { EmployeePortalShellData, MedicalRepPortalData } from "@/lib/employee-portal/service";

type PortalDashboardPageProps = {
  data: MedicalRepPortalData;
};

type ContactHRSupportPageProps = {
  data: EmployeePortalShellData;
};

export const ContactHRSupportPage = dynamic<ContactHRSupportPageProps>(() =>
  import("@/components/employee-portal/employee-portal-dashboard").then((mod) => mod.ContactHRSupportPage),
);

export const EmployeePortalIncentivePage = dynamic<PortalDashboardPageProps>(() =>
  import("@/components/employee-portal/employee-portal-dashboard").then((mod) => mod.EmployeePortalIncentivePage),
);

export const MedicalRepOverviewPage = dynamic<PortalDashboardPageProps>(() =>
  import("@/components/employee-portal/employee-portal-dashboard").then((mod) => mod.MedicalRepOverviewPage),
);

export const MedicalRepPayrollPage = dynamic<PortalDashboardPageProps>(() =>
  import("@/components/employee-portal/employee-portal-dashboard").then((mod) => mod.MedicalRepPayrollPage),
);
