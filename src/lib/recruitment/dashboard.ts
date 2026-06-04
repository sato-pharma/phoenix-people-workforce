// Recruitment / ATS — dashboard aggregation for the admin pages.

import type { AccessContext } from "@/lib/auth/permissions";
import { listApplications, type ApplicationWithContext } from "@/lib/recruitment/applications";
import { listRequisitions } from "@/lib/recruitment/requisitions";
import {
  applicationStages,
  isTerminalApplicationStage,
  type Requisition,
} from "@/lib/recruitment/types";

export type RecruitmentDashboard = {
  requisitions: Requisition[];
  applications: ApplicationWithContext[];
  summary: {
    totalRequisitions: number;
    openRequisitions: number;
    totalApplications: number;
    activeApplications: number;
    hires: number;
    stageCounts: Record<string, number>;
  };
};

export async function getRecruitmentDashboard(access: AccessContext): Promise<RecruitmentDashboard> {
  const [requisitions, applications] = await Promise.all([
    listRequisitions(access),
    listApplications(access),
  ]);

  const stageCounts: Record<string, number> = {};
  for (const stage of applicationStages) stageCounts[stage] = 0;
  for (const application of applications) {
    stageCounts[application.stage] = (stageCounts[application.stage] ?? 0) + 1;
  }

  const openRequisitions = requisitions.filter((requisition) =>
    ["req_open", "req_published"].includes(requisition.status),
  ).length;
  const activeApplications = applications.filter(
    (application) => !isTerminalApplicationStage(application.stage),
  ).length;
  const hires = applications.filter((application) => application.stage === "hired").length;

  return {
    requisitions,
    applications,
    summary: {
      totalRequisitions: requisitions.length,
      openRequisitions,
      totalApplications: applications.length,
      activeApplications,
      hires,
      stageCounts,
    },
  };
}
