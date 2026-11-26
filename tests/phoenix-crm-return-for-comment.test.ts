import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { stripComments } from "./support/comment-strip.ts";

import { bulkDropNotice, repeatOfDropped } from "../src/lib/phoenix-crm/bulk-drop.ts";
import {
  canReturnForComment,
  isWithRep,
  stageAfterReply,
  stageAfterReturn,
  WITH_REP_LABEL,
  WITH_REP_STAGE,
} from "../src/lib/phoenix-crm/list-request-rules.ts";

/**
 * Phoenix CRM — SFE returns a waiting request to the rep for a comment (owner, 2026-10-12: "add an option
 * for the sfe to return for comment"). The request stays pending with the rep, and when the rep answers it
 * goes straight back to SFE. Also pins the bulk drop's repeat-ask handling (the same customer asked twice).
 */

const source = (path: string): string => stripComments(readFileSync(path, "utf8"));
const raw = (path: string): string => readFileSync(path, "utf8");

export function runPhoenixCrmReturnForCommentTests(): void {
  // ── A · The rules: which step can be returned, and where it goes back to ─────────────────────────
  {
    const base = { kind: "drop" as const, status: "pending", stage: "sfe" as const, withRep: false, canDecide: true, hasReviewer: true };
    assert.equal(canReturnForComment(base), true, "SFE's step of a drop can be returned");
    assert.equal(canReturnForComment({ ...base, kind: "add" }), true, "…and of an add");
    assert.equal(canReturnForComment({ ...base, kind: "restore" }), true, "…and of a bring-back (every kind, his answer)");
    assert.equal(canReturnForComment({ ...base, stage: "manager" }), false, "the district manager's own step is never returned");
    assert.equal(canReturnForComment({ ...base, withRep: true }), false, "a request already with the rep is not returned twice");
    assert.equal(canReturnForComment({ ...base, canDecide: false }), false, "only whoever decides the step may return it");
    assert.equal(canReturnForComment({ ...base, status: "approved" }), false, "a decided request is not returned");
    assert.equal(canReturnForComment({ ...base, kind: "grade", stage: null }), false, "a grade change is the manager's while the territory has one");
    assert.equal(canReturnForComment({ ...base, kind: "grade", stage: null, hasReviewer: false }), true, "…and SFE's, returnable, when it has none");

    assert.equal(WITH_REP_STAGE, "rep");
    assert.equal(isWithRep("rep"), true);
    assert.equal(isWithRep("sfe"), false);
    assert.equal(stageAfterReply("drop"), "sfe", "a reply goes straight back to SFE, never through the manager again");
    assert.equal(stageAfterReply("add"), "sfe");
    assert.equal(stageAfterReply("restore"), "sfe");
    assert.equal(stageAfterReply("grade"), null, "a grade change has no stage to return to");
    assert.equal(WITH_REP_LABEL, "Waiting for the rep's comment");
  }

  // ── B · The migration: additive, with the guard that keeps an approval from slipping past ────────
  {
    const sql = raw("supabase/migrations/20261012180000_phoenix_crm_return_request_for_comment.sql");
    assert.match(sql, /stage in \('manager', 'sfe', 'rep'\)/, "'rep' is a stage");
    assert.match(sql, /\(status = 'pending' and \(kind <> 'grade' or stage = 'rep'\)\) = \(stage is not null\)/, "a grade change is stageless unless it is with the rep");
    assert.match(sql, /if old\.stage = 'rep' and new\.status = 'approved' then\s*raise exception 'phoenix_crm:request_with_rep'/, "no writer can approve a request the rep still owes a comment on");
    assert.match(sql, /if v_note is null then\s*raise exception 'phoenix_crm:note_required'/, "the return needs a note");
    assert.match(sql, /v_back_to := case when v_request\.kind = 'grade' then null else 'sfe' end/, "the answer goes back to SFE's step");
    assert.match(sql, /grant execute on function public\.phoenix_crm_return_request\(jsonb\) to service_role/, "service role only");
    assert.doesNotMatch(sql, /\bdrop (table|column)\b|\bdelete from\b|\btruncate\b/i, "additive: nothing is dropped or deleted");
  }

  // ── C · The wiring: routes, the card, the Team tab ───────────────────────────────────────────────
  {
    const returnRoute = source("app/api/phoenix-crm/list/requests/return/route.ts");
    assert.match(returnRoute, /assertPermission\(access, "phoenix_crm", "approve"\)/, "returning is an approver's act");
    assert.match(returnRoute, /returnListRequestForComment\(viewer, body\)/);
    const answerRoute = source("app/api/phoenix-crm/list/requests/answer/route.ts");
    assert.match(answerRoute, /assertPermission\(access, "phoenix_crm", "create"\)/, "answering is the rep's act");
    assert.match(answerRoute, /answerReturnedRequest\(viewer, body\)/);

    const list = source("src/lib/phoenix-crm/server/list.ts");
    assert.match(list, /if \(withRep && decision === "approve" && !asAdministrator\) \{/, "the service refuses to approve a request with the rep — to everyone but the Administrator");
    assert.match(list, /const stage = withRep \? "rep" :/, "a refusal of a request with the rep sends the stored stage");
    assert.match(list, /if \(!note\) throw validationError\(RETURN_NOTE_REQUIRED\)/, "the return note is required");

    const card = source("src/components/phoenix-crm/request-card.tsx");
    assert.match(card, /Return for comment/, "SFE's card offers it");
    assert.match(card, /\/api\/phoenix-crm\/list\/requests\/return/);
    assert.match(card, /\/api\/phoenix-crm\/list\/requests\/answer/, "the rep's card answers");
    assert.match(card, /const canReturn = deciding && !request\.withRep && request\.canReturn;/, "only where the server says this viewer may — SFE, or the Administrator in its place");

    const team = source("src/components/phoenix-crm/team-tab.tsx");
    assert.match(team, /const withRep = requests\.filter\(\(request\) => request\.withRep\);/, "with-the-rep requests have their own group");
    assert.match(team, /!request\.canDecide && !request\.withRep/, "and are not 'waiting for another manager'");

    const nudge = source("src/lib/phoenix-crm/server/approval-nudge.ts");
    assert.match(nudge, /if \(isWithRep\(row\.stage\)\) continue;/, "no manager is nudged for a request the rep owes");

    const policy = source("src/lib/notifications/policy.ts");
    assert.match(policy, /"phoenix_crm\.request_returned"/);
    assert.match(policy, /"phoenix_crm\.request_answered"/);
  }

  // ── E · The Administrator answers a list request at ANY step and status (owner, 2026-11-27) ───────
  //  "make super admin can approve reject or return for edit any approval type in phoenix crm … I must
  //  have the authority to respond whatever response in any step any status as super admin"
  {
    const base = { kind: "drop" as const, status: "pending", stage: "manager" as const, withRep: false, canDecide: false, hasReviewer: true };
    assert.equal(canReturnForComment({ ...base, asAdministrator: true }), true, "he returns the district manager's own step");
    assert.equal(canReturnForComment({ ...base, stage: "sfe", asAdministrator: true }), true, "…and SFE's");
    assert.equal(canReturnForComment({ ...base, kind: "grade", stage: null, asAdministrator: true }), true, "…and a grade change on a territory that has its manager");
    assert.equal(canReturnForComment({ ...base, withRep: true, asAdministrator: true }), false, "a request already with the rep is not returned twice, even by him");
    assert.equal(canReturnForComment({ ...base, status: "approved", asAdministrator: true }), false, "a decided request is reversed, not returned");
    assert.equal(canReturnForComment(base), false, "nobody else returns the district manager's step");

    assert.equal(stageAfterReturn("drop", "manager"), "manager", "a request returned from the district manager's step goes back to him");
    assert.equal(stageAfterReturn("add", "sfe"), "sfe");
    assert.equal(stageAfterReturn("grade", null), null, "a row returned before the column existed keeps the old rule");
    assert.equal(stageAfterReturn("drop", null), "sfe");
    assert.equal(stageAfterReturn("drop", "rep"), "sfe", "only a real step is read back");

    const list = source("src/lib/phoenix-crm/server/list.ts");
    const returnFn = list.match(/export async function returnListRequestForComment[\s\S]*?\n}\n/)?.[0] ?? "";
    assert.match(returnFn, /const asAdministrator = canOverrideDecision\(viewer, isTest\);\s+if \(!asAdministrator\) assertListRequestApprover\(viewer, seat, isTest, stage\);/, "he is not asked to hold the step he returns");
    assert.match(returnFn, /as_administrator: asAdministrator/, "and the database is told it is him");
    const decideFn = list.match(/export async function decideListRequest[\s\S]*?\n}\n/)?.[0] ?? "";
    assert.match(decideFn, /stageAfterReturn\(kind, request\.returned_from_stage\)/, "a with-rep request is decided at the step it returns to");
    assert.match(decideFn, /decision === "approve" && !asAdministrator && customerId && awaitsPlaceCheck/, "he approves through a Place-check hold");
    assert.match(decideFn, /as_administrator: asAdministrator,/, "and the database is told it is him");
    assert.match(list, /const stage = withRep \? stageAfterReturn\(kind, row\.returned_from_stage\)/, "every card reads the same step");
    assert.match(list, /returned_from_stage, rep_reply/, "the column is read");
    assert.match(list, /asAdministrator: canOverrideDecision\(viewer, isTest\),\s+\}\);\s+return \{ canDecide, canReturn \};/, "his card is offered the return");

    const card = source("src/components/phoenix-crm/request-card.tsx");
    assert.match(card, /const administratorDecides = pending && canOverride && !decides;/, "his buttons are drawn at every step: a grade change, the manager's, SFE's and with the rep");
    assert.match(card, /const heldOnPlaceChecks = canOverride \? null : request\.placeCheckHold;/, "Approve stays for him through a Place-check hold");
    assert.doesNotMatch(card, /<AdministratorDecline/, "the decline-only fallback is gone from the card");

    const sql = raw("supabase/migrations/20261127004142_phoenix_crm_administrator_decides_any_list_request.sql");
    assert.match(sql, /add column if not exists returned_from_stage text/);
    assert.match(sql, /if v_request\.stage = 'manager' and not v_as_administrator then\s+raise exception 'phoenix_crm:cannot_return';/, "only he returns the manager's step");
    assert.match(sql, /set returned_from_stage = v_request\.stage,\s+stage = 'rep'/, "every return records the step it left");
    assert.match(sql, /v_back_to := coalesce\(v_request\.returned_from_stage, case when v_request\.kind = 'grade' then null else 'sfe' end\);/, "the answer goes back there");
    const decide = raw("supabase/migrations/20261127004938_phoenix_crm_administrator_approves_a_request_with_the_rep.sql");
    assert.match(decide, /if v_request\.stage = 'rep' then\s+if v_decision = 'approve' and not v_as_administrator then\s+raise exception 'phoenix_crm:request_with_rep';/, "nobody else approves a request the rep still owes a comment on");
    assert.match(decide, /update public\.phoenix_crm_list_requests q\s+set stage = v_request\.stage\s+where q\.id = v_request\.id;/, "his approval steps the row out of 'rep' first, so the with-rep guard lets it through");
    for (const text of [sql, decide].map((body) => body.replace(/--[^\n]*/g, ""))) {
      assert.doesNotMatch(text, /\bdrop (table|column|trigger)\b|\bdelete from\b|\btruncate\b/i, "additive: nothing is dropped or deleted");
    }
  }

  // ── D · The bulk drop: a customer asked about twice is dropped once ──────────────────────────────
  {
    assert.equal(repeatOfDropped({ customerKey: "c1" }, new Set(["c1"])), true, "his second ask is a repeat once he is dropped");
    assert.equal(repeatOfDropped({ customerKey: "c2" }, new Set(["c1"])), false);
    assert.equal(repeatOfDropped({ customerKey: null }, new Set(["c1"])), false, "an unknown customer is never assumed a repeat");
    assert.equal(repeatOfDropped({}, new Set(["c1"])), false);

    const notice = bulkDropNotice([
      { customerName: "Dr A", ok: true, final: true },
      { customerName: "Dr A", ok: true, final: true, repeat: true },
      { customerName: "Dr B", ok: true, final: true },
    ]);
    assert.equal(notice.tone, "info");
    assert.equal(notice.title, "Approved 2 drop requests: 2 customers dropped from the list · 1 repeat request closed with them.");

    const team = source("src/components/phoenix-crm/team-tab.tsx");
    assert.match(team, /if \(repeatOfDropped\(request, dropped\)\) \{/, "the Team tab skips the repeat instead of sending a call that is refused");
    assert.match(team, /if \(result\.final && request\.customerKey\) dropped\.add\(request\.customerKey\)/, "only a final drop closes the customer's other asks");
  }

  console.log("phoenix-crm return for comment: OK");
}
