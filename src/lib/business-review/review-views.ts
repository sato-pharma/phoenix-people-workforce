import type { ReviewLine } from "./canonical";

// The cross-line view switcher's option list, split out of service.ts into its own dependency-free
// module for the same reason official-lines.ts is: the Business Review dashboard is a CLIENT
// component and only needs REVIEW_VIEWS (plus the ReviewLine/ReviewView types, which are erased at
// compile time), but service.ts imports canonical.ts at the top for its real (server-only) review
// builder, and canonical.ts's own chains end at node:crypto two different ways (business-review/
// sources/marketing.ts -> marketing-requests/service.ts, and sales/monthly-distributor-import.ts ->
// access-scope.ts -> employee-directory.ts). The `ReviewLine` import above is `import type`, so it
// is erased entirely and carries none of that. Re-exported from service.ts unchanged so every
// existing server caller keeps importing from where it already does.

export const REVIEW_LINES: { id: ReviewLine; label: string }[] = [
  { id: "pedia", label: "Pedia" },
  { id: "cns", label: "CNS" },
  { id: "anti", label: "Anti-Infective" },
];

/** What the top switcher offers: the cross-line company rollup first (and default),
 * then each individual line. */
export type ReviewView = "company" | ReviewLine;
export const REVIEW_VIEWS: { id: ReviewView; label: string }[] = [
  { id: "company", label: "All Company" },
  ...REVIEW_LINES,
];
export const DEFAULT_REVIEW_VIEW: ReviewView = "company";
export function isReviewView(v: string | undefined): v is ReviewView {
  return !!v && REVIEW_VIEWS.some((x) => x.id === v);
}
