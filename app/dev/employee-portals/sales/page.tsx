import { notFound } from "next/navigation";
import { connection } from "next/server";

import { SalesPerformancePage } from "@/components/sales/sales-performance-page";
import {
  EmployeePortalChrome,
} from "@/components/employee-portal/employee-portal-layout";
import {
  EmployeePortalPageShell,
} from "@/components/employee-portal/enterprise-shell";
import { resolveEmployeePortalNavVisibility } from "@/lib/employee-portal/navigation";
import { employeePortalDevPreviewData } from "@/lib/employee-portal/dev-preview-data";
import type { SalesDashboardData } from "@/lib/sales/types";

export const metadata = {
  title: "Sales Performance Dev Preview",
};

const devSalesData: SalesDashboardData = {
  summary: {
    totalApprovedSales: 6370000,
    totalApprovedTarget: 5975000,
    achievementRate: 1.066,
    activeProducts: 18,
    unitsSold: 32400,
    linkedEmployees: 24,
    approvedRecords: 1240,
    topManager: "Ahmed Hassan",
    dsmLinkedRecords: 8,
    dsmTotalRecords: 8,
    dataQualityRate: 1,
    averageFactoryPrice: 196.3,
  },
  trend: [
    { period: "2025-10", sales: 780000, target: 880000, achievementRate: 0.886, linkedEmployees: 22 },
    { period: "2025-11", sales: 860000, target: 920000, achievementRate: 0.935, linkedEmployees: 23 },
    { period: "2025-12", sales: 940000, target: 960000, achievementRate: 0.979, linkedEmployees: 24 },
    { period: "2026-01", sales: 1020000, target: 980000, achievementRate: 1.041, linkedEmployees: 24 },
    { period: "2026-02", sales: 1050000, target: 1020000, achievementRate: 1.029, linkedEmployees: 24 },
    { period: "2026-03", sales: 1110000, target: 1060000, achievementRate: 1.047, linkedEmployees: 24 },
    { period: "2026-04", sales: 1175000, target: 1100000, achievementRate: 1.068, linkedEmployees: 24 },
    { period: "2026-05", sales: 1260000, target: 1180000, achievementRate: 1.068, linkedEmployees: 24 },
  ],
  productPerformance: [
    { product: "Cardiomax 50mg", family: "Cardio", sales: 1210000, target: 1100000, achievementRate: 1.1 },
    { product: "Glucofen 500mg", family: "Metabolic", sales: 990000, target: 920000, achievementRate: 1.076 },
    { product: "Vasotrol 10mg", family: "Vascular", sales: 780000, target: 750000, achievementRate: 1.04 },
    { product: "Lipidex 20mg", family: "Cardio", sales: 650000, target: 600000, achievementRate: 1.083 },
    { product: "Pressunil 5mg", family: "Hypertension", sales: 540000, target: 580000, achievementRate: 0.931 },
    { product: "Metforza XR", family: "Metabolic", sales: 480000, target: 440000, achievementRate: 1.091 },
    { product: "Arterixin 25mg", family: "Vascular", sales: 420000, target: 460000, achievementRate: 0.913 },
    { product: "Betacardiol CR", family: "Cardio", sales: 380000, target: 350000, achievementRate: 1.086 },
    { product: "Insulex Pen", family: "Metabolic", sales: 340000, target: 380000, achievementRate: 0.895 },
    { product: "Diuretix 12.5mg", family: "Hypertension", sales: 280000, target: 320000, achievementRate: 0.875 },
    { product: "Thrombostat 75mg", family: "Vascular", sales: 220000, target: 250000, achievementRate: 0.88 },
    { product: "Coagulex Forte", family: "Cardio", sales: 180000, target: 200000, achievementRate: 0.9 },
    { product: "Angiomax Plus", family: "Hypertension", sales: 160000, target: 195000, achievementRate: 0.821 },
    { product: "Statinol 40mg", family: "Cardio", sales: 140000, target: 180000, achievementRate: 0.778 },
    { product: "Nephroguard", family: "Metabolic", sales: 120000, target: 160000, achievementRate: 0.75 },
    { product: "Venotonic Gel", family: "Vascular", sales: 100000, target: 130000, achievementRate: 0.769 },
    { product: "Cerebrovex 200", family: "Cardio", sales: 80000, target: 110000, achievementRate: 0.727 },
    { product: "Adrenalex Inj", family: "Cardio", sales: 40000, target: 100000, achievementRate: 0.4 },
  ],
  filters: {
    periods: ["2025-10", "2025-11", "2025-12", "2026-01", "2026-02", "2026-03", "2026-04", "2026-05"],
    families: ["Cardio", "Hypertension", "Metabolic", "Vascular"],
    products: [
      "Cardiomax 50mg", "Glucofen 500mg", "Vasotrol 10mg", "Lipidex 20mg",
      "Pressunil 5mg", "Metforza XR", "Arterixin 25mg", "Betacardiol CR",
      "Insulex Pen", "Diuretix 12.5mg", "Thrombostat 75mg", "Coagulex Forte",
      "Angiomax Plus", "Statinol 40mg", "Nephroguard", "Venotonic Gel",
      "Cerebrovex 200", "Adrenalex Inj",
    ],
    lines: ["Cardio Metabolic", "Respiratory"],
    managers: ["DSM-001", "DSM-002", "DSM-003"],
    salesTypes: ["Primary", "Secondary"],
    territories: ["Greater Cairo", "Alexandria", "Delta", "Upper Egypt"],
  },
  familyMatrix: [],
  managerPerformance: [],
  territories: [],
  recentBatches: [],
  anomalies: [],
};

export default async function SalesDevPreviewPage() {
  if (process.env.NODE_ENV === "production") {
    notFound();
  }

  await connection();

  const data = employeePortalDevPreviewData;
  const visibility = resolveEmployeePortalNavVisibility(
    data.employee.roleLabel,
    undefined,
    data.employee.line,
    data.employee.department,
    data.employee.hrId,
    true, // dev preview fixture: surface device-gated tabs (e.g. Fingerprint Report)
  );

  return (
    <EmployeePortalChrome
      activePathOverride="/employee-portals/sales"
      data={data}
      disableSessionGuard
      visibility={visibility}
    >
      <EmployeePortalPageShell
        description="Deep performance view with team filters, product mix, and trend diagnostics."
        title="Sales Performance"
      >
        <SalesPerformancePage data={devSalesData} isLoading={false} />
      </EmployeePortalPageShell>
    </EmployeePortalChrome>
  );
}
