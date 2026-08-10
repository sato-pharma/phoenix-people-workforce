import { Badge } from "@/components/ui/badge";
import type { ResignationStatus } from "@/lib/resignations/types";
import type { ResignationDaysState } from "@/lib/resignations/view-model";

const statusLabels: Record<ResignationStatus, string> = {
  approved: "Approved",
  cancelled: "Cancelled",
  completed: "Completed",
  rejected: "Rejected",
  submitted: "Submitted",
  under_review: "Under Review",
};

const statusVariants: Record<ResignationStatus, "danger" | "neutral" | "success" | "warning"> = {
  approved: "success",
  cancelled: "danger",
  completed: "success",
  rejected: "danger",
  submitted: "warning",
  under_review: "neutral",
};

export function ResignationStatusBadge({ status }: { status: ResignationStatus }) {
  const label = statusLabels[status];
  if (!label) return <Badge variant="neutral">{status}</Badge>;
  return <Badge variant={statusVariants[status]}>{label}</Badge>;
}

/**
 * Days Left cell. The wording and tone come from resignationDaysState, which is the pure function
 * under test — this only renders it, so the desktop table and the mobile card can never disagree.
 */
export function ResignationDaysCell({ state }: { state: ResignationDaysState }) {
  return (
    <>
      <Badge variant={state.tone}>{state.text}</Badge>
      <p className="mt-1 whitespace-nowrap text-xs text-[#64748B]">{state.label}</p>
    </>
  );
}

export type ResignationCardAccent = "amber" | "emerald" | "orange" | "rose" | "sky" | "slate";

export function resignationCardAccent(status: ResignationStatus): ResignationCardAccent {
  switch (status) {
    case "submitted":
      return "orange";
    case "approved":
    case "completed":
      return "emerald";
    case "rejected":
    case "cancelled":
      return "rose";
    case "under_review":
    default:
      return "slate";
  }
}
