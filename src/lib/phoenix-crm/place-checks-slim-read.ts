/**
 * Place checks — what its two big reads ask the database for, and how the answer is put back together.
 *
 * Pure (no server import), so `tests/phoenix-crm-place-checks-speed.test.ts` checks every rule here
 * without a request. The reads themselves are in `server/validation-reviews.ts`.
 */

type Row = Record<string, unknown>;

/**
 * The keys of a place's `signboard_check` that Place checks reads — and the only ones it downloads.
 *
 * 🔴 THE SIGNBOARD COLUMN IS READ BY THE KEYS THE BOARD SHOWS, NEVER WHOLE (owner, 16 Nov 2026: "fix the
 * place checks slowness"). The column keeps every sign the reader saw and the reader's note: 7.7 MB of
 * the 18 MB the 6,558 places in use weigh (measured 16 Nov 2026), and the board reads six small keys of
 * it — `signboardOf` (verdict, problem, reason, signText, retake) and `signboardHoldStillReading`
 * (attempts). So the database picks those keys out, one aliased column each (`signboard_check->key`),
 * and `signboardCheckRead` puts them back into the object both readers take. A key either reader starts
 * reading must be added HERE, or it reads as absent — the test holds this list against the readers.
 */
export const SIGNBOARD_KEYS_THE_BOARD_READS = ["verdict", "problem", "reason", "signText", "retake", "attempts"] as const;

const SIGNBOARD_KEY_ALIAS = "sb_";

/** The select fragment for a `phoenix_crm_places` read: the keys above, in place of the whole column. */
export const SIGNBOARD_CHECK_KEYS_SELECT = SIGNBOARD_KEYS_THE_BOARD_READS.map((key) => `${SIGNBOARD_KEY_ALIAS}${key}:signboard_check->${key}`).join(", ");

/**
 * The `signboard_check` a row read with `SIGNBOARD_CHECK_KEYS_SELECT` carried: the keys it had, or null
 * when it had none. A stored check always has a `verdict` (`PhoenixCrmSignboardCheck`), so "none" is a
 * place never read — what the whole column's null said.
 */
export function signboardCheckRead(row: Row): Row | null {
  const check: Row = {};
  for (const key of SIGNBOARD_KEYS_THE_BOARD_READS) {
    const value = row[`${SIGNBOARD_KEY_ALIAS}${key}`];
    if (value !== null && value !== undefined) check[key] = value;
  }
  return Object.keys(check).length > 0 ? check : null;
}

/**
 * The customer and the place each review is about, read IN the review's own request.
 *
 * 🔴 ONE REQUEST PER PAGE, NOT THIRTY MORE (owner, 16 Nov 2026: "fix the place checks slowness"). The
 * customers and the places of every decision were read afterwards by id, 150 ids a request — 2,080
 * reviews made about 30 requests after the pages, four at a time. Both columns are foreign keys
 * (`phoenix_crm_validation_reviews_customer_id_fkey`, `…_place_id_fkey`), so PostgREST joins them into
 * each row; the constraint is NAMED so a second key to either table one day cannot make it ambiguous.
 * The place carries the signboard by its keys, as above, and who created it — the Super Admin's
 * approval lock (`approvalLockFor`) reads that.
 */
export const REVIEW_SUBJECTS_SELECT =
  "customer:phoenix_crm_customers!phoenix_crm_validation_reviews_customer_id_fkey(id, name, list_type, speciality, customer_type), " +
  "place:phoenix_crm_places!phoenix_crm_validation_reviews_place_id_fkey(id, label, address, brick_name, area_name, lat, lon, pin_lat, pin_lon, pin_accuracy_meters, photo_lat, photo_lon, photo_accuracy_meters, photo_path, status, shared_place_id, created_by_hr_id, " +
  `${SIGNBOARD_CHECK_KEYS_SELECT})`;

/**
 * The same joins, with the place joined `!inner`, for the read that asks for the decisions of the customers
 * seated in a building (`loadValidationReviews`, `seatedDecisionsOnly`; 23 Nov 2026). A filter on
 * a joined table drops the review only when the join is inner; without it the review comes back with an
 * empty place. Every review has a place (`place_id` is not null), so the inner join drops nothing else.
 */
export const REVIEW_SUBJECTS_SEATED_SELECT = REVIEW_SUBJECTS_SELECT.replace("_place_id_fkey(", "_place_id_fkey!inner(");

/**
 * Whether the seated-decisions read keeps a review row as the database sent it: every waiting review, and
 * a decision whose place sits in a building.
 *
 * 🔴 SEATED IS THE RULE; THE DATABASE'S NARROWING ONLY SAVES THE DOWNLOAD. The read puts every row it got
 * through this, so a request that came back wider answers the same rows.
 */
export function keptBySeatedDecisionsRead(row: { status?: unknown; place?: unknown }): boolean {
  if (row.status === "pending") return true;
  const place = row.place;
  if (typeof place !== "object" || place === null || Array.isArray(place)) return false;
  const building = (place as { shared_place_id?: unknown }).shared_place_id;
  return typeof building === "string" && building.trim() !== "";
}

/**
 * The customer's status, joined into the places-in-use read so a dropped customer's place can be left out
 * in the same request (owner, 17 Nov 2026: 77 such places counted as "Validated, in use"). `!inner` makes
 * the filter on `customer.status` drop the place rather than blank the field; the key is NAMED, as above.
 */
export const PLACE_CUSTOMER_STATUS_JOIN = "customer:phoenix_crm_customers!phoenix_crm_places_customer_id_fkey!inner(status)";
