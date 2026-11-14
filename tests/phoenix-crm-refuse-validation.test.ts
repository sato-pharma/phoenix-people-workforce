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
 *   1. the service checks WHO first, demands the reason the rep is told, refuses a place that is not
 *      active, goes through the shared RPC, and measures the customer's visits again;
 *   2. the route is the Super Admin's, behind the same permission and CSRF gates as the queue;
 *   3. the page offers the list, and the screen asks for the reason before the button arms;
 *   4. nothing in what the rep reads names a person.
 *
 * Two owner changes of 2026-10-15 are pinned here too ("make admin able to reject validation even if
 * approved before and admin comment is optional"): the free-text note is optional on every path on
 * this page, and an APPROVED review can be rejected on its own row — through the same decision the
 * pending row makes, so the review keeps the evidence the system held it on.
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
  assert.ok(gate < firstRead, "and it asks BEFORE it reads — the deciders alone, as the queue beside it");
  assert.match(refuse, /throw forbiddenError\("Only the Super Admin and the SFE Manager decide these\."\)/, "with the queue's own refusal");

  // A hand refusal carries no Google evidence, so the one sentence the REP is told is the record.
  assert.match(refuse, /if \(!refusalReason\) throw validationError\(VALIDATION_REASON_REQUIRED\)/, "a refusal with no chosen reason is refused");
  assert.match(refuse, /cleanText\(body\.note, 500\)/, "the note is trimmed to the column's 500 characters");
  // 🔴 AND THE NOTE IS OPTIONAL (owner, 2026-10-15: "admin comment is optional"). It was required,
  // and 22 of the module's first 24 refusals answered with the single character `-`.
  assert.doesNotMatch(refuse, /if \(!note\) throw/, "and the free-text note is NOT required — only the reason is");

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
  // 🔴 THE LIVE BODY IS THE ONE 20261110214512 INSTALLED (the Super Admin's corrected name, 2026-11-10),
  // which restated 20261015212903's (the note made optional) whole. Reading an older file would pin a
  // body the database no longer has.
  const migration = readFileSync(
    new URL("supabase/migrations/20261110214512_phoenix_crm_restore_validation_corrected_name.sql", ROOT),
    "utf8",
  ).replace(/\r\n/g, "\n");
  const fn = /create or replace function public\.phoenix_crm_restore_validation\(p jsonb\)([\s\S]*?)\n\$\$;/.exec(migration);
  assert.ok(fn, "phoenix_crm_restore_validation is restated whole by the migration that changed it");

  assert.match(fn[1], /if v_review\.status <> 'rejected' then\n\s*raise exception 'phoenix_crm:review_not_rejected';/, "only a REJECTED review can be taken back");
  assert.match(fn[1], /if v_place\.status <> 'retired' then\n\s*raise exception 'phoenix_crm:place_not_retired';/, "a place that is not retired any more is left alone");
  // The note is OPTIONAL since 2026-10-15 (owner: "admin comment is optional") — it is still length-
  // capped, and who reversed it and when are on the row either way.
  assert.doesNotMatch(fn[1], /v_note is null or/, "a reversal with no written reason is accepted");
  assert.match(fn[1], /\(v_note is not null and char_length\(v_note\) > 500\)/, "and a note that is written is still capped at the column's 500 characters");

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

  assert.ok(restore.indexOf("canRestoreValidation(viewer)") < restore.indexOf("callPhoenixCrm"), "restoreValidation asks who before it calls anything");
  // 🔴 THE SUPER ADMIN ALONE, AND NEVER BLOCKED (owner, 2026-11-10). The SFE Manager's gate is not the
  // one asked, and the short-name refusal every shared approve path makes is not made here.
  assert.doesNotMatch(restore, /canDecideValidationReviews\(viewer\)/, "the SFE Manager does not take a rejection back");
  assert.doesNotMatch(restore, /refuseApprovalOfShortName/, "a short name never blocks the Super Admin's take-back");
  assert.doesNotMatch(restore, /if \(!note\) throw/, "the reversal's note is optional here too (owner, 2026-10-15)");
  assert.match(restore, /cleanText\(body\.note, 500\)/, "and is still trimmed to the column's 500 characters");
  assert.match(restore, /callPhoenixCrm<Row>\("phoenix_crm_restore_validation"/, "it goes through the database function, which owns the rules");
  const restamp = restore.indexOf("restampVisitLocationsQuietly");
  assert.ok(restamp > restore.indexOf("callPhoenixCrm"), "and measures the customer's visits again AFTER the place is back");
  assert.match(restore, /scope: "all"/, "every visit of his, so the distances the rejection removed come back");

  // Only the latest rejection is offered, and only while the place is still retired.
  const load = functionBody(service, "loadValidationReviews");
  assert.match(load, /restorable: status === "rejected" && place\.status === "retired"/, "the row says whether its rejection can still be taken back — the same test the database makes");
  assert.match(load, /refusable: status === "approved" && place\.status === "active"/, "and whether its APPROVAL can still be taken back — the mirror of it (owner, 2026-10-15)");

  const db = read("src/lib/phoenix-crm/server/db.ts");
  for (const code of ["review_not_rejected", "place_not_retired"]) {
    assert.ok(db.includes(`${code}:`), `${code} is worded for the person who pressed the button, not left as a raw code`);
  }
}

function checkRestoreScreen(): void {
  const queue = read("src/components/phoenix-crm/validation-review-queue.tsx");
  // The control itself lives in place-check-restore.tsx since 2026-11-10, shared with a seated customer's
  // card, so the take-back is one control for the Super Admin alone wherever it is drawn.
  const control = read("src/components/phoenix-crm/place-check-restore.tsx");
  assert.match(queue, /<RestoreAfterRejection/, "the rejected row draws the one take-back control");
  assert.match(control, /"\/api\/phoenix-crm\/validation-reviews\/restore"/, "which posts to the restore route");
  assert.match(control, /return nameParts \? \{ reviewId, note, nameParts \} : \{ reviewId, note \};/, "with the review, the written reason, and the corrected names only when he edited them");
  // `scope` is the one-by-one review's (2026-10-18): it tells the control which slide it decides.
  assert.match(queue, /\{row\.restorable \? <Restore row=\{row\}(?: scope=\{scope\})? \/> : null\}/, "and the option appears only where the server says it still can");
  assert.doesNotMatch(queue, /disabled=\{saving \|\| note\.trim\(\)\.length === 0\}/, "the button no longer waits for a written note (owner, 2026-10-15)");
  assert.match(control, /Approve it after all/, "worded as what it does");
}

/**
 * Rejecting a place this page APPROVED before (owner, 2026-10-15: "make admin able to reject
 * validation even if approved before").
 *
 * 🔴 THE DATABASE IS THE AUTHORITY ON WHAT MAY BE RE-DECIDED, so its guard is pinned first: the one
 * widening is a REJECT on an APPROVED review. Approving an approved one, and anything at all on a
 * rejected one, must still raise `review_decided` — the second of those is what stops this control
 * colliding with `phoenix_crm_restore_validation`, which has its own rules about the retired place.
 */
function checkRejectAfterApproval(): void {
  const migration = readFileSync(
    new URL("supabase/migrations/20261015212903_phoenix_crm_reject_after_approve_and_optional_note.sql", ROOT),
    "utf8",
  ).replace(/\r\n/g, "\n");
  const fn = /create or replace function public\.phoenix_crm_decide_validation_review\(p jsonb\)([\s\S]*?)\n\$function\$;/.exec(migration);
  assert.ok(fn, "phoenix_crm_decide_validation_review is restated whole by the migration that changed it");

  assert.match(
    fn[1],
    /if not \(v_review\.status = 'approved' and v_decision = 'reject'\) and v_review\.status <> 'pending' then\n\s*raise exception 'phoenix_crm:review_decided';/,
    "a reject of an approved review is let through, and every other re-decision still raises review_decided",
  );
  // The reject branch is what runs, unchanged: the place is retired, the customer goes back to To
  // validate when it was his only one, and reopened_at is stamped.
  assert.match(fn[1], /set status = 'rejected', decided_by_hr_id = v_actor, decided_at = now\(\), decision_note = v_note,/, "it writes the rejection on the same row");
  assert.match(fn[1], /set reopened_at = now\(\), updated_at = now\(\)/, "and stamps the wait, as a held place's rejection does");

  const grants = migration.slice(fn.index + fn[0].length);
  assert.match(
    grants,
    /revoke execute on function public\.phoenix_crm_decide_validation_review\(jsonb\) from public, anon, authenticated;/,
    "execute is revoked from PUBLIC, which is what anon and authenticated inherit it through",
  );
  assert.match(
    grants,
    /grant execute on function public\.phoenix_crm_decide_validation_review\(jsonb\) to service_role;/,
    "and re-granted to the service role alone",
  );

  // The screen: the SAME route and the SAME decision the pending row posts, so there is one reject
  // path — and the review row keeps the evidence the system held it on.
  const queue = read("src/components/phoenix-crm/validation-review-queue.tsx");
  assert.match(queue, /\{row\.refusable \? <RejectAfterApproval row=\{row\}(?: scope=\{scope\})? \/> : null\}/, "the approved row offers it, only where the server says it still can");
  assert.match(
    queue,
    /\{ reviewId: row\.reviewId, decision: "reject", note, refusalReason: reason \}/,
    "with the review, the chosen reason and the optional note",
  );
  assert.match(queue, /Reject it after all/, "worded as what it does");
  assert.match(queue, /disabled=\{saving \|\| reason === ""\}/, "and it cannot be pressed before the reason the rep is told is chosen");
}

/**
 * Answering several rows at once (owner, 2026-10-15: "also make me able to multiple select and
 * response").
 *
 * 🔴 THE WHOLE POINT IS THAT IT IS NOT A SECOND DECISION PATH. The bar runs each section's OWN row
 * request, once per picked row, with one reason and one note typed for all of them — so the rep reads
 * exactly what a one-row refusal tells him, the audit rows are the same rows, and no route, RPC or
 * wording is added anywhere. These assertions pin that, the selection's own safety (what is ticked is
 * intersected with what is on screen), and that a district manager's board draws none of it.
 */
function checkBulkDecide(): void {
  const bulk = read("src/components/phoenix-crm/place-check-bulk.tsx");

  // No route of its own, and no decision of its own: each action is handed in by the screen.
  assert.doesNotMatch(bulk, /\/api\//, "the bulk bar names no route — each action is the screen's own request");
  assert.match(bulk, /run: \(row: Row, answer: BulkAnswer\) => Promise<unknown>/, "an action IS the one row request the page already makes — `crmPost` hands back a value");
  assert.match(bulk, /outcomeOf: \(answer: unknown, row: Row\) => PlaceCheckOutcome;/, "and the action says what that value means, in the row control's own words (14 Nov 2026)");

  // One answer, N times, in order.
  assert.match(bulk, /for \(const row of targets\) \{[\s\S]*?landed\.push\(action\.outcomeOf\(await action\.run\(row, \{ note, reason \}\), row\)\);/, "it runs them one at a time, each with the reason and note typed once, and keeps what each did");
  assert.match(bulk, /const targets = picked\.filter\(action\.takes\)/, "and only on the picked rows that action can answer");

  // 🔴 A ROW THAT FALLS OUT OF THE LIST FALLS OUT OF THE SELECTION — ids in state, rows the authority.
  assert.match(bulk, /ticked\.map\(\(id\) => onScreen\.get\(id\)\)\.filter\(\(row\): row is Row => row !== undefined\)/, "what is ticked is intersected with what is on screen at every render");
  assert.match(bulk, /if \(picks\.selectable === 0\) return null;/, "and a section with nothing to pick draws no bar at all");

  // A destructive action says what it costs and arms before it runs; the count is in the button.
  assert.match(bulk, /if \(action\.warning && armed !== action\.key\) \{[\s\S]*?setArmed\(action\.key\);[\s\S]*?return;/, "a warning action is armed by the first press and runs on the second");
  assert.match(bulk, /\$\{action\.label\} \(\$\{targets\.length\}\)/, "each button carries the number it will answer");
  assert.match(bulk, /const held = action\.needsReason && reason === ""/, "a refusal is held until the reason the rep is told is chosen");
  assert.doesNotMatch(bulk, /note\.trim\(\)\.length === 0/, "and never on the free-text note, which is optional everywhere on this page");

  // What failed is named by the customer, not by an id — and the page is re-read either way.
  assert.match(bulk, /failed\.push\(\{ name: nameOf\(row\), problem: messageOf\(error\) \}\)/, "a row that would not answer is named by the person it is about");
  assert.match(bulk, /router\.refresh\(\)/, "and the board is re-read when the run ends");

  // Fits the screen, like every other control in the module.
  assert.doesNotMatch(bulk, /overflow-x-auto|min-w-\[/, "never a horizontal scroller");
  assert.doesNotMatch(bulk, /rounded-(?!none)/, "square corners only");

  // ── The three sections that wire it, each to its own request ───────────────────────────────────
  const queue = read("src/components/phoenix-crm/validation-review-queue.tsx");
  assert.match(queue, /section: "waiting" \| "decided"/, "the queue is told which set it is drawing");
  assert.match(queue, /actions=\{section === "waiting" \? WAITING_ACTIONS : decidedActions\}/, "and that decides what a bulk answer can be");
  // The decided set loses its take-back for anybody but the Super Admin (owner, 2026-11-10: "the SFE cannot").
  assert.match(queue, /const decidedActions = canRestore \? DECIDED_ACTIONS : DECIDED_ACTIONS\.filter/, "and only the Super Admin is offered the bulk take-back");
  assert.match(queue, /takes: \(row\) => row\.status === "pending"/, "the waiting actions reach pending rows");
  assert.match(queue, /takes: \(row\) => row\.refusable/, "a bulk reject-after-all reaches only the approvals the server says can still be taken back");
  assert.match(queue, /takes: \(row\) => row\.restorable/, "and a bulk approve-after-all only the rejections it says can");
  // 🔴 THE PICK-LIST FOLLOWS THE PHOTOGRAPHS: a timetable refusal is never offered `photo_of_paper`.
  assert.match(queue, /picks\.picked\.every\(\(row\) => row\.photoKind === "schedule"\) \? "schedule" : "signboard"/, "the reasons offered follow what the picked photographs are");

  const board = read("src/components/phoenix-crm/validation-reviews-board.tsx");
  for (const prop of ['section="waiting"', 'section="decided"']) {
    assert.ok(board.includes(prop), `the board names its sets: ${prop}`);
  }

  const list = read("src/components/phoenix-crm/validated-place-list.tsx");
  assert.match(list, /actions=\{IN_USE_ACTIONS\}/, "the validated list approves and refuses in bulk through its own two routes");
  assert.match(list, /crmPost<unknown>\("\/api\/phoenix-crm\/validation-reviews\/refuse", \{ placeId: row\.placeId, note: answer\.note, refusalReason: answer\.reason \}/, "with exactly the body one row posts");
  // 🔴 THE PAGE IS WHAT CAN BE PICKED — "Pick all" must never reach rows behind a Show more.
  assert.match(list, /useRowPicks<ValidatedPlaceRow>\(bulk \? shown : \[\]/, "and only the rows actually on screen can be ticked");

  const venues = read("src/components/phoenix-crm/shared-place-list.tsx");
  assert.match(venues, /actions=\{venueActions\}/, "the polyclinics decide in bulk too");
  assert.match(venues, /const venueActions = canRestore \? VENUE_ACTIONS : VENUE_ACTIONS\.filter/, "and only the Super Admin brings a building back in bulk");
  assert.match(venues, /\{ sharedPlaceId: row\.sharedPlaceId, decision: "reject", note: answer\.note, refusalReason: answer\.reason \}/, "through the venue's own decision route, body for body");

  // 🔴 AND IT IS THE SUPER ADMIN'S ALONE — a district manager's board decides nothing (owner, 2026-10-13).
  for (const [file, source] of [
    ["validation-review-queue.tsx", queue],
    ["validated-place-list.tsx", list],
    ["shared-place-list.tsx", venues],
  ] as const) {
    assert.match(source, /const bulk = mode === "company";/, `${file}: the bar is drawn only on the Super Admin's own board`);
    assert.match(source, /bulk \?/, `${file}: and every pick box is behind that same test`);
  }
}

function checkRoute(): void {
  const route = read("app/api/phoenix-crm/validation-reviews/refuse/route.ts");
  assert.match(route, /assertSameOriginMutation\(request\)/, "the refusal route checks the origin");
  assert.match(route, /assertPermission\(access, "phoenix_crm", "approve"\)/, "and the module's approve right — both deciders hold it, and the SFE Manager holds no update");
  assert.match(route, /refuseValidatedPlace\(viewer, await request\.json\(\)\)/, "before the service decides who may actually press it");
  assert.match(route, /export const runtime = "nodejs"/, "it runs on node, like every CRM route");

  const restore = read("app/api/phoenix-crm/validation-reviews/restore/route.ts");
  assert.match(restore, /assertSameOriginMutation\(request\)/, "the restore route checks the origin too");
  assert.match(restore, /assertPermission\(access, "phoenix_crm", "approve"\)/, "and the same module right");
  assert.match(restore, /restoreValidation\(viewer, await request\.json\(\)\)/, "before the service decides who may press it");

  const registry = read("src/lib/security/access-registry.ts");
  for (const pattern of ["/api/phoenix-crm/validation-reviews/refuse", "/api/phoenix-crm/validation-reviews/restore"]) {
    assert.ok(registry.includes(`pattern: "${pattern}"`), `${pattern} is declared in the access registry`);
  }
}

function checkScreens(): void {
  const page = read("app/(admin)/admin/field-crm/validation-reviews/page.tsx");
  assert.match(page, /canDecideValidationReviews\(viewer\)\) redirect\("\/admin"\)/, "the page stays the deciders' alone — the Super Admin and the SFE Manager");
  assert.match(page, /loadValidatedPlaces\(viewer\)/, "and now also loads the validations the system did not question");
  // The prop names rather than one literal line: the sixth set (the polyclinics, 2026-10-09) made the
  // call multi-line, and a single-line fingerprint would go red on formatting alone.
  // Since 2026-11-14 the page hands the recent decisions and the seated places in use, and the board reads
  // the rest on the click (`place-checks-on-demand.ts`) — so those two props are the narrower sets.
  for (const prop of ["pending={waiting}", "decided={recentDecided}", "validated={seatedInUse}", "onDemand={onDemand}", "reopened={reopened}", "capped={capped}"]) {
    assert.ok(page.includes(prop), `the Place checks board is handed ${prop}`);
  }
  // Since 2026-10-18 the page draws the board through the one-by-one review's wrapper, which hands
  // every prop on to it unchanged — so the wrapper is pinned to draw the company board.
  assert.ok(page.includes("<ValidationReviewsBoard") || page.includes("<PlaceChecksWithDeck"), "the board is what the page draws");
  if (page.includes("<PlaceChecksWithDeck")) {
    const wrapper = read("src/components/place-review-deck/place-checks-with-deck.tsx");
    assert.match(wrapper, /<ValidationReviewsBoard \{\.\.\.board\} mode="company"/, "the wrapper draws the company board with every prop it was handed");
  }

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
  // The REASON gates the button; the note is optional since 2026-10-15 ("admin comment is optional").
  assert.match(list, /disabled=\{reason === ""\}/, "and cannot be armed before the reason the rep is told is chosen");
  assert.doesNotMatch(list, /note\.trim\(\)\.length === 0/, "never gated on the free-text note");
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
  // The comment reaches the rep and their manager since 2026-11-01, and its label says so; the rep still
  // reads a role and never a name (`placeNoteRepAuthorText`).
  assert.match(list, /\{VALIDATION_NOTE_LABEL\}/, "the comment box says who reads it");
  const feedback = read("src/lib/phoenix-crm/validation-feedback.ts");
  assert.match(feedback, /VALIDATION_NOTE_LABEL = "Comment — optional \(the rep and their manager read it\)"/);

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
  checkRejectAfterApproval();
  checkBulkDecide();
  checkRoute();
  checkScreens();
  checkTheRepReadsNothingAboutAPerson();
}
