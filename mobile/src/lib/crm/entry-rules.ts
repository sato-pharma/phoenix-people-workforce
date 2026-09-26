/**
 * Phoenix CRM — the size limits the entry screens hold text to, on the phone.
 *
 * The values the server enforces (src/lib/phoenix-crm/entry-rules.ts). They are transcribed here so the
 * phone caps a field at the same length the save does, and a rep is never allowed to type past what the
 * server will keep. `SPECIALITY_TEXT_MAX` lives in the web list-screens beside `parseNewCustomer`, and
 * the two decision notes in plan-rules.ts and unplanned-rules.ts; the rest are the module's own exports.
 *
 * 🔴 EVERY constant here is compared against its web twin by `tests/phoenix-crm-mobile-mirrors.test.ts`,
 * which resolves the twin BY NAME across the web module. A constant added here must therefore exist
 * there under the same name, and a value changed on either side goes red — rather than the phone
 * quietly capping a field at a length the server does not, which is how a rep loses what he typed.
 */

export const CUSTOMER_NAME_MAX = 120;
export const PLACE_TEXT_MAX = 200;
export const SPECIALITY_TEXT_MAX = 80;
export const VISIT_COMMENT_MAX = 1000;
export const VISIT_PRODUCTS_MAX = 12;
export const DROP_REASON_MAX = 500;
/** A manager returning a plan, or refusing an off-plan visit, writes the rep a note this long. */
export const PLAN_DECISION_NOTE_MAX = 500;
export const UNPLANNED_DECISION_NOTE_MAX = 500;
