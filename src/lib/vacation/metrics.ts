import type {
  VacationPaymentStatus,
  VacationRequestStatus,
} from "@/lib/vacation/types";

export type VacationMetricRow = {
  canDecide?: boolean;
  durationDays: number;
  managerDecision?: "approved" | "rejected" | null;
  paymentStatus: VacationPaymentStatus;
  status: VacationRequestStatus;
};

export function summarizeVacationRequests(rows: VacationMetricRow[]) {
  const summary = {
    approved: 0,
    managerDecisionActions: 0,
    paidDays: 0,
    pending: 0,
    rejected: 0,
    total: rows.length,
    unpaidDays: 0,
  };

  for (const row of rows) {
    if (row.status === "approved") summary.approved += 1;
    if (row.status === "pending_manager") summary.pending += 1;
    if (row.status === "rejected") summary.rejected += 1;
    if (row.paymentStatus === "paid") summary.paidDays += row.durationDays;
    if (row.paymentStatus === "unpaid") summary.unpaidDays += row.durationDays;
    if (row.managerDecision || row.canDecide) summary.managerDecisionActions += 1;
  }

  return summary;
}

export function buildVacationPlatformMetrics(rows: VacationMetricRow[]) {
  const summary = summarizeVacationRequests(rows);

  return {
    approvedRequests: summary.approved,
    managerDecisionActions: summary.managerDecisionActions,
    paidDays: summary.paidDays,
    pendingRequests: summary.pending,
    rejectedRequests: summary.rejected,
    totalRequests: summary.total,
    unpaidDays: summary.unpaidDays,
  };
}
