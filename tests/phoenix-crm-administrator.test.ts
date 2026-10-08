import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { stripComments } from "./support/comment-strip.ts";

/**
 * Phoenix CRM — the Administrator is not a step (owner, 2026-10-08).
 *
 * "Exclude HR from the approvals … make him able to decline, or return with a comment, any decision —
 * but the plan never stops for his approval." And: "call it the Administrator", never HR, never an
 * override. What this file pins, from the emitted source of every approval kind:
 *   1. every approval engine lets him DECLINE and nothing else — the approve path refuses him;
 *   2. nothing is COUNTED as waiting for him, and no screen names him HR or an override;
 *   3. his decline tells the rep, the district manager and SFE, naming him by his title;
 *   4. the database: no `hr_pending`, SFE's yes reopens the week, and a decline needs a comment.
 */

function source(path: string): string {
  return stripComments(readFileSync(new URL(`../${path}`, import.meta.url), "utf8")).replace(/\r\n/g, "\n");
}

export function runPhoenixCrmAdministratorTests(): void {
  // ── 1. Decline only ─────────────────────────────────────────────────────────────────────────────
  {
    const list = source("src/lib/phoenix-crm/server/list.ts");
    assert.match(list, /canOverrideDecision\(viewer, isTest\)\) \{\s+if \(decision !== "refuse"\) throw validationError\(/, "a list request: he declines, never approves");

    const unplanned = source("src/lib/phoenix-crm/server/unplanned.ts");
    assert.match(unplanned, /if \(decision !== "refuse"\) throw validationError\(/, "an off-plan visit: he declines, never approves");
    assert.match(unplanned, /actor_role: asAdministrator \? "administrator" : viewer\.role/, "and the database records him as the Administrator");

    const edits = source("src/lib/phoenix-crm/server/plan-edits.ts");
    assert.match(edits, /"administrator"/, "a plan edit has the Administrator's own stage");

    const access = source("src/lib/phoenix-crm/server/access.ts");
    assert.match(access, /export function canOverrideDecision\(viewer: PhoenixCrmViewer, isTest: boolean\): boolean \{\s+return !isTest && canAdminister\(viewer\);/, "never on a test entry");
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

  console.log("phoenix-crm administrator: OK");
}
