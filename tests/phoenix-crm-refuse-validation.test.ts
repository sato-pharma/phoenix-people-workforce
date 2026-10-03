import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { stripComments } from "./support/comment-strip.ts";

/**
 * Phoenix CRM — the Super Admin can refuse a validation the Google check never held.
 *
 * Only AM customers are checked against their own Google Maps listing (`googleCheckApplies`), so a
 * DOCTOR's validation is never held, never reaches the reviews queue, and until 2026-10-03 could not
 * be taken back at all — one had to be undone in SQL.
 *
 * The refusal must not become a second reject path. It writes the SAME review row the automatic check
 * would have written and runs the SAME `phoenix_crm_decide_validation_review` reject, so there is one
 * audit shape and the rep keeps reading the system's own automated wording (golden rule #1: "do not
 * show the rep that a person is accepting or rejecting"). Every layer is pinned by source, because the
 * service reads the database and cannot be imported here:
 *
 *   1. the service checks WHO first, demands a written reason, refuses a place that is not active,
 *      goes through the shared RPC, and measures the customer's visits again;
 *   2. the route is the Super Admin's, behind the same permission and CSRF gates as the queue;
 *   3. the page offers the list, and the screen asks for the reason before the button arms;
 *   4. nothing in what the rep reads names a person.
 */

const ROOT = new URL("../", import.meta.url);

function read(path: string): string {
  return stripComments(readFileSync(new URL(path, ROOT), "utf8").replace(/\r\n/g, "\n"));
}

/** `export (async )?function name(...) { ... }` — the text from its signature to its closing brace at column 0. */
function functionBody(source: string, name: string): string {
  const match = new RegExp(`export (?:async )?function ${name}\\([\\s\\S]*?\\n\\}`).exec(source);
  assert.ok(match, `${name} is still declared as an exported function — this test resolves it by that name`);
  return match[0];
}

function checkService(): void {
  const service = read("src/lib/phoenix-crm/server/validation-reviews.ts");
  const refuse = functionBody(service, "refuseValidatedPlace");

  // WHO, before anything is read.
  const gate = refuse.indexOf("canDecideValidationReviews(viewer)");
  const firstRead = refuse.indexOf('.from("phoenix_crm_places")');
  assert.ok(gate > -1, "refuseValidatedPlace asks who is refusing");
  assert.ok(firstRead > -1, "refuseValidatedPlace reads the place");
  assert.ok(gate < firstRead, "and it asks BEFORE it reads — the Super Admin alone, as the queue beside it");
  assert.match(refuse, /throw forbiddenError\("Only the Super Admin decides these\."\)/, "with the queue's own refusal");

  // A hand refusal carries no Google evidence, so the reason is the record.
  assert.match(refuse, /if \(!note\) throw validationError\(/, "a refusal with no written reason is refused");
  assert.match(refuse, /cleanText\(body\.note, 500\)/, "the reason is trimmed to the column's 500 characters");

  // An already-retired place must not be refused twice.
  assert.match(refuse, /if \(place\.status !== "active"\)/, "a place that is already retired cannot be refused again");

  // ONE reject path: the review row the automatic check would have written, then the shared RPC.
  const inserted = refuse.indexOf('.from("phoenix_crm_validation_reviews")');
  const decided = refuse.indexOf('callPhoenixCrm<Row>("phoenix_crm_decide_validation_review"');
  assert.ok(inserted > -1, "it writes the review row the automatic check would have written");
  assert.ok(decided > inserted, "and only then runs the SAME reject the held reviews run");
  assert.match(refuse, /kind: "validation"/, "recorded as a validation review");
  assert.match(refuse, /status: "pending"/, "created pending, so the shared RPC is what decides it");
  assert.match(refuse, /reason: "refused_by_admin"/, "and says it was refused by hand, not by Google");
  assert.match(refuse, /created_by_hr_id: String\(place\.created_by_hr_id\)/, "in the REP's name, exactly as a held review is");
  assert.match(refuse, /decision: "reject"/, "the decision is a reject");

  // A retired place changes what every visit to that customer is measured against.
  const restamp = refuse.indexOf("restampVisitLocationsQuietly");
  assert.ok(restamp > decided, "the customer's visits are measured again AFTER the place is retired");
  assert.match(refuse, /scope: "all"/, "every visit of his, not only the unplaced ones");

  // The list the page offers.
  const load = functionBody(service, "loadValidatedPlaces");
  assert.ok(load.indexOf("canDecideValidationReviews(viewer)") < load.indexOf(".from("), "the list is the Super Admin's too, asked before it reads");
  assert.match(load, /\.eq\("status", "active"\)/, "it offers places still in use");
  assert.match(load, /held\.has\(String\(row\.id\)\)/, "and leaves out the ones already waiting in the queue above, so one place is never in two lists");
  assert.match(load, /visits: visitsByPlace\.get/, "each row says how many visits are measured against it");
  assert.match(load, /otherPlaces:/, "and whether the customer has another place, which decides if he goes back to To validate");
}

function checkRoute(): void {
  const route = read("app/api/phoenix-crm/validation-reviews/refuse/route.ts");
  assert.match(route, /assertSameOriginMutation\(request\)/, "the refusal route checks the origin");
  assert.match(route, /assertPermission\(access, "phoenix_crm", "update"\)/, "and the module's update right");
  assert.match(route, /refuseValidatedPlace\(viewer, await request\.json\(\)\)/, "before the service decides who may actually press it");
  assert.match(route, /export const runtime = "nodejs"/, "it runs on node, like every CRM route");
}

function checkScreens(): void {
  const page = read("app/(admin)/admin/field-crm/validation-reviews/page.tsx");
  assert.match(page, /canDecideValidationReviews\(viewer\)\) redirect\("\/admin"\)/, "the page stays the Super Admin's alone");
  assert.match(page, /loadValidatedPlaces\(viewer\)/, "and now also loads the validations the system did not question");
  assert.match(page, /<ValidatedPlaceList rows=\{validated\} \/>/, "which it draws under the queue");

  const list = read("src/components/phoenix-crm/validated-place-list.tsx");
  assert.match(list, /"\/api\/phoenix-crm\/validation-reviews\/refuse"/, "the button posts to the refusal route");
  assert.match(list, /\{ placeId: row\.placeId, note \}/, "with the place and the written reason");
  assert.match(list, /disabled=\{note\.trim\(\)\.length === 0\}/, "and cannot be armed before the reason is written");
  assert.match(list, /armed \?/, "a refusal is confirmed before it is sent — it retires a place and cannot be undone");

  // Fits the screen: the module's fixed table on desktop, the same rows as cards on a phone.
  assert.match(list, /<CrmTable columns=\{\[/, "desktop draws the module's table-fixed table with its colgroup");
  assert.match(list, /<CrmCardsOnPhone>/, "and a phone draws cards");
  assert.doesNotMatch(list, /overflow-x-auto|min-w-\[/, "never a horizontal scroller — the fits-the-screen golden rule");
  assert.doesNotMatch(list, /truncate|text-ellipsis|line-clamp/, "and never an ellipsis: wrapping wins");
  assert.doesNotMatch(list, /rounded-(?!none)/, "square corners only");
}

function checkTheRepReadsNothingAboutAPerson(): void {
  const list = read("src/components/phoenix-crm/validated-place-list.tsx");
  assert.match(list, /never shown to the rep/, "the note is marked as the record's, not the rep's");

  // What the rep's own list says after a refusal is the system's sentence, unchanged by this feature.
  const rules = read("src/lib/phoenix-crm/google-place-rules.ts");
  assert.match(rules, /LOCATION_NOT_CONFIRMED_TEXT =\s*\n?\s*"The system could not confirm this location\./, "the rep still reads the system's own wording");

  const service = read("src/lib/phoenix-crm/server/validation-reviews.ts");
  const refuse = functionBody(service, "refuseValidatedPlace");
  assert.doesNotMatch(refuse, /notifyPhoenixCrm|createSystemNotificationForRecipients/, "and is never notified that somebody refused him");
}

export function runPhoenixCrmRefuseValidationTests(): void {
  checkService();
  checkRoute();
  checkScreens();
  checkTheRepReadsNothingAboutAPerson();
}
