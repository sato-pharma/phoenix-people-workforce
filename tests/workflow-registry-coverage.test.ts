import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stripComments, stripSqlComments } from "./support/comment-strip.ts";
import { parseRoleStrict } from "../src/lib/auth/permissions.ts";
import { AUTOMATED_PAYROLL_RUN_TRANSITIONS } from "../src/lib/automated-payroll/run-transitions.ts";
import { MARKET_AWARENESS_STATUSES } from "../src/lib/market-awareness/types.ts";
import { REPORT_IT_TRANSITIONS } from "../src/lib/report-it/lifecycle.ts";
import { REPORT_IT_STATUSES } from "../src/lib/report-it/types.ts";
import { MARKET_AWARENESS_TRANSITIONS } from "../src/lib/market-awareness/workflow.ts";
import { assertMarketAwarenessRegistryTransition } from "../src/lib/market-awareness/workflow-registry.ts";
import { EMPLOYEE_PLAN_TRANSITIONS, EmployeePlanWorkflowError, employeePlanStatuses } from "../src/lib/weekly-planning/plan-v1.ts";
import { assertEmployeePlanRegistryTransition } from "../src/lib/weekly-planning/plan-registry.ts";
import { WEEKLY_PLAN_STATUSES, WEEKLY_PLAN_TRANSITIONS } from "../src/lib/weekly-planning/workflow.ts";
import { listWorkflowDomains } from "../src/lib/workflow-control/definitions.ts";
import { assertRegistryAgreesWithCodeTransition } from "../src/lib/workflow-registry/code-fallback.ts";
import { isWorkflowRegistryTransitionError, type WorkflowRegistryModule } from "../src/lib/workflow-registry/service.ts";

/**
 * EVERY TRANSITION TABLE IN CODE HAS A REGISTRY ROW AND A WORKFLOW CONTROL MAP ENTRY (audit item REC-005).
 *
 * Phoenix keeps state machines in two places: TypeScript tables under src/lib/, and rows in
 * `workflow_registry_modules`. Before REC-005 four machines (legacy weekly plans, employee plans,
 * market awareness, the automated payroll run) lived only in code, so the Workflow Registry and the
 * Workflow Control map showed a smaller company than the one that runs. This test:
 *
 *  1. scans comment-stripped src/lib for every `*_TRANSITIONS` / `*Transitions` table, every
 *     `claimTransition(` site and every registry-helper call, and FAILS, naming the file, on one whose
 *     module key is not seeded by a migration or not listed on the Workflow Control map;
 *  2. holds every map `registryModuleKey` to a seeded row;
 *  3. holds each REC-005 seed EQUAL to its code table (from, to, reason), and the automated payroll
 *     table equal to the six claimTransition sites in run-service.ts;
 *  4. proves the code-table fallback: no row or an unreadable registry decides by code alone; a copy
 *     agrees; a row that disagrees refuses.
 *
 * A NEW TABLE: seed its module in a migration (`on conflict (module_key) do nothing`), add a subflow
 * with that `registryModuleKey` to src/lib/workflow-control/definitions.ts, and add it to CODE_TABLES
 * below. A table that is not a workflow goes in NOT_WORKFLOWS with its reason.
 */

type CodeTable = { file: string; moduleKey: string };

/** Each transition table in src/lib → the registry module that records it. */
const CODE_TABLES: Record<string, CodeTable> = {
  WEEKLY_PLAN_TRANSITIONS: { file: "src/lib/weekly-planning/workflow.ts", moduleKey: "weekly_plans" },
  EMPLOYEE_PLAN_TRANSITIONS: { file: "src/lib/weekly-planning/plan-v1.ts", moduleKey: "employee_plans" },
  MARKET_AWARENESS_TRANSITIONS: { file: "src/lib/market-awareness/workflow.ts", moduleKey: "market_awareness" },
  AUTOMATED_PAYROLL_RUN_TRANSITIONS: { file: "src/lib/automated-payroll/run-transitions.ts", moduleKey: "automated_payroll_runs" },
  payrollTransitions: { file: "src/lib/payroll/workflow.ts", moduleKey: "payroll_batches" },
  REPORT_IT_TRANSITIONS: { file: "src/lib/report-it/lifecycle.ts", moduleKey: "report_it" },
};

const REPORT_IT_MIGRATION = "supabase/migrations/20261113211605_register_report_it_workflow.sql";
/** REPORT_IT_TRANSITIONS is keyed by status, not action: the registry names each move by where it lands. */
const REPORT_IT_ACTION_BY_DESTINATION: Record<string, string> = { under_assessment: "start_assessment", closed: "close" };

/** Files that move a row with claimTransition(...) → the registry module that records the machine. */
const CLAIM_SITES: Record<string, string> = {
  "src/lib/automated-payroll/run-service.ts": "automated_payroll_runs",
};

/** Names that match the scan but are not workflows — each with its reason. */
const NOT_WORKFLOWS: Record<string, string> = {
  CAIRO_ZONE_TRANSITIONS: "the Africa/Cairo UTC-offset changes (daylight saving), a time-zone table, not a workflow",
};

const REGISTRY_HELPERS = [
  "assertWorkflowRegistryTransition",
  "assertWorkflowRegistryRuntimeTransition",
  "resolveWorkflowRegistryTransition",
  "assertRegistryAgreesWithCodeTransition",
];

const REC005_MIGRATION = "supabase/migrations/20261113201813_register_remaining_workflows.sql";
const THIS_TEST = "tests/workflow-registry-coverage.test.ts";

type SeedAction = { key: string; from: string[]; to: string; requiresReason: boolean; allowedRoles: string[]; tests?: string[] };
type SeedStatus = { key: string; terminal: boolean };
type Seed = { file: string; moduleKey: string; statuses: SeedStatus[] | null; actions: SeedAction[] | null };

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rel = (full: string) => path.relative(repoRoot, full).split(path.sep).join("/");

/** The phase the latest phx_reopen_automated_payroll_part1 sets on the run, read from its migration. */
function reopenFunctionPhase(): string {
  const dir = path.join(repoRoot, "supabase/migrations");
  const files = readdirSync(dir).filter((name) => name.endsWith(".sql")).sort().reverse();
  for (const name of files) {
    const sql = stripSqlComments(readFileSync(path.join(dir, name), "utf8"));
    if (!/create\s+or\s+replace\s+function\s+public\.phx_reopen_automated_payroll_part1\s*\(/i.test(sql)) continue;
    const write = /update\s+public\.automated_payroll_runs\s+set\s+phase\s*=\s*'([^']+)'/i.exec(sql);
    assert.ok(write, `${name}: phx_reopen_automated_payroll_part1 writes no phase on the run`);
    return write[1];
  }
  assert.fail("no migration creates phx_reopen_automated_payroll_part1, which reopenPart1Atomically calls");
}

function walk(dir: string, onFile: (file: string) => void) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, onFile);
    else onFile(full);
  }
}

/** Splits `a, (b, c), 'd,e'` at top-level commas, honouring SQL quotes and parentheses. */
function splitTopLevel(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let inQuote = false;
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inQuote) {
      if (ch === "'") {
        if (text[i + 1] === "'") i += 1;
        else inQuote = false;
      }
      continue;
    }
    if (ch === "'") inQuote = true;
    else if (ch === "(" || ch === "[" || ch === "{") depth += 1;
    else if (ch === ")" || ch === "]" || ch === "}") depth -= 1;
    else if (ch === "," && depth === 0) {
      parts.push(text.slice(start, i).trim());
      start = i + 1;
    }
  }
  parts.push(text.slice(start).trim());
  return parts;
}

/** The parenthesised tuples after VALUES, up to the statement's end, quote-aware. */
function valueTuples(sql: string, from: number): string[] {
  const tuples: string[] = [];
  let depth = 0;
  let inQuote = false;
  let tupleStart = -1;
  for (let i = from; i < sql.length; i += 1) {
    const ch = sql[i];
    if (inQuote) {
      if (ch === "'") {
        if (sql[i + 1] === "'") i += 1;
        else inQuote = false;
      }
      continue;
    }
    if (ch === "'") inQuote = true;
    else if (ch === "(") {
      if (depth === 0) tupleStart = i + 1;
      depth += 1;
    } else if (ch === ")") {
      depth -= 1;
      if (depth === 0) tuples.push(sql.slice(tupleStart, i));
    } else if (depth === 0 && (ch === ";" || /^on\s+conflict\b/i.test(sql.slice(i, i + 12)))) break;
  }
  return tuples;
}

const sqlString = (literal: string) => {
  const match = /^'([\s\S]*)'(?:::\w+)?$/.exec(literal.trim());
  return match ? match[1].replace(/''/g, "'") : null;
};

function parseJsonLiteral<T>(literal: string | undefined): T | null {
  if (!literal) return null;
  const text = sqlString(literal);
  if (text === null) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

/** Every workflow_registry_modules row any migration inserts, with its file. */
function readSeeds(): Seed[] {
  const seeds: Seed[] = [];
  const dirs = ["supabase/migrations", "supabase/_migrations_archive/pre-baseline-2026-07-11"];
  for (const dir of dirs) {
    const files: string[] = [];
    walk(path.join(repoRoot, dir), (file) => {
      if (file.endsWith(".sql")) files.push(file);
    });
    for (const file of files.sort()) {
      const sql = stripSqlComments(readFileSync(file, "utf8"));
      const insert = /insert\s+into\s+(?:public\.)?workflow_registry_modules\s*\(([^)]*)\)\s*values/gi;
      for (let match = insert.exec(sql); match; match = insert.exec(sql)) {
        const columns = match[1].split(",").map((column) => column.trim());
        const at = (name: string) => columns.indexOf(name);
        assert.ok(at("module_key") >= 0, `${rel(file)}: a workflow_registry_modules insert names no module_key column`);
        for (const tuple of valueTuples(sql, match.index + match[0].length)) {
          const values = splitTopLevel(tuple);
          const moduleKey = sqlString(values[at("module_key")] ?? "");
          assert.ok(moduleKey, `${rel(file)}: a workflow_registry_modules row's module_key is not a plain string`);
          seeds.push({
            actions: parseJsonLiteral<SeedAction[]>(values[at("actions")]),
            file: rel(file),
            moduleKey,
            statuses: parseJsonLiteral<SeedStatus[]>(values[at("statuses")]),
          });
        }
      }
    }
  }
  return seeds;
}

const sameSet = (a: readonly string[], b: readonly string[]) =>
  a.length === new Set(a).size && [...a].sort().join("|") === [...b].sort().join("|");

/** Compares a seed with a code table; the message names the action that differs. */
function assertSeedEqualsCode(
  moduleKey: string,
  seed: Seed,
  code: Map<string, { from: readonly string[]; to: string; requiresReason?: boolean }>,
  statuses: readonly string[],
) {
  assert.ok(seed.actions && seed.statuses, `${moduleKey}: the seed's statuses and actions must be JSON literals`);
  assert.ok(
    sameSet(seed.statuses.map((status) => status.key), statuses),
    `${moduleKey}: the seed's statuses must equal the code's statuses`,
  );
  assert.ok(
    sameSet(seed.actions.map((action) => action.key), [...code.keys()]),
    `${moduleKey}: the seed's action keys must equal the code table's (seed ${seed.actions.map((a) => a.key).join(", ")}; code ${[...code.keys()].join(", ")})`,
  );
  for (const action of seed.actions) {
    const row = code.get(action.key)!;
    assert.ok(
      sameSet(action.from, row.from),
      `${moduleKey}.${action.key}: the seed leaves from [${action.from.join(", ")}] but the code table from [${row.from.join(", ")}]`,
    );
    assert.equal(action.to, row.to, `${moduleKey}.${action.key}: the seed lands on "${action.to}" but the code table on "${row.to}"`);
    if (row.requiresReason !== undefined) {
      assert.equal(action.requiresReason, row.requiresReason, `${moduleKey}.${action.key}: requiresReason differs from the code table`);
    }
  }
}

function asModule(moduleKey: string, seed: Seed, isActive = true): WorkflowRegistryModule {
  return {
    actions: (seed.actions ?? []).map((action) => ({
      allowedRoles: [],
      auditLog: "",
      from: [...action.from],
      key: action.key,
      label: action.key,
      notifications: [],
      requiresReason: action.requiresReason,
      sideEffects: [],
      tests: [],
      to: action.to,
    })),
    createdAt: "",
    createdBy: "system",
    description: "",
    id: moduleKey,
    isActive,
    moduleKey,
    moduleName: moduleKey,
    statuses: [],
    updatedAt: "",
    updatedBy: "system",
    version: 1,
  } as WorkflowRegistryModule;
}

async function rejects(promise: Promise<unknown>, check: (error: unknown) => boolean, message: string) {
  try {
    await promise;
  } catch (error) {
    assert.ok(check(error), `${message} (wrong error: ${error instanceof Error ? error.message : String(error)})`);
    return;
  }
  assert.fail(`${message} (it did not refuse)`);
}

export async function runWorkflowRegistryCoverageTests() {
  const seeds = readSeeds();
  const seededKeys = new Set(seeds.map((seed) => seed.moduleKey));
  const mapKeys = new Set<string>();
  for (const domain of listWorkflowDomains()) {
    for (const subflow of domain.subflows) {
      if (subflow.registryModuleKey) mapKeys.add(subflow.registryModuleKey);
    }
  }

  // ── 1. Every Workflow Control map registryModuleKey is a seeded registry row ────────────────
  for (const key of mapKeys) {
    assert.ok(seededKeys.has(key), `the Workflow Control map names registry module "${key}", which no migration seeds`);
  }

  const requireRegistered = (moduleKey: string, where: string) => {
    assert.ok(seededKeys.has(moduleKey), `${where}: registry module "${moduleKey}" is not seeded by any migration`);
    assert.ok(
      mapKeys.has(moduleKey),
      `${where}: registry module "${moduleKey}" has no subflow on the Workflow Control map (src/lib/workflow-control/definitions.ts)`,
    );
  };

  // ── 2. Scan src/lib for transition tables, claim sites and registry-helper calls ───────────
  const stringConstants = new Map<string, string>();
  const foundTables = new Map<string, string>();
  const foundClaimFiles = new Set<string>();
  const helperCalls: { file: string; moduleKey: string }[] = [];

  walk(path.join(repoRoot, "src", "lib"), (full) => {
    if (!full.endsWith(".ts") && !full.endsWith(".tsx")) return;
    const file = rel(full);
    const source = stripComments(readFileSync(full, "utf8"));

    for (const m of source.matchAll(/\bconst\s+([A-Za-z_]\w*)\s*(?::\s*string\s*)?=\s*"([^"]+)"/g)) {
      stringConstants.set(m[1], m[2]);
    }
    for (const m of source.matchAll(/\bconst\s+([A-Z][A-Z0-9_]*_TRANSITIONS|[a-z][A-Za-z0-9]*Transitions)\b/g)) {
      const previous = foundTables.get(m[1]);
      assert.ok(!previous || previous === file, `transition table ${m[1]} is defined twice: ${previous} and ${file}`);
      foundTables.set(m[1], file);
    }
    if (/(?<!function\s)\bclaimTransition\s*\(/.test(source)) foundClaimFiles.add(file);
    if (!file.startsWith("src/lib/workflow-registry/")) {
      for (const helper of REGISTRY_HELPERS) {
        const call = new RegExp(`\\b${helper}\\s*\\(\\s*\\{([\\s\\S]*?)\\}\\s*\\)`, "g");
        for (const m of source.matchAll(call)) {
          const key = /\bmoduleKey\s*:\s*(?:"([^"]+)"|([A-Za-z_]\w*))/.exec(m[1]);
          assert.ok(key, `${file}: a ${helper}(...) call passes no moduleKey this test can read`);
          helperCalls.push({ file, moduleKey: key[1] ?? key[2] });
        }
      }
    }
  });

  for (const [name, file] of foundTables) {
    if (NOT_WORKFLOWS[name]) continue;
    const entry = CODE_TABLES[name];
    assert.ok(
      entry,
      `${file}: transition table ${name} has no registry entry. Seed its module in a migration, add a ` +
        `subflow with that registryModuleKey to src/lib/workflow-control/definitions.ts, and add ${name} to ` +
        `CODE_TABLES in ${THIS_TEST} (or to NOT_WORKFLOWS with the reason it is not a workflow).`,
    );
    assert.equal(file, entry.file, `${name} moved from ${entry.file} to ${file}; update CODE_TABLES`);
    requireRegistered(entry.moduleKey, `${file}: ${name}`);
  }
  for (const [name, entry] of Object.entries(CODE_TABLES)) {
    assert.equal(foundTables.get(name), entry.file, `CODE_TABLES names ${name} in ${entry.file}, which the scan no longer finds`);
  }
  for (const name of Object.keys(NOT_WORKFLOWS)) {
    assert.ok(foundTables.has(name), `NOT_WORKFLOWS names ${name}, which the scan no longer finds; remove it`);
  }

  for (const file of foundClaimFiles) {
    const moduleKey = CLAIM_SITES[file];
    assert.ok(moduleKey, `${file}: moves a row with claimTransition(...) but has no registry entry; add it to CLAIM_SITES in ${THIS_TEST}`);
    requireRegistered(moduleKey, `${file}: claimTransition`);
  }

  assert.ok(helperCalls.length >= 10, `the scan found only ${helperCalls.length} registry-helper calls; the pattern has rotted`);
  for (const call of helperCalls) {
    const moduleKey = stringConstants.get(call.moduleKey) ?? call.moduleKey;
    assert.ok(/^[a-z][a-z0-9_]*$/.test(moduleKey), `${call.file}: registry module key ${call.moduleKey} does not resolve to a string`);
    requireRegistered(moduleKey, `${call.file}: registry helper`);
  }
  for (const [name, value] of stringConstants) {
    if (name.endsWith("WorkflowRegistryModuleKey")) requireRegistered(value, `constant ${name}`);
  }

  // ── 3. Each REC-005 seed equals its code table, exactly ──────────────────────────────────────
  const rec005 = (moduleKey: string) => {
    const rows = seeds.filter((seed) => seed.moduleKey === moduleKey);
    assert.equal(rows.length, 1, `${moduleKey} must be seeded exactly once (found ${rows.map((r) => r.file).join(", ") || "none"})`);
    assert.equal(rows[0].file, REC005_MIGRATION, `${moduleKey} is seeded by ${REC005_MIGRATION}`);
    return rows[0];
  };

  assertSeedEqualsCode(
    "weekly_plans",
    rec005("weekly_plans"),
    new Map(Object.entries(WEEKLY_PLAN_TRANSITIONS).map(([key, t]) => [key, { from: t.from, requiresReason: t.requiresReason, to: t.to }])),
    WEEKLY_PLAN_STATUSES,
  );
  assertSeedEqualsCode(
    "employee_plans",
    rec005("employee_plans"),
    new Map(
      Object.entries(EMPLOYEE_PLAN_TRANSITIONS).map(([key, t]) => [
        key,
        { from: t.from, requiresReason: Boolean((t as { requiresComment?: boolean }).requiresComment), to: t.to },
      ]),
    ),
    employeePlanStatuses,
  );
  const awareness = new Map<string, { from: string[]; to: string }>();
  for (const t of MARKET_AWARENESS_TRANSITIONS) {
    const row = awareness.get(t.action);
    if (row) {
      assert.equal(row.to, t.to, `market awareness ${t.action} has two destinations in code; one registry action cannot hold both`);
      row.from.push(t.from);
    } else awareness.set(t.action, { from: [t.from], to: t.to });
  }
  assertSeedEqualsCode("market_awareness", rec005("market_awareness"), awareness, MARKET_AWARENESS_STATUSES);
  assertSeedEqualsCode(
    "automated_payroll_runs",
    rec005("automated_payroll_runs"),
    new Map(AUTOMATED_PAYROLL_RUN_TRANSITIONS.map((t) => [t.action, { from: t.from, to: t.to }])),
    ["part1", "part2", "ready", "published", "cancelled"],
  );

  // The safety-report lifecycle (REC-033) is seeded as an exact copy of its code table, in its own migration.
  const reportItRows = seeds.filter((seed) => seed.moduleKey === "report_it");
  assert.equal(reportItRows.length, 1, "report_it must be seeded exactly once");
  assert.equal(reportItRows[0].file, REPORT_IT_MIGRATION, `report_it is seeded by ${REPORT_IT_MIGRATION}`);
  const reportItCode = new Map<string, { from: string[]; to: string }>();
  for (const [from, to] of Object.entries(REPORT_IT_TRANSITIONS)) {
    if (!to) continue;
    const key = REPORT_IT_ACTION_BY_DESTINATION[to];
    assert.ok(key, `report_it: the move ${from} -> ${to} has no registry action name`);
    reportItCode.set(key, { from: [from], to });
  }
  assertSeedEqualsCode("report_it", reportItRows[0], reportItCode, REPORT_IT_STATUSES);
  for (const status of reportItRows[0].statuses!) {
    assert.equal(status.terminal, REPORT_IT_TRANSITIONS[status.key as keyof typeof REPORT_IT_TRANSITIONS] === null, `report_it: "${status.key}" is terminal exactly when the code table has no exit from it`);
  }
  for (const action of reportItRows[0].actions!) {
    for (const role of action.allowedRoles) assert.doesNotThrow(() => parseRoleStrict(role), `report_it.${action.key}: unknown role ${role}`);
    assert.ok(action.tests?.includes(THIS_TEST), `report_it.${action.key}: names ${THIS_TEST} in tests`);
  }

  // Seed structure: statuses declared, terminal statuses have no exit, roles parse, tests named.
  for (const moduleKey of ["weekly_plans", "employee_plans", "market_awareness", "automated_payroll_runs"]) {
    const seed = rec005(moduleKey);
    const declared = new Set(seed.statuses!.map((status) => status.key));
    assert.equal(declared.size, seed.statuses!.length, `${moduleKey}: duplicate status keys`);
    for (const action of seed.actions!) {
      for (const status of [...action.from, action.to]) {
        assert.ok(declared.has(status), `${moduleKey}.${action.key}: status "${status}" is not declared`);
      }
      assert.ok(action.allowedRoles.length > 0, `${moduleKey}.${action.key}: no allowed role`);
      for (const role of action.allowedRoles) assert.doesNotThrow(() => parseRoleStrict(role), `${moduleKey}.${action.key}: unknown role ${role}`);
      assert.ok(action.tests?.includes(THIS_TEST), `${moduleKey}.${action.key}: names ${THIS_TEST} in tests`);
    }
    for (const status of seed.statuses!.filter((s) => s.terminal)) {
      assert.ok(
        !seed.actions!.some((action) => action.from.includes(status.key)),
        `${moduleKey}: terminal status "${status.key}" has an action leaving it`,
      );
    }
  }
  assert.deepEqual(
    rec005("automated_payroll_runs").actions!.flatMap((action) => action.allowedRoles),
    AUTOMATED_PAYROLL_RUN_TRANSITIONS.map(() => "Super Admin"),
    "automated payroll run actions are Super Admin only",
  );

  // The automated payroll table equals the six claimTransition sites in run-service.ts.
  const runService = stripComments(readFileSync(path.join(repoRoot, "src/lib/automated-payroll/run-service.ts"), "utf8"));
  const claims = [...runService.matchAll(/(?<!function\s)\bclaimTransition\(\s*\w+\s*,\s*\[([^\]]*)\]\s*,\s*"([^"]+)"\s*\)/g)];
  assert.equal(claims.length, AUTOMATED_PAYROLL_RUN_TRANSITIONS.length, "one claimTransition site per automated payroll transition");
  const usedLabels = new Set<string>();
  for (const claim of claims) {
    const label = claim[2];
    const from = [...claim[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    const row = AUTOMATED_PAYROLL_RUN_TRANSITIONS.find((t) => t.claimLabel === label);
    assert.ok(row, `run-service.ts claims "${label}", which AUTOMATED_PAYROLL_RUN_TRANSITIONS does not list`);
    assert.ok(!usedLabels.has(label), `run-service.ts claims "${label}" twice`);
    usedLabels.add(label);
    assert.ok(sameSet(from, row.from), `"${label}": run-service.ts leaves from [${from.join(", ")}] but the table from [${row.from.join(", ")}]`);
    const after = runService.slice(claim.index! + claim[0].length);
    // reopenPart1Atomically (payroll audit 2026-11-14, owner: "All or nothing") moves the run inside the
    // database function phx_reopen_automated_payroll_part1, so its SQL is read for the phase it writes.
    const write = /\bphase:\s*"([^"]+)"|\bmarkRunPublished\(|\breopenPart1Atomically\(/.exec(after);
    assert.ok(write, `"${label}": no phase write follows the claim`);
    const written = write[1] ?? (write[0].startsWith("reopenPart1Atomically") ? reopenFunctionPhase() : "published");
    assert.equal(written, row.to, `"${label}": run-service.ts writes phase "${written}" but the table says "${row.to}"`);
  }

  // ── 4. The code-table fallback ───────────────────────────────────────────────────────────────
  const planSeed = rec005("employee_plans");
  const awarenessSeed = rec005("market_awareness");
  const firstPlan = Object.entries(EMPLOYEE_PLAN_TRANSITIONS)[0];
  const planAction = firstPlan[0] as keyof typeof EMPLOYEE_PLAN_TRANSITIONS;
  const planFrom = firstPlan[1].from[0];

  assert.deepEqual(
    await assertEmployeePlanRegistryTransition({ action: planAction, loadModules: async () => [], status: planFrom }),
    { reason: "module_not_registered", source: "code" },
    "no registry row: the code table decides alone",
  );
  assert.deepEqual(
    await assertEmployeePlanRegistryTransition({
      action: planAction,
      loadModules: async () => [asModule("employee_plans", planSeed, false)],
      status: planFrom,
    }),
    { reason: "module_not_registered", source: "code" },
    "an inactive registry row: the code table decides alone",
  );
  assert.deepEqual(
    await assertRegistryAgreesWithCodeTransition({
      actionKey: planAction,
      codeNextStatus: firstPlan[1].to,
      loadModules: async () => {
        throw new Error("registry unreachable");
      },
      moduleKey: "employee_plans",
      status: planFrom,
    }),
    { reason: "registry_unreadable", source: "code" },
    "an unreadable registry: the code table decides alone",
  );

  const planCopy = async () => [asModule("employee_plans", planSeed)];
  for (const [action, t] of Object.entries(EMPLOYEE_PLAN_TRANSITIONS)) {
    for (const status of t.from) {
      const verdict = await assertEmployeePlanRegistryTransition({
        action: action as keyof typeof EMPLOYEE_PLAN_TRANSITIONS,
        loadModules: planCopy,
        status,
      });
      assert.deepEqual(verdict, { nextStatus: t.to, source: "registry" }, `employee_plans ${action} from ${status}: the seed agrees`);
    }
  }
  const awarenessCopy = async () => [asModule("market_awareness", awarenessSeed)];
  for (const transition of MARKET_AWARENESS_TRANSITIONS) {
    const verdict = await assertMarketAwarenessRegistryTransition({ loadModules: awarenessCopy, transition });
    assert.deepEqual(verdict, { nextStatus: transition.to, source: "registry" }, `market_awareness ${transition.action} from ${transition.from}: the seed agrees`);
  }

  const retargeted: Seed = {
    ...planSeed,
    actions: planSeed.actions!.map((action) => (action.key === planAction ? { ...action, to: "hr_acknowledged" } : action)),
  };
  await rejects(
    assertEmployeePlanRegistryTransition({ action: planAction, loadModules: async () => [asModule("employee_plans", retargeted)], status: planFrom }),
    (error) => error instanceof EmployeePlanWorkflowError && error.code === "INVALID_TRANSITION",
    "a registry row that sends a plan elsewhere than the code refuses as INVALID_TRANSITION",
  );
  const narrowed: Seed = {
    ...planSeed,
    actions: planSeed.actions!.map((action) => (action.key === planAction ? { ...action, from: action.from.filter((s) => s !== planFrom) } : action)),
  };
  await rejects(
    assertEmployeePlanRegistryTransition({ action: planAction, loadModules: async () => [asModule("employee_plans", narrowed)], status: planFrom }),
    (error) => error instanceof EmployeePlanWorkflowError && error.code === "INVALID_TRANSITION",
    "a registry row that no longer allows the plan's status refuses",
  );
  const firstAwareness = MARKET_AWARENESS_TRANSITIONS[0];
  const withoutAction: Seed = { ...awarenessSeed, actions: awarenessSeed.actions!.filter((action) => action.key !== firstAwareness.action) };
  await rejects(
    assertMarketAwarenessRegistryTransition({ loadModules: async () => [asModule("market_awareness", withoutAction)], transition: firstAwareness }),
    isWorkflowRegistryTransitionError,
    "a registry row without the action refuses",
  );
}
