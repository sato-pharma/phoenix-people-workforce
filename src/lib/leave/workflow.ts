import type {
  LeaveWorkflowAction,
  LeaveWorkflowActor,
  LeaveWorkflowStatus,
  VacationRequestRecord,
  VacationRequestType,
} from "@/lib/leave/requests";

export const leaveTypeCodeByRequestType: Record<VacationRequestType, string> = {
  "Annual Leave": "annual_leave",
  "Sick Leave": "sick_leave",
  "Unpaid Leave": "unpaid_leave",
  "Compensatory Leave": "compensatory_leave",
  Other: "other",
};

export const leaveWorkflowStatusOptions: LeaveWorkflowStatus[] = [
  "awaiting_manager",
  "awaiting_hr",
  "awaiting_payout",
  "approved",
  "manager_rejected",
  "hr_rejected",
  "needs_routing",
  "cancelled",
  "draft",
];

export type WorkflowTransitionRequest = {
  action: Exclude<LeaveWorkflowAction, "submit" | "route">;
  actor: LeaveWorkflowActor;
  currentStatus: LeaveWorkflowStatus;
  overrideReason?: string;
  rejectionReason?: string;
};

export type WorkflowTransitionResult = {
  managerStatus: "pending" | "approved" | "rejected" | "not_required";
  hrStatus: "pending" | "approved" | "rejected" | "not_required";
  nextStatus: LeaveWorkflowStatus;
  payrollStatus: "not_required" | "pending" | "processed" | "blocked";
  requiresAuditOverride: boolean;
};

const transitionMatrix: Partial<Record<LeaveWorkflowStatus, Partial<Record<LeaveWorkflowActor, Partial<Record<Exclude<LeaveWorkflowAction, "submit" | "route">, WorkflowTransitionResult>>>>>> = {
  awaiting_manager: {
    manager: {
      approve: {
        hrStatus: "pending",
        managerStatus: "approved",
        nextStatus: "awaiting_hr",
        payrollStatus: "pending",
        requiresAuditOverride: false,
      },
      reject: {
        hrStatus: "not_required",
        managerStatus: "rejected",
        nextStatus: "manager_rejected",
        payrollStatus: "not_required",
        requiresAuditOverride: false,
      },
    },
    admin: {
      approve: {
        hrStatus: "pending",
        managerStatus: "approved",
        nextStatus: "awaiting_hr",
        payrollStatus: "pending",
        requiresAuditOverride: true,
      },
      reject: {
        hrStatus: "not_required",
        managerStatus: "rejected",
        nextStatus: "manager_rejected",
        payrollStatus: "not_required",
        requiresAuditOverride: true,
      },
    },
  },
  awaiting_hr: {
    hr: {
      approve: {
        hrStatus: "approved",
        managerStatus: "approved",
        nextStatus: "approved",
        payrollStatus: "pending",
        requiresAuditOverride: false,
      },
      reject: {
        hrStatus: "rejected",
        managerStatus: "approved",
        nextStatus: "hr_rejected",
        payrollStatus: "blocked",
        requiresAuditOverride: false,
      },
    },
    admin: {
      approve: {
        hrStatus: "approved",
        managerStatus: "approved",
        nextStatus: "approved",
        payrollStatus: "pending",
        requiresAuditOverride: true,
      },
      reject: {
        hrStatus: "rejected",
        managerStatus: "approved",
        nextStatus: "hr_rejected",
        payrollStatus: "blocked",
        requiresAuditOverride: true,
      },
    },
  },
  needs_routing: {
    admin: {
      approve: {
        hrStatus: "pending",
        managerStatus: "approved",
        nextStatus: "awaiting_hr",
        payrollStatus: "pending",
        requiresAuditOverride: true,
      },
      reject: {
        hrStatus: "not_required",
        managerStatus: "rejected",
        nextStatus: "manager_rejected",
        payrollStatus: "not_required",
        requiresAuditOverride: true,
      },
    },
  },
  approved: {},
  awaiting_payout: {},
  cancelled: {},
  draft: {},
  hr_rejected: {},
  manager_rejected: {},
};

export function deriveLegacyStatus(workflowStatus: LeaveWorkflowStatus) {
  if (workflowStatus === "approved" || workflowStatus === "awaiting_payout") return "Approved" as const;
  if (workflowStatus === "manager_rejected" || workflowStatus === "hr_rejected" || workflowStatus === "cancelled") return "Rejected" as const;
  return "Pending" as const;
}

export function getWorkflowStatusLabel(workflowStatus: LeaveWorkflowStatus) {
  switch (workflowStatus) {
    case "awaiting_manager":
      return "Awaiting Manager";
    case "awaiting_hr":
      return "Awaiting HR";
    case "awaiting_payout":
      return "Awaiting Payout";
    case "approved":
      return "Approved";
    case "manager_rejected":
      return "Manager Rejected";
    case "hr_rejected":
      return "HR Rejected";
    case "needs_routing":
      return "Needs Routing";
    case "cancelled":
      return "Cancelled";
    default:
      return "Draft";
  }
}

export function resolveAllowedActions(input: {
  actor: LeaveWorkflowActor;
  request: Pick<VacationRequestRecord, "workflowStatus">;
}) {
  const actorConfig = transitionMatrix[input.request.workflowStatus]?.[input.actor];
  return actorConfig ? (Object.keys(actorConfig) as Array<"approve" | "reject">) : [];
}

export function transitionLeaveRequest(input: WorkflowTransitionRequest): WorkflowTransitionResult {
  const actorTransitions = transitionMatrix[input.currentStatus]?.[input.actor];
  const transition = actorTransitions?.[input.action];

  if (!transition) {
    throw new Error(`Invalid leave transition: ${input.actor} cannot ${input.action} from ${input.currentStatus}.`);
  }

  if (transition.requiresAuditOverride && input.actor === "admin" && !String(input.overrideReason ?? "").trim()) {
    throw new Error("Admin override reason is required.");
  }

  if (input.action === "reject" && !String(input.rejectionReason ?? "").trim()) {
    throw new Error("Rejection reason is required.");
  }

  return transition;
}
