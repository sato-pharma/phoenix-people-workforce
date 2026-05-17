export type ContractRow = {
  area: string;
  contract_id: string | null;
  contract_renewal_date: string;
  contract_signed_date: string | null;
  crm_id: string | null;
  full_name: string;
  hr_id: string;
  job_title: string;
  line: string;
  manager_hr_id: string | null;
  renewal_day: number;
  workflow: ContractRenewalRecord | null;
};

export type ContractRenewalStatus =
  | "requested"
  | "manager_review"
  | "hr_review"
  | "renewed"
  | "not_renewed"
  | "cancelled";

export type ContractRenewalAction =
  | "manager_review"
  | "hr_review"
  | "renew"
  | "not_renew"
  | "upload_signed"
  | "cancel";

export type ContractRenewalRecord = {
  id: string;
  employeeHrId: string;
  employeeName: string;
  jobTitle: string | null;
  lineName: string | null;
  areaName: string | null;
  currentContractId: string | null;
  currentRenewalDate: string | null;
  requestedRenewalDate: string;
  proposedStartDate: string | null;
  proposedEndDate: string | null;
  newContractDocumentUrl: string | null;
  newContractDocumentName: string | null;
  signedContractUrl: string | null;
  signedContractName: string | null;
  signedAt: string | null;
  workflowNotes: string | null;
  status: ContractRenewalStatus;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  managerReviewedAt: string | null;
  managerReviewedBy: string | null;
  hrReviewedAt: string | null;
  hrReviewedBy: string | null;
  decisionAt: string | null;
  decisionBy: string | null;
  decisionReason: string | null;
  completedContractId: string | null;
};

export type ContractRenewalDashboardData = {
  rows: ContractRow[];
  summary: {
    activeRequests: number;
    managerReview: number;
    hrReview: number;
    notRenewed: number;
    renewed: number;
    totalRequests: number;
  };
};

export type CreateContractRenewalInput = {
  employeeHrId: string;
  requestedRenewalDate?: string | null;
  proposedStartDate?: string | null;
  proposedEndDate?: string | null;
  newContractDocumentUrl?: string | null;
  newContractDocumentName?: string | null;
  workflowNotes?: string | null;
};
