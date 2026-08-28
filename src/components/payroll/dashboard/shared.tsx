import { Badge } from "@/components/ui/badge";
import type { SalaryBatch } from "@/lib/payroll/types";

export const payrollMonths = [
  { label: "January", value: "1" },
  { label: "February", value: "2" },
  { label: "March", value: "3" },
  { label: "April", value: "4" },
  { label: "May", value: "5" },
  { label: "June", value: "6" },
  { label: "July", value: "7" },
  { label: "August", value: "8" },
  { label: "September", value: "9" },
  { label: "October", value: "10" },
  { label: "November", value: "11" },
  { label: "December", value: "12" },
];

export const panelClassName =
  "rounded-[28px] border border-phx-line bg-white/94 shadow-[0_18px_46px_rgba(15,23,42,0.08)] backdrop-blur";

export const publishedPayslipStatuses = new Set(["approved", "locked"]);

const payrollStageOrderForReplacement = [
  "uploaded",
  "part1_ready",
  "part1_paid",
  "adjustments_open",
  "part2_ready",
  "under_review",
  "approved",
  "locked",
];

const replaceableBatchStatuses = new Set(["uploaded", "part1_ready", "rejected"]);

function isPart1PaidBatch(batch: SalaryBatch) {
  return Boolean(batch.part1PaidAt) || payrollStageOrderForReplacement.indexOf(batch.status) >= payrollStageOrderForReplacement.indexOf("part1_paid");
}

export function isBatchReplaceable(batch: SalaryBatch) {
  return replaceableBatchStatuses.has(batch.status) && !isPart1PaidBatch(batch);
}

export function payrollPeriodLabel(month: number, year: number) {
  const monthName =
    payrollMonths.find((item) => item.value === String(month))?.label ??
    `Month ${month}`;

  return `${monthName} ${year}`;
}

export function payrollPeriodIndex(month: number, year: number) {
  return year * 12 + month;
}

export function statusBadge(status: string) {
  switch (status) {
    case "adjustments_open":
      return <Badge variant="warning">Adjustments Open</Badge>;
    case "approved":
      return <Badge variant="success">Approved</Badge>;
    case "locked":
      return <Badge variant="success">Locked</Badge>;
    case "part1_paid":
      return <Badge variant="success">Part 1 Paid</Badge>;
    case "part1_ready":
      return <Badge variant="warning">Part 1 Ready</Badge>;
    case "part2_ready":
      return <Badge variant="warning">Part 2 Ready</Badge>;
    case "rejected":
      return <Badge variant="danger">Rejected</Badge>;
    case "under_review":
      return <Badge variant="warning">Under Review</Badge>;
    default:
      return <Badge variant="neutral">Uploaded</Badge>;
  }
}
