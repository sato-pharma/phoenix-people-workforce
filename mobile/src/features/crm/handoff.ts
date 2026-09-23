/**
 * Phoenix CRM — the two hand-offs that pass between the List and Visits screens, the same pair the web
 * module carries (visits-tab.tsx).
 *
 * A rep is at the door with the phone in his hand: the moment he validates a customer, that same photo
 * can stand for today's visit; and the moment he saves a visit on a customer not validated yet, he can
 * validate him now. Each hand-off belongs to one territory in one mode, and is dropped when the shell
 * moves away from it.
 */

import type { CrmCapturedPhoto } from "@/lib/crm/photo";

/** The database lets a validation photo stand for a visit for 30 minutes; the phone stops offering at 28. */
export const REUSE_WINDOW_MS = 28 * 60 * 1000;

export function reuseWindowOver(validatedAtMs: number): boolean {
  return Date.now() - validatedAtMs > REUSE_WINDOW_MS;
}

/** A customer just validated on the List, handed to Add Visit with the photo it was validated with. */
export type PendingVisit = {
  seatId: string;
  test: boolean;
  customerId: string;
  customerName: string;
  /** The place's validation photo, which may stand for this visit; null when he came from a plain row. */
  photo: CrmCapturedPhoto | null;
  /** The phone's Date.now() when the validation saved. */
  validatedAtMs: number;
};

/** A visit just saved on a customer not validated yet, handed back to the List's Validate screen. */
export type PendingValidate = {
  seatId: string;
  test: boolean;
  /** His entry on the territory's iReports360 list: what Validate opens on. */
  contactCrmId: number;
  customerName: string;
};
