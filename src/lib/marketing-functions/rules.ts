// Marketing Functions — the pure rules: what a saved item may hold, the month's Planned / Actual / Done
// figures, and which items carry forward. No IO, no clock.

import { isIsoDate } from "./months";
import type { FieldFeedbackInput, MarketingFunctionItem } from "./types";
import {
  CALL_REMARK_KEYS,
  FIELD_ACTION_OWNERS,
  MARKETING_FUNCTION_CATEGORIES,
  isCallRating,
  isFieldActionOwner,
  isMarketingFunctionCategoryKey,
  isMarketingFunctionStatus,
  type CallRating,
  type CallRemarkKey,
  type MarketingFunctionCategoryKey,
} from "./vocabulary";

export const MAX_ITEMS_PER_MONTH = 200;
export const MAX_TEXT = 2000;
export const MAX_SHORT_TEXT = 160;

function cleanText(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.replace(/\r\n/g, "\n").trim();
  return trimmed ? trimmed.slice(0, max) : null;
}

/**
 * One item as the browser sent it, or null when it cannot be saved. A row with no description is
 * dropped rather than refused: a blank line the author never filled is not an error.
 */
export function normalizeItem(raw: unknown): MarketingFunctionItem | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  if (!isMarketingFunctionCategoryKey(value.categoryKey)) return null;
  const description = cleanText(value.description, MAX_TEXT);
  if (!description) return null;
  return {
    id: typeof value.id === "string" && value.id ? value.id : null,
    categoryKey: value.categoryKey,
    product: cleanText(value.product, MAX_SHORT_TEXT),
    description,
    dueDate: isIsoDate(value.dueDate) ? value.dueDate : null,
    origin: value.origin === "actual" ? "actual" : "planned",
    statusMid: isMarketingFunctionStatus(value.statusMid) ? value.statusMid : null,
    noteMid: cleanText(value.noteMid, MAX_TEXT),
    statusEnd: isMarketingFunctionStatus(value.statusEnd) ? value.statusEnd : null,
    noteEnd: cleanText(value.noteEnd, MAX_TEXT),
  };
}

export function normalizeItems(raw: unknown): MarketingFunctionItem[] {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, MAX_ITEMS_PER_MONTH).map(normalizeItem).filter((item): item is MarketingFunctionItem => item !== null);
}

export type MonthFigures = {
  planned: number;
  actual: number;
  done: number;
  /** Done of everything on the sheet, 0–100, or null when the sheet is empty. */
  donePercent: number | null;
};

/** "Done" is the end-of-month status; until that is set, the mid-month one counts. */
export function itemIsDone(item: Pick<MarketingFunctionItem, "statusMid" | "statusEnd">): boolean {
  return (item.statusEnd ?? item.statusMid) === "done";
}

export function monthFigures(items: readonly MarketingFunctionItem[]): MonthFigures {
  const planned = items.filter((item) => item.origin === "planned").length;
  const actual = items.filter((item) => item.origin === "actual").length;
  const done = items.filter(itemIsDone).length;
  const total = items.length;
  return { planned, actual, done, donePercent: total === 0 ? null : Math.round((done / total) * 100) };
}

export function categoryFigures(
  items: readonly MarketingFunctionItem[],
): Record<MarketingFunctionCategoryKey, MonthFigures> {
  const result = {} as Record<MarketingFunctionCategoryKey, MonthFigures>;
  for (const category of MARKETING_FUNCTION_CATEGORIES) {
    result[category.key] = monthFigures(items.filter((item) => item.categoryKey === category.key));
  }
  return result;
}

/**
 * What "Carry forward" copies into next month: everything not done and not cancelled, as a fresh
 * planned item with both statuses cleared. The description, product and category travel; the due
 * date is dropped when it lies before next month starts, because a past date is not a plan.
 */
export function carryForwardItems(items: readonly MarketingFunctionItem[], nextMonthStart: string): MarketingFunctionItem[] {
  return items
    .filter((item) => {
      const last = item.statusEnd ?? item.statusMid;
      return last !== "done" && last !== "cancelled";
    })
    .map((item) => ({
      id: null,
      categoryKey: item.categoryKey,
      product: item.product,
      description: item.description,
      dueDate: item.dueDate && item.dueDate >= nextMonthStart ? item.dueDate : null,
      origin: "planned" as const,
      statusMid: null,
      noteMid: null,
      statusEnd: null,
      noteEnd: null,
    }));
}

function cleanCount(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return null;
  return Math.min(Math.round(number), 500);
}

/** A field-visit form as the browser sent it. Throws a plain sentence for what cannot be saved. */
export function normalizeFieldFeedbackInput(raw: unknown): FieldFeedbackInput {
  if (!raw || typeof raw !== "object") throw new Error("The form is empty.");
  const value = raw as Record<string, unknown>;
  const repHrId = cleanText(value.repHrId, 40);
  if (!repHrId) throw new Error("Choose the accompanied person.");
  if (!isIsoDate(value.visitDate)) throw new Error("Choose the date of the visit.");

  const ratings: Partial<Record<CallRemarkKey, CallRating>> = {};
  const rawRatings = value.ratings && typeof value.ratings === "object" ? (value.ratings as Record<string, unknown>) : {};
  for (const key of CALL_REMARK_KEYS) {
    const rating = rawRatings[key];
    if (isCallRating(rating)) ratings[key] = rating;
  }

  const owners = Array.isArray(value.actionOwners) ? value.actionOwners.filter(isFieldActionOwner) : [];

  return {
    id: typeof value.id === "string" && value.id ? value.id : null,
    visitType: value.visitType === "single" ? "single" : "double",
    repHrId,
    visitDate: value.visitDate,
    amClinics: cleanCount(value.amClinics),
    pmClinics: cleanCount(value.pmClinics),
    pharmacies: cleanCount(value.pharmacies),
    objectives: cleanText(value.objectives, MAX_TEXT),
    ratings,
    comments: cleanText(value.comments, MAX_TEXT),
    doctorsComments: cleanText(value.doctorsComments, MAX_TEXT),
    recommendations: cleanText(value.recommendations, MAX_TEXT),
    actionOwners: FIELD_ACTION_OWNERS.filter((owner) => owners.includes(owner)),
    fromCrmDay: value.fromCrmDay === true,
  };
}

/** What still stops a form from being signed, in plain words; empty when it can be signed. */
export function missingForSignature(input: Pick<FieldFeedbackInput, "ratings" | "objectives">): string[] {
  const missing: string[] = [];
  const unrated = CALL_REMARK_KEYS.filter((key) => !input.ratings[key]).length;
  if (unrated > 0) missing.push(`${unrated} of the ${CALL_REMARK_KEYS.length} call remarks ${unrated === 1 ? "is" : "are"} not rated yet.`);
  if (!input.objectives) missing.push("The objectives of the field visit are empty.");
  return missing;
}
