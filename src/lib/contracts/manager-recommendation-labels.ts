import type { ContractManagerRecommendation, ContractManagerRecommendationValue } from "./types";

/**
 * The browser-safe half of src/lib/contracts/manager-recommendation.ts — constants, labels and the
 * page's context type, with no server import, so the manager's form can share them.
 */

export const CONTRACT_RECOMMENDATION_NOTE_MAX = 1000;

export const contractRecommendationLabels: Record<ContractManagerRecommendationValue, string> = {
  do_not_renew: "Do not renew",
  renew: "Renew",
};

/** The address the renewal reminder's button opens — one address for every recipient; each shell's page decides. */
export function contractRecommendHref(employeeHrId: string) {
  return `/contracts/recommend/${encodeURIComponent(employeeHrId)}`;
}

export type ManagerRecommendationContext =
  | { state: "not_found" }
  | { state: "forbidden" }
  | {
      state: "ready";
      employee: {
        hrId: string;
        name: string;
        jobTitle: string;
        line: string;
        area: string;
        managerName: string | null;
      };
      renewalDate: string;
      daysUntil: number | null;
      /** In the employee's manager chain — the only viewers who give an answer. */
      canRecommend: boolean;
      /** Holds contracts:read — offered the way to the Contract Renewal board. */
      canOpenBoard: boolean;
      mine: ContractManagerRecommendation | null;
      recommendations: ContractManagerRecommendation[];
    };
