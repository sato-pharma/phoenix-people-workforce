import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { stripComments } from "./support/comment-strip.ts";
import { canonicalHrIdKey } from "../src/lib/hr-id.ts";
import { decideDirectOrderHold } from "../src/lib/direct-orders/hold-decision.ts";
import {
  LIST_STANDING_EVENTS,
  PLACE_STANDING_EVENTS,
  SUPER_ADMIN_APPROVAL_IS_FINAL_TEXT,
  actedBySuperAdmin,
  approvalLockedFor,
} from "../src/lib/phoenix-crm/super-admin-approval-rules.ts";

/**
 * Phoenix CRM — what the Super Admin approved, only the Super Admin rejects.
 *
 * Owner, 2026-11-16: "when super admin approve something sfe or whoever cannot reject it back bec its
 * approved by admin". On 2026-11-15 the SFE Manager refused three trusted-point validations the
 * administrator had made on one rep's list ("no signboard" — a trusted point has no photograph by design),
 * and the three doctors went back to To validate.
 *
 * Pinned at every layer:
 *   1. the rule itself, by behaviour (`approvalLockedFor`);
 *   2. the database — both decision functions refuse a non-Super-Admin reject, and the helper is closed
 *      to the browser roles;
 *   3. the refuse service asks BEFORE the upsert that wipes who approved the review;
 *   4. the refusal reaches the screen as a 403 with the plain sentence;
 *   5. every screen that drew a Reject or Refuse draws the sentence instead, and bulk reject skips it;
 *   6. (owner, 2026-11-20) every other way the SFE Manager could undo or contradict the Super Admin is
 *      refused before its write: moving or removing a place, dropping, moving or bringing back a customer,
 *      refusing a step he approved, returning a plan he approved, turning round his doctor-list answer;
 *   7. (owner, 2026-11-20, "Direct orders, marketing requests") the same in those two modules: a rung he
 *      approved, an order he approved, a pharmacy he ruled on, a customer, link, licence, setting or venue
 *      he decided — none is reversed, refused, re-approved, merged away or overwritten below him.
 */

const ROOT = new URL("../", import.meta.url);

function read(path: string): string {
  return stripComments(readFileSync(new URL(path, ROOT), "utf8").replace(/\r\n/g, "\n"));
}

function readSql(path: string): string {
  return readFileSync(new URL(path, ROOT), "utf8")
    .replace(/\r\n/g, "\n")
    .replace(/--[^\n]*/g, "");
}

function checkRule(): void {
  // As the loader builds it: every key through the one HR id normaliser.
  const superAdmins = new Set([canonicalHrIdKey("B-10") as string]);

  // The Super Admin's own approval, refused for anyone else.
  assert.equal(approvalLockedFor({ viewerIsSuperAdmin: false, approvedBy: "B-10", superAdmins }), true, "an approval the Super Admin decided is locked for the SFE Manager");
  assert.equal(approvalLockedFor({ viewerIsSuperAdmin: false, approvedBy: " b-10 ", superAdmins }), true, "the approver's id is matched trimmed and in any case, as the database matches it");
  // A trusted point: the place he created himself carries the lock even when nobody decided a review.
  assert.equal(approvalLockedFor({ viewerIsSuperAdmin: false, approvedBy: null, placeCreatedBy: "B-10", superAdmins }), true, "a place the Super Admin created is locked for the SFE Manager");
  // He is never blocked.
  assert.equal(approvalLockedFor({ viewerIsSuperAdmin: true, approvedBy: "B-10", placeCreatedBy: "B-10", superAdmins }), false, "the Super Admin himself may always reject");
  // What somebody else approved stays rejectable.
  assert.equal(approvalLockedFor({ viewerIsSuperAdmin: false, approvedBy: "S-01", placeCreatedBy: "R-77", superAdmins }), false, "what the SFE Manager or a rep did is not locked");
  assert.equal(approvalLockedFor({ viewerIsSuperAdmin: false, approvedBy: null, placeCreatedBy: null, superAdmins }), false, "nothing decided, nothing locked");
  // An empty set of Super Admins locks nothing — which is why the loader throws on a failed read.
  assert.equal(approvalLockedFor({ viewerIsSuperAdmin: false, approvedBy: "B-10", superAdmins: new Set() }), false);

  // His words, 2026-11-20: "this is the system administrator decision and you have no right to overcome it".
  assert.match(SUPER_ADMIN_APPROVAL_IS_FINAL_TEXT, /^This is the system administrator's decision\. You have no right to override it\.$/);

  const loader = read("src/lib/phoenix-crm/server/super-admin-approval.ts");
  assert.match(loader, /\.rpc\("phoenix_crm_super_admin_hr_ids"\)/, "the screen asks the database who counts, through the guard's own definition");
  assert.match(loader, /if \(error\) throw error;/, "a failed read of the Super Admins throws — it never answers an empty set");
  assert.match(loader, /if \(viewer\.isSuperAdmin\) return \(\) => false;/, "nothing is ever locked for the Super Admin viewer");
}

function checkDatabase(): void {
  const sql = readSql("supabase/migrations/20261116230741_phoenix_crm_super_admin_approval_is_final.sql");

  assert.match(sql, /create or replace function public\.phoenix_crm_is_super_admin\(p_hr_id text\)/);
  assert.match(sql, /role = 'Super Admin'/, "the helper asks for the Super Admin role");
  assert.match(sql, /is_test_persona/, "and skips a test account");
  assert.match(sql, /revoke execute on function public\.phoenix_crm_is_super_admin\(text\) from public, anon, authenticated;/, "the helper is closed to the browser roles");
  // The whole body, dollar quotes included — a lone `$` there (a JavaScript replace eats one of `$$`) is
  // invisible to every migration checker and only fails when the database parses it.
  assert.match(
    sql,
    /as \$\$\n  select distinct upper\(trim\(u\.hr_id\)\)\n  from public\.app_auth_users u\n  where public\.phoenix_crm_is_super_admin\(u\.hr_id\);\n\$\$;/,
    "the list the screen reads is built on the very same test",
  );
  assert.match(sql, /revoke execute on function public\.phoenix_crm_super_admin_hr_ids\(\) from public, anon, authenticated;/, "and is closed to the browser roles too");

  const review = /create or replace function public\.phoenix_crm_decide_validation_review\(p jsonb\)[\s\S]*?\n\$\$;/.exec(sql);
  assert.ok(review, "the migration redefines phoenix_crm_decide_validation_review");
  assert.match(
    review[0],
    /if v_decision = 'reject' and not public\.phoenix_crm_is_super_admin\(v_actor\) and \(\s*\(v_review\.status = 'approved' and public\.phoenix_crm_is_super_admin\(v_review\.decided_by_hr_id\)\)/,
    "a reject of a review the Super Admin approved is refused for anyone else",
  );
  assert.match(review[0], /public\.phoenix_crm_is_super_admin\(pl\.created_by_hr_id\)/, "and a reject of a place the Super Admin created");
  assert.match(review[0], /raise exception 'phoenix_crm:approved_by_super_admin';/);

  const venue = /create or replace function public\.phoenix_crm_decide_shared_place\(p jsonb\)[\s\S]*?\n\$\$;/.exec(sql);
  assert.ok(venue, "the migration redefines phoenix_crm_decide_shared_place");
  assert.match(
    venue[0],
    /public\.phoenix_crm_is_super_admin\(v_venue\.decided_by_hr_id\)\s*and not public\.phoenix_crm_is_super_admin\(v_actor\) then\s*raise exception 'phoenix_crm:approved_by_super_admin';/,
    "rejecting a building the Super Admin approved is refused for anyone else",
  );

  for (const fn of ["phoenix_crm_decide_validation_review(jsonb)", "phoenix_crm_decide_shared_place(jsonb)"]) {
    assert.ok(sql.includes(`revoke execute on function public.${fn} from public, anon, authenticated;`), `${fn} stays closed to the browser roles`);
  }

  // "Keep it" (and a bulk Approve) runs the approve branch again. The reject lock above reads decided_by_hr_id,
  // so that branch must leave a Super Admin's decision whole — name, time and note TOGETHER — when somebody who is
  // not one approves an active building he approved. Last replacer of the function: the follow-up migration.
  // The last replacer of the function reads from here: it must keep every Keep-it line below AND the building guard.
  const keepIt = readSql("supabase/migrations/20261118220000_phoenix_crm_building_reject_respects_super_admin_seats.sql");
  const approve = /create or replace function public\.phoenix_crm_decide_shared_place\(p jsonb\)[\s\S]*?\n\$\$;/.exec(keepIt);
  assert.ok(approve, "the Keep-it migration redefines phoenix_crm_decide_shared_place");
  assert.match(
    approve[0],
    /v_keeps_decision := coalesce\(\s*v_venue\.status = 'active'\s*and public\.phoenix_crm_is_super_admin\(v_venue\.decided_by_hr_id\)\s*and not public\.phoenix_crm_is_super_admin\(v_actor\),\s*false\s*\);/,
    "a Super Admin's decision is kept only for an active building he approved, approved again by someone who is not one",
  );
  for (const [column, kept, fresh] of [
    ["decided_at", "v_venue.decided_at", "now()"],
    ["decided_by_hr_id", "v_venue.decided_by_hr_id", "v_actor"],
    ["decision_note", "v_venue.decision_note", "v_note"],
  ] as const) {
    assert.ok(
      approve[0].includes(`${column} = case when v_keeps_decision then ${kept} else ${fresh} end`),
      `Keep it leaves his ${column} alone — the name alone staying put printed his name beside the SFE Manager's click time and note`,
    );
  }
  // Rejecting the BUILDING retires every seat in it, so it is refused for anyone but a Super Admin while a VALIDATED
  // customer seated in it stands on a Super Admin's approval (a review he approved, or a place he created); a building
  // whose seated doctors are still pending stays the SFE's to reject (owner, 18 Nov 2026).
  assert.match(
    approve[0],
    /if v_decision = 'reject' and not public\.phoenix_crm_is_super_admin\(v_actor\) and exists \([\s\S]*?pl\.shared_place_id = v_id and pl\.status = 'active' and c\.status = 'active'[\s\S]*?public\.phoenix_crm_is_super_admin\(pl\.created_by_hr_id\)[\s\S]*?r\.status = 'approved' and public\.phoenix_crm_is_super_admin\(r\.decided_by_hr_id\)[\s\S]*?raise exception 'phoenix_crm:approved_by_super_admin';/,
    "a building is not rejected by anyone else while a validated seat stands on the Super Admin's approval",
  );
  assert.ok(
    approve[0].indexOf("c.status = 'active'") < approve[0].indexOf("set status = 'retired', decided_at = now()"),
    "and the guard runs before the building is retired",
  );
  assert.ok(approve[0].includes("revoke execute on function") === false && keepIt.includes("revoke execute on function public.phoenix_crm_decide_shared_place(jsonb) from public, anon, authenticated;"), "and the function stays closed to the browser roles");
}

function checkService(): void {
  const service = read("src/lib/phoenix-crm/server/validation-reviews.ts");
  const refuse = /export async function refuseValidatedPlace\([\s\S]*?\n\}/.exec(service);
  assert.ok(refuse, "refuseValidatedPlace is still an exported function");
  const body = refuse[0];
  const guard = body.indexOf("throw forbiddenError(SUPER_ADMIN_APPROVAL_IS_FINAL_TEXT)");
  const wipe = body.indexOf(".upsert(");
  assert.ok(guard > -1, "refuseValidatedPlace refuses what the Super Admin approved");
  assert.ok(wipe > -1, "refuseValidatedPlace still upserts the review");
  assert.ok(guard < wipe, "and it refuses BEFORE the upsert puts the review back to pending and clears who approved it");
  assert.match(body, /lockedFor\(earlierRow\?\.status === "approved" \? earlierRow\.decided_by_hr_id : null, place\.created_by_hr_id\)/, "from who approved the review and who created the place");

  const db = read("src/lib/phoenix-crm/server/db.ts");
  assert.match(db, /approved_by_super_admin: \{ status: 403, message: SUPER_ADMIN_APPROVAL_IS_FINAL_TEXT \}/, "the database refusal reaches the screen as a 403 with the plain sentence");

  const venues = read("src/lib/phoenix-crm/server/shared-places.ts");
  assert.match(venues, /lockedBySuperAdmin: row\.status === "active" && lockedFor\(row\.decided_by_hr_id\)/, "an active building the Super Admin approved is marked locked");
}

function checkScreens(): void {
  const NOTE = "<CrmNote tone=\"neutral\">{SUPER_ADMIN_APPROVAL_IS_FINAL_TEXT}</CrmNote>";

  const venues = read("src/components/phoenix-crm/shared-place-list.tsx");
  assert.ok(venues.includes(`{row.lockedBySuperAdmin ? ${NOTE} : null}`), "a locked building shows the sentence");
  assert.match(venues, /\{row\.lockedBySuperAdmin \? null : \(/, "and no Reject button");
  assert.match(venues, /takes: \(row\) => !row\.restorable && !row\.lockedBySuperAdmin/, "bulk reject skips a locked building");

  const validated = read("src/components/phoenix-crm/validated-place-list.tsx");
  assert.ok(validated.includes(`if (row.lockedBySuperAdmin) return ${NOTE};`), "Refuse becomes the sentence on a locked place (the review deck reuses this button)");
  assert.match(validated, /takes: \(row\) => !row\.lockedBySuperAdmin/, "bulk refuse skips a locked place");

  const queue = read("src/components/phoenix-crm/validation-review-queue.tsx");
  assert.ok(queue.includes(`{row.status === "approved" && row.lockedBySuperAdmin ? ${NOTE} : null}`), "an approved, locked review shows the sentence");

  const seated = read("src/components/phoenix-crm/shared-place-customers.tsx");
  assert.ok(seated.includes(`if (customer.state === "in_use" && customer.lockedBySuperAdmin) return ${NOTE};`), "a seated customer the Super Admin approved shows the sentence instead of Reject");

  const groups = read("src/lib/phoenix-crm/shared-place-groups.ts");
  assert.match(groups, /customer\.lockedBySuperAdmin = customer\.lockedBySuperAdmin === true \|\| review\.lockedBySuperAdmin === true;/, "the approved review's lock is carried onto the seated customer");

  const deck = read("src/components/place-review-deck/review-deck.tsx");
  assert.match(deck, /<PlaceInUseReject row=\{row\}/, "the review deck reuses the gated Reject button rather than a second one");
}

/** The body of one exported function, from its name to the first line that closes it at column zero. */
function functionBody(path: string, name: string): string {
  const source = read(path);
  const match = new RegExp(`export async function ${name}\\([\\s\\S]*?\\n\\}`).exec(source);
  assert.ok(match, `${name} is still an exported function in ${path}`);
  return match[0];
}

/** The guard is called in this function, and before the write it protects. */
function guardsBefore(path: string, name: string, guard: string, write: string, why: string): void {
  const body = functionBody(path, name);
  const at = body.indexOf(guard);
  const writeAt = body.indexOf(write);
  assert.ok(at > -1, `${name} asks ${guard.trim()} — ${why}`);
  assert.ok(writeAt > -1, `${name} still makes the write ${write}`);
  assert.ok(at < writeAt, `${name} refuses BEFORE ${write} — ${why}`);
}

function checkEverySfeUndo(): void {
  const superAdmins = new Set([canonicalHrIdKey("B-10") as string]);
  assert.equal(actedBySuperAdmin(["S-01", " b-10 "], superAdmins), true, "any one of the actors being the Super Admin locks it");
  assert.equal(actedBySuperAdmin(["S-01", null, undefined, ""], superAdmins), false, "nobody's act is not his");
  assert.equal(actedBySuperAdmin([42, {}], superAdmins), false, "a value that is not an HR id is nobody");

  // The bulk loads and housekeeping he runs over thousands of rows never freeze a list — production, 20 Nov 2026:
  // 3,413 customer_pending rows carry his id. Nor does his rejection of a photo.
  for (const housekeeping of ["customer_pending", "customer_loaded", "list_loaded", "customer_renamed", "customer_merged_in", "validation_review_rejected", "visit_locations_restamped"]) {
    assert.ok(!(LIST_STANDING_EVENTS as readonly string[]).includes(housekeeping), `${housekeeping} is not a decision about the list`);
    assert.ok(!(PLACE_STANDING_EVENTS as readonly string[]).includes(housekeeping), `${housekeeping} is not a decision about the place`);
  }
  for (const decided of ["customer_validated", "validation_review_approved", "customer_restored", "customer_moved_in", "customer_dropped", "request_decided"]) {
    assert.ok((LIST_STANDING_EVENTS as readonly string[]).includes(decided), `${decided} decides where the customer stands`);
  }
  for (const decided of ["place_added", "place_moved", "place_restored", "place_seated", "validation_review_approved"]) {
    assert.ok((PLACE_STANDING_EVENTS as readonly string[]).includes(decided), `${decided} decides where the place is`);
  }

  const loader = read("src/lib/phoenix-crm/server/super-admin-approval.ts");
  assert.match(loader, /export function superAdminDecisionStands\(\): Error \{\n  return forbiddenError\(SUPER_ADMIN_APPROVAL_IS_FINAL_TEXT\);/, "every lock refuses with a 403 and the one sentence");
  assert.match(loader, /if \(viewerIsSuperAdmin\) return;/, "the Super Admin himself is never blocked");
  assert.match(loader, /select\("created_by_hr_id, admin_photo_by_hr_id"\)/, "a place he created or photographed is his");
  assert.match(loader, /if \(row\.decided_by_role === "administrator"\) throw superAdminDecisionStands\(\);/, "a plan he approved as the Administrator is his");

  const PLACE = "src/lib/phoenix-crm/server/place-move.ts";
  guardsBefore(PLACE, "movePlace", "await assertPlaceIsNotSuperAdmins(viewer, placeId, isTest);", '"phoenix_crm_move_place"', "a place he placed, moved or approved");
  guardsBefore(PLACE, "retirePlace", "await assertPlaceIsNotSuperAdmins(", '"phoenix_crm_update_place"', "a place he placed, moved or approved");

  const LIST = "src/lib/phoenix-crm/server/list.ts";
  guardsBefore(LIST, "sfeDropFromList", "await assertListStandingIsNotSuperAdmins(viewer, customerId, isTest);", '"phoenix_crm_create_request"', "a customer he kept, validated or moved");
  guardsBefore(LIST, "moveCustomerToSeat", "await assertListStandingIsNotSuperAdmins(", '"phoenix_crm_move_customer"', "a customer he kept, validated or moved");
  guardsBefore(LIST, "sfeBringBack", "await assertListStandingIsNotSuperAdmins(viewer, customerId, isTest);", '"phoenix_crm_create_request"', "a customer he dropped");
  guardsBefore(
    LIST,
    "decideListRequest",
    "await assertSuperAdminDecisionStands(viewer.isSuperAdmin, [request.manager_decided_by_hr_id, request.admin_decided_by_hr_id]);",
    '"phoenix_crm_decide_request"',
    "a step he approved is not refused later",
  );
  assert.match(functionBody(LIST, "decideListRequest"), /manager_decided_by_hr_id, admin_decided_by_hr_id"\)/, "and the request read names who took the earlier steps");

  guardsBefore("src/lib/phoenix-crm/server/plans.ts", "transitionPlan", "await assertApprovedPlanStands(viewer, planRow);", '"phoenix_crm_plan_transition"', "a week he approved");
  guardsBefore("src/lib/phoenix-crm/server/monthly-plans.ts", "decideMonthlyPlan", "await assertApprovedPlanStands(viewer, headerRow);", '"phoenix_crm_monthly_plan_transition"', "a month he approved");
  assert.match(functionBody("src/lib/phoenix-crm/server/monthly-plans.ts", "decideMonthlyPlan"), /decided_by_hr_id, decided_by_role"\)/, "the month read names who approved it");

  guardsBefore(
    "src/lib/phoenix-crm/server/unplanned.ts",
    "decideUnplannedVisit",
    "await assertSuperAdminDecisionStands(viewer.isSuperAdmin, [row.manager_decided_by_hr_id, row.admin_decided_by_hr_id]);",
    '"phoenix_crm_decide_unplanned_visit"',
    "an off-plan or recorded visit he approved is not refused later",
  );
  guardsBefore(
    "src/lib/phoenix-crm/server/plan-edits.ts",
    "decidePlanEdit",
    "await assertSuperAdminDecisionStands(viewer.isSuperAdmin, [row.manager_decided_by_hr_id, row.admin_decided_by_hr_id]);",
    '"phoenix_crm_decide_plan_edit_request"',
    "a week edit he approved is not refused later",
  );
  guardsBefore(
    "src/lib/marketing-requests/crm-list-check.ts",
    "decideMarketingListCheck",
    'await assertSuperAdminDecisionStands(access.role === "Super Admin", [row.decided_by_hr_id]);',
    "const update = await supabase",
    "his doctor-list answer is not turned round",
  );
}

function checkDirectOrdersAndMarketing(): void {
  const ORDERS = "src/lib/direct-orders/service.ts";
  const helper = read("src/lib/direct-orders/super-admin-decision.ts");
  assert.match(helper, /access\.role === "Super Admin" \|\| access\.scope === "system"/, "Direct Orders' own test for the Super Admin");
  assert.match(helper, /\.in\("status", \["approved_new", "matched_existing", "rejected"\]\)/, "every claim he decided, either way, is his ruling");
  assert.match(helper, /if \(row\.hold_release_ground === "kept_held"\) actors\.push\(row\.hold_release_decided_by_hr_id\);/, "so is his ruling that a pharmacy's orders stay held");
  assert.match(helper, /if \(row\.hold_release_ground === "admin_released"\) actors\.push\(row\.hold_release_decided_by_hr_id\);/, "an order he released into the chain is his");

  // The ladder: a rung he approved is not rejected or returned later — the CEO keeps his say.
  guardsBefore(ORDERS, "decideDirectOrder", "await assertSuperAdminDecisionStands(isSuperAdmin, approvedStepActors(steps));", '"phx_apply_direct_order_decision"', "a rung he approved");
  assert.match(functionBody(ORDERS, "decideDirectOrder"), /if \(input\.decision !== "approve" && access\.role !== "CEO"\) \{/, "only a reject or a return is refused, and never the CEO's");
  guardsBefore(ORDERS, "reverseDirectOrder", "approvedStepActors(await loadSteps(original.id))", ".insert({", "an order he approved is reversed by nobody below him");
  guardsBefore(ORDERS, "confirmDirectOrderCleanup", "await assertPharmacyRulingStands(access, mergedId);", '.from("direct_order_pharmacies")', "a pharmacy he ruled on is not merged away");
  guardsBefore(ORDERS, "confirmDirectOrderCleanup", "await assertOrderCarriedBySuperAdminStands(access, {", "cancelled", "an order he carried is not cancelled as a duplicate");
  guardsBefore(ORDERS, "updateDirectOrderPharmacyDetails", "await assertPharmacyRulingStands(access, input.pharmacyId);", ".update(", "who and where a pharmacy he ruled on is");
  guardsBefore(ORDERS, "replaceDirectOrderPharmacyCodes", "await assertPharmacyRulingStands(access, input.pharmacyId);", ".delete()", "the codes of a pharmacy he ruled on");
  assert.match(read(ORDERS), /verified_at: new Date\(\)\.toISOString\(\),\s*\}\)\s*\.eq\("id", input\.pharmacyId\)\s*\.neq\("verification_status", "verified"\);/, "a confirmed pharmacy keeps the name of whoever confirmed it");
  guardsBefore("src/lib/direct-orders/pharmacy-validation.ts", "decideDirectOrderPharmacyValidation", 'if (input.decision !== "reject") await assertPharmacyRulingStands(access, pharmacyId);', 'status: "approved_new"', "a pharmacy he refused is not approved through another claim");

  // His "stays held" beats a code that would otherwise prove the pharmacy — and the SFE clean-up, which asks the same rule.
  const provenCode = { distributorCode: "UCP", customerCode: "123456", mappedBrickId: "B1" } as never;
  const kept = decideDirectOrderHold({ verificationStatus: "pending_review", declaredBrickId: "B1", distributorCodes: [provenCode], holdReleaseGround: "kept_held" });
  assert.deepEqual([kept.hold, kept.ground], [true, "admin_kept_held"], "a pharmacy he ruled stays held stays held, whatever code arrives");
  const proven = decideDirectOrderHold({ verificationStatus: "pending_review", declaredBrickId: "B1", distributorCodes: [provenCode], holdReleaseGround: null });
  assert.equal(proven.hold, false, "without his ruling the same code still proves the pharmacy");

  const MARKETING = "src/lib/marketing-requests/service.ts";
  guardsBefore(MARKETING, "createMarketingValidationRecord", "const keepsSuperAdminsVerdict = Boolean(existingCustomerRow) && !isVenueOnly", ".update({ ...capturedColumns", "a customer he validated keeps his verdict");
  assert.match(functionBody(MARKETING, "createMarketingValidationRecord"), /\.\.\.\(keepsSuperAdminsVerdict \? \{\} : \{\n\s+validated_at: adminValidatedAt,/, "the evidence is still saved; only the verdict columns stay his");
  guardsBefore(MARKETING, "createMarketingValidationRecord", "const linkVerdictStands = Boolean(existingLinkRow)", '.from("marketing_customer_pharmacies")\n              .update(', "an approved link keeps its verdict");
  assert.match(functionBody(MARKETING, "createMarketingValidationRecord"), /existingLinkRow\?\.validation_status === "admin_approved" \|\|/, "an admin-approved link is never rewritten by a capture");
  guardsBefore("src/lib/marketing-requests/pharmacy-license-verdict.ts", "recordMarketingPharmacyLicenseVerdict", "await assertSuperAdminDecisionStands(false, [previous.license_name_checked_by_hr_id]);", "...licenseVerdictColumns(", "his licence verdict is not turned round");
  guardsBefore(MARKETING, "mergeMarketingVenue", "await assertSuperAdminDecisionStands(access.role === \"Super Admin\", [", "moveMarketingVenueChildren(", "a venue he validated is not merged away");
  guardsBefore(MARKETING, "updateMarketingControlSetting", "await assertSuperAdminDecisionStands(access.role === \"Super Admin\", [", ".update({", "a setting he set last");
}

export function runPhoenixCrmSuperAdminApprovalIsFinalTests(): void {
  checkRule();
  checkEverySfeUndo();
  checkDirectOrdersAndMarketing();
  checkDatabase();
  checkService();
  checkScreens();
}
