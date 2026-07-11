import { strict as assert } from "node:assert";
import { readdirSync, readFileSync } from "node:fs";

function source(path: string) {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

export function runWeeklyPlansRpcContractTests() {
  const migrationsDir = new URL("../supabase/_migrations_archive/pre-baseline-2026-07-11/", import.meta.url);
  const migrations = readdirSync(migrationsDir);
  const atomicMigration = migrations.find((file) => /weekly_plans_atomic_rpcs\.sql$/.test(file));
  const itemMigration = migrations.find((file) => /weekly_plans_atomic_item_replace\.sql$/.test(file));
  assert.ok(
    atomicMigration,
    "expected a weekly_plans_atomic_rpcs.sql migration to exist",
  );
  assert.ok(
    itemMigration,
    "expected a weekly_plans_atomic_item_replace.sql migration to exist",
  );

  const sql = readFileSync(new URL(atomicMigration!, migrationsDir), "utf8");
  const itemSql = readFileSync(new URL(itemMigration!, migrationsDir), "utf8");

  for (const rpc of [
    "phx_weekly_plan_submit",
    "phx_weekly_plan_decide",
    "phx_weekly_plan_acknowledge",
    "phx_weekly_plan_cancel",
  ]) {
    assert.match(
      sql,
      new RegExp(`create or replace function public\\.${rpc}[\\s\\S]*?security definer`, "i"),
      `${rpc} must be defined SECURITY DEFINER`,
    );
    assert.match(
      sql,
      new RegExp(`grant execute on function public\\.${rpc}[^;]*to service_role`, "i"),
      `${rpc} must be GRANTed to service_role only`,
    );
    assert.match(
      sql,
      new RegExp(`revoke execute on function public\\.${rpc}[^;]*from public,\\s*authenticated,\\s*anon`, "i"),
      `${rpc} must REVOKE EXECUTE from public, authenticated, anon`,
    );
  }

  assert.ok(
    (sql.match(/for update/gi) ?? []).length >= 4,
    "state-transition RPCs must lock employee_plan_headers with SELECT FOR UPDATE",
  );
  assert.ok(
    (sql.match(/weekly_plan_revision_conflict/g) ?? []).length >= 4,
    "state-transition RPCs must raise weekly_plan_revision_conflict",
  );
  assert.match(
    sql,
    /create or replace function public\.phx_weekly_plan_next_status/i,
    "phx_weekly_plan_next_status helper must mirror plan-v1.ts transitions in SQL",
  );

  assert.match(
    itemSql,
    /create or replace function public\.phx_weekly_plan_replace_items[\s\S]*?security definer/i,
    "phx_weekly_plan_replace_items must be defined SECURITY DEFINER",
  );
  assert.match(
    itemSql,
    /for update/i,
    "phx_weekly_plan_replace_items must lock the header row",
  );
  assert.match(
    itemSql,
    /weekly_plan_revision_conflict/,
    "phx_weekly_plan_replace_items must raise weekly_plan_revision_conflict",
  );
  assert.match(
    itemSql,
    /weekly_plan_invalid_transition/,
    "phx_weekly_plan_replace_items must raise weekly_plan_invalid_transition",
  );
  assert.match(
    itemSql,
    /weekly_plan_not_found/,
    "phx_weekly_plan_replace_items must raise weekly_plan_not_found",
  );
  assert.match(
    itemSql,
    /delete from public\.employee_plan_items[\s\S]*?where plan_id = p_plan_id/i,
    "phx_weekly_plan_replace_items must delete items inside the RPC transaction",
  );
  assert.match(
    itemSql,
    /insert into public\.employee_plan_items/i,
    "phx_weekly_plan_replace_items must insert items inside the RPC transaction",
  );
  assert.match(
    itemSql,
    /item_activity_date < header_period_start or item_activity_date > header_period_end/i,
    "phx_weekly_plan_replace_items must reject dates outside the plan period",
  );
  assert.match(
    itemSql,
    /public\.phx_weekly_plan_next_status\(current_status,\s*'submit',\s*true\)/i,
    "phx_weekly_plan_replace_items must optionally submit through the SQL state machine",
  );
  assert.match(
    itemSql,
    /revoke execute on function public\.phx_weekly_plan_replace_items[^;]*from public,\s*authenticated,\s*anon/i,
    "phx_weekly_plan_replace_items must REVOKE EXECUTE from public, authenticated, anon",
  );
  assert.match(
    itemSql,
    /grant execute on function public\.phx_weekly_plan_replace_items[^;]*to service_role/i,
    "phx_weekly_plan_replace_items must be GRANTed to service_role only",
  );

  const serviceSource = source("src/lib/weekly-planning/service.ts");
  for (const rpc of [
    "phx_weekly_plan_replace_items",
    "phx_weekly_plan_decide",
    "phx_weekly_plan_acknowledge",
    "phx_weekly_plan_cancel",
  ]) {
    assert.match(
      serviceSource,
      new RegExp(`rpc\\("${rpc}"`),
      `service.ts must call ${rpc} via supabase.rpc()`,
    );
  }
  assert.doesNotMatch(
    serviceSource,
    /async function replacePlanItems/,
    "service.ts must not do service-side item delete/insert outside the RPC",
  );
  assert.match(
    serviceSource,
    /async function rpcReplacePlanItems/,
    "service.ts must expose an internal rpcReplacePlanItems wrapper",
  );
  assert.match(
    serviceSource,
    /rpc\("phx_weekly_plan_replace_items"[\s\S]*?p_submit: input\.submit/,
    "rpcReplacePlanItems must pass the submit flag into the SQL transaction",
  );
  assert.match(
    serviceSource,
    /assertItemDateInPeriod/,
    "service.ts must validate item dates before calling the RPC",
  );
  assert.match(
    serviceSource,
    /activityDate < periodStartDate \|\| activityDate > periodEndDate/,
    "service.ts must reject item dates outside the plan period",
  );

  for (const route of [
    "app/api/weekly-plans/route.ts",
    "app/api/weekly-plans/[id]/route.ts",
    "app/api/weekly-plans/[id]/decision/route.ts",
    "app/api/weekly-plans/[id]/acknowledge/route.ts",
  ]) {
    const routeSource = source(route);
    assert.match(
      routeSource,
      /isWeeklyPlanRpcError/,
      `${route} must surface weekly-plan RPC errors as typed HTTP responses`,
    );
  }

  assert.doesNotMatch(
    serviceSource,
    /from\("employee_plan_headers"\)\.update\(patch\)/,
    "decideEmployeePlan must not write the header outside the phx_weekly_plan_decide RPC",
  );
}
