import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { stripComments } from "./support/comment-strip.ts";

import {
  ADMINISTRATOR_REVERSAL_DAYS,
  ADMINISTRATOR_REVERSAL_KINDS,
  isAdministratorReversalKind,
} from "../src/lib/phoenix-crm/administrator-reversal-rules.ts";

/**
 * Phoenix CRM — the Administrator is not a step (owner, 2026-10-08).
 *
 * "Exclude HR from the approvals … make him able to decline, or return with a comment, any decision —
 * but the plan never stops for his approval." And: "call it the Administrator", never HR, never an
 * override. Then, on 2026-10-14: in an urgent situation he approves instead of anyone, any title, on
 * any Phoenix CRM approval — still never a step. What this file pins, from the emitted source of every
 * approval kind:
 *   1. every approval engine lets him APPROVE or DECLINE at the step a row is at — he skips none;
 *   2. nothing is COUNTED as waiting for him, and no screen names him HR or an override;
 *   3. his decline tells the rep, the district manager and SFE, naming him by his title;
 *   4. the database: no `hr_pending`, SFE's yes reopens the week, and a decline needs a comment;
 *   5. he can also take back what was already decided (a reopened week, an approved visit, an approved
 *      list request) - only him, only on a real entry, with a comment, and only what can be put back.
 */

function source(path: string): string {
  return stripComments(readFileSync(new URL(`../${path}`, import.meta.url), "utf8")).replace(/\r\n/g, "\n");
}

export function runPhoenixCrmAdministratorTests(): void {
  // ── 1. He approves or declines, at the step the row is at ───────────────────────────────────────
  {
    const list = source("src/lib/phoenix-crm/server/list.ts");
    assert.match(list, /if \(!canOverrideDecision\(viewer, isTest\)\) assertListRequestApprover\(viewer, seat, isTest, rowStage\);/, "a list request: the approver check is skipped for him, and only for him");
    assert.doesNotMatch(list, /can only decline/, "a list request: nothing refuses his approval");
    assert.match(list, /This request is waiting for the rep's comment/, "but a request that is with the rep is approved by nobody, him included");

    const unplanned = source("src/lib/phoenix-crm/server/unplanned.ts");
    assert.match(unplanned, /const asAdministrator = canOverrideDecision\(viewer, isTest\);\s+if \(!asAdministrator\) \{\s+assertUnplannedVisitApprover/, "an off-plan visit: the approver check is skipped for him");
    assert.doesNotMatch(unplanned, /can only decline/, "an off-plan visit: nothing refuses his approval");
    assert.match(unplanned, /actor_role: asAdministrator \? "administrator" : viewer\.role/, "and the database records him as the Administrator");

    const edits = source("src/lib/phoenix-crm/server/plan-edits.ts");
    assert.match(edits, /stage: asAdministrator && decision === "refuse" \? "administrator" : stage,/, "a plan edit: his decline is his own stage, his approval takes the step the row is at");
    assert.doesNotMatch(edits, /can only decline/, "a plan edit: nothing refuses his approval");

    for (const file of ["src/lib/phoenix-crm/server/plans.ts", "src/lib/phoenix-crm/server/monthly-plans.ts"]) {
      const text = source(file);
      assert.match(
        text,
        /const asAdministrator = canOverrideDecision\(viewer, isTest\);\s+if \(!asAdministrator\) assertReviewer\(viewer, seat, isTest\);\s+decidedAs = asAdministrator \? "administrator" : "reviewer";/,
        `${file}: he approves a plan in the reviewer's place, and is recorded as the Administrator`,
      );
    }

    const access = source("src/lib/phoenix-crm/server/access.ts");
    assert.match(access, /export function canOverrideDecision\(viewer: PhoenixCrmViewer, isTest: boolean\): boolean \{\s+return !isTest && canAdminister\(viewer\);/, "never on a test entry");
    // He is never a step: none of the functions that answer "does this wait for you" learns about him.
    for (const name of ["canDecideUnplannedVisit", "canDecidePlanEdit", "canDecideListRequest", "canReviewTerritory"]) {
      const body = access.match(new RegExp(`export function ${name}\\([\\s\\S]*?\\n}\\n`))?.[0] ?? "";
      assert.ok(body.length > 0, `${name} is found`);
      assert.doesNotMatch(body, /canAdminister|canOverrideDecision/, `${name} does not count the Administrator as the holder of a step`);
    }
  }

  // ── 2. Nothing waits for him ────────────────────────────────────────────────────────────────────
  {
    const overview = source("src/lib/phoenix-crm/server/overview.ts");
    assert.doesNotMatch(overview, /hrAcknowledgements/, "no 'waiting for you' count holds the Administrator");
    const team = source("src/lib/phoenix-crm/server/team.ts");
    assert.equal((team.match(/canOverride: canOverrideDecision\(viewer, isTest\)/g) ?? []).length, 3, "requests, visits and plan edits carry the flag apart from canDecide");

    const decline = source("src/components/phoenix-crm/administrator-decline.tsx");
    assert.match(decline, /as Administrator/, "the button names him by his title");
    for (const file of [
      "src/components/phoenix-crm/administrator-decline.tsx",
      "src/components/phoenix-crm/plan-edit-card.tsx",
      "src/components/phoenix-crm/request-card.tsx",
      "src/components/phoenix-crm/unplanned-visit-card.tsx",
    ]) {
      const text = source(file);
      const strings = text.match(/"[^"\n]*"|`[^`\n]*`|>[^<>{}\n]+</g) ?? [];
      for (const piece of strings) {
        assert.doesNotMatch(piece, /\bHR\b|overrid/i, `${file} never calls him HR or an override: ${piece}`);
      }
    }
  }

  // ── 3. The notices ──────────────────────────────────────────────────────────────────────────────
  {
    const notify = source("src/lib/phoenix-crm/server/notifications.ts");
    assert.match(notify, /"The Administrator"/, "his decisions are announced by his title");
    assert.doesNotMatch(notify, /hr_pending/, "no notice waits on a step that no longer exists");
  }

  // ── 4. The database ─────────────────────────────────────────────────────────────────────────────
  {
    const sql = readFileSync(new URL("../supabase/migrations/20261008160000_phoenix_crm_administrator_not_hr.sql", import.meta.url), "utf8").replace(/\r\n/g, "\n");
    assert.match(sql, /add column if not exists admin_note text/, "his comment has a column");
    assert.match(sql, /'administrator'/, "the events accept his stage");
    assert.match(sql, /if v_decision = 'refuse' and v_note is null then/, "a decline needs a comment the rep reads");
  }

  // ── 5. Reversing what was already decided ───────────────────────────────────────────────────────
  {
    assert.deepEqual([...ADMINISTRATOR_REVERSAL_KINDS], ["plan_edit", "visit", "request"], "three kinds of decided item");
    assert.equal(isAdministratorReversalKind("plan_edit"), true);
    assert.equal(isAdministratorReversalKind("plan"), false, "a weekly plan is returned, not reversed");
    assert.equal(ADMINISTRATOR_REVERSAL_DAYS, 14);

    const service = source("src/lib/phoenix-crm/server/administrator-reversals.ts");
    assert.match(service, /if \(!canOverrideDecision\(viewer, isTest\)\) return null;/, "no other viewer's payload carries the list");
    assert.match(service, /function assertAdministrator\(viewer: PhoenixCrmViewer, isTest: boolean\): void \{\s+if \(!canOverrideDecision\(viewer, isTest\)\) throw forbiddenError\(/, "only the Administrator, only on a real entry");
    assert.match(service, /if \(!note\) throw validationError\(/, "a comment is required");
    assert.equal((service.match(/assertAdministrator\(viewer, row\.is_test === true\)/g) ?? []).length, 3, "every kind checks WHO before it writes");
    assert.equal((service.match(/reversed: true,/g) ?? []).length, 3, "every kind tells the rep, the district manager and SFE it was a reversal");

    const sql = readFileSync(new URL("../supabase/migrations/20261008190000_phoenix_crm_administrator_reverses.sql", import.meta.url), "utf8").replace(/\r\n/g, "\n").replace(/--.*$/gm, "");
    assert.equal((sql.match(/raise exception 'phoenix_crm:note_required';/g) ?? []).length, 3, "each function needs the comment");
    assert.match(sql, /if v_request\.status <> 'reopened' then/, "only a reopened week closes again");
    assert.match(sql, /or v_plan\.status <> 'draft'\s+or v_plan\.version is distinct from v_request\.reopened_plan_version/, "and only while the rep has not touched it");
    assert.match(sql, /if v_row\.status <> 'approved' then/, "only an approved visit");
    assert.match(sql, /if v_request\.status <> 'approved' or v_request\.customer_id is null then/, "only an approved list request");
    assert.match(sql, /and ev\.created_at > v_request\.decided_at/, "and not once anything else touched that customer");
    assert.equal((sql.match(/grant execute on function public\.phoenix_crm_reverse_/g) ?? []).length, 3, "service role only");

    const panel = source("src/components/phoenix-crm/administrator-reversals-panel.tsx");
    assert.doesNotMatch(panel, /\bHR\b|overrid/i, "the panel never calls him HR or an override");
    const team = source("src/lib/phoenix-crm/server/team.ts");
    assert.match(team, /reversible,\s+summary: \{/, "the Team payload carries the list beside the summary - never counted in it");
    const notify = source("src/lib/phoenix-crm/server/notifications.ts");
    assert.ok((notify.match(/reversed the approval/g) ?? []).length >= 6, "all three kinds word a reversal as a reversal, to the rep and to the managers");
  }

  console.log("phoenix-crm administrator: OK");
}
