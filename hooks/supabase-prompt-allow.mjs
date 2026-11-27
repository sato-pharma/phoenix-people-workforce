#!/usr/bin/env node
// supabase-prompt-allow.mjs - PermissionRequest hook (owner, 2026-10-18).
//
// He asked that Supabase never prompt him, plan mode included. This answers the permission prompt for
// exactly the tools his standing Supabase grant already covers (AGENTS.md section 8): every read tool
// plus execute_sql and apply_migration, on supabase-production and supabase-staging.
//
// NOT covered, so they keep prompting: create_project, pause_project, restore_project,
// create_edge_function_secret (section 8: the grant does not cover creating or deleting a project or
// reading secrets), and the branch and edge-function deploy tools, which the grant never named.
//
// Fail-closed: any error, unreadable input or uncovered tool prints NOTHING, which leaves the prompt
// exactly as it was. The only way this file can approve is the allow line below.
//
// Every call is logged to ~/.claude/logs/supabase-prompt-allow.log: Cairo time, tool, permission mode
// and the decision. NEVER the SQL text - it can hold real employee data.
//
// Self-test:  node supabase-prompt-allow.mjs selftest

import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const COVERED =
  /^mcp__supabase-(production|staging)__(list_[a-z_]+|get_advisors|get_project|get_project_url|get_organization|get_edge_function|get_publishable_keys|generate_typescript_types|query_logs|search_docs|execute_sql|apply_migration)$/;

const ALLOW = {
  hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } },
};

export function decide(toolName) {
  return typeof toolName === "string" && COVERED.test(toolName);
}

function cairoNow() {
  try {
    return new Date().toLocaleString("en-GB", { timeZone: "Africa/Cairo" });
  } catch {
    return new Date().toISOString();
  }
}

function logLine(tool, mode, allowed) {
  try {
    const dir = join(homedir(), ".claude", "logs");
    mkdirSync(dir, { recursive: true });
    const safeTool = String(tool).replace(/[^A-Za-z0-9_\-]/g, "?").slice(0, 120);
    const safeMode = String(mode).replace(/[^A-Za-z0-9_\-]/g, "?").slice(0, 40);
    appendFileSync(
      join(dir, "supabase-prompt-allow.log"),
      `${cairoNow()} Cairo | ${safeTool} | mode=${safeMode} | ${allowed ? "ALLOW" : "LEFT-TO-PROMPT"}\n`,
    );
  } catch {
    // a log fault must never change the decision
  }
}

function main() {
  let input = {};
  try {
    input = JSON.parse(readFileSync(0, "utf8"));
  } catch {
    return;
  }
  const tool = input && typeof input === "object" ? input.tool_name : undefined;
  const mode = input && typeof input === "object" ? (input.permission_mode ?? "unknown") : "unknown";
  const allowed = decide(tool);
  logLine(tool ?? "(no tool name)", mode, allowed);
  if (allowed) process.stdout.write(JSON.stringify(ALLOW));
}

function selftest() {
  const cases = [
    ["mcp__supabase-production__execute_sql", true],
    ["mcp__supabase-production__apply_migration", true],
    ["mcp__supabase-production__list_tables", true],
    ["mcp__supabase-production__list_projects", true],
    ["mcp__supabase-staging__execute_sql", true],
    ["mcp__supabase-staging__get_advisors", true],
    ["mcp__supabase-production__query_logs", true],
    ["mcp__supabase-production__create_project", false],
    ["mcp__supabase-production__pause_project", false],
    ["mcp__supabase-production__restore_project", false],
    ["mcp__supabase-production__create_edge_function_secret", false],
    ["mcp__supabase-staging__create_edge_function_secret", false],
    ["mcp__supabase-production__delete_branch", false],
    ["mcp__supabase-production__merge_branch", false],
    ["mcp__supabase-production__reset_branch", false],
    ["mcp__supabase-production__deploy_edge_function", false],
    ["mcp__supabase-production__execute_sql_extra", false],
    ["mcp__supabase-other__execute_sql", false],
    ["mcp__45bb6356-8105-4482-9464-25bfd754baec__execute_sql", false],
    ["mcp__b345e47e-3198-4b48-97cc-07b47bbb3087__execute_sql", false],
    ["Bash", false],
    ["", false],
    [undefined, false],
    [42, false],
  ];
  let failed = 0;
  for (const [name, want] of cases) {
    const got = decide(name);
    if (got !== want) {
      failed += 1;
      console.log(`FAIL ${String(name)}: wanted ${want}, got ${got}`);
    }
  }
  console.log(`${cases.length - failed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

if (process.argv[2] === "selftest") selftest();
else main();
