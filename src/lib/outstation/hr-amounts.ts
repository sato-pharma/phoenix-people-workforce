/**
 * THE AMOUNTS THE SUPER ADMIN SET ON AN EXPENSE CLAIM, part by part (owner, 24 Nov 2026: "i want to
 * be able to edit in expense value", and asked which edit, "All of these": each part, on a waiting and
 * on a decided claim, any figure — above the claim too — until a payroll takes the trip).
 *
 * Stored ONCE, on the request (`outstation_expense_requests.hr_amounts`), and never over what the
 * employee claimed: `fuel_amount`, the tickets, `allowance_amount`, `meeting_amount`, `other_amount` and
 * `claimed_total_amount` keep the claim exactly as it was sent. NULL = never edited.
 *
 * The one place a stored edit becomes money is the payroll mapping (payroll-expense-mapping.ts): when
 * one is present, the trip's travel, allowance, meeting and other ARE these figures, and its total is
 * their sum. So payroll, the desk and the payroll row read one figure, and nothing downstream clamps it.
 *
 * Pure: no database, no session.
 */

import { roundCurrency } from "@/lib/payroll/money";

/** The four parts a trip is paid in — the four money columns of its payroll row. */
export type ExpenseParts = {
  allowance: number;
  meeting: number;
  other: number;
  /** Fuel and both tickets: the payroll row's one travel figure. */
  travel: number;
};

export const EXPENSE_PART_KEYS = ["travel", "allowance", "meeting", "other"] as const satisfies ReadonlyArray<keyof ExpenseParts>;

export const EXPENSE_PART_LABEL: Record<keyof ExpenseParts, string> = {
  allowance: "Allowance",
  meeting: "Meeting",
  other: "Other",
  travel: "Travel (fuel and tickets)",
};

/** The highest figure one part may carry. Far above any real trip; a typing slip of extra zeros stops here. */
export const EXPENSE_PART_MAX = 1_000_000;

/** The stored edit: the four figures, the reason, and who set them when. */
export type HrAmounts = ExpenseParts & {
  /** The Super Admin's hr id. */
  by: string | null;
  /** The parts as the claim read just before this edit, kept for the record. */
  before: ExpenseParts | null;
  reason: string;
  /** ISO time of the edit. */
  setAt: string;
};

const part = (value: unknown): number | null => {
  if (value === null || value === undefined || value === "" || typeof value === "boolean") return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > EXPENSE_PART_MAX) return null;
  return roundCurrency(parsed);
};

function partsOf(value: unknown): ExpenseParts | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const travel = part(record.travel);
  const allowance = part(record.allowance);
  const meeting = part(record.meeting);
  const other = part(record.other);
  if (travel === null || allowance === null || meeting === null || other === null) return null;
  return { allowance, meeting, other, travel };
}

/**
 * The stored edit, or null. A value that is not a whole, well-formed edit reads as NO edit — never as
 * a half-edit with a zero in it, which would quietly pay a part as nothing.
 */
export function readHrAmounts(value: unknown): HrAmounts | null {
  const parts = partsOf(value);
  if (!parts) return null;
  const record = value as Record<string, unknown>;
  return {
    ...parts,
    before: partsOf(record.before),
    by: typeof record.by === "string" && record.by.trim() ? record.by.trim() : null,
    reason: typeof record.reason === "string" ? record.reason.trim() : "",
    setAt: typeof record.setAt === "string" ? record.setAt : "",
  };
}

/** What the four parts pay together. */
export function partsTotal(parts: ExpenseParts): number {
  return roundCurrency(parts.travel + parts.allowance + parts.meeting + parts.other);
}

/** Do two sets of parts pay the same in every part (to the piastre)? */
export function sameParts(a: ExpenseParts, b: ExpenseParts): boolean {
  return EXPENSE_PART_KEYS.every((key) => Math.abs(a[key] - b[key]) < 0.005);
}
