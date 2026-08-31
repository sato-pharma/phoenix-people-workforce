import dynamic from "next/dynamic";

import type { VsTargetDashboardData } from "@/lib/sales/vs-target-page";

type VsTargetDashboardProps = {
  data: VsTargetDashboardData;
  basePath: string;
  kicker: string;
};

export const VsTargetDashboard = dynamic<VsTargetDashboardProps>(() =>
  import("@/components/sales/vs-target/vs-target-dashboard").then((mod) => mod.VsTargetDashboard),
);
