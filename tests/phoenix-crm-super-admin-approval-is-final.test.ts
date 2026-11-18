import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { stripComments } from "./support/comment-strip.ts";
import { canonicalHrIdKey } from "../src/lib/hr-id.ts";
import { SUPER_ADMIN_APPROVAL_IS_FINAL_TEXT, approvalLockedFor } from "../src/lib/phoenix-crm/super-admin-approval-rules.ts";

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
 *   5. every screen that drew a Reject or Refuse draws the sentence instead, and bulk reject skips it.
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

  assert.match(SUPER_ADMIN_APPROVAL_IS_FINAL_TEXT, /^The administrator approved this, so only the administrator can take it back\.$/);

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
  const keepIt = readSql("supabase/migrations/20261118191500_phoenix_crm_keep_it_keeps_the_super_admin_decision.sql");
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
  assert.match(deck, /<PlaceInUseRefuse row=\{row\}/, "the review deck reuses the gated Refuse button rather than a second one");
}

export function runPhoenixCrmSuperAdminApprovalIsFinalTests(): void {
  checkRule();
  checkDatabase();
  checkService();
  checkScreens();
}
