import dynamic from "next/dynamic";

import type { EmployeePortalShellData, MedicalRepPortalData } from "@/lib/employee-portal/service";

type PortalDashboardPageProps = {
  data: MedicalRepPortalData;
  surface?: "employee-portal" | "workspace";
};

type ContactHRSupportPageProps = {
  data: EmployeePortalShellData;
};

// ITS OWN CHUNK (2026-10-01, "slow to transfer between page and page"): this imported the whole
// dashboard module, so the Request Support form shipped recharts and the incentive calculators
// with it (91 KB of its 171 KB gzip). The form's own file carries only what the form uses.
export const ContactHRSupportPage = dynamic<ContactHRSupportPageProps>(() =>
  import("@/components/employee-portal/contact-hr-support-page").then((mod) => mod.ContactHRSupportPage),
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
