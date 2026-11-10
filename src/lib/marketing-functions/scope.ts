// Marketing Functions & Field Visit Feedback — who fills, who reads, who reviews. Pure.
//
// The permission matrix says whether a role may open a module at all; it has no per-row layer, so
// WHOSE rows a viewer gets is decided here and applied in the service before anything is returned —
// never in a component. The owner's answers of 2026-11-10:
//   * Product Managers ONLY fill both sheets (Dr. Rasha wrote to Dr. Ahmed; she reviews, she does not
//     keep a sheet of her own here).
//   * Dr. Rasha (Group Product Manager) reads and reviews; the Marketing Manager and the CEO read;
//     the Super Admin sees everything.
//   * The rep's own line National Sales Manager reads the FIELD FEEDBACK on his reps — never the
//     monthly sheet. The rep himself never sees either.

import type { AccessContext, PhoenixRole } from "@/lib/auth/permissions";
import { canonicalHrIdKey } from "@/lib/hr-id";

import type { MarketingMonthStatus } from "./vocabulary";

type Viewer = Pick<AccessContext, "role" | "hrId">;

/** The one role that writes both sheets. */
export const MARKETING_FUNCTIONS_AUTHOR_ROLES: readonly PhoenixRole[] = ["Product Manager"] as const;

/** Read every Product Manager's sheets and forms. */
export const MARKETING_FUNCTIONS_SEE_ALL_ROLES: readonly PhoenixRole[] = [
  "Super Admin",
  "CEO",
  "Marketing Manager",
  "Group Product Manager",
] as const;

/** Stamp a submitted month Reviewed, or reopen one. The Marketing Manager covers a sheet with no
 * Group Product Manager above it (a Product Manager reporting to him directly). */
export const MARKETING_FUNCTIONS_REVIEWER_ROLES: readonly PhoenixRole[] = [
  "Group Product Manager",
  "Marketing Manager",
  "Super Admin",
] as const;

/** Read the field feedback only on the reps under them. */
export const FIELD_FEEDBACK_LINE_READER_ROLES: readonly PhoenixRole[] = ["National Sales Manager"] as const;

/** Who is offered the Monthly Marketing Functions page at all (UX; the routes re-check). */
export const MARKETING_FUNCTIONS_PORTAL_ROLES: readonly PhoenixRole[] = [
  ...MARKETING_FUNCTIONS_AUTHOR_ROLES,
  "Group Product Manager",
  "Marketing Manager",
] as const;

/** Who is offered the Field Visit Feedback pages at all (UX; the routes re-check). */
export const FIELD_FEEDBACK_PORTAL_ROLES: readonly PhoenixRole[] = [
  ...MARKETING_FUNCTIONS_PORTAL_ROLES,
  ...FIELD_FEEDBACK_LINE_READER_ROLES,
] as const;

export function isMarketingFunctionsAuthor(viewer: Viewer): boolean {
  return MARKETING_FUNCTIONS_AUTHOR_ROLES.includes(viewer.role) && Boolean(viewer.hrId?.trim());
}

export function seesEveryMarketingSheet(viewer: Pick<AccessContext, "role">): boolean {
  return MARKETING_FUNCTIONS_SEE_ALL_ROLES.includes(viewer.role);
}

export function canReviewMarketingMonths(viewer: Pick<AccessContext, "role">): boolean {
  return MARKETING_FUNCTIONS_REVIEWER_ROLES.includes(viewer.role);
}

export function isSamePerson(left: string | null | undefined, right: string | null | undefined): boolean {
  const a = canonicalHrIdKey(left);
  return Boolean(a) && a === canonicalHrIdKey(right);
}

/**
 * Whose monthly sheet this viewer may open. A Product Manager: his own, whatever author a link names.
 * A see-all role: any author. Everyone else: none — the National Sales Manager included.
 */
export function resolveMonthAuthor(viewer: Viewer, requestedAuthorHrId: string | null | undefined): string | null {
  if (isMarketingFunctionsAuthor(viewer)) return viewer.hrId!.trim();
  if (seesEveryMarketingSheet(viewer)) {
    const requested = requestedAuthorHrId?.trim();
    return requested ? requested : null;
  }
  return null;
}

/** Only the author edits, and only a draft. A submitted sheet waits; a reviewed one is the record. */
export function canEditMonth(viewer: Viewer, input: { authorHrId: string; status: MarketingMonthStatus | null }): boolean {
  if (!isMarketingFunctionsAuthor(viewer) || !isSamePerson(viewer.hrId, input.authorHrId)) return false;
  return input.status === null || input.status === "draft";
}

export function canSubmitMonth(
  viewer: Viewer,
  input: { authorHrId: string; status: MarketingMonthStatus | null; itemCount: number },
): boolean {
  return canEditMonth(viewer, input) && input.status === "draft" && input.itemCount > 0;
}

/** A reviewer never reviews a sheet of their own. */
export function canStampMonth(viewer: Viewer, input: { authorHrId: string; status: MarketingMonthStatus | null }): boolean {
  return canReviewMarketingMonths(viewer) && input.status === "submitted" && !isSamePerson(viewer.hrId, input.authorHrId);
}

/** Reopening hands a submitted or reviewed sheet back to its author as a draft. */
export function canReopenMonth(viewer: Viewer, input: { authorHrId: string; status: MarketingMonthStatus | null }): boolean {
  return (
    canReviewMarketingMonths(viewer) &&
    (input.status === "submitted" || input.status === "reviewed") &&
    !isSamePerson(viewer.hrId, input.authorHrId)
  );
}

export type FieldFeedbackVisibility =
  | { kind: "all" }
  | { kind: "author"; hrId: string }
  | { kind: "reps"; repKeys: ReadonlySet<string> }
  | { kind: "none" };

/**
 * Which field-feedback forms this viewer may list. `lineRepKeys` is the National Sales Manager's own
 * reps (canonical HR id keys), resolved by the caller from the downward scope; it is ignored for
 * every other role.
 */
export function resolveFieldFeedbackVisibility(
  viewer: Viewer,
  lineRepKeys: ReadonlySet<string> | null = null,
): FieldFeedbackVisibility {
  if (seesEveryMarketingSheet(viewer)) return { kind: "all" };
  if (isMarketingFunctionsAuthor(viewer)) return { kind: "author", hrId: viewer.hrId!.trim() };
  if (FIELD_FEEDBACK_LINE_READER_ROLES.includes(viewer.role) && viewer.hrId?.trim()) {
    return { kind: "reps", repKeys: lineRepKeys ?? new Set<string>() };
  }
  return { kind: "none" };
}

export function canViewFieldFeedback(
  visibility: FieldFeedbackVisibility,
  form: { authorHrId: string; repHrId: string; signedAt: string | null },
): boolean {
  if (visibility.kind === "author") return isSamePerson(visibility.hrId, form.authorHrId);
  // Every reader sees a form once it is signed — a draft is still the Product Manager's own notes.
  if (visibility.kind === "all") return Boolean(form.signedAt);
  if (visibility.kind === "reps") {
    const key = canonicalHrIdKey(form.repHrId);
    return Boolean(form.signedAt) && Boolean(key) && visibility.repKeys.has(key!);
  }
  return false;
}

/** Only the author edits a form, and only before he signs it. */
export function canEditFieldFeedback(viewer: Viewer, form: { authorHrId: string; signedAt: string | null } | null): boolean {
  if (!isMarketingFunctionsAuthor(viewer)) return false;
  if (!form) return true;
  return !form.signedAt && isSamePerson(viewer.hrId, form.authorHrId);
}
