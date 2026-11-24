/**
 * "Save amounts" on one expense claim — what is refused, and what is written, before anything is.
 *
 * Owner, 24 Nov 2026: "i want to be able to edit in expense value", and asked which edit, "All of
 * these": each part (travel, allowance, meeting, other), on a waiting claim and on a decided one, any
 * figure — above the claim too — until a payroll takes the trip.
 *
 * The edit is stored once, on the request (`hr_amounts`, hr-amounts.ts), and never over the claim:
 * what the employee sent stays as sent. Setting every part back to the claim clears the edit.
 *
 * Refused, and nothing written:
 *   - the claim is not on his list, or a payroll took it (locked), or its payout month's payroll has
 *     already run (`approved_missed`) — the same two closures `decidedChange` names for a decision;
 *   - the claim moved since he opened it (the version he saw is not the version stored);
 *   - a part is not a figure from 0 to EGP 1,000,000;
 *   - nothing changed;
 *   - no reason. An edited figure is money, and the record says why.
 *
 * Pure: no database, no session. amounts.ts reads the claim and the payroll run, and writes.
 */

import { DECIDED_CHANGE_REFUSAL, decidedChange } from "@/lib/outstation/approvals/decided-change";
import type { DeskAmountsRequest, DeskClaim } from "@/lib/outstation/approvals/types";
import { OUTSTATION_CLAIM_CHANGED_MESSAGE } from "@/lib/outstation/claim-revision";
import {
  EXPENSE_PART_KEYS,
  EXPENSE_PART_MAX,
  partsTotal,
  sameParts,
  type ExpenseParts,
  type HrAmounts,
} from "@/lib/outstation/hr-amounts";
import { roundCurrency } from "@/lib/payroll/money";

export const AMOUNTS_REFUSAL = {
  badPart: `Each amount is a figure from 0 to EGP ${EXPENSE_PART_MAX.toLocaleString("en-US")}.`,
  gone: "This claim is not on your list any more.",
  inPayroll: DECIDED_CHANGE_REFUSAL.inPayroll,
  noChange: "These are the amounts the claim already pays. Nothing changed.",
  noReason: "Say why the amounts changed.",
  payrollRan: DECIDED_CHANGE_REFUSAL.payrollRan,
} as const;

/** The longest reason kept; the box stops typing past it. */
export const AMOUNTS_REASON_MAX = 500;

export type PlannedAmounts =
  | {
      /** The parts the claim paid just before this edit. */
      before: ExpenseParts;
      /** What is stored: the new edit, or null when every part is back at the claim. */
      next: HrAmounts | null;
      ok: true;
      /** What the trip pays after the edit. */
      total: number;
    }
  | { code: "changed" | "refused"; message: string; ok: false };

const refused = (message: string): PlannedAmounts => ({ code: "refused", message, ok: false });

/** The parts the claim pays now: the edit when there is one, else the claim's own. */
export function currentParts(parts: NonNullable<DeskClaim["parts"]>): ExpenseParts {
  const source = parts.edited ?? parts.claimed;
  return { allowance: source.allowance, meeting: source.meeting, other: source.other, travel: source.travel };
}

/** A typed part as a figure, or null when it is not one the desk accepts. */
function partOf(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > EXPENSE_PART_MAX) return null;
  return roundCurrency(value);
}

export function planDeskAmounts(input: {
  by: string | null;
  claim: DeskClaim | null | undefined;
  now: Date;
  request: DeskAmountsRequest;
}): PlannedAmounts {
  const { claim, request } = input;
  if (!claim || !claim.parts) return refused(AMOUNTS_REFUSAL.gone);
  if (claim.locked || claim.standing === "in_payroll") return refused(AMOUNTS_REFUSAL.inPayroll);
  if (claim.standing === "approved_missed") return refused(AMOUNTS_REFUSAL.payrollRan);
  // Waiting, rejected, held or queued for the next payroll: open. `decidedChange` is asked so a
  // closure added there one day closes this box too.
  const why = decidedChange(claim).why;
  if (why === DECIDED_CHANGE_REFUSAL.inPayroll || why === DECIDED_CHANGE_REFUSAL.payrollRan) return refused(why);
  if (!request.revision || request.revision !== claim.revision) {
    return { code: "changed", message: OUTSTATION_CLAIM_CHANGED_MESSAGE, ok: false };
  }

  const typed = {} as ExpenseParts;
  for (const key of EXPENSE_PART_KEYS) {
    const value = partOf(request.parts?.[key]);
    if (value === null) return refused(AMOUNTS_REFUSAL.badPart);
    typed[key] = value;
  }

  const before = currentParts(claim.parts);
  if (sameParts(typed, before)) return refused(AMOUNTS_REFUSAL.noChange);
  const reason = String(request.reason ?? "").trim().slice(0, AMOUNTS_REASON_MAX);
  if (!reason) return refused(AMOUNTS_REFUSAL.noReason);

  // Every part back at the claim: the edit is cleared, and the trip pays its claim again.
  if (sameParts(typed, claim.parts.claimed)) {
    return { before, next: null, ok: true, total: claim.parts.claimedTotal };
  }
  return {
    before,
    next: { ...typed, before, by: input.by, reason, setAt: input.now.toISOString() },
    ok: true,
    total: partsTotal(typed),
  };
}

/**
 * Can the amounts box open on this claim? Not on one a payroll took, nor on one whose payout
 * month's payroll has run — the same two closures the plan refuses — and not on a claim that carries
 * no parts. Asked by the opened trip; the server asks the plan again.
 */
export function amountsOpen(claim: Pick<DeskClaim, "locked" | "parts" | "standing">): boolean {
  if (!claim.parts || claim.locked) return false;
  return claim.standing !== "in_payroll" && claim.standing !== "approved_missed";
}

/** "1,250.50" or "0" typed by a person, as a part; null when it is not a figure from 0 to the cap. */
export function typedPart(value: string): number | null {
  const text = value.replace(/[,\s]/g, "").replace(/^egp/i, "");
  if (!/^\d+(\.\d{1,2})?$/.test(text)) return null;
  return partOf(Number(text));
}

/** The boxes as the amounts box opens them: the parts the claim pays now. */
export function amountsDraft(parts: NonNullable<DeskClaim["parts"]>): Record<keyof ExpenseParts, string> {
  const now = currentParts(parts);
  const out = {} as Record<keyof ExpenseParts, string>;
  for (const key of EXPENSE_PART_KEYS) out[key] = String(now[key]);
  return out;
}

/** The four typed boxes as parts, or null while any of them is not a figure. */
export function draftParts(draft: Record<keyof ExpenseParts, string>): ExpenseParts | null {
  const out = {} as ExpenseParts;
  for (const key of EXPENSE_PART_KEYS) {
    const value = typedPart(draft[key] ?? "");
    if (value === null) return null;
    out[key] = value;
  }
  return out;
}
