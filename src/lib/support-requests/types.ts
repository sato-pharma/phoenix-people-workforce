// Employee HR support requests — shared types and status set.
//
// Split out from service.ts on purpose: this file has NO server-only imports (no
// Supabase admin client, no notifications/email-templates -> employee-directory chain),
// so client components (SupportRequestsWorkspace) can import SUPPORT_REQUEST_STATUSES as
// a real value without pulling service.ts's server-only dependency chain into the browser
// bundle. service.ts re-exports everything here for its own (server-side) consumers.

export const SUPPORT_REQUEST_STATUSES = ["Pending", "In Progress", "Resolved", "Closed"] as const;
export type SupportRequestStatus = (typeof SUPPORT_REQUEST_STATUSES)[number];

export type SupportRequestAttachment = {
  name: string;
  size: number;
  type: string;
};

export type SupportRequestRow = {
  attachments: SupportRequestAttachment[];
  category: string;
  createdAt: string;
  description: string;
  employeeName: string;
  hrId: string;
  id: string;
  status: "Pending" | "In Progress" | "Resolved" | "Closed";
  subcategory: string | null;
  subject: string;
};

export type CreateSupportRequestInput = {
  attachments?: SupportRequestAttachment[];
  category: string;
  description: string;
  employeeName: string;
  hrId: string;
  subcategory?: string | null;
  subject: string;
};

export type SupportRequestListFilter = {
  limit?: number;
  status?: SupportRequestStatus | "all";
};

export type SupportNotificationStatus = {
  errored: boolean;
  fellBackToSuperAdmin: boolean;
  recipientCount: number;
};

export type CreateSupportRequestResult = {
  notification: SupportNotificationStatus;
  row: SupportRequestRow;
};
