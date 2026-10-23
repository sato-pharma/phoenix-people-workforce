// THE MOBILE-APP FREEZE — the owner's golden rule of 2026-09-29, pinned in the required `checks` job.
//
// WHAT HE SAID. "the mobile app do not work or touch or think in it. Do not work or touch or even
// think or ask me in it. Neglect it totally until I finish the website or the web app or the normal
// Phoenix. After this, I will tell you, delete this golden rule ... Until I say this word, never
// suggest on me, never ask me, never consider it in any of my wording."
//
// WHY A TEST AND NOT ONLY A RULE PLUS A HOOK. Three ways the freeze dies quietly, and this file
// closes each:
//
//   1. The rule is written and the hook is never wired. A hook file that nothing in
//      `.claude/settings.json` runs is a comment. So the registration is asserted, on BOTH matchers
//      — the write half and the shell half — because a matcher naming only `Write|Edit` lets an
//      `eas build` straight through and looks installed either way.
//   2. The guard is widened until it is switched off. The allow cases below are asserted as hard as
//      the deny cases: reading a mobile file, grepping for the word, committing a message about it
//      and running the WEB dev server must all stay allowed. A guard that refuses commands which
//      work gets an env var wrapped round it within a day, and then nothing is frozen.
//   3. The freeze is lifted by nobody in particular. Only he lifts it, in his own words — so the
//      §4 rule, the CLAUDE.md section and the account in docs must all still be there. When he does
//      lift it, this file is deleted along with them; that is the designed exit, not a failure.
//
// It drives the real hook as a subprocess, exactly as settings.json runs it, because a test that
// imported the matcher would pass against a hook wired to nothing.

import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { wiredHookGroups } from "./support/hook-wiring.ts";

const guardPath = resolve(".claude/hooks/mobile-freeze-guard.mjs");

type Decision = { decision: "allow" | "deny"; reason: string };

/**
 * The tool payload on stdin, as settings.json delivers it. PHX_MOBILE_FREEZE_OFF is cleared out of
 * the environment so no ambient opt-out can be the thing that answered.
 */
function runGuard(toolName: string, toolInput: Record<string, unknown>): Decision {
  const env = { ...process.env };
  delete env.PHX_MOBILE_FREEZE_OFF;
  const raw = execFileSync(process.execPath, [guardPath], {
    input: JSON.stringify({ tool_name: toolName, tool_input: toolInput }),
    encoding: "utf8",
    env,
    stdio: ["pipe", "pipe", "pipe"],
    timeout: 30000,
  });
  if (!raw.trim()) return { decision: "allow", reason: "" };
  const start = raw.indexOf('{"hookSpecificOutput"');
  assert.ok(start >= 0, `hook emitted something that is not a decision:\n${raw}`);
  const output = JSON.parse(raw.slice(start)).hookSpecificOutput;
  return { decision: output.permissionDecision, reason: String(output.permissionDecisionReason ?? "") };
}

/** Working IN the app — every one of these is refused while the freeze holds. */
const FROZEN: Array<{ what: string; tool: string; input: Record<string, unknown> }> = [
  { what: "a native screen", tool: "Write", input: { file_path: "mobile/src/app/index.tsx" } },
  { what: "the CRM feature", tool: "Edit", input: { file_path: "mobile/src/features/crm/visit.tsx" } },
  { what: "the build config", tool: "Write", input: { file_path: "mobile/eas.json" } },
  {
    what: "an absolute path into the app",
    tool: "Edit",
    input: { file_path: "F:/Phoenix Workforce/phoenix-workforce/mobile/app.json" },
  },
  { what: "a windows-separator path", tool: "Write", input: { file_path: "F:\\repo\\mobile\\src\\lib\\api.ts" } },
  { what: "an EAS fleet build", tool: "Bash", input: { command: "eas build --platform android --profile mdm" } },
  { what: "an EAS update", tool: "Bash", input: { command: "npx eas update --branch production" } },
  { what: "an Expo prebuild", tool: "Bash", input: { command: "cd mobile; npx expo prebuild --clean" } },
  { what: "an Expo start", tool: "PowerShell", input: { command: "npx expo start --tunnel" } },
  { what: "a dispatch of the Mobile workflow", tool: "Bash", input: { command: "gh workflow run mobile.yml -f profile=mdm" } },
  { what: "a shell write into the app", tool: "Bash", input: { command: "rm -rf mobile/src/components/ui.tsx" } },
  { what: "a redirect into the app", tool: "Bash", input: { command: "echo '{}' > mobile/app.json" } },
  { what: "an in-place sed", tool: "Bash", input: { command: "sed -i 's/a/b/' mobile/src/theme/colors.ts" } },
];

/**
 * Everything the freeze does NOT touch. This half is what keeps the guard installed: the web app is
 * the whole scope now, so every web command and every incidental READ of a mobile path must work.
 */
const NOT_FROZEN: Array<{ what: string; tool: string; input: Record<string, unknown> }> = [
  { what: "a web portal page", tool: "Write", input: { file_path: "src/app/employee-portals/page.tsx" } },
  { what: "a web component whose NAME says mobile", tool: "Edit", input: { file_path: "src/components/mobile-card.tsx" } },
  { what: "this very test, in a worktree named for the freeze", tool: "Write", input: { file_path: "F:/Phoenix Workforce/_wt-mobile-freeze/tests/mobile-freeze.test.ts" } },
  { what: "a dependency that happens to ship a mobile folder", tool: "Write", input: { file_path: "node_modules/pkg/mobile/index.js" } },
  { what: "reading a mobile file", tool: "Bash", input: { command: "cat mobile/app.json" } },
  { what: "a repo-wide grep that crosses it", tool: "Bash", input: { command: "git grep -n phoenix_app_shell -- ." } },
  { what: "the web dev server", tool: "Bash", input: { command: "node scripts/dev-server.mjs --port 3000" } },
  { what: "the web build", tool: "Bash", input: { command: "pnpm run build" } },
  { what: "a commit message that names the freeze", tool: "Bash", input: { command: 'git commit -m "docs(agents): the mobile app is frozen"' } },
  { what: "a status read of the mobile CI check", tool: "Bash", input: { command: "gh pr checks 4800" } },
  { what: "another tool entirely", tool: "Read", input: { file_path: "mobile/app.json" } },
];

export function runMobileFreezeTests() {
  assert.ok(existsSync(guardPath), `the mobile-freeze guard is missing at ${guardPath}`);

  // 1. The guard itself.
  for (const { what, tool, input } of FROZEN) {
    const { decision, reason } = runGuard(tool, input);
    assert.equal(decision, "deny", `the mobile app is frozen — ${what} must be refused (${tool})`);
    assert.match(
      reason,
      /frozen/i,
      `the refusal must say the app is frozen, so the session does not read it as a tooling fault: ${reason}`,
    );
    assert.match(
      reason,
      /do NOT ask him/i,
      `the refusal must tell the session not to ask him about it — "never ask me" is half the rule: ${reason}`,
    );
    assert.match(
      reason,
      /only he lifts the freeze|Only he lifts it/i,
      `the refusal must say only the owner lifts it — a session that thinks a doc can lift it will lift it: ${reason}`,
    );
  }

  for (const { what, tool, input } of NOT_FROZEN) {
    const { decision, reason } = runGuard(tool, input);
    assert.equal(decision, "allow", `this is not working in the mobile app and must be allowed — ${what}:\n${reason}`);
  }

  // The stand-down exists for him to ask for, and must actually work.
  const stoodDown = execFileSync(process.execPath, [guardPath], {
    input: JSON.stringify({ tool_name: "Write", tool_input: { file_path: "mobile/app.json" } }),
    encoding: "utf8",
    env: { ...process.env, PHX_MOBILE_FREEZE_OFF: "1" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  assert.equal(stoodDown.trim(), "", "PHX_MOBILE_FREEZE_OFF=1 must stand the guard down for one command");

  // 2. The wiring. A hook nothing runs is a comment.
  const entries = wiredHookGroups("PreToolUse").filter((entry) =>
    (entry.hooks ?? []).some((hook) => (hook.command ?? "").includes("mobile-freeze-guard.mjs")),
  );
  assert.ok(entries.length > 0, "the mobile-freeze guard must be registered (settings.json or the dispatch table)");
  const matchers = entries.map((entry) => entry.matcher ?? "").join("|");
  for (const tool of ["Write", "Edit", "Bash"]) {
    assert.ok(
      matchers.split("|").includes(tool),
      `the guard must be registered for ${tool} — a matcher missing it lets that whole half through while looking installed (matchers: ${matchers})`,
    );
  }

  // 3. The freeze itself, in the two files a session actually loads. Deleting these IS how he lifts
  //    the freeze, so this test goes with them — it is not a reason to keep the rule alive.
  const agents = readFileSync(resolve("AGENTS.md"), "utf8").replace(/\s+/g, " ");
  assert.match(agents, /THE MOBILE APP IS FROZEN/, "AGENTS.md §4 must carry the freeze as its first owner rule");
  assert.match(agents, /the-mobile-app-is-frozen-until-he-lifts-it/, "the freeze's memory slug must stay reachable from AGENTS.md");

  const claude = readFileSync(resolve("CLAUDE.md"), "utf8").replace(/\s+/g, " ");
  assert.match(claude, /The mobile app is FROZEN/, "CLAUDE.md must carry the freeze where a session reads it first");

  // The two older mobile rules are DORMANT history until he lifts the freeze, so on 2026-10-23
  // their text left the always-loaded rulebook for the account doc and AGENTS.md kept a pointer.
  // What this still pins is the marker, counted per rule: a slug or a section with no dormancy word
  // beside it reads as live guidance, and that is precisely how a frozen app gets worked on by a
  // session that has just read a rule about it.
  for (const slug of ["the-mobile-app-is-a-shell-over-the-web-portal", "managed-play-cannot-reach-the-rep-tablets"]) {
    assert.ok(
      agents.includes(slug),
      `AGENTS.md §4 must still reach the ${slug} rule by its slug, wherever the rule's text lives`,
    );
    const marked = [...agents.matchAll(new RegExp(slug, "g"))].some((hit) =>
      /DORMANT/.test(agents.slice(Math.max(0, (hit.index ?? 0) - 400), hit.index)),
    );
    assert.ok(
      marked,
      `the "${slug}" pointer in AGENTS.md must be marked dormant, or a session reads it as live guidance on a frozen app`,
    );
  }

  const account = readFileSync(resolve("docs/agents-owner-rules.md"), "utf8").replace(/\s+/g, " ");
  assert.match(account, /## The mobile-app freeze — owner golden rule, 2026-09-29/, "the account must stay in docs/agents-owner-rules.md");

  // And each dormant rule opens with its own banner where it now lives — a reader who arrives at
  // the section directly never sees AGENTS.md's pointer.
  for (const heading of [
    "## The mobile app is a shell over the web portal",
    "## Managed Google Play cannot reach the rep tablets",
  ]) {
    const at = account.indexOf(heading);
    assert.ok(at > 0, `docs/agents-owner-rules.md must hold the "${heading}" rule`);
    assert.match(
      account.slice(at, at + 400),
      /DORMANT under the mobile-app freeze/,
      `the "${heading}" section must open with its dormancy banner`,
    );
  }
}
