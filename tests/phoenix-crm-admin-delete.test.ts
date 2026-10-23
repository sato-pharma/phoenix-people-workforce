import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { stripComments } from "./support/comment-strip.ts";

import {
  adminDeleteTargetOfManagerDayVisit,
  ADMIN_DELETE_KINDS,
  ADMIN_DELETE_WORDS,
  isAdminDeleteKind,
  parseAdminDelete,
} from "../src/lib/phoenix-crm/admin-delete-rules.ts";
import {
  phoenixCrmMonthlyNoticeKeyPrefix,
  phoenixCrmPlanEditNoticeKeyPrefix,
  phoenixCrmPlanNoticeKeyPrefix,
} from "../src/lib/phoenix-crm/server/notifications.ts";

/**
 * Phoenix CRM — the Super Admin deletes a plan, a visit or a day record as if it never happened
 * (owner, 2026-10-23: "in every weekly plan, every visit, every record, for the admin only, make admin
 * tools — delete this record or this plan as if it did not happen").
 *
 * Pinned here: the four kinds and what each says; the parse; that the database keeps a copy BEFORE the
 * first row goes, and clears every child before its parent; that the service is the Super Admin's alone
 * and withdraws notices only AFTER the database has deleted; and that every screen draws the button only
 * from the server's own `adminDeletes` answer.
 */

const ID = "11111111-2222-4333-8444-555555555555";

function raw(path: string): string {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

function source(path: string): string {
  return stripComments(raw(path));
}

export async function runPhoenixCrmAdminDeleteTests(): Promise<void> {
  // ── 1 · The kinds and the parse ─────────────────────────────────────────────────────────────────
  {
    assert.deepEqual([...ADMIN_DELETE_KINDS], ["rep_plan", "manager_plan", "visit", "day_activity", "monthly_plan", "manager_visit"]);
    for (const kind of ADMIN_DELETE_KINDS) {
      assert.equal(isAdminDeleteKind(kind), true);
      assert.ok(ADMIN_DELETE_WORDS[kind].button.length > 0 && ADMIN_DELETE_WORDS[kind].takes.length > 0, `${kind} says what it deletes`);
    }
    assert.equal(isAdminDeleteKind("payroll_row"), false, "only the six kinds");
    assert.equal(isAdminDeleteKind("double_visit_plan"), false, "the retired double-visit planner has no screen, so no kind");

    // A card on a manager's day names where its visit came from: his own table, or a rep's visit.
    assert.deepEqual(adminDeleteTargetOfManagerDayVisit(`own:${ID}`), { kind: "manager_visit", id: ID });
    assert.deepEqual(adminDeleteTargetOfManagerDayVisit(`rep:${ID}`), { kind: "visit", id: ID });
    assert.deepEqual(adminDeleteTargetOfManagerDayVisit(`ride:${ID}:B-9`), { kind: "visit", id: ID });
    assert.equal(adminDeleteTargetOfManagerDayVisit("own:not-an-id"), null);
    assert.equal(adminDeleteTargetOfManagerDayVisit(`other:${ID}`), null, "a source this tool cannot name draws no button");
    assert.equal(isAdminDeleteKind(undefined), false);

    assert.deepEqual(parseAdminDelete({ kind: "visit", id: ID.toUpperCase() }), { ok: true, value: { kind: "visit", id: ID } });
    assert.equal(parseAdminDelete({ kind: "visit", id: "not-an-id" }).ok, false, "a record is named by its id");
    assert.equal(parseAdminDelete({ kind: "everything", id: ID }).ok, false, "an unknown kind is refused");
    assert.equal(parseAdminDelete(null).ok, false);
  }

  // ── 2 · The database: a copy first, children before parents, the service role alone ─────────────
  {
    const sql = raw("supabase/migrations/20261023223001_phoenix_crm_admin_delete_anything.sql");
    assert.match(sql, /revoke execute on function public\.phoenix_crm_admin_delete\(jsonb\) from public, anon, authenticated;/);
    assert.match(sql, /grant execute on function public\.phoenix_crm_admin_delete\(jsonb\) to service_role;/);
    assert.match(sql, /revoke all on table public\.phoenix_crm_admin_deletions from public, anon, authenticated;/);

    // Per kind: the copy is written before the first delete of that kind.
    const branches = sql.split(/\n  (?:elsif|if) v_kind = /).slice(1);
    assert.equal(branches.length, 4, "one branch for each kind");
    for (const branch of branches) {
      const copyAt = branch.indexOf("insert into public.phoenix_crm_admin_deletions");
      const deleteAt = branch.indexOf("delete from");
      assert.ok(copyAt > 0 && copyAt < deleteAt, "the copy is kept before a single row is deleted");
    }

    // A rep's plan: every child and the edit requests' events, then the plan itself.
    const plan = branches[0];
    const planAt = plan.indexOf("delete from public.phoenix_crm_plans where id = v_id;");
    for (const child of [
      "phoenix_crm_plan_edit_request_events",
      "phoenix_crm_plan_edit_requests",
      "phoenix_crm_plan_items",
      "phoenix_crm_plan_activities",
      "phoenix_crm_plan_day_starts",
      "phoenix_crm_plan_events",
      "phoenix_crm_team_start_notices",
    ]) {
      const at = plan.indexOf(`delete from public.${child} `);
      assert.ok(at > 0 && at < planAt, `${child} goes before the plan`);
    }

    // A visit: the unplanned approval's events, then the approval, then the visit — and a linked visit goes with it.
    const visit = branches[2];
    assert.match(visit, /with recursive family as/, "a visit linked from it goes with it, because that foreign key cascades");
    const eventsAt = visit.indexOf("delete from public.phoenix_crm_unplanned_visit_events");
    const approvalAt = visit.indexOf("delete from public.phoenix_crm_unplanned_visits ");
    const visitAt = visit.indexOf("delete from public.phoenix_crm_visits where id = any (v_ids);");
    assert.ok(eventsAt > 0 && eventsAt < approvalAt && approvalAt < visitAt, "events, then the approval, then the visit");
    assert.match(visit, /update public\.phoenix_crm_visit_asks set visit_id = null/, "an ask that pointed at it is kept, un-linked");
    assert.match(visit, /update public\.phoenix_crm_double_visit_requests set visit_id = null/, "a double-visit request is kept, un-linked");

    // Every delete and update in the function carries its own where — an unqualified one 400s through PostgREST.
    for (const statement of sql.match(/^\s*(?:delete from|update) public\.[^;]*;/gm) ?? []) {
      assert.match(statement, /\bwhere\b/i, `qualified: ${statement.trim().slice(0, 80)}`);
    }
  }

  // ── 3 · The service: the Super Admin alone, notices only after the database has deleted ─────────
  {
    const service = source("src/lib/phoenix-crm/server/admin-delete.ts");
    assert.match(service, /if \(!canEnterMissedRecords\(viewer\)\) throw forbiddenError\(/, "the Super Admin alone, never a test persona");
    const callAt = service.indexOf('callPhoenixCrm<Row>("phoenix_crm_admin_delete"');
    const withdrawPlanAt = service.indexOf("await withdrawPhoenixCrmPlanNotices(");
    const withdrawVisitAt = service.indexOf("await withdrawPhoenixCrmVisitNotices(");
    assert.ok(callAt > 0 && callAt < withdrawPlanAt && callAt < withdrawVisitAt, "notices are withdrawn AFTER the database deleted");
    assert.match(service, /actor_hr_id: viewer\.hrId/, "the one asking is the viewer, never the screen's word");

    const route = source("app/api/phoenix-crm/admin-delete/route.ts");
    assert.match(route, /assertSameOriginMutation\(request\)/);
    assert.match(route, /assertPermission\(access, "phoenix_crm", "update"\)/);
    assert.doesNotMatch(route, /export async function GET/, "a mutation only");

    const registry = source("src/lib/security/access-registry.ts");
    assert.match(registry, /pattern: "\/api\/phoenix-crm\/admin-delete"/, "the route is declared in the access registry");

    assert.equal(phoenixCrmPlanNoticeKeyPrefix(ID), `phoenix_crm:plan:${ID}:`, "the prefix every plan notice was written under");
    assert.equal(phoenixCrmPlanEditNoticeKeyPrefix(ID), `phoenix_crm:plan_edit:${ID}:`, "the prefix every edit-request notice was written under");
    const notifications = source("src/lib/phoenix-crm/server/notifications.ts");
    assert.match(notifications, /idempotencyKey: `phoenix_crm:plan:\$\{notice\.planId\}:v\$\{notice\.version\}:submitted`/, "the key a plan notice is written under is the prefix's own");
  }

  // ── 4 · The screens: drawn only from the server's own answer ───────────────────────────────────
  {
    const week = source("src/components/phoenix-crm/plan-week-panel.tsx");
    assert.match(week, /adminDelete && plan \? \(\s*<div[^>]*>\s*<AdminDelete id=\{plan\.planId\}[^>]*kind="rep_plan"/, "a rep's week");
    const board = source("src/components/phoenix-crm/plan-board.tsx");
    assert.match(board, /adminDelete=\{view\.adminDeletes && selected\.week\.plan \?/);
    const manager = source("src/components/phoenix-crm/manager-plan-board.tsx");
    assert.match(manager, /view\.adminDeletes && plan\.planId \? \(\s*<div[^>]*>\s*<AdminDelete[^>]*kind="manager_plan"/, "a manager's week");
    const day = source("src/components/phoenix-crm/day-detail-view.tsx");
    assert.match(day, /kind="day_activity"/, "the day's record");
    assert.match(day, /kind="visit"/, "a visit");
    for (const file of [
      "src/lib/phoenix-crm/server/monthly-plans.ts",
      "src/lib/phoenix-crm/server/manager-plans.ts",
      "src/lib/phoenix-crm/server/day-detail.ts",
    ]) {
      assert.match(source(file), /adminDeletes: canEnterMissedRecords\(viewer\)/, `${file} answers from the Super Admin gate`);
    }

    const button = source("src/components/phoenix-crm/admin-delete.tsx");
    assert.match(button, /setConfirming\(true\)/, "asks once more before it goes");
    assert.match(button, /A copy is kept\./, "says a copy is kept");
  }

  // ── 5 · A month's plan and a manager's own visit (the second migration) ────────────────────────
  {
    const sql = raw("supabase/migrations/20261023232001_phoenix_crm_admin_delete_month_and_manager_visit.sql");
    assert.match(sql, /check \(kind in \('rep_plan', 'manager_plan', 'visit', 'day_activity', 'monthly_plan', 'manager_visit'\)\)/, "the log admits both new kinds");
    assert.match(sql, /revoke execute on function public\.phoenix_crm_admin_delete\(jsonb\) from public, anon, authenticated;/);
    assert.match(sql, /grant execute on function public\.phoenix_crm_admin_delete\(jsonb\) to service_role;/);

    const branches = sql.split(/\n  (?:elsif|if) v_kind = /).slice(1);
    assert.equal(branches.length, 6, "the four old kinds are kept, and two are added");
    for (const branch of branches) {
      const copyAt = branch.indexOf("insert into public.phoenix_crm_admin_deletions");
      const deleteAt = branch.indexOf("delete from");
      assert.ok(copyAt > 0 && copyAt < deleteAt, "the copy is kept before a single row is deleted");
    }

    // A month: its weeks are the plans whose Saturday falls in it, each deleted through the same function
    // (so each keeps its own copy), and only then the month's history and header.
    const month = branches[4];
    assert.match(month, /pl\.week_start >= \(v_record ->> 'month_start'\)::date/);
    assert.match(month, /pl\.week_start < \(\(v_record ->> 'month_start'\)::date \+ interval '1 month'\)::date/, "a week belongs to the month its Saturday falls in");
    assert.match(month, /pl\.seat_id = v_seat/, "only this seat's weeks");
    const weeksAt = month.indexOf("public.phoenix_crm_admin_delete(");
    const eventsAt = month.indexOf("delete from public.phoenix_crm_monthly_plan_events where monthly_plan_id = v_id;");
    const headerAt = month.indexOf("delete from public.phoenix_crm_monthly_plans where id = v_id;");
    assert.ok(weeksAt > 0 && weeksAt < eventsAt && eventsAt < headerAt, "weeks, then the month's history, then its header");

    // A manager's own visit is a row on its own.
    const visit = branches[5];
    assert.match(visit, /delete from public\.phoenix_crm_manager_visits where id = v_id;/);
    assert.match(visit, /raise exception 'phoenix_crm:visit_not_found'/);

    for (const statement of sql.match(/^\s*(?:delete from|update) public\.[^;]*;/gm) ?? []) {
      assert.match(statement, /\bwhere\b/i, `qualified: ${statement.trim().slice(0, 80)}`);
    }

    // The service withdraws the month's notices and each week's, after the database has deleted.
    const service = source("src/lib/phoenix-crm/server/admin-delete.ts");
    assert.match(service, /kind === "monthly_plan"/);
    assert.match(service, /for \(const week of weeks\)/, "every week the month took with it");
    assert.ok(service.indexOf("callPhoenixCrm") < service.indexOf("for (const week of weeks)"), "after the database deleted");
    assert.equal(phoenixCrmMonthlyNoticeKeyPrefix(ID), `phoenix_crm:monthly:${ID}:`, "the prefix every monthly notice was written under");
    const notifications = source("src/lib/phoenix-crm/server/notifications.ts");
    assert.match(notifications, /idempotencyKey: `phoenix_crm:monthly:\$\{notice\.monthlyPlanId\}:v\$\{notice\.version\}:submitted`/, "the key a monthly notice is written under is the prefix's own");

    // The screens: a month on the planner, a visit on a manager's day — each from the server's own answer.
    const board = source("src/components/phoenix-crm/plan-board.tsx");
    assert.match(board, /view\.adminDeletes && view\.plan \? \(\s*<div[^>]*>\s*<AdminDelete[^>]*kind="monthly_plan"/, "a month's plan");
    const dayView = source("src/components/phoenix-crm/manager-day-view.tsx");
    assert.match(dayView, /view\.adminDeletes && visits\.length > 0/);
    assert.match(dayView, /adminDeleteTargetOfManagerDayVisit\(visit\.id\)/);
    assert.match(source("src/lib/phoenix-crm/server/manager-day-detail.ts"), /adminDeletes: canEnterMissedRecords\(viewer\)/);
  }
}
