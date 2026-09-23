/**
 * Phoenix CRM — the size limits the entry screens hold text to, on the phone.
 *
 * The values the server enforces (src/lib/phoenix-crm/entry-rules.ts). They are transcribed here so the
 * phone caps a field at the same length the save does, and a rep is never allowed to type past what the
 * server will keep. `SPECIALITY_TEXT_MAX` lives in the web list-screens beside `parseNewCustomer`; the
 * rest are the module's own exports.
 */

export const CUSTOMER_NAME_MAX = 120;
export const PLACE_TEXT_MAX = 200;
export const SPECIALITY_TEXT_MAX = 80;
export const VISIT_COMMENT_MAX = 1000;
export const VISIT_PRODUCTS_MAX = 12;
export const DROP_REASON_MAX = 500;
