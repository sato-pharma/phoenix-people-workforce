#!/usr/bin/env node
// PermissionRequest + PreToolUse hook — in PLAN MODE nothing waits on the owner's click (owner, 2026-10-26: "in plan mode
// they are auto approved, don't tell me approve on them one by one").
//
// Fires only when Claude Code is about to SHOW a permission prompt; deny rules and PreToolUse hooks
// (bash-guard, delete guard, mobile freeze) have already run and still refuse what they refuse.
//   - not plan mode                      → silent, the normal flow decides
//   - ExitPlanMode / AskUserQuestion     → silent, the plan review and his own answers stay his
//   - a file edit outside ~/.claude/plans → DENIED with a reason, never a prompt (plan mode edits nothing)
//   - everything else                    → ALLOWED
// Registered on BOTH events (2026-10-26, "fix the plan-mode prompts again"): PreToolUse answers before any prompt
// surface exists (the desktop app's own prompt included); PermissionRequest stays as the backstop. Another
// PreToolUse hook's deny (bash-guard, delete guard) still wins over this allow.
// Fails open: any error prints nothing, so the normal prompt shows.
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const KEEP_HIS = new Set(["ExitPlanMode", "AskUserQuestion", "EnterPlanMode"]);
const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const PLANS_DIR = resolve(join(homedir(), ".claude", "plans")).toLowerCase();

function log(line) {
  try {
    const dir = join(homedir(), ".claude", "logs");
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, "plan-mode-auto-approve.log"), `${new Date().toISOString()} ${line}\n`);
  } catch {}
}

let EVENT = "PermissionRequest";
function decide(behavior, message) {
  if (EVENT === "PreToolUse") {
    const out = { hookEventName: "PreToolUse", permissionDecision: behavior, permissionDecisionReason: message || "plan mode: auto-approved (owner, 2026-10-26)" };
    process.stdout.write(JSON.stringify({ hookSpecificOutput: out }));
    return;
  }
  const decision = message ? { behavior, message } : { behavior };
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision } }));
}

try {
  const input = JSON.parse(readFileSync(0, "utf8") || "{}");
  const tool = String(input.tool_name || "");
  if (input.hook_event_name === "PreToolUse") EVENT = "PreToolUse";
  const tag = `[${EVENT === "PreToolUse" ? "pre" : "perm"} ${String(input.session_id || "").slice(0, 8)}${input.agent_id ? " " + String(input.agent_id).slice(0, 8) : ""}]`;
  if (input.permission_mode !== "plan" || KEEP_HIS.has(tool)) process.exit(0);

  if (EDIT_TOOLS.has(tool)) {
    const target = input.tool_input?.file_path || input.tool_input?.notebook_path || "";
    if (target && resolve(String(target)).toLowerCase().startsWith(PLANS_DIR)) {
      log(`${tag} allow ${tool} ${target}`);
      decide("allow");
    } else {
      log(`${tag} deny ${tool} ${target}`);
      decide("deny", "Plan mode edits no files until the plan is approved — put this change in the plan instead.");
    }
    process.exit(0);
  }

  log(`${tag} allow ${tool} ${String(input.tool_input?.command || "").slice(0, 60).replace(/\s+/g, " ")}`);
  decide("allow");
} catch {
  process.exit(0);
}
