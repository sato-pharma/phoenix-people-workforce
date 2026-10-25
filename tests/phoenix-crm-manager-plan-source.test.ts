import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { stripComments, stripSqlComments } from "./support/comment-strip.ts";

/**
 * THE CROSS-BRANCH HALF of the manager-plan test — the scans of the whole tree that any branch can trip
 * without touching the module: no file outside the module reads a manager-plan table, no migration names
 * his own visits' table, and the screens that show his week go through the one adapter.
 *
 * 🔴 IT IS ITS OWN REGISTRATION, IMPORTING ONLY NODE AND THE COMMENT STRIPPER, SO `scripts/check-contracts.mjs`
 * RUNS IT BEFORE A PUSH. Measured over 18-25 Oct 2026 the manager-plan test turned 9 CI jobs red on 6
 * branches, and the ones that never touched Phoenix CRM (the calendar, CRM team statistics, the admin
 * delete) were all here: a new migration or reader named one of these tables. The rest of the test imports
 * half of `src/lib/phoenix-crm/server`, which the offline contract check cannot load, so the scans had
 * waited for CI and each of those branches learned about them one push late.
 */

function source(path: string): string {
  return stripComments(readFileSync(new URL(`../${path}`, import.meta.url), "utf8")).replace(/\r\n/g, "\n");
}

function filesUnder(dir: string): string[] {
  const root = new URL(`../${dir}/`, import.meta.url);
  const out: string[] = [];
  const walk = (relative: string) => {
    for (const entry of readdirSync(new URL(relative, root), { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      const next = relative ? join(relative, entry.name) : entry.name;
      if (entry.isDirectory()) walk(`${next.replace(/\\/g, "/")}/`);
      else if (/\.(ts|tsx)$/.test(entry.name)) out.push(`${dir}/${next.replace(/\\/g, "/")}`);
    }
  };
  walk("");
  return out;
}

export function runPhoenixCrmManagerPlanSourceTests(): void {
  // ── Nothing outside the module reads the tables, and his visits never reach a KPI ─────────────

  const tableRead = /\.from\(\s*["'`]phoenix_crm_manager_/;
  for (const file of [...filesUnder("src"), ...filesUnder("app")]) {
    if (!tableRead.test(source(file))) continue;
    assert.match(file, /^src\/lib\/phoenix-crm\/server\/manager-[a-z-]+\.ts$/, `${file} reads a manager-plan table directly — outside screens go through manager-plan-readers.ts`);
  }
  // A migration that only CHANGES the table itself reads nothing from it. Named one by one, each may not read
  // it, view it or wrap it in a function; where the value is a pattern, the table may be named only inside it.
  //   * widening — its own columns, checks and comments (null: it names the table wherever it likes);
  //   * planner and autovacuum tuning (2026-10-24) — an `alter table … set (...)` of storage parameters,
  //     which reads nothing, counts nothing and reaches no KPI.
  const changesOwnVisitsOnly = new Map<string, { purpose: string; onlyIn: RegExp | null }>([
    ["20261019103745_phoenix_crm_manager_visit_place.sql", { purpose: "widen his own visits' table", onlyIn: null }],
    ["20261023035106_manager_visit_detail_writeup.sql", { purpose: "widen his own visits' table", onlyIn: null }],
    [
      "20261024200000_every_table_with_data_and_no_statistics_gets_them.sql",
      {
        purpose: "tune his own visits' storage",
        onlyIn: /alter\s+table\s+if\s+exists\s+public\.phoenix_crm_manager_visits\s+set\s*\([^)]*\);/gi,
      },
    ],
  ]);
  const readsOwnVisits = /\b(from|join)\s+(public\.)?phoenix_crm_manager_visits\b|create\s+(or\s+replace\s+)?(view|function|materialized)/i;
  // The Super Admin's delete (owner, 2026-10-23) takes ONE of his visits out by id, with a copy kept. It counts,
  // sums and reports nothing: its only function is that delete, and the table is named in exactly two places.
  const deletesOwnVisitsOnly = new Set(["20261023232001_phoenix_crm_admin_delete_month_and_manager_visit.sql"]);
  for (const file of readdirSync(new URL("../supabase/migrations/", import.meta.url))) {
    if (!file.endsWith(".sql") || file === "20261017000000_phoenix_crm_manager_plan.sql") continue;
    const text = readFileSync(new URL(`../supabase/migrations/${file}`, import.meta.url), "utf8");
    if (deletesOwnVisitsOnly.has(file)) {
      const body = stripSqlComments(text);
      assert.equal(/create\s+(or\s+replace\s+)?(view|materialized)/i.test(body), false, `${file} may not wrap his own visits in a view`);
      assert.deepEqual(
        [...body.matchAll(/create\s+or\s+replace\s+function\s+public\.(\w+)/gi)].map((match) => match[1]),
        ["phoenix_crm_admin_delete"],
        `${file} may create only the delete, never a reader of his own visits`,
      );
      const leftover = body
        .replace(/from public\.phoenix_crm_manager_visits x where x\.id = v_id and x\.is_test = v_is_test for update;/g, "")
        .replace(/delete from public\.phoenix_crm_manager_visits where id = v_id;/g, "");
      assert.equal(leftover.includes("phoenix_crm_manager_visits"), false, `${file} names his own visits only to lock one row and delete it`);
      continue;
    }
    const change = changesOwnVisitsOnly.get(file);
    if (change) {
      const body = stripSqlComments(text);
      assert.equal(readsOwnVisits.test(body), false, `${file} may ${change.purpose}, never read the table into a view, a function or a KPI`);
      if (change.onlyIn) {
        const leftover = body.replace(change.onlyIn, "");
        assert.equal(leftover.includes("phoenix_crm_manager_visits"), false, `${file} names his own visits only to ${change.purpose}`);
      }
      continue;
    }
    assert.equal(text.includes("phoenix_crm_manager_visits"), false, `${file} names his own visits — they count in his own report only, never a view or a KPI`);
  }
  for (const outside of [
    "src/lib/weekly-planning/calendar-service.ts",
    "src/lib/weekly-planning/plan-adherence-data.ts",
    "src/lib/private-calendar/plan-items.ts",
    "src/lib/calendar/service.ts",
    "src/lib/action-center/decided-for-me.ts",
    "src/lib/phoenix-crm/server/visit-report.ts",
    // His own single visits as display rows (owner, 2026-10-20: "Show, keep out of reps"): the Field Activity day.
    "src/lib/field-activity/report.ts",
  ]) {
    const text = source(outside);
    assert.match(text, /@\/lib\/phoenix-crm\/server\/manager-plan-readers/, `${outside} reads his week through the one adapter`);
    assert.equal(/@\/lib\/phoenix-crm\/server\/manager-plan-(rows|queue|report|hub)"/.test(text), false, `${outside} never reaches past the adapter`);
    assert.equal(text.includes("phoenix_crm_manager_visits"), false, `${outside} never names his own visits' table`);
  }
  // 🔴 THE DISPLAY ROWS LIVE IN THE ADAPTER (owner, 2026-10-20, multiple choice: "Show, keep out of reps — his own
  // visits appear under his name in the Visit Report and the Field Activity day, never in a rep's totals"). Both
  // screens reach his own visits through `loadManagerOwnVisitRows`, which hands back the detail reader's records and
  // nothing else — no count, no rate, nothing a KPI could be built from.
  {
    const adapter = source("src/lib/phoenix-crm/server/manager-plan-readers.ts");
    assert.match(adapter, /export async function loadManagerOwnVisitRows\(input: \{/, "the display-row reader is the adapter's");
    assert.match(
      adapter,
      /return readOwnVisitDetails\(\{ end: input\.end, isTest: input\.isTest \?\? false, managerHrIds: input\.managerHrIds, start: input\.start \}\);/,
      "and it is the detail reader's own records, read for exactly the managers and days asked",
    );
    assert.match(
      adapter,
      /import \{ loadManagerOwnVisitDetails as readOwnVisitDetails \} from "@\/lib\/phoenix-crm\/server\/manager-visit-details";/,
      "through the one manager-*.ts file that reads the table",
    );
    for (const screen of ["src/lib/phoenix-crm/server/visit-report.ts", "src/lib/field-activity/report.ts"]) {
      assert.match(source(screen), /loadManagerOwnVisitRows\(\{/, `${screen} reads his own visits as display rows`);
    }
  }
  for (const quiet of ["src/lib/phoenix-crm/server/manager-plan-readers.ts", "src/lib/phoenix-crm/server/manager-plan-queue.ts"]) {
    assert.equal(/from "@\/lib\/(notifications\/|phoenix-crm\/server\/notifications)/.test(source(quiet)), false, `${quiet} imports no notice sender — it would close the import cycle through notifications/in-app.ts`);
  }
}
