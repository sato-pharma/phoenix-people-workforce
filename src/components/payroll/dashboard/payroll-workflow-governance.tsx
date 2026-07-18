import { AlertTriangle, ArrowRight, CheckCircle, Loader2 } from "lucide-react";
import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { formatDateTimeValue } from "@/lib/i18n/format";
import type {
  PayrollDashboardData,
  PayrollWorkflowAction,
  SalaryBatch,
  SalaryFlag,
} from "@/lib/payroll/types";
import { cn } from "@/lib/utils";

import {
  panelClassName,
  payrollPeriodLabel,
  statusBadge,
} from "./shared";

type WorkflowActionOption = {
  action: PayrollWorkflowAction;
  description: string;
  label: string;
  tone?: "danger" | "primary" | "secondary";
};

const payrollStageOrder = [
  "uploaded",
  "part1_ready",
  "part1_paid",
  "adjustments_open",
  "part2_ready",
  "under_review",
  "approved",
  "locked",
];

function workflowActionsForStatus(status: string): WorkflowActionOption[] {
  switch (status) {
    case "uploaded":
      return [{ action: "mark_part1_ready", description: "Freeze the uploaded file for Part 1 review.", label: "Mark Part 1 Ready" }];
    case "part1_ready":
      return [{ action: "mark_part1_paid", description: "Lock Base, Basic, and First Part values.", label: "Confirm Part 1 Paid", tone: "primary" }];
    case "part1_paid":
      return [{ action: "open_adjustments", description: "Open the monthly variable window for Part 2.", label: "Open Adjustments" }];
    case "adjustments_open":
      return [{ action: "mark_part2_ready", description: "Prepare Part 2 after additions and deductions are loaded.", label: "Mark Part 2 Ready", tone: "primary" }];
    case "part2_ready":
      return [{ action: "mark_review", description: "Send the batch into final payroll review.", label: "Send To Review", tone: "primary" }];
    case "under_review":
      return [
        { action: "approve", description: "Publish payroll and payslips for this month.", label: "Approve Payroll", tone: "primary" },
        { action: "reject", description: "Return the batch to adjustments with a reason.", label: "Reject", tone: "danger" },
      ];
    case "approved":
      return [{ action: "lock", description: "Close the payroll period permanently.", label: "Lock Payroll", tone: "primary" }];
    case "rejected":
      return [{ action: "reopen", description: "Return rejected payroll to the Part 2 adjustment stage.", label: "Reopen Adjustments" }];
    default:
      return [];
  }
}

function payrollStageLabel(status: string) {
  return status
    .replace(/^part(\d)/, "part $1")
    .replace(/_/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export function PayrollWorkflowPanel({
  batch,
  busyAction,
  onAction,
}: {
  batch: SalaryBatch;
  busyAction: PayrollWorkflowAction | null;
  onAction: (action: PayrollWorkflowAction) => void;
}) {
  const actions = workflowActionsForStatus(batch.status);
  const shownStages =
    batch.status === "rejected"
      ? [...payrollStageOrder.slice(0, payrollStageOrder.indexOf("under_review") + 1), "rejected"]
      : payrollStageOrder.filter((stage) => stage !== "locked" || batch.status === "locked");
  const activeIndex = shownStages.indexOf(batch.status);

  return (
    <Card className={`${panelClassName} p-5`}>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-base font-bold text-[#0F172A]">Payroll Payment Stage</h2>
            {statusBadge(batch.status)}
          </div>
          <p className="mt-1 text-sm text-[#64748B]">
            {payrollPeriodLabel(batch.month, batch.year)} · Part 1 {batch.part1PaidAt ? `paid ${formatDateTimeValue(batch.part1PaidAt)}` : "not paid yet"}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {actions.map((item) => (
            <Button
              className={cn(
                "h-9 rounded-xl px-3 py-2 text-xs",
                item.tone === "danger" && "border-rose-200 bg-rose-50 text-rose-700 hover:bg-rose-100",
                item.tone === "primary" && "bg-[#F97316] text-white hover:bg-[#EA580C]",
              )}
              disabled={Boolean(busyAction)}
              key={item.action}
              onClick={() => onAction(item.action)}
              title={item.description}
              type="button"
              variant={item.tone === "danger" ? "destructive" : item.tone === "primary" ? "default" : "secondary"}
            >
              {busyAction === item.action ? (
                <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
              ) : item.tone === "danger" ? (
                <AlertTriangle className="mr-2 h-3.5 w-3.5" />
              ) : (
                <ArrowRight className="mr-2 h-3.5 w-3.5" />
              )}
              {item.label}
            </Button>
          ))}
        </div>
      </div>
      <div className="mt-4 grid gap-2 md:grid-cols-4 xl:grid-cols-8">
        {shownStages.map((stage, index) => {
          const complete = activeIndex >= index && activeIndex >= 0;
          const current = batch.status === stage;
          return (
            <div
              className={cn(
                "rounded-2xl border px-3 py-2 text-xs font-semibold",
                complete ? "border-orange-200 bg-orange-50 text-orange-800" : "border-[#E2E8F0] bg-[#F8FAFC] text-[#64748B]",
                current && "ring-2 ring-orange-300",
              )}
              key={stage}
            >
              <div className="flex items-center gap-2">
                {complete ? <CheckCircle className="h-3.5 w-3.5" /> : <span className="h-2 w-2 rounded-full bg-[#CBD5E1]" />}
                <span>{payrollStageLabel(stage)}</span>
              </div>
            </div>
          );
        })}
      </div>
    </Card>
  );
}

export function PayrollGovernanceAlerts({ flags }: { flags: SalaryFlag[] }) {
  if (flags.length === 0) return null;

  return (
    <Card className={`${panelClassName} p-5`}>
      <div className="mb-3 flex items-center gap-2">
        <AlertTriangle className="h-4 w-4 text-warning" />
        <h2 className="text-base font-bold text-[#0F172A]">
          Payroll Alerts ({flags.length})
        </h2>
      </div>
      <div className="space-y-2">
        {flags.slice(0, 14).map((flag) => (
          <div
            className="flex items-start justify-between gap-4 rounded-lg border border-border bg-bg-muted px-4 py-3"
            key={flag.id}
          >
            <div>
              {flag.hrId && (
                <p className="font-mono text-xs text-text-secondary">
                  {flag.hrId}
                </p>
              )}
              <p className="text-sm text-text">{flag.message}</p>
            </div>
            <Badge
              variant={
                flag.severity === "critical"
                  ? "danger"
                  : flag.severity === "warning"
                    ? "warning"
                    : "neutral"
              }
            >
              {flag.severity}
            </Badge>
          </div>
        ))}
      </div>
    </Card>
  );
}

export function PayrollResignationCandidatesBanner({
  candidates,
  count,
}: {
  candidates: PayrollDashboardData["resignationCandidates"];
  count: number;
}) {
  if (candidates.length === 0) return null;

  const total = count > 0 ? count : candidates.length;
  const preview = candidates.slice(0, 8);
  const noun = total === 1 ? "employee" : "employees";
  const verb = total === 1 ? "is" : "are";
  const candidateNoun = total === 1 ? "a resignation candidate" : "resignation candidates";

  return (
    <Card className={`${panelClassName} border-[#FDBA74] bg-[#FFF7ED] p-5`}>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[#FFEDD5] text-[#C2410C]">
          <AlertTriangle className="h-5 w-5" aria-hidden="true" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-black text-[#9A3412]">
            Resignation alarm: {total} {noun} in this batch {verb} {candidateNoun} not in the
            employee directory.
          </p>
          <p className="mt-1 text-sm text-[#9A3412]">
            These HR IDs were flagged during a payroll upload and sent to the resignation report.
            Review them before approving this batch.
          </p>
          {preview.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-2">
              {preview.map((candidate) => (
                <span
                  className="rounded-full border border-[#FED7AA] bg-white px-3 py-1 text-xs font-semibold text-[#9A3412]"
                  key={candidate.hrId}
                >
                  {candidate.hrId} - {candidate.fullName}
                </span>
              ))}
              {total > preview.length && (
                <span className="rounded-full border border-[#FED7AA] bg-white px-3 py-1 text-xs font-semibold text-[#9A3412]">
                  +{total - preview.length} more
                </span>
              )}
            </div>
          )}
          <Link
            className="mt-3 inline-flex items-center gap-1 text-sm font-semibold text-[#C2410C] underline underline-offset-2 hover:text-[#9A3412]"
            href="/resignations"
          >
            View in resignation report
            <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
          </Link>
        </div>
      </div>
    </Card>
  );
}
