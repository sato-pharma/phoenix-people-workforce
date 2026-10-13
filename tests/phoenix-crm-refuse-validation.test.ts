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
  // 🔴 place_id is UNIQUE on that table, so a place held once already HAS a row: a plain insert
  // raises 23505 the first time an AM place the check approved is refused here.
  assert.match(refuse, /\.upsert\(/, "the row is upserted, never plainly inserted");
  assert.match(refuse, /\{ onConflict: "place_id" \}/, "on the unique column");
  assert.match(refuse, /decided_at: null/, "and the previous decision is cleared with it — the table's CHECK ties decided_at to the status");
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

/**
 * Approving after a rejection (owner, 2026-10-03: "add the option to approve after reject"). The
 * database is the authority on what may be reversed, so it is pinned first.
 */
function checkRestoreDatabase(): void {
  const migration = readFileSync(new URL("supabase/migrations/20261003184147_phoenix_crm_restore_validation.sql", ROOT), "utf8").replace(/\r\n/g, "\n");
  const fn = /create or replace function public\.phoenix_crm_restore_validation\(p jsonb\)([\s\S]*?)\n\$\$;/.exec(migration);
  assert.ok(fn, "phoenix_crm_restore_validation is in its own migration");

  assert.match(fn[1], /if v_review\.status <> 'rejected' then\n\s*raise exception 'phoenix_crm:review_not_rejected';/, "only a REJECTED review can be taken back");
  assert.match(fn[1], /if v_place\.status <> 'retired' then\n\s*raise exception 'phoenix_crm:place_not_retired';/, "a place that is not retired any more is left alone");
  assert.match(fn[1], /v_note is null/, "a reversal with no written reason is refused, like the refusal it undoes");

  assert.match(fn[1], /set status = 'active', retired_at = null, retired_by_hr_id = null/, "the place comes back");
  assert.match(fn[1], /validated_by_hr_id = v_review\.created_by_hr_id/, "and the customer is validated in the REP's own name, never the admin's");
  assert.match(fn[1], /'place_restored'/, "the restore is on the record as its own event");
  assert.match(fn[1], /'validation_review_approved'/, "beside the approval");

  // 🔴 ONE review row per place — `phoenix_crm_validation_reviews_place_idx` is UNIQUE on place_id.
  // The first draft INSERTED a second row and died on 23505 against real production data; it was
  // caught by running the function there inside a transaction that was rolled back on purpose, which
  // no source-pinned assertion could have seen. So the row is UPDATED, and what it said before is
  // carried in `google` rather than thrown away.
  assert.match(fn[1], /update public\.phoenix_crm_validation_reviews/, "the place's one review row is UPDATED to approved");
  assert.doesNotMatch(fn[1], /insert into public\.phoenix_crm_validation_reviews/, "never a second row — place_id is UNIQUE and a second insert raises 23505");
  assert.match(fn[1], /'restored', true/, "the row says it came back");
  assert.match(fn[1], /'rejected_by_hr_id', v_review\.decided_by_hr_id/, "and keeps who had rejected it");
  assert.match(fn[1], /'rejection_note', v_review\.decision_note/, "and why");

  const grants = migration.slice(fn.index + fn[0].length);
  assert.match(grants, /revoke execute on function public\.phoenix_crm_restore_validation\(jsonb\) from public, anon, authenticated;/, "execute is revoked from PUBLIC, which is what anon and authenticated inherit it through");
  assert.match(grants, /grant execute on function public\.phoenix_crm_restore_validation\(jsonb\) to service_role;/, "and re-granted to the service role alone");
  assert.match(fn[1], /security definer/i, "it runs as the owner, like every other module function");
}

function checkRestoreService(): void {
  const service = read("src/lib/phoenix-crm/server/validation-reviews.ts");
  const restore = functionBody(service, "restoreValidation");

  assert.ok(restore.indexOf("canDecideValidationReviews(viewer)") < restore.indexOf("callPhoenixCrm"), "restoreValidation asks who before it calls anything");
  assert.match(restore, /if \(!note\) throw validationError\(/, "a reversal needs its reason here too");
  assert.match(restore, /callPhoenixCrm<Row>\("phoenix_crm_restore_validation"/, "it goes through the database function, which owns the rules");
  const restamp = restore.indexOf("restampVisitLocationsQuietly");
  assert.ok(restamp > restore.indexOf("callPhoenixCrm"), "and measures the customer's visits again AFTER the place is back");
  assert.match(restore, /scope: "all"/, "every visit of his, so the distances the rejection removed come back");

  // Only the latest rejection is offered, and only while the place is still retired.
  const load = functionBody(service, "loadValidationReviews");
  assert.match(load, /restorable: status === "rejected" && place\.status === "retired"/, "the row says whether its rejection can still be taken back — the same test the database makes");

  const db = read("src/lib/phoenix-crm/server/db.ts");
  for (const code of ["review_not_rejected", "place_not_retired"]) {
    assert.ok(db.includes(`${code}:`), `${code} is worded for the person who pressed the button, not left as a raw code`);
  }
}

function checkRestoreScreen(): void {
  const queue = read("src/components/phoenix-crm/validation-review-queue.tsx");
  assert.match(queue, /"\/api\/phoenix-crm\/validation-reviews\/restore"/, "the rejected row posts to the restore route");
  assert.match(queue, /\{ reviewId: row\.reviewId, note \}/, "with the review and the written reason");
  assert.match(queue, /\{row\.restorable \? <Restore row=\{row\} \/> : null\}/, "and the option appears only where the server says it still can");
  assert.match(queue, /disabled=\{saving \|\| note\.trim\(\)\.length === 0\}/, "the button cannot be pressed before the reason is written");
  assert.match(queue, /Approve it after all/, "worded as what it does");
}

function checkRoute(): void {
  const route = read("app/api/phoenix-crm/validation-reviews/refuse/route.ts");
  assert.match(route, /assertSameOriginMutation\(request\)/, "the refusal route checks the origin");
  assert.match(route, /assertPermission\(access, "phoenix_crm", "update"\)/, "and the module's update right");
  assert.match(route, /refuseValidatedPlace\(viewer, await request\.json\(\)\)/, "before the service decides who may actually press it");
  assert.match(route, /export const runtime = "nodejs"/, "it runs on node, like every CRM route");

  const restore = read("app/api/phoenix-crm/validation-reviews/restore/route.ts");
  assert.match(restore, /assertSameOriginMutation\(request\)/, "the restore route checks the origin too");
  assert.match(restore, /assertPermission\(access, "phoenix_crm", "update"\)/, "and the same module right");
  assert.match(restore, /restoreValidation\(viewer, await request\.json\(\)\)/, "before the service decides who may press it");

  const registry = read("src/lib/security/access-registry.ts");
  for (const pattern of ["/api/phoenix-crm/validation-reviews/refuse", "/api/phoenix-crm/validation-reviews/restore"]) {
    assert.ok(registry.includes(`pattern: "${pattern}"`), `${pattern} is declared in the access registry`);
  }
}

function checkScreens(): void {
  const page = read("app/(admin)/admin/field-crm/validation-reviews/page.tsx");
  assert.match(page, /canDecideValidationReviews\(viewer\)\) redirect\("\/admin"\)/, "the page stays the Super Admin's alone");
  assert.match(page, /loadValidatedPlaces\(viewer\)/, "and now also loads the validations the system did not question");
  // The prop names rather than one literal line: the sixth set (the polyclinics, 2026-10-09) made the
  // call multi-line, and a single-line fingerprint would go red on formatting alone.
  for (const prop of ["pending={waiting}", "decided={decided}", "validated={validated}", "reopened={reopened}", "capped={capped}"]) {
    assert.ok(page.includes(prop), `the Place checks board is handed ${prop}`);
  }
  assert.ok(page.includes("<ValidationReviewsBoard"), "the board is what the page draws");

  const board = read("src/components/phoenix-crm/validation-reviews-board.tsx");
  // By PROP, not as one line — the same lesson the loop above was rewritten for. This assertion was
  // still a single-line fingerprint and went red on 2026-10-13 when the call gained `mode` and
  // `noteIndex` for the district manager's board, with nothing about the list wrong. What matters is
  // which data it is handed and that the BOARD owns the search, so those are what is pinned.
  const validatedCall = /<ValidatedPlaceList[\s\S]*?\/>/.exec(board);
  assert.ok(validatedCall, "the board draws the validated list under the filters");
  for (const prop of ["key={validatedKey}", "rows={filteredValidated}", "showSearch={false}"]) {
    assert.ok(validatedCall[0].includes(prop), `the validated list is handed ${prop} — the board owns the search`);
  }

  const list = read("src/components/phoenix-crm/validated-place-list.tsx");
  assert.match(list, /"\/api\/phoenix-crm\/validation-reviews\/refuse"/, "the button posts to the refusal route");
  // Since 2026-10-08 the refusal carries one of six closed reasons the rep is told, beside the note
  // kept for the record (owner: "tell the rep why, from a fixed pick-list, never naming a person").
  assert.match(list, /\{ placeId: row\.placeId, note, refusalReason: reason \}/, "with the place, the note and the chosen reason");
  assert.match(list, /disabled=\{reason === "" \|\| note\.trim\(\)\.length === 0\}/, "and cannot be armed before both are given");
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
  // The note is still the record's: its label says the rep reads only the chosen reason.
  assert.match(list, /\{VALIDATION_NOTE_LABEL\}/, "the note is labelled as the record's, not the rep's");
  const feedback = read("src/lib/phoenix-crm/validation-feedback.ts");
  assert.match(feedback, /VALIDATION_NOTE_LABEL = "Note for the record \(the rep reads only the reason above\)"/);

  // What the rep's own list says after a refusal is still the SYSTEM's sentence ("this place" since
  // 2026-10-08), with the chosen reason about his photo in place of it when there is one.
  const rules = read("src/lib/phoenix-crm/google-place-rules.ts");
  assert.match(rules, /LOCATION_NOT_CONFIRMED_TEXT =\s*\n?\s*"The system could not confirm this place\./, "the rep still reads the system's own wording");

  // He IS told now (owner, 2026-10-08) — through the one in-app notice worded about his photo, never
  // through a call here that could name who refused him.
  const service = read("src/lib/phoenix-crm/server/validation-reviews.ts");
  const refuse = functionBody(service, "refuseValidatedPlace");
  assert.match(refuse, /tellRepValidateAgain\(/, "the refusal tells the rep what is wrong with the photo");
  assert.doesNotMatch(refuse, /createSystemNotificationForRecipients/, "and never through a raw notification that bypasses the module's wording");
}

export function runPhoenixCrmRefuseValidationTests(): void {
  checkService();
  checkRestoreDatabase();
  checkRestoreService();
  checkRestoreScreen();
  checkRoute();
  checkScreens();
  checkTheRepReadsNothingAboutAPerson();
}
