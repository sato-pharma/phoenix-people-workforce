// Employee business-card requests — shared types and status set.
//
// Split out from request-service.ts on purpose: this file has NO server-only
// imports, so client components (EmployeeBusinessCard, BusinessCardRequestsQueue)
// can import BUSINESS_CARD_REQUEST_STATUSES as a real value without pulling the
// service's Supabase/notifications chain into the browser bundle. request-service.ts
// re-exports everything here for its own (server-side) consumers.

export const BUSINESS_CARD_REQUEST_STATUSES = ["Pending", "In Progress", "Printed", "Cancelled"] as const;
export type BusinessCardRequestStatus = (typeof BUSINESS_CARD_REQUEST_STATUSES)[number];

/**
 * The card the signed-in employee sees on their own page. `name` and `mobile` are
 * the only two lines they may correct; `title`, `lineArea` and `email` are shown but
 * resolved from the register server-side and never editable here (owner: email never).
 */
export type OwnBusinessCard = {
  address: string;
  email: string;
  lineArea: string;
  mobile: string;
  name: string;
  title: string;
  website: string;
};

export type BusinessCardRequestRow = {
  cardEmail: string;
  cardLineArea: string;
  cardMobile: string;
  cardName: string;
  cardTitle: string;
  createdAt: string;
  employeeName: string;
  hrId: string;
  id: string;
  note: string | null;
  status: BusinessCardRequestStatus;
};

/** What the employee sends: only the two lines they may correct, plus an optional note. */
export type CreateBusinessCardRequestInput = {
  cardMobile: string;
  cardName: string;
  note?: string | null;
};

export type BusinessCardRequestListFilter = {
  /** Ignored: the HR queue returns every request. Kept so older callers still compile. */
  limit?: number;
  status?: BusinessCardRequestStatus | "all";
};

export type BusinessCardRequestNotificationStatus = {
  errored: boolean;
  recipientCount: number;
};

export type CreateBusinessCardRequestResult = {
  notification: BusinessCardRequestNotificationStatus;
  row: BusinessCardRequestRow;
};
