/**
 * Phoenix CRM — places the Google Maps check could not confirm, and the administrator's decision on each.
 *
 * Owner, 2026-10-03: an account Google has no listing for is "held for review and only system admin can
 * approve or reject … but do not show the rep that a person is accepting or rejecting — show him that
 * it's automated from system". Widened 2026-10-19 to the SFE Manager, and narrowed back on 19 Nov 2026:
 * the SFE Manager approved wrong validations, so he only RECOMMENDS, and his recommendations wait on the
 * SFE recommendations page (owner, 22 Nov 2026: "SFE is no more responsible for validations. He only
 * recommends."). So:
 *   · ONE decider, one predicate: the Super Admin (`canDecideValidationReviews`), never the SFE Manager,
 *     a test account or a district manager. The page lives under /admin, a tree a rep cannot open.
 *   · The rep reads only `locationCheck` on his own list ("checking" / "not_confirmed"), worded as the
 *     system's (google-place-rules.ts). Nothing he receives names who decided, or that anybody did.
 *
 * The writes are `phoenix_crm_validate_customer` / `phoenix_crm_add_place` (the hold) and
 * `phoenix_crm_decide_validation_review` (the decision) — migration 20261003130536.
 */

// Since the split of 23 Nov 2026 (no file of Place checks over 400 lines) every read and write below lives
// in a part under `server/validation-reviews/`; this path re-exports all of them, so no importer changed.
export { VALIDATION_REVIEWS_PATH, heldReviewNeedsFullName } from "@/lib/phoenix-crm/server/validation-reviews/shared";
export type { ValidationReviewRow, ValidationBoardRead, ValidatedPlaceRow } from "@/lib/phoenix-crm/server/validation-reviews/types";
export { type LocationCheckReading, loadLocationChecks, pendingLocationReview, pendingLocationReviewCustomers, countValidationReviewsWaiting } from "@/lib/phoenix-crm/server/validation-reviews/location-checks";
export { withdrawValidationReviewWaiting, notifyValidationReviewWaiting, validationNotConfirmedKeyPrefix, withdrawValidationNotConfirmed } from "@/lib/phoenix-crm/server/validation-reviews/notices";
export { loadValidationReviews, adviceOnWaitingReview } from "@/lib/phoenix-crm/server/validation-reviews/queue";
export { decideValidationReview, restoreValidation } from "@/lib/phoenix-crm/server/validation-reviews/decisions";
export { loadValidatedPlaces, scheduleOf, signboardOf } from "@/lib/phoenix-crm/server/validation-reviews/decided";
export { refuseValidatedPlace, approveValidatedPlace } from "@/lib/phoenix-crm/server/validation-reviews/place-in-use-decisions";
export { type ReopenedCustomerRow, sentBackRepName, loadReopenedCustomers, countReopenedCustomersWaiting, loadValidateAgainPhotoPaths } from "@/lib/phoenix-crm/server/validation-reviews/reopened";

/**
 * The decider, and the seat scope of a Place checks read — BOTH declared in `server/access.ts` and
 * re-exported here under the names every caller already imports. The reason they cannot live in this
 * file is written out where they are: one of the four section reads is the venue board in
 * `server/shared-places.ts`, which this file imports from, so declaring them here and importing them
 * there would close a cycle.
 */
export { canDecideValidationReviews, canRestoreValidation, placeChecksSeatScope, readsCompanyPlaceChecks, recommendsOnCompanyPlaceChecks } from "@/lib/phoenix-crm/server/access";
